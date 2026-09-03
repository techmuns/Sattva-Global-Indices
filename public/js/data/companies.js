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
 * The NSE Additional Surveillance Measure metadata block.
 *
 * `available` is the load-bearing field: a company's null `asm` means NOT UNDER
 * ASM when it is true, and UNKNOWN when it is false (the feed did not load). A
 * caller must consult it before rendering a null as "clear", or an outage would
 * paint every company as unflagged — the §2.4 lie. `null` only before load.
 */
export const asm = () => requireLoaded().asm ?? null;

/**
 * How each fund's own basket has moved, and the band adjustment derived from it.
 *
 * `null` when fund-benchmarks.json was not built — the bands then stand raw and
 * every rule says so, rather than an unadjusted band being shown as adjusted.
 */
export const benchmarks = () => requireLoaded().benchmarks ?? null;

/**
 * The two review windows the relative-performance reading is measured across,
 * plus the band and the attribution. Null when the price history or the
 * corporate-action history is absent — in which case every reading is a stated
 * absence rather than some readings and some silence.
 */
export const relativeWindow = () => requireLoaded().relativePerformance ?? null;

/**
 * The rebalance-date baselines: which one is in force by default, every one the
 * reader may switch to, and the band and attribution behind the reading.
 *
 * ⚠ A DIFFERENT WINDOW FROM `relativeWindow()` ABOVE. That one is measured
 * across MSCI's ten-day PRICE windows; this one from the day each review took
 * EFFECT. Six weeks apart at the near end, and on the committed record the two
 * disagree about the SIGN for 27.8% of companies. Neither is a noisier version
 * of the other, and no caller may substitute one for the other.
 */
export const rebalanceBaselines = () => requireLoaded().sinceRebalance ?? null;

/* ────────────────────────────────────────────────────────────────────────────
 * The alternate baselines, fetched only if a reader asks for one
 * ──────────────────────────────────────────────────────────────────────────── */

const baselineCache = new Map();     // review -> Map(companyKey -> reading)
let baselineFilePromise = null;

/**
 * Load public/data/relative-baselines.json, once.
 *
 * It is 1.2 MB and answers a question most readers never ask, so it is NOT in
 * companies.json and NOT fetched at startup. The default baseline's reading
 * rides on every company record and paints on first load; this is only reached
 * when the reader re-bases the screen.
 */
async function loadBaselineFile() {
  if (baselineFilePromise) return baselineFilePromise;
  baselineFilePromise = (async () => {
    const response = await fetch('data/relative-baselines.json', { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`relative-baselines.json responded ${response.status} ${response.statusText}`);
    }
    const json = await response.json();
    if (!json?.readings) throw new Error('relative-baselines.json carried no readings');
    for (const [review, byKey] of Object.entries(json.readings)) {
      baselineCache.set(review, new Map(Object.entries(byKey)));
    }
    return json;
  })();
  return baselineFilePromise;
}

/**
 * Make a baseline available for synchronous reading by `readingFor` below.
 *
 * The default one is already inline, so it resolves without a fetch. Any other
 * pulls the file once. A failure REJECTS rather than resolving empty: a screen
 * that silently kept the old baseline's numbers under a new baseline's heading
 * would be the worst possible outcome here.
 */
export async function ensureBaseline(review) {
  const context = rebalanceBaselines();
  if (!context) return false;
  if (review === context.defaultReview) return true;
  await loadBaselineFile();
  return baselineCache.has(review);
}

/**
 * One company's reading under the baseline in force.
 *
 * Returns `undefined` — distinct from `null` — when the baseline has not been
 * loaded yet, so a caller can tell "not fetched" from "no reading for this
 * company". Rendering the second as the first is how a loading state becomes a
 * statement about a company.
 */
export function readingFor(company, review) {
  const context = rebalanceBaselines();
  if (!context) return null;
  if (!review || review === context.defaultReview) return company.sinceRebalance ?? null;
  const byKey = baselineCache.get(review);
  if (!byKey) return undefined;
  return byKey.get(keyOf(company)) ?? null;
}

/** The descriptor for one baseline: its label, effective date and span. */
export function baselineMeta(review) {
  return rebalanceBaselines()?.baselines?.find((b) => b.review === review) ?? null;
}

/**
 * The three as-of dates, each labelled, plus which one governs.
 *
 * THEY ARE NOT COLLAPSED INTO ONE "UPDATED" TIME. They are three independent
 * measurements taken at three different moments; averaging them or showing only
 * the newest would claim the page is fresher than its oldest input. The oldest
 * is what actually governs how current the screen is, and it is named.
 */
/**
 * The feed registry, as a pure function of the record's own `asOf` block.
 *
 * Split out of `freshness()` so a verifier can run it against a committed file
 * without loading the browser's data module — a registry nothing can test
 * against the record is how a feed goes missing from it for a week.
 */
export function feedRegistry(asOf = {}) {
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
    // ⚠ THESE TWO WERE MISSING, AND THEY ARE THE STALE ONES.
    //
    // freshness().oldest is what the export banner prints as "the oldest of
    // these governs how current this file is", and it was computed over four
    // feeds that did not include either input the relative-performance column
    // depends on. Measured the day they were added: quote-stats 19 Aug,
    // fund-benchmarks 21 Aug, prices 27 Aug — so a workbook carrying a column
    // measured to 19 August was stamped with a freshness governed by the 27th.
    //
    // The benchmark feed is the sharper case. It is a soft step in the daily
    // refresh, and it went unwritten from 21 to 28 August while every run
    // reported green — an outage that was invisible on the one surface built to
    // make outages visible. A soft-failing step whose staleness nothing tracks
    // is exactly how an outage becomes an absence.
    {
      id: 'benchmarks',
      label: 'Segment benchmark closes',
      raw: asOf.benchmarksAsOf ?? null,
      detail: 'the newest close across the benchmark series — Yahoo, and the ETF rather than the index',
      // Attempted daily and allowed to fail so a Yahoo outage cannot stop the
      // exchange pipeline behind it. Past about three days the bands are being
      // floated by a segment move that is no longer current.
      cadence: 'attempted every trading day, allowed to fail',
      staleAfterDays: 3,
    },
    {
      id: 'quote-stats',
      label: 'Munshot quote statistics',
      raw: asOf.quoteStatsCapturedAt ?? null,
      detail: 'average daily volume and corporate-action flags, captured monthly from a rate-limited third party',
      cadence: 'monthly, on the 1st',
      staleAfterDays: 40,
    },
    // The two reference feeds. They decide WHO IS IN the universe and how a
    // holding row reaches an ISIN, so a stale one does not show as a wrong
    // number — it shows as a company that is simply not there. That is the
    // harder failure to notice, which is the argument for registering them.
    {
      id: 'bse-master',
      label: 'BSE scrip master',
      raw: asOf.bseScripMasterCapturedAt ?? null,
      detail: 'the active-equity scrip list the whole scrape universe is built from — a code not in it is never fetched',
      cadence: 'every trading day',
      staleAfterDays: 4,
    },
    {
      id: 'nse-universe',
      label: 'NSE index universe',
      raw: asOf.nseUniverseCapturedAt ?? null,
      detail: 'the ISIN-to-NSE-symbol bridge from niftyindices — the only thing an NSE symbol is ever asserted from',
      cadence: 'every trading day, guaranteed weekly',
      staleAfterDays: 9,
    },
    {
      id: 'asm',
      label: 'NSE ASM list',
      raw: asOf.asmAsOf ?? null,
      detail: "NSE's published Additional Surveillance Measure stages — the date NSE says the list took effect",
      // Attempted daily and allowed to fail, like every NSE feed: the edge
      // throttles a datacentre IP unpredictably (§3.7). Past about a fortnight a
      // surveillance stage on screen may name a stock that has since moved off
      // the list — a stale flag is worth surfacing.
      cadence: 'attempted every trading day, guaranteed weekly',
      staleAfterDays: 12,
    },
  ];
  return feeds.map((feed) => ({ ...feed, date: parseFeedDate(feed.raw) }));
}

export function freshness() {
  const asOf = requireLoaded().asOf ?? {};
  const feeds = feedRegistry(asOf);

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
      cadence: byId['nse-universe']?.cadence ?? null,
      staleAfterDays: byId['nse-universe']?.staleAfterDays ?? null,
      status: meta.nseUniverseCapturedAt ? 'ok' : 'missing',
      count: null,
      countLabel: null,
    },
    {
      id: 'bse-master',
      name: 'BSE scrip master',
      publisher: 'BSE Ltd',
      what:
        'The active-equity scrip list. Every scrape universe is built from it and nothing is ever fetched '
        + 'for a code that is not in it — which is the only thing standing between this project and a '
        + 'delisted company\'s frozen figures, because BSE answers for those as though nothing happened.',
      tier: 'measured',
      asOf: meta.bseScripMasterCapturedAt ?? null,
      asOfDate: parseFeedDate(meta.bseScripMasterCapturedAt ?? null),
      cadence: byId['bse-master']?.cadence ?? null,
      staleAfterDays: byId['bse-master']?.staleAfterDays ?? null,
      status: meta.bseScripMasterCapturedAt ? 'ok' : 'missing',
      count: requireLoaded().coverage?.scripMasterCount ?? null,
      countLabel: 'active equity scrips',
    },
    {
      id: 'benchmarks',
      name: 'Segment benchmark closes',
      publisher: 'Yahoo Finance',
      what:
        'Daily closes for EEM, SMIN, EEMS and INDA, plus USDINR. THE ETF, NOT THE INDEX — an ETF carries '
        + 'tracking error and trades at a premium or discount, and MSCI index levels are licensed. The '
        + 'funds quote in dollars, so every figure derived here is converted to rupees with both halves '
        + 'of each product struck on the same date.',
      tier: 'measured',
      asOf: meta.benchmarksAsOf ?? null,
      asOfDate: parseFeedDate(meta.benchmarksAsOf ?? null),
      cadence: byId.benchmarks?.cadence ?? null,
      staleAfterDays: byId.benchmarks?.staleAfterDays ?? null,
      status: meta.benchmarksAsOf ? 'ok' : 'missing',
      count: requireLoaded().benchmarks?.funds?.length ?? null,
      countLabel: 'benchmark series',
    },
    {
      id: 'quote-stats',
      name: 'Munshot quote statistics',
      publisher: 'fastapi.muns.io — Yahoo Finance NSE data',
      what:
        'Average daily volume, used to express a modelled flow in days of trading. Captured monthly from a '
        + 'rate-limited third party, so it is the feed most likely to be the oldest thing on the page.',
      tier: 'measured',
      asOf: meta.quoteStatsCapturedAt ?? null,
      asOfDate: parseFeedDate(meta.quoteStatsCapturedAt ?? null),
      cadence: byId['quote-stats']?.cadence ?? null,
      staleAfterDays: byId['quote-stats']?.staleAfterDays ?? null,
      status: meta.quoteStatsCapturedAt ? 'ok' : 'missing',
      count: requireLoaded().quoteStats?.companyCount ?? null,
      countLabel: 'companies with a statistics row',
    },
    {
      id: 'asm',
      name: 'NSE Additional Surveillance Measure',
      publisher: 'National Stock Exchange of India',
      what:
        'The published list of securities under Additional Surveillance Measure, with the surveillance '
        + 'stage for each — carried through unchanged and joined to the universe by ISIN. dhan.co/nse-asm-list '
        + 'mirrors this same NSE feed. A company not on the list is NOT under ASM; when the feed is '
        + 'unavailable the stage is unknown, never silently "clear".',
      tier: 'measured',
      asOf: meta.asmAsOf ?? null,
      asOfDate: parseFeedDate(meta.asmAsOf ?? null),
      cadence: byId.asm?.cadence ?? null,
      staleAfterDays: byId.asm?.staleAfterDays ?? null,
      status: asm()?.available ? 'ok' : 'missing',
      count: asm()?.flaggedInUniverse ?? null,
      countLabel: 'tracked companies under ASM',
    },
  ];
}
