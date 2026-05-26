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
const POST_INIT_COLUMNS = ["team_override"];

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
