#!/usr/bin/env node
/**
 * scrape-nse-freefloat.mjs — NSE pre-open market API -> public/data/nse-freefloat.json
 *
 *   node scripts/scrape-nse-freefloat.mjs
 *
 * Zero dependencies. Shells out to `curl`. Read the next paragraph before you
 * "simplify" that.
 *
 * ---------------------------------------------------------------------------
 * DO NOT REPLACE curl WITH fetch(). IT IS NOT A HEADER PROBLEM.
 * ---------------------------------------------------------------------------
 * Measured against www.nseindia.com from a server:
 *
 *     curl + a browser User-Agent, no cookies   -> HTTP 200
 *     curl with no User-Agent                   -> connection refused
 *     node fetch() with the SAME User-Agent     -> HTTP 403
 *     node fetch() with a full browser header set -> HTTP 403
 *
 * Node's built-in fetch (undici) is TLS/HTTP2-fingerprinted and rejected by
 * NSE's edge regardless of what headers you send. The failure presents as a
 * headers problem and is not one; no amount of header tuning fixes it. Cookie
 * warming does not help either — the pre-open endpoint returns 200 with no
 * cookie jar at all.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ENDPOINT
 * ---------------------------------------------------------------------------
 * `metadata.marketCap` on /api/market-data-pre-open is FREE-FLOAT market cap in
 * rupees, as published by NSE. It is NOT computed from promoter holding, and
 * this codebase must never compute it that way: the (100 - promoter%) x mcap
 * formula disagrees with NSE because lock-in shares held by VCs and PE firms
 * are not promoter holdings but are not free float either — and the global
 * indices follow NSE, not the arithmetic.
 *
 * The endpoints that would carry free float for the full ~700-name universe
 * (/api/quote-equity?section=trade_info, /api/equity-stockIndices) are
 * Akamai-blocked from a server (403). Three pre-open keys are what is reachable.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCRIPT REFUSES TO DO
 * ---------------------------------------------------------------------------
 *  - It will not report a blocked key as an empty result. Every key that could
 *    not be read lands in `failed[]` with its reason. Rendering an outage as
 *    "no companies have free float" is the single worst thing this codebase
 *    could do.
 *  - It will not overwrite a good previous snapshot with a smaller one. Pass
 *    --allow-shrink if the universe genuinely shrank and you mean it.
 *  - It will not exit 0 having collected nothing.
 *  - It will not restamp `sessionTimestamp`. That is when NSE struck the
 *    prices; `capturedAt` is when we fetched. Two different facts.
 */

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { renderTable, num } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const OUT_PATH = join(REPO, 'public', 'data', 'nse-freefloat.json');

const ENDPOINT = 'https://www.nseindia.com/api/market-data-pre-open';

/**
 * The three keys that actually carry free-float market cap.
 * Measured: NIFTY 50/50, FO 208/208, SME 53/53, union 261 distinct symbols.
 * OTHERS (1,971 rows) and ALL (2,179 rows) return `marketCap: "-"` for every
 * row — present but with no reading — and BANKNIFTY is 403. Read in this order;
 * a symbol under more than one key is kept once, under the first key that had it.
 */
const KEYS = ['NIFTY', 'FO', 'SME'];

// A real browser UA is required: with no User-Agent the edge refuses the connection.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// NSE throttles intermittently — a request that worked a minute ago can 403 and
// then succeed seconds later, from the same machine with the same headers. Retry
// generously rather than recording a false outage.
//
// `--fail-with-body` is load-bearing, not decoration. Without --fail, curl treats
// an HTTP 403 as a SUCCESSFUL transfer (exit 0) that happens to carry an error
// page, so --retry-all-errors sees nothing to retry and the first throttle
// becomes a permanent "outage". --fail-with-body makes 4xx/5xx an error curl will
// retry, while still handing us the body to diagnose from.
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

/** Space requests out a little; three keys fired back-to-back invites a throttle. */
const GAP_BETWEEN_KEYS_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const STATUS_SENTINEL = '\n__CURL_HTTP_STATUS__';

function curlJson(url) {
  return new Promise((resolve) => {
    execFile(
      'curl',
      [...CURL_ARGS, '-A', USER_AGENT, '-w', `${STATUS_SENTINEL}%{http_code}`, url],
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
          // Reached here means curl exhausted its retries on this status.
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

/** A reading, or null. Never 0 — "no reading" and "zero rupees" are different facts. */
function reading(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '' || text === '-' || text === '--') return null;
    const n = Number(text.replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

async function readKey(key) {
  const result = await curlJson(`${ENDPOINT}?key=${encodeURIComponent(key)}`);
  if (!result.ok) return { key, ok: false, reason: result.reason };

  const rows = Array.isArray(result.json?.data) ? result.json.data : null;
  if (rows === null) {
    return { key, ok: false, reason: 'response carried no `data` array' };
  }
  if (rows.length === 0) {
    return { key, ok: false, reason: 'response carried an empty `data` array' };
  }

  const companies = [];
  for (const row of rows) {
    const meta = row?.metadata;
    const symbol = typeof meta?.symbol === 'string' ? meta.symbol.trim() : '';
    if (symbol === '') continue;

    const freeFloatMcapInr = reading(meta.marketCap);
    if (freeFloatMcapInr === null) continue; // no reading — not zero float

    const iep = reading(meta.iep);
    const previousClose = reading(meta.previousClose);
    // Pre-open strikes at the indicative equilibrium price; lastPrice mirrors
    // iep during that session and is the fallback if iep is absent.
    const basis = iep ?? reading(meta.lastPrice);

    companies.push({
      symbol,
      freeFloatMcapInr,
      iep,
      previousClose,
      // DERIVED, not published: free-float rupees / the price they were struck at.
      // Stored as a share count so a daily price move can re-value it without
      // a fresh scrape. `implied` marks it as ours, not NSE's.
      impliedFreeFloatShares: basis === null ? null : Math.round(freeFloatMcapInr / basis),
      sourceKey: key,
    });
  }

  if (companies.length === 0) {
    return {
      key,
      ok: false,
      reason: `returned ${rows.length} rows but none carried a free-float market cap`,
    };
  }

  return {
    key,
    ok: true,
    rowsReturned: rows.length,
    companies,
    timestamp: typeof result.json.timestamp === 'string' ? result.json.timestamp : null,
    totalMarketCap: reading(result.json.totalmarketcap),
    bytes: result.bytes,
  };
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

  process.stdout.write(`\nNSE pre-open free-float scrape — ${ENDPOINT}\n`);
  process.stdout.write(`Transport: curl (node fetch is fingerprinted and 403s — see header comment)\n\n`);

  const results = [];
  for (const [i, key] of KEYS.entries()) {
    /* eslint-disable no-await-in-loop */
    if (i > 0) await sleep(GAP_BETWEEN_KEYS_MS);
    const result = await readKey(key);
    results.push(result);
    process.stdout.write(
      result.ok
        ? `  ${key.padEnd(6)} ok   ${String(result.rowsReturned).padStart(5)} rows, ` +
          `${String(result.companies.length).padStart(5)} with free-float mcap, ` +
          `${num(Math.round(result.bytes / 1024))} KB, timestamp ${JSON.stringify(result.timestamp)}\n`
        : `  ${key.padEnd(6)} FAIL ${result.reason}\n`,
    );
  }

  const okResults = results.filter((r) => r.ok);
  const failed = results
    .filter((r) => !r.ok)
    .map((r) => ({ key: r.key, reason: r.reason }));

  // Dedup across keys: first key that carried a symbol owns it.
  const bySymbol = new Map();
  const keyStats = [];
  for (const result of okResults) {
    let fresh = 0;
    for (const company of result.companies) {
      if (bySymbol.has(company.symbol)) continue;
      bySymbol.set(company.symbol, company);
      fresh += 1;
    }
    keyStats.push({
      key: result.key,
      rowsReturned: result.rowsReturned,
      rowsWithFreeFloat: result.companies.length,
      newSymbols: fresh,
      sessionTimestamp: result.timestamp,
    });
  }

  const companies = [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));

  process.stdout.write('\n');
  process.stdout.write(
    renderTable(
      [
        { key: 'key', label: 'Key', align: 'left' },
        { key: 'rows', label: 'Rows', align: 'right' },
        { key: 'withFf', label: 'With free float', align: 'right' },
        { key: 'fresh', label: 'New in union', align: 'right' },
        { key: 'ts', label: 'NSE session timestamp', align: 'left' },
      ],
      keyStats.map((s) => ({
        key: s.key,
        rows: num(s.rowsReturned),
        withFf: `${num(s.rowsWithFreeFloat)} of ${num(s.rowsReturned)}`,
        fresh: num(s.newSymbols),
        ts: s.sessionTimestamp ?? '—',
      })),
    ),
  );
  process.stdout.write(`\n\nUnion: ${num(companies.length)} distinct symbols with a free-float reading.\n`);

  if (failed.length > 0) {
    process.stdout.write(`\nFailed keys (recorded in failed[], NOT rendered as zero rows):\n`);
    for (const f of failed) process.stdout.write(`  ${f.key.padEnd(6)} ${f.reason}\n`);
  } else {
    process.stdout.write('Failed keys: none.\n');
  }

  if (companies.length === 0) {
    process.stderr.write(
      '\nNo symbols were read. This is an OUTAGE, not a finding: it does not mean\n' +
        'no company has free float. Nothing written; exiting non-zero.\n\n',
    );
    process.exit(1);
  }

  const timestamps = [...new Set(keyStats.map((s) => s.sessionTimestamp).filter(Boolean))];
  if (timestamps.length > 1) {
    process.stdout.write(
      `\nWARNING: keys disagree on the NSE session timestamp (${timestamps.join(' | ')}).\n` +
        `Storing the first-read key's value; per-key values are kept in keysRead[].\n`,
    );
  }
  const sessionTimestamp = keyStats[0]?.sessionTimestamp ?? null;
  if (sessionTimestamp === null) {
    process.stderr.write(
      '\nNSE returned data with no session timestamp. Refusing to write a snapshot\n' +
        'that cannot say when it was struck.\n\n',
    );
    process.exit(1);
  }

  // ---- MERGE, DO NOT REPLACE ------------------------------------------
  //
  // THE PRE-OPEN LIST IS A SESSION ROSTER, NOT A UNIVERSE, and treating it as a
  // universe froze this file for nine days.
  //
  // Only symbols that actually participated in a given day's pre-open call
  // appear in it, and the SME segment in particular swings hard: it was 53 rows
  // when this project was built and 24 on 28 Aug 2026, so the union moved 261 ->
  // 234. The old shrink guard read that as a partial read, refused to write, and
  // exited 1 — every single day, permanently, while the workflow's warning
  // blamed a throttle that had not happened. The scrape was fine; the guard was
  // wrong about what it was guarding.
  //
  // A symbol missing from today's roster did NOT trade in today's pre-open. That
  // is "no reading today", not "this company is gone" — the same distinction
  // prices already make with `staleDays` (CLAUDE.md §2.10). So today's readings
  // are merged OVER the stored ones and each company keeps the session
  // timestamp of the reading it actually carries.
  const previous = previousSnapshot();
  const mergedBySymbol = new Map();
  let carriedForward = 0;

  if (previous?.companies) {
    for (const company of previous.companies) {
      // Never restamp: a carried reading keeps the session it was struck in.
      mergedBySymbol.set(company.symbol, { ...company, carriedForward: true });
    }
  }
  for (const company of companies) {
    mergedBySymbol.set(company.symbol, { ...company, sessionTimestamp, carriedForward: false });
  }
  for (const company of mergedBySymbol.values()) if (company.carriedForward) carriedForward += 1;

  const merged = [...mergedBySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));

  // The guard that replaces the shrink test. It asks the question the old one
  // meant to ask — "did this run actually read NSE?" — against TODAY'S fresh
  // count, which a roster change cannot move. A genuine partial read still
  // stops the run; a quiet SME day no longer does.
  const FRESH_FLOOR = 150;
  if (companies.length < FRESH_FLOOR) {
    if (!allowShrink) {
      process.stderr.write(
        `\nREFUSING TO WRITE: only ${num(companies.length)} symbols were read fresh this run,\n` +
          `below the floor of ${num(FRESH_FLOOR)}. That is a partial read, not a quiet session.\n` +
          `Pass --allow-shrink only if NSE genuinely publishes this few now.\n\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`\n--allow-shrink: writing on only ${num(companies.length)} fresh symbols.\n`);
  }

  process.stdout.write(
    `\nMerged: ${num(companies.length)} read fresh this session, ` +
      `${num(carriedForward)} carried forward from an earlier session, ` +
      `${num(merged.length)} total.\n`,
  );

  const payload = {
    source: 'NSE pre-open market API — nseindia.com/api/market-data-pre-open',
    note:
      'Free-float market cap as published by NSE. NOT computed from promoter holding. ' +
      'Struck at the pre-open indicative equilibrium price (09:00–09:08 IST), not at the close.',
    capturedAt: new Date().toISOString(),
    // The session THIS run read. Individual companies carry their own, because
    // a carried-forward reading was struck in an earlier session and saying
    // otherwise would restamp somebody else's measurement (CLAUDE.md §3.7).
    sessionTimestamp,
    keysRead: keyStats,
    companyCount: merged.length,
    freshThisSession: companies.length,
    carriedForward,
    companies: merged,
    failed,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `\nWrote ${OUT_PATH.replace(REPO + '/', '')} — ${num(merged.length)} companies ` +
      `(${num(companies.length)} fresh, ${num(carriedForward)} carried), ` +
      `session ${sessionTimestamp}, ${failed.length} failed key(s).\n\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`\nUnhandled failure: ${error?.stack || error}\n\n`);
  process.exit(1);
});
