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
 *
 * ---------------------------------------------------------------------------
 * ⚠ WHY THIS LIVES UNDER public/js AND TAKES ITS INFLATE AS AN ARGUMENT
 * ---------------------------------------------------------------------------
 * The same workbook is now read in two places: `scripts/import-ftse.mjs`, which
 * writes the committed artefact, and the dashboard's upload panel, which lets
 * the desk drop in a fresh quarterly book without waiting for anyone to run a
 * script. A second reader for the browser would be a second set of answers to
 * the sparse-cell and rich-text traps above, and the two would drift — silently,
 * because both would keep producing plausible rows.
 *
 * So there is one reader, and it is environment-neutral:
 *
 *   - it works on a `Uint8Array` through a `DataView`, never on Node's `Buffer`;
 *   - it decodes with `TextDecoder`, which both runtimes have;
 *   - and it takes its INFLATE as an argument, because the two runtimes cannot
 *     share one. Node has `zlib.inflateRawSync`; the browser has no synchronous
 *     inflate at all, only the async `DecompressionStream('deflate-raw')`.
 *
 * That last difference is why `readXlsx` is ASYNC. It costs Node an `await` and
 * it is the only shape a browser can satisfy — a sync signature would have
 * forced the second implementation this file exists to prevent.
 *
 * Only code under public/js is served, so a shared module has to live here. The
 * build scripts already import from public/js/model for exactly this reason.
 */

const DECODER = new TextDecoder('utf-8');
const decode = (bytes) => DECODER.decode(bytes);

/* ── ZIP ──────────────────────────────────────────────────────────────────*/

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** Locate the End Of Central Directory record, scanning back over any comment. */
function findEocd(view) {
  const min = Math.max(0, view.byteLength - 0xffff - 22);
  for (let i = view.byteLength - 22; i >= min; i -= 1) {
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  throw new Error('not a ZIP archive: no end-of-central-directory record');
}

/**
 * Every entry in the archive, as { name, offset, method, compressedSize }.
 * Read from the CENTRAL directory rather than by walking local headers: a local
 * header may declare sizes of zero and defer them to a trailing data descriptor,
 * and a reader that trusts those zeroes silently returns empty files.
 */
function readEntries(bytes, view) {
  const eocd = findEocd(view);
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(p, true) !== SIG_CENTRAL) throw new Error(`corrupt central directory at entry ${i}`);
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { name, offset, method, compressedSize });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * The decompressed bytes of one entry, or null when the archive has no such part.
 *
 * `inflateRaw` is injected: raw DEFLATE with no zlib header, returning a
 * `Uint8Array`. Node passes `zlib.inflateRawSync`; the browser passes a
 * `DecompressionStream('deflate-raw')` wrapper. Both are awaited, so the
 * synchronous one costs nothing but the keyword.
 */
export async function readZipEntry(bytes, name, inflateRaw) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entry = readEntries(bytes, view).get(name);
  if (!entry) return null;
  const p = entry.offset;
  if (view.getUint32(p, true) !== SIG_LOCAL) throw new Error(`corrupt local header for ${name}`);
  const nameLen = view.getUint16(p + 26, true);
  const extraLen = view.getUint16(p + 28, true);
  const start = p + 30 + nameLen + extraLen;
  const body = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return body;
  if (entry.method === 8) return inflateRaw(body);
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
 * @param {Uint8Array} bytes
 * @param {(body: Uint8Array) => Uint8Array | Promise<Uint8Array>} inflateRaw
 * @returns {Promise<{ rows: {number:number, cells:(string|null)[]}[], sharedCount:number }>}
 */
export async function readXlsx(bytes, inflateRaw, sheetPath = 'xl/worksheets/sheet1.xml') {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const sharedXml = await readZipEntry(input, 'xl/sharedStrings.xml', inflateRaw);
  const shared = parseSharedStrings(sharedXml ? decode(sharedXml) : null);
  const sheetXml = await readZipEntry(input, sheetPath, inflateRaw);
  if (!sheetXml) throw new Error(`the workbook has no ${sheetPath}`);
  return { rows: parseSheet(decode(sheetXml), shared), sharedCount: shared.length };
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
