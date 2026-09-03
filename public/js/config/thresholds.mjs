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
 * Relative performance measured from the REBALANCE DATE — the desk's baseline.
 *
 * ---------------------------------------------------------------------------
 * ⚠ THIS IS A DIFFERENT BASELINE FROM `RELATIVE_PERFORMANCE` ABOVE, ON PURPOSE
 * ---------------------------------------------------------------------------
 * `RELATIVE_PERFORMANCE` measures window to window: the ten days MSCI struck its
 * market caps in for one review against the ten days it struck them in for the
 * next. That is the window MSCI *decides* on, and it is the right window for a
 * forecast about MSCI's next decision.
 *
 * It is NOT the window the desk asked about. The desk's question is "how has
 * this stock done against the index since the last rebalance" — baselined on the
 * day the new composition took effect and every tracking fund actually traded.
 * For the May 2026 review those two dates are 17-30 April and 29 May: six weeks
 * apart, and a different number.
 *
 * Both ship. Neither is a noisier version of the other, and each says on screen
 * which window it measured.
 *
 * ---------------------------------------------------------------------------
 * A SINGLE DAY AT EACH END, AND WHY THERE IS NO TEN-DAY MEAN HERE
 * ---------------------------------------------------------------------------
 * The ten-day mean upstream exists because MSCI does not publish WHICH of its
 * ten price days it used, so no single day is privileged and the mean is the
 * only unbiased point estimate. That reasoning does not transfer: the rebalance
 * date is published and unambiguous. Averaging it with its neighbours would
 * baseline the reading on a window nobody asked for.
 *
 * So the point estimate is struck on the rebalance date itself. What replaces
 * the day-choice envelope is a SENSITIVITY test — if the baseline had been
 * struck a session or two either side, would the sign survive? That is a
 * fragility measure, not a redefinition of the baseline, and it is measured on
 * the baseline end only: the latest close is the newest fact, not a choice
 * anybody makes.
 */
export const REBALANCE_BASELINE = {
  enabled: true,
  basis: "the company's close on the rebalance date against its latest committed close, both from the "
    + 'BSE bhavcopy, compared with the segment benchmark struck on the SAME two dates in rupees: '
    + '(1 + stock) / (1 + index) - 1',
  attribution: "the desk's own reading, and the desk's own baseline. MSCI publishes the effective date "
    + 'of each review but no performance rule of any kind — this measures a window from a date MSCI '
    + 'does publish and draws no conclusion MSCI would recognise.',
  /**
   * Which review's effective date is the baseline by default.
   *
   * `null` means "the most recent review whose effective date has passed",
   * resolved against the newest session the exchange has served — never against
   * the clock, so a build does not depend on when it ran. Set an explicit
   * `'2026-05'` to pin it.
   */
  defaultReview: null,
  /**
   * How many past rebalance dates the reader may choose between.
   *
   * Bounded by the benchmark series, which carries two years of daily closes —
   * a baseline older than that has no index leg and would produce a column of
   * stated absences rather than a comparison.
   */
  offerCount: 4,
  /**
   * How many business days either side of the rebalance date the sensitivity
   * test sweeps. Five candidate baselines at +/-2, which is enough to show a
   * one-day print moving the answer and few enough to stay 20 extra bhavcopy
   * requests rather than 200.
   */
  sensitivityDays: 2,
  /**
   * How far the reading must clear zero before a DIRECTION is claimed, in
   * percentage points.
   *
   * ⚠ SET FROM THE MEASURED SENSITIVITY OF THIS READING, NOT FROM THE 15 pp
   * BAND ABOVE. That band is the median width of a 100-pair day-choice envelope
   * and is far too wide for a reading whose baseline date is published: it would
   * suppress almost every direction on a measurement that is not that uncertain.
   *
   * Measured across the committed record, over the five candidate baselines
   * either side of 29 May 2026:
   *
   *     sensitivity width  p10 1.56  MEDIAN 3.64  p75 5.66  p90 9.56  max 49.29 pp
   *     span entirely one side of zero:  1,084 of 1,193  (90.9%)
   *
   * That is a far more stable reading than the window one above, and for a
   * reason rather than by luck: the baseline date is published, so the only
   * uncertainty is a day or two of price noise rather than 100 undisclosed
   * (from-day, to-day) pairs. 90.9% against 68.6%.
   *
   * The band is set at 4 pp — the first whole number AT OR ABOVE the measured
   * median, on the same principle as the band above: a threshold below the
   * measured uncertainty of its own input produces state changes that are noise
   * wearing a threshold's face. As there, the band alone is not the gate — the
   * WHOLE sensitivity span must clear it.
   *
   * MEASURED CONSEQUENCE at 4 pp: 849 of 1,193 readings are robust (71.2%), and
   * 24 of the 39 migration rows. Reported, not tuned: this gate admits most
   * rows because this measurement genuinely is less uncertain, and the 15 pp
   * band above admits few because that one genuinely is more.
   */
  bandPct: 4,
  /**
   * Which benchmark stands for each segment. INDEX ids, not fund ids — the fund
   * that HOLDS a stock is not the index that decides its segment, and EEM is
   * about 11% India. Deliberately a separate object from the two above: a future
   * change to one must not silently move the others.
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

/**
 * ---------------------------------------------------------------------------
 * WHEN A COMPANY IS IN THE EM ETF *AND* A SMALL-CAP FUND
 * ---------------------------------------------------------------------------
 * CLAUDE.md §2.15 recorded the segments as strictly disjoint on the committed
 * holdings and said, in as many words, that a future holdings file breaking the
 * pattern would invalidate the derivation. The August 2026 files broke it, and
 * the two ways they broke it are different facts:
 *
 *   1. DIFFERENT DATES. EEM and SMIN were re-downloaded after the review took
 *      effect; EEMS was not. Laurus Labs shows in EEM (31 Aug) and in EEMS
 *      (17 Aug) because it migrated up and the older file has not caught up.
 *      Nothing is wrong with the funds; the record is comparing two moments.
 *
 *   2. SAME DATE, ONE SIDE A RESIDUE. Astral shows in EEM at 0.0002% ($0.08m)
 *      and in SMIN at 0.4387% ($3.40m), both files dated 31 Aug. That is what a
 *      migration LOOKS LIKE while the trade is still unwinding — a real, tiny,
 *      shrinking leg on the side being left.
 *
 * So the derivation gains one rule, and it is the desk's:
 *
 *   THE NEWEST FILE THAT NAMES THE COMPANY DECIDES ITS SEGMENT. Where the files
 *   are dated the same, the larger position by market value decides.
 *
 * Newer evidence beats older evidence; equally-dated evidence is settled by
 * where the money actually is. Both halves are recorded on the company, so a
 * reader sees the overlap rather than a segment that quietly picked a side.
 */
export const SEGMENT_OVERLAP = {
  /**
   * Below this share of the larger position, a same-dated second leg is read as
   * a residue being unwound rather than as a second membership.
   *
   * Measured on the 31 Aug 2026 files: Astral's EM leg is 2.4% of its small-cap
   * leg, and it is the only same-dated overlap in the record. 10% is the desk's
   * round number an order of magnitude above that — not a published tolerance,
   * and not MSCI's. It classifies an overlap; it never decides a segment, which
   * the rule above does on its own.
   */
  residualShareOfLargerPct: 10,
  rule: 'the newest file that names the company decides its segment; where the files share a date, '
    + 'the larger position by market value decides',
  attribution: "the desk's rule. MSCI publishes no such tie-break because MSCI's own segments "
    + 'are disjoint by construction — the overlap is an artefact of reading two tracking funds, '
    + 'captured at two moments, as evidence of one index.',
};

/**
 * ---------------------------------------------------------------------------
 * WHAT THE AUGUST 2026 REVIEW TAUGHT, AND WHAT WAS CHANGED BECAUSE OF IT
 * ---------------------------------------------------------------------------
 * The August 2026 review is the first outcome this project has ever had. The
 * frozen forecast (`predictions-2026-08.json`) named 166 companies as moving; 33
 * moved; 23 of the 166 were right. 13.9% precision, 69.7% recall.
 *
 * Diagnosed against the outcome, the errors were not mis-set numbers. They were
 * three CATEGORY errors — the model asking a different question from the one
 * MSCI answers — and each has a published correction:
 *
 *   1. ONE SIZE WHERE MSCI USES TWO. Verdicts were decided on free-float market
 *      cap alone. MSCI's size cutoff is a FULL market cap (GIMI p. 28) and free
 *      float enters through a SEPARATE minimum (p. 30). Measured over the
 *      review's 18 exits, full market cap separates better than free float
 *      (AUC 0.919 against 0.899) — and the two real migration-downs sat at
 *      −35.5% and −41.1% of the Standard cutoff on full market cap, comfortably
 *      inside MSCI's published −33.3% buffer, but at −31.6% and −31.7% on free
 *      float, where that same buffer misses BOTH. The buffer was never wrong;
 *      it was being applied to the wrong quantity.
 *
 *   2. NO HYSTERESIS. A single bright line predicted 39 migrations and 3
 *      happened. MSCI buffers migration asymmetrically — out below 2/3 of the
 *      cutoff, in above 1.5× it (pp. 44–45) — precisely so that a company
 *      drifting a few percent across a line does not trade.
 *
 *   3. NO FOREIGN INCLUSION FACTOR FLOOR. MSCI requires FIF ≥ 0.15 (pp. 21, 45).
 *      52 of the 1,239 companies carrying a float factor sit below it — the
 *      other 26 of 1,265 have no reading at all and are neither counted nor
 *      excluded (§2.3, §2.5) — and NOT ONE of the 52 is held by any fund, NOT
 *      ONE entered: LIC at 0.035, SBI Funds at 0.070, IDBI Bank at 0.052.
 *      Sixteen of them carried an inclusion verdict under the old rules, and
 *      inside the corrected model the floor removes 38 candidates at zero recall
 *      cost. The smallest actual entrant's factor is 0.225, half again above the
 *      floor, so it is not a bar the events came close to.
 *
 * ---------------------------------------------------------------------------
 * ⚠ AND THE CUTOFF THE RATIOS SCALE IS OURS, AND IT IS BIASED HIGH
 * ---------------------------------------------------------------------------
 * §2.26 recorded, of the coverage-walk cutoff, that landing inside MSCI's own
 * published reference range was corroboration. THAT DOES NOT CARRY OVER. The
 * rank-derived IMI cutoff is USD 998m against MSCI's published EM IMI Global
 * Minimum Size Range of USD 309–710m (pp. 24, 26) — 1.41x above the top.
 *
 * The reason is in the derivation: the constituent count comes from three
 * iShares funds that SAMPLE rather than replicate, so it under-states MSCI's
 * real India IMI membership and the Nth company by full market cap is therefore
 * bigger than MSCI's own cutoff. `model.sizeCutoffReference` computes the
 * comparison on every build so it cannot go stale, and verify-data 46 fails if
 * it is dropped.
 *
 * ---------------------------------------------------------------------------
 * ⚠ NOT ONE NUMBER BELOW WAS FITTED TO THE OUTCOME, AND THE CHOICE STILL WAS
 * ---------------------------------------------------------------------------
 * Every ratio in the corrected model is MSCI's own, cited to a page in
 * `msci-methodology.mjs`, and every rupee figure is derived from the constituent
 * counts on the holdings files. Bands of ₹8,000 Cr and ₹3,800 Cr fitted to these
 * 33 events scored better still (20.5% / 97.0%) and were REJECTED, for a reason
 * that was measured rather than asserted: refit the bands on 32 of the 33 events
 * and score the one held out, and 97.0% becomes 90.9% — three events the
 * in-sample fit catches that a leave-one-out fit does not. Two of the 33 turn on
 * 2.5% of the fitted bar. A threshold read off 18 exits is worth nothing next
 * quarter.
 *
 * But the DECISION to derive the cutoffs by rank rather than by the coverage
 * walk was made knowing this outcome. So the figures below are IN-SAMPLE. They
 * are what the corrected model would have said about a review it was designed
 * after, which is not the same thing as what it will say about the next one.
 * Nothing may present them as a track record. §2.13 still stands: one review is
 * one data point, and there is still no probability anywhere in this product.
 */
export const AUGUST_2026_CALIBRATION = {
  review: '2026-08',
  /**
   * ⚠ NO SCORE IS TYPED HERE, and that is not tidiness.
   *
   * CLAUDE.md §2.5: no figure in any config, caption or doc may be hand-typed —
   * derive it from the module that owns the data. Both the forecast score and
   * the retrospective one are computed by `scripts/build-rebalance.mjs` from the
   * frozen snapshot and written into `rebalance-<review>.json`, which is where
   * every surface reads them. A number copied into this block would go stale the
   * first time a rule moved, and would look authoritative while it did.
   */
  scoresLiveIn: 'public/data/rebalance-2026-08.json',
  inSample: true,
  changes: [
    'size decided on full market cap, which is the basis MSCI expresses a cutoff in (GIMI p. 28)',
    "MSCI's asymmetric migration buffers, 2/3 out and 1.5x in (pp. 44-45)",
    "MSCI's 0.15 Foreign Inclusion Factor floor (pp. 21, 45)",
    'cutoffs derived by rank against the observed constituent count, not by the coverage walk',
    "the free-float minimum for a NEW constituent (p. 30) recorded but NOT applied — our cutoff is "
      + 'too high for it, and it discarded three of this review\'s twelve entrants',
  ],
  attribution:
    "the desk's decision, taken after seeing one review's outcome. The RATIOS are MSCI's and are "
    + 'cited to a page; the rupee cutoffs they are applied to are ours, derived from the '
    + 'constituents the funds hold. No threshold was tuned to fit the 33 events.',
  note:
    'IN-SAMPLE. The corrected model was designed knowing what happened in August 2026, so its '
    + 'retrospective score is not a forecast record and must never be shown as one.',
};

/**
 * The desk's rupee bands are KEPT, and they are no longer what decides a verdict.
 *
 * ---------------------------------------------------------------------------
 * TWO THRESHOLDS, AND THE DISAGREEMENT IS THE INFORMATION — CLAUDE.md §2.14
 * ---------------------------------------------------------------------------
 * `REVIEW_THRESHOLDS` above is the desk's own heuristic and it is still measured
 * on every company, still floated by `SEGMENT_BAND_ADJUSTMENT`, and still
 * recorded on every rule that fires. What changed in September 2026 is which of
 * the two the VERDICT follows.
 *
 * Deleting the desk's band because a review disagreed with it would answer a
 * question about accuracy by throwing away the client's own frame of reference.
 * Keeping it silently beside a verdict it did not produce would be worse. So it
 * is carried explicitly, as its own rule, with its own result, and the drill
 * panel says where the two part company.
 *
 * Measured on the record of 28 Aug 2026: the desk's floated exclusion band puts
 * the deletion bar at ₹2,538 Cr of free float, and August's exits ran to
 * ₹3,749 Cr — PTC India left the index carrying more free float than the desk's
 * own INCLUSION band asks of a new entrant. That is the disagreement, it is
 * large, and it is on the record rather than resolved away.
 */
export const DESK_BAND_ROLE = {
  decidesVerdict: false,
  stillMeasured: true,
  rule: "the desk's bands are recorded on every company and named on every drill; the verdict "
    + "follows MSCI's published geometry applied to the observed constituent counts",
  attribution: "the desk's own decision, September 2026, after the August review was scored",
};
