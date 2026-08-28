#!/usr/bin/env node
/**
 * fetch-bhavcopy.mjs — BSE end-of-day bhavcopy -> public/data/prices.json
 *
 *   node scripts/fetch-bhavcopy.mjs [--date YYYY-MM-DD] [--allow-shrink]
 *                                   [--min-coverage 95] [--from-file path.csv]
 *
 * One request for the whole market. The output is COMMITTED, and it is the
 * floor: the static site must render fully from it with no Worker and no
 * network beyond the committed files.
 *
 * ---------------------------------------------------------------------------
 * THIS SCRIPT FAILS LOUDLY RATHER THAN COMMITTING A DEGRADED FILE
 * ---------------------------------------------------------------------------
 * A dashboard silently serving yesterday's prices under today's date is worse
 * than one that visibly failed. So the run exits non-zero and writes nothing if:
 *
 *   - the response is not a bhavcopy (HTML-with-a-200, wrong columns);
 *   - its own TradDt is not the date requested;
 *   - row-level continuity against the previous file fails;
 *   - fewer than `--min-coverage`% of the universe priced.
 *
 * A stock ABSENT from the file has not traded. That is not zero and not
 * "unchanged": its last close is carried forward with `staleDays`, and every
 * figure computed from it is marked.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';

import {
  assertBhavcopyShape, parseBhavcopy, assertContinuity, bhavcopyUrl,
} from './lib/bhavcopy.mjs';
import { renderTable, num, CheckList } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const OUT_PATH = join(REPO, 'public', 'data', 'prices.json');
const rel = (p) => p.replace(`${REPO}/`, '');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const STATUS_SENTINEL = '\n__CURL_HTTP_STATUS__';

function curlText(url) {
  return new Promise((resolve) => {
    execFile(
      'curl',
      [
        '-s', '-S', '--fail-with-body',
        '--retry', '4', '--retry-delay', '5', '--retry-all-errors',
        '--max-time', '120', '--compressed',
        '-A', USER_AGENT, '-H', 'referer: https://www.bseindia.com/',
        '-w', `${STATUS_SENTINEL}%{http_code}\n__CT__%{content_type}`,
        url,
      ],
      { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          resolve({ ok: false, reason: `curl failed: ${String(stderr || error.message).trim().split('\n')[0]}` });
          return;
        }
        const ctAt = stdout.lastIndexOf('\n__CT__');
        const contentType = ctAt === -1 ? '' : stdout.slice(ctAt + 7).trim();
        const rest = ctAt === -1 ? stdout : stdout.slice(0, ctAt);
        const at = rest.lastIndexOf(STATUS_SENTINEL);
        if (at === -1) { resolve({ ok: false, reason: 'curl produced no status line' }); return; }
        const status = Number.parseInt(rest.slice(at + STATUS_SENTINEL.length).trim(), 10);
        resolve({ ok: status === 200, status, contentType, text: rest.slice(0, at), reason: status === 200 ? null : `HTTP ${status}` });
      },
    );
  });
}

/** Most recent weekday, in IST — the exchange's own calendar day. */
/**
 * The most recent date BSE could plausibly have PUBLISHED a bhavcopy for.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS FIXES, AND IT COST SIX RED RUNS
 * ---------------------------------------------------------------------------
 * The old version converted to IST and stepped off weekends, which is right as
 * far as it goes — and it only knew the IST *date*, never the IST *time*. The
 * scheduled run on 27 Aug 2026 started at 23:50 UTC, which is 05:20 IST on the
 * 28th: a Friday, so the function returned 2026-08-28 and the job asked BSE for
 * a bhavcopy of a session that had not opened yet. BSE answered with its
 * single-page-app shell, the shape assertion refused to write, and the job went
 * red for a reason that had nothing to do with the data.
 *
 * A GitHub Actions schedule is best-effort and can be delayed by hours, so
 * "what time is it in IST" is not a detail the caller can be assumed to control.
 *
 * PUBLICATION_HOUR_IST is deliberately later than the 15:30 close: BSE takes a
 * while to publish, and asking early costs a whole day's refresh while asking
 * late costs nothing at all — the previous session's file is the last close,
 * which is exactly what the dashboard claims to show.
 */
const PUBLICATION_HOUR_IST = 18;

function latestTradeDate(now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  // Before BSE has published, the newest available session is the PREVIOUS one.
  if (ist.getUTCHours() < PUBLICATION_HOUR_IST) ist.setUTCDate(ist.getUTCDate() - 1);
  const day = ist.getUTCDay();
  if (day === 0) ist.setUTCDate(ist.getUTCDate() - 2);
  else if (day === 6) ist.setUTCDate(ist.getUTCDate() - 1);
  return ist.toISOString().slice(0, 10);
}

/** One calendar day earlier, skipping back over weekends. YYYY-MM-DD. */
function previousTradingDay(date) {
  const d = new Date(`${date}T00:00:00Z`);
  do { d.setUTCDate(d.getUTCDate() - 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

const daysBetween = (a, b) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

function readJson(path) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; }
  catch { return null; }
}

async function main() {
  const args = process.argv.slice(2);
  const argOf = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback; };
  const tradeDate = argOf('--date', latestTradeDate());
  const minCoverage = Number(argOf('--min-coverage', '95'));
  const fromFile = argOf('--from-file', null);
  const allowShrink = args.includes('--allow-shrink');

  const checks = new CheckList('bhavcopy');

  process.stdout.write(`\nBSE bhavcopy — ${tradeDate}\n\n`);

  let text;
  let contentType = 'text/csv';
  let resolvedDate = tradeDate;

  if (fromFile) {
    process.stdout.write(`  reading ${fromFile} (offline)\n`);
    text = readFileSync(fromFile, 'utf8');
  } else {
    // ---- WALK BACK OVER SESSIONS THAT DO NOT EXIST -----------------------
    //
    // India has a lot of trading holidays and no published-as-data calendar we
    // carry, so "the last weekday" is regularly not a session. On such a day BSE
    // answers its single-page-app shell, the shape assertion refuses — correctly
    // — and the whole refresh goes red for a market that was simply shut.
    //
    // Walking back is honest because the FILE CARRIES ITS OWN DATE: whatever
    // lands is stamped with the session it belongs to and the dashboard shows
    // that date. Serving Thursday's close on a Friday holiday is not a stale
    // number pretending to be today's, it is the last close, which is exactly
    // what the header claims.
    //
    // Only when the caller did not name a date. An explicit --date is a
    // question about THAT day and must fail loudly rather than answer about
    // another one.
    const explicit = argOf('--date', null) !== null;
    const maxStepBack = explicit ? 0 : 6;
    let attempt = 0;
    let candidate = tradeDate;

    for (;;) {
      const url = bhavcopyUrl(candidate);
      process.stdout.write(`  GET ${url}\n`);
      const response = await curlText(url);
      if (!response.ok) {
        process.stderr.write(`\nCould not fetch the bhavcopy: ${response.reason}\n` +
          'This is an outage, not a day with no prices. Nothing written.\n\n');
        process.exit(1);
      }
      const probe = assertBhavcopyShape(response.text, { expectDate: candidate, contentType: response.contentType });
      // "Not a CSV at all" means the session does not exist. Anything else — a
      // CSV whose own TradDt disagrees, missing columns — is a real fault and
      // must not be walked past.
      const sessionMissing = !probe.ok && probe.problems.some((p) => /not CSV|HTML/i.test(p));

      if (probe.ok || !sessionMissing || attempt >= maxStepBack) {
        text = response.text;
        contentType = response.contentType;
        resolvedDate = candidate;
        process.stdout.write(`  ${num(Math.round(text.length / 1024))} KB, content-type ${contentType}\n`);
        break;
      }

      attempt += 1;
      const back = previousTradingDay(candidate);
      process.stdout.write(
        `  ${candidate} has no bhavcopy — a holiday, or BSE has not published yet. `
        + `Stepping back to ${back} (${attempt} of ${maxStepBack}).\n`,
      );
      candidate = back;
    }
  }

  if (resolvedDate !== tradeDate) {
    process.stdout.write(`\n  Resolved to ${resolvedDate}: ${tradeDate} was not a trading session.\n`);
  }

  // ---- shape: a 200 is not a contract ------------------------------------
  const shape = assertBhavcopyShape(text, { expectDate: resolvedDate, contentType });
  checks.assert(shape.ok, 'the response IS a bhavcopy for the requested date', shape.problems.join('; '));
  if (!shape.ok) {
    process.stderr.write('\nREFUSING TO WRITE — the response did not pass the shape assertion:\n');
    for (const problem of shape.problems) process.stderr.write(`  • ${problem}\n`);
    process.stderr.write(
      '\nBSE serves its single-page-app shell with HTTP 200 for URLs that do not exist, so a\n' +
      'status check alone would have written an empty price file and turned every free-float\n' +
      'figure null on a day when nothing was wrong.\n\n',
    );
    process.exit(1);
  }

  const { rows } = parseBhavcopy(text);
  process.stdout.write(`  parsed ${num(rows.length)} rows, TradDt ${shape.tradeDate}\n\n`);

  // ---- universe: the scrips this project actually prices -------------------
  const bseFloat = readJson(join(REPO, 'public', 'data', 'bse-freefloat.json'));
  if (!bseFloat) {
    process.stderr.write('Missing public/data/bse-freefloat.json. Run scripts/scrape-bse-freefloat.mjs first.\n\n');
    process.exit(1);
  }
  const universe = new Map(bseFloat.scrips.map((s) => [s.scripCode, s]));
  const byScrip = new Map(rows.map((r) => [r.scripCode, r]));

  // ---- continuity against the previous committed file ---------------------
  const previous = readJson(OUT_PATH);
  let continuity = { compared: 0, failures: [], skipped: 0, against: null };

  // The continuity test is "today's previous-close equals YESTERDAY's close".
  // It is only meaningful when the stored file is a DIFFERENT trading day. Run
  // it against a file carrying the same trade date and it compares today's
  // previous-close (yesterday's number) against today's close, so almost every
  // scrip "fails" — 1,194 failures out of 1,196 compared, measured on the one
  // scheduled run this workflow has ever made.
  //
  // That is a guard reading its own subject: a same-day re-run, and every first
  // scheduled run after a manual build on the same day, fails on a file that is
  // perfectly good. The job then refuses to write, which is safe but wrong, and
  // a daily schedule turns it from a curiosity into a job that is red most days.
  const sameDay = previous?.tradeDate === shape.tradeDate;
  if (sameDay) {
    process.stdout.write(
      `  continuity: the stored file is already ${previous.tradeDate}, the same day as this one,\n`
      + '              so there is no previous day to compare against. Skipped — comparing a day\n'
      + '              with itself would fail almost every scrip and say nothing about the data.\n',
    );
    // Carry the stored file's own continuity record forward rather than blanking
    // it. The comparison that was made when THIS trade date was first fetched is
    // still the evidence for this trade date — replacing it with zeroes would
    // erase a real check and leave the committed artefact claiming nothing was
    // ever verified.
    continuity = previous.continuity && previous.continuity.compared > 0
      ? { ...previous.continuity, carriedForwardFrom: previous.tradeDate,
          note: 'this run re-fetched the same trade date; the continuity evidence recorded when '
            + 'it was first fetched is carried forward unchanged' }
      : { compared: 0, failures: [], skipped: 0, against: null,
          skippedReason: 'same trade date as the stored file, and the stored file had no continuity record either' };
  } else if (previous?.prices) {
    // ---- IS THE STORED FILE THE IMMEDIATELY PRECEDING SESSION? -----------
    //
    // THE SECOND BUG, AND THE ONE THAT MADE THE FIRST PERMANENT.
    //
    // Continuity means "today's PrvsClsgPric equals YESTERDAY's ClsPric". It is
    // a sharp tripwire across ADJACENT sessions and it is meaningless across a
    // gap: if the stored file is 21 Aug and this one is 26 Aug, today's
    // previous-close is 25 Aug's close and comparing it to 21 Aug's fails for
    // essentially every scrip that moved.
    //
    // So a single missed day poisoned every day after it. The record froze at
    // 21 Aug, and each subsequent run compared a non-adjacent pair, failed,
    // refused to write, and left the record frozen for the next run to fail on
    // in exactly the same way. Six consecutive red runs, and the guard that
    // exists to prevent a stale dashboard was the thing keeping it stale.
    //
    // Across a gap the honest move is to SKIP the check and say so, not to
    // report a gap in our own record as corruption in BSE's data. Nothing is
    // weakened: `assertBhavcopyShape` still requires the file's own TradDt to be
    // the date requested, which is what catches a wrong or stale file. What is
    // lost is one day of row-level evidence, and that loss is recorded rather
    // than papered over.
    const expectedPrevious = previousTradingDay(shape.tradeDate);
    const adjacent = previous.tradeDate === expectedPrevious;

    if (!adjacent) {
      const gap = daysBetween(previous.tradeDate, shape.tradeDate);
      // A NEGATIVE gap is a deliberate backfill — someone passed --date for an
      // older session. It is not a hole in the record and must not read like
      // one, so it is described rather than reported as "-1 days apart".
      const relation = gap < 0
        ? `this run is re-fetching an OLDER session (the stored file is ${Math.abs(gap)} calendar days newer)`
        : `${gap} calendar days apart`;
      process.stdout.write(
        `  continuity: the stored file is ${previous.tradeDate} and this one is ${shape.tradeDate}, `
        + `${relation}.\n`
        + `              The previous TRADING day is ${expectedPrevious}, so these two files are NOT\n`
        + "              adjacent and today's PrvsClsgPric cannot equal the stored ClsPric. Skipped:\n"
        + '              comparing non-adjacent sessions would report a gap in OUR record as a fault\n'
        + "              in BSE's data, and refusing to write on it is what kept the gap open.\n",
      );
      continuity = {
        compared: 0,
        failures: [],
        skipped: 0,
        against: previous.tradeDate,
        skippedReason: `the stored file is ${previous.tradeDate}; the session before ${shape.tradeDate} is `
          + `${expectedPrevious}, so the two files are not adjacent and continuity cannot hold across them`,
        gapDays: gap,
      };
      // Loud, because a skipped tripwire must never look like a passed one.
      process.stdout.write(
        `\n  ::warning:: continuity was NOT checked on this run — `
        + (gap < 0
          ? `this is a backfill of ${shape.tradeDate} over a stored ${previous.tradeDate}`
          : `the record had a ${gap}-day gap (${previous.tradeDate} to ${shape.tradeDate})`)
        + '. It is checked again from the next run onward.\n\n',
      );
    } else {
      const previousClose = new Map(
        Object.entries(previous.prices)
          .filter(([, p]) => p.close !== null && p.staleDays === 0)
          .map(([code, p]) => [code, p.close]),
      );
      continuity = { ...assertContinuity(rows, previousClose), against: previous.tradeDate };
      process.stdout.write(
        `  continuity vs ${previous.tradeDate}: compared ${num(continuity.compared)}, ` +
        `failures ${num(continuity.failures.length)}, no counterpart ${num(continuity.skipped)}\n`,
      );
      checks.assert(
        continuity.failures.length === 0,
        "today's PrvsClsgPric equals yesterday's ClsPric for every common scrip",
        continuity.failures.slice(0, 6).map((f) => `${f.symbol ?? f.scripCode}: ${f.todayPrevClose} vs ${f.yesterdayClose}`).join(' | '),
      );
    }
  } else {
    process.stdout.write('  continuity: no previous prices.json — first run, nothing to compare against\n');
  }

  // ---- assemble, with carry-forward ---------------------------------------
  const prices = {};
  const priced = [];
  const carriedForward = [];
  const missing = [];

  for (const [scripCode, scrip] of universe) {
    const row = byScrip.get(scripCode);
    if (row && row.close !== null) {
      prices[scripCode] = {
        scripCode,
        isin: row.isin ?? scrip.isin ?? null,
        symbol: row.symbol ?? null,
        tradeDate: row.tradeDate,
        open: row.open, high: row.high, low: row.low,
        close: row.close, prevClose: row.prevClose,
        volume: row.volume,
        staleDays: 0,
        source: 'bhavcopy-bse',
      };
      priced.push(scripCode);
      continue;
    }

    // Absent from the file means NOT TRADED. Carry the last close forward and
    // say how old it is; never fill with zero and never call it unchanged.
    const before = previous?.prices?.[scripCode];
    if (before && before.close !== null) {
      const staleDays = daysBetween(before.tradeDate, shape.tradeDate);
      prices[scripCode] = {
        ...before,
        staleDays: Number.isFinite(staleDays) && staleDays > 0 ? staleDays : (before.staleDays ?? 0) + 1,
        source: 'bhavcopy-bse-carried',
      };
      carriedForward.push({ scripCode, name: scrip.name, lastTradeDate: before.tradeDate, staleDays: prices[scripCode].staleDays });
      continue;
    }

    missing.push({ scripCode, scripId: scrip.scripId, name: scrip.name });
  }

  const coveragePct = (priced.length / universe.size) * 100;

  process.stdout.write('\n');
  process.stdout.write(
    renderTable(
      [
        { key: 'what', label: 'Universe', align: 'left' },
        { key: 'n', label: 'Scrips', align: 'right' },
      ],
      [
        { what: 'in the scrape universe', n: num(universe.size) },
        { what: 'priced from this bhavcopy', n: `${num(priced.length)} of ${num(universe.size)}` },
        { what: 'carried forward (did not trade)', n: num(carriedForward.length) },
        { what: 'no price from any source', n: num(missing.length) },
        { what: 'rows in the file, all instruments', n: num(rows.length) },
      ],
    ),
  );
  process.stdout.write(`\n\n  coverage ${coveragePct.toFixed(2)}% (floor ${minCoverage}%)\n`);

  if (carriedForward.length) {
    process.stdout.write('\n  Carried forward — these did NOT trade, they are not zero:\n');
    for (const c of carriedForward.slice(0, 20)) {
      process.stdout.write(`    ${c.scripCode.padEnd(8)} ${String(c.name).slice(0, 40).padEnd(42)} last traded ${c.lastTradeDate} (${c.staleDays}d)\n`);
    }
    if (carriedForward.length > 20) process.stdout.write(`    … and ${carriedForward.length - 20} more, all listed in the file\n`);
  }
  if (missing.length) {
    process.stdout.write('\n  No price from any source — NAMED, not merely counted:\n');
    for (const m of missing) {
      process.stdout.write(`    ${m.scripCode.padEnd(8)} ${String(m.scripId ?? '').padEnd(14)} ${m.name}\n`);
    }
  }

  checks.assert(
    coveragePct >= minCoverage,
    `at least ${minCoverage}% of the universe priced`,
    `only ${coveragePct.toFixed(2)}% (${priced.length} of ${universe.size})`,
  );

  if (!checks.passed) {
    process.stderr.write(`\nREFUSING TO WRITE ${rel(OUT_PATH)} — ${checks.failures.length} check(s) failed:\n\n`);
    checks.print();
    process.stderr.write('\nA dashboard serving yesterday\'s prices under today\'s date is worse than one that visibly failed.\n\n');
    process.exit(1);
  }

  if (previous && Object.keys(previous.prices ?? {}).length > Object.keys(prices).length && !allowShrink) {
    process.stderr.write(
      `\nREFUSING TO WRITE: existing file has ${num(Object.keys(previous.prices).length)} priced scrips, ` +
      `this run has ${num(Object.keys(prices).length)}. Pass --allow-shrink if the universe genuinely shrank.\n\n`,
    );
    process.exit(1);
  }

  const payload = {
    source: 'BSE end-of-day bhavcopy — bseindia.com/download/BhavCopy/Equity',
    note:
      'End-of-day BSE prices, committed so the static site renders with no Worker and no network. ' +
      'A scrip absent from the file did NOT trade: its last close is carried forward with staleDays > 0 ' +
      'and source "bhavcopy-bse-carried". Live NSE prices, where available, overlay this in memory only ' +
      'and are never written back here.',
    capturedAt: new Date().toISOString(),
    tradeDate: shape.tradeDate,
    fileRowCount: rows.length,
    universeCount: universe.size,
    pricedCount: priced.length,
    carriedForwardCount: carriedForward.length,
    missingCount: missing.length,
    coveragePct: Number(coveragePct.toFixed(3)),
    continuity: {
      against: continuity.against,
      compared: continuity.compared,
      failures: continuity.failures,
      noCounterpart: continuity.skipped,
    },
    carriedForward,
    missing,
    prices,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `\nWrote ${rel(OUT_PATH)} — ${num(priced.length)} priced, ${num(carriedForward.length)} carried, ` +
    `${num(missing.length)} missing, trade date ${shape.tradeDate}.\n\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`\nUnhandled failure: ${error?.stack || error}\n\n`);
  process.exit(1);
});
