/**
 * relative.js — how a company moved against its segment, review window to
 *               review window.
 *
 * Pure. No fetching, no clock. The build computes it and the browser reads it,
 * so a figure on screen is the arithmetic the record was built from.
 *
 * ---------------------------------------------------------------------------
 * THE QUESTION, AND WHY THE OBVIOUS ANSWER IS THE WRONG QUANTITY
 * ---------------------------------------------------------------------------
 * The desk asked how a company performed against the indices holding it, review
 * to review, and whether that says anything about migration.
 *
 * The nearest available reading was a nominal one-year change from a third-party
 * statistics feed. It is not a noisier version of the review-quarter figure — it
 * is a different quantity that happens to share units. Measured on the 738
 * companies carrying both, the two disagree about whether the company out- or
 * under-performed on 201 of them (27.2%), and on 117 of those BOTH readings
 * exceed 5 pp, so it is a confident +40.7 against a confident -5.3 for the same
 * company (KEI). This module measures the window MSCI actually uses.
 *
 * ---------------------------------------------------------------------------
 * ⚠ THE FUND THAT HOLDS A STOCK IS NOT THE INDEX THAT DECIDES ITS SEGMENT
 * ---------------------------------------------------------------------------
 * "The indices holding the stock" for a Standard constituent is EEM, which is
 * ~11% India. Over a year EEM returned +45.5% in rupees against INDA's +2.6%,
 * and against EEM essentially every Indian large cap "underperforms" — wrong in
 * the same direction for every company, for a reason that has nothing to do with
 * India. Migration is decided by ranking Indian companies inside MSCI India, so
 * the benchmark is INDA for Standard and SMIN for Small Cap. Only a benchmark
 * whose basket is actually Indian may be differenced against an Indian company —
 * `comparableInInr` in benchmarks.js is the gate.
 *
 * ---------------------------------------------------------------------------
 * ⚠ GEOMETRIC, NOT AN ARITHMETIC POINT DIFFERENCE
 * ---------------------------------------------------------------------------
 *     relativePct = ((1 + stock/100) / (1 + index/100) - 1) x 100
 *
 * Subtracting two compounded returns is not the outperformance a reader
 * reconstructs from the two numbers beside it. WELCORP returned +119.7% against
 * SMIN's +4.5%: the difference is 115.2 pp, the comparable figure is +110.0%,
 * and a reader who checks the arithmetic finds neither matches the other.
 *
 * ---------------------------------------------------------------------------
 * ⚠ MSCI DOES NOT SAY WHICH OF THE TEN DAYS IT USED, AND IT MATTERS ENORMOUSLY
 * ---------------------------------------------------------------------------
 * The price cut-off is "one of the last 10 business days of the month before the
 * review month" and MSCI does not publish which. So there are 100 (from-day,
 * to-day) pairs it could have meant, and they do not agree. Measured across all
 * 1,177 companies with a reading:
 *
 *     envelope width   p10 8.30   MEDIAN 14.73   p75 21.03   p90 29.16   max 133.15 pp
 *     envelope entirely one side of zero:  807 of 1,177  (68.6%)
 *
 * For 31.4% of companies the SIGN of the answer depends on which day you pick.
 * The point estimate is the mean of the ten days at each end — no single day is
 * privileged — and the envelope is carried as a first-class field beside it.
 * `robust` is true only when the WHOLE envelope sits one side of the band, and
 * nothing may act on a reading that is not robust.
 *
 * That measurement is also why the band is what it is: any band below ~15 pp is
 * inside the noise of its own input, and a threshold smaller than its
 * measurement's uncertainty produces state changes that are noise wearing a
 * threshold's face.
 */

import { RELATIVE_PERFORMANCE } from '../config/thresholds.mjs';

/** Every reason a window return can be absent, each in its own words — 2.4. */
export const WINDOW_STATES = {
  measured: {
    label: 'measured',
    detail: 'Both windows are complete and no corporate action fell in the quarter.',
  },
  adjusted: {
    label: 'measured, adjusted for a corporate action',
    detail: 'A bonus, split or consolidation fell BETWEEN the two windows. The earlier window is '
      + 'divided by the factor BSE published for it, so both ends sit on the same number of shares.',
  },
  'action-inside-window': {
    label: 'a corporate action fell inside a price window',
    detail: 'The ten closes at one end straddle two different share bases, so their mean is not a '
      + 'price. No single factor repairs it, because some of the ten days are before the action and '
      + 'some after.',
  },
  'unquantifiable-action': {
    label: 'a corporate action with no published ratio',
    detail: 'A rights issue, demerger or consolidation moved the price by an amount BSE does not '
      + 'publish. The move is real and its size is unknown, so no return can be computed across it.',
  },
  'incomplete-window': {
    label: 'the company did not trade on every day of a window',
    detail: 'A ten-day mean over fewer than ten days is a mean of a different window. The missing '
      + 'sessions are days the scrip did not trade, not days worth zero.',
  },
  'no-price-history': {
    label: 'no price history for this scrip',
    detail: 'The company has no BSE scrip code, or did not appear in the archived bhavcopies for '
      + 'these windows.',
  },
  'no-action-data': {
    label: 'corporate-action history could not be read',
    detail: 'BSE did not answer for this scrip. Its actions are UNKNOWN, which is not the same as '
      + 'none — a bonus we cannot see would read as a collapse.',
  },
  'no-index-leg': {
    label: 'the segment benchmark has no close on these dates',
    detail: 'Both legs must be struck on the same dates. Walking the index back to a different day '
      + 'would difference two different days and call the result relative performance.',
  },
  'no-benchmark': {
    label: 'no Indian benchmark stands for this segment',
    detail: 'A benchmark whose basket is mostly not India cannot be differenced against an Indian '
      + 'company: the answer would be a currency and country move, not an outperformance.',
  },
};

/**
 * The mean of a window's closes.
 *
 * ALL-OR-NOTHING ON PURPOSE. A mean over eight of ten sessions is the mean of a
 * different window, and it would silently be compared against a ten-day mean at
 * the other end. Returns null rather than a partial figure — 2.3.
 */
export function windowMean(closes) {
  if (!Array.isArray(closes) || closes.length === 0) return null;
  let total = 0;
  for (const close of closes) {
    if (close === null || close === undefined || !(close > 0)) return null;
    total += close;
  }
  return total / closes.length;
}

/**
 * The factor the EARLIER window must be divided by to sit on the later window's
 * share basis.
 *
 * `actions` are BSE's published events; only those strictly BETWEEN the windows
 * can be handled this way. One inside a window is a different state entirely —
 * see `action-inside-window` above.
 */
export function adjustmentFor(actions, betweenAfter, betweenBefore) {
  const between = (actions ?? []).filter(
    (a) => a.exDate && a.exDate > betweenAfter && a.exDate < betweenBefore,
  );
  if (between.some((a) => !a.quantifiable)) {
    return { state: 'unquantifiable-action', factor: null, applied: between };
  }
  const factor = between.reduce((product, a) => product * a.priceFactor, 1);
  return { state: between.length ? 'adjusted' : 'measured', factor, applied: between };
}

/** Geometric relative return, in percent. Null in, null out — never a coercion. */
export function relativeOf(stockPct, indexPct) {
  // ⚠ NOT `stockPct - indexPct`. In JavaScript `null - 4.5` is -4.5 — finite,
  // sortable, and plausible — so a bare subtraction would give every company
  // with a missing leg a mild-underperformer reading that sorts among the real
  // ones instead of into the missing group. 2.3, in its sharpest form.
  if (typeof stockPct !== 'number' || !Number.isFinite(stockPct)) return null;
  if (typeof indexPct !== 'number' || !Number.isFinite(indexPct)) return null;
  const denominator = 1 + (indexPct / 100);
  if (!(denominator > 0)) return null;
  return (((1 + (stockPct / 100)) / denominator) - 1) * 100;
}

const pctChange = (from, to) => (from > 0 && to > 0 ? ((to - from) / from) * 100 : null);
const round = (v) => (v === null || v === undefined ? null : Number(v.toFixed(3)));

/**
 * The whole reading for one company.
 *
 * @param {object} input
 *   `closesFrom` / `closesTo`  the ten raw closes at each end, index-aligned
 *   `indexFrom` / `indexTo`    the benchmark's rupee closes on the SAME dates
 *   `actions`                  BSE's published actions for this scrip, or null
 *                              when they could not be read (which is not "none")
 *   `windowFromTo` / `windowToFrom`  the two dates the gap is measured between
 *   `benchmark`                the benchmark descriptor, for disclosure
 */
export function assessRelative(input) {
  const {
    closesFrom, closesTo, indexFrom, indexTo, actions,
    windowFromTo, windowToFrom, benchmark, hasPriceHistory = true,
  } = input;

  const absent = (state) => ({
    state,
    reason: WINDOW_STATES[state]?.detail ?? null,
    label: WINDOW_STATES[state]?.label ?? state,
    stockPct: null, indexPct: null, relativePct: null,
    envelope: null, widthPp: null, robust: false, direction: null,
    benchmarkSymbol: benchmark?.symbol ?? null,
    adjustmentFactor: null, actionsApplied: [],
  });

  if (!hasPriceHistory) return absent('no-price-history');
  if (!benchmark) return absent('no-benchmark');
  if (actions === null || actions === undefined) return absent('no-action-data');

  // An action INSIDE either window corrupts that window's own mean.
  const insideEither = actions.filter((a) => a.exDate
    && ((a.exDate >= input.windowFromFrom && a.exDate <= windowFromTo)
      || (a.exDate >= windowToFrom && a.exDate <= input.windowToTo)));
  if (insideEither.length > 0) return absent('action-inside-window');

  const adjustment = adjustmentFor(actions, windowFromTo, windowToFrom);
  if (adjustment.state === 'unquantifiable-action') return absent('unquantifiable-action');

  const meanFrom = windowMean(closesFrom);
  const meanTo = windowMean(closesTo);
  if (meanFrom === null || meanTo === null) return absent('incomplete-window');

  const indexMeanFrom = windowMean(indexFrom);
  const indexMeanTo = windowMean(indexTo);
  if (indexMeanFrom === null || indexMeanTo === null) return absent('no-index-leg');

  const factor = adjustment.factor;
  const stockPct = pctChange(meanFrom / factor, meanTo);
  const indexPct = pctChange(indexMeanFrom, indexMeanTo);
  const relativePct = relativeOf(stockPct, indexPct);
  if (relativePct === null) return absent('no-index-leg');

  // ---- the day-choice envelope, over every pair MSCI could have meant ------
  let lo = Infinity;
  let hi = -Infinity;
  for (let a = 0; a < closesFrom.length; a += 1) {
    const priceA = closesFrom[a];
    const indexA = indexFrom[a];
    if (!(priceA > 0) || !(indexA > 0)) continue;
    for (let b = 0; b < closesTo.length; b += 1) {
      const priceB = closesTo[b];
      const indexB = indexTo[b];
      if (!(priceB > 0) || !(indexB > 0)) continue;
      const pair = relativeOf(pctChange(priceA / factor, priceB), pctChange(indexA, indexB));
      if (pair === null) continue;
      if (pair < lo) lo = pair;
      if (pair > hi) hi = pair;
    }
  }
  const haveEnvelope = Number.isFinite(lo) && Number.isFinite(hi);

  // ROBUST means the whole envelope clears the band, not the point estimate.
  // A reading whose sign flips on which of MSCI's ten undisclosed days you pick
  // is not evidence of anything, and only a robust reading may act.
  const band = RELATIVE_PERFORMANCE.bandPct;
  const robust = haveEnvelope && (lo > band || hi < -band);

  return {
    state: adjustment.state,
    reason: WINDOW_STATES[adjustment.state]?.detail ?? null,
    label: WINDOW_STATES[adjustment.state]?.label ?? adjustment.state,
    stockPct: round(stockPct),
    indexPct: round(indexPct),
    relativePct: round(relativePct),
    envelope: haveEnvelope ? [round(lo), round(hi)] : null,
    widthPp: haveEnvelope ? round(hi - lo) : null,
    robust,
    // Only ever set from a ROBUST reading. An unstable one has no direction,
    // and rendering "outperformed" from a sign that flips on a day choice is
    // the number-wearing-a-fact failure this whole module is arranged against.
    direction: robust ? (lo > band ? 'outperformed' : 'underperformed') : null,
    benchmarkSymbol: benchmark.symbol,
    benchmarkName: benchmark.name,
    // ⚠ SIX DECIMALS, NOT THREE. A 4:3 bonus is 1.333333...; stored at 3dp the
    // stored stock leg no longer recomputes from the record, and a verifier
    // recomputing it finds a 0.03 pp disagreement it cannot explain. That is
    // exactly the "reconstruct the number from what is on screen" test failing
    // on our own rounding rather than on anything real.
    adjustmentFactor: factor === 1 ? null : Number(factor.toFixed(6)),
    actionsApplied: adjustment.applied.map((a) => ({
      exDate: a.exDate, purpose: a.purpose, priceFactor: a.priceFactor,
    })),
  };
}

/**
 * What the reading says about a verdict — WITHOUT changing it.
 *
 * ---------------------------------------------------------------------------
 * WHY IT DOES NOT MOVE THE VERDICT KEY, AND WHAT IT DOES INSTEAD
 * ---------------------------------------------------------------------------
 * A migration verdict turns on a RANK by free-float market cap, and free float
 * is floatFactor x sharesOutstanding x today's price. Today's rank therefore
 * already contains every past price move — that is how the company reached it.
 * Re-reading the trend against that rank and letting it move the verdict counts
 * the same evidence twice.
 *
 * There is one role that does not double-count, and it is the one the desk
 * actually wants: today's rank is a POINT FORECAST of the rank in MSCI's next
 * price window (19-30 Oct 2026), which has not happened. A robust trend is
 * evidence about which way that forecast moves. So a company sitting just below
 * the Standard boundary and robustly outperforming its segment is APPROACHING
 * that boundary, and the screen should say so — while its verdict continues to
 * describe where it stands today, which is what the verdict label claims.
 *
 * Measured on the committed record, three companies are in that position:
 * HFCL (rank 168, 2.8% below the cutoff, +84.4% with an envelope of [52, 120]),
 * Kalyan Jewellers (rank 172, +35.5% [25, 46]) and Gland Pharma (rank 178,
 * +30.8% [25, 40]). Every one currently reads "stable".
 *
 * The signal is additive: it never creates, renames, withholds or destroys a
 * verdict, so `verdictFromRules` still reproduces every verdict from its own
 * rules and the eight-key set is untouched.
 */
export function trendSignal(relative, { verdict, segment, distanceToCutoffPct }) {
  if (!relative || !relative.robust || relative.relativePct === null) return null;
  const near = distanceToCutoffPct !== null
    && distanceToCutoffPct !== undefined
    && Math.abs(distanceToCutoffPct) <= RELATIVE_PERFORMANCE.nearBoundaryPct;

  // Approaching a boundary the size rule has not crossed. This is the forecast,
  // and it is the only kind of signal that is not already inside the rank.
  if (near && segment === 'smallcap' && relative.direction === 'outperformed' && verdict !== 'migration-up') {
    return {
      kind: 'approaching-up',
      label: 'Closing on the Standard boundary',
      detail: `Ranked just below the Standard segment and outperforming ${relative.benchmarkSymbol} by `
        + `${relative.relativePct.toFixed(1)}% over the quarter, robustly across all ten of MSCI's `
        + 'possible price days. Its rank today does not cross; its trend points across.',
    };
  }
  if (near && segment === 'standard' && relative.direction === 'underperformed' && verdict !== 'migration-down') {
    return {
      kind: 'approaching-down',
      label: 'Closing on the Small Cap boundary',
      detail: `Ranked just inside the Standard segment and underperforming ${relative.benchmarkSymbol} by `
        + `${Math.abs(relative.relativePct).toFixed(1)}% over the quarter, robustly across all ten of `
        + "MSCI's possible price days. Its rank today holds; its trend points across.",
    };
  }

  // On a migration verdict, whether the trend agrees with the size rule. This is
  // NOT independent evidence — the rank is computed from price, so agreement is
  // close to arithmetic — which is why only the DISAGREEMENTS are worth a mark.
  if (verdict === 'migration-up' && relative.direction === 'underperformed') {
    return {
      kind: 'disagrees',
      label: 'Trend disagrees with the size rule',
      detail: `Large enough today to rank inside the Standard segment, but underperforming `
        + `${relative.benchmarkSymbol} by ${Math.abs(relative.relativePct).toFixed(1)}% over the quarter.`,
    };
  }
  if (verdict === 'migration-down' && relative.direction === 'outperformed') {
    return {
      kind: 'disagrees',
      label: 'Trend disagrees with the size rule',
      detail: `Overtaken on size today, but outperforming ${relative.benchmarkSymbol} by `
        + `${relative.relativePct.toFixed(1)}% over the quarter.`,
    };
  }
  return null;
}
