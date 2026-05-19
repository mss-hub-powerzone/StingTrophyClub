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

  const colNames = ["id", ...COLUMNS.map(([c]) => c)];
  const placeholders = colNames.map(() => "?").join(", ");
  const values = [id, ...COLUMNS.map(([c]) => cols[c])];

  try {
    await env.DB.prepare(
      `INSERT INTO players (${colNames.join(", ")}) VALUES (${placeholders})`
    ).bind(...values).run();
  } catch (e) {
    const msg = String(e && e.message || e);
    if (msg.toLowerCase().includes("unique") || msg.toLowerCase().includes("constraint")) {
      return json({ error: "Player with this id already exists", id }, { status: 409 });
    }
    return json({ error: msg }, { status: 500 });
  }

  const row = await env.DB.prepare("SELECT * FROM players WHERE id = ?").bind(id).first();
  return json({ player: rowToPlayer(row) }, { status: 201 });
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

  const cols = playerToColumns(body, { fillDefaults });
  const colNames = Object.keys(cols);
  if (colNames.length === 0) {
    return json({ player: rowToPlayer(existing) });
  }
  const setClause = colNames.map(c => `${c} = ?`).join(", ");
  const values = colNames.map(c => cols[c]);

  await env.DB.prepare(
    `UPDATE players SET ${setClause}, updated_at = datetime('now') WHERE id = ?`
  ).bind(...values, id).run();

  const row = await loadPlayer(env, id);
  return json({ player: rowToPlayer(row) });
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
