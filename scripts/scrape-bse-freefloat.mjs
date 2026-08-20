#!/usr/bin/env node
/**
 * scrape-bse-freefloat.mjs — per-scrip BSE free float -> public/data/bse-freefloat.json
 *
 *   node scripts/scrape-bse-freefloat.mjs [--limit N] [--allow-shrink]
 *
 * Requires public/data/bse-scrip-master.json and public/data/msci-funds.json.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS STORED, AND WHY IT IS A FACTOR AND NOT A RUPEE FIGURE
 * ---------------------------------------------------------------------------
 *     floatFactor = MktCapFF / MktCapFull
 *
 * Dimensionless, and both halves come from ONE response at ONE instant, so no
 * price difference can leak into it. That matters more than it looks: a rupee
 * free-float figure is struck at one moment's price and is wrong by the next
 * day's open, whereas the factor only moves when shareholding moves — which is
 * the quarterly event this product exists to forecast. So:
 *
 *     freeFloatMcap(today) = floatFactor x sharesOutstanding x price(today)
 *
 * A monthly snapshot plus a daily price recompute, which is what the desk asked
 * for, and it only works because what is persisted is price-independent.
 *
 * ---------------------------------------------------------------------------
 * THREE REQUESTS PER SCRIP, ALL FROM BSE
 * ---------------------------------------------------------------------------
 *   StockTrading       MktCapFull + MktCapFF  -> the factor. Without this the
 *                      scrip has no reading at all.
 *   getScripHeaderData LTP -> shares outstanding, and the price basis for
 *                      comparing NSE's float factor with BSE's. Optional: a
 *                      failure here costs the share count, not the factor.
 *   ComHeader          ISIN + sector. Optional. The ISIN is a genuine
 *                      cross-check against the master rather than decoration —
 *                      it is fetched per scrip and compared.
 *
 * Every price used with a BSE market cap is BSE's own LTP. Dividing a BSE
 * market cap by an NSE price would fold a price difference into a float
 * difference and make the NSE-vs-BSE comparison meaningless.
 *
 * ---------------------------------------------------------------------------
 * BSE tolerates far more load than this script applies. It is somebody else's
 * free service and this job runs monthly; concurrency stays at 4.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  bseGet, stockTradingUrl, scripHeaderUrl, comHeaderUrl,
  parseCroreToRupees, parsePrice, pooled,
} from './lib/bse.mjs';
import { buildIndex, resolveAll } from './lib/resolve.mjs';
import { renderTable, num, round } from './lib/report.mjs';
import { SCRAPE_UNIVERSE_MIN_FULL_MCAP_INR, toCrore } from '../public/js/config/thresholds.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const OUT_PATH = join(REPO, 'public', 'data', 'bse-freefloat.json');

/**
 * Concurrency, and why it moved from 4 to 8.
 *
 * The old comment said: "Concurrency stays at 4 with a gap between requests. BSE
 * tolerates far more. It is somebody else's free service and this job runs
 * MONTHLY — there is no reason to lean on it." That reasoning was right and its
 * premise has changed: the desk now wants this refreshed every trading day, and
 * at 4 the full universe takes about 25 minutes.
 *
 * MEASURED on 20 Aug 2026, cold disjoint batches of 140 scrips so no rung could
 * read another rung's cache — the first attempt at this measurement was
 * confounded exactly that way and reported a 12x speedup that was BSE's cache:
 *
 *     concurrency  4   169 ms/scrip   p50 659 ms   p90 827 ms   0 non-200
 *     concurrency  8    80 ms/scrip   p50 648 ms   p90 840 ms   0 non-200
 *     concurrency 16    44 ms/scrip   p50 680 ms   p90 914 ms   0 non-200
 *     concurrency 24    28 ms/scrip   p50 636 ms   p90 793 ms   0 non-200
 *
 * Per-request latency is FLAT to 24 in flight: BSE is not queueing us, so the
 * extra parallelism costs the service nothing it was not already serving. A
 * whole-master sweep of 4,974 scrips at 10 completed in 294 s with zero failures.
 *
 * 8 is chosen well below the measured ceiling rather than at it: it halves the
 * daily wall clock while leaving the service the same headroom it showed at 24.
 * Raise it with --concurrency only if a run genuinely needs to finish sooner,
 * and never past 16 without measuring again — this is somebody else's free
 * service and the numbers above are a snapshot, not a guarantee.
 */
const CONCURRENCY = numberFlag('--concurrency', 8, { min: 1, max: 16 });
const GAP_MS = numberFlag('--gap-ms', 60, { min: 0, max: 5000 });

/** A numeric CLI flag, clamped, so a typo cannot silently hammer the service. */
function numberFlag(name, fallback, { min, max }) {
  const at = process.argv.indexOf(name);
  if (at === -1) return fallback;
  const raw = Number(process.argv[at + 1]);
  if (!Number.isFinite(raw)) {
    process.stderr.write(`\n${name} needs a number; got ${JSON.stringify(process.argv[at + 1])}.\n\n`);
    process.exit(1);
  }
  return Math.min(max, Math.max(min, Math.round(raw)));
}

function requireFile(path, how) {
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  process.stderr.write(`\nMissing ${path.replace(REPO + '/', '')}. Run \`${how}\` first.\n\n`);
  process.exit(1);
  return null;
}

/**
 * How many times a null market cap is re-asked before it is believed.
 *
 * ---------------------------------------------------------------------------
 * A NULL FROM BSE IS NOT A FACT ABOUT THE COMPANY
 * ---------------------------------------------------------------------------
 * Measured the hard way on 20 Aug 2026. Under sustained load BSE starts
 * answering HTTP 200 with a well-formed body and `MktCapFull: null` for scrips
 * it served correctly minutes earlier. The run degraded from 320 ms/scrip to
 * 1,366 ms/scrip and produced 98 "failures" — CESC, ATUL, KAJARIACER, GESHIP,
 * CAPLIPOINT, SAGILITY among them. Every one of those returned a proper figure
 * on a quiet re-probe seconds after the run ended:
 *
 *     500084 CESC        MktCapFull "20,758.43"  MktCapFF "9,841.66"
 *     500027 ATUL        MktCapFull "19,196.47"  MktCapFF "10,332.40"
 *     500233 KAJARIACER  MktCapFull "19,180.88"  MktCapFF "9,946.38"
 *
 * This is the Munshot `not_found` trap (3.7) in a second place: a soft "no data"
 * that looks like an answer. `bseGet` cannot retry it because HTTP 200 with a
 * parseable body IS a successful transfer — the retry has to live here, where
 * the SHAPE is judged rather than the status.
 *
 * A company that genuinely has no market cap — an ETF, a suspended line — still
 * lands in failed[] after the retries, which is correct. It just has to say so
 * three times.
 */
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const NULL_MCAP_RETRIES = 3;
const NULL_MCAP_BACKOFF_MS = 2500;

/** Gap between the one-at-a-time re-asks in the quiet sweep-up after the pool. */
const SWEEP_GAP_MS = 1200;

async function readScrip(scrip) {
  // StockTrading carries the two numbers this whole file exists for, so it is
  // the one that gets re-asked when the answer is shaped like an outage.
  let trading = null;
  let fullMcapInr = null;
  let freeFloatMcapInr = null;
  for (let attempt = 0; attempt <= NULL_MCAP_RETRIES; attempt += 1) {
    if (attempt > 0) await sleep(NULL_MCAP_BACKOFF_MS * attempt);
    trading = await bseGet(stockTradingUrl(scrip.scripCode));
    if (!trading.ok) continue;
    fullMcapInr = parseCroreToRupees(trading.json?.MktCapFull);
    freeFloatMcapInr = parseCroreToRupees(trading.json?.MktCapFF);
    // A "-" is BSE saying it publishes nothing for this instrument, which is a
    // real answer and must not be retried. A null or an absent field is the
    // load-shedding shape above, and must.
    const saidNothing = trading.json?.MktCapFull === '-' || trading.json?.MktCapFF === '-';
    if (fullMcapInr !== null || saidNothing) break;
  }

  const [header, com] = await Promise.all([
    bseGet(scripHeaderUrl(scrip.scripCode)),
    bseGet(comHeaderUrl(scrip.scripCode)),
  ]);

  if (!trading.ok) {
    return { scrip, ok: false, reason: `StockTrading: ${trading.reason}` };
  }

  if (fullMcapInr === null) {
    return {
      scrip,
      ok: false,
      reason: `no usable MktCapFull (${JSON.stringify(trading.json?.MktCapFull)}) `
        + `after ${NULL_MCAP_RETRIES} re-asks`,
    };
  }
  if (freeFloatMcapInr === null) {
    return { scrip, ok: false, reason: `no usable MktCapFF (${JSON.stringify(trading.json?.MktCapFF)})` };
  }
  if (freeFloatMcapInr > fullMcapInr * 1.001) {
    return {
      scrip,
      ok: false,
      reason: `free float ₹${num(Math.round(toCrore(freeFloatMcapInr)))} Cr exceeds full market cap ` +
        `₹${num(Math.round(toCrore(fullMcapInr)))} Cr — refusing a factor above 1`,
    };
  }

  const priceInr = header.ok ? parsePrice(header.json?.CurrRate?.LTP) : null;
  const priceAsOf = header.ok ? (String(header.json?.Header?.Ason ?? '').trim() || null) : null;
  const comIsinRaw = com.ok ? String(com.json?.ISIN ?? '').trim() : '';
  const comIsin = /^IN[A-Z0-9]{10}$/.test(comIsinRaw) ? comIsinRaw : null;

  const notes = [];
  if (!header.ok) notes.push(`no price: getScripHeaderData: ${header.reason}`);
  else if (priceInr === null) notes.push(`no price: LTP was ${JSON.stringify(header.json?.CurrRate?.LTP)}`);
  if (!com.ok) notes.push(`no sector/ISIN cross-check: ComHeader: ${com.reason}`);
  if (comIsin && scrip.isin && comIsin !== scrip.isin) {
    notes.push(`ISIN mismatch: master says ${scrip.isin}, ComHeader says ${comIsin}`);
  }

  return {
    scrip,
    ok: true,
    notes,
    record: {
      scripCode: scrip.scripCode,
      scripId: scrip.scripId,
      name: scrip.name,
      // The master's ISIN is authoritative; ComHeader's is the cross-check.
      isin: scrip.isin,
      isinFromComHeader: comIsin,
      // 'equity' or 'invit-reit'. An InvIT unit is a real, priced, free-float-
      // publishing security and it is NOT an equity share — anything that ranks
      // or sums across the two has to say which is which.
      instrumentKind: scrip.instrumentKind ?? 'equity',
      sector: com.ok ? (String(com.json?.IndustryNew ?? '').trim() || null) : null,
      fullMcapInr,
      freeFloatMcapInr,
      // Both halves from one response at one instant. Price-independent.
      floatFactor: round(freeFloatMcapInr / fullMcapInr, 6),
      priceInr,
      priceAsOf,
      // DERIVED: full market cap / BSE's own last traded price. Both BSE.
      sharesOutstanding: priceInr === null ? null : Math.round(fullMcapInr / priceInr),
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const allowShrink = args.includes('--allow-shrink');
  const limitAt = args.indexOf('--limit');
  const limit = limitAt >= 0 ? Number.parseInt(args[limitAt + 1], 10) : null;

  const master = requireFile(join(REPO, 'public', 'data', 'bse-scrip-master.json'), 'node scripts/fetch-bse-master.mjs');
  const funds = requireFile(join(REPO, 'public', 'data', 'msci-funds.json'), 'node scripts/import-ishares.mjs');
  const nseUniverse = requireFile(join(REPO, 'public', 'data', 'nse-universe.json'), 'node scripts/fetch-nse-universe.mjs');
  const freefloat = requireFile(join(REPO, 'public', 'data', 'nse-freefloat.json'), 'node scripts/scrape-nse-freefloat.mjs');
  const universeSeed = requireFile(join(REPO, 'public', 'data', 'universe.json'), 'node scripts/import-universe.mjs');

  const index = buildIndex(master, nseUniverse, new Set(freefloat.companies.map((c) => c.symbol)));
  const { resolved } = resolveAll(funds.funds, index);

  const byCode = new Map(master.scrips.map((s) => [s.scripCode, s]));

  // Held first: a company the funds own is in scope at any size. A position we
  // hold and cannot price is a hole in the product; a small company we do not
  // hold is merely absent from a candidate list.
  const held = new Map();
  for (const record of resolved) {
    if (!record.bseScripCode) continue;
    const scrip = byCode.get(record.bseScripCode);
    if (scrip) held.set(scrip.scripCode, scrip);
  }

  // Then everything large enough to matter to a review, by the desk's own
  // exclusion floor. Applied to FULL market cap because that is all that is
  // known before a request is spent — see thresholds.mjs.
  const large = new Map();
  for (const scrip of master.scrips) {
    if (scrip.indicativeFullMcapInr !== null
      && scrip.indicativeFullMcapInr >= SCRAPE_UNIVERSE_MIN_FULL_MCAP_INR) {
      large.set(scrip.scripCode, scrip);
    }
  }

  // Then the desk's own list. BSE's `indicativeFullMcapInr` is struck at an
  // undisclosed moment, so a company sitting within a few percent of the floor
  // can be above it on the desk's screen and below it in the master, or the
  // other way round. The seed catches those without a re-export.
  //
  // A seed code is only believed when the ACTIVE master carries it AND agrees on
  // the ISIN. Anything else is not fetched: a code the active master does not
  // carry may belong to a delisted company that BSE will still answer for with
  // three-year-old figures and nothing in the response to say so — 3.8.
  const seeded = new Map();
  const seedRejected = [];
  for (const row of universeSeed?.companies ?? []) {
    if (!row.bseScripCode) continue;
    const scrip = byCode.get(row.bseScripCode);
    if (!scrip) {
      seedRejected.push({ scripCode: row.bseScripCode, isin: row.isin, name: row.name,
        reason: 'not in the active equity master (REIT/InvIT, other segment, or inactive)' });
      continue;
    }
    if (scrip.isin && row.isin && scrip.isin !== row.isin) {
      seedRejected.push({ scripCode: row.bseScripCode, isin: row.isin, name: row.name,
        reason: `the active master has ISIN ${scrip.isin} on this code, the seed says ${row.isin}` });
      continue;
    }
    seeded.set(scrip.scripCode, scrip);
  }

  const universe = [...new Map([...held, ...large, ...seeded]).values()]
    .sort((a, b) => (b.indicativeFullMcapInr ?? 0) - (a.indicativeFullMcapInr ?? 0));
  const target = limit ? universe.slice(0, limit) : universe;

  process.stdout.write('\nBSE free-float scrape — api.bseindia.com\n\n');
  process.stdout.write(
    renderTable(
      [
        { key: 'what', label: 'Universe', align: 'left' },
        { key: 'n', label: 'Scrips', align: 'right' },
      ],
      [
        { what: 'held by an iShares fund (any size)', n: num(held.size) },
        { what: `full mcap >= ₹${num(Math.round(toCrore(SCRAPE_UNIVERSE_MIN_FULL_MCAP_INR)))} Cr (the desk's exclusion floor)`, n: num(large.size) },
        { what: "on the desk's seed list and in the active master", n: num(seeded.size) },
        { what: 'seed codes rejected (not active, or ISIN disagrees)', n: num(seedRejected.length) },
        { what: 'union to scrape', n: num(universe.size ?? universe.length) },
        { what: 'this run', n: num(target.length) },
      ],
    ),
  );
  process.stdout.write(
    `\n\n${num(target.length * 3)} requests at concurrency ${CONCURRENCY}. ` +
      `Held-but-below-the-floor: ${num([...held.keys()].filter((c) => !large.has(c)).length)}.\n\n`,
  );

  const startedAt = Date.now();
  let lastBeat = 0;
  const results = await pooled(target, readScrip, {
    concurrency: CONCURRENCY,
    gapMs: GAP_MS,
    onProgress: (done, total) => {
      if (done - lastBeat < 100 && done !== total) return;
      lastBeat = done;
      const elapsed = (Date.now() - startedAt) / 1000;
      process.stdout.write(
        `  ${String(done).padStart(5)} of ${total}  ${elapsed.toFixed(0)}s  ` +
          `${(elapsed / done * 1000).toFixed(0)} ms/scrip\n`,
      );
    },
  });

  // ---- the quiet sweep-up ------------------------------------------------
  //
  // The per-scrip re-asks inside readScrip() happen while the pool is still
  // running, so they are made under exactly the load that caused the null. The
  // fix that actually works is to wait until the pool has STOPPED and ask again
  // slowly. Measured 20 Aug 2026: a run at concurrency 8 produced 98 nulls, and
  // every one of the six spot-checked returned a proper figure on a single quiet
  // request seconds after the run ended. A second run with in-pool retries alone
  // still left 16 — ABB, TRENT, INDUSINDBK, HAVELLS, SWIGGY among them, none of
  // which is a company without a market capitalisation.
  //
  // One at a time, with a real gap. This is the last chance a scrip gets before
  // it is called a failure, so it is worth the seconds.
  const stragglers = results.filter((r) => !r.ok);
  if (stragglers.length > 0) {
    process.stdout.write(
      `\n  ${num(stragglers.length)} scrip(s) failed under load. Re-asking one at a time, `
      + `${SWEEP_GAP_MS} ms apart, now the pool has stopped.\n`,
    );
    let recovered = 0;
    for (const straggler of stragglers) {
      await sleep(SWEEP_GAP_MS);
      const retry = await readScrip(straggler.scrip);
      if (retry.ok) {
        results[results.indexOf(straggler)] = retry;
        recovered += 1;
      }
    }
    process.stdout.write(
      `  recovered ${num(recovered)} of ${num(stragglers.length)}; `
      + `${num(stragglers.length - recovered)} still unreadable and going to failed[].\n`,
    );
  }
  const elapsedMs = Date.now() - startedAt;

  const okResults = results.filter((r) => r && r.ok);
  const failed = results
    .filter((r) => r && !r.ok)
    .map((r) => ({ scripCode: r.scrip.scripCode, scripId: r.scrip.scripId, name: r.scrip.name, reason: r.reason }));
  const notes = okResults
    .filter((r) => r.notes.length > 0)
    .map((r) => ({ scripCode: r.scrip.scripCode, scripId: r.scrip.scripId, notes: r.notes }));

  const scrips = okResults.map((r) => r.record).sort((a, b) => b.fullMcapInr - a.fullMcapInr);

  const withPrice = scrips.filter((s) => s.priceInr !== null).length;
  const withSector = scrips.filter((s) => s.sector !== null).length;
  const isinMismatches = notes.filter((n) => n.notes.some((t) => t.startsWith('ISIN mismatch'))).length;

  process.stdout.write('\n');
  process.stdout.write(
    renderTable(
      [
        { key: 'what', label: 'Result', align: 'left' },
        { key: 'n', label: 'Count', align: 'right' },
      ],
      [
        { what: 'scrips with a free-float factor', n: `${num(scrips.length)} of ${num(target.length)}` },
        { what: '— also with a price (share count derivable)', n: `${num(withPrice)} of ${num(scrips.length)}` },
        { what: '— also with a sector', n: `${num(withSector)} of ${num(scrips.length)}` },
        { what: 'failed scrips (in failed[])', n: num(failed.length) },
        { what: 'ISIN mismatches vs the master', n: num(isinMismatches) },
      ],
    ),
  );
  process.stdout.write(
    `\n\nWall clock ${(elapsedMs / 1000).toFixed(1)}s for ${num(target.length * 3)} requests ` +
      `(${(elapsedMs / Math.max(1, target.length * 3)).toFixed(0)} ms/request, concurrency ${CONCURRENCY}).\n`,
  );

  if (failed.length > 0) {
    process.stdout.write(`\nFailed scrips (recorded, NOT rendered as zero float):\n`);
    for (const f of failed.slice(0, 25)) {
      process.stdout.write(`  ${f.scripCode.padEnd(8)} ${String(f.scripId).padEnd(12)} ${f.reason}\n`);
    }
    if (failed.length > 25) process.stdout.write(`  … and ${failed.length - 25} more, all in failed[]\n`);
  }
  if (notes.length > 0) {
    process.stdout.write(`\n${num(notes.length)} scrip(s) with partial reads (recorded in notes[]).\n`);
  }

  if (scrips.length === 0) {
    process.stderr.write(
      '\nNo scrips were read. This is an OUTAGE, not a universe with no free float.\n' +
        'Nothing written; exiting non-zero.\n\n',
    );
    process.exit(1);
  }

  if (!limit && existsSync(OUT_PATH)) {
    try {
      const previous = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
      if (Number.isFinite(previous.scripCount) && previous.scripCount > scrips.length && !allowShrink) {
        process.stderr.write(
          `\nREFUSING TO WRITE: the existing snapshot has ${num(previous.scripCount)} scrips and this run\n` +
            `collected ${num(scrips.length)}. A partial read must not replace a good file.\n` +
            'Re-run; pass --allow-shrink only if the universe genuinely shrank.\n\n',
        );
        process.exit(1);
      }
    } catch { /* an unreadable previous file does not block a good one */ }
  }

  const payload = {
    source: 'BSE India — api.bseindia.com (StockTrading, getScripHeaderData, ComHeader)',
    note:
      'floatFactor = MktCapFF / MktCapFull, both from one StockTrading response at one instant, so it '
      + 'is price-independent. All monetary fields are RUPEES; BSE publishes ₹ crore strings and the '
      + 'conversion happens once, in scripts/lib/bse.mjs. sharesOutstanding is DERIVED as '
      + 'fullMcapInr / priceInr using BSE\'s own last traded price.',
    capturedAt: new Date().toISOString(),
    universe: {
      heldByFunds: held.size,
      minFullMcapInr: SCRAPE_UNIVERSE_MIN_FULL_MCAP_INR,
      minFullMcapAttribution:
        "the desk's exclusion floor (₹2,000 Cr) — the desk's heuristic, not an MSCI published rule",
      seeded: seeded.size,
      seedRejected,
      candidates: universe.length,
      requested: target.length,
      partial: Boolean(limit),
    },
    requestCount: target.length * 3,
    elapsedMs,
    scripCount: scrips.length,
    scrips,
    notes,
    failed,
  };

  if (limit) {
    process.stdout.write(
      `\n--limit ${limit} was passed, so this is a partial run and nothing was written.\n\n`,
    );
    return;
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `\nWrote ${OUT_PATH.replace(REPO + '/', '')} — ${num(scrips.length)} scrips, ${failed.length} failed.\n\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`\nUnhandled failure: ${error?.stack || error}\n\n`);
  process.exit(1);
});
