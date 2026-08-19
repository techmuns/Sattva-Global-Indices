#!/usr/bin/env node
/**
 * probe-liveness.mjs — does Munshot's quote actually move intraday?
 *
 *   node scripts/probe-liveness.mjs [--symbols RELIANCE,HFCL] [--country INDIA]
 *                                   [--gap-seconds 600] [--label "NSE open"]
 *
 * The question this answers is NOT "does the endpoint respond". It is "is the
 * number a live quote or a frozen close". Those look identical in a single
 * call, and the difference decides whether the pill on screen may say "live".
 *
 * The measurement is two calls separated by a gap, compared field by field.
 * It is only meaningful while the relevant market is OPEN — run post-close and
 * an unchanged price proves nothing at all, which is exactly the trap this
 * script exists to make visible rather than to fall into. The output therefore
 * always states whether the window was open, and refuses to call an unchanged
 * price "not live" outside one.
 *
 * Exit code is 0 whether or not the price moved; this reports, it does not gate.
 */

import { fetchBatch, MARKET } from './lib/munshot.mjs';
import { renderTable, num } from './lib/report.mjs';

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : fallback;
};

const symbols = argOf('--symbols', 'RELIANCE,HFCL,TCS').split(',').map((s) => s.trim()).filter(Boolean);
const country = argOf('--country', 'INDIA');
const gapSeconds = Number.parseInt(argOf('--gap-seconds', '600'), 10);
const label = argOf('--label', '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Compare the fields that would move if this were a live feed.
 * These are the NORMALISED names from lib/munshot.mjs (`price`), not the
 * upstream envelope's (`currentPrice`) — reading the wrong one yields
 * `undefined` on both sides, which compares equal and looks like "not live".
 */
const WATCHED = ['price', 'lastVolume', 'dayLow', 'dayHigh'];

async function snapshot() {
  const at = new Date();
  const result = await fetchBatch(symbols, { country, timeoutMs: 20000 });
  return { at, result };
}

async function main() {
  process.stdout.write(`\nMunshot liveness probe${label ? ` — ${label}` : ''}\n`);
  process.stdout.write(`  symbols   ${symbols.join(', ')}\n`);
  process.stdout.write(`  country   ${country}\n`);
  process.stdout.write(`  gap       ${gapSeconds}s\n`);

  const window = MARKET[country] ?? null;
  const openNow = window ? window.isOpen(new Date()) : null;
  process.stdout.write(
    `  window    ${window ? `${window.label} — ${openNow ? 'OPEN right now' : 'CLOSED right now'}` : 'unknown for this country'}\n\n`,
  );

  const first = await snapshot();
  process.stdout.write(`  t0 ${first.at.toISOString()}  ok=${first.result.ok.length} failed=${first.result.failed.length}\n`);
  if (first.result.failed.length) {
    for (const f of first.result.failed) process.stdout.write(`     FAILED ${f.symbol}: ${f.reason}\n`);
  }

  process.stdout.write(`  waiting ${gapSeconds}s …\n`);
  await sleep(gapSeconds * 1000);

  const second = await snapshot();
  process.stdout.write(`  t1 ${second.at.toISOString()}  ok=${second.result.ok.length} failed=${second.result.failed.length}\n\n`);

  const rows = [];
  let moved = 0;
  let compared = 0;
  for (const symbol of symbols) {
    const a = first.result.quotes[symbol];
    const b = second.result.quotes[symbol];
    if (!a || !b) {
      rows.push({ symbol, field: '—', t0: 'no quote', t1: 'no quote', changed: '—' });
      continue;
    }
    for (const field of WATCHED) {
      const before = a[field];
      const after = b[field];
      if (before === null && after === null) continue;
      compared += 1;
      const changed = before !== after;
      if (changed && field === 'price') moved += 1;
      rows.push({
        symbol,
        field,
        t0: before === null ? '—' : String(before),
        t1: after === null ? '—' : String(after),
        changed: changed ? 'MOVED' : 'same',
      });
    }
  }

  process.stdout.write(
    renderTable(
      [
        { key: 'symbol', label: 'Symbol', align: 'left' },
        { key: 'field', label: 'Field', align: 'left' },
        { key: 't0', label: 'At t0', align: 'right' },
        { key: 't1', label: 'At t1', align: 'right' },
        { key: 'changed', label: '', align: 'left' },
      ],
      rows,
    ),
  );

  const elapsed = (second.at - first.at) / 1000;
  process.stdout.write(`\n\n  compared ${num(compared)} field(s) over ${elapsed.toFixed(0)}s\n`);
  process.stdout.write(`  currentPrice moved for ${moved} of ${symbols.length} symbol(s)\n\n`);

  if (moved > 0) {
    process.stdout.write('  VERDICT: the feed is LIVE — the price changed within the window.\n\n');
  } else if (openNow === true) {
    process.stdout.write(
      '  VERDICT: no movement while the market was OPEN. Either the feed is cached/delayed,\n' +
        '  or these symbols genuinely did not print. Re-run on a liquid symbol before concluding.\n\n',
    );
  } else {
    process.stdout.write(
      '  VERDICT: INCONCLUSIVE. The market was closed for this window, so an unchanged price is\n' +
        '  the expected result and says nothing about whether the feed is live during a session.\n' +
        '  Re-run inside market hours. This is the trap the probe exists to make visible.\n\n',
    );
  }
}

main().catch((error) => {
  process.stderr.write(`\nProbe failed: ${error?.stack || error}\n\n`);
  process.exit(1);
});
