/**
 * msci-methodology.mjs — what MSCI's own methodology book actually says.
 *
 * ---------------------------------------------------------------------------
 * SOURCE, AND WHY EVERY VALUE HERE CARRIES A PAGE NUMBER
 * ---------------------------------------------------------------------------
 * MSCI Global Investable Market Indexes Methodology, **August 2026**, 192 pages,
 * fetched from https://www.msci.com/index/methodology/latest/GIMI on 24 Aug 2026.
 *
 * Everything in this file is quoted or derived from that document and cites the
 * page it came from. That is the point of the file: until now every threshold in
 * this project was the DESK'S HEURISTIC, correctly labelled as such. These are
 * different — they are MSCI's published rules, and the code must never blur the
 * two. `thresholds.mjs` holds the desk's numbers; this file holds MSCI's.
 *
 * ⚠ Having MSCI's rules is NOT the same as being able to APPLY them. Most of
 * them need the Market Investable Equity Universe — every listed company in
 * India that passes MSCI's investability screens, ranked by full market cap,
 * with MSCI's own free-float factors. We do not have that. What this file
 * enables is a model that is wrong in KNOWN ways rather than unknown ones, and
 * a screen that can say which MSCI rule a verdict is approximating.
 */

export const SOURCE = {
  document: 'MSCI Global Investable Market Indexes Methodology',
  edition: 'August 2026',
  pages: 192,
  url: 'https://www.msci.com/index/methodology/latest/GIMI',
  retrieved: '2026-08-24',
  note: 'MSCI publishes the methodology; it does NOT publish the resulting market '
    + 'size-segment cutoffs, the Market Investable Equity Universe, or its own free-float '
    + 'factors. The rules are public; the inputs that make them computable are not.',
};

/**
 * The indexes the three funds track, verbatim from the iShares fund pages.
 * Checked 24 Aug 2026 — SMIN's stated holding count (461) matches the India row
 * count in our committed workbook exactly.
 */
export const TRACKED_INDEXES = {
  eem: { index: 'MSCI Emerging Markets Index', segment: 'standard', holdings: 1196 },
  smin: { index: 'MSCI India Small Cap Index', segment: 'smallcap', holdings: 461 },
  eems: { index: 'MSCI Emerging Markets Small Cap Index', segment: 'smallcap', holdings: 1692 },
};

/**
 * Market coverage targets, in FREE-FLOAT-adjusted market capitalisation. (p. 24)
 *
 *   Large Cap  70% ± 5%
 *   Standard   85% ± 5%
 *   IMI        99% +1% / −0.5%
 *
 * Mid Cap is Standard minus Large Cap. Small Cap is IMI minus Standard — so the
 * Small Cap segment is a RESIDUAL, not a band. A company is in Small Cap because
 * it is in the Investable Market and not in Standard.
 */
export const COVERAGE_TARGETS = {
  largeCap: { target: 70, tolerance: 5, basis: 'free-float-adjusted market cap', page: 24 },
  standard: { target: 85, tolerance: 5, basis: 'free-float-adjusted market cap', page: 24 },
  imi: { target: 99, toleranceUp: 1, toleranceDown: 0.5, basis: 'free-float-adjusted market cap', page: 24 },
  smallCapIsResidual: 'IMI coverage minus Standard coverage',
};

/**
 * ⚠ THE DISTINCTION THIS PROJECT HAD WRONG
 *
 * The Market Size-Segment Cutoff is a **FULL market capitalisation** figure. The
 * 85% / 99% coverage targets are measured in **free-float-adjusted** market cap,
 * but the cutoff that comes out of the procedure — and every buffer around it —
 * is full market cap. From the worked example on p. 28:
 *
 *   "companies are counted in descending order of FULL market capitalization …
 *    until the cumulative FREE FLOAT-ADJUSTED market capitalization … reaches
 *    85% … the full market capitalization of the last company counted (USD 4.1
 *    billion) defines the Market Size-Segment Cutoff"
 *
 * Free float enters the size test only through a SEPARATE requirement — see
 * MIN_FREE_FLOAT_MCAP below.
 *
 * Our model compares FREE-FLOAT market cap against the desk's rupee bands. That
 * is one quantity where MSCI uses two, and it is the largest known gap between
 * this model and the index it forecasts.
 */
export const CUTOFF_BASIS = {
  ranking: 'full market capitalisation',
  coverageMeasure: 'free-float-adjusted market capitalisation',
  cutoffExpressedIn: 'full market capitalisation',
  page: 28,
};

/**
 * Buffer zones — how a company actually migrates between segments. (pp. 44–45)
 *
 * "An existing constituent is generally allowed to remain in its current
 *  size-segment even if its company full market capitalization falls below
 *  (above) the Market Size-Segment Cutoff … as long as it falls within a buffer
 *  zone … defined with boundaries of 2/3rd of and 1.5 times the Market
 *  Size-Segment Cutoff between two size-segments."
 *
 * So the rule is ASYMMETRIC and hysteretic:
 *   - an EXISTING constituent leaves only below 2/3 (−33%) of the cutoff;
 *   - a NON-constituent enters only above 1.5× (+50%) of the cutoff.
 *
 * That asymmetry is the whole reason a company can sit "in the index" and
 * "below the cutoff" at the same time without anything being wrong, and it is
 * why index turnover is far lower than a naive cutoff model predicts.
 *
 * Note how closely the desk's own heuristic tracks this shape: the desk's
 * inclusion floor over its exclusion floor is 3,500/2,000 = 1.75, against MSCI's
 * 1.5 / (2/3) = 2.25. The desk's bands are a rough hand-fit of the buffer
 * geometry — which is a point in the desk's favour, and still not the rule.
 */
export const BUFFERS = {
  lowerMultiple: 2 / 3,
  upperMultiple: 1.5,
  lowerLabel: '−33% (2/3 of the cutoff)',
  upperLabel: '+50% (1.5× the cutoff)',
  page: 44,
  named: [
    'Large Cap Lower Buffer (−33%)',
    'Mid Cap / Standard Lower Buffer (−33%)',
    'Small Cap Lower Buffer (−33%)',
    'Mid Cap Upper Buffer (+50%)',
    'Small Cap Upper Buffer (+50%)',
    'Small Cap Entry Buffer (+50%)',
  ],
  /**
   * The Small Cap Entry Buffer has a second condition that pure geometry misses
   * (p. 44): a non-constituent above 1.5× the IMI cutoff is added "only to the
   * extent that they replace current constituents which have fallen below the
   * Small Cap Lower Buffer".
   *
   * Index entry is therefore COMPETITIVE, not absolute. Clearing the bar makes a
   * company eligible; it does not make it included. Nothing in our model can see
   * this, and it is why an "inclusion" verdict here can only ever be a candidacy.
   */
  smallCapEntryIsReplacementBased: true,
};

/**
 * Final size-segment investability requirements, on FREE FLOAT. (pp. 30, 45)
 *
 * New constituents: free-float-adjusted market cap ≥ 50% of the Market
 * Size-Segment Cutoff. Existing constituents may stay at 2/3 of that threshold.
 *
 * This is the rule the desk's rupee bands most plausibly approximate: if India's
 * IMI cutoff were around ₹4,000 Cr of full market cap, the new-entrant free-float
 * requirement would be ₹2,000 Cr — the desk's exclusion floor exactly.
 */
export const MIN_FREE_FLOAT_MCAP = {
  newConstituentMultipleOfCutoff: 0.5,
  existingConstituentRelief: 2 / 3,
  pages: [30, 45],
};

/**
 * Foreign Inclusion Factor floor. (pp. 21, 45)
 * A security generally needs FIF ≥ 0.15 to be in the Market Investable Equity
 * Universe, and an existing Small Cap constituent must keep FIF ≥ 0.15 to remain.
 *
 * FIF is NOT the same as an exchange's free-float factor: it also carries foreign
 * ownership limits. For most Indian companies the two are close; for those near a
 * sectoral FDI cap they are not.
 */
export const MIN_FIF = { floor: 0.15, pages: [21, 45] };

/** EM minimum liquidity, at the security level. (p. 19) */
export const EM_LIQUIDITY = {
  atvr3MonthPct: 15,
  atvr12MonthPct: 15,
  frequencyOfTrading3MonthPct: 80,
  overConsecutiveQuarters: 4,
  page: 19,
  note: 'ATVR is the Annualised Traded Value Ratio. We hold a 3-month ADV from a '
    + 'third party, which is not the same measure and cannot be substituted for it.',
};

/**
 * Global Minimum Size Reference, from the August 2026 book (p. 26), on data as
 * of the close of 20 July 2026. USD millions, FULL market capitalisation.
 *
 * The EM figures are defined as exactly one half of the DM figures (p. 25).
 * The Global Minimum Size RANGE is 0.5× to 1.15× the Reference (p. 24), and a
 * market's cutoff is placed inside that range.
 *
 * These are a snapshot that MOVES AT EVERY REVIEW. They are recorded with their
 * as-of date for exactly that reason; anything reading them must show the date.
 */
export const GLOBAL_MIN_SIZE_REFERENCE = {
  asOf: '2026-07-20',
  edition: 'August 2026',
  currency: 'USD',
  unit: 'millions',
  page: 26,
  rangeLowMultiple: 0.5,
  rangeHighMultiple: 1.15,
  developed: { largeCap: 53878, standard: 16276, imi: 1234 },
  emerging: { largeCap: 26939, standard: 8138, imi: 617 },
  frontier: { largeCap: 1283, standard: 473, imi: 31 },
  statedStandardRangeEm: { lowUsdBn: 4.07, highUsdBn: 9.36, page: 25 },
};

/**
 * Index review timetable. (p. 49)
 *
 * ⚠ This replaces an assumption this project carried as "unconfirmed". The
 * cutoff dates are published and specific:
 *
 *   Equity Universe Cutoff  last business day of the month THREE months before
 *   Liquidity Cutoff        last business day of the month TWO months before
 *   Price Cutoff            ANY ONE of the last 10 business days of the month
 *                           BEFORE the review month — MSCI does not say which
 *
 * The price consequence is large and this project had it wrong. The market cap
 * that decides the August review was struck somewhere in the last 10 business
 * days of JULY. By the time the review is announced, the deciding price is weeks
 * old — so a verdict computed on today's price is answering a question MSCI has
 * already stopped asking.
 *
 * Since the February 2023 review all four reviews are comprehensive (p. 152).
 * Before that, May and November were Semi-Annual Index Reviews and February and
 * August were lighter Quarterly Index Reviews. Our calendar treats all four
 * alike, which is correct for the current methodology and wrong for history.
 */
export const REVIEW_TIMETABLE = {
  page: 49,
  allFourAreComprehensiveSince: '2023-02',
  cutoffs: {
    equityUniverse: { monthsBefore: 3, day: 'last business day' },
    liquidity: { monthsBefore: 2, day: 'last business day' },
    price: { monthsBefore: 1, day: 'any one of the last 10 business days', mscisChoiceIsUndisclosed: true },
  },
  reviewMonths: [2, 5, 8, 11],
};
