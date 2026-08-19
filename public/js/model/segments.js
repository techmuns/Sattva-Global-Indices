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

/** Segment from the holdings alone. */
export function segmentOf(company) {
  if (company?.funds?.[STANDARD_FUND]) return 'standard';
  if (SMALLCAP_FUNDS.some((f) => company?.funds?.[f])) return 'smallcap';
  return 'outside';
}

/** Does EM Small-Cap currently sample this company? Never assume it does. */
export const isSampledByEmSmallCap = (company) => Boolean(company?.funds?.[SMALLCAP_SAMPLING_FUND]);

/**
 * Re-check the disjointness the derivation rests on.
 * @returns {{ok: boolean, violations: Array, counts: object}}
 */
export function assertDisjoint(companies) {
  const violations = [];
  for (const company of companies) {
    const inStandard = Boolean(company.funds?.[STANDARD_FUND]);
    const inSmallCap = SMALLCAP_FUNDS.some((f) => company.funds?.[f]);
    if (inStandard && inSmallCap) {
      violations.push({
        isin: company.isin,
        name: company.name,
        funds: Object.entries(company.funds ?? {}).filter(([, v]) => v).map(([k]) => k),
      });
    }
  }

  const counts = { standard: 0, smallcap: 0, outside: 0 };
  for (const company of companies) counts[segmentOf(company)] += 1;

  const smin = new Set(companies.filter((c) => c.funds?.smin).map((c) => c.isin));
  const eems = companies.filter((c) => c.funds?.eems);
  const emScNotInIndiaSc = eems.filter((c) => !smin.has(c.isin));

  return {
    ok: violations.length === 0,
    violations,
    counts,
    emSmallCapIsSubset: emScNotInIndiaSc.length === 0,
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
