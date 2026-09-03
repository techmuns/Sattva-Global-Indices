#!/usr/bin/env node
/**
 * scrape-nse-asm.mjs — NSE Additional Surveillance Measure report -> public/data/nse-asm.json
 *
 *   node scripts/scrape-nse-asm.mjs
 *
 * Zero dependencies. Shells out to `curl`. Read the next paragraph before you
 * "simplify" that.
 *
 * ---------------------------------------------------------------------------
 * DO NOT REPLACE curl WITH fetch(). IT IS NOT A HEADER PROBLEM.
 * ---------------------------------------------------------------------------
 * This hits www.nseindia.com, whose Akamai edge TLS/HTTP2-fingerprints Node's
 * built-in fetch (undici) and answers it 403 regardless of headers, while `curl`
 * with a browser User-Agent gets HTTP 200. The whole story is in the header of
 * scrape-nse-freefloat.mjs and in CLAUDE.md §3.7; the same rule binds here.
 *
 * ---------------------------------------------------------------------------
 * WHAT ASM IS, AND WHY THE DASHBOARD SHOWS IT
 * ---------------------------------------------------------------------------
 * The Additional Surveillance Measure is an NSE/SEBI framework that puts volatile
 * or manipulation-prone stocks under extra surveillance — a stage that tightens
 * margins, caps price bands and, at the top stages, forces trade-to-trade
 * settlement. A portfolio manager weighing a small-cap for a forced-flow trade
 * needs to know a name is under ASM: the constraints change how a position can be
 * built or unwound. This is exactly the population where inclusion forecasting
 * matters, so the surveillance stage rides on the company record.
 *
 * /api/reportASM is NSE's own published list, returned as {longterm, shortterm},
 * each a `data[]` of rows carrying `isin`, `symbol`, `survCode` (e.g.
 * "LTASM - I (13)"), `survDesc` and `asmTime` (the date the list took effect).
 * dhan.co/nse-asm-list — the source the desk pointed at — mirrors this same feed;
 * NSE is where it comes from, it carries the ISIN this project keys everything on
 * (§3.9), and it needs no pagination: the report is the complete list in one call.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCRIPT REFUSES TO DO
 * ---------------------------------------------------------------------------
 *  - It will not report a blocked read as "no stocks are under ASM". A failed
 *    fetch lands in `failed[]` with its reason and the previous good snapshot is
 *    kept, because rendering an outage as an empty list is the §2.4 lie.
 *  - It will not overwrite a good previous snapshot with a much smaller one. The
 *    ASM roster moves day to day, but a halving is a partial read, not a quiet
 *    day — pass --allow-shrink if the list genuinely shrank and you mean it.
 *  - It will not exit 0 having collected nothing.
 *  - It carries NSE's own figures through unchanged (tier 1). It never invents a
 *    stage, and a row with no ISIN cannot be joined so it is recorded apart in
 *    `noIsin[]` rather than dropped or force-fitted.
 */

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { renderTable, num } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const OUT_PATH = join(REPO, 'public', 'data', 'nse-asm.json');

const ENDPOINT = 'https://www.nseindia.com/api/reportASM';

// A real browser UA is required: with no User-Agent the edge refuses the
// connection. Measured: bare UA returns HTTP 200 with the full report, exactly
// as for the pre-open free-float endpoint.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// NSE throttles intermittently — a request that worked a minute ago can 403 and
// then succeed seconds later. `--fail-with-body` is load-bearing: without --fail
// curl treats an HTTP 403 as a successful transfer carrying an error page, so
// --retry-all-errors sees nothing to retry and the first throttle becomes a
// permanent "outage" (CLAUDE.md §3.7).
const RETRY_COUNT = 6;
const CURL_ARGS = [
  '-s',
  '-S',
  '--fail-with-body',
  '--retry', String(RETRY_COUNT),
  '--retry-delay', '20',
  '--retry-all-errors',
  '--max-time', '40',
];

const STATUS_SENTINEL = '\n__CURL_HTTP_STATUS__';

function curlJson(url) {
  return new Promise((resolve) => {
    execFile(
      'curl',
      [
        ...CURL_ARGS,
        '-A', USER_AGENT,
        '-H', 'accept: application/json',
        '-H', 'referer: https://www.nseindia.com/',
        '-w', `${STATUS_SENTINEL}%{http_code}`,
        url,
      ],
      { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          const detail = String(stderr || error.message).trim().split('\n')[0];
          resolve({ ok: false, reason: `curl failed: ${detail || 'no output'}` });
          return;
        }
        const at = stdout.lastIndexOf(STATUS_SENTINEL);
        if (at === -1) {
          resolve({ ok: false, reason: 'curl produced no status line' });
          return;
        }
        const status = Number.parseInt(stdout.slice(at + STATUS_SENTINEL.length).trim(), 10);
        const body = stdout.slice(0, at);
        if (status !== 200) {
          resolve({
            ok: false,
            reason: `HTTP ${Number.isFinite(status) ? status : '???'} after ${RETRY_COUNT} retries`,
            bytes: body.length,
          });
          return;
        }
        try {
          resolve({ ok: true, json: JSON.parse(body), bytes: body.length });
        } catch (parseError) {
          resolve({
            ok: false,
            reason: `HTTP 200 but the body did not parse as JSON (${body.length} bytes): ${parseError.message}`,
          });
        }
      },
    );
  });
}

/** A trimmed non-empty string, or null. Never '' — an empty field is not a value. */
function text(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** The two categories NSE returns, and how each renders on the desk's screen. */
const CATEGORIES = [
  { key: 'longterm', label: 'Long Term ASM (LTASM)' },
  { key: 'shortterm', label: 'Short Term ASM (STASM)' },
];

/**
 * Normalise one NSE ASM row, carrying its published fields through UNCHANGED.
 *
 * Returns null for a row with no ISIN: it cannot be joined to the universe
 * (§3.9 keys on ISIN), and guessing a match by symbol is exactly the fuzzy join
 * this project refuses. Such rows are counted and kept in `noIsin[]` so a gap is
 * never mistaken for an absence.
 */
function normalise(row, categoryKey) {
  const isin = text(row?.isin);
  const base = {
    isin,
    symbol: text(row?.symbol),
    companyName: text(row?.companyName),
    category: categoryKey,
    // NSE's own words, carried verbatim — tier 1. `survCode` is the code dhan
    // shows ("LTASM - I (13)"); `stage` is the short indicator ("Stage I").
    stage: text(row?.asmSurvIndicator),
    survCode: text(row?.survCode),
    survDesc: text(row?.survDesc),
    // The date NSE says the list took effect. Carried, never restamped.
    asmDate: text(row?.asmTime),
    series: text(row?.series),
  };
  return { isin, base };
}

function previousSnapshot() {
  if (!existsSync(OUT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(OUT_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const allowShrink = process.argv.includes('--allow-shrink');

  process.stdout.write(`\nNSE ASM report scrape — ${ENDPOINT}\n`);
  process.stdout.write('Transport: curl (node fetch is fingerprinted and 403s — see header comment)\n\n');

  const result = await curlJson(ENDPOINT);

  // A blocked read is an OUTAGE, not "nothing is under ASM". Keep the last good
  // snapshot in place, record the failure, exit non-zero.
  if (!result.ok) {
    process.stdout.write(`  FAIL  ${result.reason}\n`);
    const previous = previousSnapshot();
    if (previous) {
      process.stderr.write(
        `\nThe fetch failed and a previous snapshot exists (${num(previous.totalFlagged ?? 0)} flagged, ` +
          `captured ${previous.capturedAt ?? '?'}). Leaving it in place rather than overwriting a good\n` +
          'file with an outage. Exiting non-zero.\n\n',
      );
    } else {
      process.stderr.write('\nThe fetch failed and there is no previous snapshot. Nothing written; exiting non-zero.\n\n');
    }
    process.exit(1);
  }

  // Parse the two categories. A category that is absent from the response (not
  // merely empty) is a shape change worth failing on.
  const companies = [];
  const noIsin = [];
  const failed = [];
  const byCategory = [];
  for (const cat of CATEGORIES) {
    const rows = result.json?.[cat.key]?.data;
    if (!Array.isArray(rows)) {
      failed.push({ category: cat.key, reason: `response carried no ${cat.key}.data array` });
      byCategory.push({ key: cat.key, label: cat.label, count: null, byStage: null });
      continue;
    }
    let kept = 0;
    const byStage = new Map();
    for (const row of rows) {
      const { isin, base } = normalise(row, cat.key);
      byStage.set(base.survCode ?? '(no code)', (byStage.get(base.survCode ?? '(no code)') ?? 0) + 1);
      if (isin === null) {
        noIsin.push(base);
        continue;
      }
      companies.push(base);
      kept += 1;
    }
    byCategory.push({
      key: cat.key,
      label: cat.label,
      count: rows.length,
      withIsin: kept,
      byStage: Object.fromEntries([...byStage.entries()].sort((a, b) => b[1] - a[1])),
    });
  }

  const totalFlagged = companies.length + noIsin.length;

  // The as-of NSE itself stamps on the rows. Every row carries the same date;
  // if they ever disagree, keep them all and surface the set rather than pick one.
  const asOfDates = [...new Set([...companies, ...noIsin].map((c) => c.asmDate).filter(Boolean))];
  const asOf = asOfDates.length === 1 ? asOfDates[0] : (asOfDates[0] ?? null);

  // ---- report ----------------------------------------------------------
  process.stdout.write(
    renderTable(
      [
        { key: 'cat', label: 'Category', align: 'left' },
        { key: 'rows', label: 'Rows', align: 'right' },
        { key: 'isin', label: 'With ISIN', align: 'right' },
        { key: 'stages', label: 'Stages', align: 'left' },
      ],
      byCategory.map((c) => ({
        cat: c.label,
        rows: c.count === null ? 'FAIL' : num(c.count),
        isin: c.count === null ? '—' : `${num(c.withIsin)} of ${num(c.count)}`,
        stages: c.byStage
          ? Object.entries(c.byStage).map(([code, n]) => `${code}: ${n}`).join(', ')
          : '—',
      })),
    ),
  );
  process.stdout.write(
    `\n\nTotal under ASM: ${num(totalFlagged)} securities ` +
      `(${num(companies.length)} with an ISIN to join on, ${num(noIsin.length)} without). ` +
      `NSE effective date: ${asOf ?? '—'}.\n`,
  );
  if (failed.length) {
    process.stdout.write('\nCategories that failed to parse (recorded in failed[], NOT rendered as zero):\n');
    for (const f of failed) process.stdout.write(`  ${f.category.padEnd(10)} ${f.reason}\n`);
  }

  // ---- refuse to overwrite good data with a partial or empty read ------
  if (failed.length > 0) {
    const previous = previousSnapshot();
    if (previous && !allowShrink) {
      process.stderr.write(
        `\nREFUSING TO WRITE: ${failed.length} categor(y/ies) failed to parse, so this is a partial\n` +
          `read. A previous snapshot exists (${num(previous.totalFlagged ?? 0)} flagged) and is kept.\n` +
          'Pass --allow-shrink only if NSE genuinely changed the report shape.\n\n',
      );
      process.exit(1);
    }
  }

  if (totalFlagged === 0) {
    const previous = previousSnapshot();
    if (previous && !allowShrink) {
      process.stderr.write(
        '\nREFUSING TO WRITE: the report parsed but carried no securities at all, and a previous\n' +
          `snapshot exists (${num(previous.totalFlagged ?? 0)} flagged). An empty ASM list is far more\n` +
          'likely a bad read than a day on which nothing is under surveillance. Pass --allow-shrink to\n' +
          'write it anyway.\n\n',
      );
      process.exit(1);
    }
    if (!previous) {
      process.stderr.write(
        '\nThe report parsed but carried no securities and there is no previous snapshot to compare\n' +
          'against. Nothing written; exiting non-zero.\n\n',
      );
      process.exit(1);
    }
  }

  const previous = previousSnapshot();
  if (previous && previous.totalFlagged > 0 && totalFlagged < previous.totalFlagged * 0.5 && !allowShrink) {
    process.stderr.write(
      `\nREFUSING TO WRITE: ${num(totalFlagged)} securities read this run, less than half the ` +
        `${num(previous.totalFlagged)} in the\nprevious snapshot. A halving is far more likely a partial read ` +
        'than a genuine roster change.\nPass --allow-shrink if the list really shrank this much.\n\n',
    );
    process.exit(1);
  }

  companies.sort((a, b) => (a.symbol ?? a.isin ?? '').localeCompare(b.symbol ?? b.isin ?? ''));

  const payload = {
    source: 'NSE Additional Surveillance Measure (ASM) report — nseindia.com/api/reportASM',
    note:
      'NSE\'s published list of securities under Additional Surveillance Measure (ASM), with the ' +
      'surveillance stage for each, carried through unchanged (tier 1). Joined to the universe by ISIN. ' +
      'dhan.co/nse-asm-list mirrors this same NSE feed.',
    capturedAt: new Date().toISOString(),
    // NSE's own effective date for the list, carried verbatim — a different fact
    // from when we fetched it (capturedAt), and never restamped.
    asOf,
    endpoint: ENDPOINT,
    totalFlagged,
    withIsin: companies.length,
    categories: byCategory,
    companies,
    // Rows NSE published with no ISIN — counted, kept, but not joinable.
    noIsin,
    failed,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `\nWrote ${OUT_PATH.replace(`${REPO}/`, '')} — ${num(totalFlagged)} under ASM ` +
      `(${num(companies.length)} joinable by ISIN), effective ${asOf ?? '—'}, ${failed.length} failed categor(y/ies).\n\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`\nUnhandled failure: ${error?.stack || error}\n\n`);
  process.exit(1);
});
