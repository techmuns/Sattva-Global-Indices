/**
 * cutoff-measure.mjs — measure how uncertain the size cutoffs actually are.
 *
 * The model in public/js/model/cutoff-uncertainty.js turns measured components
 * into scenarios and a band. This is where the components are MEASURED, and it
 * lives under scripts/ for one reason: two of the three need the 2 MB of price
 * history, which the browser never downloads. What crosses into the record is
 * three pairs of dimensionless multipliers, so the browser can rebuild the same
 * scenarios against a live cutoff without the file behind them.
 *
 * ⚠ NOTHING HERE IS TYPED. Every figure is read off price-history.json,
 * corporate-actions.json or a page of MSCI's methodology. A hand-set band would
 * be the exact failure this feature exists to remove — false precision — with
 * an extra layer of authority on top.
 *
 * ⚠ AND A COMPONENT THAT COULD NOT BE MEASURED IS NOT A MULTIPLIER OF 1.
 * It comes back `applies: false` with its reason in words (§2.4). A silent 1
 * would narrow the band to exactly the degree we failed to look, and the
 * narrowing would read as confidence.
 */

/**
 * Re-derive the two size cutoffs as they stood on one past session.
 *
 * ⚠ THE SHARE COUNT MOVES WITH THE PRICE ACROSS A CORPORATE ACTION, and
 * forgetting that is a clean 2x error on a bonus. BSE carries closes
 * unadjusted (§3.8.1), so the close on a pre-bonus day is struck on the
 * pre-bonus share count: shares(d) = shares(today) / priceFactor, exactly
 * cancelling the price it is multiplied by. Skipping the division would report
 * a company as twice its real historical size and drag the whole ranking with
 * it.
 *
 * ⚠ THE INTERVAL IS HALF-OPEN AT THE OLD END. An action ex-dated ON `date` is
 * already inside that day's close, so it must not be unwound again; one ex-dated
 * on the latest session must be. Hence `exDate > date && exDate <= latestDate` —
 * the same bound §2.12.3 spells out for the rebalance baseline, and not the
 * window function's interval.
 *
 * @returns {{date, standardInr, imiInr, ranked, standardCount, imiCount,
 *            noPrice, unquantifiable}}
 */
export function cutoffsOnDate({ date, companies, priceHistory, corporateActions, latestDate, segmentOf }) {
  const index = priceHistory.dates.indexOf(date);
  if (index < 0) return null;

  const rows = [];
  let noPrice = 0;
  let unquantifiable = 0;

  for (const company of companies) {
    const code = company.bseScripCode != null ? String(company.bseScripCode) : null;
    const scrip = code ? priceHistory.scrips[code] : null;
    const close = scrip ? scrip.closes[index] : null;
    if (!(close > 0) || !Number.isFinite(company.sharesOutstanding) || !Number.isFinite(company.floatFactor)) {
      noPrice += 1;
      continue;
    }
    const record = code ? corporateActions.scrips[code] : null;
    const between = (record?.actions ?? []).filter((a) => a.exDate && a.exDate > date && a.exDate <= latestDate);
    if (between.some((a) => !a.quantifiable)) {
      // An action we cannot size is not an action of 1.0 (§3.8.1). The company
      // leaves this scenario's ranking and is counted, never zeroed.
      unquantifiable += 1;
      continue;
    }
    const factor = between.reduce((product, a) => product * a.priceFactor, 1);
    const shares = company.sharesOutstanding / factor;
    rows.push({ company, fullMcapInr: shares * close });
  }

  rows.sort((a, b) => b.fullMcapInr - a.fullMcapInr);
  const standardCount = rows.filter((r) => segmentOf(r.company) === 'standard').length;
  const smallCapCount = rows.filter((r) => segmentOf(r.company) === 'smallcap').length;
  const imiCount = standardCount + smallCapCount;
  const at = (n) => (n >= 1 && n <= rows.length ? rows[n - 1].fullMcapInr : null);

  return {
    date,
    ranked: rows.length,
    noPrice,
    unquantifiable,
    standardCount,
    imiCount,
    standardInr: at(standardCount),
    imiInr: at(imiCount),
  };
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const round = (v, dp = 6) => (Number.isFinite(v) ? Number(v.toFixed(dp)) : null);

/** Per-day cutoffs across one MSCI price window, plus the window's own spread. */
function measureWindow(window, args) {
  const days = window.dates
    .map((date) => cutoffsOnDate({ ...args, date }))
    .filter((d) => d && Number.isFinite(d.imiInr) && Number.isFinite(d.standardInr));
  if (days.length < 2) return null;
  const summarise = (field) => {
    const values = days.map((d) => d[field]);
    const avg = mean(values);
    return { min: Math.min(...values), max: Math.max(...values), mean: avg };
  };
  return {
    review: window.review,
    from: window.from,
    to: window.to,
    sessionsMeasured: days.length,
    sessionsInWindow: window.dates.length,
    standard: summarise('standardInr'),
    imi: summarise('imiInr'),
    days: days.map((d) => ({ date: d.date, standardInr: d.standardInr, imiInr: d.imiInr, ranked: d.ranked })),
  };
}

/**
 * COMPONENT 1 — the day MSCI priced on, which it does not publish (GIMI p. 49).
 *
 * Multipliers are the window's own min and max against its own mean, so they are
 * a DISPERSION and can be applied to a cutoff struck on a different day. Using
 * the window's raw rupee figures instead would replace today's bar with July's,
 * which is a different (and much larger) claim.
 */
function priceDayComponent(config, newest) {
  if (!newest) {
    return {
      ...config,
      applies: false,
      reason: 'No completed MSCI price window in the record could be re-priced, so the day-choice '
        + 'spread has not been measured. It is not zero; it is unmeasured.',
    };
  }
  const ratio = (side) => ({
    low: round(side.min / side.mean),
    high: round(side.max / side.mean),
  });
  return {
    ...config,
    applies: true,
    measuredOn: { review: newest.review, from: newest.from, to: newest.to, sessions: newest.sessionsMeasured },
    standard: ratio(newest.standard),
    imi: ratio(newest.imi),
    spreadPct: {
      standard: round(((newest.standard.max / newest.standard.min) - 1) * 100, 3),
      imi: round(((newest.imi.max / newest.imi.min) - 1) * 100, 3),
    },
    days: newest.days,
  };
}

/**
 * COMPONENT 2 — our constituent count is a floor, so our cutoff is a ceiling.
 *
 * The scenario is the count at which our cutoff reaches the TOP of MSCI's
 * published Global Minimum Size Range (pp. 24, 26). One-sided and downward:
 * three sampling funds can omit a constituent but cannot invent one.
 *
 * ⚠ WHERE OUR CUTOFF IS ALREADY INSIDE THE PUBLISHED RANGE, NOTHING FIRES, and
 * the multiplier stays exactly 1 with `insideRange: true` on the record. That is
 * a corroboration and it is reported as one — it is not the same as a component
 * that could not be measured, so the two never share a field.
 */
function countComponent(config, { ranked, sizeCutoffs, reference, fxRate }) {
  if (!ranked?.length || !(fxRate > 0)) {
    return {
      ...config,
      applies: false,
      reason: !(fxRate > 0)
        ? "No USD/INR rate for the latest session, and MSCI's published range is in dollars — so our "
          + 'cutoff cannot be placed against it at all.'
        : 'The record carried no ranking to walk.',
    };
  }
  const usdM = (inr) => inr / fxRate / 1e6;
  const highUsdM = reference.rangeHighMultiple;

  const walk = (ourCount, referenceUsdM) => {
    const ourInr = ranked[ourCount - 1] ?? null;
    if (!Number.isFinite(ourInr)) return null;
    const ceiling = referenceUsdM * highUsdM;
    const ourUsdM = usdM(ourInr);
    if (ourUsdM <= ceiling) {
      return { insideRange: true, count: ourCount, inr: ourInr, ourUsdM: round(ourUsdM, 1), ceilingUsdM: round(ceiling, 1), multiple: 1 };
    }
    // The first N whose cutoff has fallen to the top of the published range.
    let count = null;
    for (let n = ourCount; n <= ranked.length; n += 1) {
      if (usdM(ranked[n - 1]) <= ceiling) { count = n; break; }
    }
    if (count === null) {
      return {
        insideRange: false, count: null, inr: null, ourUsdM: round(ourUsdM, 1), ceilingUsdM: round(ceiling, 1),
        multiple: null,
        note: 'No count inside the record reaches the top of the published range — the whole tracked '
          + 'universe sits above it, so this component is a floor on the correction rather than the '
          + 'correction itself.',
      };
    }
    return {
      insideRange: false, count, inr: ranked[count - 1],
      ourUsdM: round(ourUsdM, 1), ceilingUsdM: round(ceiling, 1),
      multiple: round(ranked[count - 1] / ourInr),
    };
  };

  const standard = walk(sizeCutoffs.standardCount, reference.emerging.standard);
  const imi = walk(sizeCutoffs.imiCount, reference.emerging.imi);
  if (!standard || !imi) {
    return { ...config, applies: false, reason: 'The record carried no company at one of the two constituent counts.' };
  }
  return {
    ...config,
    applies: true,
    fxRate: round(fxRate, 4),
    msciReferenceUsdM: { standard: reference.emerging.standard, imi: reference.emerging.imi },
    rangeHighMultiple: highUsdM,
    msciPages: [reference.page, 24],
    standard: { low: standard.multiple ?? 1, high: 1 },
    imi: { low: imi.multiple ?? 1, high: 1 },
    counts: { low: { standard: standard.count ?? null, imi: imi.count ?? null } },
    detail: { standard, imi },
  };
}

/**
 * COMPONENT 3 — the bar itself moves between reviews.
 *
 * ⚠ n = 1. The record holds two MSCI price windows, so there is exactly one
 * review-to-review move to measure. The magnitude is real and reproducible; the
 * DIRECTION of the next one is not knowable from a single observation, which is
 * why the scenario is applied both ways. Every surface that shows this says n=1
 * beside it.
 */
function driftComponent(config, windows) {
  if (windows.length < 2) {
    return {
      ...config,
      applies: false,
      reason: `Only ${windows.length} MSCI price window${windows.length === 1 ? ' is' : 's are'} on the `
        + 'record, and a review-to-review move needs two. Unmeasured, which is not the same as zero.',
    };
  }
  const [older, newer] = windows.slice(-2);
  const magnitude = (field) => {
    const ratio = newer[field].mean / older[field].mean;
    return Math.max(ratio, 1 / ratio);
  };
  const bounds = (field) => {
    const m = magnitude(field);
    return { low: round(1 / m), high: round(m) };
  };
  return {
    ...config,
    applies: true,
    observations: 1,
    from: { review: older.review, window: `${older.from}..${older.to}`, standardInr: older.standard.mean, imiInr: older.imi.mean },
    to: { review: newer.review, window: `${newer.from}..${newer.to}`, standardInr: newer.standard.mean, imiInr: newer.imi.mean },
    movePct: {
      standard: round(((newer.standard.mean / older.standard.mean) - 1) * 100, 3),
      imi: round(((newer.imi.mean / older.imi.mean) - 1) * 100, 3),
    },
    standard: bounds('standard'),
    imi: bounds('imi'),
  };
}

/**
 * Measure all three components.
 *
 * @returns {{measuredAt, windows, components, notes}} the block that goes onto
 *          the record as `model.cutoffUncertainty`, minus the scenarios and band
 *          which are derived from it by the shared model module.
 */
export function measureCutoffUncertainty({
  config, companies, priceHistory, corporateActions, latestDate, segmentOf, sizeCutoffs, reference, fxRate,
}) {
  const windows = [];
  if (priceHistory && corporateActions) {
    for (const window of priceHistory.windows ?? []) {
      const measured = measureWindow(window, { companies, priceHistory, corporateActions, latestDate, segmentOf });
      if (measured) windows.push(measured);
    }
  }
  const ranked = companies
    .filter((c) => Number.isFinite(c.fullMcapInr) && Number.isFinite(c.freeFloatMcapInr))
    .map((c) => c.fullMcapInr)
    .sort((a, b) => b - a);

  return {
    basis:
      'The band is the envelope of the scenarios below, each moving ONE measured component. It is not '
      + 'a confidence interval and carries no distributional claim.',
    attribution: config.attribution,
    disclosure: config.disclosure,
    vocabulary: config.vocabulary,
    windows: windows.map(({ days, ...rest }) => ({ ...rest, days })),
    components: [
      priceDayComponent(config.priceDay, windows[windows.length - 1] ?? null),
      countComponent(config.constituentCount, { ranked, sizeCutoffs, reference, fxRate }),
      driftComponent(config.reviewDrift, windows),
    ],
  };
}
