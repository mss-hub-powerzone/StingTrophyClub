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
const POST_INIT_COLUMNS = ["team_override", "photo_url", "kit_number"];

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
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  },
};
