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
    },
    {
      id: 'nse',
      label: 'NSE pre-open session',
      raw: asOf.nseSession ?? null,
      detail: "NSE's own session timestamp, carried verbatim — when NSE struck the prices",
    },
    {
      id: 'bse',
      label: 'BSE free-float scrape',
      raw: asOf.bseCapturedAt ?? null,
      detail: 'when we fetched BSE market caps and prices',
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
      status: byId.bse?.raw ? 'ok' : 'missing',
      count: cov.floatFromBse ?? null,
      countLabel: 'companies whose float reading is BSE’s',
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
