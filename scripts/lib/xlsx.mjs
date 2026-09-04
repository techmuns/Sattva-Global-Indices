/**
 * A minimal XLSX reader — ZIP container plus SpreadsheetML — with no dependencies.
 *
 * ⚠ THIS IS A DIFFERENT FORMAT FROM THE ISHARES WORKBOOKS (§3.1).
 *
 * The iShares `.xls` files are SpreadsheetML 2003: plain XML, read by
 * `lib/spreadsheetml.mjs`. Vanguard's holdings export is a real OOXML `.xlsx` —
 * a ZIP archive of XML parts, where the text of every cell usually lives in a
 * shared-string table and the sheet holds only an index into it. Neither reader
 * can read the other's files, and both must exist.
 *
 * Two traps this reader exists to handle, both of which silently shift columns:
 *
 *   1. A `<row>` carries `r="8"` and a `<c>` carries `r="D8"`. Rows and cells
 *      are BOTH sparse — an empty cell is simply absent from the XML, not an
 *      empty element. Pushing cells in document order shifts every later column
 *      left and throws nothing, which is §3.1's sparse-cell trap wearing an
 *      OOXML hat. Cells are therefore placed by their decoded column letter.
 *
 *   2. A shared string may be split across several `<t>` runs (rich text), so
 *      "Mahindra & Mahindra" can arrive as three fragments. Taking the first
 *      `<t>` truncates the name, and a truncated name is a name that matches the
 *      wrong company. Every run inside an `<si>` is concatenated.
 *
 * Read columns by HEADER NAME, never by index — the same rule as every other
 * reader here (§3.2).
 */

import { inflateRawSync } from 'node:zlib';

/* ── ZIP ──────────────────────────────────────────────────────────────────*/

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** Locate the End Of Central Directory record, scanning back over any comment. */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new Error('not a ZIP archive: no end-of-central-directory record');
}

/**
 * Every entry in the archive, as { name, offset, method, compressedSize }.
 * Read from the CENTRAL directory rather than by walking local headers: a local
 * header may declare sizes of zero and defer them to a trailing data descriptor,
 * and a reader that trusts those zeroes silently returns empty files.
 */
function readEntries(buf) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error(`corrupt central directory at entry ${i}`);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { name, offset, method, compressedSize });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** The decompressed bytes of one entry, or null when the archive has no such part. */
export function readZipEntry(buf, name) {
  const entry = readEntries(buf).get(name);
  if (!entry) return null;
  const p = entry.offset;
  if (buf.readUInt32LE(p) !== SIG_LOCAL) throw new Error(`corrupt local header for ${name}`);
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const body = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return body;
  if (entry.method === 8) return inflateRawSync(body);
  throw new Error(`unsupported ZIP compression method ${entry.method} for ${name}`);
}

/* ── XML ──────────────────────────────────────────────────────────────────*/

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Undo XML escaping, including numeric character references. */
export function unescapeXml(text) {
  if (!text || !text.includes('&')) return text ?? '';
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/** "A" → 0, "Z" → 25, "AA" → 26. The cell reference's column, zero-based. */
export function columnIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;          // stop at the row digits
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/**
 * The shared-string table: every `<si>` flattened to one string, with all of
 * its `<t>` runs joined (see trap 2 above).
 */
function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let text = '';
    for (const t of si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += unescapeXml(t[1]);
    out.push(text);
  }
  return out;
}

/**
 * Rows of a worksheet, each an array of cell values placed at their true column
 * index (absent cells are `null`). Values are strings; the caller decides what
 * a column means and parses it.
 */
function parseSheet(xml, shared) {
  const rows = [];
  for (const row of xml.matchAll(/<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cell of row[2].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cell[1];
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const inner = cell[2];
      let value = null;
      if (type === 'inlineStr') {
        let text = '';
        for (const t of inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += unescapeXml(t[1]);
        value = text;
      } else {
        const v = /<v[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        if (v != null) {
          value = type === 's' ? (shared[Number(v)] ?? null) : unescapeXml(v);
        }
      }
      const at = ref ? columnIndex(ref) : cells.length;
      cells[at] = value ?? null;
    }
    for (let i = 0; i < cells.length; i += 1) if (cells[i] === undefined) cells[i] = null;
    rows.push({ number: Number(row[1]), cells });
  }
  return rows;
}

/**
 * Read the first worksheet of an .xlsx buffer.
 * @returns {{ rows: {number:number, cells:(string|null)[]}[], sharedCount:number }}
 */
export function readXlsx(buf, sheetPath = 'xl/worksheets/sheet1.xml') {
  const sharedXml = readZipEntry(buf, 'xl/sharedStrings.xml');
  const shared = parseSharedStrings(sharedXml ? sharedXml.toString('utf8') : null);
  const sheetXml = readZipEntry(buf, sheetPath);
  if (!sheetXml) throw new Error(`the workbook has no ${sheetPath}`);
  return { rows: parseSheet(sheetXml.toString('utf8'), shared), sharedCount: shared.length };
}

/**
 * Find the header row by the exact text of its first cell and return
 * { header, dataRows, headerRowNumber }. The preamble height is NOT assumed —
 * Vanguard puts a download stamp, a title, a fund name and an as-at date above
 * the table, and none of that is a guaranteed constant (§3.2).
 */
export function tableFrom(rows, firstHeaderCell) {
  const at = rows.findIndex((r) => (r.cells[0] ?? '').trim() === firstHeaderCell);
  if (at < 0) throw new Error(`no header row whose first cell is ${JSON.stringify(firstHeaderCell)}`);
  const header = rows[at].cells.map((c) => (c ?? '').trim());
  return { header, headerRowNumber: rows[at].number, dataRows: rows.slice(at + 1) };
}

/** A by-name accessor for one row, so nothing is ever read by index (§3.2). */
export function rowReader(header) {
  const index = new Map(header.map((name, i) => [name, i]));
  return (row, name) => {
    if (!index.has(name)) throw new Error(`no column named ${JSON.stringify(name)}`);
    const value = row.cells[index.get(name)];
    return value == null ? null : String(value).trim();
  };
}
