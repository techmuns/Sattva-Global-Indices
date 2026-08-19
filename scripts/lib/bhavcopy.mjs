/**
 * bhavcopy.mjs — BSE end-of-day bhavcopy: parse, validate, compare. Pure.
 *
 * One request covers the whole market and the result is committed, so the
 * static site renders fully with no Worker and no network. This is the FLOOR
 * that everything else overlays.
 *
 * ---------------------------------------------------------------------------
 * TRAP 1 — A 200 IS NOT A CONTRACT
 * ---------------------------------------------------------------------------
 * BSE serves its single-page-app shell, with HTTP 200 and content-type
 * text/html, for download URLs that do not exist:
 *
 *     …/download/BhavCopy/Equity/EQ_ISINCODE_180826.zip  ->  200, 13,850 bytes, text/html
 *
 * A fetcher that trusts the status code writes an empty price file, and every
 * free-float figure on the dashboard goes null on a day when nothing was
 * actually wrong. So the SHAPE is validated, not the status: it must parse as
 * CSV, carry the columns we expect, and its own `TradDt` must be the date we
 * asked for. Same family as BSE serving delisted scrips as though nothing
 * happened — the response is well-formed and about something else.
 *
 * ---------------------------------------------------------------------------
 * TRAP 2 — A FILE-LEVEL DATE CHECK CANNOT SEE A STALE ROW
 * ---------------------------------------------------------------------------
 * A file whose `TradDt` is today can still carry a row copied from yesterday.
 * The row-level tripwire is continuity: today's `PrvsClsgPric` must equal
 * yesterday's `ClsPric`, per scrip. Measured across 4,562 common scrips on
 * 18->19 Aug 2026: zero failures, so it is a sharp tripwire rather than a noisy
 * one.
 *
 * Note the true-negative shape: a handful of rows carry byte-identical full
 * bars across two days. Those are bonds and liquid-ETF units that genuinely did
 * not trade, and they PASS continuity — an unchanged close is not a stale row.
 */

/** Columns this project reads. A file missing any of them is not a bhavcopy. */
export const REQUIRED_COLUMNS = [
  'TradDt', 'FinInstrmTp', 'FinInstrmId', 'ISIN', 'TckrSymb', 'FinInstrmNm',
  'OpnPric', 'HghPric', 'LwPric', 'ClsPric', 'LastPric', 'PrvsClsgPric', 'SctySrs',
];

/** Split a CSV line honouring double quotes. Company names carry commas. */
function splitCsvLine(line) {
  const cells = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cell += '"'; i += 1; } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { cells.push(cell); cell = ''; }
    else cell += ch;
  }
  cells.push(cell);
  return cells;
}

/** A price cell as a positive finite number, or null. Never 0 for "absent". */
export function priceValue(text) {
  if (text === null || text === undefined) return null;
  const trimmed = String(text).trim();
  if (trimmed === '' || trimmed === '-') return null;
  const parsed = Number(trimmed.replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** An integer count (volume, trades) or null. Zero IS meaningful here. */
export function countValue(text) {
  if (text === null || text === undefined) return null;
  const trimmed = String(text).trim();
  if (trimmed === '' || trimmed === '-') return null;
  const parsed = Number(trimmed.replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Validate that a response body IS a bhavcopy before parsing it as one.
 *
 * @param {string} text  the raw response body
 * @param {{expectDate?: string, contentType?: string}} options
 * @returns {{ok: boolean, problems: string[], headers?: string[], tradeDate?: string}}
 */
export function assertBhavcopyShape(text, { expectDate, contentType } = {}) {
  const problems = [];

  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, problems: ['response body was empty'] };
  }

  // The cheapest and most decisive check: BSE's SPA shell begins with a doctype.
  const head = text.slice(0, 400).toLowerCase();
  if (head.includes('<!doctype') || head.includes('<html')) {
    problems.push(
      'response is HTML, not CSV — BSE serves its single-page-app shell with HTTP 200 ' +
      'for download URLs that do not exist',
    );
    return { ok: false, problems };
  }
  if (contentType && /html/i.test(contentType)) {
    problems.push(`content-type was ${contentType}, not a CSV type`);
  }

  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length < 2) {
    problems.push(`only ${lines.length} non-empty line(s) — no data rows`);
    return { ok: false, problems };
  }

  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const missing = REQUIRED_COLUMNS.filter((column) => !headers.includes(column));
  if (missing.length) {
    problems.push(`missing expected column(s): ${missing.join(', ')}`);
    return { ok: false, problems, headers };
  }

  const index = new Map(headers.map((h, i) => [h, i]));
  const firstRow = splitCsvLine(lines[1]);
  const tradeDate = (firstRow[index.get('TradDt')] ?? '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
    problems.push(`TradDt "${tradeDate}" is not a YYYY-MM-DD date`);
  } else if (expectDate && tradeDate !== expectDate) {
    // The file is well-formed and about a DIFFERENT DAY. Silently accepting it
    // would publish yesterday's prices under today's date.
    problems.push(`TradDt is ${tradeDate} but ${expectDate} was requested`);
  }

  return { ok: problems.length === 0, problems, headers, tradeDate };
}

/**
 * Parse a validated bhavcopy.
 * @returns {{tradeDate: string|null, rows: Array, skipped: number}}
 */
export function parseBhavcopy(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const index = new Map(headers.map((h, i) => [h, i]));
  const at = (cells, column) => cells[index.get(column)] ?? null;

  const rows = [];
  let skipped = 0;
  let tradeDate = null;

  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const scripCode = String(at(cells, 'FinInstrmId') ?? '').trim();
    if (scripCode === '') { skipped += 1; continue; }
    const date = String(at(cells, 'TradDt') ?? '').trim();
    if (tradeDate === null) tradeDate = date;

    rows.push({
      scripCode,
      isin: String(at(cells, 'ISIN') ?? '').trim() || null,
      symbol: String(at(cells, 'TckrSymb') ?? '').trim() || null,
      name: String(at(cells, 'FinInstrmNm') ?? '').trim() || null,
      series: String(at(cells, 'SctySrs') ?? '').trim() || null,
      instrumentType: String(at(cells, 'FinInstrmTp') ?? '').trim() || null,
      tradeDate: date,
      open: priceValue(at(cells, 'OpnPric')),
      high: priceValue(at(cells, 'HghPric')),
      low: priceValue(at(cells, 'LwPric')),
      close: priceValue(at(cells, 'ClsPric')),
      last: priceValue(at(cells, 'LastPric')),
      prevClose: priceValue(at(cells, 'PrvsClsgPric')),
      volume: countValue(at(cells, 'TtlTradgVol')),
      trades: countValue(at(cells, 'TtlNbOfTxsExctd')),
    });
  }

  return { tradeDate, rows, skipped, headers };
}

/**
 * Row-level continuity: today's `PrvsClsgPric` must equal yesterday's `ClsPric`.
 *
 * @param {Array} todayRows
 * @param {Map<string, number>} previousCloseByScrip
 * @param {{tolerance?: number}} options  absolute rupee tolerance for rounding
 * @returns {{compared: number, failures: Array, skipped: number}}
 */
export function assertContinuity(todayRows, previousCloseByScrip, { tolerance = 0.011 } = {}) {
  const failures = [];
  let compared = 0;
  let skipped = 0;

  for (const row of todayRows) {
    const yesterdayClose = previousCloseByScrip.get(row.scripCode);
    if (yesterdayClose === undefined || yesterdayClose === null || row.prevClose === null) {
      skipped += 1;
      continue;
    }
    compared += 1;
    const gap = Math.abs(row.prevClose - yesterdayClose);
    if (gap > tolerance) {
      failures.push({
        scripCode: row.scripCode,
        symbol: row.symbol,
        name: row.name,
        todayPrevClose: row.prevClose,
        yesterdayClose,
        gap: Number(gap.toFixed(4)),
      });
    }
  }

  return { compared, failures, skipped };
}

/** The download URL for one trade date. `date` is YYYY-MM-DD. */
export function bhavcopyUrl(date) {
  const compact = date.replace(/-/g, '');
  return `https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_${compact}_F_0000.CSV`;
}
