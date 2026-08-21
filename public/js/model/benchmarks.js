/**
 * benchmarks.js — how a fund's own basket has moved, in rupees.
 *
 * Pure. No fetching, no clock. The build and the browser share it so a return
 * shown on screen is the same arithmetic the verdict was computed from.
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING TO GET RIGHT: THESE FUNDS ARE PRICED IN DOLLARS
 * ---------------------------------------------------------------------------
 * A free-float market cap is in rupees. SMIN, EEMS and EEM quote in USD, so
 * their headline return folds in the INR/USD move. Measured 20 Aug 2026, SMIN
 * was -3.62% over a year in dollars and +5.44% in rupees: the sign flips.
 *
 * An ETF's price is the rupee value of its basket expressed in dollars,
 *
 *     price_usd = basket_inr / usdinr    =>    basket_inr = price_usd × usdinr
 *
 * so a rupee return multiplies each end of the window by that date's rate. Both
 * halves of each product come from the same date; nothing is ever divided
 * across two sources or two moments.
 */

/** The three funds, and the ticker whose price stands in for each one's basket. */
export const FUND_BENCHMARKS = [
  {
    id: 'eem',
    symbol: 'EEM',
    name: 'iShares MSCI Emerging Markets ETF',
    tracks: 'MSCI Emerging Markets Index',
  },
  {
    id: 'smin',
    symbol: 'SMIN',
    name: 'iShares MSCI India Small-Cap ETF',
    tracks: 'MSCI India Small Cap Index',
  },
  {
    id: 'eems',
    symbol: 'EEMS',
    name: 'iShares MSCI Emerging Markets Small-Cap ETF',
    tracks: 'MSCI Emerging Markets Small Cap Index',
  },
];

/** `[{date, close}]` -> `Map(date -> close)`. */
export function seriesToMap(series) {
  const map = new Map();
  for (const point of series ?? []) map.set(point.date, point.close);
  return map;
}

/**
 * The FX rate for a date, walking back up to `maxBack` days.
 *
 * A fund can trade on a day the FX series has no point for, and the other way
 * round. Walking back to the last known rate is right; interpolating forward
 * would use a rate that did not exist yet.
 *
 * Returns `null` rather than a guess when nothing is in range — 2.3.
 */
export function rateOn(fxMap, date, maxBack = 7) {
  if (!fxMap || !date) return null;
  const cursor = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime())) return null;
  for (let i = 0; i <= maxBack; i += 1) {
    const key = cursor.toISOString().slice(0, 10);
    if (fxMap.has(key)) return { rate: fxMap.get(key), on: key };
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return null;
}

/**
 * Percentage return over the last `tradingDays` points of a series.
 *
 * Pass `fxMap` to get the return in RUPEES; pass null to get it in the fund's
 * own currency. Returns null when either end is missing — never 0, which would
 * read as "the segment did not move".
 */
export function returnBetween(series, tradingDays, fxMap) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const last = series[series.length - 1];
  const firstIndex = Math.max(0, series.length - 1 - tradingDays);
  const first = series[firstIndex];
  if (!first || !last || !(first.close > 0) || !(last.close > 0)) return null;
  if (first.date === last.date) return null;
  return percentChange(first, last, fxMap);
}

/**
 * Percentage return from the last close on or before `fromDate` to the end of
 * the series. This is the window a review actually cares about: how far the
 * segment has moved since the last time MSCI set its cut-offs.
 */
export function returnSince(series, fromDate, fxMap) {
  if (!Array.isArray(series) || series.length < 2 || !fromDate) return null;
  let first = null;
  for (const point of series) {
    if (point.date <= fromDate) first = point;
    else break;
  }
  const last = series[series.length - 1];
  if (!first || !last || first.date === last.date) return null;
  if (!(first.close > 0) || !(last.close > 0)) return null;
  return percentChange(first, last, fxMap);
}

/** The date of the point `returnSince` would measure from, for disclosure. */
export function anchorDateFor(series, fromDate) {
  let first = null;
  for (const point of series ?? []) {
    if (point.date <= fromDate) first = point;
    else break;
  }
  return first?.date ?? null;
}

function percentChange(first, last, fxMap) {
  if (!fxMap) return ((last.close / first.close) - 1) * 100;
  const a = rateOn(fxMap, first.date);
  const b = rateOn(fxMap, last.date);
  if (!a || !b || !(a.rate > 0) || !(b.rate > 0)) return null;
  return (((last.close * b.rate) / (first.close * a.rate)) - 1) * 100;
}

/**
 * Everything a fund's benchmark contributes to the record, in one object.
 *
 * `sinceLastReview` is the load-bearing one: it is what the desk's rupee bands
 * are floated by. The rest are context.
 */
export function summarise(fund, fxMap, lastReviewEffectiveDate) {
  const series = fund.series ?? [];
  const inr = (days) => round(returnBetween(series, days, fxMap));
  const usd = (days) => round(returnBetween(series, days, null));

  const sinceInr = round(returnSince(series, lastReviewEffectiveDate, fxMap));
  const sinceUsd = round(returnSince(series, lastReviewEffectiveDate, null));

  return {
    fundId: fund.fundId,
    symbol: fund.symbol,
    name: fund.name,
    lastClose: fund.lastClose,
    // In RUPEES. This is the one the model uses.
    returnInrPct: { oneDay: inr(1), oneMonth: inr(21), threeMonths: inr(63), oneYear: inr(250) },
    // The quoted, dollar return. Kept beside it so the FX contribution is
    // visible rather than buried — they differ by 9 to 13 points over a year.
    returnUsdPct: { oneDay: usd(1), oneMonth: usd(21), threeMonths: usd(63), oneYear: usd(250) },
    sinceLastReview: {
      effectiveDate: lastReviewEffectiveDate,
      measuredFrom: anchorDateFor(series, lastReviewEffectiveDate),
      inrPct: sinceInr,
      usdPct: sinceUsd,
      fxContributionPp: sinceInr === null || sinceUsd === null ? null : round(sinceInr - sinceUsd),
    },
  };
}

const round = (value) => (value === null || value === undefined ? null : Number(value.toFixed(3)));
