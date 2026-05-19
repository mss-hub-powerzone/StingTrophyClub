// Tiny RFC 4180-ish CSV parser.
//
// Supports quoted fields, escaped quotes ("") inside quoted fields, embedded
// newlines inside quoted fields, and \r\n / \n line endings. Returns an array
// of rows; each row is an array of strings.

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < n && text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      if (i + 1 < n && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop trailing fully-empty rows (sheet exports often end with a blank line).
  while (rows.length && rows[rows.length - 1].every(v => v === "")) rows.pop();
  return rows;
}

export function rowsToObjects(rows) {
  if (!rows.length) return [];
  const header = rows[0].map(h => String(h || "").trim());
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const obj = {};
    for (let c = 0; c < header.length; c++) {
      obj[header[c]] = c < row.length ? row[c] : "";
    }
    out.push(obj);
  }
  return out;
}
