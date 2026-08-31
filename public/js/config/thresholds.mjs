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
 * Relative performance — how a company moved against its segment, review window
 * to review window.
 *
 * ---------------------------------------------------------------------------
 * ⚠ THE BAND IS SET FROM A MEASUREMENT, NOT FROM A ROUND NUMBER
 * ---------------------------------------------------------------------------
 * MSCI's price cut-off is "one of the last 10 business days of the month before
 * the review month" and it does not publish WHICH. So the same quarter has 100
 * (from-day, to-day) pairs it could have meant, and they do not agree.
 *
 * Measured across all 1,177 companies with a reading, on the committed windows
 * 2026-04-17..04-30 and 2026-07-20..07-31:
 *
 *     envelope width   p10 8.30   MEDIAN 14.73   p75 21.03   p90 29.16   max 133.15
 *     envelope entirely one side of zero:  807 of 1,177  (68.6%)
 *
 * A first design proposed 5 pp and 10 pp. Both are below the median width of
 * their own input — a threshold smaller than the uncertainty of the thing it
 * bands produces state changes that are noise wearing a threshold's face.
 *
 * `bandPct` is therefore set AT the measured median. It is the desk's number in
 * the sense that the desk chose to sit at the median rather than at p75, and the
 * measurement it was chosen against is written above so the choice can be argued
 * with rather than merely accepted.
 *
 * The band alone is not the gate. A reading may only act when its WHOLE envelope
 * clears the band, so acting typically needs roughly 15 + half a width, or about
 * 22 pp.
 *
 * MEASURED CONSEQUENCE, against the observed rank cutoff the model actually uses
 * (Godrej Properties, ₹27,917 Cr): 198 of 1,177 readings are robust; of the 37
 * migration rows, 2; of the 42 companies within `nearBoundaryPct` of the cutoff,
 * 4 are robust and 2 point across a boundary their rank has not crossed.
 *
 * Those figures are reported on the surface rather than used to argue the band
 * down. A gate that admits almost nobody is a finding about how noisy a
 * ten-undisclosed-day window is, not a calibration failure to be tuned away.
 */
export const RELATIVE_PERFORMANCE = {
  enabled: true,
  basis: "the company's ten-day mean close across MSCI's price window, against the same ten days of "
    + "the segment benchmark in rupees, compared geometrically: (1 + stock) / (1 + index) - 1",
  attribution: "the desk's own reading. MSCI publishes neither the day it prices on nor any "
    + 'performance rule — this measures a window MSCI does publish and draws no conclusion MSCI '
    + 'would recognise.',
  /**
   * The measured median day-choice envelope width, in percentage points. Below
   * this a reading cannot be distinguished from a different choice of day.
   */
  bandPct: 15,
  /**
   * How close to the observed rank cutoff a company must sit before its trend is
   * read as approaching a boundary. The desk's number: outside this, a quarter's
   * move does not plausibly carry a company across before the next review.
   */
  nearBoundaryPct: 15,
  /**
   * Which benchmark stands for each segment. INDEX ids, not fund ids — see
   * SEGMENT_BAND_ADJUSTMENT above and the header of model/benchmarks.js on why
   * the fund that holds a stock is not the index that decides its segment.
   *
   * Kept separate from SEGMENT_BAND_ADJUSTMENT deliberately: one floats a rupee
   * band, the other differences two returns, and a future change to either must
   * not silently move the other.
   */
  benchmarkForSegment: { standard: 'inda', smallcap: 'smin', outside: 'smin' },
};

/**
 * What the screener's market-cap filter is, in words.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT A REVIEW CUT-OFF, AND MUST NEVER BE SHOWN AS ONE.
 * ---------------------------------------------------------------------------
 * `REVIEW_THRESHOLDS` are the desk's inclusion/exclusion bands, they are about
 * FREE-FLOAT market cap, and they drive verdicts. The filter is about plain
 * FULL market cap, it decides nothing, and no rule reads it.
 *
 * It used to be five fixed bands in a dropdown, and those bands lived here
 * because somebody had chosen the boundaries. They are gone (31 Aug 2026): the
 * reader now types the two ends, so there is no boundary left for this module
 * to own — only the disclosure of what the number being filtered actually is,
 * which still has exactly one home.
 *
 * A company with NO market-cap reading matches no range in either direction —
 * CLAUDE.md §2.3; missing is never zero, and a company we have not measured is
 * not a small one.
 */
export const MARKET_CAP_FILTER_ATTRIBUTION =
  'Full market cap, as published by BSE for the company as a whole — not free float, and not '
  + "the desk's review bands. The range only narrows what is listed; no verdict reads it.";

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
