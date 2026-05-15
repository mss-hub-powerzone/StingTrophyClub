# Sting Trophy Club — Tryout Dashboard

A single-file static dashboard for tracking Sting Trophy Club soccer tryouts
across the U17 (Jon Barber • N1) and U16 (Wayne Smith • ECNL RL NTX) squads.

The dashboard is implemented entirely in `index.html` — HTML, CSS, and vanilla
JS in one file. Player data (imported roster + tryout prospects) is embedded as
a JavaScript array, so no backend or build step is required.

## Features

- Tabbed views: All Players, U17, U16, Outside Range
- Filtering by status, position, player type, and quick view
- Search across name, club, school, and contact info
- Sortable by name, birthdate, or status
- Edit player details (status, position, notes, offer/commitment dates) via a
  side drawer
- Add and delete players
- Export current player list as CSV
- Light / dark theme toggle

## Run locally

Because everything is static, you can either open `index.html` directly in a
browser or serve the folder with any static HTTP server:

```bash
# Python 3
python3 -m http.server 8000
# then visit http://localhost:8000
```

```bash
# Node
npx serve .
```

## Deploy

Any static host works. Common options:

- **GitHub Pages** — enable Pages on this repo and point it at the `main`
  branch root. The dashboard will be served at the Pages URL.
- **Netlify / Vercel / Cloudflare Pages** — drag-and-drop or connect the repo;
  no build command needed, publish directory is the repo root.

## Assets

`index.html` references three logo images from the `assets/` directory at
the repo root:

- `assets/Sting-Logo.jpg`
- `assets/N1-league-logo.jpg`
- `assets/ECNL-RL-boys.jpg`

## Editing player data

The initial player list lives in the `initialPlayers` array near the top of
the `<script>` block in `index.html`. Edits made through the UI live only in
the current browser session — use **Export CSV** to capture changes.
