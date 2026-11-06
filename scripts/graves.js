#!/usr/bin/env node
// Admin CLI for the graves table. Uses the same DB_PATH as the server.
//
//   node scripts/graves.js list [--limit N]
//   node scripts/graves.js delete <id>
//   node scripts/graves.js delete --name "<text>"
import readline from 'node:readline/promises';
import { openDb } from '../db.js';

const USAGE = `usage:
  graves list [--limit N]
  graves delete <id>
  graves delete --name "<text>"`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

const time = (ms) => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');

function printGraves(graves, now = Date.now()) {
  for (const g of graves) {
    const status = g.death_at <= now ? 'dead' : 'alive';
    console.log(`${g.id}  ${time(g.created_at)}  ${time(g.death_at)}  ${status.padEnd(5)}  ${JSON.stringify(g.name)}`);
  }
}

function printHeader() {
  console.log(`${'id'.padEnd(36)}  ${'created'.padEnd(20)}  ${'death'.padEnd(20)}  state  name`);
}

async function main(args) {
  const [command, ...rest] = args;

  if (command === 'list') {
    let limit = 20;
    if (rest.length) {
      if (rest[0] !== '--limit' || rest.length !== 2 || !/^\d+$/.test(rest[1]) || Number(rest[1]) < 1) {
        fail(USAGE);
      }
      limit = Number(rest[1]);
    }
    const db = openDb();
    const graves = db.recentGraves(limit);
    if (graves.length === 0) console.log('No graves.');
    else {
      printHeader();
      printGraves(graves);
    }
    db.close();
    return;
  }

  if (command === 'delete' && rest[0] === '--name') {
    if (rest.length !== 2 || rest[1] === '') fail(USAGE);
    const db = openDb();
    const matches = db.findByName(rest[1]);
    if (matches.length === 0) {
      console.log(`No graves with a name containing ${JSON.stringify(rest[1])}.`);
      db.close();
      return;
    }
    printHeader();
    printGraves(matches);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Delete ${matches.length} grave${matches.length === 1 ? '' : 's'}? [y/N] `);
    rl.close();
    if (answer.trim().toLowerCase() === 'y') {
      const n = db.deleteGraves(matches.map((g) => g.id));
      console.log(`Deleted ${n} grave${n === 1 ? '' : 's'}.`);
    } else {
      console.log('Nothing deleted.');
    }
    db.close();
    return;
  }

  if (command === 'delete') {
    if (rest.length !== 1 || rest[0].startsWith('--')) fail(USAGE);
    const db = openDb();
    const grave = db.getGrave(rest[0]);
    if (grave && db.deleteGrave(grave.id)) {
      console.log('Deleted:');
      printGraves([grave]);
    } else {
      console.log(`No grave with id ${rest[0]}.`);
      process.exitCode = 1;
    }
    db.close();
    return;
  }

  fail(USAGE);
}

await main(process.argv.slice(2));
