// Manual admin-triggered Google Form/Sheet sync.
//
// The Google Form responses live in a public Google Sheet, exported as CSV at
// the URL below. This handler fetches the CSV, filters to rows submitted in
// 2026, maps each survey row onto the players-table shape, and inserts any
// rows that don't already look like a duplicate of an existing player.

import { parseCsv, rowsToObjects } from "./csv.js";
import { COLUMNS, json, makeId, playerToColumns, requireAdmin, rowToPlayer } from "./shared.js";

const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1SFdOSqkFWCyzoeOuCfIK6TkNuDTiRVuCwgEPtcI6Mfc/export?format=csv";

// Google Form column titles. Kept here so a small wording change in the form
// is one edit, not a hunt through the file.
const COL = {
  timestamp: "Timestamp",
  firstName: "Player First Name",
  lastName: "Player Last Name",
  birthday: "Player Birth day",
  gender: "Player Gender",
  parent1First: "Parent First Name",
  parent1Last: "Parent Last Name",
  parent1Phone: "Parent Phone Number",
  parent1Email: "Parent e-mail",
  parent2First: "Parent 2 First Name",
  parent2Last: "Parent 2 Last Name",
  parent2Phone: "Parent 2 Phone Number",
  parent2Email: "Parent 2 e-mail",
  school: "What school does the player attend?",
  position: "What position(s) do you prefer and gravitate towards?",
  grade: "What is your grade range?",
  recentClub: "What team or club have you most recently played with?",
};

const norm = s => String(s ?? "").trim();
const lowerNorm = s => norm(s).toLowerCase().replace(/\s+/g, " ");

// "5/14/2026 19:26:36" or "5/14/2026" → "2026" (returns null if unparseable).
export function timestampYear(ts) {
  const s = norm(ts);
  if (!s) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return Number(m[3]);
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.getUTCFullYear();
  return null;
}

// Normalize a date that could be "1/21/2010", "2010-01-21", or "01/21/2010"
// into YYYY-MM-DD. Returns "" if it can't be parsed.
export function normalizeBirthdate(raw) {
  const s = norm(raw);
  if (!s) return "";
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${String(+m[2]).padStart(2, "0")}-${String(+m[3]).padStart(2, "0")}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) {
    const month = +m[1];
    const day = +m[2];
    let year = +m[3];
    if (year < 100) year += year >= 50 ? 1900 : 2000;
    if (!month || !day || !year) return "";
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const da = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${mo}-${da}`;
  }
  return "";
}

function pickName(first, last) {
  return `${norm(first)} ${norm(last)}`.replace(/\s+/g, " ").trim();
}

// Build a player payload (camelCase, matching what the existing /api/players
// POST path expects) from one Google Form response row.
export function mapRowToPlayer(row) {
  const firstName = norm(row[COL.firstName]);
  const lastName = norm(row[COL.lastName]);
  const birthdate = normalizeBirthdate(row[COL.birthday]);
  const gender = norm(row[COL.gender]);
  const grade = norm(row[COL.grade]);
  const school = norm(row[COL.school]);
  const position = norm(row[COL.position]);
  const club = norm(row[COL.recentClub]);
  const ts = norm(row[COL.timestamp]);

  const contact1Name = pickName(row[COL.parent1First], row[COL.parent1Last]);
  const contact1Phone = norm(row[COL.parent1Phone]);
  const contact1Email = norm(row[COL.parent1Email]);
  const contact2Name = pickName(row[COL.parent2First], row[COL.parent2Last]);
  const contact2Phone = norm(row[COL.parent2Phone]);
  const contact2Email = norm(row[COL.parent2Email]);

  const noteLines = [
    "Source: Google Form",
    ts ? `Form timestamp: ${ts}` : "",
    grade ? `Grade range: ${grade}` : "",
    gender ? `Gender: ${gender}` : "",
  ].filter(Boolean);

  return {
    firstName,
    lastName,
    birthdate,
    status: "Prospect",
    position,
    school,
    club,
    playerType: "prospect",
    offerSent: "",
    commitmentDate: "",
    followUp: true,
    email: "",
    phone: "",
    contact1Name,
    contact1Phone,
    contact1Email,
    contact2Name,
    contact2Phone,
    contact2Email,
    notes: noteLines.join("\n"),
  };
}

// Two players match if their normalized first+last+birthdate match AND
// (when both rows have a primary contact email) the contact emails also
// match. When one side has no email we fall back to first+last+birthdate.
export function isDuplicate(candidate, existing) {
  const a = {
    first: lowerNorm(candidate.firstName),
    last: lowerNorm(candidate.lastName),
    birth: lowerNorm(candidate.birthdate),
    email: lowerNorm(candidate.contact1Email),
  };
  const b = {
    first: lowerNorm(existing.firstName ?? existing.first_name),
    last: lowerNorm(existing.lastName ?? existing.last_name),
    birth: lowerNorm(existing.birthdate),
    email: lowerNorm(existing.contact1Email ?? existing.contact1_email),
  };
  if (!a.first || !a.last) return false;
  if (a.first !== b.first || a.last !== b.last) return false;
  if (a.birth && b.birth && a.birth !== b.birth) return false;
  if (a.birth && !b.birth) return false;
  if (!a.birth && b.birth) return false;
  if (a.email && b.email) return a.email === b.email;
  return true;
}

async function fetchSheetCsv(env) {
  const base = (env && env.SHEET_CSV_URL) || SHEET_CSV_URL;
  // Bust both the upstream Google export cache and Cloudflare's own fetch
  // cache so admin-triggered syncs always see the latest form responses.
  // Without this, a sync run minutes after a new form submission can return
  // a stale CSV and silently skip the new row (it never reaches the dedup
  // step because it isn't in the response).
  const sep = base.includes("?") ? "&" : "?";
  const url = `${base}${sep}_=${Date.now()}`;
  const res = await fetch(url, {
    redirect: "follow",
    cache: "no-store",
    cf: { cacheTtl: 0, cacheEverything: false },
    headers: {
      "user-agent": "stingtrophyclub-sync/1.0",
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
  });
  if (!res.ok) {
    throw new Error(`Sheet fetch failed: HTTP ${res.status}`);
  }
  return await res.text();
}

async function insertPlayer(env, body) {
  const id = makeId(body);
  const cols = playerToColumns(body, { fillDefaults: true });
  const colNames = ["id", ...COLUMNS.map(([c]) => c)];
  const placeholders = colNames.map(() => "?").join(", ");
  const values = [id, ...COLUMNS.map(([c]) => cols[c])];
  let finalId = id;
  try {
    await env.DB.prepare(
      `INSERT INTO players (${colNames.join(", ")}) VALUES (${placeholders})`
    ).bind(...values).run();
  } catch (e) {
    const msg = String((e && e.message) || e).toLowerCase();
    if (msg.includes("unique") || msg.includes("constraint")) {
      finalId = `${id}-${Math.random().toString(36).slice(2, 7)}`;
      values[0] = finalId;
      await env.DB.prepare(
        `INSERT INTO players (${colNames.join(", ")}) VALUES (${placeholders})`
      ).bind(...values).run();
    } else {
      throw e;
    }
  }
  return finalId;
}

// Core sync routine — exported so it can be unit-tested with a mock env.
export async function runSync(env, { csvText } = {}) {
  const summary = {
    rowsScanned: 0,
    considered2026: 0,
    inserted: 0,
    duplicates: 0,
    ignoredNon2026: 0,
    errors: [],
  };

  let text = csvText;
  if (text == null) {
    text = await fetchSheetCsv(env);
  }
  const rows = rowsToObjects(parseCsv(text));
  summary.rowsScanned = rows.length;

  // Load existing players once so we can do in-memory dedup.
  let existing = [];
  if (env && env.DB) {
    const { results } = await env.DB.prepare("SELECT * FROM players").all();
    existing = (results || []).map(rowToPlayer);
  }

  for (const row of rows) {
    try {
      const year = timestampYear(row[COL.timestamp]);
      if (year !== 2026) {
        summary.ignoredNon2026++;
        continue;
      }
      summary.considered2026++;
      const candidate = mapRowToPlayer(row);
      if (!candidate.firstName && !candidate.lastName) {
        summary.errors.push({ row: row[COL.timestamp] || "(unknown)", error: "missing player name" });
        continue;
      }
      if (existing.some(e => isDuplicate(candidate, e))) {
        summary.duplicates++;
        continue;
      }
      if (env && env.DB) {
        const id = await insertPlayer(env, candidate);
        candidate.id = id;
      }
      existing.push(candidate);
      summary.inserted++;
    } catch (e) {
      summary.errors.push({
        row: row[COL.timestamp] || "(unknown)",
        error: String((e && e.message) || e),
      });
    }
  }

  return summary;
}

export async function handleSyncRequest(request, env) {
  if (!env || !env.DB) return json({ error: "DB binding missing" }, { status: 500 });
  const unauthorized = requireAdmin(request, env);
  if (unauthorized) return unauthorized;

  try {
    const summary = await runSync(env);
    return json({ ok: true, summary });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, { status: 502 });
  }
}
