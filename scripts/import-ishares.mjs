#!/usr/bin/env node
/**
 * import-ishares.mjs — the three committed iShares workbooks -> public/data/msci-funds.json
 *
 *   node scripts/import-ishares.mjs
 *
 * Zero dependencies. Reads scripts/fixtures/ishares-{eem,smin,eems}.xls, which are
 * SpreadsheetML 2003 despite the .xls extension (see scripts/lib/spreadsheetml.mjs).
 *
 * WHAT THIS SCRIPT REFUSES TO DO
 *
 *  - It will not write a file whose numbers have drifted from EXPECTED below.
 *    A silently-wrong holdings file is worse than no holdings file: every flow
 *    estimate downstream inherits the error and nothing else in the pipeline
 *    can detect it.
 *  - It will not resolve tickers. `534091` and `--` and `NAM.INDIA` are stored
 *    exactly as BlackRock wrote them, tagged with how they READ. Resolution to
 *    NSE symbols is a later, separate, auditable step.
 *  - It will not drop a row it cannot make sense of. Every India equity row in
 *    the file reaches the output.
 *  - It will not mix weights across funds. Each weight is written inside the
 *    fund object it belongs to and the data contract forbids summing them.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseWorkbook,
  cellText,
  findRowByFirstCell,
  tableFromHeaderRow,
} from './lib/spreadsheetml.mjs';
import { renderTable, CheckList, round, num } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const FIXTURES = join(HERE, 'fixtures');
const OUT_PATH = join(REPO, 'public', 'data', 'msci-funds.json');

/**
 * EXPECTED describes THE THREE WORKBOOKS COMMITTED IN scripts/fixtures/.
 *
 * ⚠ THE THREE ARE NO LONGER AS OF THE SAME DAY, and that is a fact about the
 * record rather than a defect here. EEM and SMIN were re-downloaded after the
 * August 2026 review took effect and are as of 2026-08-31; EEMS was not
 * supplied and is still as of 2026-08-17. `holdingsAsOf` is therefore checked
 * per fund, `msci-funds.json` carries a date per fund, and everything
 * downstream reads the OLDEST of them as the record's freshness — a fresh EEM
 * does not make a fortnight-old EEMS current (CLAUDE.md §2.10).
 *
 * These are NOT invariants of the funds. A workbook refreshed next month will
 * legitimately move every count and every weight in this table. When you drop
 * in fresh fixtures, the correct response to a failure here is to re-measure
 * and update this table in the same commit as the new .xls files — never to
 * loosen the check. This table was last re-measured on 2026-09-03, from the
 * script's own refusal message.
 *
 * `declaredSecurities` is cross-checked against the value the workbook itself
 * prints in its "Number of Securities (excluding cash and derivatives)" row, so
 * that line is verified against the file rather than merely asserted about it.
 */
const EXPECTED = {
  // Re-downloaded after the August 2026 review took effect.
  eem: {
    name: 'iShares MSCI Emerging Markets ETF',
    holdingsAsOf: '2026-08-31',
    declaredSecurities: 1189,
    sharesOutstanding: 464850000,
    dataRows: 1283,
    indiaRows: 169,
    indiaEquityRows: 168,
    indiaWeightPct3dp: '11.360',
    onNse: 166,
    onBse: 2,
    tickerNone: 0,
    hasTypeColumn: true,
  },
  smin: {
    name: 'iShares MSCI India Small-Cap ETF',
    holdingsAsOf: '2026-08-31',
    declaredSecurities: 453,
    sharesOutstanding: 10750000,
    dataRows: 477,
    indiaRows: 454,
    indiaEquityRows: 453,
    indiaWeightPct3dp: '99.442',
    onNse: 446,
    onBse: 7,
    tickerNone: 3,
    hasTypeColumn: false,
  },
  // NOT re-downloaded for the August review. Still the pre-rebalance file, and
  // every surface that shows it has to say so rather than let a fresh sibling
  // imply it is current.
  eems: {
    name: 'iShares MSCI Emerging Markets Small-Cap ETF',
    holdingsAsOf: '2026-08-17',
    declaredSecurities: 1693,
    sharesOutstanding: 5000000,
    dataRows: 1725,
    indiaRows: 415,
    indiaEquityRows: 414,
    indiaWeightPct3dp: '21.271',
    onNse: 407,
    onBse: 7,
    tickerNone: 2,
    hasTypeColumn: false,
  },
};

const FUNDS = [
  { id: 'eem', shortName: 'EM', fixture: 'ishares-eem.xls' },
  { id: 'smin', shortName: 'India SC', fixture: 'ishares-smin.xls' },
  { id: 'eems', shortName: 'EM SC', fixture: 'ishares-eems.xls' },
];

/** Column headers every fund must have. `Type` is deliberately absent: the two
 *  small-cap workbooks do not carry it. Read by name, never by position. */
const REQUIRED_COLUMNS = [
  'Ticker',
  'Name',
  'Sector',
  'Asset Class',
  'Market Value',
  'Weight (%)',
  'Quantity',
  'Price',
  'Location',
  'Exchange',
  'Currency',
  'FX Rate',
];

const MONTHS = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

/** "Aug 17, 2026" -> "2026-08-17". Returns null on anything else. */
function isoDate(text) {
  const match = /^([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})$/.exec(cellText(text));
  if (!match) return null;
  const month = MONTHS[match[1]];
  if (!month) return null;
  return `${match[3]}-${month}-${String(match[2]).padStart(2, '0')}`;
}

/** "464,850,000.00" -> 464850000. Returns null when there is no number here. */
function declaredNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = cellText(value).replace(/,/g, '');
  if (text === '' || text === '-' || text === '--') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * How a ticker READS. This is not resolution — nothing here looks anything up.
 *   'none'     the file prints `--`: an unlisted entity (typically a demerger
 *              that has not started trading) for which BlackRock has no ticker.
 *   'bse-code' an all-digit BSE scrip code, not an NSE symbol.
 *   'nse'      reads like an NSE symbol. May still be a BlackRock house code
 *              (SHFL, TMCV, ENRIN) or use different punctuation (NAM.INDIA vs
 *              NAM-INDIA). Only a resolver can tell, and there isn't one yet.
 */
function classifyTicker(ticker) {
  if (ticker === '' || ticker === '--' || ticker === '-') return 'none';
  if (/^\d+$/.test(ticker)) return 'bse-code';
  return 'nse';
}

/** Preamble label -> value, for the rows above the header. */
function preambleMap(rows, headerRowIndex) {
  const map = new Map();
  for (let i = 0; i < headerRowIndex; i += 1) {
    const label = cellText(rows[i]?.[0]);
    if (label !== '' && rows[i]?.length > 1) map.set(label, rows[i][1]);
  }
  return map;
}

/** The fund's own name: the first preamble row holding a single cell that is
 *  not the leading MM/DD/YYYY stamp. Never a hard-coded row number. */
function fundNameFrom(rows, headerRowIndex) {
  for (let i = 0; i < headerRowIndex; i += 1) {
    const filled = (rows[i] ?? []).map(cellText).filter((v) => v !== '');
    if (filled.length !== 1) continue;
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(filled[0])) continue;
    return filled[0];
  }
  return null;
}

function loadFund(fund) {
  const checks = new CheckList(fund.id);
  const expected = EXPECTED[fund.id];
  const xml = readFileSync(join(FIXTURES, fund.fixture), 'utf8');

  checks.assert(
    xml.includes('urn:schemas-microsoft-com:office:spreadsheet'),
    'fixture is SpreadsheetML 2003',
    `${fund.fixture} does not declare the spreadsheet namespace`,
  );

  const workbook = parseWorkbook(xml);
  const holdings = workbook.sheet('Holdings');
  const historical = workbook.sheet('Historical');
  checks.assert(holdings !== null, 'has a Holdings sheet', 'missing');
  checks.assert(historical !== null, 'has a Historical sheet', 'missing');
  if (!holdings || !historical) return { fund, checks, diagnostics: null, record: null };

  // ---- Holdings preamble -------------------------------------------------
  const headerRowIndex = findRowByFirstCell(holdings.rows, 'Ticker');
  checks.assert(
    headerRowIndex >= 0,
    'found the header row by its "Ticker" cell',
    'no row on the Holdings sheet begins with "Ticker"',
  );
  if (headerRowIndex < 0) return { fund, checks, diagnostics: null, record: null };

  const preamble = preambleMap(holdings.rows, headerRowIndex);
  const name = fundNameFrom(holdings.rows, headerRowIndex);
  const asOf = isoDate(preamble.get('Fund Holdings as of'));
  const inceptionDate = isoDate(preamble.get('Inception Date'));
  const declaredSecurities = declaredNumber(
    preamble.get('Number of Securities (excluding cash and derivatives)'),
  );
  const sharesOutstanding = declaredNumber(preamble.get('Shares Outstanding'));

  checks.equal(name, expected.name, 'fund name');
  checks.equal(asOf, expected.holdingsAsOf, 'Fund Holdings as of');
  checks.assert(inceptionDate !== null, 'inception date parses', `got ${JSON.stringify(cellText(preamble.get('Inception Date')))}`);
  checks.equal(
    declaredSecurities,
    expected.declaredSecurities,
    'workbook\'s own "Number of Securities (excluding cash and derivatives)"',
  );
  checks.equal(sharesOutstanding, expected.sharesOutstanding, 'Shares Outstanding');

  // ---- Holdings table ----------------------------------------------------
  const { headers, records } = tableFromHeaderRow(holdings.rows, headerRowIndex);
  for (const column of REQUIRED_COLUMNS) {
    checks.assert(
      headers.includes(column),
      `has column "${column}"`,
      `headers are: ${headers.filter(Boolean).join(', ')}`,
    );
  }
  checks.equal(headers.includes('Type'), expected.hasTypeColumn, 'presence of the "Type" column');
  checks.equal(records.length, expected.dataRows, 'total data rows');

  const indiaRows = records.filter((r) => cellText(r.get('Location')) === 'India');
  const indiaEquity = indiaRows.filter((r) => cellText(r.get('Asset Class')) === 'Equity');
  checks.equal(indiaRows.length, expected.indiaRows, 'India rows (all asset classes)');
  checks.equal(indiaEquity.length, expected.indiaEquityRows, 'India equity rows');

  // ---- Money ------------------------------------------------------------
  // AUM is computed over EVERY row in the workbook, not the India slice. Flow
  // in dollars is (delta weight) x (total fund AUM); using the India slice as
  // the denominator understates EM ETF flows by about nine times.
  let totalMarketValueUsd = 0;
  let nonNumericMarketValueRows = 0;
  for (const record of records) {
    const value = declaredNumber(record.get('Market Value'));
    if (value === null) nonNumericMarketValueRows += 1;
    else totalMarketValueUsd += value;
  }
  checks.equal(nonNumericMarketValueRows, 0, 'every row has a numeric Market Value');

  let indiaMarketValueUsd = 0;
  let weightSum = 0;
  const exchangeCounts = new Map();
  const tickerKindCounts = { nse: 0, 'bse-code': 0, none: 0 };
  const nonNumericWeightRows = [];

  const holdingsOut = indiaEquity.map((record) => {
    const ticker = cellText(record.get('Ticker'));
    const weightPct = declaredNumber(record.get('Weight (%)'));
    const marketValueUsd = declaredNumber(record.get('Market Value'));
    const exchange = cellText(record.get('Exchange'));
    const kind = classifyTicker(ticker);

    if (weightPct === null) nonNumericWeightRows.push(`row ${record.rowNumber} (${ticker})`);
    else weightSum += weightPct;
    if (marketValueUsd !== null) indiaMarketValueUsd += marketValueUsd;
    exchangeCounts.set(exchange, (exchangeCounts.get(exchange) ?? 0) + 1);
    tickerKindCounts[kind] += 1;

    return {
      ticker, // verbatim from BlackRock — NOT resolved to an NSE symbol
      name: cellText(record.get('Name')),
      sector: cellText(record.get('Sector')),
      exchange,
      weightPct, // percent of THIS fund. Never comparable across funds.
      marketValueUsd,
      quantity: declaredNumber(record.get('Quantity')),
      priceUsd: declaredNumber(record.get('Price')),
      fxRate: declaredNumber(record.get('FX Rate')), // local units per USD
      tickerKind: kind,
    };
  });

  checks.equal(nonNumericWeightRows.length, 0, 'every India equity row has a numeric weight');
  checks.equal(weightSum.toFixed(3), expected.indiaWeightPct3dp, 'India equity weight sum (3 dp)');

  const onNse = exchangeCounts.get('National Stock Exchange Of India') ?? 0;
  const onBse = exchangeCounts.get('Bse Ltd') ?? 0;
  checks.equal(onNse, expected.onNse, 'India equity rows on NSE');
  checks.equal(onBse, expected.onBse, 'India equity rows on BSE');
  checks.equal(
    onNse + onBse,
    expected.indiaEquityRows,
    'NSE + BSE accounts for every India equity row',
  );
  checks.equal(tickerKindCounts.none, expected.tickerNone, 'India equity rows with ticker "--"');
  checks.equal(
    tickerKindCounts['bse-code'],
    expected.onBse,
    'numeric (BSE scrip code) tickers match the BSE exchange count',
  );

  // ---- Historical: NAV ---------------------------------------------------
  const historicalHeaderIndex = findRowByFirstCell(historical.rows, 'As Of');
  checks.assert(historicalHeaderIndex >= 0, 'Historical sheet has an "As Of" header', 'not found');
  let navPerShare = null;
  let navAsOf = null;
  let historicalRowCount = 0;
  if (historicalHeaderIndex >= 0) {
    const table = tableFromHeaderRow(historical.rows, historicalHeaderIndex);
    historicalRowCount = table.records.length;
    // The sheet arrives newest-first, but pick by date rather than trusting order.
    let latest = null;
    for (const row of table.records) {
      const date = isoDate(row.get('As Of'));
      if (date === null) continue;
      if (latest === null || date > latest.date) {
        latest = { date, nav: declaredNumber(row.get('NAV per Share')) };
      }
    }
    checks.assert(latest !== null, 'Historical sheet has at least one dated NAV row', 'none parsed');
    if (latest) {
      navPerShare = latest.nav;
      navAsOf = latest.date;
    }
  }

  // NAV x shares outstanding should land near total market value. They are
  // struck at different moments, so the residual is PRINTED, not asserted —
  // a small gap is honest and forcing them to agree would be a lie.
  const impliedAum =
    navPerShare !== null && sharesOutstanding !== null ? navPerShare * sharesOutstanding : null;
  const navResidualPct =
    impliedAum !== null && totalMarketValueUsd !== 0
      ? ((impliedAum - totalMarketValueUsd) / totalMarketValueUsd) * 100
      : null;

  const record = {
    id: fund.id,
    name,
    shortName: fund.shortName,
    asOf,
    inceptionDate,
    securitiesCount: declaredSecurities,
    sharesOutstanding,
    navPerShare,
    navAsOf,
    totalMarketValueUsd: round(totalMarketValueUsd, 2),
    indiaMarketValueUsd: round(indiaMarketValueUsd, 2),
    indiaWeightPct: round(weightSum, 5),
    indiaEquityCount: holdingsOut.length,
    holdings: holdingsOut,
  };

  const diagnostics = {
    id: fund.id,
    shortName: fund.shortName,
    dataRows: records.length,
    indiaRows: indiaRows.length,
    indiaEquity: indiaEquity.length,
    onNse,
    onBse,
    tickerKindCounts,
    weightSum,
    totalMarketValueUsd,
    indiaMarketValueUsd,
    navPerShare,
    sharesOutstanding,
    impliedAum,
    navResidualPct,
    historicalRowCount,
    columns: headers.filter(Boolean).length,
    hasTypeColumn: headers.includes('Type'),
    nonEquityIndiaAssetClasses: [
      ...new Set(
        indiaRows
          .filter((r) => cellText(r.get('Asset Class')) !== 'Equity')
          .map((r) => cellText(r.get('Asset Class'))),
      ),
    ],
  };

  return { fund, checks, diagnostics, record };
}

function main() {
  const results = FUNDS.map(loadFund);
  const failed = results.filter((r) => !r.checks.passed);

  const diagnostics = results.map((r) => r.diagnostics).filter(Boolean);

  process.stdout.write('\niShares fund import — India equity slice\n\n');
  process.stdout.write(
    renderTable(
      [
        { key: 'shortName', label: 'Fund', align: 'left' },
        { key: 'id', label: 'id', align: 'left' },
        { key: 'cols', label: 'Cols', align: 'right' },
        { key: 'dataRows', label: 'Rows', align: 'right' },
        { key: 'indiaRows', label: 'India', align: 'right' },
        { key: 'indiaEquity', label: 'India eq', align: 'right' },
        { key: 'weight', label: 'Weight %', align: 'right' },
        { key: 'nse', label: 'NSE', align: 'right' },
        { key: 'bse', label: 'BSE', align: 'right' },
        { key: 'noTicker', label: "'--'", align: 'right' },
        { key: 'totalAum', label: 'Fund AUM $', align: 'right' },
        { key: 'indiaAum', label: 'India $', align: 'right' },
      ],
      diagnostics.map((d) => ({
        shortName: d.shortName,
        id: d.id,
        cols: d.columns,
        dataRows: num(d.dataRows),
        indiaRows: num(d.indiaRows),
        indiaEquity: num(d.indiaEquity),
        weight: d.weightSum.toFixed(3),
        nse: num(d.onNse),
        bse: num(d.onBse),
        noTicker: num(d.tickerKindCounts.none),
        totalAum: num(d.totalMarketValueUsd, 0),
        indiaAum: num(d.indiaMarketValueUsd, 0),
      })),
    ),
  );

  process.stdout.write('\n\nNAV cross-check (printed, not asserted — struck at different times)\n\n');
  process.stdout.write(
    renderTable(
      [
        { key: 'shortName', label: 'Fund', align: 'left' },
        { key: 'nav', label: 'NAV/share', align: 'right' },
        { key: 'so', label: 'Shares out', align: 'right' },
        { key: 'implied', label: 'NAV x shares $', align: 'right' },
        { key: 'total', label: 'Sum of rows $', align: 'right' },
        { key: 'residual', label: 'Residual', align: 'right' },
      ],
      diagnostics.map((d) => ({
        shortName: d.shortName,
        nav: d.navPerShare === null ? '—' : d.navPerShare.toFixed(6),
        so: num(d.sharesOutstanding),
        implied: num(d.impliedAum, 0),
        total: num(d.totalMarketValueUsd, 0),
        residual: d.navResidualPct === null ? '—' : `${d.navResidualPct >= 0 ? '+' : ''}${d.navResidualPct.toFixed(3)}%`,
      })),
    ),
  );

  process.stdout.write('\n\nNotes\n');
  for (const d of diagnostics) {
    process.stdout.write(
      `  ${d.shortName.padEnd(9)} ${d.columns} columns` +
        `${d.hasTypeColumn ? ' (includes "Type")' : ' (no "Type" column)'}` +
        `, ${num(d.historicalRowCount)} historical NAV rows` +
        `, non-equity India rows: ${d.nonEquityIndiaAssetClasses.join(', ') || 'none'}\n`,
    );
  }
  process.stdout.write(
    '\n  Weights are percentages of their own fund. There is no arithmetic that\n' +
      '  relates a weight in one fund to a weight in another — do not sum, average\n' +
      '  or rank across the three columns above.\n',
  );

  if (failed.length > 0) {
    process.stderr.write(
      `\nREFUSING TO WRITE ${OUT_PATH.replace(REPO + '/', '')} — ${failed.reduce((a, r) => a + r.checks.failures.length, 0)} check(s) failed:\n\n`,
    );
    for (const result of failed) result.checks.print();
    process.stderr.write(
      '\nThese values describe the workbooks committed in scripts/fixtures/. If you\n' +
        'replaced them with a fresh download, re-measure and update the EXPECTED table\n' +
        'in this script in the same commit as the new fixtures. Do not loosen the check.\n',
    );
    process.exit(1);
  }

  const payload = {
    source: 'iShares fund holdings workbooks (BlackRock) — scripts/import-ishares.mjs',
    importedAt: new Date().toISOString(),
    fixtures: FUNDS.map((f) => `scripts/fixtures/${f.fixture}`),
    units: {
      weightPct: 'percent of the fund it appears under; not comparable across funds',
      marketValueUsd: 'USD, as reported by BlackRock',
      priceUsd: 'USD per share, as reported by BlackRock (rounded to cents in the source)',
      fxRate: 'local currency units per USD, as reported by BlackRock',
    },
    funds: results.map((r) => r.record),
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const totalHoldings = payload.funds.reduce((a, f) => a + f.holdings.length, 0);
  process.stdout.write(
    `\nAll checks passed. Wrote ${OUT_PATH.replace(REPO + '/', '')} — ` +
      `${payload.funds.length} funds, ${num(totalHoldings)} India equity holdings.\n\n`,
  );
}

main();
