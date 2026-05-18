# Sting Trophy Club — Tryout Dashboard

A dashboard for tracking Sting Trophy Club soccer tryouts across the U17
(Jon Barber • N1) and U16 (Wayne Smith • ECNL RL NTX) squads.

The frontend is a single static `index.html` (HTML + CSS + vanilla JS),
served from a **Cloudflare Worker** alongside the `/api/players` endpoints.
Player data lives in **Cloudflare D1**.

## Architecture

```
public/
  index.html                static dashboard (loads players from /api/players)
  assets/                   logo images
src/
  worker.js                 Worker entrypoint: routes /api/players[*],
                            otherwise delegates to the ASSETS binding
  shared.js                 column mapping, auth, JSON helpers
migrations/
  0001_init.sql             players table schema
  0002_seed_players.sql     41 existing players seeded from the original list
wrangler.toml               Worker + static assets + D1 binding configuration
```

This is a **Cloudflare Workers** deployment (not Pages). A single Worker
serves both the static dashboard (via the Workers Static Assets binding
pointed at `./public`) and the JSON API at `/api/players[*]` (backed by
the D1 binding `DB`). Mutations require an `ADMIN_TOKEN` secret and the
client must send it as `Authorization: Bearer <token>` or `X-Admin-Token`.
Reads are public.

## Features

- Tabbed views: All Players, U17, U16, Outside Range
- Filtering by status, position, player type, and quick view
- Search across name, club, school, and contact info
- Sortable by name, birthdate, or status
- Edit player details (status, position, notes, offer/commitment dates,
  birthdate) via a side drawer
- Add and delete players (writes go to D1)
- Export current player list as CSV
- Light / dark theme toggle (preference persisted in `localStorage`)

## Run locally with D1

```bash
npm install -g wrangler

# 1. Create the D1 database (one-time)
wrangler d1 create stingtrophyclub
# Copy the printed database_id into wrangler.toml under [[d1_databases]].

# 2. Apply migrations + seed locally
wrangler d1 migrations apply stingtrophyclub --local

# 3. Set an admin token for the local dev server
echo 'ADMIN_TOKEN = "dev-secret"' > .dev.vars

# 4. Run the Worker dev server (serves static files + API + local D1)
wrangler dev
# Open the URL it prints. Click "Admin" in the dashboard header and paste
# "dev-secret" to enable add/edit/delete.
```

## Deploy to Cloudflare (Workers)

> The repo is already wired to Cloudflare via GitHub auto-deploy as a
> **Workers** project, deployed to
> `https://stingtrophyclub.jon-barber.workers.dev`. After the one-time
> setup below, `git push` to `main` redeploys the Worker automatically.

```bash
# 1. Create the D1 database in your Cloudflare account
wrangler d1 create stingtrophyclub
# -> note the database_id; paste it into wrangler.toml.

# 2. Run migrations + seed against the remote database
wrangler d1 migrations apply stingtrophyclub --remote

# 3. Bind D1 as `DB` to the Worker
#    With wrangler.toml in the repo Cloudflare picks the binding up on
#    next build. Alternatively, attach manually:
#      Workers & Pages -> stingtrophyclub -> Settings -> Bindings -> D1
#      Variable name: DB
#      D1 database:   stingtrophyclub

# 4. Set the admin token secret
wrangler secret put ADMIN_TOKEN
# (paste a long random string when prompted)

# 5. Trigger a redeploy (push a commit, or "Retry deployment" in the dashboard)
```

> **Migration from the previous Pages-Functions layout:** the old
> `functions/api/...` files have been replaced by the single Worker in
> `src/worker.js`. The SQL schema and migrations are unchanged. Static
> assets moved from the repo root into `./public/` so that
> `migrations/`, `src/`, and `README.md` are not exposed to the public
> internet via the assets binding.

## Admin token UX

Click the **Admin** button in the header to set or clear the token for the
current browser session. It is stored in `sessionStorage` only (not synced,
not persisted across browser restarts) and sent with every mutating request.
A `401` from the API clears the stored token and prompts again.

## Assets

`public/index.html` references three logo images from the `public/assets/`
directory (served at `/assets/...`):

- `assets/Sting-Logo.jpg`
- `assets/N1-league-logo.jpg`
- `assets/ECNL-RL-boys.jpg`

## Editing player data

- **In the dashboard** — set the admin token, then use Add / Edit / Delete in
  the UI. Changes go straight to D1 and are visible to other browsers on
  refresh.
- **In bulk** — write SQL against the `players` table and run it with
  `wrangler d1 execute stingtrophyclub --remote --command "..."`.
- **From CSV** — the dashboard's Export CSV button still works (downloads
  whatever is currently loaded from the API).

## API reference

| Method | Path                    | Auth | Description |
| ------ | ----------------------- | ---- | ----------- |
| GET    | `/api/players`          | —    | List all players |
| POST   | `/api/players`          | yes  | Create a player (body: camelCase JSON) |
| GET    | `/api/players/:id`      | —    | Fetch one player |
| PATCH  | `/api/players/:id`      | yes  | Partial update |
| PUT    | `/api/players/:id`      | yes  | Full replace |
| DELETE | `/api/players/:id`      | yes  | Delete |

Auth header: `Authorization: Bearer $ADMIN_TOKEN` (or `X-Admin-Token: $ADMIN_TOKEN`).
