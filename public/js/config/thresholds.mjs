/**
 * Every threshold this project uses. One module, no exceptions.
 *
 * ---------------------------------------------------------------------------
 * THESE ARE THE DESK'S HEURISTICS. MSCI DOES NOT PUBLISH THEM.
 * ---------------------------------------------------------------------------
 * MSCI derives its size cut-offs globally at each quarterly review from the
 * investable universe of the day; the rupee figures below are a rule of thumb
 * that has worked for this desk. They are useful. They are not the rule, and
 * nothing in this codebase may print them as though MSCI published them.
 *
 * Any screen that uses one of these must say so in words the reader will see —
 * "the desk's cut-off, not MSCI's published rule". See CLAUDE.md §2.2.
 *
 * Values live here as RUPEES because every monetary field in this project is
 * rupees. The `Cr` helpers exist so the numbers can be *written* the way the
 * desk says them out loud without a hand-typed 1e7 anywhere.
 */

/** ₹1 crore = 10,000,000 rupees. The only place this constant is written. */
export const RUPEES_PER_CRORE = 1e7;

/** Crore -> rupees. */
export const crore = (value) => value * RUPEES_PER_CRORE;

/** Rupees -> crore, for display only. */
export const toCrore = (rupees) => rupees / RUPEES_PER_CRORE;

/**
 * Free-float market cap bands the desk works to for the quarterly MSCI review.
 *
 * Source: the desk's own experience of past reviews, not an MSCI publication.
 * The desk quotes inclusion as "roughly ₹3,500–4,000 Cr" and exclusion as
 * "below ₹2,000–2,400 Cr", so both are ranges, not points. Anything that
 * renders a single number from these must show the band it came from.
 */
export const REVIEW_THRESHOLDS = {
  attribution:
    "the desk's own heuristic from past MSCI reviews — MSCI does not publish these cut-offs",

  inclusion: {
    /** Below this, the desk does not consider a name an inclusion candidate. */
    lowInr: crore(3500),
    /** Above this, the desk treats inclusion as materially likely. */
    highInr: crore(4000),
    label: '₹3,500–4,000 Cr free-float market cap',
  },

  exclusion: {
    /** Below this, the desk treats exclusion as materially likely. */
    lowInr: crore(2000),
    /** Above this, the desk stops worrying about exclusion. */
    highInr: crore(2400),
    label: '₹2,000–2,400 Cr free-float market cap',
  },
};

/**
 * The universe we bother to price at all.
 *
 * Set to the bottom of the desk's exclusion band: a company below this is not
 * an inclusion candidate and is already out of the exclusion conversation, so
 * spending a request on it every month buys nothing. This selects the scrips
 * `scripts/scrape-bse-freefloat.mjs` fetches, on top of everything the funds
 * actually hold (which is always fetched regardless of size — a name the funds
 * hold is in scope no matter how small it has become).
 *
 * NOTE: applied to FULL market cap from the BSE scrip master, because that is
 * what is available before any per-scrip request is made. The desk's band is
 * about FREE-FLOAT market cap, so this filter is deliberately looser than the
 * band it is derived from — it must never exclude a company that could clear
 * the free-float test, and full mcap >= free-float mcap always.
 */
/**
 * Floating the desk's rupee bands by how far the segment itself has moved.
 *
 * ---------------------------------------------------------------------------
 * WHY A FIXED RUPEE BAND IS THE WRONG SHAPE
 * ---------------------------------------------------------------------------
 * The desk works to ₹3,500–4,000 Cr for inclusion and ₹2,000–2,400 Cr for
 * exclusion. Those are ABSOLUTE figures. MSCI's real cut-offs are not: they are
 * derived at each review from the investable universe, so they rise with a
 * rising market and fall with a falling one.
 *
 * The consequence is directional and it applies to every company at once. In a
 * segment that rose 12%, a fixed band OVER-CALLS inclusions — companies clear a
 * bar that has itself moved up. In a segment that fell, it under-calls.
 *
 * So the band is multiplied by the segment's own price return since the last
 * review's effective date, measured from the fund that tracks that segment:
 *
 *     adjustedBand = band × (1 + segmentReturnSinceLastReview)
 *
 * Both the raw band and the adjusted one are recorded on every rule that uses
 * them, so a reader can see exactly how much the adjustment moved the bar and
 * what the verdict would have been without it.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS AND IS NOT
 * ---------------------------------------------------------------------------
 * It is an APPROXIMATION and the desk's own, on two counts. MSCI derives its
 * cut-offs from the whole investable universe rather than from one segment, and
 * the proxy is an ETF rather than the index — an ETF carries tracking error and
 * trades at a premium or discount to NAV. Directionally it is right and the
 * magnitude is close; it is not MSCI's arithmetic and must never be shown as if
 * it were.
 *
 * The return is measured in RUPEES. The funds quote in dollars, and over a year
 * to 20 Aug 2026 that difference was 9 to 13 percentage points — enough to flip
 * SMIN's sign from -3.62% to +5.44%. See public/js/model/benchmarks.js.
 *
 * Set `enabled: false` to fall back to the raw bands. Every rule keeps both
 * numbers either way, so nothing downstream has to change to compare them.
 */
export const SEGMENT_BAND_ADJUSTMENT = {
  enabled: true,
  basis: "the tracking fund's price return in rupees since the last review's effective date",
  attribution: "the desk's own adjustment. MSCI derives its size cut-offs from the investable "
    + 'universe at each review and does not publish them; this floats a fixed rupee band by a '
    + 'measured segment move, using an ETF as a proxy for the index it tracks.',
  /**
   * Which benchmark's basket stands in for each segment.
   *
   * ⚠ THESE ARE INDEX IDS, NOT FUND IDS, AND THE DIFFERENCE IS THE WHOLE POINT.
   *
   * `standard` was `eem` and that was a category error. EEM is the fund that
   * HOLDS India's Standard names, so it is right for their flows — but it is
   * ~11% India, so its return is mostly a statement about somewhere else, while
   * Standard/Small Cap migration is decided by ranking Indian companies inside
   * MSCI India. Measured since the last review (2026-05-29) with the corrected
   * FX dates, the two disagree in SIGN:
   *
   *     EEM   -2.077%   ->  the segment shrank,  bands float DOWN
   *     INDA  +1.341%   ->  the segment grew,    bands float UP
   *
   * Both clear minMovePct, so both were live — the old mapping was floating
   * every Standard constituent's band the wrong way. Over a year the gap is
   * 44.3 pp, and against EEM 149 of 164 Standard constituents "underperform" by
   * a median of 43.7 pp: wrong in the same direction for every company, which
   * is the failure a segment benchmark exists to prevent.
   *
   * `outside` uses the India small-cap fund because a company entering the index
   * enters MSCI India Small Cap, so that is the bar it has to clear.
   */
  benchmarkForSegment: { standard: 'inda', smallcap: 'smin', outside: 'smin' },
  /**
   * Below this the adjustment is recorded but not applied. A segment that moved
   * a fraction of a percent since the last review cannot meaningfully have moved
   * MSCI's cut-off, and applying it would churn verdicts on noise.
   */
  minMovePct: 1,
};

/**
 * The market-cap buckets the screener's size filter offers.
 *
 * ---------------------------------------------------------------------------
 * THESE ARE NOT THE REVIEW CUT-OFFS ABOVE, AND MUST NEVER BE SHOWN AS THEM.
 * ---------------------------------------------------------------------------
 * `REVIEW_THRESHOLDS` are the desk's inclusion/exclusion bands, they are about
 * FREE-FLOAT market cap, and they drive verdicts. These are plain FULL market
 * cap ranges chosen to slice the whole tracked universe into readable groups —
 * they decide nothing, they are a navigation aid, and no rule reads them.
 *
 * Boundaries are the desk's, picked to be round numbers a manager already
 * thinks in. Nobody published them and nothing about them is a judgement.
 *
 * `maxCr: null` means the top band is open-ended, so the set covers every
 * company that has a full market cap at all. A company with NO reading is not
 * placed in a band — see CLAUDE.md 2.3; missing is never zero, and a company
 * with no market cap is not a small one.
 */
export const MARKET_CAP_FILTER_BANDS = [
  { id: 'mcap-0-10k', minCr: null, maxCr: 10000 },
  { id: 'mcap-10k-30k', minCr: 10000, maxCr: 30000 },
  { id: 'mcap-30k-70k', minCr: 30000, maxCr: 70000 },
  { id: 'mcap-70k-200k', minCr: 70000, maxCr: 200000 },
  { id: 'mcap-200k-up', minCr: 200000, maxCr: null },
].map((band) => ({
  ...band,
  // Rupees, because every monetary field in this project is rupees. Derived
  // from the crore figure above so the two cannot drift apart.
  minInr: band.minCr === null ? null : crore(band.minCr),
  maxInr: band.maxCr === null ? null : crore(band.maxCr),
}));

/** What the market-cap filter must disclose about itself, in words. */
export const MARKET_CAP_FILTER_ATTRIBUTION =
  'Full market cap, as published by BSE for the company as a whole — not free float, and not '
  + "the desk's review bands. These ranges only group the universe for reading; no verdict uses them.";

export const SCRAPE_UNIVERSE_MIN_FULL_MCAP_INR = REVIEW_THRESHOLDS.exclusion.lowInr;

/**
 * How far NSE and BSE may disagree on a company's float factor before we treat
 * the gap as something other than a definitional difference.
 *
 * The two exchanges apply slightly different float definitions and a gap of
 * around 1% is expected and normal (RELIANCE: 0.4978 NSE vs 0.4926 BSE).
 * Beyond this, a human should look: it is more likely a stale share count, a
 * corporate action one exchange has processed and the other has not, or a
 * mis-resolved company than a genuine definitional gap.
 *
 * The desk's number, chosen to be loose enough not to cry wolf. Not a
 * published tolerance from anybody.
 */
export const FLOAT_FACTOR_DISAGREEMENT_REVIEW_PCT = 5;

/**
 * How far NSE and BSE must disagree before NSE's float factor is used instead
 * of BSE's.
 *
 * The desk's instruction, and the desk's number:
 *
 *     "Keep BSE as the primary source. Then look for all the companies in NSE.
 *      In case there is over 2% difference between the BSE and NSE data point,
 *      prefer NSE's data, otherwise let it be BSE. Whatever companies are not
 *      listed on BSE, keep NSE as the source."
 *
 * The reasoning behind it, which is the desk's and not MSCI's: BSE covers
 * essentially the whole listed universe and NSE publishes free float for only
 * ~250 names, so BSE is the only source that can carry the screen at all. But
 * where the two MATERIALLY disagree the desk trusts NSE, because MSCI is
 * understood to follow NSE. Below the gap, the difference is definitional noise
 * (RELIANCE sits about 1% apart) and switching source for it would churn the
 * record without changing any decision.
 *
 * MEASURED CONSEQUENCE, on the committed data at the time this was set: of 206
 * companies carrying both readings, 24 exceed 2% and take NSE's factor; the
 * other 182 keep BSE's. The median gap is 0.071%.
 *
 * NOT a published tolerance from either exchange, from MSCI, or from anybody
 * else. It is a desk rule and every screen that acts on it must say so.
 *
 * Compared as |NSE − BSE| / BSE — relative to BSE because BSE is the primary
 * and the question is how far NSE departs from it.
 */
export const FLOAT_SOURCE_PREFER_NSE_GAP_PCT = 2;

/**
 * How the float source is chosen, in words, for anything that has to disclose
 * the rule on screen or in row 1 of an export. Kept beside the number so the
 * two cannot drift apart.
 */
export const FLOAT_SOURCE_RULE = {
  primary: 'bse',
  preferNseAboveGapPct: FLOAT_SOURCE_PREFER_NSE_GAP_PCT,
  label: "BSE is primary; NSE is used where the two differ by more than 2%, and "
    + 'wherever BSE has no reading at all',
  attribution: "the desk's rule, not a published methodology from either exchange or from MSCI",
};
