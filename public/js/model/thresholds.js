/**
 * thresholds.js — the two thresholds this model uses, and which is which.
 *
 * There are two, they come from different places, and they are NOT competing
 * estimates of the same boundary. Conflating them is the single easiest way to
 * make this model wrong, so they are kept apart and every verdict names the one
 * that produced it.
 *
 * ---------------------------------------------------------------------------
 * 1. THE DESK'S BANDS — an assumption, and labelled as one
 * ---------------------------------------------------------------------------
 * Inclusion ₹3,500–4,000 Cr, exclusion ₹2,000–2,400 Cr. They live in
 * `public/js/config/thresholds.mjs` and are re-exported here so there is still
 * exactly one home for them.
 *
 * MSCI derives its size cut-offs GLOBALLY at each quarterly review and does not
 * publish them in advance. Nothing may present these as MSCI's rule.
 *
 * Measured on the committed data, these bands sit at the boundary between
 * companies no fund holds and the Small Cap segment — 0% of Standard
 * constituents, 20% of Small Cap constituents and 85% of unheld companies fall
 * below ₹3,500 Cr. So this is the INDEX-ENTRY question: does a company get into
 * MSCI India IMI at all?
 *
 * ---------------------------------------------------------------------------
 * 2. THE OBSERVED BOUNDARY — a measurement, and it updates itself
 * ---------------------------------------------------------------------------
 * Where the Standard/Small-Cap line actually sits today, read off the current
 * constituents. This is the SEGMENT question: should a company be in Standard
 * or in Small Cap? It is an order of magnitude above the desk's bands
 * (₹18,521 Cr vs ₹3,500 Cr on the committed data) because it answers a
 * different question, not because either is wrong.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FLOOR ALONE CANNOT CLASSIFY A CONSTITUENT
 * ---------------------------------------------------------------------------
 * The observed Standard floor IS the smallest Standard constituent, so by
 * construction no Standard constituent is below it and a "below the floor"
 * test can never fire. That is the same self-defeating shape as a guard reading
 * its threshold from the value under test (see CLAUDE.md §3.8).
 *
 * The non-circular test is a RANK CROSSING against the whole universe: MSCI
 * Standard currently holds N India names, so take the top N companies by
 * free-float market cap across the entire record. A Standard constituent
 * outside that top N has been overtaken and is a migration-down candidate; a
 * non-Standard company inside it has overtaken and is a migration-up candidate.
 * Each is measured against the other segment and the unheld universe, never
 * against its own segment's own extremum.
 */

import { REVIEW_THRESHOLDS, crore, toCrore } from '../config/thresholds.mjs';

export { REVIEW_THRESHOLDS, crore, toCrore };

/** Where a threshold came from. Rendered beside every rule that fires. */
export const THRESHOLD_SOURCE = {
  desk: {
    key: 'desk',
    label: "the desk's own band",
    detail:
      "The desk's rule of thumb from past reviews. MSCI derives its size cut-offs globally at each "
      + 'review and does not publish them in advance, so this is an assumption, not MSCI\'s rule.',
  },
  observed: {
    key: 'observed',
    label: 'observed from current constituents',
    detail:
      'Measured from where MSCI has actually placed companies today, read off the three funds\' own '
      + 'holdings. It moves when the constituents move.',
  },
  msci: {
    key: 'msci',
    label: "MSCI's published rule",
    detail:
      'A ratio MSCI publishes in the GIMI Methodology, cited to a page. The RATIO is MSCI\'s; the '
      + 'rupee figure it is applied to is ours, derived from the constituents we can see.',
  },
};

const median = (sorted) => (sorted.length ? sorted[Math.floor(sorted.length / 2)] : null);
const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null);

/**
 * Measure the boundary from the current constituents.
 *
 * @param {Array} companies  every company in the record
 * @param {(c) => string} segmentOf
 * @returns {object} the observed boundary, with the companies that define it
 */
export function observedBoundary(companies, segmentOf) {
  const priced = companies.filter((c) => c.freeFloatMcapInr !== null && c.freeFloatMcapInr !== undefined);

  const standard = priced.filter((c) => segmentOf(c) === 'standard');
  const smallCap = priced.filter((c) => segmentOf(c) === 'smallcap');
  const outside = priced.filter((c) => segmentOf(c) === 'outside');

  const byFloat = (a, b) => a.freeFloatMcapInr - b.freeFloatMcapInr;
  const stdSorted = [...standard].sort(byFloat);
  const scSorted = [...smallCap].sort(byFloat);

  const standardFloorCompany = stdSorted[0] ?? null;
  const smallCapCeilingCompany = scSorted[scSorted.length - 1] ?? null;
  const standardFloor = standardFloorCompany?.freeFloatMcapInr ?? null;
  const smallCapCeiling = smallCapCeilingCompany?.freeFloatMcapInr ?? null;

  // The rank cutoff: how many names MSCI currently has in Standard.
  const standardCount = standard.length;
  const universeRanked = [...priced].sort((a, b) => b.freeFloatMcapInr - a.freeFloatMcapInr);
  const rankCutoffCompany = universeRanked[standardCount - 1] ?? null;

  const overlapLow = standardFloor;
  const overlapHigh = smallCapCeiling;
  const hasOverlap = standardFloor !== null && smallCapCeiling !== null && smallCapCeiling > standardFloor;
  const inOverlap = hasOverlap
    ? priced.filter((c) => c.freeFloatMcapInr >= overlapLow && c.freeFloatMcapInr <= overlapHigh)
    : [];

  return {
    standardCount,
    smallCapCount: smallCap.length,
    outsideCount: outside.length,

    standardFloorInr: standardFloor,
    standardFloorCompany: standardFloorCompany
      ? { name: standardFloorCompany.name, nseSymbol: standardFloorCompany.nseSymbol }
      : null,
    smallCapCeilingInr: smallCapCeiling,
    smallCapCeilingCompany: smallCapCeilingCompany
      ? { name: smallCapCeilingCompany.name, nseSymbol: smallCapCeilingCompany.nseSymbol }
      : null,

    hasOverlap,
    overlapLowInr: hasOverlap ? overlapLow : null,
    overlapHighInr: hasOverlap ? overlapHigh : null,
    overlapWidthInr: hasOverlap ? overlapHigh - overlapLow : null,
    overlapRatio: hasOverlap ? smallCapCeiling / standardFloor : null,
    overlapCount: inOverlap.length,
    overlapBySegment: {
      standard: inOverlap.filter((c) => segmentOf(c) === 'standard').length,
      smallcap: inOverlap.filter((c) => segmentOf(c) === 'smallcap').length,
      outside: inOverlap.filter((c) => segmentOf(c) === 'outside').length,
    },

    // The non-circular discriminator.
    rankCutoffInr: rankCutoffCompany?.freeFloatMcapInr ?? null,
    rankCutoffCompany: rankCutoffCompany
      ? { name: rankCutoffCompany.name, nseSymbol: rankCutoffCompany.nseSymbol }
      : null,

    // Robustness context: the floor is a single company, so a percentile says
    // how exposed it is to one outlier.
    standardP5Inr: percentile(stdSorted.map((c) => c.freeFloatMcapInr), 0.05),
    standardMedianInr: median(stdSorted.map((c) => c.freeFloatMcapInr)),
    smallCapMedianInr: median(scSorted.map((c) => c.freeFloatMcapInr)),
    outsideMedianInr: median([...outside].sort(byFloat).map((c) => c.freeFloatMcapInr)),
  };
}

/**
 * Rank every company by free-float market cap, so the rank-crossing test can
 * ask "is this company inside the top N?" without re-sorting per company.
 * @returns {Map<string, number>} company key -> 1-based rank
 */
export function rankByFreeFloat(companies, keyOf) {
  const ranked = companies
    .filter((c) => c.freeFloatMcapInr !== null && c.freeFloatMcapInr !== undefined)
    .sort((a, b) => b.freeFloatMcapInr - a.freeFloatMcapInr);
  const ranks = new Map();
  ranked.forEach((c, i) => ranks.set(keyOf(c), i + 1));
  return ranks;
}

/**
 * ---------------------------------------------------------------------------
 * THE SIZE-SEGMENT CUTOFFS, DERIVED BY RANK AGAINST THE CONSTITUENT COUNT
 * ---------------------------------------------------------------------------
 * MSCI's size-segment cutoff is a FULL market cap (GIMI p. 28) — the full market
 * cap of the last company counted before cumulative FREE FLOAT reaches the
 * coverage target. `gimi.js` implements that walk, and on our universe it lands
 * in the wrong place by a wide margin. Measured on the record of 28 Aug 2026:
 *
 *   | cutoff derived by | companies at or above it | constituents MSCI holds |
 *   | ---               | ---                      | ---                     |
 *   | coverage walk, Standard 85% | 306            | 165                     |
 *   | coverage walk, IMI 99%      | 1,016          | 623                     |
 *
 * The walk is not wrong; it is being run over the wrong universe. MSCI's targets
 * are 85% and 99% of the **Market Investable Equity Universe** — what survives
 * MSCI's liquidity (ATVR, p. 19), foreign-room (p. 21), length-of-trading and
 * minimum-size screens. We run them over every company BSE lists above the
 * desk's ₹2,000 Cr floor, so cumulative free float reaches 99% far deeper down
 * the list than it does for MSCI, and the cutoff comes out roughly 1.6–1.9×
 * too low.
 *
 * The consequence is not subtle. Apply MSCI's 2/3 lower buffer to an IMI cutoff
 * of ₹3,345 Cr and the deletion bar sits at ₹2,230 Cr — below which exactly
 * THREE Small Cap constituents fall, and none of the three left the index in
 * August 2026. That is why the GIMI model calls every one of the review's 18
 * exits `stable`.
 *
 * ---------------------------------------------------------------------------
 * SO THE COUNT IS OBSERVED AND THE RATIOS ARE MSCI'S
 * ---------------------------------------------------------------------------
 * How many India names MSCI currently holds in Standard, and how many in IMI, is
 * not something we have to estimate: it is on the holdings files. So the cutoff
 * is the Nth company by FULL market cap across the WHOLE record, where N is that
 * count — the same non-circular rank crossing the Standard boundary already
 * used, moved onto the size measure MSCI actually cuts on, and extended to the
 * IMI boundary.
 *
 * ⚠ THE Nth COMPANY IS DRAWN FROM THE WHOLE UNIVERSE, NEVER FROM ONE SEGMENT.
 * A cutoff read off the constituents alone would be the guard-reads-its-own-
 * threshold trap in CLAUDE.md §3.8: the smallest Standard constituent IS the
 * Standard floor, so no Standard constituent could ever be below it and the test
 * could never fire.
 *
 * Ranking the whole record instead — constituents and unheld companies together —
 * is what lets a constituent be overtaken. Which company happens to sit at rank N
 * is incidental and it is often a constituent (Yes Bank at 166 and Saregama at
 * 622 on the record of 31 Aug 2026); what matters is that the list it is drawn
 * from is not the segment being tested. The proof the test can fire is that it
 * does: 23 of 458 Small Cap constituents sit below the deletion buffer on that
 * same record, and 5 of 167 Standard constituents below the migration one.
 *
 * Everything applied to these two numbers afterwards is MSCI's, cited to a page:
 * the 2/3 lower buffer, the 1.5× entry buffer (pp. 44–45), the 50% minimum
 * free-float test with 2/3 relief for incumbents (pp. 30, 45) and the 0.15 FIF
 * floor (pp. 21, 45).
 *
 * @param {Array} companies  every company in the record
 * @param {(c) => string} segmentOf
 * @returns {object} the two cutoffs, the counts behind them, and the companies
 *                   that define them
 */
export function observedSizeCutoffs(companies, segmentOf) {
  // Both a full market cap AND a free float, because a company missing either
  // cannot be ranked and must not be ranked as a zero — a fabricated zero would
  // sort to the bottom of the list the cutoff is read off and drag it down
  // (CLAUDE.md §2.3).
  const measurable = companies.filter((c) => Number.isFinite(c.fullMcapInr) && Number.isFinite(c.freeFloatMcapInr));
  const excluded = companies.length - measurable.length;

  const ranked = [...measurable].sort((a, b) => b.fullMcapInr - a.fullMcapInr);
  const standardCount = measurable.filter((c) => segmentOf(c) === 'standard').length;
  const smallCapCount = measurable.filter((c) => segmentOf(c) === 'smallcap').length;
  const imiCount = standardCount + smallCapCount;

  const at = (n) => (n >= 1 && n <= ranked.length ? ranked[n - 1] : null);
  const describe = (company) => (company
    ? {
      inr: company.fullMcapInr,
      company: { name: company.name, nseSymbol: company.nseSymbol ?? null },
      segment: segmentOf(company),
    }
    : { inr: null, company: null, segment: null });

  return {
    basis: 'full market cap, which is the quantity MSCI expresses a size-segment cutoff in (GIMI p. 28)',
    rankedCount: ranked.length,
    excludedForMissingSize: excluded,
    standardCount,
    smallCapCount,
    imiCount,
    standard: describe(at(standardCount)),
    imi: describe(at(imiCount)),
  };
}

/**
 * Rank every company by FULL market cap. The companion to `rankByFreeFloat`,
 * kept separate rather than parameterised so a caller cannot silently rank by
 * one quantity while naming the other.
 * @returns {Map<string, number>} company key -> 1-based rank
 */
export function rankByFullMcap(companies, keyOf) {
  const ranked = companies
    .filter((c) => Number.isFinite(c.fullMcapInr))
    .sort((a, b) => b.fullMcapInr - a.fullMcapInr);
  const ranks = new Map();
  ranked.forEach((c, i) => ranks.set(keyOf(c), i + 1));
  return ranks;
}
