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
const POST_INIT_COLUMNS = ["team_override", "photo_url", "kit_number", "bio", "shirt_size"];

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
    const shirtSize = form ? String(form.get('shirt_size') || '').trim() : '';
    const kitNumber = form ? String(form.get('kit_number') || '').slice(0, 4).trim() : '';
    const allowed = ['YS','YM','YL','YXL','AS','AM','AL','AXL','A2XL','A3XL',''];
    const safeSize = allowed.includes(shirtSize) ? shirtSize : '';
    const safeKit = /^[0-9]{0,4}$/.test(kitNumber) ? kitNumber : '';
    await env.DB.prepare("UPDATE players SET bio = ?, shirt_size = ?, kit_number = CASE WHEN ? != '' THEN ? ELSE kit_number END, updated_at = datetime('now') WHERE id = ?")
      .bind(bio, safeSize, safeKit, safeKit, id).run();
    return new Response(bioPageHtml(name, p.photoUrl || '', bio, safeSize, safeKit || p.kitNumber || '', true), { headers: { 'content-type': 'text/html;charset=UTF-8' } });
  }

  return new Response(bioPageHtml(name, p.photoUrl || '', p.bio || '', p.shirtSize || '', p.kitNumber || '', false), { headers: { 'content-type': 'text/html;charset=UTF-8' } });
}

function bioPageHtml(name, photoUrl, currentBio, currentSize, currentKit, saved) {
  const hasPhoto = !!(photoUrl && photoUrl.trim());
  const photoSrc = hasPhoto ? escHtml(photoUrl) : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Player Profile — ${escHtml(name)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1f26;color:#e8e0d0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .card{background:#162830;border:1px solid #2a4a55;border-radius:18px;padding:28px;width:min(480px,100%);display:flex;flex-direction:column;gap:18px}
  h1{font-size:21px;color:#67b7c9;line-height:1.2}
  .sub{font-size:13px;color:#9ab;line-height:1.5}
  label.lbl{font-size:12px;color:#9ab;font-weight:600;margin-bottom:4px;display:block;text-transform:uppercase;letter-spacing:.4px}
  textarea{width:100%;background:#0d1f26;border:1px solid #2a4a55;border-radius:10px;color:#e8e0d0;font-size:15px;padding:12px;resize:vertical;min-height:90px;font-family:inherit}
  textarea:focus,select:focus,input:focus{outline:none;border-color:#67b7c9}
  select,input[type=text]{width:100%;background:#0d1f26;border:1px solid #2a4a55;border-radius:10px;color:#e8e0d0;font-size:15px;padding:11px 12px;appearance:none;-webkit-appearance:none;font-family:inherit}
  .counter{font-size:12px;color:#9ab;text-align:right;margin-top:3px}
  .btn{background:#67b7c9;color:#0d1f26;border:none;border-radius:10px;padding:13px 28px;font-size:15px;font-weight:700;cursor:pointer;width:100%}
  .btn:hover{background:#89ccd9}
  .saved{background:#1a3a2a;border:1px solid #2a6a4a;border-radius:10px;padding:13px;color:#67c98a;font-size:14px}
  .logo{display:flex;align-items:center;gap:12px}
  .logo img.logo-img{width:40px;height:40px;object-fit:contain}
  .logo span{font-size:12px;color:#9ab}
  .photo-wrap{display:flex;align-items:center;gap:16px}
  .photo-wrap img{width:72px;height:72px;border-radius:50%;object-fit:cover;border:2px solid #2a4a55;background:#0d1f26}
  .photo-placeholder{width:72px;height:72px;border-radius:50%;background:#0d1f26;border:2px dashed #2a4a55;display:flex;align-items:center;justify-content:center;font-size:26px;flex-shrink:0}
  .photo-meta{flex:1}
  .photo-meta p{font-size:12px;color:#9ab;margin-top:4px}
  .upload-btn{background:transparent;border:1px solid #2a4a55;border-radius:8px;color:#9ab;padding:7px 14px;font-size:13px;cursor:pointer;font-family:inherit}
  .upload-btn:hover{border-color:#67b7c9;color:#67b7c9}
  #upload-status{font-size:12px;margin-top:6px;color:#9ab;min-height:16px}
  .divider{border:none;border-top:1px solid #2a4a55}
  .field{display:flex;flex-direction:column;gap:4px}
</style></head><body>
<div class="card">
  <div class="logo"><img class="logo-img" src="/assets/Sting-Logo.jpg" alt="Sting"><span>Sting Soccer • Trophy Club</span></div>
  <div>
    <h1>Hey ${escHtml(name)}!</h1>
    <p class="sub">Fill out what you can — it'll show up in the match day program.</p>
  </div>
  ${saved ? '<div class="saved">✓ Saved! Your info has been updated.</div>' : ''}

  <!-- Photo section (JS upload, no page reload) -->
  <div class="field">
    <label class="lbl">Profile photo</label>
    <div class="photo-wrap">
      ${hasPhoto
        ? `<img id="photo-preview" src="${photoSrc}" alt="photo">`
        : `<div class="photo-placeholder" id="photo-placeholder">📷</div>`}
      <div class="photo-meta">
        <button type="button" class="upload-btn" onclick="document.getElementById('photo-file').click()">
          ${hasPhoto ? 'Replace photo' : 'Upload photo'}
        </button>
        <p>Shoulders &amp; above • square works best</p>
        <div id="upload-status"></div>
      </div>
    </div>
    <input type="file" id="photo-file" accept="image/*" style="display:none" onchange="uploadPhoto(this)">
  </div>

  <hr class="divider">

  <!-- Text fields form -->
  <form method="POST" id="info-form">
    <div style="display:flex;flex-direction:column;gap:16px">
      <div class="field">
        <label class="lbl" for="kit_input">Kit # (jersey number)</label>
        <input type="text" id="kit_input" name="kit_number" maxlength="4" inputmode="numeric" pattern="[0-9]*" placeholder="e.g. 10" value="${escHtml(currentKit)}">
      </div>
      <div class="field">
        <label class="lbl" for="size_select">Shirt size</label>
        <select id="size_select" name="shirt_size">
          <option value="">— Select size —</option>
          <optgroup label="Youth">
            <option value="YS" ${currentSize==='YS'?'selected':''}>Youth S</option>
            <option value="YM" ${currentSize==='YM'?'selected':''}>Youth M</option>
            <option value="YL" ${currentSize==='YL'?'selected':''}>Youth L</option>
            <option value="YXL" ${currentSize==='YXL'?'selected':''}>Youth XL</option>
          </optgroup>
          <optgroup label="Adult">
            <option value="AS" ${currentSize==='AS'?'selected':''}>Adult S</option>
            <option value="AM" ${currentSize==='AM'?'selected':''}>Adult M</option>
            <option value="AL" ${currentSize==='AL'?'selected':''}>Adult L</option>
            <option value="AXL" ${currentSize==='AXL'?'selected':''}>Adult XL</option>
            <option value="A2XL" ${currentSize==='A2XL'?'selected':''}>Adult 2XL</option>
            <option value="A3XL" ${currentSize==='A3XL'?'selected':''}>Adult 3XL</option>
          </optgroup>
        </select>
      </div>
      <div class="field">
        <label class="lbl" for="bio_input">Player bio</label>
        <textarea id="bio_input" name="bio" maxlength="280" oninput="document.getElementById('ct').textContent=280-this.value.length+' left'" placeholder="e.g. I'm from Southlake TX, have played with Sting since U10. I play center mid and love to set up goals.">${escHtml(currentBio)}</textarea>
        <div class="counter"><span id="ct">${280 - currentBio.length} left</span></div>
      </div>
      <button type="submit" class="btn">Save my info</button>
    </div>
  </form>
</div>
<script>
const PLAYER_ID = ${JSON.stringify(name)};
async function uploadPhoto(input) {
  const file = input.files[0];
  if (!file) return;
  const status = document.getElementById('upload-status');
  status.textContent = 'Uploading…';
  // Derive player ID from current URL path: /bio/<id>
  const pathId = location.pathname.replace(/^\\/bio\\//, '').replace(/\\/$/, '');
  try {
    const res = await fetch('/api/players/' + encodeURIComponent(pathId) + '/photo', {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'image/jpeg' },
      body: file
    });
    if (!res.ok) throw new Error('Upload failed (' + res.status + ')');
    const data = await res.json();
    status.textContent = '✓ Photo uploaded!';
    status.style.color = '#67c98a';
    // Swap in the new photo
    const url = data.photoUrl || data.photo_url || '';
    if (url) {
      const preview = document.getElementById('photo-preview');
      const placeholder = document.getElementById('photo-placeholder');
      if (preview) {
        preview.src = url;
      } else if (placeholder) {
        const img = document.createElement('img');
        img.id = 'photo-preview';
        img.src = url;
        img.alt = 'photo';
        img.style.cssText = 'width:72px;height:72px;border-radius:50%;object-fit:cover;border:2px solid #2a4a55';
        placeholder.replaceWith(img);
      }
    }
  } catch(e) {
    status.textContent = '✗ ' + e.message;
    status.style.color = '#e79ac2';
  }
  input.value = '';
}
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Player self-serve lookup  GET /update
// Public page — lists all active players so they can find themselves and tap
// through to their /bio/:id self-serve form.
// ---------------------------------------------------------------------------
async function handleUpdateLookup(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, first_name, last_name, team_bucket, team_label, team_override, photo_url, kit_number, bio, shirt_size FROM players WHERE status != 'Declined' ORDER BY last_name, first_name"
  ).all();

  const players = (results || []).map(r => ({
    id: r.id,
    name: [r.first_name, r.last_name].filter(Boolean).join(' '),
    team: r.team_override || r.team_bucket || '',
    teamLabel: r.team_label || r.team_override || r.team_bucket || '',
    hasPhoto: !!(r.photo_url && r.photo_url.trim()),
    hasBio: !!(r.bio && r.bio.trim()),
    hasSize: !!(r.shirt_size && r.shirt_size.trim()),
    kit: r.kit_number || '',
  }));

  const u17 = players.filter(p => p.team === 'U17');
  const u16 = players.filter(p => p.team === 'U16');
  const other = players.filter(p => p.team !== 'U17' && p.team !== 'U16');

  function renderGroup(label, group) {
    if (!group.length) return '';
    const rows = group.map(p => {
      const done = [p.hasPhoto, p.hasBio, p.hasSize].filter(Boolean).length;
      const pct = Math.round(done / 3 * 100);
      const badge = pct === 100 ? '✓' : pct >= 67 ? '⬤⬤○' : pct >= 33 ? '⬤○○' : '○○○';
      const color = pct === 100 ? '#67c98a' : pct >= 67 ? '#67b7c9' : '#9ab';
      return `<a class="player-row" href="/bio/${encodeURIComponent(p.id)}">
        <span class="pname">${escHtml(p.name)}</span>
        <span class="pstatus" style="color:${color}">${badge}</span>
      </a>`;
    }).join('');
    return `<div class="group"><div class="group-label">${escHtml(label)}</div>${rows}</div>`;
  }

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Player Info Update — Sting Soccer</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1f26;color:#e8e0d0;min-height:100vh;padding:24px 16px}
  .page{max-width:480px;margin:0 auto;display:flex;flex-direction:column;gap:20px}
  .logo{display:flex;align-items:center;gap:12px}
  .logo img{width:44px;height:44px;object-fit:contain}
  .logo-text h2{font-size:16px;font-weight:800;color:#e8e0d0;line-height:1}
  .logo-text p{font-size:12px;color:#9ab;margin-top:2px}
  .intro{font-size:14px;color:#9ab;line-height:1.6}
  .search-wrap{position:relative}
  #search{width:100%;background:#162830;border:1px solid #2a4a55;border-radius:12px;color:#e8e0d0;font-size:16px;padding:13px 16px;font-family:inherit}
  #search:focus{outline:none;border-color:#67b7c9}
  .group{background:#162830;border:1px solid #2a4a55;border-radius:14px;overflow:hidden}
  .group-label{font-size:11px;font-weight:700;color:#67b7c9;text-transform:uppercase;letter-spacing:.7px;padding:10px 16px;border-bottom:1px solid #2a4a55;background:#0d1f26}
  .player-row{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;border-bottom:1px solid #1a3040;text-decoration:none;color:#e8e0d0;transition:background .15s}
  .player-row:last-child{border-bottom:none}
  .player-row:hover,.player-row:active{background:#1e3844}
  .pname{font-size:15px;font-weight:600}
  .pstatus{font-size:13px;letter-spacing:1px}
  .legend{font-size:11px;color:#9ab;text-align:center;line-height:1.8}
  #no-results{display:none;text-align:center;font-size:14px;color:#9ab;padding:20px}
</style></head><body>
<div class="page">
  <div class="logo">
    <img src="/assets/Sting-Logo.jpg" alt="Sting">
    <div class="logo-text"><h2>Sting Soccer</h2><p>Trophy Club</p></div>
  </div>
  <p class="intro">Find your name below and tap it to update your photo, jersey number, shirt size, and bio for the match day program.</p>
  <div class="search-wrap">
    <input type="search" id="search" placeholder="Search your name…" autocomplete="off" autocorrect="off" spellcheck="false">
  </div>
  <div id="player-list">
    ${renderGroup('U17 Boys — N1 National', u17)}
    ${renderGroup('U16 Boys — ECNL RL', u16)}
    ${renderGroup('Other', other)}
  </div>
  <p id="no-results">No players found.</p>
  <p class="legend">✓ = all info complete &nbsp;|&nbsp; ⬤ = some info filled &nbsp;|&nbsp; ○ = not started</p>
</div>
<script>
const search = document.getElementById('search');
const list = document.getElementById('player-list');
const noResults = document.getElementById('no-results');
search.addEventListener('input', () => {
  const q = search.value.toLowerCase().trim();
  let any = false;
  list.querySelectorAll('.player-row').forEach(row => {
    const match = !q || row.querySelector('.pname').textContent.toLowerCase().includes(q);
    row.style.display = match ? '' : 'none';
    if (match) any = true;
  });
  list.querySelectorAll('.group').forEach(g => {
    const vis = [...g.querySelectorAll('.player-row')].some(r => r.style.display !== 'none');
    g.style.display = vis ? '' : 'none';
  });
  noResults.style.display = any ? 'none' : 'block';
});
search.focus();
</script>
</body></html>`;

  return new Response(html, { headers: { 'content-type': 'text/html;charset=UTF-8' } });
}


function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ---------------------------------------------------------------------------
// Match Day Program  GET /program
// One page per team. 3-col grid, up to 12 players per page. No cover page.
// ---------------------------------------------------------------------------
async function handleProgram(request, env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM players WHERE status != 'Declined' ORDER BY CAST(kit_number AS INTEGER), last_name"
  ).all();
  const players = results.map(rowToPlayer);
  const u17 = players.filter(p => (p.teamOverride || p.teamBucket) === 'U17');
  const u16 = players.filter(p => (p.teamOverride || p.teamBucket) === 'U16');
  const baseUrl = new URL(request.url).origin;
  const today = new Date().toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  const css = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',sans-serif;background:#fff;color:#111;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .team-page{padding:12px 14px;page-break-after:always}
  .team-page:last-child{page-break-after:auto}
  .th{display:flex;align-items:center;gap:12px;background:linear-gradient(135deg,#0d1f26,#162e38);border-radius:12px;padding:11px 16px;margin-bottom:10px}
  .th .sl{width:42px;height:42px;object-fit:contain;flex-shrink:0}
  .th .ll{width:34px;height:34px;object-fit:contain;flex-shrink:0;opacity:.9}
  .th .hi{flex:1}
  .th .hi h2{font-size:19px;font-weight:900;color:#fff;line-height:1}
  .th .hi p{font-size:11px;color:#9ab;margin-top:3px}
  .th .hd{font-size:10px;color:#67b7c9;font-weight:600;text-align:right;white-space:nowrap}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}
  .pc{display:flex;gap:8px;align-items:flex-start;background:#f7f5f1;border-radius:9px;padding:8px;border:1px solid #e4dfd6;page-break-inside:avoid}
  .pw{flex-shrink:0;width:64px;height:64px;border-radius:7px;overflow:hidden;background:#ddd8d0;display:flex;align-items:center;justify-content:center}
  .pw img{width:100%;height:100%;object-fit:cover}
  .pw .ph{font-size:26px;opacity:.35}
  .inf{flex:1;min-width:0}
  .kn{font-size:23px;font-weight:900;color:#0d1f26;line-height:1}
  .nm{font-size:11.5px;font-weight:800;color:#0d1f26;line-height:1.2;margin-top:1px}
  .pa{font-size:9.5px;color:#778;font-weight:600;margin-top:2px;text-transform:uppercase;letter-spacing:.3px}
  .bio{font-size:9.5px;color:#444;margin-top:3px;line-height:1.45;font-style:italic;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
  .be{font-size:9px;color:#ccc;margin-top:3px;font-style:italic}
  @media print{@page{size:letter;margin:7mm}.no-print{display:none}}
  @media screen{body{max-width:900px;margin:0 auto;padding:16px}.team-page{border:1px solid #e0dbd4;border-radius:14px;margin-bottom:20px}.print-btn{position:fixed;bottom:20px;right:20px;background:#0d1f26;color:#67b7c9;border:none;border-radius:40px;padding:11px 22px;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,.25);z-index:99;font-family:inherit}.back-btn{display:inline-block;margin-bottom:12px;color:#333;font-size:13px;font-weight:600;text-decoration:none;padding:6px 14px;border:1px solid #ddd;border-radius:8px}}`;
  const body = `<a href="/" class="back-btn no-print">&larr; Dashboard</a>
<button class="print-btn no-print" onclick="window.print()">Print / Save PDF</button>
${teamPage(u17,'U17 Boys','N1 National League','Coach Jon Barber',baseUrl+'/assets/N1-league-logo.jpg',baseUrl,today)}
${teamPage(u16,'U16 Boys','ECNL RL NTX','Coach Wayne Smith',baseUrl+'/assets/ECNL-RL-boys.jpg',baseUrl,today)}`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sting Soccer Match Day Program</title><style>${css}</style></head><body>${body}</body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html;charset=UTF-8' } });
}

function teamPage(players, teamName, league, coach, leagueLogo, baseUrl, today) {
  if (!players.length) return '';
  return `<div class="team-page"><div class="th"><img class="sl" src="${baseUrl}/assets/Sting-Logo.jpg" alt="Sting"><img class="ll" src="${escHtml(leagueLogo)}" alt=""><div class="hi"><h2>${escHtml(teamName)}</h2><p>${escHtml(league)} &bull; ${escHtml(coach)} &bull; ${players.length} Players</p></div><div class="hd">${escHtml(today)}</div></div><div class="grid">${players.map(p => playerCard(p)).join('')}</div></div>`;
}

function playerCard(p) {
  const name = [p.firstName, p.lastName].filter(Boolean).join(' ');
  const photo = p.photoUrl ? `<img src="${escHtml(p.photoUrl)}" alt="${escHtml(name)}" loading="lazy">` : `<div class="ph">&#128100;</div>`;
  const age = p.teamBucket === 'U17' ? 'U17' : p.teamBucket === 'U16' ? 'U16' : '';
  const bio = p.bio ? `<div class="bio">${escHtml(p.bio)}</div>` : `<div class="be">Bio coming soon</div>`;
  return `<div class="pc"><div class="pw">${photo}</div><div class="inf"><div class="kn">${p.kitNumber ? escHtml(p.kitNumber) : '&mdash;'}</div><div class="nm">${escHtml(name)}</div><div class="pa">${escHtml(p.position || 'TBD')} &bull; ${escHtml(age)}</div>${bio}</div></div>`;
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
    // Player self-serve lookup: GET /update
    if (url.pathname === '/update' || url.pathname === '/update/') {
      return handleUpdateLookup(env);
    }
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  },
};
