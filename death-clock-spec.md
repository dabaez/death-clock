# The Death Clock — Spec

## Overview

A joke website in the style of early-2000s "what's your destiny" quiz sites. It claims it will calculate the date of your death. You enter your name, it shows you the first question, and before you can answer it cuts you off and tells you that you will die in 30–59 seconds.

Your fate is tied to your browser with a cookie. Refreshing recalculates how many seconds you have left, and once the time has passed, the site tells you you're already dead and shows your tombstone. Everyone who has died appears in a shared graveyard at a secret, unadvertised URL.

## Stack

- **Frontend:** plain HTML, CSS and vanilla JavaScript. There is no framework and no build step.
- **Backend:** Node.js (20+) with Express, serving both the static files and a small JSON API from one process.
- **Database:** SQLite via `better-sqlite3`.
- **Config (env vars):**
  - `PORT` (default `3000`).
  - `DB_PATH` (default `./data/deathclock.db`); create the directory and the schema on startup if missing.
  - `TRUST_PROXY` (optional) is passed to Express's `trust proxy` setting so `req.ip` is correct behind a proxy.

Deployment is out of scope.

## Project structure

```
death-clock/
  package.json
  server.js            # Express app: static files + API
  db.js                # SQLite setup and queries
  scripts/graves.js    # admin CLI
  public/
    index.html         # landing, question, reveal, tombstone screens
    app.js
    graveyard.html
    graveyard.js
    style.css
  data/                # SQLite file lives here (gitignored)
```

## Data model

There is one table, `graves`:

| column       | type    | notes                                      |
|--------------|---------|--------------------------------------------|
| `id`         | TEXT PK | random, from `crypto.randomUUID()`         |
| `name`       | TEXT    | validated name, max 30 characters          |
| `created_at` | INTEGER | ms since epoch, when the name was submitted |
| `death_at`   | INTEGER | ms since epoch, `created_at + N seconds`   |

Add an index on `(death_at, id)` for the graveyard query.

IP addresses are **never** stored.

## Cookie

- The cookie is named `dc_grave` and its value is the grave `id`.
- Set `Max-Age` to 1 year, `Path=/`, `SameSite=Lax`, and `HttpOnly`. Add `Secure` when the request is over HTTPS.
- The cookie is the only persistence. Clearing cookies is how a person "comes back to life"; there is no other reset.
- If the cookie points to a grave that no longer exists (e.g. deleted with the CLI), treat the visitor as new and clear the cookie.

## Server logic

- **Death time:** the server picks it, never the client: `N = crypto.randomInt(30, 60)` (30–59 inclusive), `death_at = created_at + N * 1000`.
- **State of a grave at time `now`:**
  - **alive** if `death_at > now`, with `secondsLeft = Math.ceil((death_at - now) / 1000)`;
  - **dead** otherwise.
- **Name validation (server-side; also mirrored client-side for instant feedback):**
  - Trim it and collapse internal whitespace to single spaces.
  - Strip control characters.
  - Require 1–30 characters, counting Unicode code points (`[...name].length`).
  - There is no profanity filter.

## API

### `GET /api/me`

This returns the current visitor's state based on the cookie, in one of three shapes:

```json
{ "state": "new" }
{ "state": "alive", "name": "Sam", "secondsLeft": 41 }
{ "state": "dead",  "name": "Sam", "deathAt": 1762354937000 }
```

### `POST /api/graves`

Body: `{ "name": "Sam" }`

- If the visitor's cookie already points to an existing grave, do **not** create a new one; return their current state (same shape as `/api/me`).
- Otherwise, validate the name, apply the rate limit, create the grave, set the cookie, and return `{ "state": "alive", "name": ..., "secondsLeft": ... }`.
- On a validation error, return `400` with `{ "error": "..." }`.
- On hitting the rate limit, return `429` with `{ "error": "Death is busy right now. Try again later." }`.
- Limit the JSON body size to something small (e.g. 1 KB).

### `GET /api/graveyard?cursor=<cursor>`

- Return only graves where `death_at <= now`. People still in their final seconds must not appear.
- Order newest death first: `ORDER BY death_at DESC, id DESC`.
- Return 50 per page, using keyset pagination on `(death_at, id)`. `cursor` is an opaque string encoding the last row's `(death_at, id)`.
- Response:

```json
{ "graves": [ { "name": "Sam", "deathAt": 1762354937000 } ], "nextCursor": "..." }
```

`nextCursor` is `null` when there are no more. Do not expose grave ids in this endpoint.

### Rate limit

- Rate limiting applies only to `POST /api/graves`.
- Allow at most 5 grave creations per IP per rolling 10 minutes, keyed on `req.ip`.
- Keep the counts in memory only, never persisted, and prune old entries periodically.

## Pages and screens

### `index.html` (`/`)

The page has four screens, all hidden initially. On load, `app.js` calls `GET /api/me` and shows the right screen, which avoids a flash of the wrong one.

**1. Landing (state `new`)**

```
☠️ THE DEATH CLOCK ☠️
Answer our questions and find out the date of your death

Enter your name: [ ______ ]  [ Begin ]
```

- The text is a placeholder and should be easy to edit in the HTML.
- There is **no** mention of or link to the graveyard.
- The page shows inline validation if the name is empty or too long.

**2. Question**

When the person submits a valid name:

- Immediately show: **"Are you a boy or a girl?"** with three buttons: **Boy**, **Girl**, **Other**.
- At the same time, fire `POST /api/graves` in the background.
- The buttons must look and feel fully clickable: pointer cursor, hover effect, pressed state. Clicking them does **nothing**: no feedback, no error, no navigation. Use `type="button"`.
- After **1 second** (or when the POST response arrives, whichever is later), cut abruptly to the reveal. There is no transition or fade; it should feel like you got interrupted.
- If the POST fails (rate limit or other error), replace the question with the error message instead of the reveal, and let the person try again.

**3. Reveal (state `alive`)**

> **Sam, you will die in 45 seconds.**

- On the first reveal, compute the number as the server's `secondsLeft` minus the seconds elapsed since the response arrived, so it reflects the actual time remaining.
- There is **no** live countdown. The number is static.
- Refreshing the page shows this exact same screen with the recalculated number from `/api/me`.
- If someone refreshes during the question screen and the grave was already created, they go straight to this screen.
- There is no graveyard link here.

**4. Tombstone (state `dead`)**

- Show a tombstone-styled box with the person's name and their time of death.
- Format the time in the viewer's local time, e.g. `Nov 5, 2026, 3:42:17 PM` (use `toLocaleString` with `dateStyle: "medium", timeStyle: "medium"`).
- Below it, add a single link to `/graveyard`. Nothing else: no cause of death, no highlighting.

### `graveyard.html` (`/graveyard`)

- It is reachable only by knowing the URL or via the link on the tombstone screen. Nothing else links to it.
- Add `<meta name="robots" content="noindex">`.
- It shows a list of tombstones, each with only the name and time of death (viewer's local time, same format as above).
- It loads the first 50, then shows a **"Dig deeper"** button that fetches the next page and appends it. Hide the button when `nextCursor` is `null`.
- Empty state: "No one has died yet."
- It works the same whether or not the visitor has a cookie or is dead.

## Security

- Render every user-supplied string with `textContent` (or equivalent), **never** `innerHTML`.
- Validate names on the server regardless of client-side checks.
- Use parameterized SQL queries only.

## Admin CLI — `scripts/graves.js`

It uses the same `DB_PATH` as the server.

```
node scripts/graves.js list [--limit N]
node scripts/graves.js delete <id>
node scripts/graves.js delete --name "<text>"
```

- `list` shows the most recent graves (default 20) with id, name, created time, death time, and whether they're dead yet.
- `delete <id>` deletes one grave and prints what was deleted, or says it was not found.
- `delete --name "<text>"` finds every grave whose name contains the text (case-insensitive). It prints the matches, asks `Delete N graves? [y/N]`, and deletes only on `y`.

Add npm scripts for convenience (e.g. `npm run graves -- list`).

## Look and feel

Aim for an **early-2000s quiz site** look:

- Bright colors, perhaps a gradient or CSS-generated pattern background (no external images).
- A centered content box with a thick border.
- Fonts in the Verdana / Tahoma / Comic Sans vibe.
- Bevelled, chunky buttons, and liberal emoji (☠️ ✨ 🔮).
- Tombstones should look like little grey tombstones (rounded top, "R.I.P.").
- All in plain CSS, with no external fonts or assets required.

It must also work on phones:

- Include a viewport meta tag.
- The content box should be fluid with a max width.
- Use tap-friendly button sizes.
- There should be no horizontal scrolling.

## Tests

Add a few API tests with `node:test` (using a temporary DB file):

- Creating a grave sets the cookie and returns 30–59 seconds left.
- A second POST with the same cookie does not create a new grave.
- `/api/me` returns `alive` then `dead` once `death_at` passes (allow overriding "now" or `death_at` for tests).
- The graveyard excludes graves that are still alive and paginates correctly.
- Name validation rejects empty and over-30-character names.
- The rate limit returns 429 on the 6th creation within 10 minutes.

## Out of scope

The following are intentionally not part of this project:

- Deployment and hosting configuration.
- A profanity filter or moderation UI (the CLI is the moderation tool).
- A live countdown.
- Storing IP addresses or any analytics.
- Any way to "revive" other than clearing cookies.

## Acceptance checklist

- [ ] A new visitor sees only the landing page. There is no hint of the graveyard.
- [ ] Submitting a name shows the gender question for about 1 second; the buttons look clickable but do nothing.
- [ ] The reveal says "NAME, you will die in X seconds" with X between roughly 29 and 59, with no countdown.
- [ ] Refreshing before death shows the same reveal with a smaller number.
- [ ] Refreshing after death shows the tombstone (name and time of death) and a link to `/graveyard`.
- [ ] Clearing cookies returns the visitor to the landing page.
- [ ] `/graveyard` lists only the dead, newest first, 50 at a time with "Dig deeper".
- [ ] Names containing HTML render as plain text everywhere.
- [ ] The CLI can list and delete graves, and name-based deletion asks for confirmation.
- [ ] The site looks right on a phone.
