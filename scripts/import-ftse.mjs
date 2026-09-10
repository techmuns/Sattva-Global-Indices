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
 * different currency. `assertCurrency` in public/js/model/ftse-resolve.js re-runs that
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
import { inflateRawSync } from 'node:zlib';

// ⚠ THE PARSE LIVES UNDER public/js NOW, AND THIS SCRIPT IS NO LONGER ITS ONLY
// CALLER. The dashboard's upload panel reads the same workbook with the same
// reader, so the desk can drop in a fresh quarterly book without waiting for
// anyone to run this. A second parser for the browser would produce plausible
// rows that quietly disagreed with these ones — see the header of ftse-book.js.
import { readFtseBook, assertBookShape } from '../public/js/model/ftse-book.js';
import { renderTable, num } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const FIXTURE = join(REPO, 'scripts', 'fixtures', 'vanguard-ftse-em-allcap.xlsx');
const OUT_PATH = join(REPO, 'public', 'data', 'ftse-funds.json');

/**
 * Node has a synchronous raw inflate and the browser has none, so the shared
 * reader takes it as an argument. `inflateRawSync` returns a Buffer, which IS a
 * Uint8Array — no copy needed, and the reader only ever indexes and decodes it.
 */
const inflateRaw = (body) => inflateRawSync(body);

/**
 * Measured on the committed fixture. This describes THAT WORKBOOK, not the fund
 * in general — a fresh download will legitimately move every number here, and
 * the table must be re-measured in the same commit that replaces the file
 * (§5). Never loosen a figure to make a run pass.
 *
 * ⚠ THIS TABLE DOES NOT TRAVEL TO THE UPLOAD PANEL, and it must not. An upload
 * is by definition a different workbook, so every figure here will have moved
 * legitimately and applying it there would reject every real quarterly book.
 * What the panel runs instead is `assertBookShape` — the checks that hold for
 * ANY Vanguard book, plus the shrink guard every writer here follows.
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

async function main() {
  const { payload, measured } = await readFtseBook(readFileSync(FIXTURE), inflateRaw, {
    fixtures: ['scripts/fixtures/vanguard-ftse-em-allcap.xlsx'],
    receivedAs: 'committed fixture',
  });
  const fund = payload.funds[0];

  // ---- is this a Vanguard holdings book at all? --------------------------
  //
  // The SAME structural checks the upload panel runs, before the fixture-specific
  // drift check below. They are looser and they answer a different question — is
  // this the right kind of file, rather than is it the file we measured — and a
  // structurally broken workbook gets a sentence naming what is wrong with it
  // instead of a list of eleven drifted figures.
  const shape = assertBookShape(measured, { previous: null });
  if (!shape.ok) {
    process.stderr.write(
      `\nThis does not read as a Vanguard holdings export:\n\n${
        shape.checks.filter((c) => !c.ok).map((c) => `  ${c.label} — ${c.detail}`).join('\n')
      }\n\n`,
    );
    process.exit(1);
  }

  // ---- refuse to write on drift from the committed workbook ---------------
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

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  process.stdout.write(`\nVanguard FTSE EM holdings — ${fund.name}\n\n`);
  process.stdout.write(renderTable(
    [{ key: 'k', label: 'measured' }, { key: 'v', label: '', align: 'right' }],
    [
      { k: 'holdings as at', v: fund.asOf },
      { k: 'downloaded on', v: fund.downloadedOn },
      { k: 'rows in the book', v: num(fund.dataRows) },
      { k: 'India rows', v: num(fund.indiaRows) },
      { k: 'India weight, of the whole fund', v: `${measured.indiaWeightPct3dp}%` },
      { k: 'all weights sum to', v: `${measured.totalWeightPct3dp}%  (cash and futures excluded)` },
      { k: 'India market value', v: `CAD ${num(Math.round(fund.indiaMarketValueCad))}` },
      { k: 'rows with a placeholder name', v: num(measured.placeholderNameRows) },
      { k: 'rows with no ticker', v: num(measured.noTickerRows) },
      { k: "rows Vanguard rounded to '0.00%'", v: num(measured.weightRoundsToZeroRows) },
    ],
  ));
  process.stdout.write(`\nWrote ${OUT_PATH.replace(`${REPO}/`, '')}\n\n`);
}

await main();
