/**
 * csv.mjs — an RFC 4180 reader, zero dependencies.
 *
 * The bhavcopy reader in bhavcopy.mjs splits on commas with a small quote
 * escape because the exchange's own file is machine-generated and regular. A
 * Screener export is not: `Name` and `Industry` carry commas inside quotes
 * ("Residential, Commercial Projects"), and a splitter that does not track
 * quote state shifts every later column left — the same silent failure the
 * SpreadsheetML reader guards against with ss:Index.
 *
 * ---------------------------------------------------------------------------
 * READ BY HEADER NAME, NEVER BY INDEX.
 * ---------------------------------------------------------------------------
 * `readTable` returns rows as objects keyed on the header text, for the reason
 * CLAUDE.md 3.2 gives about the iShares workbooks: a positional reader parses
 * today's file correctly and silently misreads tomorrow's when a column moves.
 * Screener lets a user choose columns, so column ORDER IS NOT STABLE ACROSS
 * EXPORTS. Anything reading these files by position is one re-export away from
 * putting `Industry` in `ISIN Code` and throwing nothing.
 */

/** Split CSV text into rows of raw string fields, honouring quotes and CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let sawField = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } // an escaped quote
        else quoted = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') { quoted = true; sawField = true; continue; }
    if (ch === ',') { row.push(field); field = ''; sawField = true; continue; }
    if (ch === '\r') continue; // CRLF: the \n does the work
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = []; field = ''; sawField = false;
      continue;
    }
    field += ch;
    sawField = true;
  }

  // A trailing line with no newline still counts. A trailing newline does not
  // invent an empty row.
  if (sawField || field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Parse into { header, rows } where each row is an object keyed on header text.
 *
 * @param {string} text
 * @param {{ require?: string[] }} [options] column names that MUST be present;
 *   a missing one throws rather than yielding undefined at every call site.
 */
export function readTable(text, { require: required = [] } = {}) {
  const raw = parseCsv(text);
  if (raw.length === 0) throw new Error('csv: the file is empty');

  const header = raw[0].map((h) => h.trim());
  const seen = new Set();
  for (const name of header) {
    if (seen.has(name)) throw new Error(`csv: duplicate column "${name}" — reading by name would be ambiguous`);
    seen.add(name);
  }

  const missing = required.filter((name) => !header.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `csv: missing required column(s) ${missing.map((m) => `"${m}"`).join(', ')}. `
      + `Present: ${header.join(', ')}`,
    );
  }

  const rows = [];
  for (let r = 1; r < raw.length; r += 1) {
    const cells = raw[r];
    // A short row is a real defect, not something to pad with empty strings:
    // padding turns a truncated download into rows that look complete.
    if (cells.length === 1 && cells[0].trim() === '') continue; // blank line
    if (cells.length < header.length) {
      throw new Error(
        `csv: row ${r + 1} has ${cells.length} fields, header has ${header.length}. `
        + 'A short row means the file is truncated or the quoting is broken.',
      );
    }
    const obj = {};
    for (let i = 0; i < header.length; i += 1) obj[header[i]] = cells[i];
    rows.push(obj);
  }
  return { header, rows };
}

/**
 * A number from a CSV cell, or null.
 *
 * Empty, "-", "" and non-numeric text are ABSENT, not zero — 2.3 of CLAUDE.md.
 * Screener writes plain decimals with no digit grouping, so unlike a BSE figure
 * this does not need parseGroupedNumber. It still refuses anything that is not
 * wholly a number, so "1,234" (were Screener ever to change) fails loudly
 * rather than becoming 1.
 */
export function numberValue(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (t === '' || t === '-' || t === '--' || t === 'NA' || t === 'N/A') return null;
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Trimmed text, or null when the cell is empty. Never "" — 2.3. */
export function textValue(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  return t === '' ? null : t;
}
