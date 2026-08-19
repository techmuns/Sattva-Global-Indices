#!/usr/bin/env node
/**
 * check-naive-join.mjs — measure the gap a ticker resolver will have to close.
 *
 *   node scripts/check-naive-join.mjs
 *
 * Joins public/data/msci-funds.json to public/data/nse-freefloat.json on
 * `iShares ticker === NSE symbol`, EXACTLY and NAIVELY. There is deliberately
 * no resolver here: no case folding, no punctuation fixes, no BSE-code lookup,
 * no alias table. This run is the BASELINE — a later, separate prompt builds the
 * resolver and has to beat these numbers, and it can only be shown to beat them
 * if the unimproved figure is on the record first.
 *
 * This script reads and reports; it writes nothing.
 *
 * Two denominators matter and both are printed:
 *   - by COUNT — how many holdings we can price the float of;
 *   - by WEIGHT — how much of the fund's India exposure those holdings carry.
 * They differ enormously, and the difference is the story: the NSE free-float
 * set covers most of the EM ETF's India weight and very little of either
 * small-cap fund's — and the small caps are exactly where inclusion
 * forecasting matters.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { renderTable, num, round } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const FUNDS_PATH = join(REPO, 'public', 'data', 'msci-funds.json');
const FREEFLOAT_PATH = join(REPO, 'public', 'data', 'nse-freefloat.json');

function requireFile(path, how) {
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  process.stderr.write(
    `\nMissing ${path.replace(REPO + '/', '')}. Run \`${how}\` first.\n` +
      'This script reports on a join; it will not invent one side of it.\n\n',
  );
  process.exit(1);
  return null;
}

function main() {
  const funds = requireFile(FUNDS_PATH, 'node scripts/import-ishares.mjs');
  const freefloat = requireFile(FREEFLOAT_PATH, 'node scripts/scrape-nse-freefloat.mjs');

  const nseSymbols = new Set(freefloat.companies.map((c) => c.symbol));

  process.stdout.write(
    `\nNaive join — iShares ticker === NSE symbol, exact match, NO resolver\n` +
      `  funds     ${funds.funds.length} funds, holdings as of ${funds.funds[0]?.asOf}\n` +
      `  freefloat ${num(freefloat.companyCount)} NSE symbols, session ${freefloat.sessionTimestamp}\n\n`,
  );

  const rows = [];
  const detail = [];

  for (const fund of funds.funds) {
    const matched = [];
    const unmatched = [];
    for (const holding of fund.holdings) {
      (nseSymbols.has(holding.ticker) ? matched : unmatched).push(holding);
    }
    const totalWeight = fund.holdings.reduce((a, h) => a + (h.weightPct ?? 0), 0);
    const matchedWeight = matched.reduce((a, h) => a + (h.weightPct ?? 0), 0);

    rows.push({
      fund: fund.shortName,
      byCount: `${num(matched.length)} of ${num(fund.holdings.length)}`,
      countPct: `${round((matched.length / fund.holdings.length) * 100, 1).toFixed(1)}%`,
      byWeight: `${round(matchedWeight, 3).toFixed(3)} of ${round(totalWeight, 3).toFixed(3)}`,
      weightPct: `${round((matchedWeight / totalWeight) * 100, 1).toFixed(1)}%`,
    });

    const byKind = { nse: 0, 'bse-code': 0, none: 0 };
    for (const h of unmatched) byKind[h.tickerKind] += 1;
    detail.push({ fund, matched, unmatched, byKind, totalWeight, matchedWeight });
  }

  process.stdout.write(
    renderTable(
      [
        { key: 'fund', label: 'Fund', align: 'left' },
        { key: 'byCount', label: 'Matched (holdings)', align: 'right' },
        { key: 'countPct', label: '%', align: 'right' },
        { key: 'byWeight', label: 'Matched (India weight %)', align: 'right' },
        { key: 'weightPct', label: '% of India weight', align: 'right' },
      ],
      rows,
    ),
  );
  process.stdout.write(
    '\n\nEvery figure above is "X of Y". The weight columns are percentages of\n' +
      'their own fund and are not comparable between rows.\n',
  );

  for (const d of detail) {
    process.stdout.write(
      `\n\n--- ${d.fund.shortName} (${d.fund.id}) — ${num(d.unmatched.length)} of ` +
        `${num(d.fund.holdings.length)} holdings unmatched ---\n` +
        `    by ticker kind: nse-looking ${d.byKind.nse}, BSE scrip code ${d.byKind['bse-code']}, ` +
        `no ticker ('--') ${d.byKind.none}\n` +
        `    unmatched India weight: ${round(d.totalWeight - d.matchedWeight, 3).toFixed(3)} ` +
        `of ${round(d.totalWeight, 3).toFixed(3)} percentage points of this fund\n\n`,
    );
    const ordered = [...d.unmatched].sort((a, b) => (b.weightPct ?? 0) - (a.weightPct ?? 0));
    for (const h of ordered) {
      process.stdout.write(
        `      ${h.ticker.padEnd(14)} ${String(round(h.weightPct, 5) ?? '—').padStart(8)}%  ` +
          `${h.tickerKind.padEnd(9)} ${h.name}\n`,
      );
    }
  }

  // MRF is worth a named look: it is a large, liquid, F&O-eligible name, so a
  // plain-symbol miss is suspicious. Say which of the two possible causes it is
  // — absent from the NSE set, or present under a different spelling — without
  // fixing anything. Fixing is the resolver's job, in its own prompt.
  const suspicious = ['MRF'];
  process.stdout.write('\n\nNamed checks\n');
  for (const ticker of suspicious) {
    const inFunds = funds.funds
      .filter((f) => f.holdings.some((h) => h.ticker === ticker))
      .map((f) => f.shortName);
    const exact = nseSymbols.has(ticker);
    const near = [...nseSymbols].filter(
      (s) => s !== ticker && s.replace(/[^A-Z0-9]/gi, '').toUpperCase().includes(ticker.toUpperCase()),
    );
    process.stdout.write(
      `  ${ticker}: held by ${inFunds.join(', ') || 'no fund'}; ` +
        `exact match in the NSE set: ${exact ? 'yes' : 'NO'}; ` +
        `near spellings in the NSE set: ${near.length ? near.join(', ') : 'none'}\n`,
    );
  }
  process.stdout.write(
    '\n  Not fixed here. The NSE set is the 261 symbols carried by the NIFTY, FO and\n' +
      '  SME pre-open keys — a name absent from all three has NO free-float reading\n' +
      '  from this source, which is a different fact from having no free float.\n\n',
  );
}

main();
