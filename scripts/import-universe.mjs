#!/usr/bin/env node
/**
 * import-universe.mjs — the desk's tracked universe -> public/data/universe.json
 *
 *   node scripts/import-universe.mjs
 *
 * Zero dependencies, no network. Reads scripts/fixtures/screener-universe.csv.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * The desk's instruction is "track every company above ₹2,000 Cr market cap".
 * This CSV is a Screener export of exactly that screen, and it does two jobs:
 *
 *   1. A SEED for the universe. Not the whole definition of it — see below.
 *   2. An IDENTITY BRIDGE. It carries ISIN, BSE code and NSE code together for
 *      1,253 companies, which is far better coverage than niftyindices' index
 *      lists (nse-universe.json), and it is the only source that names the
 *      NSE-only listings BSE cannot see at all.
 *
 * It is NOT the universe on its own, and build-companies.mjs must never treat
 * it as such, because a fixed list goes stale in exactly the way that matters:
 *
 *   - Companies cross ₹2,000 Cr in both directions every week. Measured against
 *     this export, La Opala (₹2,081 Cr) and TeamLease (₹2,071 Cr) sit above the
 *     floor in our own BSE data and below it in Screener's — the same companies,
 *     different minutes. A frozen list silently drops them.
 *   - A company the funds HOLD stays in scope at any size. Genus Prime Infra is
 *     ₹52 Cr and held; it is not in this export and must not be dropped.
 *
 * So the universe is recomputed every run as a UNION, and this file is one of
 * its three inputs:
 *
 *     active BSE scrips >= ₹2,000 Cr        (self-maintaining, from BSE's master)
 *   ∪ every company held by any fund        (any size, always)
 *   ∪ this seed list                        (catches NSE-only names)
 *
 * ---------------------------------------------------------------------------
 * PROVENANCE: THE EXPORT CARRIES NO DATE
 * ---------------------------------------------------------------------------
 * Screener's CSV has a `Current Price` column and no timestamp anywhere. The
 * honest record of that is `asOf: null` — NOT today's date, and NOT the date the
 * file happened to be added to the repo. Inventing an as-of for a file that has
 * none is precisely the fabrication 2.1 forbids.
 *
 * What we CAN do is measure it: the price column is compared against the
 * committed BSE closes and the best-matching trade date is reported as
 * `priceMatch`, clearly marked as ours (tier 2) rather than Screener's. That is
 * evidence about when the export was struck, not a claim from Screener.
 *
 * Screener's `Market Capitalization` is used ONLY to record what the screen was
 * and to sanity-check the floor. It never reaches a screen as a company's market
 * cap: that comes from BSE, recomputed against today's price.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { readTable, numberValue, textValue } from './lib/csv.mjs';
import { renderTable, num } from './lib/report.mjs';
import { RUPEES_PER_CRORE, SCRAPE_UNIVERSE_MIN_FULL_MCAP_INR } from '../public/js/config/thresholds.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const CSV_PATH = join(REPO, 'scripts/fixtures/screener-universe.csv');
const OUT_PATH = join(REPO, 'public/data/universe.json');
const PRICES_PATH = join(REPO, 'public/data/prices.json');

/** A real ISIN for an Indian security. Anything else is not an identity. */
const ISIN_RE = /^IN[A-Z0-9]{9}\d$/;

const REQUIRED = [
  'Name', 'BSE Code', 'NSE Code', 'ISIN Code',
  'Industry Group', 'Industry', 'Current Price', 'Market Capitalization',
];

function main() {
  const allowShrink = process.argv.includes('--allow-shrink');

  if (!existsSync(CSV_PATH)) {
    process.stderr.write(`\nMissing ${CSV_PATH.replace(REPO + '/', '')}.\n\n`);
    process.exit(1);
  }
  const text = readFileSync(CSV_PATH, 'utf8');
  const sha256 = createHash('sha256').update(text).digest('hex');
  const { header, rows } = readTable(text, { require: REQUIRED });

  process.stdout.write('\nUniverse import — Screener export\n\n');

  const companies = [];
  const rejected = [];
  const byIsin = new Map();

  for (const [i, row] of rows.entries()) {
    const isin = textValue(row['ISIN Code']);
    const name = textValue(row.Name);
    const rowNumber = i + 2; // 1-based, plus the header line

    if (!isin || !ISIN_RE.test(isin)) {
      // Kept on the record with a reason. A row we cannot key is not a row we
      // pretend we never saw — 2.4.
      rejected.push({ rowNumber, name, isin, reason: `not a well-formed ISIN: ${JSON.stringify(isin)}` });
      continue;
    }
    if (byIsin.has(isin)) {
      // Two rows for one company means one of them is wrong, and the wrongness
      // is invisible downstream because both look well-formed — 3.9.
      process.stderr.write(
        `\nRefusing to write: ISIN ${isin} appears twice `
        + `(rows ${byIsin.get(isin).rowNumber} and ${rowNumber}: `
        + `${byIsin.get(isin).name} / ${name}).\n\n`,
      );
      process.exit(1);
    }

    const bseScripCode = textValue(row['BSE Code']);
    const nseSymbol = textValue(row['NSE Code']);
    const mcCrore = numberValue(row['Market Capitalization']);
    const priceInr = numberValue(row['Current Price']);

    const record = {
      isin,
      name,
      // Verbatim, as they appear. Not resolved, not looked up — 3.4.
      bseScripCode,
      nseSymbol,
      industryGroup: textValue(row['Industry Group']),
      industry: textValue(row.Industry),
      // Normalised to RUPEES at this boundary so exactly one unit exists
      // downstream, the same rule the BSE client applies to ₹-crore strings.
      screenerFullMcapInr: mcCrore === null ? null : Math.round(mcCrore * RUPEES_PER_CRORE),
      screenerPriceInr: priceInr,
      listing: bseScripCode && nseSymbol ? 'both'
        : bseScripCode ? 'bse-only'
        : nseSymbol ? 'nse-only'
        : 'neither',
    };
    byIsin.set(isin, { rowNumber, name });
    companies.push(record);
  }

  // ---- guards ------------------------------------------------------------
  const checks = [];
  const fail = (ok, label, detail) => { checks.push({ ok, label, detail }); return ok; };

  fail(companies.length > 0, 'the export produced at least one company', `${companies.length} rows`);
  fail(rejected.length === 0, 'every row carries a well-formed ISIN',
    rejected.slice(0, 4).map((r) => `row ${r.rowNumber} ${r.name}`).join(' | '));

  // The screen claims "> ₹2,000 Cr". If rows fall below it, the export is not
  // the screen it says it is, and the universe floor documented downstream
  // would be a fiction.
  const belowFloor = companies.filter((c) => c.screenerFullMcapInr !== null
    && c.screenerFullMcapInr < SCRAPE_UNIVERSE_MIN_FULL_MCAP_INR);
  fail(belowFloor.length === 0,
    `every company clears the ₹${num(SCRAPE_UNIVERSE_MIN_FULL_MCAP_INR / RUPEES_PER_CRORE)} Cr screen the export claims`,
    belowFloor.slice(0, 4).map((c) => `${c.name} ₹${num(Math.round(c.screenerFullMcapInr / RUPEES_PER_CRORE))} Cr`).join(' | '));

  const noMcap = companies.filter((c) => c.screenerFullMcapInr === null);
  fail(noMcap.length === 0, 'every company has a parsable market cap',
    noMcap.slice(0, 4).map((c) => c.name).join(' | '));

  // ---- when was this struck? MEASURED, not claimed ------------------------
  // Screener publishes no timestamp. Rather than invent one, compare the price
  // column against the committed BSE closes and report the match rate.
  let priceMatch = null;
  if (existsSync(PRICES_PATH)) {
    const prices = JSON.parse(readFileSync(PRICES_PATH, 'utf8'));
    let compared = 0;
    let within1pct = 0;
    let exact = 0;
    for (const c of companies) {
      if (!c.bseScripCode || c.screenerPriceInr === null) continue;
      const row = prices.prices?.[c.bseScripCode];
      const close = row?.closeInr ?? row?.close ?? null;
      if (close === null || !(close > 0)) continue;
      compared += 1;
      const rel = Math.abs(c.screenerPriceInr - close) / close;
      if (rel < 0.0001) exact += 1;
      if (rel < 0.01) within1pct += 1;
    }
    priceMatch = {
      note: 'DERIVED BY US, not published by Screener: the export carries no timestamp, '
        + "so its price column is compared against the committed BSE closes to date it.",
      againstTradeDate: prices.tradeDate ?? null,
      compared,
      exact,
      within1pct,
      exactPct: compared > 0 ? Number(((exact / compared) * 100).toFixed(1)) : null,
      within1pctPct: compared > 0 ? Number(((within1pct / compared) * 100).toFixed(1)) : null,
    };
  }

  const counts = {
    companies: companies.length,
    withBseCode: companies.filter((c) => c.bseScripCode).length,
    withNseSymbol: companies.filter((c) => c.nseSymbol).length,
    both: companies.filter((c) => c.listing === 'both').length,
    bseOnly: companies.filter((c) => c.listing === 'bse-only').length,
    nseOnly: companies.filter((c) => c.listing === 'nse-only').length,
    neither: companies.filter((c) => c.listing === 'neither').length,
  };

  process.stdout.write(renderTable(
    [{ key: 'what', label: 'Seed list', align: 'left' }, { key: 'n', label: 'Companies', align: 'right' }],
    [
      { what: 'rows in the export', n: num(counts.companies) },
      { what: 'listed on both exchanges', n: num(counts.both) },
      { what: 'BSE only (no NSE code)', n: num(counts.bseOnly) },
      { what: 'NSE only (no BSE code) — BSE can never serve these', n: num(counts.nseOnly) },
      { what: 'neither code — not listed on either exchange', n: num(counts.neither) },
    ],
  ));

  if (priceMatch) {
    process.stdout.write(
      `\n\n  price column vs the committed ${priceMatch.againstTradeDate} BSE closes: `
      + `${num(priceMatch.exact)} of ${num(priceMatch.compared)} exact (${priceMatch.exactPct}%), `
      + `${num(priceMatch.within1pct)} within 1% (${priceMatch.within1pctPct}%)\n`,
    );
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    process.stderr.write(`\n\nREFUSING TO WRITE ${OUT_PATH.replace(REPO + '/', '')} — ${failed.length} check(s) failed:\n\n`);
    for (const c of failed) process.stderr.write(`  FAIL  ${c.label}${c.detail ? ` — ${c.detail}` : ''}\n`);
    process.stderr.write('\n');
    process.exit(1);
  }
  for (const c of checks) process.stdout.write(`\n  ok    ${c.label}`);
  process.stdout.write('\n');

  // A writer never replaces a good snapshot with a smaller one.
  if (existsSync(OUT_PATH) && !allowShrink) {
    const previous = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
    const was = previous.companies?.length ?? 0;
    if (companies.length < was) {
      process.stderr.write(
        `\nRefusing to shrink the universe: ${num(was)} companies on file, `
        + `${num(companies.length)} in this export. Pass --allow-shrink if the screen genuinely shrank.\n\n`,
      );
      process.exit(1);
    }
  }

  const payload = {
    source: 'Screener.in export — the screen "market capitalisation above ₹2,000 Cr"',
    note: 'A SEED and an identity bridge, not the whole universe. build-companies.mjs '
      + 'unions this with every active BSE scrip above the floor and with every company '
      + 'the funds hold at any size, so a company crossing the floor is picked up without '
      + 'a re-export.',
    // Screener publishes no as-of. Saying so is the record; a date here would be
    // invented. `priceMatch` below is our own attempt to date it.
    asOf: null,
    asOfNote: 'Screener\'s export carries no timestamp. This is null on purpose — see priceMatch.',
    fixture: 'scripts/fixtures/screener-universe.csv',
    sha256,
    columnsInExport: header.length,
    screen: {
      minFullMcapInr: SCRAPE_UNIVERSE_MIN_FULL_MCAP_INR,
      label: '₹2,000 Cr full market capitalisation',
      attribution: "the desk's instruction — track every company above ₹2,000 Cr. "
        + 'Full market cap, not free float, and not an MSCI published cut-off.',
    },
    priceMatch,
    counts,
    rejected,
    companies,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stdout.write(`\nWrote ${OUT_PATH.replace(REPO + '/', '')} — ${num(companies.length)} companies.\n\n`);
}

main();
