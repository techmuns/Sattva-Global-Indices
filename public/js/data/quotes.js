/**
 * quotes.js — the live overlay.
 *
 * Fetches live NSE quotes through our Worker, merges them into memory, and
 * emits the keys that actually changed.
 *
 * ---------------------------------------------------------------------------
 * FOUR RULES THIS MODULE EXISTS TO ENFORCE
 * ---------------------------------------------------------------------------
 * 1. LIVE PRICES ARE NEVER WRITTEN BACK to a committed file. The committed
 *    prices.json is the server's own bytes under the server's own date; a
 *    locally patched copy would destroy the basis for trusting either. This
 *    module holds an in-memory overlay and nothing else.
 *
 * 2. A LIVE PRICE SWAPS THE EXCHANGE. Munshot is Yahoo NSE; the baseline is BSE
 *    bhavcopy. So every overlaid row carries `priceExchange: 'NSE'` and a
 *    reader can always tell whether the number moved because the stock moved or
 *    because the source did.
 *
 * 3. OUTSIDE MARKET HOURS THERE IS NO LIVE PRICE, only the last one. The poller
 *    does not run, and the UI says "last close" rather than "live".
 *
 * 4. A TIMED-OUT TICKER IS A FAILURE, NOT A MISSING VALUE. It keeps its EOD
 *    price, stays on the `eod` tier, and is listed in `failed`.
 */

import { createPoller } from '../core/live.js';
import * as companies from './companies.js';

const QUOTES_ENDPOINT = 'api/quotes';
const REQUEST_TIMEOUT_MS = 25000;

/** IST market window. No holiday calendar, so a holiday looks like an open
 *  session with no ticks — which is why the freshness claim on screen is
 *  derived from whether a byte arrived, not from the clock alone. */
export const MARKET_OPEN_MINUTES = 9 * 60 + 15;
export const MARKET_CLOSE_MINUTES = 15 * 60 + 30;

export function istNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { minutes: Number(get('hour')) * 60 + Number(get('minute')), weekday: get('weekday') };
}

export function isMarketOpen(now = new Date()) {
  const { minutes, weekday } = istNow(now);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return minutes >= MARKET_OPEN_MINUTES && minutes <= MARKET_CLOSE_MINUTES;
}

/* ── state ────────────────────────────────────────────────────────────────── */

/** symbol -> live quote. In memory only, for this page view. */
const overlay = new Map();
let lastAsOf = null;
let lastOk = null;
let lastFailure = null;
let lastFailedSymbols = [];
let poller = null;
const listeners = new Set();

export const liveQuote = (nseSymbol) => (nseSymbol ? overlay.get(nseSymbol) ?? null : null);
export const liveCount = () => overlay.size;
export const liveAsOf = () => lastAsOf;
export const lastLiveError = () => lastFailure;
export const liveFailedSymbols = () => lastFailedSymbols;
export const isLive = () => lastOk === true && overlay.size > 0 && isMarketOpen();

/** Symbols a live quote could EVER reach: Munshot is keyed on NSE tickers, so a
 *  company with no asserted NSE symbol stays on EOD permanently. */
export function eligibleSymbols() {
  return companies.all().map((c) => c.nseSymbol).filter(Boolean);
}

export function onQuotes(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

function emit(event) {
  for (const handler of listeners) {
    try { handler(event); } catch (error) { console.error('[quotes] listener threw', error); }
  }
}

/* ── fetch ────────────────────────────────────────────────────────────────── */

/**
 * One request to OUR Worker. Always resolves — never throws, never hangs.
 * A missing `/api/quotes` (the plain static server) resolves as `no-worker`,
 * which is a normal state, not an error: the site is designed to run without it.
 */
export async function fetchQuotes(symbols) {
  if (!symbols.length) return { ok: false, reason: 'no-symbols' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(QUOTES_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbols }),
      signal: controller.signal,
    });

    // A static origin has no /api/quotes, and each server says so differently:
    // 404 (nginx, Cloudflare Pages), 405 (method not allowed), 501 (Python's
    // http.server, which is what `python3 -m http.server` returns for a POST).
    // All three mean the same thing — there is no Worker here — and that is a
    // designed state, not an error.
    if ([404, 405, 501].includes(response.status)) {
      return { ok: false, reason: 'no-worker', detail: 'this deployment serves static files only' };
    }
    if (!response.ok) {
      return { ok: false, reason: 'upstream', detail: `worker returned HTTP ${response.status}` };
    }

    const cacheState = response.headers.get('x-siflows-cache');
    const json = await response.json();
    if (!json?.ok) {
      return { ok: false, reason: json?.reason ?? 'upstream', detail: json?.detail ?? null, remedy: json?.remedy ?? null, cacheState };
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
 * Merge a result into the overlay and return the COMPANY KEYS whose displayed
 * numbers actually changed.
 *
 * Returning changed keys rather than "everything" is the whole point: the table
 * repaints exactly those rows through `updateRows(keys)`, so a price landing
 * never disturbs the reader's search, filters, sort or watchlist.
 */
export function mergeQuotes(result) {
  const changed = [];
  if (!result?.ok || !result.quotes) return changed;

  const bySymbol = new Map();
  for (const company of companies.all()) {
    if (company.nseSymbol) bySymbol.set(company.nseSymbol, company);
  }

  for (const [symbol, quote] of Object.entries(result.quotes)) {
    if (!Number.isFinite(quote?.price) || quote.price <= 0) continue;
    const previous = overlay.get(symbol);
    overlay.set(symbol, { ...quote, symbol, receivedAt: new Date() });
    if (previous && previous.price === quote.price) continue; // nothing visible moved
    const company = bySymbol.get(symbol);
    if (company) changed.push(companies.keyOf(company));
  }

  lastAsOf = result.asOf ?? new Date().toISOString();
  return changed;
}

/* ── poller ───────────────────────────────────────────────────────────────── */

export function startLive({ intervalMs = 30000 } = {}) {
  if (poller) return poller;

  poller = createPoller({
    name: 'quotes',
    intervalMs,
    // Outside market hours there is no live price, only the last one. Not an
    // error state — simply nothing to ask for.
    shouldPoll: () => isMarketOpen() && eligibleSymbols().length > 0,
    fetcher: () => fetchQuotes(eligibleSymbols()),
  });

  poller.subscribe((event) => {
    if (event.type === 'idle') {
      lastOk = null;
      emit({ type: 'idle', at: event.at });
      return;
    }
    if (event.type === 'error') {
      lastOk = false;
      lastFailure = { reason: event.result.reason, detail: event.result.detail ?? null, remedy: event.result.remedy ?? null, at: event.at };
      emit({ type: 'error', at: event.at, failure: lastFailure, failures: event.failures });
      // `no-worker` is not transient and will not fix itself: this deployment
      // has no /api/quotes and never will. Retrying every 30 seconds would add
      // a console error per tick to a site that is working exactly as designed.
      if (event.result.reason === 'no-worker') {
        console.info('[quotes] no /api/quotes on this origin — staying on committed end-of-day prices');
        stopLive();
      }
      return;
    }
    lastOk = true;
    lastFailure = null;
    lastFailedSymbols = Array.isArray(event.result.failed) ? event.result.failed : [];
    const changed = mergeQuotes(event.result);
    emit({
      type: 'tick',
      at: event.at,
      changed,
      resolved: event.result.resolved ?? Object.keys(event.result.quotes ?? {}).length,
      requested: event.result.requested ?? null,
      cacheState: event.result.cacheState ?? null,
    });
  });

  poller.start();
  return poller;
}

export function stopLive() {
  poller?.stop();
  poller = null;
}

export const livePoller = () => poller;

/** Test seam: drive the overlay without a network. */
export function __injectQuotes(result) {
  const changed = mergeQuotes(result);
  lastOk = true;
  lastFailedSymbols = result.failed ?? [];
  emit({ type: 'tick', at: new Date(), changed, resolved: Object.keys(result.quotes ?? {}).length, requested: null, cacheState: 'test' });
  return changed;
}
