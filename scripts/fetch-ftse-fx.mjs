/**
 * The CAD → INR rate the FTSE book needs → public/data/ftse-fx.json
 *
 * ⚠ WHY THIS IS A SEPARATE FEED FROM fund-benchmarks.json.
 *
 * The obvious home was beside USDINR in `fetch-fund-benchmarks.mjs`, and that is
 * where it was written first. It cannot live there: that file's fund series must
 * reach the committed price date or every index leg on the screen empties at
 * once (`verify-data` 55), so re-running it is gated on Yahoo having published
 * the newest session for four ETFs. The FTSE rate has no such dependency, and
 * chaining a currency lookup to four unrelated funds' publication schedule would
 * mean the FTSE book could not be joined on any day one of them lagged.
 *
 * ⚠ AND IT IS NEVER DERIVED FROM THE WORKBOOK IT CHECKS.
 *
 * The tempting shortcut is to read the rate out of Vanguard's own numbers — take
 * the implied prices and solve for whatever constant makes them agree with our
 * closes. That would make the currency guard read its threshold from the value
 * under test, so it could never fail, which is the trap §3.8 exists to name. The
 * rate comes from Yahoo, independently, and the guard then has something real to
 * disagree with.
 *
 * The reader is `lib/yahoo.mjs` — the same one the benchmarks use — so this
 * series gets the same timezone and duplicate-bar handling that a currency pair
 * on `CCY` actually trips (§3.8.2), and the same `assertSeriesDates` guard.
 *
 * Usage: node scripts/fetch-ftse-fx.mjs [--allow-shrink]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchSeries } from './lib/yahoo.mjs';
import { assertSeriesDates } from '../public/js/model/benchmarks.js';
import { num, CheckList } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const OUT_PATH = join(REPO, 'public', 'data', 'ftse-fx.json');

const SYMBOL = 'CADINR=X';
const RANGE = '2y';
const MIN_POINTS = 200;

async function main() {
  process.stdout.write(`\nFTSE book FX — ${SYMBOL} daily closes from Yahoo Finance\n\n`);

  const result = await fetchSeries(SYMBOL, { range: RANGE });
  if (!result.ok) {
    process.stderr.write(
      `\nCould not read ${SYMBOL}: ${result.reason}\n`
      + 'This is an OUTAGE, not a flat rate. Nothing written.\n\n',
    );
    process.exit(1);
  }

  const checks = new CheckList('ftse-fx');
  // Load-bearing: every rupee figure derived from the FTSE book assumes this
  // quotes INR per CAD. A different listing under the same ticker would be
  // silently wrong rather than visibly broken.
  checks.assert(result.currency === 'INR', `${SYMBOL} quotes INR per CAD`, `currency is ${result.currency}`);
  checks.assert(result.series.length >= MIN_POINTS,
    `at least ${MIN_POINTS} usable closes`, `${result.series.length} points`);

  // The same calendar guard the benchmarks use: a whole-day timezone shift
  // cannot satisfy it in either direction, and a duplicate date fails it.
  const dates = assertSeriesDates(result.series);
  checks.assert(dates.ok, `${SYMBOL}'s date labels are trading dates`, dates.reason ?? 'weekday tally and no duplicates');

  // Refuse to replace a good file with a shorter one. Anchored on the dates we
  // already held INSIDE this run's own span, not on a raw count — a rolling
  // window legitimately drops its oldest point every day (§3.8.2).
  if (existsSync(OUT_PATH) && !process.argv.includes('--allow-shrink')) {
    const previous = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
    const now = new Set(result.series.map((p) => p.date));
    const first = result.series[0]?.date ?? '';
    const last = result.series[result.series.length - 1]?.date ?? '';
    const lost = (previous.series ?? [])
      .filter((p) => p.date >= first && p.date <= last && !now.has(p.date))
      .map((p) => p.date);
    if (lost.length) {
      process.stderr.write(
        `\n${lost.length} date(s) we already held inside this run's own span did not come back: `
        + `${lost.slice(0, 8).join(', ')}${lost.length > 8 ? ' …' : ''}\n`
        + 'Pass --allow-shrink only if the history genuinely got shorter.\n\n',
      );
      process.exit(1);
    }
  }

  if (checks.failures.length) {
    checks.print();
    process.stderr.write('\nA guard failed. Nothing written.\n\n');
    process.exit(1);
  }

  const payload = {
    source: 'Yahoo Finance — query1.finance.yahoo.com/v8/finance/chart, daily closes',
    note:
      "INR per CAD. The FTSE book is Vanguard Canada's and is struck in CAD, while the workbook prints "
      + 'a bare "$" and never says so. This rate converts it, and lets the build PROVE the currency by '
      + "comparing implied share prices against this project's own closes — it is never derived from "
      + 'the workbook itself, which would make that guard read its threshold from the value under test.',
    symbol: result.symbol,
    currency: result.currency,
    meaning: 'INR per CAD',
    capturedAt: new Date().toISOString(),
    asOf: result.series[result.series.length - 1]?.date ?? null,
    range: RANGE,
    exchange: result.exchange,
    timezone: result.timezone,
    gmtOffset: result.gmtOffset,
    duplicateDateBars: result.duplicateDateBars,
    points: result.series.length,
    series: result.series,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `\nWrote ${OUT_PATH.replace(`${REPO}/`, '')} — ${num(result.series.length)} closes, `
    + `newest ${payload.asOf}, ${result.duplicateDateBars} duplicate-date bar(s) collapsed.\n\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`\nUnhandled failure: ${error?.stack || error}\n\n`);
  process.exit(1);
});
