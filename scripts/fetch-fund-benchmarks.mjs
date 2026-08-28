#!/usr/bin/env node
/**
 * fetch-fund-benchmarks.mjs — how each fund's own basket has moved
 *                             -> public/data/fund-benchmarks.json
 *
 *   node scripts/fetch-fund-benchmarks.mjs
 *
 * Zero dependencies. Node's built-in fetch works against Yahoo — unlike NSE,
 * this host is not TLS-fingerprinted, so no shelling out to curl.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS: A SIZE CUT-OFF IS NOT AN ABSOLUTE RUPEE FIGURE
 * ---------------------------------------------------------------------------
 * The desk's bands — ₹3,500–4,000 Cr for inclusion, ₹2,000–2,400 Cr for
 * exclusion — are fixed rupee numbers. MSCI's real cut-offs are not: they are
 * derived at each review FROM THE INVESTABLE UNIVERSE, so they rise with a
 * rising market and fall with a falling one.
 *
 * That matters for a verdict. A company whose free float grew 4% in a segment
 * that grew 12% has become RELATIVELY SMALLER — it is closer to exclusion, not
 * further from it — and a fixed rupee band cannot see that at all. So the
 * segment's own move is measured here and the bands are floated by it.
 *
 * ---------------------------------------------------------------------------
 * ⚠ THE ETF IS PRICED IN DOLLARS AND THE FREE FLOAT IS IN RUPEES
 * ---------------------------------------------------------------------------
 * This is the trap, and it is a large one. SMIN, EEMS and EEM all trade in USD,
 * so their quoted return folds in the INR/USD move. Measured 20 Aug 2026:
 *
 *     fund   window     USD return   INR return   FX contribution
 *     SMIN   1 year        -3.62%      +5.44%        +9.05 pp   <- SIGN FLIPS
 *     EEMS   1 year       +12.86%     +23.46%       +10.60 pp
 *     EEM    1 year       +33.91%     +46.96%       +13.05 pp
 *
 * Comparing an Indian company's rupee growth against SMIN's DOLLAR return would
 * have said the segment shrank 3.6% when it grew 5.4%. Every relative judgement
 * built on it would be wrong, and wrong in the same direction for every company.
 *
 * The conversion is exact rather than a correction factor. An ETF's price is the
 * rupee value of its basket expressed in dollars:
 *
 *     price_usd = basket_inr / usdinr        =>   basket_inr = price_usd × usdinr
 *
 * so the basket's rupee return between two dates is
 *
 *     (price_usd(b) × usdinr(b)) / (price_usd(a) × usdinr(a)) − 1
 *
 * Both halves of each product come from the same date. USDINR=X is fetched
 * alongside for exactly this.
 *
 * ---------------------------------------------------------------------------
 * PRICE RETURN, NOT TOTAL RETURN — AND THAT IS DELIBERATE
 * ---------------------------------------------------------------------------
 * These are the funds' PRICE series. Dividends are not reinvested, and should
 * not be: a company's free-float market cap moves with its price, not with a
 * distribution its holders received in cash. A total-return series would
 * overstate the segment's move by the yield and drift a little further from the
 * truth every quarter.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 * It is the ETF, not the index. An ETF carries tracking error and trades at a
 * premium or discount to NAV, so this is a close proxy for the index's move and
 * not the index itself. It is labelled that way everywhere it surfaces. MSCI's
 * own index levels are licensed and this project has no entitlement to them.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { renderTable, num } from './lib/report.mjs';
import { FUND_BENCHMARKS, returnBetween, seriesToMap, assertSeriesDates } from '../public/js/model/benchmarks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const OUT_PATH = join(REPO, 'public/data/fund-benchmarks.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FX_SYMBOL = 'USDINR=X';
const RANGE = '2y';

/** Below this many usable daily closes the series is not worth trusting. */
const MIN_POINTS = 200;
/** A series whose last close is older than this is stale, not a series. */
const MAX_AGE_DAYS = 10;

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
function tradingDate(timestamp, gmtOffset) {
  return new Date((timestamp + gmtOffset) * 1000).toISOString().slice(0, 10);
}

const chartUrl = (symbol) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
  + `?range=${RANGE}&interval=1d`;

async function fetchSeries(symbol) {
  let response;
  try {
    response = await fetch(chartUrl(symbol), {
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
  const series = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const close = closes[i];
    if (close === null || close === undefined || !(close > 0)) continue;
    series.push({ date: tradingDate(timestamps[i], gmtOffset), close });
  }

  return {
    ok: true,
    symbol: result.meta?.symbol ?? symbol,
    currency: result.meta?.currency ?? null,
    instrumentType: result.meta?.instrumentType ?? null,
    exchange: result.meta?.fullExchangeName ?? null,
    timezone: result.meta?.exchangeTimezoneName ?? null,
    gmtOffset,
    series,
  };
}

function main() { return run(); }

async function run() {
  process.stdout.write('\nFund benchmarks — Yahoo Finance daily closes\n\n');

  const wanted = [...FUND_BENCHMARKS.map((f) => f.symbol), FX_SYMBOL];
  const fetched = new Map();
  for (const symbol of wanted) {
    const result = await fetchSeries(symbol);
    if (!result.ok) {
      process.stderr.write(
        `\nCould not read ${symbol}: ${result.reason}\n`
        + 'This is an OUTAGE, not a flat market. Nothing written.\n\n',
      );
      process.exit(1);
    }
    fetched.set(symbol, result);
    await new Promise((resolve) => { setTimeout(resolve, 400); });
  }

  // ---- guards, before anything is computed from the numbers --------------
  const checks = [];
  const check = (ok, label, detail) => { checks.push({ ok, label, detail }); };

  const fx = fetched.get(FX_SYMBOL);
  // The currency assertion is load-bearing: the whole INR conversion assumes the
  // funds quote in USD and USDINR=X quotes rupees per dollar. If Yahoo ever
  // served a different listing under the same ticker, every return below would
  // be silently wrong rather than visibly broken.
  check(fx.currency === 'INR', `${FX_SYMBOL} quotes INR per USD`, `currency is ${fx.currency}`);
  for (const fund of FUND_BENCHMARKS) {
    const s = fetched.get(fund.symbol);
    check(s.currency === 'USD', `${fund.symbol} quotes USD`, `currency is ${s.currency}`);
    check(s.series.length >= MIN_POINTS, `${fund.symbol} has at least ${MIN_POINTS} usable closes`,
      `${s.series.length} points`);
  }
  check(fx.series.length >= MIN_POINTS, `${FX_SYMBOL} has at least ${MIN_POINTS} usable closes`,
    `${fx.series.length} points`);

  // ---- the date-label guards --------------------------------------------
  // These exist because the UTC bug they catch shipped, and sat unread in the
  // committed file for a week. The assertion lives in benchmarks.js so the
  // fetcher and verify-data run one implementation against one calendar.
  for (const [symbol, series] of fetched) {
    const dates = assertSeriesDates(series.series);
    check(dates.ok, `${symbol}'s date labels are trading dates`,
      dates.ok ? JSON.stringify(dates.tally) : dates.problems.join('; '));
  }

  // The FX series must actually cover the days the funds traded. Walking back is
  // legitimate for a genuine holiday and is how the shift hid: 57 of 502 dates
  // resolved to the previous day's rate and every one of them looked fine.
  const fxDates = new Set(fx.series.map((p) => p.date));
  for (const fund of FUND_BENCHMARKS) {
    const s = fetched.get(fund.symbol);
    const missing = s.series.filter((p) => !fxDates.has(p.date));
    check(missing.length <= s.series.length * 0.03,
      `${fund.symbol}'s trading dates have an exact FX rate`,
      `${missing.length} of ${s.series.length} need a walk-back`
        + (missing.length ? ` — first ${missing.slice(0, 3).map((p) => p.date).join(', ')}` : ''));
  }

  // Freshness is measured against the newest close ACROSS the series, not the
  // clock — a build must not depend on when it happened to run.
  const newest = [...fetched.values()]
    .map((s) => s.series[s.series.length - 1]?.date)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  for (const [symbol, s] of fetched) {
    const last = s.series[s.series.length - 1]?.date ?? null;
    const ageDays = last && newest
      ? Math.round((Date.parse(newest) - Date.parse(last)) / 86400000)
      : null;
    check(ageDays !== null && ageDays <= MAX_AGE_DAYS,
      `${symbol} is within ${MAX_AGE_DAYS} days of the newest series`,
      `last close ${last}, newest across all series ${newest}`);
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    process.stderr.write(`\nREFUSING TO WRITE ${OUT_PATH.replace(REPO + '/', '')} — ${failed.length} check(s) failed:\n\n`);
    for (const c of failed) process.stderr.write(`  FAIL  ${c.label} — ${c.detail}\n`);
    process.stderr.write('\n');
    process.exit(1);
  }

  // ---- assemble ----------------------------------------------------------
  const fxMap = seriesToMap(fx.series);
  const funds = FUND_BENCHMARKS.map((fund) => {
    const s = fetched.get(fund.symbol);
    return {
      id: fund.id,
      // NULL for a benchmark that holds nothing here (INDA). Anything that sizes
      // a trade must key on this rather than iterate the list — see the header
      // of benchmarks.js on why the holding fund and the segment index are two
      // different jobs.
      fundId: fund.fundId,
      standsForSegment: fund.standsForSegment,
      indiaWeightPct: fund.indiaWeightPct,
      symbol: s.symbol,
      name: fund.name,
      tracks: fund.tracks,
      currency: s.currency,
      instrumentType: s.instrumentType,
      exchange: s.exchange,
      timezone: s.timezone,
      firstClose: s.series[0]?.date ?? null,
      lastClose: s.series[s.series.length - 1]?.date ?? null,
      points: s.series.length,
      series: s.series,
    };
  });

  const payload = {
    source: 'Yahoo Finance — query1.finance.yahoo.com/v8/finance/chart, daily closes',
    note: 'The ETF, not the index. An ETF carries tracking error and trades at a premium or '
      + 'discount to NAV, so this is a close PROXY for the index it tracks, never the index '
      + 'itself. MSCI index levels are licensed and this project has no entitlement to them.',
    returnBasis: 'PRICE return, dividends not reinvested — a free-float market cap moves with '
      + 'price, not with a distribution paid out in cash.',
    currencyNote: 'Funds quote in USD. A rupee return is price_usd × usdinr on each date, both '
      + 'halves from the same date. Measured 20 Aug 2026, ignoring this would have put SMIN\'s '
      + '1-year move at -3.62% instead of +5.44% — the wrong sign.',
    capturedAt: new Date().toISOString(),
    // The newest close across every series. This, not capturedAt, is what the
    // freshness claim rests on.
    asOf: newest,
    range: RANGE,
    fx: {
      symbol: fx.symbol,
      currency: fx.currency,
      meaning: 'INR per USD',
      firstClose: fx.series[0]?.date ?? null,
      lastClose: fx.series[fx.series.length - 1]?.date ?? null,
      points: fx.series.length,
      series: fx.series,
    },
    funds,
  };

  // ---- report ------------------------------------------------------------
  const rows = [];
  for (const fund of funds) {
    const pxMap = seriesToMap(fund.series);
    for (const [label, tradingDays] of [['1 month', 21], ['3 months', 63], ['1 year', 250]]) {
      const usd = returnBetween(fund.series, tradingDays, null);
      const inr = returnBetween(fund.series, tradingDays, fxMap);
      if (usd === null || inr === null) continue;
      rows.push({
        fund: `${fund.symbol}`,
        window: label,
        usd: `${usd >= 0 ? '+' : ''}${usd.toFixed(2)}%`,
        inr: `${inr >= 0 ? '+' : ''}${inr.toFixed(2)}%`,
        fxpp: `${inr - usd >= 0 ? '+' : ''}${(inr - usd).toFixed(2)} pp`,
      });
      void pxMap;
    }
  }
  process.stdout.write(renderTable(
    [
      { key: 'fund', label: 'Fund', align: 'left' },
      { key: 'window', label: 'Window', align: 'left' },
      { key: 'usd', label: 'USD return', align: 'right' },
      { key: 'inr', label: 'INR return', align: 'right' },
      { key: 'fxpp', label: 'FX part', align: 'right' },
    ],
    rows,
  ));
  process.stdout.write(`\n\n  newest close across all series: ${newest}\n`);
  for (const c of checks) process.stdout.write(`  ok    ${c.label}\n`);

  // ---- a writer never replaces a good snapshot with a worse one ----------
  //
  // ⚠ COUNTING POINTS IS THE WRONG TEST FOR A ROLLING WINDOW.
  //
  // `range=2y` means two years back from TODAY, so the start of every series
  // walks forward with the calendar. Run a week later and roughly five sessions
  // fall off the front while five arrive at the back — a net drift of a point or
  // two in either direction, forever, on perfectly good data. The original guard
  // compared raw totals, so it went red on exactly that: 1,506 on file against
  // 1,503 in the run that fixed the FX dates. A guard that must be waived on
  // good data every week is a guard nobody reads, and this step is about to
  // become a hard CI step where a false red stops the pipeline.
  //
  // What must never shrink is COVERAGE OF A PERIOD, not a count. So the test is
  // anchored on the previous file — a source this run cannot move — and asks the
  // only question that matters: of the dates we already held that fall inside
  // this run's own span, how many came back? Dropping points fails it. Rolling
  // the window forward does not.
  if (existsSync(OUT_PATH)) {
    const previous = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
    const gaps = [];
    const previousSeries = [
      ...(previous.funds ?? []).map((f) => [f.symbol, f.series ?? []]),
      [previous.fx?.symbol ?? FX_SYMBOL, previous.fx?.series ?? []],
    ];
    const nowSeries = new Map([
      ...funds.map((f) => [f.symbol, f.series]),
      [payload.fx.symbol, payload.fx.series],
    ]);
    for (const [symbol, wasSeries] of previousSeries) {
      const now = nowSeries.get(symbol);
      if (!now || now.length === 0) continue;   // a symbol that has been added or removed is not a gap
      const from = now[0].date;
      const to = now[now.length - 1].date;
      const have = new Set(now.map((p) => p.date));
      const missing = wasSeries
        .filter((p) => p.date >= from && p.date <= to && !have.has(p.date))
        .map((p) => p.date);
      if (missing.length > 0) gaps.push({ symbol, missing });

      const wasLast = wasSeries[wasSeries.length - 1]?.date ?? null;
      if (wasLast && to < wasLast) gaps.push({ symbol, missing: [`series now ends ${to}, was ${wasLast}`] });
    }
    if (gaps.length > 0 && !process.argv.includes('--allow-shrink')) {
      process.stderr.write('\nRefusing to write — dates we already held did not come back:\n\n');
      for (const g of gaps) {
        process.stderr.write(`  ${g.symbol}: ${g.missing.length} missing — ${g.missing.slice(0, 6).join(', ')}\n`);
      }
      process.stderr.write('\nPass --allow-shrink only if the history genuinely got shorter.\n\n');
      process.exit(1);
    }
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `\nWrote ${OUT_PATH.replace(REPO + '/', '')} — ${funds.length} funds, `
    + `${num(funds.reduce((s, f) => s + f.points, 0))} daily closes, FX ${num(fx.series.length)}.\n\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`\nUnhandled failure: ${error?.stack || error}\n\n`);
  process.exit(1);
});
