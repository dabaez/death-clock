// SQLite setup and every query the server and the CLI use.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const DEFAULT_DB_PATH = './data/deathclock.db';

export function openDb(dbPath = process.env.DB_PATH || DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS graves (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      death_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS graves_death_at_id ON graves (death_at, id);
  `);

  const q = {
    get: db.prepare('SELECT id, name, created_at, death_at FROM graves WHERE id = ?'),
    insert: db.prepare(
      'INSERT INTO graves (id, name, created_at, death_at) VALUES (@id, @name, @created_at, @death_at)',
    ),
    deadFirstPage: db.prepare(`
      SELECT id, name, death_at FROM graves
      WHERE death_at <= ?
      ORDER BY death_at DESC, id DESC
      LIMIT ?`),
    deadAfter: db.prepare(`
      SELECT id, name, death_at FROM graves
      WHERE death_at <= ? AND (death_at, id) < (?, ?)
      ORDER BY death_at DESC, id DESC
      LIMIT ?`),
    recent: db.prepare(`
      SELECT id, name, created_at, death_at FROM graves
      ORDER BY created_at DESC, id DESC
      LIMIT ?`),
    all: db.prepare('SELECT id, name, created_at, death_at FROM graves ORDER BY created_at DESC, id DESC'),
    delete: db.prepare('DELETE FROM graves WHERE id = ?'),
  };

  return {
    getGrave: (id) => q.get.get(id),
    createGrave: (grave) => q.insert.run(grave),

    // Dead graves, newest death first. `after` is the last row of the
    // previous page, as { deathAt, id }.
    deadGraves({ now, after = null, limit }) {
      return after
        ? q.deadAfter.all(now, after.deathAt, after.id, limit)
        : q.deadFirstPage.all(now, limit);
    },

    recentGraves: (limit) => q.recent.all(limit),

    // Case-insensitive "contains", done in JS because SQLite's lower() only
    // folds ASCII.
    findByName(text) {
      const needle = text.toLowerCase();
      return q.all.all().filter((g) => g.name.toLowerCase().includes(needle));
    },

    deleteGrave: (id) => q.delete.run(id).changes > 0,
    deleteGraves: db.transaction((ids) => ids.reduce((n, id) => n + q.delete.run(id).changes, 0)),

    backup: (dest) => db.backup(dest),
    close: () => db.close(),
  };
}
