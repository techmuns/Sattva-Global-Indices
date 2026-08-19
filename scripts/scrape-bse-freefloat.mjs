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

const CONCURRENCY = 4;
const GAP_MS = 60;

function requireFile(path, how) {
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  process.stderr.write(`\nMissing ${path.replace(REPO + '/', '')}. Run \`${how}\` first.\n\n`);
  process.exit(1);
  return null;
}

async function readScrip(scrip) {
  const [trading, header, com] = await Promise.all([
    bseGet(stockTradingUrl(scrip.scripCode)),
    bseGet(scripHeaderUrl(scrip.scripCode)),
    bseGet(comHeaderUrl(scrip.scripCode)),
  ]);

  if (!trading.ok) {
    return { scrip, ok: false, reason: `StockTrading: ${trading.reason}` };
  }

  const fullMcapInr = parseCroreToRupees(trading.json?.MktCapFull);
  const freeFloatMcapInr = parseCroreToRupees(trading.json?.MktCapFF);

  if (fullMcapInr === null) {
    return { scrip, ok: false, reason: `no usable MktCapFull (${JSON.stringify(trading.json?.MktCapFull)})` };
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

  const universe = [...new Map([...held, ...large]).values()]
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
