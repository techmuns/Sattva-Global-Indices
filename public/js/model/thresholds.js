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
