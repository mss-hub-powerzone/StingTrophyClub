# Sting Trophy Club — Tryout Dashboard

A dashboard for tracking Sting Trophy Club soccer tryouts across the U17
(Jon Barber • N1) and U16 (Wayne Smith • ECNL RL NTX) squads.

The frontend is still a single static `index.html` (HTML + CSS + vanilla JS),
but player data now lives in **Cloudflare D1**. The dashboard reads from
`/api/players` and writes through Pages Functions in `functions/api/players/`.

## Architecture

```
index.html                  static dashboard (loads players from /api/players)
assets/                     logo images
functions/
  api/
    _shared.js              column mapping, auth, JSON helpers
    players/
      index.js              GET /api/players, POST /api/players
      [id].js               GET/PATCH/PUT/DELETE /api/players/:id
migrations/
  0001_init.sql             players table schema
  0002_seed_players.sql     41 existing players seeded from the original list
wrangler.toml               Pages + D1 binding configuration
```

The D1 binding is `DB`. Mutations require an `ADMIN_TOKEN` secret and the
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

## Run locally (static only)

You can still preview the UI without D1, but it will show "Could not load
players" until the API is reachable.

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Run locally with D1

```bash
npm install -g wrangler
# 1. Create the D1 database
wrangler d1 create stingtrophyclub
# Copy the printed database_id into wrangler.toml under [[d1_databases]].

# 2. Apply migrations + seed locally
wrangler d1 migrations apply stingtrophyclub --local
# (or run each file directly if you prefer:)
# wrangler d1 execute stingtrophyclub --local --file=migrations/0001_init.sql
# wrangler d1 execute stingtrophyclub --local --file=migrations/0002_seed_players.sql

# 3. Set an admin token for the local dev server
echo 'ADMIN_TOKEN = "dev-secret"' > .dev.vars

# 4. Run the Pages dev server (serves static files + functions + local D1)
wrangler pages dev . --d1 DB=stingtrophyclub
# Open the URL it prints. Click "Admin" in the dashboard header and paste
# "dev-secret" to enable add/edit/delete.
```

## Deploy to Cloudflare Pages

> The repo is already wired to Cloudflare via GitHub auto-deploy. These steps
> are the **one-time** D1 setup; after that, `git push` to `main` will redeploy
> the site and functions automatically.

```bash
# 1. Create the D1 database in your Cloudflare account
wrangler d1 create stingtrophyclub
# -> note the database_id; paste it into wrangler.toml.

# 2. Run migrations + seed against the remote database
wrangler d1 migrations apply stingtrophyclub --remote
# (or, file by file:)
# wrangler d1 execute stingtrophyclub --remote --file=migrations/0001_init.sql
# wrangler d1 execute stingtrophyclub --remote --file=migrations/0002_seed_players.sql

# 3. Bind D1 as `DB` to the Pages project
#    Cloudflare dashboard:
#      Pages -> stingtrophyclub -> Settings -> Functions -> D1 database bindings
#      Variable name: DB
#      D1 database:   stingtrophyclub
#    (Alternatively, when wrangler.toml is in the repo Cloudflare Pages will
#     pick the binding up on next build.)

# 4. Set the admin token secret
wrangler pages secret put ADMIN_TOKEN --project-name stingtrophyclub
# (paste a long random string when prompted)

# 5. Trigger a redeploy (push a commit, or "Retry deployment" in the dashboard)
```

> The live site is currently served from
> `https://stingtrophyclub.jon-barber.workers.dev` (a Worker). To pick up the
> `/api/players` Pages Functions you need a **Pages** project pointed at this
> repo. In the Cloudflare dashboard create a new Pages project from the GitHub
> repo, attach the D1 binding and `ADMIN_TOKEN` secret as above, then move the
> custom domain / DNS over to the Pages project. (Alternatively, the same
> functions can be ported into a single Worker that serves the static assets;
> the SQL and JS logic do not change.)

## Admin token UX

Click the **Admin** button in the header to set or clear the token for the
current browser session. It is stored in `sessionStorage` only (not synced,
not persisted across browser restarts) and sent with every mutating request.
A `401` from the API clears the stored token and prompts again.

## Assets

`index.html` references three logo images from the `assets/` directory at
the repo root:

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
