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

/**
 * The benchmarks, and the ticker whose price stands in for each one's basket.
 *
 * ---------------------------------------------------------------------------
 * THE FUND THAT HOLDS A STOCK IS NOT THE INDEX THAT DECIDES ITS SEGMENT
 * ---------------------------------------------------------------------------
 * These are two different jobs and conflating them was wrong in the same
 * direction for every large Indian company.
 *
 * A FLOW is about the fund that must trade: if a company's weight in EEM
 * changes, EEM's managers buy or sell, and EEM's AUM sizes the trade. That is
 * `holds`, and it is the fund from msci-funds.json.
 *
 * A SEGMENT MIGRATION is about the index that sorts companies into Standard and
 * Small Cap. That sorting happens inside MSCI INDIA — an Indian company is
 * ranked against other Indian companies, never against Taiwanese semiconductors.
 * That is `standsForSegment`.
 *
 * EEM does both jobs badly at once. It holds India's Standard names, so it is
 * the right fund for their flows. But it is ~11% India, so its return is mostly
 * a statement about somewhere else. Measured over the year to 19 Aug 2026:
 *
 *     EEM                              +45.52%   (in rupees)
 *     INDA                              +1.26%
 *     median Standard constituent       +1.82%
 *
 * Against EEM, 149 of 164 Standard constituents "underperform" by a median of
 * 43.7 pp — which would mark essentially every Indian large cap as shrinking
 * relative to its segment, in the same direction, for a reason that has nothing
 * to do with India. INDA splits the same 164 into 83 up and 81 down around a
 * median of +0.6 pp, which is what a segment benchmark is supposed to look like.
 *
 * So INDA is on the record as the Standard segment's index. It is not one of the
 * three funds and holds nothing here — `fundId: null` says so, and anything that
 * sizes a trade must key on `fundId` rather than iterate this list.
 *
 * `indiaWeightPct` is the honest limit on the rupee conversion. Multiplying a
 * price by USDINR recovers the rupee value of THE WHOLE BASKET; for INDA and
 * SMIN that basket is Indian, so the result is comparable to an Indian company's
 * rupee growth. For EEM and EEMS it is a global basket priced in rupees, which
 * is a currency overlay and not an Indian return — see `comparableInInr`.
 */
export const FUND_BENCHMARKS = [
  {
    id: 'eem',
    symbol: 'EEM',
    fundId: 'eem',
    name: 'iShares MSCI Emerging Markets ETF',
    tracks: 'MSCI Emerging Markets Index',
    holds: 'the EM ETF\'s India Standard constituents',
    standsForSegment: null,
    indiaWeightPct: 11.3,
  },
  {
    id: 'smin',
    symbol: 'SMIN',
    fundId: 'smin',
    name: 'iShares MSCI India Small-Cap ETF',
    tracks: 'MSCI India Small Cap Index',
    holds: 'the India Small-Cap ETF\'s constituents',
    // The one benchmark that is legitimately both: an India-only fund whose
    // index IS the segment its holdings sit in.
    standsForSegment: 'smallcap',
    indiaWeightPct: 100,
  },
  {
    id: 'eems',
    symbol: 'EEMS',
    fundId: 'eems',
    name: 'iShares MSCI Emerging Markets Small-Cap ETF',
    tracks: 'MSCI Emerging Markets Small Cap Index',
    holds: 'the EM Small-Cap ETF\'s India constituents',
    standsForSegment: null,
    indiaWeightPct: 21.3,
  },
  {
    id: 'inda',
    symbol: 'INDA',
    // Holds nothing in this project. It is here to answer "how did the Standard
    // segment move", which is a question about MSCI India, not about a fund.
    fundId: null,
    name: 'iShares MSCI India ETF',
    tracks: 'MSCI India Index — the Standard segment for India',
    holds: null,
    standsForSegment: 'standard',
    indiaWeightPct: 100,
  },
];

/** Look one up by its id. */
export const benchmarkById = (id) => FUND_BENCHMARKS.find((b) => b.id === id) ?? null;

/**
 * May this benchmark's rupee return be set beside an Indian company's?
 *
 * `price_usd × usdinr` recovers the rupee value of the WHOLE basket. That is a
 * genuine Indian basket return for INDA and SMIN. For EEM (11.3% India) and
 * EEMS (21.3%) it is a global basket expressed in rupees — the same number a
 * currency overlay would produce — and differencing it against an Indian
 * company's growth compares two different things and calls the answer
 * outperformance.
 *
 * The 50% line is the desk's, and it is not a close call: the two benchmarks it
 * excludes are 11% and 21% India, the two it admits are 100%.
 */
export const comparableInInr = (benchmark) => (benchmark?.indiaWeightPct ?? 0) >= 50;

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `{Mon: n, ...}` for a dated series, so an impossible label is countable. */
export function weekdayTally(series) {
  const tally = {};
  for (const point of series ?? []) {
    const day = WEEKDAY_NAMES[new Date(`${point.date}T00:00:00Z`).getUTCDay()];
    tally[day] = (tally[day] ?? 0) + 1;
  }
  return tally;
}

/**
 * Are these date labels the dates the exchange would recognise?
 *
 * ---------------------------------------------------------------------------
 * ⚠ A UTC DATE LABEL SHIFTS USDINR BACK ONE DAY FOR SEVEN MONTHS OF EVERY YEAR
 * ---------------------------------------------------------------------------
 * Yahoo stamps each daily bar at the session's opening instant in the
 * exchange's OWN timezone. For the NYSE and Cboe funds that is 09:30 New York
 * = 13:30 UTC, so a UTC date label agrees with the trading date and always
 * will. USDINR=X is carried on `CCY`, timezone Europe/London, stamped at LOCAL
 * MIDNIGHT — under GMT that is 00:00 UTC and the two agree, but under BST (late
 * March to late October, seven months a year) Monday 24 Aug 2026 sits at
 * 2026-08-23T23:00Z and a UTC label calls it SUNDAY THE 23RD.
 *
 * The committed file wore the signature plainly for a week and nobody read it:
 *
 *     FX weekday tally   Mon 104  Tue 105  Wed 104  Thu 101  Fri 45  SUN 59
 *
 * Fridays are missing because their bars were labelled Thursday, and 59
 * impossible Sundays appeared because Monday's rate was pushed back a day.
 *
 * That breaks the one promise this module rests on — "both halves of each
 * product come from the same date". 57 of EEM's 502 trading dates had no exact
 * FX point, so `rateOn` walked back and priced them with the PREVIOUS day's
 * rate, folding two days of currency into a one-day price move. Every one of
 * them looked fine.
 *
 * THE THRESHOLD HERE IS THE CALENDAR, which no bug in the fetcher can move: no
 * exchange in this payload trades at a weekend, and across two years of daily
 * bars the five weekdays must appear in roughly equal numbers. A whole-day
 * shift cannot satisfy either test, in either direction. 15% tolerates real
 * holiday clustering — Thanksgiving is always a Thursday, Good Friday always a
 * Friday — and does not tolerate a day's worth of shift.
 */
export function assertSeriesDates(series) {
  const tally = weekdayTally(series);
  const problems = [];

  // ⚠ ONE TRADING DATE, ONE CLOSE. Yahoo's timestamps are unique but the dates
  // they map to are not: it appends a live bar for the current session beside
  // that session's daily bar, and both label the same date. The committed file
  // carried USDINR=X twice on 2026-08-28 — 95.4704 and 95.3600 — and every
  // consumer builds a Map from this series, so whichever bar happened to come
  // last silently won. Both are plausible rates; the ambiguity is the defect.
  const seen = new Set();
  const duplicates = [];
  for (const point of series ?? []) {
    if (seen.has(point.date)) duplicates.push(point.date);
    seen.add(point.date);
  }
  if (duplicates.length > 0) {
    problems.push(
      `${duplicates.length} duplicate date label(s) — one trading date must carry one close: `
      + `${[...new Set(duplicates)].slice(0, 5).join(', ')}`,
    );
  }

  const weekend = (tally.Sat ?? 0) + (tally.Sun ?? 0);
  if (weekend > 0) {
    problems.push(`${weekend} weekend date label(s) — no exchange here trades at a weekend`);
  }
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((d) => tally[d] ?? 0);
  const lo = Math.min(...weekdays);
  const hi = Math.max(...weekdays);
  const spread = hi > 0 ? (hi - lo) / hi : 1;
  if (!(hi > 0) || spread > 0.15) {
    problems.push(`weekdays span ${(spread * 100).toFixed(1)}% (limit 15%) — ${JSON.stringify(tally)}`);
  }
  return { ok: problems.length === 0, problems, tally };
}

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

/**
 * The date of the point `returnSince` would measure from, for disclosure.
 *
 * ⚠ IT CLAMPS, AND A CALLER MUST BE ABLE TO SEE THAT IT DID.
 *
 * The on-or-before scan returns the last point in the series when `fromDate` is
 * past the end of it — so anchorDateFor(eem, '2027-01-01') answers 2026-08-28
 * with no signal that the date asked for was unreachable. That is the common
 * case, not an exotic one: the benchmark series is chronically a few days behind
 * the price file, so a caller asking for "today" routinely lands past the end
 * and gets a real-looking percentage for a window that closed days earlier.
 *
 * The date is still returned, because the walk-back is legitimate across a
 * holiday and callers depend on it. `resolvedWithin` is what lets a caller tell
 * a two-day holiday walk from a two-week clamp, and any window that must be
 * struck on an exact date should refuse rather than accept the clamp.
 */
export function anchorDateFor(series, fromDate, { maxWalkBackDays = null } = {}) {
  let first = null;
  for (const point of series ?? []) {
    if (point.date <= fromDate) first = point;
    else break;
  }
  if (!first) return null;
  if (maxWalkBackDays === null) return first.date;
  const gapDays = Math.round((Date.parse(fromDate) - Date.parse(first.date)) / 86400000);
  return gapDays <= maxWalkBackDays ? first.date : null;
}

/**
 * The same scan, reporting what it did rather than only its answer.
 *
 * `{requested, resolved, walkedBackDays, exact, pastEndOfSeries}` — everything a
 * guard needs to assert that a window was struck where it was asked to be.
 */
export function resolveAnchor(series, requestedDate) {
  const points = series ?? [];
  if (points.length === 0 || !requestedDate) {
    return { requested: requestedDate ?? null, resolved: null, walkedBackDays: null, exact: false, pastEndOfSeries: false };
  }
  const resolved = anchorDateFor(points, requestedDate);
  const seriesEnd = points[points.length - 1].date;
  return {
    requested: requestedDate,
    resolved,
    walkedBackDays: resolved === null
      ? null
      : Math.round((Date.parse(requestedDate) - Date.parse(resolved)) / 86400000),
    exact: resolved === requestedDate,
    // The distinguishing fact: a walk-back inside the series is a holiday, a
    // walk-back FROM PAST THE END is the series not reaching far enough.
    pastEndOfSeries: requestedDate > seriesEnd,
  };
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
    id: fund.id ?? fund.fundId,
    // Null for a benchmark that holds nothing here. Anything sizing a trade must
    // key on this; anything asking "how did the segment move" must not.
    fundId: fund.fundId ?? null,
    standsForSegment: fund.standsForSegment ?? null,
    indiaWeightPct: fund.indiaWeightPct ?? null,
    // Whether the rupee figure below may be set beside an Indian company's
    // growth at all, or is a global basket wearing a rupee sign.
    comparableInInr: comparableInInr(fund),
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
