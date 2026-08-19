#!/usr/bin/env node
/**
 * probe-chunk-size.mjs — how many symbols can one upstream batch call carry?
 *
 *   node scripts/probe-chunk-size.mjs [--max 400]
 *
 * The Worker chunks its upstream calls and the chunk size has to come from a
 * measurement, not a guess: too large and every reader's refresh half-fails,
 * too small and a full book costs needless round trips. This walks the size up
 * and reports the largest that resolved every symbol it was given.
 *
 * Reports; writes nothing.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { fetchBatchChunk } from './lib/munshot.mjs';
import { renderTable, num } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

const args = process.argv.slice(2);
const argOf = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback; };
const maxSize = Number.parseInt(argOf('--max', '400'), 10);

const companies = JSON.parse(readFileSync(join(REPO, 'public', 'data', 'companies.json'), 'utf8'));
const symbols = companies.companies.map((c) => c.nseSymbol).filter(Boolean);

const SIZES = [10, 25, 50, 100, 150, 200, 300, 400].filter((n) => n <= maxSize && n <= symbols.length);

async function main() {
  process.stdout.write(`\nMunshot batch chunk-size probe — ${num(symbols.length)} NSE symbols available\n\n`);

  const rows = [];
  let largestClean = null;

  for (const size of SIZES) {
    const slice = symbols.slice(0, size);
    const started = Date.now();
    const result = await fetchBatchChunk(slice, { timeoutMs: 20000 });
    const elapsed = Date.now() - started;
    const resolved = Object.keys(result.quotes).length;
    const clean = result.ok && resolved === size;
    if (clean) largestClean = size;

    rows.push({
      size: num(size),
      resolved: `${num(resolved)} of ${num(size)}`,
      failed: num(result.failed.length),
      seconds: (elapsed / 1000).toFixed(1),
      perSymbol: `${(elapsed / size).toFixed(0)} ms`,
      verdict: clean ? 'clean' : (result.ok ? 'PARTIAL' : `FAILED — ${result.reason}`),
    });
    process.stdout.write(
      `  ${String(size).padStart(4)} symbols → ${String(resolved).padStart(4)} resolved, ` +
      `${String(result.failed.length).padStart(3)} failed, ${(elapsed / 1000).toFixed(1)}s ${clean ? '' : ' <-- not clean'}\n`,
    );
    if (result.failed.length) {
      const reasons = [...new Set(result.failed.map((f) => f.reason))].slice(0, 3);
      process.stdout.write(`        reasons: ${reasons.join(' | ')}\n`);
    }
    // Space the probes out; this is somebody else's service.
    await new Promise((r) => setTimeout(r, 2000));
  }

  process.stdout.write('\n');
  process.stdout.write(
    renderTable(
      [
        { key: 'size', label: 'Chunk', align: 'right' },
        { key: 'resolved', label: 'Resolved', align: 'right' },
        { key: 'failed', label: 'Failed', align: 'right' },
        { key: 'seconds', label: 'Seconds', align: 'right' },
        { key: 'perSymbol', label: 'Per symbol', align: 'right' },
        { key: 'verdict', label: '', align: 'left' },
      ],
      rows,
    ),
  );

  process.stdout.write(
    `\n\n  Largest chunk that resolved EVERY symbol: ${largestClean === null ? 'none' : num(largestClean)}\n`,
  );
  if (largestClean !== null) {
    const est = rows.find((r) => r.size === num(largestClean));
    const chunks = Math.ceil(symbols.length / largestClean);
    process.stdout.write(
      `  A full ${num(symbols.length)}-symbol refresh at that size: ${num(chunks)} chunks` +
      `, about ${(Number(est.seconds) * chunks / 3).toFixed(0)}s at concurrency 3.\n\n`,
    );
  }
}

main().catch((error) => {
  process.stderr.write(`\nProbe failed: ${error?.stack || error}\n\n`);
  process.exit(1);
});
