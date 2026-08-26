/**
 * freefloat.js — BSE's own published free float, read live, in memory only.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND THE THING IT IS NOT
 * ---------------------------------------------------------------------------
 * The upstream is documented as a "free float market cap" API and reached
 * through Munshot, which invites the reading that it is a live NSE figure. It
 * is not. Its own note is explicit — "We source the value from BSE, not NSE" —
 * because NSE's `quote-equity`, the only NSE endpoint carrying `ffmc`, is
 * Akamai-blocked from their servers exactly as it is from ours (CLAUDE.md §3.7).
 * Upstream of the proxy it is `api.bseindia.com/.../StockTrading/w`: the SAME
 * endpoint `scripts/scrape-bse-freefloat.mjs` already scrapes every month.
 *
 * So this module adds no new source and no new exchange. What it adds is a path
 * to that source that a BROWSER can take, between scrapes.
 *
 * ---------------------------------------------------------------------------
 * WHICH MAKES ITS JOB A NARROW ONE
 * ---------------------------------------------------------------------------
 * The record already carries a live-priced free float:
 *
 *     freeFloatMcapInr = floatFactor × sharesOutstanding × price
 *
 * and `price` is already live during market hours. Re-fetching a rupee free
 * float would not make that fresher. What the monthly cadence CANNOT see is the
 * factor itself moving — a lock-in expiry, a promoter sale, a fresh issue —
 * and that is one of the events in CLAUDE.md §2.11 that actually FORCES an
 * index fund to trade.
 *
 * That is this module's job: compare BSE's live factor against the stored one
 * and say whether BSE has restated it. Measured before building it — 60
 * companies across the size range on 26 Aug 2026, against a record scraped 21
 * Aug 2026: 60 unchanged, 0 moved. The check is expected to be quiet, and a
 * quiet check that goes loud on the one company that matters is the point.
 *
 * ---------------------------------------------------------------------------
 * RULES THIS MODULE ENFORCES
 * ---------------------------------------------------------------------------
 * 1. NOTHING IS WRITTEN BACK. `bse-freefloat.json` is BSE's bytes under BSE's
 *    own capture date. A locally patched copy would destroy the basis for
 *    trusting either it or this. In-memory overlay, this page view only.
 *
 * 2. CRORE BECOMES RUPEES EXACTLY ONCE, here, through `crore()` from the
 *    threshold module. The wire format names its unit (`freeFloatCr`) so a
 *    crore value cannot be mistaken for a rupee one in transit — a ten-million
 *    fold error that sorts and sums perfectly happily (CLAUDE.md §3.8).
 *
 * 3. A FAILURE IS NOT AN ABSENCE. An unreachable Worker, a 404 from the
 *    upstream, a rejected token — each is its own named state and reaches the
 *    screen in those words. `unchecked` and `failed` are different things and
 *    neither is "the factor agrees".
 *
 * 4. THE TWO CLOCKS STAY APART. BSE's `asOf` travels with the value; the moment
 *    we asked is `fetchedAt`. They are never collapsed into one "updated" time.
 */

import { crore, FLOAT_FACTOR_REVISION_PCT } from '../config/thresholds.mjs';
import * as companies from './companies.js';

const FREEFLOAT_ENDPOINT = 'api/freefloat';
const REQUEST_TIMEOUT_MS = 20000;

/** Mirrors FREEFLOAT_MAX_TICKERS in worker/index.js. The Worker rejects above
 *  it; this keeps the client from ever posting a request it knows will fail. */
export const MAX_TICKERS = 25;

/* ── state ────────────────────────────────────────────────────────────────── */

/** scrip code -> the live BSE reading. In memory only, for this page view. */
const overlay = new Map();
/** scrip code -> why the last attempt for THIS company failed. A failure is a
 *  fact about the attempt, so it is kept per company rather than globally. */
const failures = new Map();
/** Requests in flight, so a reader opening the same drill twice does not
 *  produce two upstream calls. */
const inFlight = new Map();
let lastFailure = null;
let lastFetchedAt = null;
const listeners = new Set();

export const liveFloat = (scripCode) => (scripCode ? overlay.get(String(scripCode)) ?? null : null);
export const liveFloatCount = () => overlay.size;
export const lastFloatError = () => lastFailure;
export const lastFetched = () => lastFetchedAt;
export const floatFailure = (scripCode) => (scripCode ? failures.get(String(scripCode)) ?? null : null);

export function onFreeFloat(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

function emit(event) {
  for (const handler of listeners) {
    try { handler(event); } catch (error) { console.error('[freefloat] listener threw', error); }
  }
}

/**
 * The key we ask on.
 *
 * The upstream accepts an NSE symbol, a BSE security id or a numeric scrip
 * code, and resolves the first two through its own database. We send the
 * NUMERIC SCRIP CODE whenever we hold one, because ours came out of BSE's
 * ACTIVE scrip master — the one filter standing between this project and a
 * three-year-stale figure for a delisted company (CLAUDE.md §3.8). Letting a
 * remote resolver pick the code would hand that guarantee away.
 */
export function tickerFor(company) {
  if (company?.bseScripCode) return String(company.bseScripCode);
  if (company?.nseSymbol) return company.nseSymbol;
  return null;
}

/* ── fetch ────────────────────────────────────────────────────────────────── */

/**
 * One request to OUR Worker. Always resolves — never throws, never hangs.
 * A missing `/api/freefloat` (the plain static server) resolves as `no-worker`,
 * which is a normal state and not an error: the site is designed without it.
 */
export async function fetchFreeFloat(tickers) {
  const list = [...new Set(tickers.filter(Boolean).map(String))];
  if (!list.length) return { ok: false, reason: 'no-tickers' };
  if (list.length > MAX_TICKERS) {
    return { ok: false, reason: 'bad-request', detail: `${list.length} tickers exceeds the ${MAX_TICKERS} limit` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(FREEFLOAT_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tickers: list }),
      signal: controller.signal,
    });

    // A static origin has no /api/freefloat, and each server says so
    // differently: 404 (nginx, Pages), 405 (method not allowed), 501 (Python's
    // http.server, which is what `python3 -m http.server` answers to a POST).
    // All three mean there is no Worker here, which is a designed state.
    if ([404, 405, 501].includes(response.status)) {
      return { ok: false, reason: 'no-worker', detail: 'this deployment serves static files only' };
    }
    if (!response.ok) {
      return { ok: false, reason: 'upstream', detail: `worker returned HTTP ${response.status}`, failed: [] };
    }

    const cacheState = response.headers.get('x-siflows-cache');
    const json = await response.json();
    if (!json?.ok) {
      // Carry failed[] through. The Worker names every ticker it could not
      // resolve and why; dropping that here would leave the interface knowing
      // only that "something upstream" broke, during exactly the outage the
      // per-ticker detail exists to describe.
      return {
        ok: false,
        reason: json?.reason ?? 'upstream',
        detail: json?.detail ?? null,
        remedy: json?.remedy ?? null,
        failed: Array.isArray(json?.failed) ? json.failed : [],
        cacheState,
      };
    }
    return { ok: true, ...json, cacheState };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    return {
      ok: false,
      reason: aborted ? 'upstream' : 'unreachable',
      detail: aborted ? `no answer within ${REQUEST_TIMEOUT_MS} ms` : String(error?.message ?? error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Merge a result into the overlay. Returns the company keys whose check changed,
 * so a caller can repaint exactly those rows.
 */
export function mergeFreeFloat(result, requested = []) {
  const changed = [];
  if (!result?.ok || !result.values) return changed;

  const byTicker = new Map();
  for (const company of companies.all()) {
    const ticker = tickerFor(company);
    if (ticker) byTicker.set(ticker, company);
  }

  for (const [ticker, value] of Object.entries(result.values)) {
    // CONVERTED ONCE, HERE. Everything downstream of this line is rupees.
    overlay.set(ticker, {
      ...value,
      ticker,
      freeFloatMcapInr: Math.round(crore(value.freeFloatCr)),
      fullMcapInr: Math.round(crore(value.fullCr)),
      receivedAt: new Date(),
    });
    failures.delete(ticker);
    const company = byTicker.get(ticker);
    if (company) changed.push(companies.keyOf(company));
  }

  // A ticker we asked about that did not come back is a FAILURE for that
  // company, recorded against it by name. Leaving it merely absent would make
  // "we could not read it" indistinguishable from "we never asked".
  const returned = new Set(Object.keys(result.values));
  const byReason = new Map((result.failed ?? []).map((f) => [String(f.ticker), f.reason]));
  for (const ticker of requested.map(String)) {
    if (returned.has(ticker)) continue;
    failures.set(ticker, byReason.get(ticker) ?? 'not present in the upstream response');
    const company = byTicker.get(ticker);
    if (company) changed.push(companies.keyOf(company));
  }

  lastFetchedAt = result.fetchedAt ?? new Date().toISOString();
  return changed;
}

/**
 * Check one company on demand, de-duplicating concurrent asks.
 * Resolves to the same shape `checkFor` reads.
 */
export async function checkCompany(company) {
  const ticker = tickerFor(company);
  if (!ticker) return { state: 'unavailable', reason: 'no BSE scrip code or NSE symbol to ask on' };
  if (overlay.has(ticker)) return checkFor(company);
  if (inFlight.has(ticker)) { await inFlight.get(ticker); return checkFor(company); }

  const run = (async () => {
    const result = await fetchFreeFloat([ticker]);
    if (result.ok) {
      lastFailure = null;
      const changed = mergeFreeFloat(result, [ticker]);
      emit({ type: 'checked', changed, cacheState: result.cacheState ?? null });
    } else {
      lastFailure = { reason: result.reason, detail: result.detail ?? null, remedy: result.remedy ?? null, at: new Date() };
      failures.set(ticker, `${result.reason}${result.detail ? `: ${result.detail}` : ''}`);
      emit({ type: 'error', failure: lastFailure });
    }
  })();

  inFlight.set(ticker, run);
  try { await run; } finally { inFlight.delete(ticker); }
  return checkFor(company);
}

/* ── the check ────────────────────────────────────────────────────────────── */

/**
 * Has BSE restated this company's float factor since the record was built?
 *
 * Five states, and they are deliberately five rather than a boolean:
 *
 *   unavailable — nothing to ask on, or no stored factor to compare against
 *   unchecked   — we have not asked. NOT "agrees".
 *   failed      — we asked and could not read it. NOT "agrees" either.
 *   agrees      — BSE's live factor matches the stored one within the threshold
 *   revised     — BSE has restated it, and that may force a trade
 *
 * The comparison is against `floatFactorBse` and never against `floatFactor`.
 * Where the desk's rule took NSE's factor instead (a gap over 2%), `floatFactor`
 * is NSE's, and measuring an NSE figure against a BSE one would report the
 * known definitional gap between the exchanges as a fresh revision every single
 * time — CLAUDE.md §2.8. Like against like, or not at all.
 */
export function checkFor(company) {
  const ticker = tickerFor(company);
  const stored = company?.floatFactorBse ?? null;

  if (!ticker || stored === null || stored === undefined) {
    return {
      state: 'unavailable',
      reason: !ticker ? 'no BSE scrip code or NSE symbol to ask on' : 'no stored BSE factor to compare against',
      storedFactor: stored ?? null,
      liveFactor: null,
      gapPct: null,
      thresholdPct: FLOAT_FACTOR_REVISION_PCT,
    };
  }

  const failed = failures.get(ticker);
  if (failed) {
    return {
      state: 'failed', reason: failed, storedFactor: stored, liveFactor: null, gapPct: null,
      thresholdPct: FLOAT_FACTOR_REVISION_PCT, ticker,
    };
  }

  const live = overlay.get(ticker);
  if (!live) {
    return {
      state: 'unchecked', reason: null, storedFactor: stored, liveFactor: null, gapPct: null,
      thresholdPct: FLOAT_FACTOR_REVISION_PCT, ticker,
    };
  }

  const gapPct = ((live.factor - stored) / stored) * 100;
  return {
    state: Math.abs(gapPct) > FLOAT_FACTOR_REVISION_PCT ? 'revised' : 'agrees',
    reason: null,
    storedFactor: stored,
    liveFactor: live.factor,
    gapPct,
    thresholdPct: FLOAT_FACTOR_REVISION_PCT,
    ticker,
    // BSE's own as-of, never restamped with our fetch time.
    asOf: live.asOf ?? null,
    fetchedAt: lastFetchedAt,
    freeFloatMcapInr: live.freeFloatMcapInr,
    fullMcapInr: live.fullMcapInr,
    source: live.source ?? 'BSE',
  };
}

/** Test seam: drive the overlay without a network. */
export function __injectFreeFloat(result, requested = []) {
  return mergeFreeFloat(result, requested);
}

/** Test seam: forget everything read this session. */
export function __resetFreeFloat() {
  overlay.clear();
  failures.clear();
  inFlight.clear();
  lastFailure = null;
  lastFetchedAt = null;
}
