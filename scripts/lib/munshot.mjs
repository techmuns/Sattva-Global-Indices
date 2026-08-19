/**
 * munshot.mjs — Munshot (fastapi.muns.io) batch client and rawQuote parser.
 *
 * Pure and testable: `parseRawQuote` touches no network and no clock, so the
 * shape of a quote can be asserted without a token or a market session.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FEED ACTUALLY IS
 * ---------------------------------------------------------------------------
 * `detailquote` reports `Symbol=RELIANCE.NS, Exchange=NSI`. This is Yahoo
 * Finance NSE data. The committed EOD baseline is BSE bhavcopy. They are
 * DIFFERENT EXCHANGES and do not agree to the paisa — on 19 Aug 2026 BSE closed
 * RELIANCE at 1307.50 while Munshot showed 1311.00.
 *
 * So a live price does not merely refresh the baseline; it swaps the exchange
 * underneath the number. Every figure priced this way carries `priceSource`,
 * and nothing blends the two. A reader must never watch a free-float figure
 * move and be unable to tell whether the stock moved or the source did.
 *
 * ---------------------------------------------------------------------------
 * THREE CORRECTIONS TO THE PUBLISHED DOCS, ALL MEASURED
 * ---------------------------------------------------------------------------
 *   - `type` must be `stockquote_batch`. The documented `stockquote` is HTTP 422.
 *   - `timeout_ms: 1000` (documented) times out EVERY Indian ticker. 20000 works.
 *   - `POST /stock-data` accepts an undocumented `detailquote` type, whose whole
 *     response body is a BARE STRING rather than an object, and which carries
 *     `Last Split Factor` / `Last Split Date` — a split changes the share count,
 *     which is a flow trigger, so those are worth a monthly fetch.
 *
 * `Last Split Date` is UNIX EPOCH SECONDS (`1730073600`), not a date string.
 * Reading it as a year would give 1970.
 */

import { execFile } from 'node:child_process';

const BASE = 'https://fastapi.muns.io';

/* ────────────────────────────────────────────────────────────────────────────
 * rawQuote parsing — pure
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `rawQuote` is a `key=value,key=value` STRING, not an object.
 *
 * It cannot be split on "," and it cannot be split on "=":
 *   - values contain spaces and punctuation — `Day Range=1303.5 - 1321.6`,
 *     `Website=https://www.ril.com`, `Address=Maker Chambers IV`;
 *   - a company name or address may legitimately contain a comma.
 *
 * So keys are located by pattern and values are whatever lies between them.
 * A key that is absent yields `null` — never 0, never '', never a default.
 *
 * @param {unknown} raw
 * @returns {Record<string, string>} raw string values, keyed verbatim
 */
export function parseRawQuote(raw) {
  const out = {};
  if (typeof raw !== 'string' || raw.trim() === '') return out;

  // A key looks like `Some Label (%)=` and starts at the string start or after
  // a comma. Anchoring on the comma is what stops a comma inside a value from
  // being mistaken for a separator.
  //
  // The leading character may be a DIGIT — `52-Week Range` and `10-Day Average
  // Volume` both are, and a letters-only pattern silently swallows them into
  // the preceding value, which is how `Day Range` came back as
  // "1303.5 - 1321.6,52-Week Range=1249.8 - 1611.8". The lookahead still
  // requires a letter somewhere, so a bare number after a comma is not mistaken
  // for a key.
  const keyPattern = /(?:^|,)\s*((?=[^,=]*[A-Za-z])[A-Za-z0-9][A-Za-z0-9 ()%./-]*?)=/g;
  const marks = [];
  let match;
  while ((match = keyPattern.exec(raw)) !== null) {
    marks.push({ key: match[1].trim(), valueStart: match.index + match[0].length, matchStart: match.index });
  }

  for (let i = 0; i < marks.length; i += 1) {
    const end = i + 1 < marks.length ? marks[i + 1].matchStart : raw.length;
    out[marks[i].key] = raw.slice(marks[i].valueStart, end).trim();
  }
  return out;
}

const MISSING = new Set(['', 'N/A', 'NA', 'None', 'null', 'nan', '-', '--', 'Infinity']);

/** A field as a finite number, or null. An absent key is null, never 0. */
export function quoteNumber(fields, key) {
  const value = fields?.[key];
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (MISSING.has(text)) return null;
  const parsed = Number(text.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/** A field as a trimmed string, or null. */
export function quoteText(fields, key) {
  const value = fields?.[key];
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return MISSING.has(text) ? null : text;
}

/** `"1303.5 - 1321.6"` -> `{low, high}`; either half may be null. */
export function quoteRange(fields, key) {
  const text = quoteText(fields, key);
  if (!text) return { low: null, high: null };
  const parts = text.split(/\s*-\s*/);
  if (parts.length !== 2) return { low: null, high: null };
  const low = Number(parts[0]);
  const high = Number(parts[1]);
  return {
    low: Number.isFinite(low) ? low : null,
    high: Number.isFinite(high) ? high : null,
  };
}

/**
 * `Last Split Date` is UNIX EPOCH SECONDS. Returns `YYYY-MM-DD` or null.
 * A value that is already a date string is passed through if it parses.
 */
export function quoteEpochDate(fields, key) {
  const text = quoteText(fields, key);
  if (!text) return null;
  if (/^\d{9,11}$/.test(text)) {
    const date = new Date(Number(text) * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/** The subset of a rawQuote this project uses, typed and null-safe. */
export function normaliseQuote(symbol, item) {
  const fields = parseRawQuote(item?.rawQuote);
  const day = quoteRange(fields, 'Day Range');
  const year = quoteRange(fields, '52-Week Range');
  return {
    symbol,
    status: item?.status ?? null,
    // The batch envelope's currentPrice is authoritative; rawQuote agrees but
    // is the string form.
    price: Number.isFinite(item?.currentPrice) ? item.currentPrice : quoteNumber(fields, 'Current Price'),
    prevClose: quoteNumber(fields, 'Previous Close'),
    open: quoteNumber(fields, 'Opening Price'),
    dayLow: day.low,
    dayHigh: day.high,
    yearLow: year.low,
    yearHigh: year.high,
    marketCap: quoteNumber(fields, 'Market Cap'),
    lastVolume: quoteNumber(fields, 'Last Volume'),
    avgVolume10d: quoteNumber(fields, '10-Day Average Volume'),
    avgVolume3m: quoteNumber(fields, '3-Month Average Volume'),
    ma50: quoteNumber(fields, '50-Day Moving Average'),
    ma200: quoteNumber(fields, '200-Day Moving Average'),
    yearlyChangePct: quoteNumber(fields, 'Yearly Change (%)'),
    // The raw string is kept beside the parsed values so a figure can always be
    // traced back to exactly what the upstream said.
    raw: typeof item?.rawQuote === 'string' ? item.rawQuote : null,
    source: 'munshot-nse',
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Market windows
 * ──────────────────────────────────────────────────────────────────────────── */

function minutesInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    weekday: get('weekday'),
  };
}

const WEEKEND = new Set(['Sat', 'Sun']);

/**
 * Session windows. Weekends are excluded; exchange HOLIDAYS ARE NOT, because
 * this repo carries no holiday calendar. A holiday therefore looks like an open
 * session with no ticks — which is why the screen's freshness claim is derived
 * from whether a byte actually arrived, not from the clock alone.
 */
export const MARKET = {
  INDIA: {
    label: '09:15–15:30 IST, Mon–Fri (no holiday calendar)',
    timeZone: 'Asia/Kolkata',
    openMinutes: 9 * 60 + 15,
    closeMinutes: 15 * 60 + 30,
    isOpen(date = new Date()) {
      const { minutes, weekday } = minutesInZone(date, this.timeZone);
      return !WEEKEND.has(weekday) && minutes >= this.openMinutes && minutes <= this.closeMinutes;
    },
  },
  USA: {
    label: '09:30–16:00 America/New_York, Mon–Fri (no holiday calendar)',
    timeZone: 'America/New_York',
    openMinutes: 9 * 60 + 30,
    closeMinutes: 16 * 60,
    isOpen(date = new Date()) {
      const { minutes, weekday } = minutesInZone(date, this.timeZone);
      return !WEEKEND.has(weekday) && minutes >= this.openMinutes && minutes <= this.closeMinutes;
    },
  },
};

/* ────────────────────────────────────────────────────────────────────────────
 * Transport
 * ──────────────────────────────────────────────────────────────────────────── */

const STATUS_SENTINEL = '\n__CURL_HTTP_STATUS__';

function curlPostJson(url, body, { token, timeoutSeconds = 60 } = {}) {
  const headers = ['-H', 'Content-Type: application/json'];
  if (token) headers.push('-H', `Authorization: Bearer ${token}`);
  return new Promise((resolve) => {
    execFile(
      'curl',
      [
        '-s', '-S', '--fail-with-body',
        '--retry', '2', '--retry-delay', '3', '--retry-all-errors',
        '--max-time', String(timeoutSeconds),
        ...headers,
        '-X', 'POST', '--data-binary', JSON.stringify(body),
        '-w', `${STATUS_SENTINEL}%{http_code}`,
        url,
      ],
      { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          resolve({ ok: false, reason: `unreachable: ${String(stderr || error.message).trim().split('\n')[0]}` });
          return;
        }
        const at = stdout.lastIndexOf(STATUS_SENTINEL);
        if (at === -1) { resolve({ ok: false, reason: 'curl produced no status line' }); return; }
        const status = Number.parseInt(stdout.slice(at + STATUS_SENTINEL.length).trim(), 10);
        const text = stdout.slice(0, at);
        if (status === 401 || status === 403) { resolve({ ok: false, reason: `unauthorised: HTTP ${status}` }); return; }
        if (status !== 200) { resolve({ ok: false, reason: `upstream: HTTP ${status}`, body: text.slice(0, 300) }); return; }
        try { resolve({ ok: true, json: JSON.parse(text), status }); }
        catch (e) { resolve({ ok: false, reason: `upstream: HTTP 200 but body did not parse as JSON (${e.message})` }); }
      },
    );
  });
}

/** Ten batches is plenty against somebody else's service. */
export const DEFAULT_CHUNK_SIZE = 50;
export const DEFAULT_TIMEOUT_MS = 20000;

/**
 * One upstream batch call. No chunking, no retry beyond curl's.
 * @returns {{ok: boolean, quotes: object, failed: Array, reason?: string}}
 */
export async function fetchBatchChunk(symbols, { country = 'INDIA', timeoutMs = DEFAULT_TIMEOUT_MS, token } = {}) {
  if (symbols.length === 0) return { ok: true, quotes: {}, failed: [], asOf: null };

  const result = await curlPostJson(
    `${BASE}/stock-data/batch`,
    {
      country: symbols.map(() => country).join(','),
      ticker_symbol: symbols.join(','),
      type: 'stockquote_batch', // NOT 'stockquote' — that is HTTP 422
      timeout_ms: timeoutMs,
    },
    { token, timeoutSeconds: Math.ceil(timeoutMs / 1000) + 25 },
  );

  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      quotes: {},
      failed: symbols.map((symbol) => ({ symbol, reason: result.reason })),
      asOf: null,
    };
  }

  const items = Array.isArray(result.json?.data?.items) ? result.json.data.items : [];
  const quotes = {};
  const failed = [];
  const seen = new Set();

  for (const item of items) {
    const symbol = typeof item?.ticker === 'string' ? item.ticker.trim() : '';
    if (symbol === '') continue;
    seen.add(symbol);
    // A timeout is a FAILURE, not a missing value. The row keeps its EOD price
    // and says so; it does not silently render as having no price.
    if (item.status !== 'ok') {
      failed.push({ symbol, reason: `upstream status "${item.status ?? 'unknown'}"` });
      continue;
    }
    const quote = normaliseQuote(symbol, item);
    if (quote.price === null) {
      failed.push({ symbol, reason: 'resolved with no usable price' });
      continue;
    }
    quotes[symbol] = quote;
  }

  for (const symbol of symbols) {
    if (!seen.has(symbol)) failed.push({ symbol, reason: 'not present in the upstream response' });
  }

  return { ok: true, quotes, failed, asOf: result.json?.data?.asOf ?? null };
}

/** Chunked batch fetch with bounded concurrency. */
export async function fetchBatch(symbols, {
  country = 'INDIA', timeoutMs = DEFAULT_TIMEOUT_MS, token,
  chunkSize = DEFAULT_CHUNK_SIZE, concurrency = 3, onChunk,
} = {}) {
  const chunks = [];
  for (let i = 0; i < symbols.length; i += chunkSize) chunks.push(symbols.slice(i, i + chunkSize));

  const quotes = {};
  const failed = [];
  let asOf = null;
  let next = 0;

  const runner = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= chunks.length) return;
      const result = await fetchBatchChunk(chunks[index], { country, timeoutMs, token });
      Object.assign(quotes, result.quotes);
      failed.push(...result.failed);
      if (result.asOf && !asOf) asOf = result.asOf;
      onChunk?.(index + 1, chunks.length, result);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, () => runner()));

  return {
    ok: Object.keys(quotes),      // symbols that resolved
    quotes,
    failed,
    asOf,
    chunks: chunks.length,
  };
}

/** The undocumented single-ticker detail call. Whole body is a BARE STRING. */
export async function fetchDetail(symbol, { country = 'INDIA', timeoutMs = DEFAULT_TIMEOUT_MS, token } = {}) {
  const result = await curlPostJson(
    `${BASE}/stock-data`,
    { country, ticker_symbol: symbol, type: 'detailquote', timeout_ms: timeoutMs },
    { token, timeoutSeconds: Math.ceil(timeoutMs / 1000) + 25 },
  );
  if (!result.ok) return { ok: false, symbol, reason: result.reason };

  const raw = typeof result.json === 'string' ? result.json : (result.json?.data ?? null);
  if (typeof raw !== 'string') return { ok: false, symbol, reason: 'detail response was not a string' };

  const fields = parseRawQuote(raw);
  return {
    ok: true,
    symbol,
    raw,
    fields,
    exchange: quoteText(fields, 'Exchange'),
    yahooSymbol: quoteText(fields, 'Symbol'),
    sector: quoteText(fields, 'Sector'),
    industry: quoteText(fields, 'Industry'),
    avgVolume3m: quoteNumber(fields, '3-Month Average Volume'),
    avgVolume10d: quoteNumber(fields, '10-Day Average Volume'),
    yearlyChangePct: quoteNumber(fields, 'Yearly Change (%)'),
    marketCap: quoteNumber(fields, 'Market Cap'),
    lastSplitFactor: quoteText(fields, 'Last Split Factor'),
    lastSplitDate: quoteEpochDate(fields, 'Last Split Date'),
    beta: quoteNumber(fields, 'Beta'),
  };
}

