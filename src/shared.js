// Shared helpers for the /api/players Worker routes.
//
// The dashboard speaks camelCase (firstName, teamBucket, ...); D1 stores
// snake_case columns. Translate at the API boundary so neither side has to
// know about the other.

export const COLUMNS = [
  ["first_name",      "firstName"],
  ["last_name",       "lastName"],
  ["birthdate",       "birthdate"],
  ["team_bucket",     "teamBucket"],
  ["team_label",      "teamLabel"],
  ["coach",           "coach"],
  ["league",          "league"],
  ["status",          "status"],
  ["position",        "position"],
  ["school",          "school"],
  ["club",            "club"],
  ["player_type",     "playerType"],
  ["offer_sent",      "offerSent"],
  ["commitment_date", "commitmentDate"],
  ["follow_up",       "followUp"],
  ["email",           "email"],
  ["phone",           "phone"],
  ["contact1_name",   "contact1Name"],
  ["contact1_phone",  "contact1Phone"],
  ["contact1_email",  "contact1Email"],
  ["contact2_name",   "contact2Name"],
  ["contact2_phone",  "contact2Phone"],
  ["contact2_email",  "contact2Email"],
  ["notes",           "notes"],
];

const BOOL_FIELDS = new Set(["follow_up"]);

export function rowToPlayer(row) {
  const out = { id: row.id };
  for (const [col, key] of COLUMNS) {
    let v = row[col];
    if (BOOL_FIELDS.has(col)) v = !!v;
    if (v === null || v === undefined) v = BOOL_FIELDS.has(col) ? false : "";
    out[key] = v;
  }
  return out;
}

function deriveTeamFields(birthdate) {
  let bucket = "Outside Range";
  if (birthdate && birthdate >= "2009-08-01" && birthdate <= "2010-07-31") bucket = "U17";
  else if (birthdate && birthdate >= "2010-08-01" && birthdate <= "2011-07-31") bucket = "U16";
  const label = bucket === "U17" ? "U17 Boys" : bucket === "U16" ? "U16 Boys" : "Outside Range";
  const coach = bucket === "U17" ? "Jon Barber" : bucket === "U16" ? "Wayne Smith" : "";
  const league = bucket === "U17" ? "N1" : bucket === "U16" ? "ECNL RL NTX" : "";
  return { team_bucket: bucket, team_label: label, coach, league };
}

export function playerToColumns(body, { fillDefaults = false } = {}) {
  const out = {};
  for (const [col, key] of COLUMNS) {
    if (key in body) {
      let v = body[key];
      if (BOOL_FIELDS.has(col)) v = v === true || v === "true" || v === 1 || v === "1";
      else if (v === null || v === undefined) v = "";
      else v = String(v);
      out[col] = v;
    } else if (fillDefaults) {
      out[col] = BOOL_FIELDS.has(col) ? 0 : "";
    }
  }

  const birthdateProvided = "birthdate" in body;
  const teamProvided = "teamBucket" in body || "teamLabel" in body || "coach" in body || "league" in body;
  if (birthdateProvided && !teamProvided) {
    Object.assign(out, deriveTeamFields(out.birthdate || ""));
  } else if (fillDefaults && !teamProvided) {
    Object.assign(out, deriveTeamFields(out.birthdate || ""));
  }

  if (BOOL_FIELDS.has("follow_up") && out.follow_up === true) out.follow_up = 1;
  if (BOOL_FIELDS.has("follow_up") && out.follow_up === false) out.follow_up = 0;
  return out;
}

export function makeId(body) {
  const first = String(body.firstName || "");
  const last = String(body.lastName || "");
  const birth = String(body.birthdate || "");
  const base = (first + "-" + last + "-" + (birth || Math.random().toString(36).slice(2, 9))).toLowerCase();
  let id = base.replace(/[^a-z0-9-]/g, "");
  if (!id) id = "p" + Math.random().toString(36).slice(2, 9);
  return id;
}

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers || {}),
    },
  });
}

export function getAdminToken(env) {
  if (!env) return "";
  const candidates = [env.ADMIN_TOKEN, env.admin_token, env.Admin_Token];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return "";
}

export function requireAdmin(request, env) {
  const expected = getAdminToken(env);
  if (!expected) {
    return json(
      { error: "Admin token is not configured in Cloudflare environment variables/secrets." },
      { status: 503 }
    );
  }
  const header = request.headers.get("authorization") || "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const xToken = request.headers.get("x-admin-token") || "";
  const provided = bearer || xToken;
  if (!provided || provided !== expected) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
