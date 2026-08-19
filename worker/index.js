/**
 * Sattva Index Flows Worker — static assets plus one route.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * To hold the upstream token. `env.MUNS_TOKEN` never leaves this file: the
 * browser posts symbols to us, we call Munshot, we return prices. A token
 * shipped to the client is a token published, and there is no obfuscated
 * version of that which is not that.
 *
 * Everything else is static. THE SITE MUST WORK WITH NO WORKER — the committed
 * EOD bhavcopy is the floor and the live quote is an overlay. If `/api/quotes`
 * 404s (plain `python3 -m http.server`), every row falls back to its EOD price
 * and the header says "last close" instead of "live".
 */

import { jsonResponse, failure, preflight, CORS_HEADERS } from './http.mjs';

const UPSTREAM = 'https://fastapi.muns.io/stock-data/batch';

/**
 * MEASURED, not guessed — scripts/probe-chunk-size.mjs.
 *
 * The upstream caps a batch at 81 symbols and answers HTTP 400 above it. The
 * cliff is a COUNT limit, not a body-length one: 80 of the LONGEST symbols
 * (879 ticker characters) resolve cleanly, while 85 of the SHORTEST (359
 * characters) return 400. So chunking by count is the correct axis.
 *
 * Shipped at 50 rather than 80 for margin: the cap is undocumented, so it can
 * move, and a chunk that crosses it fails ALL its symbols rather than
 * degrading. 50 costs three extra round trips on a full book and cannot fall
 * off the cliff.
 */
const CHUNK_SIZE = 50;
/** The documented 1000 ms times out every Indian ticker. 20000 resolves. */
const UPSTREAM_TIMEOUT_MS = 20000;
const UPSTREAM_CONCURRENCY = 3;
const MAX_SYMBOLS = 1500;

/** Short enough that a price is never stale on screen; long enough that a
 *  hundred readers cost the upstream one fetch per window. */
const CACHE_TTL_SECONDS = 30;
const FAILURE_TTL_SECONDS = 15;

/* ── rawQuote parsing — mirrors scripts/lib/munshot.mjs ───────────────────── */

function parseRawQuote(raw) {
  const out = {};
  if (typeof raw !== 'string' || raw.trim() === '') return out;
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

const MISSING = new Set(['', 'N/A', 'NA', 'None', 'null', 'nan', '-', '--']);

function fieldNumber(fields, key) {
  const value = fields[key];
  if (value === undefined) return null;
  const text = String(value).trim();
  if (MISSING.has(text)) return null;
  const parsed = Number(text.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function fieldRange(fields, key) {
  const value = fields[key];
  if (value === undefined) return { low: null, high: null };
  const parts = String(value).split(/\s*-\s*/);
  if (parts.length !== 2) return { low: null, high: null };
  const low = Number(parts[0]);
  const high = Number(parts[1]);
  return { low: Number.isFinite(low) ? low : null, high: Number.isFinite(high) ? high : null };
}

/* ── upstream ─────────────────────────────────────────────────────────────── */

async function fetchChunk(symbols, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS + 5000);
  try {
    const response = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        country: symbols.map(() => 'INDIA').join(','),
        ticker_symbol: symbols.join(','),
        type: 'stockquote_batch', // NOT 'stockquote' — that is HTTP 422
        timeout_ms: UPSTREAM_TIMEOUT_MS,
      }),
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      return { state: 'unauthorised', detail: `upstream HTTP ${response.status}`, symbols };
    }
    if (!response.ok) {
      return { state: 'upstream', detail: `upstream HTTP ${response.status}`, symbols };
    }

    const json = await response.json();
    const items = Array.isArray(json?.data?.items) ? json.data.items : [];
    const quotes = {};
    const failed = [];
    const seen = new Set();

    for (const item of items) {
      const symbol = typeof item?.ticker === 'string' ? item.ticker.trim() : '';
      if (!symbol) continue;
      seen.add(symbol);

      // A timeout is a FAILURE, not a missing value. The row keeps its EOD
      // price and says so; it must never read as "no price".
      if (item.status !== 'ok') {
        failed.push({ symbol, reason: `upstream status "${item.status ?? 'unknown'}"` });
        continue;
      }
      const fields = parseRawQuote(item.rawQuote);
      const day = fieldRange(fields, 'Day Range');
      const price = Number.isFinite(item.currentPrice) ? item.currentPrice : fieldNumber(fields, 'Current Price');
      if (price === null) {
        failed.push({ symbol, reason: 'resolved with no usable price' });
        continue;
      }
      quotes[symbol] = {
        price,
        prevClose: fieldNumber(fields, 'Previous Close'),
        open: fieldNumber(fields, 'Opening Price'),
        dayLow: day.low,
        dayHigh: day.high,
        lastVolume: fieldNumber(fields, 'Last Volume'),
        // The exchange travels with the number. Munshot is Yahoo NSE; the
        // committed baseline is BSE. They are different exchanges.
        source: 'munshot-nse',
      };
    }
    for (const symbol of symbols) {
      if (!seen.has(symbol)) failed.push({ symbol, reason: 'not present in the upstream response' });
    }
    return { state: 'ok', quotes, failed, asOf: json?.data?.asOf ?? null };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    return {
      state: aborted ? 'upstream' : 'unreachable',
      detail: aborted ? `upstream did not answer within ${UPSTREAM_TIMEOUT_MS + 5000} ms` : String(error?.message ?? error),
      symbols,
    };
  }
}

async function fetchAll(symbols, token) {
  const chunks = [];
  for (let i = 0; i < symbols.length; i += CHUNK_SIZE) chunks.push(symbols.slice(i, i + CHUNK_SIZE));

  const quotes = {};
  const failed = [];
  let asOf = null;
  let fatal = null;
  let next = 0;

  const runner = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= chunks.length) return;
      const result = await fetchChunk(chunks[index], token);
      if (result.state === 'ok') {
        Object.assign(quotes, result.quotes);
        failed.push(...result.failed);
        if (result.asOf && !asOf) asOf = result.asOf;
      } else {
        // An auth failure is fatal for the whole request; a single chunk
        // failing upstream is not — those symbols just keep their EOD price.
        if (result.state === 'unauthorised' && !fatal) fatal = result;
        for (const symbol of result.symbols) {
          failed.push({ symbol, reason: `${result.state}: ${result.detail}` });
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(UPSTREAM_CONCURRENCY, chunks.length) }, () => runner()));
  return { quotes, failed, asOf, fatal, chunks: chunks.length };
}

/* ── route ────────────────────────────────────────────────────────────────── */

async function handleQuotes(request, env, ctx) {
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'POST') {
    return failure('bad-request', 'POST a JSON body of {"symbols": ["RELIANCE", …]}', { request });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return failure('bad-request', 'request body was not JSON', { request });
  }

  const symbols = [...new Set(
    (Array.isArray(body?.symbols) ? body.symbols : [])
      .filter((s) => typeof s === 'string')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  )].sort();

  if (symbols.length === 0) return failure('bad-request', 'no symbols supplied', { request });
  if (symbols.length > MAX_SYMBOLS) {
    return failure('bad-request', `${symbols.length} symbols exceeds the ${MAX_SYMBOLS} limit`, { request });
  }

  // A POST is not cacheable by URL, so the cache key is a synthetic GET whose
  // path carries the symbol set. Sorting and de-duping above is what makes two
  // readers asking for the same book share one entry.
  const cacheKey = new Request(
    `https://cache.sattva.internal/api/quotes?n=${symbols.length}&h=${hashSymbols(symbols)}`,
    { method: 'GET' },
  );
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set('x-siflows-cache', 'hit');
    return new Response(cached.body, { status: cached.status, headers });
  }

  const token = env?.MUNS_TOKEN ?? null;
  if (!token) {
    // Named so the UI can say which command fixes it. The upstream currently
    // answers unauthenticated requests, but shipping that as the design would
    // make the token optional by accident — and the day it stops being optional
    // the failure would look like an outage.
    const response = failure('no-token', 'MUNS_TOKEN is not configured on this Worker', {
      maxAge: FAILURE_TTL_SECONDS, request,
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }

  const result = await fetchAll(symbols, token);

  if (result.fatal) {
    const response = failure(result.fatal.state, result.fatal.detail, { maxAge: FAILURE_TTL_SECONDS, request });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }

  if (Object.keys(result.quotes).length === 0) {
    const reason = result.failed.some((f) => /unreachable/.test(f.reason)) ? 'unreachable' : 'upstream';
    const response = failure(reason, 'no symbol resolved', {
      maxAge: FAILURE_TTL_SECONDS, request, extra: { failed: result.failed },
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }

  const response = jsonResponse(
    {
      ok: true,
      asOf: result.asOf ?? new Date().toISOString(),
      requested: symbols.length,
      resolved: Object.keys(result.quotes).length,
      chunks: result.chunks,
      chunkSize: CHUNK_SIZE,
      quotes: result.quotes,
      failed: result.failed,
    },
    { maxAge: CACHE_TTL_SECONDS, cacheState: 'live', request },
  );

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function hashSymbols(symbols) {
  let hash = 0x811c9dc5;
  const joined = symbols.join(',');
  for (let i = 0; i < joined.length; i += 1) {
    hash ^= joined.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/quotes') return handleQuotes(request, env, ctx);
    if (url.pathname === '/api/health') {
      return jsonResponse(
        { ok: true, tokenConfigured: Boolean(env?.MUNS_TOKEN), chunkSize: CHUNK_SIZE, cacheTtlSeconds: CACHE_TTL_SECONDS },
        { maxAge: 0, request },
      );
    }
    // Everything else is a static asset. The site works without this Worker.
    return env.ASSETS.fetch(request);
  },
};
