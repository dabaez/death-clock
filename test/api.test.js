import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { openDb } from '../db.js';
import { createApp } from '../server.js';

let tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deathclock-test-'));
});
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

// A fresh database, app and fake clock for each test.
let db, app, server, base, clock, dbCount = 0;
beforeEach(async (t) => {
  db = openDb(path.join(tmpDir, `test-${++dbCount}.db`));
  clock = { now: 1_800_000_000_000 };
  app = createApp({ db, now: () => clock.now, trustProxy: '' });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    app.locals.limiter.stop();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
});

async function post(name, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${base}/api/graves`, { method: 'POST', headers, body: JSON.stringify({ name }) });
  return { res, body: await res.json() };
}

async function get(pathname, cookie) {
  const res = await fetch(`${base}${pathname}`, { headers: cookie ? { Cookie: cookie } : {} });
  return { res, body: await res.json() };
}

// "dc_grave=<id>" from a Set-Cookie header.
const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];

describe('POST /api/graves', () => {
  test('creates a grave, sets the cookie and returns 30-59 seconds left', async () => {
    const { res, body } = await post('  Sam \n  Smith ');
    assert.equal(res.status, 201);
    assert.equal(body.state, 'alive');
    assert.equal(body.name, 'Sam Smith');
    assert.ok(body.secondsLeft >= 30 && body.secondsLeft <= 59, `secondsLeft ${body.secondsLeft}`);

    const setCookie = res.headers.get('set-cookie');
    assert.match(setCookie, /^dc_grave=[0-9a-f-]{36};/);
    assert.match(setCookie, /Max-Age=31536000/);
    assert.match(setCookie, /Path=\//);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.doesNotMatch(setCookie, /Secure/); // plain http here
  });

  test('a second POST with the same cookie does not create a new grave', async () => {
    const first = await post('Sam');
    const cookie = cookieOf(first.res);
    clock.now += 5000;
    const second = await post('Someone Else', cookie);
    assert.equal(second.res.status, 200);
    assert.equal(second.body.name, 'Sam');
    assert.equal(second.body.secondsLeft, first.body.secondsLeft - 5);
    assert.equal(second.res.headers.get('set-cookie'), null);
    assert.equal(db.recentGraves(10).length, 1);
  });

  test('rejects empty and over-30-character names', async () => {
    for (const name of ['', '   ', '\u0000\u0007', 'x'.repeat(31), undefined, 42]) {
      const { res, body } = await post(name);
      assert.equal(res.status, 400, `name ${JSON.stringify(name)}`);
      assert.equal(typeof body.error, 'string');
    }
    // 30 code points is fine, even when they're astral (2 UTF-16 units each).
    assert.equal((await post('💀'.repeat(30))).res.status, 201);
    assert.equal(db.recentGraves(10).length, 1);
  });

  test('strips control characters', async () => {
    const { body } = await post('Sa\u0000m\u001b');
    assert.equal(body.name, 'Sam');
  });

  test('returns 429 on the 6th creation within 10 minutes', async () => {
    for (let i = 0; i < 5; i++) {
      assert.equal((await post(`Person ${i}`)).res.status, 201);
      clock.now += 60_000;
    }
    const { res, body } = await post('Person 6');
    assert.equal(res.status, 429);
    assert.equal(body.error, 'Death is busy right now. Try again later.');

    // Once the first creation is 10 minutes old, there's room again.
    clock.now += 5 * 60_000 + 1;
    assert.equal((await post('Person 7')).res.status, 201);
  });

  test('rejects oversized and malformed bodies', async () => {
    const big = await fetch(`${base}/api/graves`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(2000) }),
    });
    assert.equal(big.status, 413);
    const bad = await fetch(`${base}/api/graves`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{nope',
    });
    assert.equal(bad.status, 400);
  });
});

describe('GET /api/me', () => {
  test('is new without a cookie', async () => {
    assert.deepEqual((await get('/api/me')).body, { state: 'new' });
  });

  test('returns alive, then dead once death_at passes', async () => {
    const { res, body: created } = await post('Sam');
    const cookie = cookieOf(res);
    const deathAt = clock.now + created.secondsLeft * 1000;

    clock.now += 10_500;
    assert.deepEqual((await get('/api/me', cookie)).body, {
      state: 'alive',
      name: 'Sam',
      secondsLeft: created.secondsLeft - 10,
    });

    clock.now = deathAt - 1;
    assert.equal((await get('/api/me', cookie)).body.secondsLeft, 1);

    clock.now = deathAt;
    assert.deepEqual((await get('/api/me', cookie)).body, { state: 'dead', name: 'Sam', deathAt });
  });

  test('treats a cookie for a deleted grave as new and clears it', async () => {
    const { res } = await post('Sam');
    const cookie = cookieOf(res);
    db.deleteGrave(cookie.split('=')[1]);
    const me = await get('/api/me', cookie);
    assert.deepEqual(me.body, { state: 'new' });
    assert.match(me.res.headers.get('set-cookie'), /^dc_grave=;.*Expires=Thu, 01 Jan 1970/);
  });
});

describe('GET /api/graveyard', () => {
  test('excludes graves that are still alive', async () => {
    db.createGrave({ id: 'a', name: 'Dead', created_at: clock.now - 60_000, death_at: clock.now - 1000 });
    db.createGrave({ id: 'b', name: 'Just died', created_at: clock.now - 30_000, death_at: clock.now });
    db.createGrave({ id: 'c', name: 'Alive', created_at: clock.now, death_at: clock.now + 1 });
    const { body } = await get('/api/graveyard');
    assert.deepEqual(body, {
      graves: [
        { name: 'Just died', deathAt: clock.now },
        { name: 'Dead', deathAt: clock.now - 1000 },
      ],
      nextCursor: null,
    });
  });

  test('is empty when no one has died', async () => {
    assert.deepEqual((await get('/api/graveyard')).body, { graves: [], nextCursor: null });
  });

  test('paginates 50 at a time, newest death first', async () => {
    // 120 dead graves, some sharing a death time so the id breaks ties.
    const expected = [];
    for (let i = 0; i < 120; i++) {
      const g = {
        id: `id-${String(i).padStart(3, '0')}`,
        name: `Person ${i}`,
        created_at: clock.now - 200_000,
        death_at: clock.now - 100_000 + Math.floor(i / 3) * 1000,
      };
      db.createGrave(g);
      expected.push(g);
    }
    db.createGrave({ id: 'zzz', name: 'Alive', created_at: clock.now, death_at: clock.now + 30_000 });
    expected.sort((x, y) => y.death_at - x.death_at || (y.id < x.id ? -1 : 1));

    const pages = [];
    let cursor;
    do {
      const { body } = await get(`/api/graveyard${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
      pages.push(body.graves);
      cursor = body.nextCursor;
    } while (cursor);

    assert.deepEqual(pages.map((p) => p.length), [50, 50, 20]);
    assert.deepEqual(
      pages.flat(),
      expected.map((g) => ({ name: g.name, deathAt: g.death_at })),
    );
    for (const g of pages.flat()) assert.equal('id' in g, false);
  });

  test('rejects a bad cursor', async () => {
    assert.equal((await get('/api/graveyard?cursor=garbage')).res.status, 400);
  });
});

describe('pages', () => {
  test('serves the landing page and the graveyard', async () => {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.doesNotMatch(await home.text(), /graveyard/i); // no hint of it for the living

    const yard = await fetch(`${base}/graveyard`);
    assert.equal(yard.status, 200);
    assert.match(await yard.text(), /<meta name="robots" content="noindex">/);
  });
});
