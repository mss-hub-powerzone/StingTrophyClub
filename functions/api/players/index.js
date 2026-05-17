// GET  /api/players       — list all players (public)
// POST /api/players       — create a player (requires admin token)

import { COLUMNS, json, makeId, playerToColumns, requireAdmin, rowToPlayer } from "../_shared.js";

export const onRequestGet = async ({ env }) => {
  if (!env.DB) return json({ error: "DB binding missing" }, { status: 500 });
  const { results } = await env.DB.prepare(
    "SELECT * FROM players ORDER BY last_name, first_name"
  ).all();
  return json({ players: (results || []).map(rowToPlayer) });
};

export const onRequestPost = async ({ request, env }) => {
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
};

export const onRequestOptions = () =>
  new Response(null, {
    status: 204,
    headers: {
      "allow": "GET, POST, OPTIONS",
    },
  });
