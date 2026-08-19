/**
 * SpreadsheetML 2003 reader — zero dependencies.
 *
 * The iShares "fund holdings" downloads carry a `.xls` extension but are NOT
 * binary BIFF workbooks and are NOT CSV. They are SpreadsheetML 2003: plain
 * UTF-8 XML with CRLF line endings, opening with
 *
 *     <?xml version="1.0"?>
 *     <?mso-application progid="Excel.Sheet"?>
 *     <Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ...>
 *
 * Anything that opens them as binary or as delimited text will fail or, worse,
 * appear to succeed on garbage. This module is the only place in the repo that
 * knows the format.
 *
 * The two traps this reader exists to handle:
 *
 *  1. SPARSE CELLS. A <Cell> may carry ss:Index="7", meaning "this cell is in
 *     column 7" — the columns before it are simply absent from the XML. A
 *     positional reader that pushes cells in document order silently shifts
 *     every later column one to the left. <Row> can carry ss:Index too, and
 *     ss:MergeAcross consumes extra columns. All three are honoured here.
 *
 *  2. LINE-WRAPPED MARKUP. Excel wraps long start tags across lines, so a
 *     <Cell ...> element and its <Data> may straddle a newline, and <Data>
 *     text itself can contain newlines. A line-oriented or per-row regex
 *     reader misses those. This is a single-pass character scanner instead.
 *
 * Values are returned as they are typed in the file: ss:Type="Number" becomes a
 * JS number, everything else stays a decoded string. No coercion, no trimming,
 * no interpretation — the caller decides what a cell means.
 */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Decode XML entity references, including the numeric ones BlackRock emits
 * (a literal `--` ticker is written as `&#45;-`, so a reader that skips
 * numeric refs sees `&#45;-` and never recognises the "no ticker" marker).
 */
export function decodeEntities(text) {
  if (text.indexOf('&') === -1) return text;
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const codePoint =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      return String.fromCodePoint(codePoint);
    }
    const named = NAMED_ENTITIES[body];
    return named === undefined ? match : named;
  });
}

const ATTR_RE = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseAttributes(raw) {
  const attrs = {};
  if (raw.indexOf('=') === -1) return attrs;
  ATTR_RE.lastIndex = 0;
  let match;
  while ((match = ATTR_RE.exec(raw)) !== null) {
    attrs[match[1]] = decodeEntities(match[3] !== undefined ? match[3] : match[4]);
  }
  return attrs;
}

/**
 * Single-pass tag scanner. Yields `{kind}` events:
 *   {kind:'open'|'self'|'close', name, attrs}
 *   {kind:'text', text}
 * Comments, processing instructions and doctypes are skipped; CDATA is text.
 * Tag ends are found with quote awareness so a `>` inside an attribute value
 * (ss:HRef URLs contain query strings) does not truncate the tag.
 */
export function* scanXml(xml) {
  const length = xml.length;
  let cursor = 0;

  while (cursor < length) {
    const lt = xml.indexOf('<', cursor);
    if (lt === -1) {
      if (cursor < length) yield { kind: 'text', text: xml.slice(cursor) };
      return;
    }
    if (lt > cursor) yield { kind: 'text', text: xml.slice(cursor, lt) };

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      cursor = end === -1 ? length : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      yield { kind: 'text', text: xml.slice(lt + 9, end === -1 ? length : end), cdata: true };
      cursor = end === -1 ? length : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      cursor = end === -1 ? length : end + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt + 2);
      cursor = end === -1 ? length : end + 1;
      continue;
    }

    let scan = lt + 1;
    let quote = '';
    while (scan < length) {
      const ch = xml[scan];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      scan += 1;
    }
    const raw = xml.slice(lt + 1, scan);
    cursor = scan + 1;

    if (raw.length === 0) continue;

    if (raw[0] === '/') {
      yield { kind: 'close', name: raw.slice(1).trim(), attrs: {} };
      continue;
    }
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameEnd = body.search(/[\s/]/);
    const name = nameEnd === -1 ? body : body.slice(0, nameEnd);
    const attrs = nameEnd === -1 ? {} : parseAttributes(body.slice(nameEnd));
    yield { kind: selfClosing ? 'self' : 'open', name, attrs };
  }
}

function localName(name) {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

function attr(attrs, suffix) {
  // Namespace prefixes are declared per-workbook; match on the local name so a
  // file that binds the spreadsheet namespace to a different prefix still reads.
  if (attrs[`ss:${suffix}`] !== undefined) return attrs[`ss:${suffix}`];
  if (attrs[suffix] !== undefined) return attrs[suffix];
  for (const key of Object.keys(attrs)) {
    if (localName(key) === suffix) return attrs[key];
  }
  return undefined;
}

function positiveInt(value) {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function typedValue(type, text) {
  switch (type) {
    case 'Number':
      return text.trim() === '' ? null : Number(text);
    case 'Boolean':
      return text.trim() === '1' || text.trim().toLowerCase() === 'true';
    default:
      return text;
  }
}

/**
 * Parse a SpreadsheetML 2003 workbook.
 *
 * @param {string} xml  full workbook text (UTF-8, CRLF is fine)
 * @returns {{sheets: Array<{name: string, rows: Array<Array<*>>}>, sheet(name): {name, rows}|null}}
 *
 * Rows are dense arrays: gaps created by ss:Index are filled with `null`, so
 * `row[i]` is always column i+1. A cell that carries no <Data> is `null`.
 */
export function parseWorkbook(xml) {
  const sheets = [];

  let sheet = null;
  let row = null;
  let nextRowIndex = 0;
  let nextColIndex = 0;
  let cellColumn = -1;
  let cellSpan = 0;
  let inCell = false;
  let dataDepth = 0;
  let dataType = 'String';
  let dataText = '';

  const placeRow = (attrs) => {
    const declared = positiveInt(attr(attrs, 'Index'));
    const index = declared === undefined ? nextRowIndex : declared - 1;
    while (sheet.rows.length < index) sheet.rows.push([]);
    row = [];
    sheet.rows[index] = row;
    nextRowIndex = index + 1;
    nextColIndex = 0;
  };

  const placeCell = (attrs) => {
    const declared = positiveInt(attr(attrs, 'Index'));
    cellColumn = declared === undefined ? nextColIndex : declared - 1;
    const mergeAcross = Number.parseInt(attr(attrs, 'MergeAcross') ?? '0', 10);
    cellSpan = Number.isFinite(mergeAcross) && mergeAcross > 0 ? mergeAcross : 0;
    nextColIndex = cellColumn + 1 + cellSpan;
    while (row.length < nextColIndex) row.push(null);
  };

  for (const ev of scanXml(xml)) {
    if (ev.kind === 'text') {
      if (dataDepth > 0) dataText += ev.cdata ? ev.text : decodeEntities(ev.text);
      continue;
    }

    const name = localName(ev.name);

    if (ev.kind === 'open' || ev.kind === 'self') {
      switch (name) {
        case 'Worksheet':
          sheet = { name: attr(ev.attrs, 'Name') ?? `Sheet${sheets.length + 1}`, rows: [] };
          sheets.push(sheet);
          nextRowIndex = 0;
          if (ev.kind === 'self') sheet = null;
          break;
        case 'Table':
          if (sheet) nextRowIndex = 0;
          break;
        case 'Row':
          if (!sheet) break;
          placeRow(ev.attrs);
          if (ev.kind === 'self') row = null;
          break;
        case 'Cell':
          if (!row) break;
          placeCell(ev.attrs);
          inCell = ev.kind === 'open';
          break;
        case 'Data':
          if (!inCell) break;
          if (dataDepth === 0) {
            dataType = attr(ev.attrs, 'Type') ?? 'String';
            dataText = '';
          }
          if (ev.kind === 'open') dataDepth += 1;
          break;
        default:
          break;
      }
      continue;
    }

    // close
    switch (name) {
      case 'Data':
        if (dataDepth > 0) {
          dataDepth -= 1;
          if (dataDepth === 0 && inCell && row && cellColumn >= 0) {
            row[cellColumn] = typedValue(dataType, dataText);
          }
        }
        break;
      case 'Cell':
        inCell = false;
        cellColumn = -1;
        cellSpan = 0;
        break;
      case 'Row':
        row = null;
        break;
      case 'Worksheet':
        sheet = null;
        break;
      default:
        break;
    }
  }

  return {
    sheets,
    sheet(name) {
      return sheets.find((s) => s.name === name) ?? null;
    },
  };
}

/** Cell as a trimmed string; null/undefined become ''. */
export function cellText(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value.trim() : String(value);
}

/** True when every cell in the row is empty. */
export function isBlankRow(row) {
  return !row || row.every((cell) => cellText(cell) === '');
}

/**
 * Find the 0-based index of the row whose first cell equals `label` (trimmed).
 * Used to locate the holdings header without hard-coding a row number: the
 * preamble above it is not a fixed height across BlackRock's funds.
 */
export function findRowByFirstCell(rows, label) {
  for (let i = 0; i < rows.length; i += 1) {
    if (cellText(rows[i]?.[0]) === label) return i;
  }
  return -1;
}

/**
 * Turn a header row plus the rows beneath it into keyed records.
 *
 * READ BY HEADER NAME, NEVER BY POSITION. The three iShares workbooks do not
 * share a column set — the EM ETF has a `Type` column the small-cap funds lack,
 * so a positional reader parses two files correctly and misreads the third
 * without throwing: sector becomes asset class, weight becomes notional value.
 *
 * @returns {{headers: string[], records: Array<{get(header): *, row: Array<*>, rowNumber: number}>}}
 */
export function tableFromHeaderRow(rows, headerRowIndex) {
  const headers = (rows[headerRowIndex] ?? []).map(cellText);
  const index = new Map();
  headers.forEach((header, i) => {
    if (header !== '' && !index.has(header)) index.set(header, i);
  });

  const records = [];
  for (let i = headerRowIndex + 1; i < rows.length; i += 1) {
    const row = rows[i] ?? [];
    if (isBlankRow(row)) continue;
    records.push({
      row,
      rowNumber: i + 1, // 1-based, matches what Excel shows
      get(header) {
        const at = index.get(header);
        if (at === undefined) {
          throw new Error(`column "${header}" is not present in this sheet (have: ${headers.filter(Boolean).join(', ')})`);
        }
        return row[at] ?? null;
      },
      has(header) {
        return index.has(header);
      },
    });
  }

  return { headers, headerIndex: index, records };
}
