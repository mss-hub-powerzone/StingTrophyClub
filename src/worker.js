// Cloudflare Worker for Sting Trophy Club.
//
// Serves /api/players[*] from D1, and delegates everything else to the
// static assets binding (public/ in the repo).

import { COLUMNS, json, makeId, playerToColumns, requireAdmin, rowToPlayer } from "./shared.js";
import { handleSyncRequest } from "./sync.js";

async function listPlayers(env) {
  if (!env.DB) return json({ error: "DB binding missing" }, { status: 500 });
  const { results } = await env.DB.prepare(
    "SELECT * FROM players ORDER BY last_name, first_name"
  ).all();
  return json({ players: (results || []).map(rowToPlayer) });
}

async function createPlayer(request, env) {
  if (!env.DB) return json({ error: "DB binding missing" }, { status: 500 });
  const unauthorized = requireAdmin(request, env);
  if (unauthorized) return unauthorized;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const id = body.id && /^[a-z0-9-]+$/.test(body.id) ? body.id : makeId(body);
  const cols = playerToColumns(body, { fillDefaults: true });

  async function runInsert(colsToWrite) {
    const names = ["id", ...Object.keys(colsToWrite)];
    const placeholders = names.map(() => "?").join(", ");
    const values = [id, ...Object.keys(colsToWrite).map(c => colsToWrite[c])];
    await env.DB.prepare(
      `INSERT INTO players (${names.join(", ")}) VALUES (${placeholders})`
    ).bind(...values).run();
  }

  let warning = "";
  try {
    await runInsert(cols);
  } catch (e) {
    const msg = String(e && e.message || e);
    if (msg.toLowerCase().includes("unique") || msg.toLowerCase().includes("constraint")) {
      return json({ error: "Player with this id already exists", id }, { status: 409 });
    }
    if (isMissingColumnError(e)) {
      const { stripped, removed } = stripPostInitColumns(cols);
      if (removed.length === 0) return json({ error: msg }, { status: 500 });
      try {
        await runInsert(stripped);
        warning =
          "D1 is missing column(s) " + removed.join(", ") +
          ". Apply the latest migrations (wrangler d1 migrations apply " +
          "stingtrophyclub --remote) to enable team override persistence. " +
          "Other fields saved.";
      } catch (e2) {
        return json({ error: String(e2 && e2.message || e2) }, { status: 500 });
      }
    } else {
      return json({ error: msg }, { status: 500 });
    }
  }

  const row = await env.DB.prepare("SELECT * FROM players WHERE id = ?").bind(id).first();
  const responseBody = { player: rowToPlayer(row) };
  if (warning) responseBody.warning = warning;
  return json(responseBody, { status: 201 });
}

async function loadPlayer(env, id) {
  return await env.DB.prepare("SELECT * FROM players WHERE id = ?").bind(id).first();
}

async function getPlayer(env, id) {
  if (!env.DB) return json({ error: "DB binding missing" }, { status: 500 });
  const row = await loadPlayer(env, id);
  if (!row) return json({ error: "Not found" }, { status: 404 });
  return json({ player: rowToPlayer(row) });
}

// Columns that were added by later migrations and may be absent from a D1
// database that hasn't had the migration applied yet. If a write hits a
// "no such column" error we strip these and retry, so the rest of the
// fields still save and the operator gets a clear warning instead of a
// bare 500.
const POST_INIT_COLUMNS = ["team_override", "photo_url", "kit_number", "bio"];

function isMissingColumnError(err) {
  const msg = String((err && err.message) || err || "").toLowerCase();
  return msg.includes("no such column") || msg.includes("has no column");
}

function stripPostInitColumns(cols) {
  const stripped = { ...cols };
  const removed = [];
  for (const c of POST_INIT_COLUMNS) {
    if (c in stripped) { delete stripped[c]; removed.push(c); }
  }
  return { stripped, removed };
}

async function updatePlayer(request, env, id, { fillDefaults }) {
  if (!env.DB) return json({ error: "DB binding missing" }, { status: 500 });
  const unauthorized = requireAdmin(request, env);
  if (unauthorized) return unauthorized;

  const existing = await loadPlayer(env, id);
  if (!existing) return json({ error: "Not found" }, { status: 404 });

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Merge sticky inputs from the existing row so PATCHes that touch only
  // birthdate still honor a previously-saved team override, and vice versa.
  // playerToColumns recomputes team_bucket/label/coach/league from the merged
  // (birthdate, team_override) pair whenever either is in the payload.
  if (!fillDefaults) {
    if (("birthdate" in body) && !("teamOverride" in body)) {
      body = { ...body, teamOverride: existing.team_override || "" };
    } else if (("teamOverride" in body) && !("birthdate" in body)) {
      body = { ...body, birthdate: existing.birthdate || "" };
    }
  }

  const cols = playerToColumns(body, { fillDefaults });
  const colNames = Object.keys(cols);
  if (colNames.length === 0) {
    return json({ player: rowToPlayer(existing) });
  }

  async function runUpdate(colsToWrite) {
    const names = Object.keys(colsToWrite);
    const setClause = names.map(c => `${c} = ?`).join(", ");
    const values = names.map(c => colsToWrite[c]);
    await env.DB.prepare(
      `UPDATE players SET ${setClause}, updated_at = datetime('now') WHERE id = ?`
    ).bind(...values, id).run();
  }

  let warning = "";
  try {
    await runUpdate(cols);
  } catch (e) {
    if (isMissingColumnError(e)) {
      // Likely the migration hasn't been applied to this D1. Strip the
      // post-init columns and retry so the rest of the edit lands.
      const { stripped, removed } = stripPostInitColumns(cols);
      if (removed.length === 0) {
        return json(
          { error: "D1 update failed: " + String((e && e.message) || e) },
          { status: 500 }
        );
      }
      try {
        await runUpdate(stripped);
        warning =
          "D1 is missing column(s) " + removed.join(", ") +
          ". Apply the latest migrations (wrangler d1 migrations apply " +
          "stingtrophyclub --remote) to enable team override persistence. " +
          "Other fields saved.";
      } catch (e2) {
        return json(
          { error: "D1 update failed after schema-fallback retry: " +
            String((e2 && e2.message) || e2) },
          { status: 500 }
        );
      }
    } else {
      return json(
        { error: "D1 update failed: " + String((e && e.message) || e) },
        { status: 500 }
      );
    }
  }

  const row = await loadPlayer(env, id);
  const responseBody = { player: rowToPlayer(row) };
  if (warning) responseBody.warning = warning;
  return json(responseBody);
}

async function deletePlayer(request, env, id) {
  if (!env.DB) return json({ error: "DB binding missing" }, { status: 500 });
  const unauthorized = requireAdmin(request, env);
  if (unauthorized) return unauthorized;

  const existing = await loadPlayer(env, id);
  if (!existing) return json({ error: "Not found" }, { status: 404 });
  await env.DB.prepare("DELETE FROM players WHERE id = ?").bind(id).run();
  return json({ ok: true, id });
}

// ---------------------------------------------------------------------------
// Photo upload / delete
// ---------------------------------------------------------------------------
// Accepts a raw image blob (JPEG or PNG) up to 4 MB, stores it in the PHOTOS
// R2 bucket as "headshots/<player-id>.jpg", and writes the public URL back to
// the player's photo_url column in D1.
//
// Setup required in wrangler.toml:
//   [[r2_buckets]]
//   binding = "PHOTOS"
//   bucket_name = "stingtrophyclub-photos"
//   preview_bucket_name = "stingtrophyclub-photos-dev"
//
// The bucket must also have a custom domain or public URL configured in the
// Cloudflare dashboard so images are served publicly.
// ---------------------------------------------------------------------------

async function uploadPhoto(request, env, id) {
  // Photo upload is intentionally PUBLIC — no admin token required.
  // Any visitor can upload/replace a player headshot. All other write
  // operations (edit fields, delete player, etc.) still require the token.

  if (!env.DB) return json({ error: "DB binding missing" }, { status: 500 });
  if (!env.PHOTOS) return json({ error: "R2 PHOTOS binding missing. Add [[r2_buckets]] with binding=PHOTOS in wrangler.toml and create the bucket." }, { status: 500 });

  const existing = await loadPlayer(env, id);
  if (!existing) return json({ error: "Player not found" }, { status: 404 });

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.startsWith("image/")) {
    return json({ error: "Content-Type must be an image/* type" }, { status: 400 });
  }

  const blob = await request.arrayBuffer();
  if (blob.byteLength > 4 * 1024 * 1024) {
    return json({ error: "Image too large (max 4 MB)" }, { status: 413 });
  }

  // Determine extension from content-type (jpeg → .jpg, png → .png, webp → .webp)
  const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
  const key = `headshots/${id}.${ext}`;

  await env.PHOTOS.put(key, blob, {
    httpMetadata: { contentType },
    customMetadata: { playerId: id },
  });

  // Build the public URL. If a PHOTOS_BASE_URL env var is set, use it.
  // Otherwise fall back to the R2 public bucket URL pattern.
  const base = (env.PHOTOS_BASE_URL || "").replace(/\/$/, "");
  const photoUrl = base ? `${base}/${key}` : `https://pub-placeholder.r2.dev/${key}`;

  await env.DB.prepare(
    "UPDATE players SET photo_url = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(photoUrl, id).run();

  const row = await loadPlayer(env, id);
  return json({ player: rowToPlayer(row), photoUrl });
}

async function deletePhoto(request, env, id) {
  const unauthorized = requireAdmin(request, env);
  if (unauthorized) return unauthorized;

  if (!env.DB) return json({ error: "DB binding missing" }, { status: 500 });

  const existing = await loadPlayer(env, id);
  if (!existing) return json({ error: "Player not found" }, { status: 404 });

  // Delete all possible extensions from R2
  if (env.PHOTOS) {
    await Promise.allSettled([
      env.PHOTOS.delete(`headshots/${id}.jpg`),
      env.PHOTOS.delete(`headshots/${id}.png`),
      env.PHOTOS.delete(`headshots/${id}.webp`),
    ]);
  }

  await env.DB.prepare(
    "UPDATE players SET photo_url = '', updated_at = datetime('now') WHERE id = ?"
  ).bind(id).run();

  const row = await loadPlayer(env, id);
  return json({ player: rowToPlayer(row) });
}

// ---------------------------------------------------------------------------
// Self-serve bio update  GET/POST /bio/:id
// Public page — no admin token. Player visits their unique link and submits
// a short bio (max 280 chars). Renders a simple branded HTML form.
// ---------------------------------------------------------------------------
async function handleBioPage(request, env, id) {
  const method = request.method.toUpperCase();
  const row = await loadPlayer(env, id);
  if (!row) return new Response('Player not found', { status: 404, headers: corsHeaders() });
  const p = rowToPlayer(row);
  const name = [p.firstName, p.lastName].filter(Boolean).join(' ');

  if (method === 'POST') {
    const form = await request.formData().catch(() => null);
    const bio = form ? String(form.get('bio') || '').slice(0, 280).trim() : '';
    await env.DB.prepare("UPDATE players SET bio = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(bio, id).run();
    return new Response(bioPageHtml(name, bio, true), { headers: { 'content-type': 'text/html;charset=UTF-8' } });
  }

  return new Response(bioPageHtml(name, p.bio || '', false), { headers: { 'content-type': 'text/html;charset=UTF-8' } });
}

function bioPageHtml(name, currentBio, saved) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Player Bio — ${escHtml(name)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1f26;color:#e8e0d0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:#162830;border:1px solid #2a4a55;border-radius:18px;padding:32px;width:min(480px,100%);display:flex;flex-direction:column;gap:20px}
  h1{font-size:22px;color:#67b7c9}
  p{font-size:14px;color:#9ab;line-height:1.6}
  textarea{width:100%;background:#0d1f26;border:1px solid #2a4a55;border-radius:10px;color:#e8e0d0;font-size:15px;padding:12px;resize:vertical;min-height:100px;font-family:inherit}
  textarea:focus{outline:none;border-color:#67b7c9}
  .counter{font-size:12px;color:#9ab;text-align:right;margin-top:4px}
  button{background:#67b7c9;color:#0d1f26;border:none;border-radius:10px;padding:12px 28px;font-size:15px;font-weight:700;cursor:pointer;align-self:flex-start}
  button:hover{background:#89ccd9}
  .saved{background:#1a3a2a;border:1px solid #2a6a4a;border-radius:10px;padding:14px;color:#67c98a;font-size:14px}
  .logo{display:flex;align-items:center;gap:12px}
  .logo img{width:44px;height:44px;object-fit:contain}
  .logo span{font-size:13px;color:#9ab}
</style></head><body>
<div class="card">
  <div class="logo"><img src="/assets/Sting-Logo.jpg" alt="Sting"><span>Sting Soccer • Trophy Club</span></div>
  <h1>Hey ${escHtml(name)}!</h1>
  <p>Share a little about yourself for the match day program. Hometown, your club background, favorite position, a fun fact — keep it to 2-3 sentences.</p>
  ${saved ? '<div class="saved">✓ Bio saved! Thanks — it will appear in the match day program.</div>' : ''}
  <form method="POST">
    <textarea name="bio" maxlength="280" oninput="document.getElementById('ct').textContent=280-this.value.length+' left'" placeholder="e.g. I'm from Southlake, TX and have played with Sting since U10. I play center mid and love to set up goals for my teammates.">${escHtml(currentBio)}</textarea>
    <div class="counter"><span id="ct">${280 - currentBio.length} left</span></div>
    <button type="submit">Save my bio</button>
  </form>
</div></body></html>`;
}

function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ---------------------------------------------------------------------------
// Match Day Program  GET /program
// Renders a print-optimised HTML page with cover + team roster pages.
// 6 players per page (2 col × 3 row). No auth required.
// ---------------------------------------------------------------------------
async function handleProgram(request, env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM players WHERE status != 'Declined' ORDER BY team_override IS NULL, birthdate, last_name"
  ).all();
  const players = results.map(rowToPlayer);
  const u17 = players.filter(p => (p.teamOverride || p.teamBucket) === 'U17');
  const u16 = players.filter(p => (p.teamOverride || p.teamBucket) === 'U16');
  const baseUrl = new URL(request.url).origin;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sting Soccer • Match Day Program</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',sans-serif;background:#fff;color:#111;-webkit-print-color-adjust:exact;print-color-adjust:exact}

  /* ---- Cover page ---- */
  .cover{width:100%;min-height:100vh;background:linear-gradient(160deg,#0d1f26 0%,#162e38 50%,#0a2a1a 100%);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;padding:48px 32px;page-break-after:always}
  .cover-logo{width:140px;height:140px;object-fit:contain;filter:drop-shadow(0 4px 24px rgba(103,183,201,.4))}
  .cover-title{font-size:48px;font-weight:900;color:#fff;text-align:center;line-height:1.1;letter-spacing:-1px}
  .cover-title span{color:#67b7c9}
  .cover-sub{font-size:20px;color:#9ab;text-align:center}
  .cover-date{font-size:16px;color:#67b7c9;font-weight:600;letter-spacing:1px;text-transform:uppercase}
  .cover-teams{display:flex;gap:32px;flex-wrap:wrap;justify-content:center;margin-top:8px}
  .cover-team-pill{background:rgba(103,183,201,.12);border:1px solid rgba(103,183,201,.3);border-radius:40px;padding:10px 22px;display:flex;align-items:center;gap:10px}
  .cover-team-pill img{width:32px;height:32px;object-fit:contain}
  .cover-team-pill span{color:#e8e0d0;font-size:14px;font-weight:600}
  .cover-footer{font-size:13px;color:#556;text-align:center;margin-top:auto}

  /* ---- Team divider page ---- */
  .team-divider{width:100%;min-height:50vh;background:linear-gradient(135deg,#0d1f26,#162e38);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:48px 32px;page-break-before:always;page-break-after:always}
  .team-divider img.league-logo{width:80px;height:80px;object-fit:contain;opacity:.9}
  .team-divider h2{font-size:36px;font-weight:900;color:#fff;text-align:center}
  .team-divider .coach-line{font-size:16px;color:#9ab;text-align:center}
  .team-divider .coach-line strong{color:#67b7c9}

  /* ---- Roster page ---- */
  .roster-page{padding:24px 28px;page-break-before:always}
  .roster-header{display:flex;align-items:center;gap:14px;margin-bottom:20px;padding-bottom:14px;border-bottom:2px solid #e8e0d0}
  .roster-header img.sting{width:44px;height:44px;object-fit:contain}
  .roster-header .rh-text h3{font-size:18px;font-weight:800;color:#0d1f26}
  .roster-header .rh-text p{font-size:12px;color:#667;margin-top:2px}
  .roster-header .page-num{margin-left:auto;font-size:12px;color:#aaa;font-weight:600}

  /* ---- Player grid ---- */
  .player-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .player-card{display:flex;gap:14px;align-items:flex-start;background:#f8f6f2;border-radius:14px;padding:14px;border:1px solid #e8e0d0;page-break-inside:avoid}
  .player-card .photo-wrap{flex-shrink:0;width:88px;height:88px;border-radius:10px;overflow:hidden;background:#d8d0c8;display:flex;align-items:center;justify-content:center}
  .player-card .photo-wrap img{width:100%;height:100%;object-fit:cover}
  .player-card .photo-wrap .ph{font-size:36px;opacity:.4}
  .player-card .info{flex:1;min-width:0}
  .player-card .kit-num{font-size:28px;font-weight:900;color:#0d1f26;line-height:1;margin-bottom:2px}
  .player-card .pname{font-size:14px;font-weight:800;color:#0d1f26;line-height:1.2}
  .player-card .pos-age{font-size:11px;color:#667;font-weight:600;margin-top:3px;text-transform:uppercase;letter-spacing:.4px}
  .player-card .bio{font-size:11px;color:#444;margin-top:6px;line-height:1.5;font-style:italic}
  .player-card .bio-empty{font-size:10px;color:#bbb;margin-top:6px;font-style:italic}

  /* ---- Print rules ---- */
  @media print {
    @page{margin:12mm 10mm}
    .cover{min-height:auto;height:calc(100vh - 24mm)}
    .no-print{display:none}
    a{color:inherit;text-decoration:none}
  }
  @media screen {
    body{max-width:860px;margin:0 auto;padding:16px}
    .cover{border-radius:18px;min-height:auto;padding:64px 48px;margin-bottom:32px}
    .team-divider{border-radius:18px;margin-bottom:32px}
    .roster-page{border:1px solid #e8e0d0;border-radius:18px;margin-bottom:32px}
    .print-btn{position:fixed;bottom:24px;right:24px;background:#0d1f26;color:#67b7c9;border:none;border-radius:40px;padding:14px 28px;font-size:15px;font-weight:700;cursor:pointer;box-shadow:0 4px 24px rgba(0,0,0,.3);z-index:99;font-family:inherit}
    .print-btn:hover{background:#162e38}
    .back-btn{display:inline-block;margin-bottom:16px;color:#0d1f26;font-size:14px;font-weight:600;text-decoration:none;padding:8px 16px;border:1px solid #ddd;border-radius:8px}
  }
</style>
</head>
<body>

<a href="/" class="back-btn no-print">← Back to Dashboard</a>
<button class="print-btn no-print" onclick="window.print()">Print / Save PDF</button>

<!-- COVER -->
<div class="cover">
  <img class="cover-logo" src="${baseUrl}/assets/Sting-Logo.jpg" alt="Sting Soccer">
  <div class="cover-title">Match Day<br><span>Program</span></div>
  <div class="cover-sub">Sting Soccer • Trophy Club</div>
  <div class="cover-date">${new Date().toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</div>
  <div class="cover-teams">
    <div class="cover-team-pill">
      <img src="${baseUrl}/assets/N1-league-logo.jpg" alt="N1">
      <span>U17 Boys • N1<br><small style="font-weight:400;color:#9ab">Coach Jon Barber</small></span>
    </div>
    <div class="cover-team-pill">
      <img src="${baseUrl}/assets/ECNL-RL-boys.jpg" alt="ECNL RL">
      <span>U16 Boys • ECNL RL NTX<br><small style="font-weight:400;color:#9ab">Coach Wayne Smith</small></span>
    </div>
  </div>
  <div class="cover-footer">stingtrophyclub.jon-barber.workers.dev</div>
</div>

${teamSection(u17, 'U17 Boys', 'N1 National League', 'Coach Jon Barber', baseUrl+'/assets/N1-league-logo.jpg', baseUrl)}
${teamSection(u16, 'U16 Boys', 'ECNL RL NTX', 'Coach Wayne Smith', baseUrl+'/assets/ECNL-RL-boys.jpg', baseUrl)}

</body></html>`;

  return new Response(html, { headers: { 'content-type': 'text/html;charset=UTF-8' } });
}

function teamSection(players, teamName, league, coach, leagueLogo, baseUrl) {
  if (!players.length) return '';
  const chunks = [];
  for (let i = 0; i < players.length; i += 6) chunks.push(players.slice(i, i + 6));
  const totalPages = chunks.length;

  const divider = `
<div class="team-divider">
  <img class="league-logo" src="${escHtml(leagueLogo)}" alt="">
  <h2>${escHtml(teamName)}</h2>
  <div class="coach-line">${escHtml(league)} &nbsp;•&nbsp; <strong>${escHtml(coach)}</strong></div>
  <div style="margin-top:8px;font-size:13px;color:#556">${players.length} Players</div>
</div>`;

  const pages = chunks.map((chunk, pageIdx) => `
<div class="roster-page">
  <div class="roster-header">
    <img class="sting" src="${baseUrl}/assets/Sting-Logo.jpg" alt="Sting">
    <div class="rh-text">
      <h3>${escHtml(teamName)} • ${escHtml(league)}</h3>
      <p>${escHtml(coach)}</p>
    </div>
    <div class="page-num">${escHtml(teamName)} &nbsp; ${pageIdx + 1} / ${totalPages}</div>
  </div>
  <div class="player-grid">
    ${chunk.map(p => playerCard(p, baseUrl)).join('')}
  </div>
</div>`).join('');

  return divider + pages;
}

function playerCard(p, baseUrl) {
  const name = [p.firstName, p.lastName].filter(Boolean).join(' ');
  const photo = p.photoUrl
    ? `<img src="${escHtml(p.photoUrl)}" alt="${escHtml(name)}" loading="lazy">`
    : `<div class="ph">👤</div>`;
  const age = p.teamBucket === 'U17' ? 'U17 Boys' : p.teamBucket === 'U16' ? 'U16 Boys' : '';
  const bioLine = p.bio
    ? `<div class="bio">${escHtml(p.bio)}</div>`
    : `<div class="bio-empty">Bio coming soon</div>`;
  return `
  <div class="player-card">
    <div class="photo-wrap">${photo}</div>
    <div class="info">
      <div class="kit-num">${p.kitNumber ? escHtml(p.kitNumber) : '—'}</div>
      <div class="pname">${escHtml(name)}</div>
      <div class="pos-age">${escHtml(p.position || 'Position TBD')} &nbsp;•&nbsp; ${escHtml(age)}</div>
      ${bioLine}
    </div>
  </div>`;
}

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === "/api/sync/google-sheet" || path === "/api/sync/google-sheet/") {
    if (method === "POST") return handleSyncRequest(request, env);
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { allow: "POST, OPTIONS" } });
    }
    return json({ error: "Method not allowed" }, { status: 405, headers: { allow: "POST, OPTIONS" } });
  }

  if (path === "/api/players" || path === "/api/players/") {
    if (method === "GET") return listPlayers(env);
    if (method === "POST") return createPlayer(request, env);
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { allow: "GET, POST, OPTIONS" } });
    }
    return json({ error: "Method not allowed" }, { status: 405, headers: { allow: "GET, POST, OPTIONS" } });
  }

  // Photo upload: PUT /api/players/:id/photo
  const mPhoto = /^\/api\/players\/([^/]+)\/photo\/?$/.exec(path);
  if (mPhoto) {
    const id = decodeURIComponent(mPhoto[1]);
    if (method === "PUT") return uploadPhoto(request, env, id);
    if (method === "DELETE") return deletePhoto(request, env, id);
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { allow: "PUT, DELETE, OPTIONS" } });
    }
    return json({ error: "Method not allowed" }, { status: 405, headers: { allow: "PUT, DELETE, OPTIONS" } });
  }

  const m = /^\/api\/players\/([^/]+)\/?$/.exec(path);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (method === "GET") return getPlayer(env, id);
    if (method === "PATCH") return updatePlayer(request, env, id, { fillDefaults: false });
    if (method === "PUT") return updatePlayer(request, env, id, { fillDefaults: true });
    if (method === "DELETE") return deletePlayer(request, env, id);
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { allow: "GET, PATCH, PUT, DELETE, OPTIONS" } });
    }
    return json({ error: "Method not allowed" }, { status: 405, headers: { allow: "GET, PATCH, PUT, DELETE, OPTIONS" } });
  }

  return json({ error: "Not found" }, { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }
    // Self-serve bio page: GET/POST /bio/:id
    const bioMatch = /^\/bio\/([^/]+)\/?$/.exec(url.pathname);
    if (bioMatch) {
      return handleBioPage(request, env, decodeURIComponent(bioMatch[1]));
    }
    // Match day program page: GET /program
    if (url.pathname === '/program' || url.pathname === '/program/') {
      return handleProgram(request, env);
    }
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  },
};
