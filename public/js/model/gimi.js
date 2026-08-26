/**
 * gimi.js — the second methodology: MSCI's own procedure, applied to our universe.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 * The screener ships two methodologies side by side so the desk can see what
 * changes when MSCI's published structure is applied instead of the desk's
 * rupee bands:
 *
 *   'freefloat'  — the shipped model. One number (free-float market cap) tested
 *                  against the desk's inclusion/exclusion bands. `assess.js`.
 *   'gimi'       — this one. Three corrections read out of the MSCI GIMI
 *                  Methodology (August 2026) and cited to page.
 *
 * Neither replaces the other here. The point is the DIFFERENCE: a reader can
 * flip the toggle and see which companies change verdict and why.
 *
 * ---------------------------------------------------------------------------
 * THE THREE CORRECTIONS
 * ---------------------------------------------------------------------------
 *
 * 1. A COMPANY HAS TWO SIZES AND MSCI USES BOTH (p. 28).
 *    Companies are counted in descending order of FULL market capitalisation
 *    until cumulative FREE-FLOAT market capitalisation reaches the coverage
 *    target; the cutoff is then expressed as the last counted company's FULL
 *    market cap. MSCI counts in one currency and answers in another. The
 *    shipped model only ever counts free float — one quantity where MSCI uses
 *    two, and in India, where promoter and government holdings are heavy, the
 *    two diverge violently.
 *
 * 2. THE BUFFERS ARE ASYMMETRIC AND HYSTERETIC (pp. 44–45).
 *    An existing constituent keeps its segment until it falls below 2/3 of the
 *    cutoff; a non-constituent enters only above 1.5x it. A single bright line
 *    predicts far more migration than the rules actually produce. Incumbents
 *    also get relief on the minimum free-float test (2/3), and index entry is
 *    REPLACEMENT-BASED, so clearing the bar makes a company eligible and never
 *    included.
 *
 * 3. THE REVIEW IS DECIDED A MONTH BEFORE IT HAPPENS (p. 49).
 *    Prices come from one of the last ten business days of the month BEFORE the
 *    review month. Once that window shuts the outcome is fixed, and a price
 *    move after it is evidence about the NEXT review, not the coming one. This
 *    module states which review the verdicts on screen are actually about.
 *
 * ---------------------------------------------------------------------------
 * ⚠ WHAT THIS IS NOT, AND THE LIMIT IS NOT A DETAIL
 * ---------------------------------------------------------------------------
 * MSCI derives its size cutoffs from the MARKET INVESTABLE EQUITY UNIVERSE
 * ACROSS ALL OF EMERGING MARKETS, at a review date, using MSCI's own float
 * factors. We hold ~1,254 Indian companies, floated by the exchanges, priced
 * today.
 *
 * So the cutoffs this module derives are OUR UNIVERSE'S cutoffs computed by
 * MSCI's PROCEDURE. They are structurally right and numerically ours. That is
 * a better approximation than a fixed rupee band — the procedure at least moves
 * with the market, which a fixed band cannot — but it is not MSCI's number and
 * nothing here may be printed as though it were. Every surface that shows a
 * GIMI cutoff carries `CUTOFF_DISCLOSURE`.
 */

import {
  CUTOFF_BASIS, BUFFERS, COVERAGE_TARGETS, MIN_FREE_FLOAT_MCAP, MIN_FIF, REVIEW_TIMETABLE, SOURCE,
} from '../config/msci-methodology.mjs';
import { segmentOf, isSampledByEmSmallCap } from './segments.js';
import { nextReview, reviewCutoffs } from './calendar.js';

/** How the methodology document is cited on screen, built from its own fields. */
export const SOURCE_LABEL = `${SOURCE.document}, ${SOURCE.edition}`;

export const METHODOLOGIES = {
  freefloat: {
    id: 'freefloat',
    label: 'Free float only',
    short: 'freefloatmarketcap',
    what: "One size number. Free-float market cap against the desk's inclusion and exclusion bands.",
    attribution: "the desk's own heuristic from past MSCI reviews",
  },
  gimi: {
    id: 'gimi',
    label: 'Free float + full market cap',
    short: 'freefloat+fullmarketcap',
    what: "Two size numbers, MSCI's way: rank by full market cap, count free float to the coverage "
      + 'target, then test free float separately. With MSCI’s buffers and review timetable.',
    attribution: `MSCI's published procedure (${SOURCE_LABEL}), applied to the universe we hold`,
  },
};

export const DEFAULT_METHODOLOGY = 'freefloat';
export const METHODOLOGY_IDS = Object.keys(METHODOLOGIES);

export const CUTOFF_DISCLOSURE =
  'Derived by MSCI’s procedure from the companies in THIS record, not published by MSCI. MSCI '
  + 'derives its cutoffs across the whole emerging-markets investable universe at each review, using '
  + 'its own float factors. The structure is MSCI’s; the number is ours.';

/* ────────────────────────────────────────────────────────────────────────────
 * Finding 1 — the cutoff, counted in one currency and answered in another
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Walk the universe MSCI's way and return the size-segment cutoffs.
 *
 * The procedure, verbatim from p. 28: sort DESCENDING BY FULL market cap,
 * accumulate FREE-FLOAT market cap, and when the running free-float total
 * crosses the coverage target, the cutoff is that company's FULL market cap.
 *
 * Two targets give the two boundaries this model needs:
 *   standard (85%) — the Standard / Small Cap line
 *   imi      (99%) — the Small Cap floor, below which a company is outside
 *
 * A company missing EITHER size is excluded from the walk entirely and counted
 * in `skipped`. It is not treated as a zero: a zero would sit at the bottom of
 * the ranking, inflate the denominator and drag both cutoffs down (CLAUDE.md
 * §2.3). The denominator is reported so the gap is visible.
 */
export function gimiCutoffs(companies) {
  const usable = companies.filter(
    (c) => Number.isFinite(c.fullMcapInr) && c.fullMcapInr > 0
      && Number.isFinite(c.freeFloatMcapInr) && c.freeFloatMcapInr > 0,
  );
  const skipped = companies.length - usable.length;

  // DESCENDING BY FULL MARKET CAP. This is the half the shipped model never
  // does, and it is the whole of Finding 1.
  const ranked = [...usable].sort((a, b) => b.fullMcapInr - a.fullMcapInr);
  const totalFreeFloat = ranked.reduce((sum, c) => sum + c.freeFloatMcapInr, 0);

  const walkTo = (targetPct) => {
    if (!(totalFreeFloat > 0) || ranked.length === 0) {
      return { cutoffInr: null, company: null, count: 0, coveragePct: null };
    }
    const target = totalFreeFloat * (targetPct / 100);
    let cumulative = 0;
    for (let i = 0; i < ranked.length; i += 1) {
      cumulative += ranked[i].freeFloatMcapInr;
      if (cumulative >= target) {
        return {
          // ANSWERED IN FULL MARKET CAP, counted in free float.
          cutoffInr: ranked[i].fullMcapInr,
          company: { name: ranked[i].name, nseSymbol: ranked[i].nseSymbol, isin: ranked[i].isin },
          count: i + 1,
          coveragePct: (cumulative / totalFreeFloat) * 100,
        };
      }
    }
    const last = ranked[ranked.length - 1];
    return {
      cutoffInr: last.fullMcapInr,
      company: { name: last.name, nseSymbol: last.nseSymbol, isin: last.isin },
      count: ranked.length,
      coveragePct: 100,
    };
  };

  const standard = walkTo(COVERAGE_TARGETS.standard.target);
  const imi = walkTo(COVERAGE_TARGETS.imi.target);

  return {
    basis: CUTOFF_BASIS,
    disclosure: CUTOFF_DISCLOSURE,
    universeCount: usable.length,
    consideredCount: companies.length,
    skipped,
    totalFreeFloatInr: totalFreeFloat,
    standard: { ...standard, targetPct: COVERAGE_TARGETS.standard.target },
    imi: { ...imi, targetPct: COVERAGE_TARGETS.imi.target },
    buffers: {
      lowerMultiple: BUFFERS.lowerMultiple,
      upperMultiple: BUFFERS.upperMultiple,
      lowerLabel: BUFFERS.lowerLabel,
      upperLabel: BUFFERS.upperLabel,
      page: BUFFERS.page,
    },
    // Every bar a verdict can be measured against, precomputed once so no rule
    // recomputes a multiple and no two rules can disagree about a bar.
    bars: {
      standardLower: standard.cutoffInr === null ? null : Math.round(standard.cutoffInr * BUFFERS.lowerMultiple),
      standardUpper: standard.cutoffInr === null ? null : Math.round(standard.cutoffInr * BUFFERS.upperMultiple),
      imiLower: imi.cutoffInr === null ? null : Math.round(imi.cutoffInr * BUFFERS.lowerMultiple),
      imiUpper: imi.cutoffInr === null ? null : Math.round(imi.cutoffInr * BUFFERS.upperMultiple),
      // The SEPARATE free-float test — the second job in Finding 1.
      minFreeFloatNew: imi.cutoffInr === null ? null
        : Math.round(imi.cutoffInr * MIN_FREE_FLOAT_MCAP.newConstituentMultipleOfCutoff),
      minFreeFloatExisting: imi.cutoffInr === null ? null
        : Math.round(imi.cutoffInr * MIN_FREE_FLOAT_MCAP.newConstituentMultipleOfCutoff
          * MIN_FREE_FLOAT_MCAP.existingConstituentRelief),
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Finding 3 — which review these verdicts are actually about
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Is the coming review still open to today's data, or already sealed?
 *
 * `priceAsOf` is the date of the prices the verdicts were computed from — the
 * committed bhavcopy date, not the wall clock. Asking "is it after 31 July"
 * of the CLOCK while the numbers came from a file dated differently would
 * report a freshness the figures do not have.
 */
export function reviewWindow(priceAsOf, now = new Date()) {
  const review = nextReview(now);
  const cutoffs = reviewCutoffs(review.year, review.month);
  const asOf = priceAsOf ? String(priceAsOf).slice(0, 10) : null;

  const windowClosed = asOf !== null && asOf > cutoffs.price.to;
  // When the coming review is already priced, today's numbers are evidence
  // about the one after it. Naming that is the whole commercial point of the
  // finding: the forecasting is worth most in the ten days before the window
  // shuts, and worth nothing about a review already decided.
  const following = windowClosed
    ? nextReview(new Date(Date.UTC(review.year, review.month, 15)))
    : null;
  const followingCutoffs = following ? reviewCutoffs(following.year, following.month) : null;

  return {
    review,
    cutoffs,
    priceAsOf: asOf,
    windowOpensOn: cutoffs.price.from,
    windowClosesOn: cutoffs.price.to,
    windowClosed,
    // What the numbers on screen can honestly speak to.
    verdictsAreAbout: windowClosed && following ? following : review,
    following,
    followingCutoffs,
    source: `${SOURCE_LABEL}, p. ${REVIEW_TIMETABLE.page}`,
    note: windowClosed
      ? `Prices for the ${review.label} review were taken on one of ${cutoffs.price.from} to `
        + `${cutoffs.price.to} and that window has shut. Today’s figures are evidence about `
        + `${following ? following.label : 'the following review'}, not about ${review.label}.`
      : `Prices for the ${review.label} review are taken on one of ${cutoffs.price.from} to `
        + `${cutoffs.price.to}. Until that window shuts, today’s figures can still move the outcome.`,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The assessment
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A rule, WITH THE UNIT OF ITS OWN NUMBERS.
 *
 * This model compares three different kinds of quantity — rupees (market caps),
 * a dimensionless ratio (the Foreign Inclusion Factor) and, in the other model,
 * ranks. A table that assumed rupees rendered MSCI's FIF floor of 0.15 as
 * "₹0 Cr", which is not a rounding artefact but a different number entirely.
 * The unit travels with the rule so the renderer never has to guess from the key.
 */
const rule = (key, label, input, threshold, thresholdSource, result, note, unit = 'inr') => ({
  key, label, input, threshold, thresholdSource, result, note: note ?? null, band: null, unit,
});

/** Signed distance to a bar, as a percentage of that bar. */
function distanceTo(value, threshold) {
  if (value === null || threshold === null || !(threshold > 0)) return null;
  return ((value - threshold) / threshold) * 100;
}

/**
 * Assess one company under MSCI's structure.
 *
 * Returns the SAME shape as `assess()` in assess.js, deliberately: the two
 * methodologies have to be comparable row by row, and a different shape would
 * make the comparison a rewrite rather than a swap.
 *
 * @param {object} company
 * @param {{cutoffs: object, quarantined: Set, keyOf: Function, window: object}} context
 */
export function assessGimi(company, context) {
  const { cutoffs, quarantined, keyOf, window: reviewWin } = context;
  const segment = segmentOf(company);
  const rulesFired = [];
  const key = keyOf(company);
  const isConstituent = segment === 'standard' || segment === 'smallcap';

  // The distance is ALWAYS paired with the rule it was measured against.
  // Taking "the last rule fired" instead was wrong the moment a verdict could
  // turn on the FIF floor while the last rule pushed was about free float — the
  // sentence then reported a real percentage against the wrong threshold.
  const done = (verdict, distancePct, distanceRuleKey = null) =>
    finish(verdict, rulesFired, distancePct, segment, company, reviewWin, distanceRuleKey);

  // ---- gates, in priority order. Each short-circuits. ---------------------
  if (quarantined?.has(key)) {
    rulesFired.push(rule(
      'share-count-quarantined', 'Share count could not be corroborated',
      'sharesOutstanding', null, 'reconciliation', 'unknown',
      'Both size numbers are derived from the share count, so a suspect count makes every '
      + 'comparison below it meaningless.',
    ));
    return done('unknown', null);
  }

  const full = company.fullMcapInr;
  const freeFloat = company.freeFloatMcapInr;

  // MISSING IS NOT ZERO, and under this methodology a company needs BOTH sizes.
  // That is a real coverage cost of the correction and it is reported, not
  // papered over: a company with no full market cap cannot be ranked at all.
  if (!Number.isFinite(full) || full <= 0) {
    rulesFired.push(rule(
      'no-full-mcap', 'No full market cap', 'fullMcapInr', null, 'measurement', 'unknown',
      'MSCI ranks by full market capitalisation. Without one this company cannot be placed against '
      + 'a size-segment cutoff at all — and a missing size is not a small one.',
    ));
    return done('unknown', null);
  }
  if (!Number.isFinite(freeFloat) || freeFloat <= 0) {
    rulesFired.push(rule(
      'no-free-float', 'No free-float reading', 'freeFloatMcapInr', null, 'measurement', 'unknown',
      'The free-float test is separate from the size test and cannot be skipped.',
    ));
    return done('unknown', null);
  }

  const bars = cutoffs.bars;
  if (bars.imiLower === null || bars.standardUpper === null) {
    rulesFired.push(rule(
      'no-cutoff', 'No size-segment cutoff could be derived', null, null, 'derived', 'unknown',
      'The universe carried too few companies with both sizes to run the coverage walk.',
    ));
    return done('unknown', null);
  }

  // ---- the separate free-float test (Finding 1, second job) ---------------
  // Incumbents get 2/3 relief (p. 45). Applied BEFORE the size question,
  // because failing it removes a company regardless of how large it is.
  const ffBar = isConstituent ? bars.minFreeFloatExisting : bars.minFreeFloatNew;
  const ffLabel = isConstituent
    ? `Free float vs ${(MIN_FREE_FLOAT_MCAP.newConstituentMultipleOfCutoff * MIN_FREE_FLOAT_MCAP.existingConstituentRelief).toFixed(3)}× the IMI cutoff (incumbent relief)`
    : `Free float vs ${MIN_FREE_FLOAT_MCAP.newConstituentMultipleOfCutoff}× the IMI cutoff`;
  rulesFired.push(rule(
    'min-free-float', ffLabel, freeFloat, ffBar, 'msci',
    freeFloat >= ffBar ? 'above' : 'below',
    `MSCI's minimum free-float market cap, pp. ${MIN_FREE_FLOAT_MCAP.pages.join(' and ')}. `
    + (isConstituent
      ? 'Existing constituents may sit at 2/3 of the requirement.'
      : 'A new constituent must clear the full requirement.'),
  ));

  // ---- the FIF floor (p. 21, p. 45) --------------------------------------
  const fif = company.floatFactor;
  if (Number.isFinite(fif)) {
    rulesFired.push(rule(
      'min-fif', 'Foreign Inclusion Factor floor', fif, MIN_FIF.floor, 'msci',
      fif >= MIN_FIF.floor ? 'above' : 'below',
      `MSCI's global minimum FIF, pp. ${MIN_FIF.pages.join(' and ')}. Below it a security is not `
      + 'investable at all, whatever its size.',
      'factor',
    ));
  }
  const failsFif = Number.isFinite(fif) && fif < MIN_FIF.floor;
  const failsFreeFloat = freeFloat < ffBar;

  // ---- Finding 2: the buffers, asymmetric and hysteretic ------------------
  if (!isConstituent) {
    // ENTRY. A non-constituent must clear 1.5× the IMI cutoff (Small Cap Entry
    // Buffer), and entry is replacement-based on top of that.
    if (failsFif || failsFreeFloat) {
      return done('stable', failsFif ? distanceTo(fif, MIN_FIF.floor) : distanceTo(freeFloat, ffBar),
        failsFif ? 'min-fif' : 'min-free-float');
    }
    rulesFired.push(rule(
      'entry-buffer', `Full market cap vs the Small Cap Entry Buffer (${BUFFERS.upperLabel})`,
      full, bars.imiUpper, 'msci',
      full >= bars.imiUpper ? 'above' : 'below',
      `p. ${BUFFERS.page}. A non-constituent does not enter at the cutoff; it enters at 1.5× it. `
      + 'And entry is REPLACEMENT-BASED: clearing this bar makes a company eligible, never included.',
    ));
    if (full >= bars.imiUpper) {
      return done('likely-inclusion', distanceTo(full, bars.imiUpper), 'entry-buffer');
    }
    rulesFired.push(rule(
      'entry-cutoff', 'Full market cap vs the IMI cutoff itself',
      full, cutoffs.imi.cutoffInr, 'derived',
      full >= cutoffs.imi.cutoffInr ? 'above' : 'below',
      'Above the cutoff but inside the entry buffer: large enough to matter, not large enough to '
      + 'enter under MSCI’s rules.',
    ));
    if (full >= cutoffs.imi.cutoffInr) {
      return done('possible-inclusion', distanceTo(full, bars.imiUpper), 'entry-cutoff');
    }
    return done('stable', distanceTo(full, cutoffs.imi.cutoffInr), 'entry-cutoff');
  }

  // CONSTITUENTS. Exclusion outranks migration: leaving the index entirely is a
  // bigger event than moving between segments.
  rulesFired.push(rule(
    'imi-lower-buffer', `Full market cap vs the Small Cap Lower Buffer (${BUFFERS.lowerLabel})`,
    full, bars.imiLower, 'msci',
    full < bars.imiLower ? 'below' : 'above',
    `p. ${BUFFERS.page}. An existing constituent is not dropped at the cutoff — it keeps its place `
    + 'until it falls to 2/3 of it. This is the hysteresis a single bright line cannot see.',
  ));
  if (full < bars.imiLower) {
    return done('likely-exclusion', distanceTo(full, bars.imiLower), 'imi-lower-buffer');
  }

  if (failsFif) {
    return done('likely-exclusion', distanceTo(fif, MIN_FIF.floor), 'min-fif');
  }
  if (failsFreeFloat) {
    return done('exclusion-risk', distanceTo(freeFloat, ffBar), 'min-free-float');
  }

  rulesFired.push(rule(
    'imi-cutoff', 'Full market cap vs the IMI cutoff itself',
    full, cutoffs.imi.cutoffInr, 'derived',
    full < cutoffs.imi.cutoffInr ? 'below' : 'above',
    'Below the cutoff but still inside the lower buffer: at risk, not yet out.',
  ));
  if (full < cutoffs.imi.cutoffInr) {
    return done('exclusion-risk', distanceTo(full, bars.imiLower), 'imi-cutoff');
  }

  // ---- segment migration, on the SAME buffered geometry -------------------
  if (segment === 'smallcap') {
    rulesFired.push(rule(
      'standard-entry-buffer', `Full market cap vs the Standard upper buffer (${BUFFERS.upperLabel})`,
      full, bars.standardUpper, 'msci',
      full >= bars.standardUpper ? 'above' : 'below',
      `p. ${BUFFERS.page}. A Small Cap constituent moves up only above 1.5× the Standard cutoff.`,
    ));
    if (full >= bars.standardUpper) {
      return done('migration-up', distanceTo(full, bars.standardUpper), 'standard-entry-buffer');
    }
    return done('stable', distanceTo(full, bars.standardUpper), 'standard-entry-buffer');
  }

  rulesFired.push(rule(
    'standard-lower-buffer', `Full market cap vs the Standard lower buffer (${BUFFERS.lowerLabel})`,
    full, bars.standardLower, 'msci',
    full < bars.standardLower ? 'below' : 'above',
    `p. ${BUFFERS.page}. A Standard constituent drops to Small Cap only below 2/3 of the cutoff.`,
  ));
  if (full < bars.standardLower) {
    return done('migration-down', distanceTo(full, bars.standardLower), 'standard-lower-buffer');
  }
  return done('stable', distanceTo(full, bars.standardLower), 'standard-lower-buffer');
}

function finish(verdict, rulesFired, distancePct, segment, company, reviewWin, distanceRuleKey) {
  const notes = [];
  if (segment !== 'standard' && !isSampledByEmSmallCap(company)
    && verdict !== 'stable' && verdict !== 'unknown') {
    notes.push('EM Small-Cap does not currently sample this company, so it has no basis for an EM SC flow estimate.');
  }
  // Finding 3, carried onto every verdict rather than left in a banner: a
  // reader looking at one row has to be able to see which review it speaks to.
  if (reviewWin?.windowClosed) {
    notes.push(
      `The ${reviewWin.review.label} review was priced on or before ${reviewWin.windowClosesOn} and is `
      + `already sealed. This verdict is evidence about ${reviewWin.verdictsAreAbout.label}.`,
    );
  }
  // THE SHAPE MUST MATCH `assess()` FIELD FOR FIELD, including `distancePct`
  // and its rounding. Two methodologies feeding one table and one CSV means a
  // shape difference does not throw — it renders as an em dash in a column that
  // works under the other model, which reads as missing data rather than as a
  // bug in this file.
  return {
    verdict,
    segment,
    rulesFired,
    distancePct: distancePct === null ? null : Number(distancePct.toFixed(3)),
    distanceRuleKey: distanceRuleKey ?? null,
    notes,
    methodology: 'gimi',
  };
}

export const GIMI_DISCLOSURE =
  'MODELLED BY US, using MSCI’s published procedure and thresholds (' + SOURCE_LABEL + '). '
  + 'The rules and multiples are MSCI’s and cited to page; the universe they are applied to is '
  + 'ours, so the cutoffs are ours too. Not a probability, and not MSCI’s own output.';
