#!/usr/bin/env node
/**
 * fetch-quote-stats.mjs — monthly per-company statistics -> public/data/quote-stats.json
 *
 *   node scripts/fetch-quote-stats.mjs [--limit N] [--no-splits]
 *
 * Average daily volume, yearly change, market-cap cross-check and split
 * history. MONTHLY, not live: none of these move fast enough to be worth a
 * request during a session, and the split fields in particular are the point —
 * a split changes the share count, and a share-count change is one of the few
 * things that actually forces an index fund to trade.
 *
 * Two upstream calls per company at most:
 *   - `stockquote_batch`  ADV, yearly change, market cap. 80 symbols per call.
 *   - `detailquote`       Last Split Factor / Last Split Date, one at a time.
 *
 * `Last Split Date` is UNIX EPOCH SECONDS. Reading it as a date string gives
 * 1970, which would look like "no recent split" for every company.
 *
 * Only companies with an ASSERTED NSE symbol are fetched. Munshot is keyed on
 * NSE tickers and BSE's scrip_id is not an NSE symbol however often it looks
 * like one — guessing one here would attach another company's volume to a row.
 *
 * ---------------------------------------------------------------------------
 * `not_found` IS NOT A FACT ABOUT THE SYMBOL
 * ---------------------------------------------------------------------------
 * MEASURED, the hard way: under sustained load this upstream starts answering
 * `status: "not_found"` for tickers it served correctly minutes earlier —
 * RELIANCE included. It does not return 429, and it does not say "rate
 * limited"; it says the symbol does not exist.
 *
 * So `not_found` must be treated exactly like a timeout: a FAILURE for this
 * run, never a durable fact. Anything that cached it as "this company has no
 * quote" would permanently blacklist real companies, and the blacklist would
 * look like data.
 *
 * The defences are (a) modest concurrency with a gap between calls, and (b) a
 * coverage floor below which the run refuses to write. A half-populated
 * statistics file is worse than none, because the missing half renders as an
 * em dash that looks like a property of the company.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { fetchBatch, fetchDetail, DEFAULT_CHUNK_SIZE } from './lib/munshot.mjs';
import { renderTable, num, round } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const OUT_PATH = join(REPO, 'public', 'data', 'quote-stats.json');
const rel = (p) => p.replace(`${REPO}/`, '');

async function main() {
  const args = process.argv.slice(2);
  const argOf = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback; };
  const limit = args.includes('--limit') ? Number.parseInt(argOf('--limit', '0'), 10) : null;
  const withSplits = !args.includes('--no-splits');
  // Below this share of fetchable companies, the run refuses to write.
  const minCoverage = Number(argOf('--min-coverage', '80'));
  const concurrency = Number.parseInt(argOf('--concurrency', '2'), 10);
  const gapMs = Number.parseInt(argOf('--gap-ms', '400'), 10);
  const token = process.env.MUNS_TOKEN || undefined;

  const companiesPath = join(REPO, 'public', 'data', 'companies.json');
  if (!existsSync(companiesPath)) {
    process.stderr.write('Missing public/data/companies.json. Run scripts/build-companies.mjs first.\n\n');
    process.exit(1);
  }
  const companies = JSON.parse(readFileSync(companiesPath, 'utf8')).companies;

  const withSymbol = companies.filter((c) => c.nseSymbol);
  const withoutSymbol = companies.filter((c) => !c.nseSymbol);
  const target = limit ? withSymbol.slice(0, limit) : withSymbol;
  const symbols = target.map((c) => c.nseSymbol);

  process.stdout.write(`\nMunshot quote statistics — monthly\n\n`);
  process.stdout.write(
    renderTable(
      [{ key: 'what', label: 'Coverage', align: 'left' }, { key: 'n', label: 'Companies', align: 'right' }],
      [
        { what: 'in the record', n: num(companies.length) },
        { what: 'with an asserted NSE symbol (fetchable)', n: `${num(withSymbol.length)} of ${num(companies.length)}` },
        { what: 'no NSE symbol — cannot be fetched at all', n: num(withoutSymbol.length) },
        { what: 'this run', n: num(target.length) },
      ],
    ),
  );
  process.stdout.write(`\n\n  token: ${token ? 'present' : 'ABSENT (the batch endpoint currently answers unauthenticated)'}\n\n`);

  // ---- pass 1: batch — ADV, yearly change, market cap --------------------
  const started = Date.now();
  const batch = await fetchBatch(symbols, {
    token,
    chunkSize: DEFAULT_CHUNK_SIZE,
    concurrency,
    onChunk: (done, total) => {
      if (done % 5 === 0 || done === total) {
        process.stdout.write(`  batch ${String(done).padStart(3)} of ${total} chunks  ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
      }
    },
  });
  const batchSeconds = (Date.now() - started) / 1000;
  process.stdout.write(
    `\n  batch: ${num(Object.keys(batch.quotes).length)} of ${num(symbols.length)} resolved in ${batchSeconds.toFixed(1)}s ` +
    `(${batch.chunks} chunks of ${DEFAULT_CHUNK_SIZE}, concurrency ${concurrency})\n`,
  );

  const notFound = batch.failed.filter((f) => /not_found/.test(f.reason)).length;
  if (notFound > symbols.length * 0.2) {
    process.stdout.write(
      `\n  WARNING: ${num(notFound)} symbols came back "not_found". Under load this upstream reports\n` +
      '  not_found for tickers it served correctly minutes earlier, so this is far more likely to be\n' +
      '  throttling than a set of delisted companies. Slow down (--concurrency 1 --gap-ms 1500) and retry.\n',
    );
  }

  // ---- pass 2: detailquote — split factor and date -----------------------
  const details = new Map();
  if (withSplits) {
    const detailStarted = Date.now();
    const resolved = symbols.filter((s) => batch.quotes[s]);
    let done = 0;
    let next = 0;
    const runner = async () => {
      for (;;) {
        const index = next; next += 1;
        if (index >= resolved.length) return;
        if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
        const detail = await fetchDetail(resolved[index], { token });
        if (detail.ok) details.set(resolved[index], detail);
        done += 1;
        if (done % 100 === 0) {
          process.stdout.write(`  detail ${String(done).padStart(4)} of ${resolved.length}  ${((Date.now() - detailStarted) / 1000).toFixed(0)}s\n`);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => runner()));
    process.stdout.write(
      `\n  detail: ${num(details.size)} of ${num(resolved.length)} resolved in ${((Date.now() - detailStarted) / 1000).toFixed(1)}s\n`,
    );
  }

  // ---- assemble -----------------------------------------------------------
  const stats = {};
  let withAdv = 0;
  let withSplit = 0;
  const mcapGaps = [];

  for (const company of target) {
    const symbol = company.nseSymbol;
    const quote = batch.quotes[symbol];
    const detail = details.get(symbol);
    if (!quote && !detail) continue;

    // Prefer the detail call's 3-month figure: it and the batch disagree
    // slightly (13,943,013 vs 13,637,505 for RELIANCE) and detail is the richer
    // response. Which one was used is recorded, never averaged.
    const advQty = detail?.avgVolume3m ?? quote?.avgVolume3m ?? quote?.avgVolume10d ?? null;
    const advSource = detail?.avgVolume3m != null
      ? 'munshot-3m-detail'
      : quote?.avgVolume3m != null ? 'munshot-3m-batch'
      : quote?.avgVolume10d != null ? 'munshot-10d' : null;
    if (advQty !== null) withAdv += 1;
    if (detail?.lastSplitDate) withSplit += 1;

    // Cross-check: Munshot's market cap is NSE-priced, ours is BSE-priced. They
    // will not agree, and the size of the gap is the interesting part.
    let mcapGapPct = null;
    if (quote?.marketCap && company.fullMcapInr) {
      mcapGapPct = round(((quote.marketCap - company.fullMcapInr) / company.fullMcapInr) * 100, 3);
      mcapGaps.push({ symbol, name: company.name, gapPct: mcapGapPct });
    }

    stats[symbol] = {
      nseSymbol: symbol,
      isin: company.isin,
      advQty,
      advSource,
      avgVolume10d: quote?.avgVolume10d ?? detail?.avgVolume10d ?? null,
      yearlyChangePct: quote?.yearlyChangePct ?? detail?.yearlyChangePct ?? null,
      lastSplitFactor: detail?.lastSplitFactor ?? null,
      lastSplitDate: detail?.lastSplitDate ?? null,
      munshotMarketCapInr: quote?.marketCap ?? detail?.marketCap ?? null,
      munshotVsBseMcapPct: mcapGapPct,
      yahooSymbol: detail?.yahooSymbol ?? null,
      exchange: detail?.exchange ?? null,
    };
  }

  const failedSymbols = batch.failed.map((f) => ({ symbol: f.symbol, reason: f.reason }));

  process.stdout.write('\n');
  process.stdout.write(
    renderTable(
      [{ key: 'what', label: 'Result', align: 'left' }, { key: 'n', label: 'Count', align: 'right' }],
      [
        { what: 'companies with statistics', n: `${num(Object.keys(stats).length)} of ${num(target.length)}` },
        { what: '— with an average daily volume', n: num(withAdv) },
        { what: '— with a recorded split', n: num(withSplit) },
        { what: 'upstream failures', n: num(failedSymbols.length) },
      ],
    ),
  );

  if (mcapGaps.length) {
    const sorted = [...mcapGaps].sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct));
    const abs = mcapGaps.map((g) => Math.abs(g.gapPct)).sort((a, b) => a - b);
    const median = abs[Math.floor(abs.length / 2)];
    process.stdout.write(
      `\n\n  Munshot (NSE-priced) vs our BSE full market cap — median |gap| ${median.toFixed(3)}%, ` +
      `worst ${Math.abs(sorted[0].gapPct).toFixed(2)}% (${sorted[0].symbol})\n` +
      '  They are different exchanges at different instants; the gap is expected, not an error.\n',
    );
  }

  const coveragePct = target.length ? (Object.keys(stats).length / target.length) * 100 : 0;
  process.stdout.write(`\n  coverage ${coveragePct.toFixed(1)}% of fetchable companies (floor ${minCoverage}%)\n`);
  if (coveragePct < minCoverage) {
    process.stderr.write(
      `\nREFUSING TO WRITE ${rel(OUT_PATH)} — only ${coveragePct.toFixed(1)}% of fetchable companies resolved.\n` +
      'A half-populated statistics file is worse than none: the missing half renders as an em dash\n' +
      'that reads as a property of the company rather than as a failed fetch.\n' +
      'Retry more gently: --concurrency 1 --gap-ms 1500\n\n',
    );
    process.exit(1);
  }

  const payload = {
    source: 'Munshot (fastapi.muns.io) — stockquote_batch and detailquote',
    note:
      'Monthly statistics. Munshot is Yahoo Finance NSE data (Symbol=…​.NS, Exchange=NSI); the committed ' +
      'price baseline is BSE bhavcopy. Different exchanges — figures here are never blended with BSE ones. ' +
      'lastSplitDate is decoded from UNIX epoch seconds. Only companies with an asserted NSE symbol appear.',
    capturedAt: new Date().toISOString(),
    fetchable: withSymbol.length,
    notFetchable: withoutSymbol.length,
    companyCount: Object.keys(stats).length,
    coveragePct: Number(coveragePct.toFixed(2)),
    chunkSize: DEFAULT_CHUNK_SIZE,
    concurrency,
    stats,
    failed: failedSymbols,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stdout.write(`\nWrote ${rel(OUT_PATH)} — ${num(Object.keys(stats).length)} companies.\n\n`);
}

main().catch((error) => {
  process.stderr.write(`\nUnhandled failure: ${error?.stack || error}\n\n`);
  process.exit(1);
});
