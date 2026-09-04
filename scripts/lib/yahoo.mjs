/**
 * One Yahoo daily-close reader, shared by every script that needs one.
 *
 * It lives here rather than in a script because the two traps below are guards,
 * and this repo keeps ONE implementation of a guard: a second copy is a second
 * place for a timezone or a duplicate bar to be handled slightly differently,
 * which is precisely the failure §3.8.2 records. `fetch-fund-benchmarks.mjs`
 * (the funds and USDINR) and `fetch-ftse-fx.mjs` (CADINR, for the FTSE book)
 * both call this.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * The date the EXCHANGE calls this bar, not the date UTC calls it.
 *
 * Yahoo stamps each daily bar at the session's opening instant in the exchange's
 * own timezone, and publishes that timezone's offset as `meta.gmtoffset`. For
 * the NYSE and Cboe funds the offset changes nothing; for USDINR=X, carried on
 * Europe/London and stamped at local midnight, it is the difference between the
 * right date and a date one day early for seven months of every year. See
 * `assertSeriesDates` in benchmarks.js for what that cost and how it is caught.
 *
 * It is one line for every symbol rather than a special case somebody has to
 * remember USDINR needs.
 */
export function tradingDate(timestamp, gmtOffset) {
  return new Date((timestamp + gmtOffset) * 1000).toISOString().slice(0, 10);
}

const chartUrl = (symbol, RANGE) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
  + `?range=${RANGE}&interval=1d`;

export async function fetchSeries(symbol, { range = '2y' } = {}) {
  let response;
  try {
    response = await fetch(chartUrl(symbol, range), {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: AbortSignal.timeout(40000),
    });
  } catch (error) {
    return { ok: false, reason: `network: ${error.name === 'TimeoutError' ? 'timed out' : error.message}` };
  }
  if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };

  let json;
  try { json = await response.json(); } catch { return { ok: false, reason: 'response was not JSON' }; }

  const result = json?.chart?.result?.[0];
  if (!result) {
    return { ok: false, reason: `no result in the payload (${JSON.stringify(json?.chart?.error ?? null)})` };
  }

  const timestamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  // See tradingDate: the offset is the difference between the bar's UTC instant
  // and the date the exchange itself calls that session.
  const gmtOffset = Number(result.meta?.gmtoffset ?? 0);
  const raw = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const close = closes[i];
    if (close === null || close === undefined || !(close > 0)) continue;
    raw.push({ date: tradingDate(timestamps[i], gmtOffset), close });
  }

  // ---- two bars for one trading date -------------------------------------
  //
  // ⚠ YAHOO APPENDS A LIVE BAR FOR THE CURRENT SESSION ALONGSIDE ITS DAILY ONE.
  // Timestamps are unique; the DATES they map to are not. Measured on the
  // committed file, USDINR=X carried 2026-08-28 twice — 95.4704 and 95.3600,
  // 0.12% apart — and nothing said so.
  //
  // That is not cosmetic. `seriesToMap` builds a Map, so whichever bar came last
  // silently won, and the two halves of a rupee product could be struck against
  // either rate depending on iteration order. A reader recomputing a return by
  // hand off this file finds a number that does not match and cannot see why.
  //
  // The later bar is kept: it is the more recent observation of the SAME date,
  // which is what `seriesToMap` was already doing by accident. What changes is
  // that it is now deliberate, counted, and asserted against in
  // `assertSeriesDates` — so a future regression fails loudly instead of moving
  // every return by a tenth of a percent.
  const byDate = new Map();
  let collapsed = 0;
  for (const point of raw) {
    if (byDate.has(point.date)) collapsed += 1;
    byDate.set(point.date, point.close);
  }
  const series = [...byDate.entries()]
    .map(([date, close]) => ({ date, close }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    ok: true,
    duplicateDateBars: collapsed,
    symbol: result.meta?.symbol ?? symbol,
    currency: result.meta?.currency ?? null,
    instrumentType: result.meta?.instrumentType ?? null,
    exchange: result.meta?.fullExchangeName ?? null,
    timezone: result.meta?.exchangeTimezoneName ?? null,
    gmtOffset,
    series,
  };
}
