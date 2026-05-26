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
  // Bust both the upstream Google export cache (via a unique query string)
  // and Cloudflare's own fetch cache (via cache: "no-store") so an admin-
  // triggered sync always sees the latest form responses. Without this, a
  // sync run minutes after a new form submission can return a stale CSV
  // and silently skip the new row.
  //
  // Note: do NOT also set the `cf: { cacheTtl, cacheEverything }` block
  // here. Cloudflare Workers rejects that combination with
  //   "CacheTtl: 0, is not compatible with cache: no-store header"
  // because `cf.cacheTtl` is a directive *to* the cache while
  // `cache: "no-store"` says "do not consult the cache at all". The
  // cache-buster query param + `cache: "no-store"` is the supported
  // combination and is sufficient on its own.
  const sep = base.includes("?") ? "&" : "?";
  const url = `${base}${sep}_=${Date.now()}`;
  const res = await fetch(url, {
    redirect: "follow",
    cache: "no-store",
    headers: {
      "user-agent": "stingtrophyclub-sync/1.0",
    },
  });
  const text = res.ok ? await res.text() : "";
  return { url, status: res.status, ok: res.ok, text };
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
    // Names of rows inserted this run — surfaced in the admin response so the
    // operator can see exactly who was imported (or, if expected names are
    // missing, that they were skipped/deduped). Kept short (first + last) to
    // avoid leaking the rest of the row to logs.
    insertedNames: [],
    // Admin-only diagnostic block. Helps answer "why didn't <X> import?"
    // by showing whether the CSV the worker fetched actually contained the
    // row, and what verdict each 2026 candidate received. Names come from
    // the public Google Sheet and from D1 (which the admin already has
    // access to), so no new PII surface.
    debug: {
      fetch: null,             // { url, status, ok, csvByteLength, headerLine, lastDataLine }
      existingCount: 0,
      sawBeckett: false,       // first=Beckett OR last=Jones found in CSV
      beckettCandidate: null,  // { name, birthdate, verdict, dupOf?, error? }
      lastTwo2026Names: [],    // last two 2026 candidate names processed
      duplicateNames: [],      // up to 50 dup candidate names (form name -> existing match)
    },
  };

  let text = csvText;
  // ok=true is the "no fetch needed" default (csvText was supplied directly).
  // It is reset to the real upstream result whenever fetchSheetCsv runs.
  let fetchMeta = { url: null, status: null, ok: true };
  if (text == null) {
    try {
      const r = await fetchSheetCsv(env);
      fetchMeta = { url: r.url, status: r.status, ok: r.ok };
      text = r.text;
      if (!r.ok) {
        summary.errors.push({
          row: "(fetch)",
          error: `Sheet fetch failed: HTTP ${r.status}`,
        });
        text = "";
      }
    } catch (e) {
      fetchMeta = { url: null, status: null, ok: false };
      summary.errors.push({
        row: "(fetch)",
        error: `Sheet fetch threw: ${String((e && e.message) || e)}`,
      });
      text = "";
    }
  }

  // Compute fetch debug. Header line + last non-blank line let the operator
  // confirm the CSV reached the worker fresh, including the trailing row
  // that has no newline.
  const csvByteLength = text ? text.length : 0;
  let headerLine = "";
  let lastDataLine = "";
  if (csvByteLength) {
    const nl = text.indexOf("\n");
    headerLine = (nl >= 0 ? text.slice(0, nl) : text).replace(/\r$/, "");
    // Find last non-blank line
    let end = text.length;
    while (end > 0 && (text[end - 1] === "\n" || text[end - 1] === "\r")) end--;
    let start = end;
    while (start > 0 && text[start - 1] !== "\n" && text[start - 1] !== "\r") start--;
    lastDataLine = text.slice(start, end);
    // Truncate aggressively to avoid leaking the full row in the response
    if (lastDataLine.length > 160) lastDataLine = lastDataLine.slice(0, 160) + "…";
    if (headerLine.length > 240) headerLine = headerLine.slice(0, 240) + "…";
  }
  summary.debug.fetch = {
    url: fetchMeta.url,
    status: fetchMeta.status,
    ok: fetchMeta.ok,
    csvByteLength,
    headerLine,
    lastDataLine,
  };

  const rows = rowsToObjects(parseCsv(text));
  summary.rowsScanned = rows.length;

  // Did the CSV that this sync actually saw contain Beckett's row?
  summary.debug.sawBeckett = rows.some(r => {
    const f = norm(r[COL.firstName]).toLowerCase();
    const l = norm(r[COL.lastName]).toLowerCase();
    return f === "beckett" || l === "jones";
  });

  // Load existing players once so we can do in-memory dedup.
  let existing = [];
  if (env && env.DB) {
    try {
      const { results } = await env.DB.prepare("SELECT * FROM players").all();
      existing = (results || []).map(rowToPlayer);
    } catch (e) {
      summary.errors.push({
        row: "(load-existing)",
        error: `Loading existing players failed: ${String((e && e.message) || e)}`,
      });
    }
  }
  summary.debug.existingCount = existing.length;

  function recordVerdict(candidate, verdict, extra = {}) {
    const name = `${candidate.firstName} ${candidate.lastName}`.trim();
    if (verdict === "duplicate" && summary.debug.duplicateNames.length < 50) {
      summary.debug.duplicateNames.push({
        form: name,
        existing: extra.existingMatch || "(unknown)",
      });
    }
    // Track the last two 2026 candidate names so the operator can confirm
    // the latest sheet entry was actually reached by the loop.
    summary.debug.lastTwo2026Names.push({ name, verdict });
    if (summary.debug.lastTwo2026Names.length > 2) {
      summary.debug.lastTwo2026Names.shift();
    }
    if (
      candidate.firstName.toLowerCase() === "beckett" ||
      candidate.lastName.toLowerCase() === "jones"
    ) {
      summary.debug.beckettCandidate = {
        name,
        birthdate: candidate.birthdate,
        verdict,
        ...extra,
      };
    }
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
        recordVerdict(candidate, "missing-name");
        continue;
      }
      const dupMatch = existing.find(e => isDuplicate(candidate, e));
      if (dupMatch) {
        summary.duplicates++;
        recordVerdict(candidate, "duplicate", {
          existingMatch: `${dupMatch.firstName} ${dupMatch.lastName} (${dupMatch.id})`.trim(),
          dupOfId: dupMatch.id,
        });
        continue;
      }
      if (env && env.DB) {
        try {
          const id = await insertPlayer(env, candidate);
          candidate.id = id;
        } catch (e) {
          summary.errors.push({
            row: `${candidate.firstName} ${candidate.lastName}`.trim() || "(unknown)",
            error: `Insert failed: ${String((e && e.message) || e)}`,
          });
          recordVerdict(candidate, "insert-error", {
            error: String((e && e.message) || e),
          });
          continue;
        }
      }
      existing.push(candidate);
      summary.inserted++;
      summary.insertedNames.push(
        `${candidate.firstName} ${candidate.lastName}`.trim()
      );
      recordVerdict(candidate, "inserted");
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
