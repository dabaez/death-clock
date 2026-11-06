// The Death Clock: static pages plus a small JSON API, in one process.
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { openDb } from './db.js';
import { cleanName } from './public/common.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const COOKIE = 'dc_grave';
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 50;
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_ERROR = 'Death is busy right now. Try again later.';

export function stateOf(grave, now) {
  if (grave.death_at > now) {
    return { state: 'alive', name: grave.name, secondsLeft: Math.ceil((grave.death_at - now) / 1000) };
  }
  return { state: 'dead', name: grave.name, deathAt: grave.death_at };
}

// The cursor is opaque to clients: base64url of [death_at, id].
function encodeCursor(row) {
  return Buffer.from(JSON.stringify([row.death_at, row.id])).toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const [deathAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Number.isSafeInteger(deathAt) && typeof id === 'string') return { deathAt, id };
  } catch {
    // fall through
  }
  return null;
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i !== -1 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Grave creations per IP in a rolling window, kept in memory only.
function createRateLimiter({ limit, windowMs, now }) {
  const hits = new Map(); // ip -> creation times, oldest first
  const recent = (ip) => {
    const cutoff = now() - windowMs;
    const times = (hits.get(ip) || []).filter((t) => t > cutoff);
    if (times.length) hits.set(ip, times);
    else hits.delete(ip);
    return times;
  };
  const prune = () => {
    for (const ip of hits.keys()) recent(ip);
  };
  const timer = setInterval(prune, 60 * 1000);
  timer.unref();
  return {
    allowed: (ip) => recent(ip).length < limit,
    record: (ip) => hits.set(ip, [...recent(ip), now()]),
    prune,
    stop: () => clearInterval(timer),
  };
}

function parseTrustProxy(value) {
  if (value === undefined || value === '') return false;
  if (/^\d+$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value; // e.g. "loopback" or a list of addresses
}

export function createApp({ db, now = Date.now, trustProxy = process.env.TRUST_PROXY } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', parseTrustProxy(trustProxy));

  const limiter = createRateLimiter({ limit: RATE_LIMIT, windowMs: RATE_WINDOW_MS, now });
  app.locals.limiter = limiter;

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    next();
  });

  const cookieOptions = (req) => ({ path: '/', sameSite: 'lax', httpOnly: true, secure: req.secure });

  // The visitor's grave, or null. A cookie for a deleted grave is cleared.
  function currentGrave(req, res) {
    const id = readCookie(req, COOKIE);
    if (!id) return null;
    const grave = db.getGrave(id);
    if (!grave) res.clearCookie(COOKIE, cookieOptions(req));
    return grave || null;
  }

  const api = express.Router();
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  api.get('/me', (req, res) => {
    const grave = currentGrave(req, res);
    res.json(grave ? stateOf(grave, now()) : { state: 'new' });
  });

  api.post('/graves', express.json({ limit: '1kb' }), (req, res) => {
    const existing = currentGrave(req, res);
    if (existing) return res.json(stateOf(existing, now()));

    const { name, error } = cleanName(req.body?.name);
    if (error) return res.status(400).json({ error });

    if (!limiter.allowed(req.ip)) return res.status(429).json({ error: RATE_LIMIT_ERROR });

    const createdAt = now();
    const grave = {
      id: crypto.randomUUID(),
      name,
      created_at: createdAt,
      death_at: createdAt + crypto.randomInt(30, 60) * 1000,
    };
    db.createGrave(grave);
    limiter.record(req.ip);

    res.cookie(COOKIE, grave.id, { ...cookieOptions(req), maxAge: COOKIE_MAX_AGE_MS });
    res.status(201).json(stateOf(grave, createdAt));
  });

  api.get('/graveyard', (req, res) => {
    let after = null;
    if (req.query.cursor !== undefined) {
      after = typeof req.query.cursor === 'string' ? decodeCursor(req.query.cursor) : null;
      if (!after) return res.status(400).json({ error: 'Bad cursor.' });
    }
    const rows = db.deadGraves({ now: now(), after, limit: PAGE_SIZE + 1 });
    const page = rows.slice(0, PAGE_SIZE);
    res.json({
      graves: page.map((g) => ({ name: g.name, deathAt: g.death_at })),
      nextCursor: rows.length > PAGE_SIZE ? encodeCursor(page.at(-1)) : null,
    });
  });

  api.use((req, res) => res.status(404).json({ error: 'Not found.' }));

  // Malformed or oversized JSON bodies, and anything unexpected.
  api.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong.' : 'Bad request.' });
  });

  app.use('/api', api);

  app.get('/graveyard', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'graveyard.html')));
  app.use(express.static(PUBLIC_DIR));

  return app;
}

// Run directly: `node server.js`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb();
  const app = createApp({ db });
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || undefined;
  const server = app.listen(port, host, () => {
    console.log(`The Death Clock is ticking on ${host || 'port'}${host ? ':' : ' '}${port}`);
  });
  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
