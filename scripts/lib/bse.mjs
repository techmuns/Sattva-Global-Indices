/**
 * BSE India API client and number parser. Zero dependencies.
 *
 * BSE's `api.bseindia.com` needs no cookie warming and no TLS fingerprint, and
 * no throttling has been observed. It is the only source that covers the whole
 * listed universe rather than 261 names. It DOES now screen the request's
 * headers — see BROWSER_HEADERS below, which is the one place they live.
 *
 * Requests go through `curl` for the same reason the NSE scraper does: it is
 * the transport already proven in this environment, and it reads the proxy
 * configuration that Node's built-in fetch ignores by default.
 *
 * ---------------------------------------------------------------------------
 * THE PARSING TRAP — read this before touching any number here
 * ---------------------------------------------------------------------------
 * BSE returns money as STRINGS with INDIAN DIGIT GROUPING, in ₹ CRORE:
 *
 *     "MktCapFull": "17,69,379.44"      <- 17.69 lakh crore, i.e. ~₹17.7 trillion
 *
 * NSE returns a raw number, in RUPEES:
 *
 *     "marketCap": 8894519619599.8
 *
 * And the obvious parser is catastrophically wrong:
 *
 *     parseFloat("8,71,532.61")   // => 8
 *
 * It does not throw. It does not return NaN. It stops at the first comma and
 * hands back a plausible small number that will sort, sum and rank happily.
 *
 * So: `parseFloat` is banned anywhere near a BSE figure. Every value goes
 * through `parseGroupedNumber`, which validates the whole string before
 * converting, and everything is normalised to RUPEES at this boundary so that
 * exactly one unit exists downstream. A crore value reaching a rupee field is a
 * ten-million-fold error that looks like a formatting bug.
 */

import { execFile } from 'node:child_process';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const REFERER = 'https://www.bseindia.com/';
const API = 'https://api.bseindia.com/BseIndiaAPI/api';

/**
 * ⚠ THE HEADERS BSE'S EDGE NOW REQUIRES — ONE OWNER, EVERY CALLER.
 *
 * From about 23 Sep 2026 every request carrying only a User-Agent and a referer
 * came back `403 Access Denied` (Akamai), from a GitHub runner AND from a
 * residential Airtel line alike, while bseindia.com's own pages loaded the same
 * endpoints with 200 in a browser. It was never an IP block and the API was
 * never withdrawn: the edge began scoring the request's header set. Measured
 * 19 Oct 2026 against StockTrading for 500325:
 *
 *     UA + referer                                      -> 403
 *     UA + referer + origin + accept + accept-language  -> 403
 *     the full set below                                -> 200, real MktCapFF
 *     the full set minus `referer`                      -> 301 to a sales page
 *
 * Dropping any ONE of the others still answered 200, so the edge is scoring the
 * set rather than requiring a single header — which is why it is copied whole
 * from what the site itself sends, and why it must not be trimmed to "the ones
 * that matter".
 *
 * The daily refresh failed on this for four weeks, and because the scrip master
 * was its FIRST hard step, every other feed behind it — NSE, Yahoo, the
 * bhavcopy — went stale with it. When BSE moves the goalposts again, this is
 * the line to compare against a browser's request, and `probe-bse-reach.mjs`
 * says which endpoints answer before anyone reads a 45-minute log.
 */
export const BROWSER_HEADERS = Object.freeze({
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  origin: 'https://www.bseindia.com',
  referer: REFERER,
  'sec-ch-ua': '"Chromium";v="141", "Not?A_Brand";v="8"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-site',
});

/** BROWSER_HEADERS as curl `-H` arguments. */
export const BROWSER_HEADER_ARGS = Object.entries(BROWSER_HEADERS).flatMap(([k, v]) => ['-H', `${k}: ${v}`]);

/** ₹1 crore in rupees. Mirrors public/js/config/thresholds.mjs, which owns the
 *  constant for anything that renders; this copy keeps the lib importable by
 *  scripts with no config dependency. */
const RUPEES_PER_CRORE = 1e7;

/**
 * ⚠ THE GROUPED-NUMBER PARSER MOVED, AND NOTHING ELSE CHANGED.
 *
 * `parseGroupedNumber` now lives in `public/js/core/grouped-number.js` and is
 * re-exported here so every caller in scripts/ is untouched. The move was forced
 * by the FTSE upload panel, which parses Vanguard's `$1,234.56` in the browser:
 * this module imports `node:child_process` for the curl transport (§3.7), so it
 * cannot be loaded in a page at all. A second copy of the one function whose
 * entire job is to reject what `parseFloat` silently accepts is exactly the
 * duplication this repo cannot afford.
 */
// `import` then `export`, not a bare `export … from`: a re-export alone does not
// bind the name in this module's own scope, and `parseCroreToRupees` below calls
// it. That failed loudly on the first run, which is the good kind of failure.
import { parseGroupedNumber } from '../../public/js/core/grouped-number.js';

export { parseGroupedNumber };

/**
 * A BSE money field (crore, grouped string) as RUPEES.
 *
 * This is the only conversion point. Past this function, every monetary value
 * in the project is rupees and nothing carries a `Cr` unit.
 *
 * @param {unknown} value
 * @returns {number|null} rupees, rounded to the nearest rupee, or null
 */
export function parseCroreToRupees(value) {
  const crore = parseGroupedNumber(value);
  if (crore === null || crore <= 0) return null;
  return Math.round(crore * RUPEES_PER_CRORE);
}

/** A price field: a positive finite number, or null. Never zero. */
export function parsePrice(value) {
  const price = parseGroupedNumber(value);
  return price !== null && price > 0 ? price : null;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const STATUS_SENTINEL = '\n__CURL_HTTP_STATUS__';

/**
 * `--fail-with-body` is load-bearing. Without --fail, curl treats an HTTP 4xx
 * as a successful transfer carrying an error page, so --retry-all-errors finds
 * nothing to retry and the first hiccup becomes a permanent failure. Learned
 * the hard way on NSE; the same applies here. See CLAUDE.md §3.7.
 */
const RETRY_COUNT = 4;
const CURL_ARGS = [
  '-s',
  '-S',
  '--fail-with-body',
  '--retry', String(RETRY_COUNT),
  '--retry-delay', '5',
  '--retry-all-errors',
  '--max-time', '40',
  '--compressed',
];

/**
 * GET a BSE JSON endpoint.
 * @returns {Promise<{ok: true, json: any} | {ok: false, reason: string}>}
 */
export function bseGet(url) {
  return new Promise((resolve) => {
    execFile(
      'curl',
      [
        ...CURL_ARGS,
        '-A', USER_AGENT,
        ...BROWSER_HEADER_ARGS,
        '-w', `${STATUS_SENTINEL}%{http_code}`,
        url,
      ],
      { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          const detail = String(stderr || error.message).trim().split('\n')[0];
          resolve({ ok: false, reason: `curl failed: ${detail || 'no output'}` });
          return;
        }
        const at = stdout.lastIndexOf(STATUS_SENTINEL);
        if (at === -1) {
          resolve({ ok: false, reason: 'curl produced no status line' });
          return;
        }
        const status = Number.parseInt(stdout.slice(at + STATUS_SENTINEL.length).trim(), 10);
        const body = stdout.slice(0, at);
        if (status !== 200) {
          resolve({
            ok: false,
            reason: `HTTP ${Number.isFinite(status) ? status : '???'} after ${RETRY_COUNT} retries`,
          });
          return;
        }
        try {
          resolve({ ok: true, json: JSON.parse(body) });
        } catch (parseError) {
          resolve({
            ok: false,
            reason: `HTTP 200 but the body did not parse as JSON (${body.length} bytes): ${parseError.message}`,
          });
        }
      },
    );
  });
}

/**
 * GET a file from BSE's DOWNLOAD host (www.bseindia.com/download) as text.
 *
 * ⚠ CURL, NEVER fetch(). The download host's edge intermittently emits header
 * lines with leading whitespace (` X-Frame-Options:  SAMEORIGIN`). curl reads
 * past them; Node's undici refuses the whole response with `HTTPParserError:
 * Unexpected whitespace after header value` — measured 19 Oct 2026 on the
 * 16 Oct bhavcopy, while the 15th's file parsed fine. fetch-price-history.mjs
 * used fetch() and would have died on it mid-backfill; both bhavcopy readers
 * now share this one transport.
 *
 * The download host is NOT the API edge: a UA and a referer are what it has
 * always been sent, and BROWSER_HEADERS is not needed here.
 *
 * Status is returned, never judged: a non-session answers 200 with the SPA
 * shell, so the caller's shape probe decides what the body is (§3.8).
 *
 * @returns {Promise<{ok: boolean, status?: number, contentType?: string, text?: string, reason: string|null}>}
 */
export function bseDownloadText(url) {
  return new Promise((resolve) => {
    execFile(
      'curl',
      [
        '-s', '-S', '--fail-with-body',
        '--retry', '4', '--retry-delay', '5', '--retry-all-errors',
        '--max-time', '120', '--compressed',
        '-A', USER_AGENT, '-H', `referer: ${REFERER}`,
        '-w', `${STATUS_SENTINEL}%{http_code}\n__CT__%{content_type}`,
        url,
      ],
      { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          resolve({ ok: false, reason: `curl failed: ${String(stderr || error.message).trim().split('\n')[0]}` });
          return;
        }
        const ctAt = stdout.lastIndexOf('\n__CT__');
        const contentType = ctAt === -1 ? '' : stdout.slice(ctAt + 7).trim();
        const rest = ctAt === -1 ? stdout : stdout.slice(0, ctAt);
        const at = rest.lastIndexOf(STATUS_SENTINEL);
        if (at === -1) { resolve({ ok: false, reason: 'curl produced no status line' }); return; }
        const status = Number.parseInt(rest.slice(at + STATUS_SENTINEL.length).trim(), 10);
        resolve({ ok: status === 200, status, contentType, text: rest.slice(0, at), reason: status === 200 ? null : `HTTP ${status}` });
      },
    );
  });
}

/** The active-EQUITY scrip master, in one request (~1.7 MB). 4,975 scrips. */
export const SCRIP_MASTER_URL =
  `${API}/ListofScripData/w?Group=&Scripcode=&industry=&segment=Equity&status=Active`;

/**
 * The whole active scrip master, every instrument class. 12,685 scrips.
 *
 * ---------------------------------------------------------------------------
 * THIS URL RELIES ON AN UNRECOGNISED `segment` VALUE, AND THAT IS DELIBERATE
 * ---------------------------------------------------------------------------
 * Measured 20 Aug 2026 against ListofScripData with `status=Active`:
 *
 *     segment=Equity          ->  4,975 rows
 *     segment=ETF             ->    264 rows
 *     segment=<empty>         ->      0 rows
 *     segment=<anything else> -> 12,685 rows   (InvIT, REIT, Debt, Hybrid, …
 *                                               every value tried returned the
 *                                               same complete set)
 *
 * So BSE recognises exactly two filters and falls through to EVERYTHING for any
 * value it does not know. That is a trap in both directions: a typo silently
 * widens the universe, and a future release that starts honouring the value
 * would silently narrow it to nothing.
 *
 * `ALL_SEGMENTS` is therefore not a value BSE documents — it is a sentinel
 * chosen to be obviously not a real segment, and fetch-bse-master.mjs ASSERTS
 * that what comes back is a strict superset of the equity request. If BSE ever
 * starts treating it as a filter, that assertion fails loudly instead of the
 * universe quietly losing 12,000 scrips.
 *
 * The reason we need it at all: REITs and InvITs sit in `GROUP: "IF"` and BSE's
 * `segment=Equity` filter excludes all 27 of them — including Embassy Office
 * Parks, Mindspace, Nexus Select and Brookfield India, which the iShares funds
 * hold. BSE publishes MktCapFull and MktCapFF for every one; nothing was asking.
 */
export const SCRIP_MASTER_ALL_URL =
  `${API}/ListofScripData/w?Group=&Scripcode=&industry=&segment=ALL_SEGMENTS&status=Active`;

/** Free float and full market cap for one scrip. Carries MktCapFull / MktCapFF. */
export const stockTradingUrl = (scripCode) =>
  `${API}/StockTrading/w?flag=&quotetype=EQ&scripcode=${encodeURIComponent(scripCode)}`;

/** Last traded price for one scrip, from the same source as the market caps. */
export const scripHeaderUrl = (scripCode) =>
  `${API}/getScripHeaderData/w?Debtflag=&scripcode=${encodeURIComponent(scripCode)}&seriesid=`;

/** ISIN, sector and BSE's own security id for one scrip. */
export const comHeaderUrl = (scripCode) =>
  `${API}/ComHeader/w?quotetype=EQ&scripcode=${encodeURIComponent(scripCode)}&seriesid=`;

/**
 * Run `worker` over `items` with a hard concurrency cap and a gap between
 * request starts.
 *
 * Capped deliberately. BSE tolerates far more than this, but it is somebody
 * else's free service and this job runs monthly — there is no reason to lean
 * on it. `onProgress` is called after each item so a long run can show a
 * heartbeat rather than sitting silent for ten minutes.
 */
export async function pooled(items, worker, { concurrency = 4, gapMs = 60, onProgress } = {}) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;

  const runner = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
      results[index] = await worker(items[index], index);
      done += 1;
      if (onProgress) onProgress(done, items.length, results[index]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runner()),
  );
  return results;
}
