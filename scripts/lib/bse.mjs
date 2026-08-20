/**
 * BSE India API client and number parser. Zero dependencies.
 *
 * BSE's `api.bseindia.com` has no bot protection: a browser User-Agent and a
 * `referer: https://www.bseindia.com/` header are enough. No cookie warming, no
 * TLS fingerprinting, no throttling observed. It is the opposite of NSE in
 * every respect, and it is the only source that covers the whole listed
 * universe rather than 261 names.
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

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const REFERER = 'https://www.bseindia.com/';
const API = 'https://api.bseindia.com/BseIndiaAPI/api';

/** ₹1 crore in rupees. Mirrors public/js/config/thresholds.mjs, which owns the
 *  constant for anything that renders; this copy keeps the lib importable by
 *  scripts with no config dependency. */
const RUPEES_PER_CRORE = 1e7;

/**
 * A number written with Indian (or Western) digit grouping, as a plain number.
 *
 * Accepts:  "1,769,379.44"  "17,69,379.44"  "156812.20"  "0.4926"  "7.72"
 * Rejects:  "-"  ""  "N.A."  "1,2,3,4"  "12.3.4"  null  undefined  NaN inputs
 *
 * Returns `null` for anything it does not fully understand. Never guesses,
 * never partially parses. A `null` here means "no reading", which is a
 * different fact from zero and must stay different all the way to the screen.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseGroupedNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') return null;

  const text = value.trim();
  if (text === '' || text === '-' || text === '--') return null;

  // The whole string must be a number: optional sign, digit groups separated by
  // single commas, optional single decimal part. Anything else is not a number
  // we are willing to guess at.
  if (!/^-?\d{1,3}(,\d{2,3})*(\.\d+)?$/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) {
    return null;
  }

  const stripped = text.replace(/,/g, '');
  // Number(), not parseFloat(): Number("8,71,532.61") is NaN, which we can
  // detect. parseFloat("8,71,532.61") is 8, which we cannot.
  const parsed = Number(stripped);
  return Number.isFinite(parsed) ? parsed : null;
}

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
        '-H', `referer: ${REFERER}`,
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
