/**
 * segments.js — which MSCI size segment a company sits in, derived not assumed.
 *
 * ---------------------------------------------------------------------------
 * THE SEGMENTS ARE STRICTLY DISJOINT, AND THAT IS MEASURED
 * ---------------------------------------------------------------------------
 * Across the three holdings files, on the committed data:
 *
 *     EM ∩ India SC = 0      EM ∩ EM SC = 0      India SC ∩ EM SC = 408
 *
 * No company is held by the EM ETF and by either small-cap fund. So membership
 * is derivable from the holdings alone and needs no assumption:
 *
 *     held by the EM ETF                     -> MSCI India Standard (large + mid)
 *     held by India SC and/or EM SC          -> MSCI India Small Cap
 *     held by none of the three              -> outside MSCI India IMI
 *
 * `assertDisjoint` re-checks this on every build rather than trusting it. If a
 * future holdings file breaks the pattern, the derivation is invalid and the
 * build must say so rather than silently picking a segment.
 *
 * ⚠ THE AUGUST 2026 FILES BROKE IT, EXACTLY AS THAT SENTENCE ANTICIPATED, and
 * the two breaks are different facts. Laurus Labs is in EEM (31 Aug) and EEMS
 * (17 Aug) because it migrated up and the older file has not caught up. Astral
 * is in EEM at 0.0002% and SMIN at 0.4387%, both dated 31 Aug — a migration
 * caught mid-trade, the leg it is leaving nearly unwound.
 *
 * So membership is still derived from the holdings, with one added rule from
 * config/thresholds.mjs → SEGMENT_OVERLAP: the NEWEST file that names the
 * company decides, and a tie is settled by the larger position. Both legs stay
 * on the record in `segmentOverlap` so the reader sees the overlap rather than
 * a segment that quietly picked a side.
 *
 * ---------------------------------------------------------------------------
 * EM SMALL-CAP IS A STRICT SUBSET OF INDIA SMALL-CAP, AND THIS CHANGES FLOWS
 * ---------------------------------------------------------------------------
 * EM SC holds 408 of India SC's 454 India companies and ZERO that India SC
 * lacks. It SAMPLES the segment rather than replicating it.
 *
 * So a company entering MSCI India Small Cap draws a flow from the India
 * Small-Cap ETF FOR CERTAIN, and from EM Small-Cap ONLY IF that fund samples
 * it. A company EM SC does not currently hold has no basis for an EM SC entry
 * estimate — the honest output is "not sampled", never zero.
 */

import { SEGMENT_OVERLAP } from '../config/thresholds.mjs';

/** The three funds, and what holding one implies. */
export const SEGMENTS = {
  standard: {
    key: 'standard',
    label: 'MSCI India Standard',
    detail: 'Large and mid cap. Tracked here by the iShares MSCI Emerging Markets ETF.',
    funds: ['eem'],
  },
  smallcap: {
    key: 'smallcap',
    label: 'MSCI India Small Cap',
    detail:
      'Tracked here by the iShares MSCI India Small-Cap ETF, which replicates it, and by the '
      + 'EM Small-Cap ETF, which samples it.',
    funds: ['smin', 'eems'],
  },
  outside: {
    key: 'outside',
    label: 'Outside MSCI India IMI',
    detail: 'Held by none of the three funds. A candidate for entry, not a constituent.',
    funds: [],
  },
};

export const STANDARD_FUND = 'eem';
export const SMALLCAP_FUNDS = ['smin', 'eems'];
/** The fund that REPLICATES the small-cap segment; the other samples it. */
export const SMALLCAP_REPLICATING_FUND = 'smin';
export const SMALLCAP_SAMPLING_FUND = 'eems';

/**
 * Segment from the holdings alone.
 *
 * `asOfByFund` maps fund id to the date of the workbook it came from. Pass it
 * and an overlap is settled by evidence — newest file first, larger position on
 * a tie. Omit it and the tie-break falls back to position size alone, which is
 * what a caller with only one date can honestly do.
 */
export function segmentOf(company, asOfByFund = null) {
  // ONE DECISION, MADE ONCE, WITH THE EVIDENCE. An overlap is settled using the
  // per-fund workbook dates, which only the build has; the answer is written
  // onto the record as `segment`. Every later reader — assess(), gimi(), the
  // boundary — honours it rather than re-deriving without the dates and
  // quietly disagreeing with the record about two companies.
  if (typeof company?.segment === 'string' && SEGMENTS[company.segment]) return company.segment;
  const inStandard = Boolean(company?.funds?.[STANDARD_FUND]);
  const smallCapFund = SMALLCAP_FUNDS.find((f) => company?.funds?.[f]);
  if (inStandard && smallCapFund === undefined) return 'standard';
  if (!inStandard && smallCapFund !== undefined) return 'smallcap';
  if (!inStandard && smallCapFund === undefined) return 'outside';
  return describeOverlap(company, asOfByFund).segment;
}

/** Market value of a company's position in one fund, or null when not held. */
const positionUsd = (company, fund) => company?.funds?.[fund]?.marketValueUsd ?? null;

/**
 * The overlap, spelled out: which leg won, on what evidence, and both legs.
 *
 * Returns `null` for the overwhelming majority of companies, which are in one
 * segment or none. Only a company in the EM ETF *and* a small-cap fund has an
 * overlap to describe.
 */
export function describeOverlap(company, asOfByFund = null) {
  const inStandard = Boolean(company?.funds?.[STANDARD_FUND]);
  const smallCapFund = SMALLCAP_FUNDS.find((f) => company?.funds?.[f]);
  if (!inStandard || smallCapFund === undefined) return null;

  const standardAsOf = asOfByFund?.[STANDARD_FUND] ?? null;
  const smallCapAsOf = asOfByFund?.[smallCapFund] ?? null;
  const standardUsd = positionUsd(company, STANDARD_FUND);
  const smallCapUsd = positionUsd(company, smallCapFund);

  // 1. THE NEWEST FILE DECIDES. Newer evidence about membership beats older
  //    evidence, and a stale sibling is the commonest reason for an overlap.
  let segment;
  let basis;
  if (standardAsOf && smallCapAsOf && standardAsOf !== smallCapAsOf) {
    segment = standardAsOf > smallCapAsOf ? 'standard' : 'smallcap';
    basis = 'newer-file';
  } else {
    // 2. SAME DATE: the larger position decides. A missing market value cannot
    //    win a size comparison it is not in — it loses to any real number.
    segment = (standardUsd ?? -1) >= (smallCapUsd ?? -1) ? 'standard' : 'smallcap';
    basis = 'larger-position';
  }

  const larger = Math.max(standardUsd ?? 0, smallCapUsd ?? 0);
  const smaller = Math.min(standardUsd ?? 0, smallCapUsd ?? 0);
  const residualPct = larger > 0 ? (smaller / larger) * 100 : null;

  return {
    segment,
    basis,
    standardFund: STANDARD_FUND,
    smallCapFund,
    standardAsOf,
    smallCapAsOf,
    standardMarketValueUsd: standardUsd,
    smallCapMarketValueUsd: smallCapUsd,
    // How small the losing leg is against the winning one. Below the desk's
    // residual share this reads as a trade being unwound rather than as a
    // second membership.
    residualSharePct: residualPct,
    datesDiffer: Boolean(standardAsOf && smallCapAsOf && standardAsOf !== smallCapAsOf),
    rule: SEGMENT_OVERLAP.rule,
    attribution: SEGMENT_OVERLAP.attribution,
  };
}

/** Does EM Small-Cap currently sample this company? Never assume it does. */
export const isSampledByEmSmallCap = (company) => Boolean(company?.funds?.[SMALLCAP_SAMPLING_FUND]);

/**
 * Re-check the disjointness the derivation rests on.
 *
 * ---------------------------------------------------------------------------
 * AN OVERLAP IS NOW CLASSIFIED, NOT MERELY COUNTED
 * ---------------------------------------------------------------------------
 * Two kinds are explained and one is not:
 *
 *   stale-sibling  the two funds' workbooks are dated differently, so the
 *                  overlap may be nothing but the gap between them. Real, and
 *                  not evidence that the segments overlap.
 *   residual       same date, and the losing leg is under the desk's residual
 *                  share of the winning one — a migration still unwinding.
 *   unexplained    same date, both legs substantial. THAT would mean the
 *                  segments genuinely are not disjoint and the derivation is
 *                  invalid. It still fails the build.
 *
 * ⚠ THE SUBSET CHECK CANNOT RUN ACROSS TWO DATES, and passing it anyway would
 * be worse than failing it. EM SC "holding a company India SC lacks" is exactly
 * what a stale EM SC file looks like after India SC drops nine companies at a
 * review. So when the two files disagree on date the result is `null` — not
 * true, not false — and the caller reports it as not measurable (§2.4).
 */
export function assertDisjoint(companies, asOfByFund = null) {
  const overlaps = [];
  for (const company of companies) {
    const overlap = describeOverlap(company, asOfByFund);
    if (!overlap) continue;
    const kind = overlap.datesDiffer
      ? 'stale-sibling'
      : (overlap.residualSharePct !== null && overlap.residualSharePct < SEGMENT_OVERLAP.residualShareOfLargerPct)
        ? 'residual'
        : 'unexplained';
    overlaps.push({
      isin: company.isin,
      name: company.name,
      kind,
      segment: overlap.segment,
      basis: overlap.basis,
      residualSharePct: overlap.residualSharePct,
      funds: Object.entries(company.funds ?? {}).filter(([, v]) => v).map(([k]) => k),
      asOf: { [overlap.standardFund]: overlap.standardAsOf, [overlap.smallCapFund]: overlap.smallCapAsOf },
    });
  }
  const unexplained = overlaps.filter((o) => o.kind === 'unexplained');

  const counts = { standard: 0, smallcap: 0, outside: 0 };
  for (const company of companies) counts[segmentOf(company, asOfByFund)] += 1;

  const smin = new Set(companies.filter((c) => c.funds?.smin).map((c) => c.isin));
  const eems = companies.filter((c) => c.funds?.eems);
  const emScNotInIndiaSc = eems.filter((c) => !smin.has(c.isin));

  const sminAsOf = asOfByFund?.[SMALLCAP_REPLICATING_FUND] ?? null;
  const eemsAsOf = asOfByFund?.[SMALLCAP_SAMPLING_FUND] ?? null;
  const comparable = !(sminAsOf && eemsAsOf) || sminAsOf === eemsAsOf;

  return {
    ok: unexplained.length === 0,
    overlaps,
    violations: unexplained,
    counts,
    // null means NOT MEASURABLE here, and it is neither a pass nor a failure.
    emSmallCapIsSubset: comparable ? emScNotInIndiaSc.length === 0 : null,
    emSmallCapSubsetComparable: comparable,
    emSmallCapSubsetAsOf: { [SMALLCAP_REPLICATING_FUND]: sminAsOf, [SMALLCAP_SAMPLING_FUND]: eemsAsOf },
    emSmallCapOnly: emScNotInIndiaSc.map((c) => ({ isin: c.isin, name: c.name })),
    emSmallCapSampled: eems.length,
    indiaSmallCapTotal: smin.size,
  };
}

/**
 * Total free-float market cap per segment — the denominator an entry's target
 * weight is estimated against. Only companies with a reading contribute; a
 * missing float is excluded, never treated as zero.
 */
export function segmentFloatTotals(companies) {
  const totals = { standard: 0, smallcap: 0, outside: 0 };
  const counts = { standard: 0, smallcap: 0, outside: 0 };
  for (const company of companies) {
    if (company.freeFloatMcapInr === null || company.freeFloatMcapInr === undefined) continue;
    const segment = segmentOf(company);
    totals[segment] += company.freeFloatMcapInr;
    counts[segment] += 1;
  }
  return { totals, counts };
}
