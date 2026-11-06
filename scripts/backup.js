#!/usr/bin/env node
// Copies the database (same DB_PATH as the server) into <dir> as
// deathclock-<UTC time>.db, keeping the newest 30 copies.
//
//   node scripts/backup.js <dir>
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../db.js';

const KEEP = 30;
const dir = process.argv[2];
if (!dir) {
  console.error('usage: backup <dir>');
  process.exit(1);
}

fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const dest = path.join(dir, `deathclock-${stamp}.db`);

const db = openDb();
await db.backup(dest);
db.close();
console.log(`Backed up to ${dest}`);

// Names sort by time, so the oldest come first.
const old = fs
  .readdirSync(dir)
  .filter((f) => /^deathclock-\d{8}T\d{6}Z\.db$/.test(f))
  .sort()
  .slice(0, -KEEP);
for (const f of old) fs.rmSync(path.join(dir, f));
