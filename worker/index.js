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
/**
 * ⚠ OUR OWN PARALLELISM MEASURABLY HALVES THE UPSTREAM'S RESOLVE RATE.
 *
 * Measured 28 Aug 2026, 150 symbols as three chunks of 50, interleaved over
 * three rounds, 450 symbol-attempts per arm:
 *
 *     3 chunks at once        38 of 450   8.4%   21 s
 *     1 chunk at a time       83 of 450  18.4%   52 s
 *
 * Sequential won every round — 28 v 14, 30 v 12, 25 v 12 — so the direction is
 * not noise, unlike the batch-SIZE gradient measured the same afternoon, where
 * the same configuration varied 2.7x between rounds and no size could be
 * distinguished from another.
 *
 * Fully sequential is not available: 52 s is twice the browser's budget. Two is
 * the compromise, and it costs little because the symbols we drop by halving
 * capacity are the ones furthest down the reader's own sort order — quotes.js
 * sends the watchlist and the visible rows first.
 *
 * ⚠ MEASURED DURING A DEGRADED PERIOD. The upstream spent that afternoon
 * answering nginx 502s for every endpoint and resolving roughly one symbol in
 * eight. The RATIO between the arms is the finding; the absolute rates are not
 * a description of normal service, and this constant is worth re-measuring when
 * the upstream is healthy.
 */
const UPSTREAM_CONCURRENCY = 2;

/**
 * ⚠ THE ONLY NUMBER THAT MATTERS HERE IS HOW LONG THE ANSWER TAKES.
 *
 * This was 1500, which is not a capacity — it is the size of the book. Asking
 * for the book is what broke live quotes on 28 Aug 2026, and the arithmetic is
 * not subtle:
 *
 *     1,218 eligible symbols / 50 per chunk        = 25 chunks
 *     25 chunks / 3 concurrent                     =  9 waves
 *     each wave costs the upstream's FULL timeout   x 20 s
 *                                                  = 169 s, measured
 *
 * The browser aborts at 25 s. So every poll aborted, and quotes.js reported
 * the abort as `upstream` — blaming a third party for our own arithmetic. The
 * upstream was degraded that day, which is what made every wave run to its
 * full timeout instead of returning early, but the misconfiguration was ours
 * and it would bite again the moment the upstream slowed at all.
 *
 * So the cap is DERIVED from what one wave can carry, not chosen. One wave is
 * CHUNK_SIZE x UPSTREAM_CONCURRENCY symbols and costs about UPSTREAM_TIMEOUT_MS
 * in the worst case, which is what the caller's budget is sized against. Change
 * either constant and this moves with it — a hand-typed capacity would go stale
 * the first time one of them did.
 */
const ONE_WAVE = CHUNK_SIZE * UPSTREAM_CONCURRENCY;
const MAX_SYMBOLS = ONE_WAVE;

/**
 * The hard deadline for the whole request, and it is a PROMISE, not a hope.
 *
 * ⚠ GATING ONLY THE DISPATCH OF NEW CHUNKS IS NOT A BOUND.
 *
 * The first version checked the deadline before starting a chunk, which does
 * nothing about a chunk already in flight. A chunk's own worst case is
 * UPSTREAM_TIMEOUT_MS plus the 5 s abort guard = 25 s, exactly the browser's
 * budget — so the two would race, and on a slow day the browser would win and
 * report a timeout for a Worker that was about to answer.
 *
 * So fetchAll now RACES the whole run against this deadline and returns
 * whatever resolved when it fires. A partial answer inside the budget is the
 * correct answer here: the rows that resolved go live, the rest stay on their
 * committed close and say so. 21 s leaves the browser's 25 s a clear four
 * seconds for the round trip and the JSON.
 *
 * Symbols in a chunk that was still in flight are `notAttempted`, which is a
 * different fact from `failed` and must never be folded into it — we did not
 * ask and get nothing back, we stopped waiting.
 */
const REQUEST_BUDGET_MS = 21000;

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

async function fetchChunk(symbols, token, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs + 5000);
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
        timeout_ms: timeoutMs,
      }),
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      return { state: 'unauthorised', detail: `upstream HTTP ${response.status}`, symbols };
    }
    // ⚠ A GATEWAY ERROR IS AN OUTAGE, NOT AN ANSWER ABOUT THESE SYMBOLS.
    //
    // Measured 28 Aug 2026: fastapi.muns.io began serving nginx's own
    // "502 Bad Gateway" HTML for EVERY endpoint, /market_data included. Folded
    // into the generic `upstream` state that reads on screen exactly like "we
    // asked and nothing resolved" — which is a claim about the book rather than
    // about the service, and points the next reader at the wrong thing.
    if ([502, 503, 504].includes(response.status)) {
      return { state: 'down', detail: `upstream gateway error HTTP ${response.status}`, symbols };
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
      detail: aborted ? `upstream did not answer within ${timeoutMs + 5000} ms` : String(error?.message ?? error),
      symbols,
    };
  }
}

/**
 * One chunk, with a bounded retry for the symbols that came back transient.
 *
 * ---------------------------------------------------------------------------
 * ⚠ `not_found` FROM THIS UPSTREAM IS NOT A FACT ABOUT THE SYMBOL
 * ---------------------------------------------------------------------------
 * CLAUDE.md 3.8 already records it and nothing acted on it: under load the
 * upstream answers `not_found` for tickers it served correctly minutes earlier.
 * Measured 28 Aug 2026, one symbol at a time with nothing else in flight,
 * RELIANCE resolved on 2 of 8 attempts. A deliberately impossible symbol
 * returns the SAME `not_found`, so the status cannot tell a real company from a
 * fake one and must never be cached as though it could.
 *
 * So a `timeout` or `not_found` is retried once, and only for the symbols that
 * carried it — a whole-chunk retry would re-ask for the ones that already
 * answered and spend the budget re-fetching good data. `unrecognised` failure
 * reasons are not retried: they are about the shape of the answer, not its
 * availability, and repeating the request would not change them.
 *
 * ONE extra attempt, not a loop. The budget is one wave, and a second full pass
 * would double the wall clock for a service that is either healthy (in which
 * case one retry is plenty) or down (in which case no number of retries helps).
 */
/**
 * ⚠ ONLY `not_found` IS WORTH RETRYING. A `timeout` IS NOT.
 *
 * They are not two flavours of the same failure, and the difference is in the
 * clock. Measured 28 Aug 2026:
 *
 *     not_found   comes back in about 1.2 s   and is demonstrably transient —
 *                 RELIANCE resolved on 2 of 8 identical single-symbol requests,
 *                 and a symbol that CANNOT exist returns the same not_found, so
 *                 the status carries no information about the symbol at all
 *     timeout     comes back after the FULL 20 s, having already spent the
 *                 upstream's whole budget on that symbol and failed
 *
 * So retrying a not_found costs a second and sometimes buys a quote; retrying a
 * timeout costs another twenty seconds on a symbol that just proved slow. The
 * first version retried both, and a five-symbol request took 22.8 s to return
 * one quote — the retry ate the entire tick.
 */
const RETRYABLE = /^upstream status "not_found"$/;
/** Headroom kept back so the retry cannot itself overrun the request budget. */
const RETRY_MARGIN_MS = 1500;
/** Below this there is not enough time for a retry to be worth the round trip. */
const RETRY_MIN_MS = 2000;
/**
 * The retry's own window. A not_found round trip was measured at about 1.2 s
 * and a successful one at about 2 s, so six seconds is roughly a threefold
 * margin over both — generous enough that a recoverable symbol is not cut off,
 * and short enough that a symbol which has started hanging cannot spend the
 * tick. Without this cap the retry inherited the full 20 s and did exactly that.
 */
const RETRY_TIMEOUT_MS = 6000;

async function fetchChunkWithRetry(symbols, token, deadline) {
  const first = await fetchChunk(symbols, token);
  if (first.state !== 'ok') return first;

  const retryable = first.failed.filter((f) => RETRYABLE.test(f.reason)).map((f) => f.symbol);
  if (retryable.length === 0) return first;

  // ⚠ THE RETRY MUST FIT IN WHAT IS LEFT, NOT MERELY START BEFORE THE DEADLINE.
  //
  // A chunk costs the upstream's full timeout whenever any symbol in it fails,
  // so a retry at the upstream's own timeout is another whole 20 s. Gating on
  // "are we past the deadline yet" let a retry start at 20 s into a 24 s budget
  // and finish at 40 s, turning the one-wave guarantee back into two waves and
  // aborting the browser exactly as before. Measured: the first attempt at this
  // fix still timed out at 25 s for precisely that reason.
  //
  // So the retry is given the time that is ACTUALLY LEFT rather than the time a
  // first attempt gets. That is also why it is worth having: a `not_found` comes
  // back in about a second, so a short retry window is enough to recover one,
  // while a `timeout` needs the full 20 s and correctly will not fit.
  const remaining = deadline - Date.now() - RETRY_MARGIN_MS;
  if (remaining < RETRY_MIN_MS) return first;

  const second = await fetchChunk(retryable, token, Math.min(RETRY_TIMEOUT_MS, remaining));
  if (second.state !== 'ok') return first;   // a failed retry leaves the first answer standing

  const recovered = new Set(Object.keys(second.quotes));
  return {
    state: 'ok',
    quotes: { ...first.quotes, ...second.quotes },
    // Keep the ORIGINAL reason for anything the retry did not recover, so the
    // record still says what went wrong rather than only that it went wrong twice.
    failed: first.failed.filter((f) => !recovered.has(f.symbol)),
    asOf: second.asOf ?? first.asOf,
    retried: retryable.length,
    recovered: recovered.size,
  };
}

async function fetchAll(symbols, token) {
  const chunks = [];
  for (let i = 0; i < symbols.length; i += CHUNK_SIZE) chunks.push(symbols.slice(i, i + CHUNK_SIZE));

  const quotes = {};
  const failed = [];
  const notAttempted = [];
  let asOf = null;
  let fatal = null;
  let next = 0;
  let downChunks = 0;
  let retried = 0;
  let recovered = 0;
  const deadline = Date.now() + REQUEST_BUDGET_MS;

  const runner = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= chunks.length) return;

      // ⚠ NOT ATTEMPTED IS NOT FAILED. A symbol we never asked about has no
      // result, and recording it in failed[] would report our own budget as a
      // fact about the symbol — the same class of error as rendering a missing
      // value as zero. It gets its own list and its own words.
      if (Date.now() >= deadline) {
        for (const symbol of chunks[index]) notAttempted.push(symbol);
        continue;
      }

      const result = await fetchChunkWithRetry(chunks[index], token, deadline);
      if (result.state === 'ok') {
        Object.assign(quotes, result.quotes);
        failed.push(...result.failed);
        retried += result.retried ?? 0;
        recovered += result.recovered ?? 0;
        if (result.asOf && !asOf) asOf = result.asOf;
      } else {
        // An auth failure is fatal for the whole request; a single chunk
        // failing upstream is not — those symbols just keep their EOD price.
        if (result.state === 'unauthorised' && !fatal) fatal = result;
        if (result.state === 'down') downChunks += 1;
        for (const symbol of result.symbols) {
          failed.push({ symbol, reason: `${result.state}: ${result.detail}` });
        }
      }
    }
  };

  // RACE, do not await. `quotes`, `failed` and the counters are mutated in
  // place, so whatever has landed when the deadline fires is already correct —
  // and a runner still in flight simply stops being waited on.
  let timer = null;
  const budget = new Promise((resolve) => { timer = setTimeout(() => resolve('deadline'), REQUEST_BUDGET_MS); });
  const runners = Promise.all(
    Array.from({ length: Math.min(UPSTREAM_CONCURRENCY, chunks.length) }, () => runner()),
  ).then(() => 'complete');
  const outcome = await Promise.race([runners, budget]);
  clearTimeout(timer);

  // Anything neither resolved nor named as failed was in flight when we stopped
  // waiting. It gets counted, in its own words, rather than disappearing.
  if (outcome === 'deadline') {
    const accountedFor = new Set([...Object.keys(quotes), ...failed.map((f) => f.symbol), ...notAttempted]);
    for (const symbol of symbols) if (!accountedFor.has(symbol)) notAttempted.push(symbol);
  }

  return {
    quotes, failed, notAttempted, asOf, fatal, retried, recovered,
    timedOut: outcome === 'deadline',
    budgetMs: REQUEST_BUDGET_MS,
    chunks: chunks.length,
    // Every chunk answering with a gateway error is an OUTAGE, and it must not
    // read as "none of your symbols exist". See the `down` state in fetchChunk.
    allDown: downChunks > 0 && downChunks === chunks.length,
  };
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

  // ⚠ TRIM, DO NOT REJECT. A caller asking for more than one wave gets the
  // first MAX_SYMBOLS answered and is TOLD what was left out — refusing the
  // whole request would turn "we can quote 150 of your 1,218" into "you get
  // nothing", which is strictly worse for a reader and hides the cap.
  //
  // The caller decides the ORDER, and that is the load-bearing half: quotes.js
  // puts the rows on screen and the watchlist first, so a trim drops the rows
  // nobody is looking at.
  const overflow = symbols.length > MAX_SYMBOLS ? symbols.slice(MAX_SYMBOLS) : [];
  const asked = overflow.length ? symbols.slice(0, MAX_SYMBOLS) : symbols;

  // A POST is not cacheable by URL, so the cache key is a synthetic GET whose
  // path carries the symbol set. Sorting and de-duping above is what makes two
  // readers asking for the same book share one entry.
  const cacheKey = new Request(
    `https://cache.sattva.internal/api/quotes?n=${asked.length}&h=${hashSymbols(asked)}`,
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

  const result = await fetchAll(asked, token);

  if (result.fatal) {
    const response = failure(result.fatal.state, result.fatal.detail, { maxAge: FAILURE_TTL_SECONDS, request });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }

  if (Object.keys(result.quotes).length === 0) {
    // The reason has to name what actually happened, because the pill prints it
    // verbatim and a reader acts on that word. "upstream" for a gateway outage
    // sends the next person to look at our symbol list.
    const reason = result.allDown
      ? 'upstream-down'
      : result.failed.some((f) => /unreachable/.test(f.reason)) ? 'unreachable' : 'upstream';
    const detail = result.allDown
      ? 'the upstream is returning gateway errors for every request'
      : 'no symbol resolved';
    const response = failure(reason, detail, {
      maxAge: FAILURE_TTL_SECONDS,
      request,
      extra: { failed: result.failed, notAttempted: result.notAttempted, requested: asked.length },
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }

  const response = jsonResponse(
    {
      ok: true,
      asOf: result.asOf ?? new Date().toISOString(),
      // BOTH numbers, because they differ the moment a caller asks for more
      // than one wave and a reader must be able to see the cap rather than
      // infer it from a count that quietly does not match what they sent.
      sent: symbols.length,
      requested: asked.length,
      resolved: Object.keys(result.quotes).length,
      capacity: MAX_SYMBOLS,
      chunks: result.chunks,
      chunkSize: CHUNK_SIZE,
      // Reported so the retry can be judged rather than assumed. If `recovered`
      // is persistently 0 the retry is costing wall clock and buying nothing,
      // and that should be visible rather than inferred.
      retried: result.retried,
      recoveredOnRetry: result.recovered,
      // TRUE when we stopped waiting rather than finished. The rows that came
      // back are still real; the ones in `notAttempted` were simply not waited
      // for, which is not a statement about them.
      budgetExhausted: result.timedOut,
      budgetMs: result.budgetMs,
      quotes: result.quotes,
      failed: result.failed,
      // Two DIFFERENT absences, kept apart: `failed` is a symbol we asked about
      // and did not get, `notAttempted` is one we never asked about because the
      // budget ran out or the request exceeded a wave.
      notAttempted: [...result.notAttempted, ...overflow],
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
