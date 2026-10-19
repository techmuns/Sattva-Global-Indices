#!/usr/bin/env node
/**
 * fetch-ishares.mjs — BlackRock's own holdings export for EEM, SMIN and EEMS
 *                     -> scripts/fixtures/ishares-{eem,smin,eems}.xls
 *                        + scripts/fixtures/ishares-expected.json, re-measured
 *
 *   node scripts/fetch-ishares.mjs            download, check, write what is newer
 *   node scripts/fetch-ishares.mjs --dry-run  download and check; write nothing
 *
 * Then `node scripts/import-ishares.mjs` turns the workbooks into msci-funds.json
 * exactly as it always has — this script only replaces what that one reads.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS WAS "REFRESHED BY HAND", AND WHY IT NO LONGER HAS TO BE
 * ---------------------------------------------------------------------------
 * Measured 22 Sep 2026, the old `…/1467271812596.ajax?fileType=xls` URL answered
 * HTTP 200, `application/vnd.ms-excel`, and 1.4 MB of `<!DOCTYPE html>` — and the
 * conclusion recorded was that BlackRock serves a datacentre IP an HTML page.
 * Measured 19 Oct 2026 it does exactly the same to a residential line, and to a
 * real browser: the `.ajax` download was RETIRED, not blocked. The product page
 * now links BlackRock's product-data API, which answers plain curl with the
 * same SpreadsheetML 2003 workbook the committed fixtures are, byte-format for
 * byte-format. The "hand" in `refreshedBy: 'hand'` was a stale URL.
 *
 * ---------------------------------------------------------------------------
 * WHAT A FRESH WORKBOOK MUST PASS BEFORE IT REPLACES A COMMITTED ONE
 * ---------------------------------------------------------------------------
 * The importer's EXPECTED table cannot judge a new download — every figure in it
 * legitimately moves. So, exactly as §2.38 split the FTSE upload, a download is
 * held to what is true of ANY iShares book, plus a shrink guard:
 *
 *   - it is SpreadsheetML, not the HTML shell (a 200 is not a contract, §3.8);
 *   - measureWorkbook()'s structural checks: sheets, columns, a number in every
 *     row, NSE + BSE accounting for every India row;
 *   - it names THIS fund, and keeps this fund's column set (`Type` or not);
 *   - its "as of" is not older than the committed file's — never move backwards;
 *   - the India equity slice did not collapse: at least SHRINK_FLOOR of the
 *     committed row count, and a weight sum inside (0, 100].
 *
 * Only then is the file written, and its entry in ishares-expected.json
 * re-measured in the SAME write — the contract import-ishares.mjs has always
 * stated, now kept by the one actor that replaces the file.
 *
 * Nothing is written for a fund whose download is no newer than what is
 * committed, so a quiet day is a clean no-op rather than a churned commit.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { FUNDS, EXPECTED_PATH, measureWorkbook } from './import-ishares.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** BlackRock's own portfolio ids, read off each fund's product page (19 Oct 2026). */
const PORTFOLIO_IDS = { eem: '239637', smin: '239660', eems: '239642' };

const downloadUrl = (portfolioId) =>
  'https://www.blackrock.com/varnish-api/blk-one01-product-data/product-data/api/v1/get-fund-document'
  + `?appType=PRODUCT_PAGE&appSubType=ISHARES&targetSite=us-ishares&locale=en_US&portfolioId=${portfolioId}`
  + '&userType=individual&component=fundDownload';

/** A fresh India slice below this share of the committed one is a broken read, not a rebalance. */
const SHRINK_FLOOR = 0.6;

const STATUS_SENTINEL = '\n__CURL_HTTP_STATUS__';

function curlText(url) {
  return new Promise((resolve) => {
    execFile(
      'curl',
      ['-s', '-S', '-L', '--fail-with-body', '--retry', '4', '--retry-delay', '10', '--retry-all-errors',
        '--max-time', '180', '--compressed', '-A', USER_AGENT, '-w', `${STATUS_SENTINEL}%{http_code}`, url],
      { maxBuffer: 128 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          resolve({ ok: false, reason: `curl failed: ${String(stderr || error.message).trim().split('\n')[0]}` });
          return;
        }
        const at = stdout.lastIndexOf(STATUS_SENTINEL);
        if (at === -1) { resolve({ ok: false, reason: 'curl produced no status line' }); return; }
        const status = Number.parseInt(stdout.slice(at + STATUS_SENTINEL.length).trim(), 10);
        resolve(status === 200 ? { ok: true, text: stdout.slice(0, at) } : { ok: false, reason: `HTTP ${status}` });
      },
    );
  });
}

/** Every reason this download may not replace the committed workbook; empty means it may. */
function shapeProblems(result, committed) {
  const problems = [];
  if (!result.measured) {
    problems.push('the workbook did not parse far enough to measure');
    return problems;
  }
  for (const failure of result.checks.failures) problems.push(`${failure.what}: ${failure.detail ?? ''}`.trim());
  const m = result.measured;
  if (m.name !== committed.name) problems.push(`names "${m.name}", not "${committed.name}"`);
  if (m.hasTypeColumn !== committed.hasTypeColumn) {
    problems.push(`the "Type" column ${m.hasTypeColumn ? 'appeared' : 'disappeared'} — a changed export format`);
  }
  if (m.holdingsAsOf && m.holdingsAsOf < committed.holdingsAsOf) {
    problems.push(`as of ${m.holdingsAsOf}, OLDER than the committed ${committed.holdingsAsOf}`);
  }
  if (m.indiaEquityRows < Math.ceil(committed.indiaEquityRows * SHRINK_FLOOR)) {
    problems.push(`${m.indiaEquityRows} India equity rows against ${committed.indiaEquityRows} committed `
      + `(floor ${Math.round(SHRINK_FLOOR * 100)}%) — a partial file, not a rebalance`);
  }
  const weight = Number(m.indiaWeightPct3dp);
  if (!(weight > 0 && weight <= 100)) problems.push(`India weight sum ${m.indiaWeightPct3dp}% is outside (0, 100]`);
  return problems;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const expectedFile = JSON.parse(readFileSync(EXPECTED_PATH, 'utf8'));

  process.stdout.write('\niShares holdings — BlackRock product-data export\n\n');

  const refused = [];
  const fresh = [];
  for (const fund of FUNDS) {
    const committed = expectedFile.funds[fund.id];
    const response = await curlText(downloadUrl(PORTFOLIO_IDS[fund.id]));
    if (!response.ok) {
      refused.push(fund.id);
      process.stdout.write(`  ${fund.id.padEnd(5)} FAIL  could not download: ${response.reason}\n`);
      continue;
    }
    if (!response.text.includes('urn:schemas-microsoft-com:office:spreadsheet')) {
      refused.push(fund.id);
      process.stdout.write(`  ${fund.id.padEnd(5)} FAIL  HTTP 200 but not a workbook (${response.text.length} bytes, `
        + `starts ${JSON.stringify(response.text.slice(0, 40))})\n`);
      continue;
    }
    const result = measureWorkbook(response.text, fund);
    const problems = shapeProblems(result, committed);
    if (problems.length > 0) {
      refused.push(fund.id);
      process.stdout.write(`  ${fund.id.padEnd(5)} FAIL  refused:\n${problems.map((p) => `          - ${p}\n`).join('')}`);
      continue;
    }
    const m = result.measured;
    if (m.holdingsAsOf === committed.holdingsAsOf) {
      process.stdout.write(`  ${fund.id.padEnd(5)} same  as of ${m.holdingsAsOf} — already committed, nothing to write\n`);
      continue;
    }
    fresh.push({ fund, text: response.text, measured: m });
    process.stdout.write(`  ${fund.id.padEnd(5)} NEW   as of ${m.holdingsAsOf} (was ${committed.holdingsAsOf}) · `
      + `${m.indiaEquityRows} India equity rows (was ${committed.indiaEquityRows}) · `
      + `India weight ${m.indiaWeightPct3dp}% (was ${committed.indiaWeightPct3dp}%)\n`);
  }

  if (!dryRun && fresh.length > 0) {
    for (const { fund, text, measured } of fresh) {
      writeFileSync(join(FIXTURES, fund.fixture), text, 'utf8');
      expectedFile.funds[fund.id] = measured;
    }
    expectedFile.measuredOn = new Date().toISOString().slice(0, 10);
    writeFileSync(EXPECTED_PATH, `${JSON.stringify(expectedFile, null, 2)}\n`, 'utf8');
    process.stdout.write(`\nWrote ${fresh.length} workbook(s) and re-measured ishares-expected.json in the same write.\n`
      + 'Run scripts/import-ishares.mjs next.\n');
  } else if (dryRun) {
    process.stdout.write(`\n--dry-run: ${fresh.length} newer workbook(s) found, nothing written.\n`);
  } else {
    process.stdout.write('\nNothing newer than what is committed.\n');
  }

  if (refused.length > 0) {
    process.stdout.write(`\n${refused.length} fund(s) refused (${refused.join(', ')}). Their committed workbooks are `
      + 'unchanged, so msci-funds.json keeps their last good holdings and the freshness strip ages them honestly.\n\n');
    process.exit(1);
  }
  process.stdout.write('\n');
}

main();
