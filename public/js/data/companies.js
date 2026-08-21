/**
 * The single reader of public/data/companies.json.
 *
 * Loads once, indexes once, and is the ONLY place a count may come from.
 * Nothing in the interface may hand-type a figure: every denominator on screen
 * traces back to `coverage()` here, which reads the `coverage` block the build
 * script computed from the data. A hand-typed "1,202" is a bug waiting for the
 * next refresh.
 *
 * A count this module cannot establish is `null`, never `0` — callers are
 * expected to drop the clause rather than render "0 companies".
 */

import { parseFeedDate } from '../core/format.js';

let payload = null;
let byIsinIndex = null;
let loadPromise = null;

/** Stable identity for a row. ISIN where there is one; the BSE scrip otherwise. */
export const keyOf = (company) => company.isin ?? `bse:${company.bseScripCode}`;

export const FUND_IDS = ['eem', 'smin', 'eems'];

export async function load() {
  if (payload) return payload;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const response = await fetch('data/companies.json', { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`companies.json responded ${response.status} ${response.statusText}`);
    }
    const json = await response.json();
    if (!Array.isArray(json?.companies)) {
      throw new Error('companies.json carried no companies array');
    }
    payload = json;
    byIsinIndex = new Map();
    for (const company of json.companies) {
      const key = keyOf(company);
      // A duplicate key would silently overwrite a company. It cannot happen —
      // the build fails on ISIN collisions — but this is the last place the
      // assumption is cheap to check, and the drill panel keys on it.
      if (byIsinIndex.has(key)) {
        console.error(`[companies] duplicate key ${key}; the build should have refused this`);
      }
      byIsinIndex.set(key, company);
    }
    return payload;
  })();

  return loadPromise;
}

const requireLoaded = () => {
  if (!payload) throw new Error('companies data has not been loaded yet');
  return payload;
};

export const all = () => requireLoaded().companies;
export const byIsin = (key) => (byIsinIndex ? byIsinIndex.get(key) ?? null : null);
export const unresolved = () => requireLoaded().unresolved ?? [];

/**
 * `held`  — companies at least one fund owns: what must be traded if weights move.
 * `all`   — every company in the record: constituents plus inclusion candidates.
 */
export function forScope(scope) {
  const companies = all();
  return scope === 'all' ? companies : companies.filter((c) => c.held);
}

export const coverage = () => requireLoaded().coverage ?? {};

/** Per-fund coverage, with the fund's own short name. Never summed across funds. */
export function fundCoverage(fundId) {
  return coverage().byFund?.[fundId] ?? null;
}

export const fundShortName = (fundId) =>
  fundCoverage(fundId)?.shortName ?? fundId.toUpperCase();

export const thresholds = () => requireLoaded().thresholds ?? {};
export const priceMeta = () => requireLoaded().prices ?? {};
export const flowPrimitives = () => requireLoaded().flowPrimitives ?? {};
export const disagreement = () => requireLoaded().floatFactorDisagreement ?? {};

/**
 * The three as-of dates, each labelled, plus which one governs.
 *
 * THEY ARE NOT COLLAPSED INTO ONE "UPDATED" TIME. They are three independent
 * measurements taken at three different moments; averaging them or showing only
 * the newest would claim the page is fresher than its oldest input. The oldest
 * is what actually governs how current the screen is, and it is named.
 */
export function freshness() {
  const asOf = requireLoaded().asOf ?? {};
  const feeds = [
    {
      id: 'ishares',
      label: 'iShares holdings',
      raw: asOf.isharesHoldings ?? null,
      detail: "BlackRock's published fund holdings, as of the workbook's own date",
      // Each feed is refreshed on its own cadence, so one staleness threshold
      // cannot serve them all. `staleAfterDays` is the point past which THIS
      // feed being unchanged means something went wrong rather than nothing
      // moved. Every one is the desk's own number, not anybody's standard.
      cadence: 'replaced by hand when new workbooks are downloaded',
      staleAfterDays: 45,
    },
    {
      id: 'nse',
      label: 'NSE pre-open session',
      raw: asOf.nseSession ?? null,
      detail: "NSE's own session timestamp, carried verbatim — when NSE struck the prices",
      // Attempted daily and allowed to fail, because NSE's edge throttles a
      // datacentre IP unpredictably. Guaranteed weekly by a job that retries
      // three times and then fails loudly. Beyond about a fortnight the source
      // choice on the names where the two exchanges disagree is frozen on a
      // stale NSE figure, which is the thing worth flagging.
      cadence: 'attempted every trading day, guaranteed weekly',
      staleAfterDays: 12,
    },
    {
      id: 'bse',
      label: 'BSE free-float scrape',
      raw: asOf.bseCapturedAt ?? null,
      detail: 'when we fetched BSE market caps and share counts — every trading day, and never restamped because a price arrived',
      // The primary source. It runs every trading day, so more than a long
      // weekend without one means the job is broken.
      cadence: 'every trading day',
      staleAfterDays: 4,
    },
    {
      id: 'bhavcopy',
      label: 'BSE closing prices',
      raw: asOf.bhavcopyTradeDate ?? null,
      detail: "the exchange's own trade date for the committed end-of-day bhavcopy",
      cadence: 'every trading day',
      staleAfterDays: 4,
    },
  ].map((feed) => ({ ...feed, date: parseFeedDate(feed.raw) }));

  const dated = feeds.filter((f) => f.date);
  const oldest = dated.length
    ? dated.reduce((a, b) => (a.date.getTime() <= b.date.getTime() ? a : b))
    : null;

  return { feeds, oldest, meta: asOf };
}

/** Everything the sources modal needs, derived — no figure typed by hand. */
export function sourceRegistry() {
  const cov = coverage();
  const { feeds, meta } = freshness();
  const byId = Object.fromEntries(feeds.map((f) => [f.id, f]));

  return [
    {
      id: 'ishares',
      name: 'iShares fund holdings',
      publisher: 'BlackRock',
      what: 'Index weights, quantities and market values for three MSCI ETFs.',
      tier: 'measured',
      asOf: byId.ishares?.raw ?? null,
      asOfDate: byId.ishares?.date ?? null,
      // The cadence this feed is actually refreshed on, and the age past which
      // being unchanged means something broke rather than nothing moved.
      cadence: byId.ishares?.cadence ?? null,
      staleAfterDays: byId.ishares?.staleAfterDays ?? null,
      status: byId.ishares?.raw ? 'ok' : 'missing',
      count: cov.held ?? null,
      countLabel: 'companies held by at least one fund',
    },
    {
      id: 'nse',
      name: 'NSE pre-open market',
      publisher: 'National Stock Exchange of India',
      what: 'Free-float market cap as NSE publishes it. Not computed from promoter holding.',
      tier: 'measured',
      asOf: byId.nse?.raw ?? null,
      asOfDate: byId.nse?.date ?? null,
      // The cadence this feed is actually refreshed on, and the age past which
      // being unchanged means something broke rather than nothing moved.
      cadence: byId.nse?.cadence ?? null,
      staleAfterDays: byId.nse?.staleAfterDays ?? null,
      status: byId.nse?.raw ? 'ok' : 'missing',
      count: cov.floatFromNse ?? null,
      countLabel: 'companies whose float reading is NSE’s',
    },
    {
      id: 'bse',
      name: 'BSE free float',
      publisher: 'BSE Ltd',
      what: 'Full and free-float market cap per scrip, filling the gaps NSE does not cover.',
      tier: 'measured',
      asOf: byId.bse?.raw ?? null,
      asOfDate: byId.bse?.date ?? null,
      // The cadence this feed is actually refreshed on, and the age past which
      // being unchanged means something broke rather than nothing moved.
      cadence: byId.bse?.cadence ?? null,
      staleAfterDays: byId.bse?.staleAfterDays ?? null,
      status: byId.bse?.raw ? 'ok' : 'missing',
      count: cov.floatFromBse ?? null,
      countLabel: 'companies whose float reading is BSE’s',
    },
    {
      id: 'bhavcopy',
      name: 'BSE closing prices (bhavcopy)',
      publisher: 'BSE Ltd',
      what:
        'One end-of-day file for the whole market, committed to the repository. This is the floor: the '
        + 'site renders fully from it with no Worker and no network. A live NSE quote overlays it in memory only.',
      tier: 'measured',
      asOf: meta.bhavcopyTradeDate ?? null,
      asOfDate: parseFeedDate(meta.bhavcopyTradeDate ?? null),
      cadence: byId.bhavcopy?.cadence ?? null,
      staleAfterDays: byId.bhavcopy?.staleAfterDays ?? null,
      status: meta.bhavcopyTradeDate ? 'ok' : 'missing',
      count: requireLoaded().prices?.pricedCount ?? null,
      countLabel: 'scrips priced from this file',
    },
    {
      id: 'munshot',
      name: 'Munshot live quotes (NSE)',
      publisher: 'fastapi.muns.io — Yahoo Finance NSE data',
      what:
        'Intraday prices, fetched through our Worker so the token never reaches the browser. A DIFFERENT '
        + 'EXCHANGE from the committed baseline: a live figure is NSE-priced, the EOD figure is BSE-priced, '
        + 'and the two are never blended. Only during market hours, and only for companies with an asserted NSE symbol.',
      tier: 'measured',
      asOf: null,
      asOfDate: null,
      status: 'live',
      count: requireLoaded().coverage?.liveEligible ?? null,
      countLabel: 'companies a live quote can reach',
    },
    {
      id: 'nse-universe',
      name: 'NSE symbol ↔ ISIN map',
      publisher: 'niftyindices.com',
      what: 'The only source of an NSE symbol in this project. BSE scrip ids are never used as one.',
      tier: 'measured',
      asOf: meta.nseUniverseCapturedAt ?? null,
      asOfDate: parseFeedDate(meta.nseUniverseCapturedAt ?? null),
      status: meta.nseUniverseCapturedAt ? 'ok' : 'missing',
      count: null,
      countLabel: null,
    },
  ];
}
