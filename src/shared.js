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
  ["team_override",   "teamOverride"],
  ["photo_url",       "photoUrl"],
  ["kit_number",      "kitNumber"],
  ["bio",             "bio"],
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

// Canonical (bucket, label, coach, league) for a given team key. The override
// path and the age-window path both feed through this so the dashboard, CSV
// export, and offer-email routing stay consistent.
function teamFieldsFor(bucket) {
  if (bucket === "U17") {
    return { team_bucket: "U17", team_label: "U17 Boys", coach: "Jon Barber", league: "N1" };
  }
  if (bucket === "U16") {
    return { team_bucket: "U16", team_label: "U16 Boys", coach: "Wayne Smith", league: "ECNL RL NTX" };
  }
  return { team_bucket: "Outside Range", team_label: "Outside Range", coach: "", league: "" };
}

function bucketFromBirthdate(birthdate) {
  if (birthdate && birthdate >= "2009-08-01" && birthdate <= "2010-07-31") return "U17";
  if (birthdate && birthdate >= "2010-08-01" && birthdate <= "2011-07-31") return "U16";
  return "Outside Range";
}

function deriveTeamFields(birthdate, override) {
  // Explicit override wins; otherwise fall back to birthdate-derived bucket.
  const normOverride = String(override || "").trim().toUpperCase();
  if (normOverride === "U17" || normOverride === "U16") return teamFieldsFor(normOverride);
  return teamFieldsFor(bucketFromBirthdate(birthdate));
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

  // Normalize team_override values to '', 'U17', or 'U16' so downstream
  // consumers don't have to deal with case/whitespace variants.
  if ("team_override" in out) {
    const norm = String(out.team_override || "").trim().toUpperCase();
    out.team_override = (norm === "U17" || norm === "U16") ? norm : "";
  }

  const birthdateProvided = "birthdate" in body;
  const overrideProvided = "teamOverride" in body;
  const teamProvided = "teamBucket" in body || "teamLabel" in body || "coach" in body || "league" in body;

  // Recompute team_bucket/label/coach/league whenever the inputs that drive
  // them change. The override is sticky in D1, so a future birthdate edit
  // still respects it.
  const shouldDerive = (birthdateProvided && !teamProvided)
    || overrideProvided
    || (fillDefaults && !teamProvided);
  if (shouldDerive) {
    Object.assign(out, deriveTeamFields(out.birthdate || "", out.team_override || ""));
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
