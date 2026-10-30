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
 * own timezone. For the NYSE and Cboe funds a UTC label happens to agree; for
 * USDINR=X, carried on Europe/London and stamped at local midnight, it is the
 * difference between the right date and a date one day early for seven months of
 * every year. See `assertSeriesDates` in benchmarks.js for what that cost.
 *
 * ⚠ `meta.gmtoffset` IS TODAY'S OFFSET, NOT THE BAR'S.
 *
 * This used to add that one number to every bar in a two-year series. It worked
 * only while today and the bar were on the same side of a clock change, and the
 * clocks changed on 25 Oct 2026: gmtoffset went to 0, every BST bar in the file
 * (stamped 23:00Z) fell back a day, and 59 Sundays reappeared. USDINR=X and
 * CADINR=X then failed their calendar guards on every run, and the benchmarks
 * went stale on a bug that had been waiting for the first autumn this code saw.
 *
 * So the IANA zone is asked about each instant, which knows what the offset was
 * on that day. A bar with no named zone is refused by the caller: guessing an
 * offset is what this replaces.
 */
export function tradingDate(timestamp, timezone) {
  // en-CA formats as YYYY-MM-DD, in the zone's own calendar.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(timestamp * 1000));
}

const isWeekend = (date) => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());

/**
 * One chart `result` -> a clean daily series. Pure, so the two traps it handles
 * can be proved without the network (verify-data 66).
 *
 * @returns {{ok: true, series: Array, duplicateDateBars: number, weekendStubs: number}
 *          | {ok: false, reason: string}}
 */
export function seriesFromChart(result) {
  const timezone = result?.meta?.exchangeTimezoneName ?? null;
  if (!timezone) return { ok: false, reason: 'the payload names no exchange timezone, so no bar can be dated' };

  const timestamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const raw = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const close = closes[i];
    if (close === null || close === undefined || !(close > 0)) continue;
    raw.push({ date: tradingDate(timestamps[i], timezone), close });
  }

  // ---- a live stub at the end of a closed week ---------------------------
  //
  // Read on a Saturday, USDINR=X ends with one bar labelled Saturday: Yahoo's
  // live bar for a market that has shut. It is no session, and it failed the
  // calendar guard on the 24 Oct 2026 run. Only the NEWEST bar may be dropped and
  // only here: a weekend label anywhere inside the series is a shifted calendar,
  // and `assertSeriesDates` must still see that and refuse.
  let weekendStubs = 0;
  while (raw.length > 0 && isWeekend(raw[raw.length - 1].date)) {
    raw.pop();
    weekendStubs += 1;
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

  return { ok: true, series, duplicateDateBars: collapsed, weekendStubs };
}

const chartUrl = (symbol, RANGE) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
  + `?range=${RANGE}&interval=1d`;

async function readChart(symbol, range) {
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
  return { ok: true, result };
}

const ATTEMPTS = 3;

export async function fetchSeries(symbol, { range = '2y' } = {}) {
  // One bad answer from a free service must not cost the feed a day.
  let read;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    read = await readChart(symbol, range);
    if (read.ok) break;
    if (attempt < ATTEMPTS) await new Promise((resolve) => { setTimeout(resolve, attempt * 5000); });
  }
  if (!read.ok) return { ok: false, reason: `${read.reason} (after ${ATTEMPTS} attempts)` };

  const { result } = read;
  const parsed = seriesFromChart(result);
  if (!parsed.ok) return parsed;

  return {
    ok: true,
    duplicateDateBars: parsed.duplicateDateBars,
    weekendStubs: parsed.weekendStubs,
    symbol: result.meta?.symbol ?? symbol,
    currency: result.meta?.currency ?? null,
    instrumentType: result.meta?.instrumentType ?? null,
    exchange: result.meta?.fullExchangeName ?? null,
    timezone: result.meta?.exchangeTimezoneName ?? null,
    series: parsed.series,
  };
}
