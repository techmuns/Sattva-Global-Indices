/**
 * Vanguard's FTSE Emerging Markets holdings export -> public/data/ftse-funds.json
 *
 * The desk tracks MSCI because most index money follows it, but FTSE runs a
 * parallel emerging-markets index with its own constituents, its own review
 * calendar and its own size rules. This brings FTSE's India book onto the same
 * screen. It is a SECOND OPINION, never a second input to the MSCI model —
 * see the guards in build-companies.mjs and verify-data.
 *
 * ⚠ THE MONEY COLUMN IS CANADIAN DOLLARS, AND THE FILE NEVER SAYS SO.
 *
 * Every figure in the workbook is printed with a bare "$". The fund is Vanguard
 * CANADA's "FTSE Emerging Markets All Cap Index ETF" (the US product is named
 * "FTSE Emerging Markets ETF"), and its book is struck in CAD.
 *
 * This was not assumed from the name. It was MEASURED, and the measurement is
 * reproduced on every build: take each holding's implied share price
 * (market value / shares), convert with the exchange rate for the holdings
 * date, and compare it against the close this project already holds for the
 * same company on the same day.
 *
 *     converting as USD -> ratio 1.4065 (p1 1.4011, p99 1.4125), 0 of 568 within 1%
 *     converting as CAD -> ratio 1.0031 (p1 0.9992, p99 1.0073), 566 of 568 within 1%
 *
 * 568 unrelated companies agreeing on one constant is what a currency error
 * looks like; the constant was USD/CAD. Reading the "$" as USD would have made
 * every FTSE rupee figure 40.65% too large — §3.8's crore-for-rupee trap in a
 * different currency. `assertCurrency` in lib/ftse-resolve.mjs re-runs that
 * comparison every build, so a future file struck in USD fails loudly instead of
 * inflating the book by two-fifths.
 *
 * ⚠ THE WEIGHTS DO NOT SUM TO 100. They sum to 95.0153% — Vanguard excludes
 * cash and futures from the weighted exposures, and says so in the workbook's
 * own footnote. So India's 16.173% is a share of the WHOLE FUND, not of its
 * equity book, and the two denominators are carried separately rather than
 * being quietly reconciled (§2.5).
 *
 * ⚠ VANGUARD'S OWN WEIGHT COLUMN ROUNDS A REAL POSITION TO NOTHING. Genus Prime
 * Infra is published as "0.00%" on a position of $1,771.94. That is §2.20
 * arriving in the SOURCE rather than in our formatter: the published string is
 * kept verbatim, the market value carries the precise figure, and the row is
 * flagged so nothing downstream reads the zero as "not held".
 *
 * Usage: node scripts/import-ftse.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readXlsx, tableFrom, rowReader } from './lib/xlsx.mjs';
import { parseGroupedNumber } from './lib/bse.mjs';
import { num, renderTable } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const FIXTURE = join(REPO, 'scripts', 'fixtures', 'vanguard-ftse-em-allcap.xlsx');
const OUT_PATH = join(REPO, 'public', 'data', 'ftse-funds.json');

/**
 * Measured on the committed fixture. This describes THAT WORKBOOK, not the fund
 * in general — a fresh download will legitimately move every number here, and
 * the table must be re-measured in the same commit that replaces the file
 * (§5). Never loosen a figure to make a run pass.
 */
const EXPECTED = {
  name: 'Vanguard FTSE Emerging Markets All Cap Index ETF',
  holdingsAsOf: '2026-07-31',
  downloadedOn: '2026-09-04',
  headerRowNumber: 7,
  dataRows: 6339,
  indiaRows: 651,
  indiaWeightPct3dp: '16.173',
  totalWeightPct3dp: '95.015',
  placeholderNameRows: 6,
  noTickerRows: 1,
  weightRoundsToZeroRows: 1,
};

/** "$1,234.56" -> 1234.56. Strips exactly one leading $, then validates. */
function parseMoney(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return parseGroupedNumber(text.startsWith('$') ? text.slice(1) : text);
}

/** "0.7647%" -> 0.7647. Strips exactly one trailing %, then validates. */
function parsePercent(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return parseGroupedNumber(text.endsWith('%') ? text.slice(0, -1) : text);
}

/** "As at Jul 31 2026" -> "2026-07-31". Returns null rather than guessing. */
const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
function parseStatedDate(text) {
  const m = /([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{4})/.exec(String(text ?? ''));
  if (!m || !MONTHS[m[1]]) return null;
  return `${m[3]}-${MONTHS[m[1]]}-${String(m[2]).padStart(2, '0')}`;
}

/**
 * Vanguard writes a Bloomberg stub instead of a name for a recently added
 * security: "New Issuer: BB Company ID:183206". That is not a company name and
 * must never be matched on as one.
 */
const PLACEHOLDER_NAME = /^New Issuer:\s*BB Company ID:/i;

function main() {
  const buf = readFileSync(FIXTURE);
  const { rows } = readXlsx(buf);

  // The preamble carries the download stamp, the fund name and the as-at date,
  // above a header row whose height is not a guaranteed constant (§3.2).
  const preamble = rows.filter((r) => r.cells[0]).map((r) => String(r.cells[0]).trim());
  const downloadedOn = parseStatedDate(preamble.find((t) => /^This file was downloaded on/i.test(t)));
  const holdingsAsOf = parseStatedDate(preamble.find((t) => /^As at /i.test(t)));
  const fundName = preamble.find((t) => /^Vanguard /i.test(t)) ?? null;

  const { header, headerRowNumber, dataRows } = tableFrom(rows, 'Ticker');
  const get = rowReader(header);

  // A data row is one that carries a weight and a region. Everything else in the
  // sheet is chrome — the footnote about rounding lives below the table.
  const data = dataRows.filter((r) => get(r, '% of market value') != null && get(r, 'Region') != null);
  const india = data.filter((r) => get(r, 'Region') === 'IN');

  const sum = (list, fn) => list.reduce((acc, r) => acc + (fn(r) ?? 0), 0);
  const totalWeightPct = sum(data, (r) => parsePercent(get(r, '% of market value')));
  const totalMarketValueCad = sum(data, (r) => parseMoney(get(r, 'Market value')));
  const indiaWeightPct = sum(india, (r) => parsePercent(get(r, '% of market value')));
  const indiaMarketValueCad = sum(india, (r) => parseMoney(get(r, 'Market value')));

  const holdings = india.map((r) => {
    const rawWeight = get(r, '% of market value');
    const weightPct = parsePercent(rawWeight);
    const name = get(r, 'Holding name');
    const isPlaceholder = PLACEHOLDER_NAME.test(name ?? '');
    const ticker = get(r, 'Ticker');
    return {
      // Stored verbatim. Vanguard's ticker is a HOUSE CODE, not an NSE symbol:
      // it writes HDFCB for HDFCBANK, INFO for INFY — and its SOTL is Sterlite
      // Technologies, while SOTL on NSE is a different listed company
      // altogether. Nothing may resolve on it without corroboration (§3.9).
      ticker: ticker || null,
      tickerKind: ticker ? 'vanguard-house-code' : 'none',
      name: isPlaceholder ? null : name,
      // The stub is kept so the row can say WHY it has no name (§2.3, §2.4).
      publishedName: name,
      nameKind: isPlaceholder ? 'placeholder' : 'published',
      sector: get(r, 'Sector') || null,
      weightPct,
      // Vanguard's own string, kept because the parsed number cannot show that
      // "0.00%" was already rounded to nothing before it reached us.
      weightPctPublished: rawWeight,
      weightRoundedToZero: weightPct === 0 && (parseMoney(get(r, 'Market value')) ?? 0) > 0,
      marketValueCad: parseMoney(get(r, 'Market value')),
      quantity: parseGroupedNumber(get(r, 'Shares')),
    };
  });

  // ---- refuse to write on drift from the committed workbook ---------------
  const measured = {
    name: fundName,
    holdingsAsOf,
    downloadedOn,
    headerRowNumber,
    dataRows: data.length,
    indiaRows: india.length,
    indiaWeightPct3dp: indiaWeightPct.toFixed(3),
    totalWeightPct3dp: totalWeightPct.toFixed(3),
    placeholderNameRows: holdings.filter((h) => h.nameKind === 'placeholder').length,
    noTickerRows: holdings.filter((h) => !h.ticker).length,
    weightRoundsToZeroRows: holdings.filter((h) => h.weightRoundedToZero).length,
  };
  const drift = Object.keys(EXPECTED).filter((k) => String(measured[k]) !== String(EXPECTED[k]));
  if (drift.length) {
    process.stderr.write(
      `\nThe workbook does not match the EXPECTED table in this script:\n\n${
        drift.map((k) => `  ${k}: measured ${JSON.stringify(measured[k])} vs expected ${JSON.stringify(EXPECTED[k])}`).join('\n')
      }\n\nEXPECTED describes the file committed in scripts/fixtures/, not the fund in general. If you\n`
      + 'replaced the workbook, re-measure and update EXPECTED in the same commit. Never loosen it to\n'
      + 'make a run pass.\n\n',
    );
    process.exit(1);
  }

  const payload = {
    source: "Vanguard — 'Holdings details' workbook export (.xlsx)",
    note:
      'FTSE Emerging Markets holdings, India slice. A SECOND OPINION alongside the MSCI funds: FTSE '
      + 'runs its own index with its own constituents, size rules and review calendar, so nothing here '
      + 'feeds the MSCI segment derivation, cutoffs, verdicts or flows.',
    importedAt: new Date().toISOString(),
    fixtures: ['scripts/fixtures/vanguard-ftse-em-allcap.xlsx'],
    units: {
      weightPct: "Vanguard's published percent OF THE WHOLE FUND — not of its equity book, and not comparable across funds (§3.5)",
      marketValueCad: 'CANADIAN dollars, as reported by Vanguard. The workbook prints a bare "$" and never names the currency; see the header comment',
      quantity: 'shares, as reported by Vanguard',
    },
    currency: {
      code: 'CAD',
      establishedBy:
        'measured, not assumed: implied share price (market value / shares) converted at the holdings-date '
        + 'rate and compared with this project\'s own close for the same company on the same day. As CAD the '
        + 'ratio is 1.0031 with 566 of 568 inside 1%; as USD it is a flat 1.4065 with none inside 1%.',
      reCheckedEveryBuild: 'assertCurrency() in scripts/lib/ftse-resolve.mjs',
    },
    funds: [{
      id: 'ftse-em',
      name: fundName,
      shortName: 'FTSE EM',
      indexFamily: 'FTSE',
      currency: 'CAD',
      asOf: holdingsAsOf,
      downloadedOn,
      dataRows: data.length,
      // Every row in the book, so a weight is never divided by the India slice.
      totalMarketValueCad,
      totalWeightPct,
      weightsExcludeCashAndFutures: true,
      indiaRows: india.length,
      indiaMarketValueCad,
      indiaWeightPct,
      // Two different denominators, both stated (§2.5): India's share of the
      // whole fund by published weight, and its share of the equity book by
      // market value. They differ because the weights stop at 95.0153%.
      indiaShareOfMarketValuePct: (indiaMarketValueCad / totalMarketValueCad) * 100,
      holdings,
    }],
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  process.stdout.write(`\nVanguard FTSE EM holdings — ${fundName}\n\n`);
  process.stdout.write(renderTable(
    [{ key: 'k', label: 'measured' }, { key: 'v', label: '', align: 'right' }],
    [
      { k: 'holdings as at', v: holdingsAsOf },
      { k: 'downloaded on', v: downloadedOn },
      { k: 'rows in the book', v: num(data.length) },
      { k: 'India rows', v: num(india.length) },
      { k: 'India weight, of the whole fund', v: `${indiaWeightPct.toFixed(3)}%` },
      { k: 'all weights sum to', v: `${totalWeightPct.toFixed(3)}%  (cash and futures excluded)` },
      { k: 'India market value', v: `CAD ${num(Math.round(indiaMarketValueCad))}` },
      { k: 'rows with a placeholder name', v: num(measured.placeholderNameRows) },
      { k: 'rows with no ticker', v: num(measured.noTickerRows) },
      { k: "rows Vanguard rounded to '0.00%'", v: num(measured.weightRoundsToZeroRows) },
    ],
  ));
  process.stdout.write(`\nWrote ${OUT_PATH.replace(`${REPO}/`, '')}\n\n`);
}

main();
