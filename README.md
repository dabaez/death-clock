# ☠️ The Death Clock ☠️

A joke site in the style of early-2000s "what's your destiny" quizzes. It
asks for your name, shows one question, then cuts you off: you will die in
30–59 seconds. Come back after that and you get a tombstone, plus a link to
the graveyard of everyone who died before you (`/graveyard`, which nothing
else links to).

Your fate is tied to a cookie (`dc_grave`); clearing cookies brings you back
to life. The full behaviour is in [death-clock-spec.md](death-clock-spec.md).

## Running it

Needs Node 22+ and pnpm (the version is pinned in `package.json`).

```sh
pnpm install
pnpm start        # http://localhost:3000
pnpm dev          # same, restarting on changes
pnpm test         # API tests, against a temporary database
```

Settings, all optional:

| Variable      | Default                | Meaning                                                    |
|---------------|------------------------|------------------------------------------------------------|
| `PORT`        | `3000`                 | Port to listen on                                          |
| `HOST`        | all interfaces         | Address to listen on                                       |
| `DB_PATH`     | `./data/deathclock.db` | SQLite file; the folder and schema are created if missing  |
| `TRUST_PROXY` | off                    | Express's `trust proxy` setting (a hop count, `loopback`, …) |

## Layout

| Path | What |
|---|---|
| `server.js` | Express app: static pages plus the JSON API |
| `db.js` | SQLite setup and queries |
| `public/` | The pages: `index.html` + `app.js` (landing, question, reveal, tombstone), `graveyard.html` + `graveyard.js`, `style.css` |
| `public/common.js` | Name validation and date formatting, shared by the server and the pages |
| `scripts/graves.js` | Admin CLI |
| `scripts/backup.js` | Copies the database into a folder, keeping the newest 30 |
| `test/` | API tests (`node:test`) |

## API

- `GET /api/me`: `{ state: "new" }`, `{ state: "alive", name, secondsLeft }`
  or `{ state: "dead", name, deathAt }`.
- `POST /api/graves` with `{ "name": "Sam" }`: creates your grave (or returns
  the one your cookie already points to). At most 5 per IP per 10 minutes.
- `GET /api/graveyard?cursor=…`: the dead, newest first, 50 at a time:
  `{ graves: [{ name, deathAt }], nextCursor }`.

## Moderation

The CLI uses the same `DB_PATH` as the server:

```sh
pnpm graves list [--limit N]          # newest graves, dead or alive
pnpm graves delete <id>
pnpm graves delete --name "text"      # every name containing it; asks first
```

Deleting a grave sends its owner back to the landing page.
