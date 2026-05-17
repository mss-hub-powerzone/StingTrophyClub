// GET    /api/players/:id   — fetch single player (public)
// PATCH  /api/players/:id   — partial update (requires admin token)
// PUT    /api/players/:id   — full replace (requires admin token)
// DELETE /api/players/:id   — delete (requires admin token)

import { COLUMNS, json, playerToColumns, requireAdmin, rowToPlayer } from "../_shared.js";

async function loadPlayer(env, id) {
  return await env.DB.prepare("SELECT * FROM players WHERE id = ?").bind(id).first();
}

export const onRequestGet = async ({ env, params }) => {
  if (!env.DB) return json({ error: "DB binding missing" }, { status: 500 });
  const row = await loadPlayer(env, params.id);
  if (!row) return json({ error: "Not found" }, { status: 404 });
  return json({ player: rowToPlayer(row) });
};

async function update(request, env, id, { fillDefaults }) {
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

export const onRequestPatch = async ({ request, env, params }) => {
  if (!env.DB) return json({ error: "DB binding missing" }, { status: 500 });
  const unauthorized = requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  return update(request, env, params.id, { fillDefaults: false });
};

export const onRequestPut = async ({ request, env, params }) => {
  if (!env.DB) return json({ error: "DB binding missing" }, { status: 500 });
  const unauthorized = requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  return update(request, env, params.id, { fillDefaults: true });
};

export const onRequestDelete = async ({ request, env, params }) => {
  if (!env.DB) return json({ error: "DB binding missing" }, { status: 500 });
  const unauthorized = requireAdmin(request, env);
  if (unauthorized) return unauthorized;

  const existing = await loadPlayer(env, params.id);
  if (!existing) return json({ error: "Not found" }, { status: 404 });
  await env.DB.prepare("DELETE FROM players WHERE id = ?").bind(params.id).run();
  return json({ ok: true, id: params.id });
};

export const onRequestOptions = () =>
  new Response(null, {
    status: 204,
    headers: { "allow": "GET, PATCH, PUT, DELETE, OPTIONS" },
  });

// Silence unused-import warnings if a linter runs.
void COLUMNS;
