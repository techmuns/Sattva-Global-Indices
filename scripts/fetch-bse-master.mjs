#!/usr/bin/env node
/**
 * fetch-bse-master.mjs — the BSE active-equity scrip master -> public/data/bse-scrip-master.json
 *
 *   node scripts/fetch-bse-master.mjs
 *
 * One request, ~1.7 MB, the whole listed equity universe. This is the file that
 * turns "the 261 names NSE's pre-open API will tell us about" into "every
 * company that could plausibly be in an MSCI review".
 *
 * WHAT `Mktcap` IS, AND WHAT IT IS NOT
 *   The master carries a `Mktcap` field: FULL market capitalisation in ₹ crore,
 *   plain decimal, no digit grouping. Measured against the per-scrip endpoint it
 *   agrees exactly (RELIANCE 1,769,379.44 in both), so it is BSE's own figure and
 *   not an approximation.
 *   It is used HERE FOR ONE PURPOSE ONLY: choosing which scrips are worth a
 *   per-scrip request. It is struck at a moment this endpoint does not disclose,
 *   so it must never reach a screen as a company's market cap. The authoritative
 *   full market cap comes from StockTrading, alongside the free float it must be
 *   divided by, in a single response at a single instant.
 *
 * DRIFT, AND WHY THIS SCRIPT WARNS RATHER THAN REFUSES
 *   `scripts/import-ishares.mjs` hard-fails on any drift, because it reads three
 *   workbooks committed in this repo: those bytes cannot change without someone
 *   changing them, so a moved number is always a bug. This script reads a LIVE
 *   endpoint. BSE lists and delists companies continuously, so an exact-count
 *   assertion would break the monthly refresh the first time a company IPOs —
 *   punishing the data for being current. So: the reference counts are checked
 *   and any difference is reported loudly, but only a collapse below the sanity
 *   floor refuses to write. The distinction is deliberate; do not "fix" it by
 *   making this strict, and do not fix import-ishares.mjs by making it lax.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { bseGet, SCRIP_MASTER_URL, parseGroupedNumber, parseCroreToRupees } from './lib/bse.mjs';
import { renderTable, num } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const OUT_PATH = join(REPO, 'public', 'data', 'bse-scrip-master.json');

/** Measured 2026-08-19. Reported against, not enforced — see the header. */
const REFERENCE = { scrips: 4974, withIneIsin: 4706 };

/** Below these the response is not a smaller universe, it is a broken read. */
const FLOOR = { scrips: 4000, withIneIsin: 3500 };

async function main() {
  process.stdout.write('\nBSE scrip master — api.bseindia.com/BseIndiaAPI/api/ListofScripData\n\n');

  const result = await bseGet(SCRIP_MASTER_URL);
  if (!result.ok) {
    process.stderr.write(
      `Could not read the scrip master: ${result.reason}\n` +
        'This is an OUTAGE, not an empty universe. Nothing written.\n\n',
    );
    process.exit(1);
  }

  const rows = Array.isArray(result.json) ? result.json : null;
  if (!rows) {
    process.stderr.write('The scrip master response was not an array. Nothing written.\n\n');
    process.exit(1);
  }

  const scrips = [];
  const skipped = [];
  for (const row of rows) {
    const scripCode = String(row.SCRIP_CD ?? '').trim();
    const scripId = String(row.scrip_id ?? '').trim();
    if (scripCode === '' || scripId === '') {
      skipped.push({ scripCode, scripId, reason: 'missing scrip code or scrip id' });
      continue;
    }
    const isinRaw = String(row.ISIN_NUMBER ?? '').trim();
    scrips.push({
      scripCode,
      scripId, // tracks the NSE symbol closely, but is NOT one — see resolve.mjs
      name: String(row.Scrip_Name ?? '').trim(),
      issuerName: String(row.Issuer_Name ?? '').trim() || null,
      isin: /^IN[A-Z0-9]{10}$/.test(isinRaw) ? isinRaw : null,
      group: String(row.GROUP ?? '').trim() || null,
      faceValue: parseGroupedNumber(row.FACE_VALUE),
      // Indicative only. Selects the scrape universe; never renders as a market cap.
      indicativeFullMcapInr: parseCroreToRupees(row.Mktcap),
    });
  }

  const withIneIsin = scrips.filter((s) => s.isin !== null && s.isin.startsWith('INE')).length;
  const withAnyIsin = scrips.filter((s) => s.isin !== null).length;
  const withMcap = scrips.filter((s) => s.indicativeFullMcapInr !== null).length;

  const uniqueCodes = new Set(scrips.map((s) => s.scripCode)).size;
  const uniqueIds = new Set(scrips.map((s) => s.scripId)).size;
  const isinCounts = new Map();
  for (const s of scrips) {
    if (s.isin) isinCounts.set(s.isin, (isinCounts.get(s.isin) ?? 0) + 1);
  }
  const duplicateIsins = [...isinCounts.entries()].filter(([, n]) => n > 1);

  process.stdout.write(
    renderTable(
      [
        { key: 'what', label: 'Measure', align: 'left' },
        { key: 'value', label: 'This run', align: 'right' },
        { key: 'reference', label: 'Reference (2026-08-19)', align: 'right' },
        { key: 'note', label: '', align: 'left' },
      ],
      [
        {
          what: 'active equity scrips',
          value: num(scrips.length),
          reference: num(REFERENCE.scrips),
          note: scrips.length === REFERENCE.scrips ? 'match' : 'DRIFT',
        },
        {
          what: 'with an INE… ISIN',
          value: num(withIneIsin),
          reference: num(REFERENCE.withIneIsin),
          note: withIneIsin === REFERENCE.withIneIsin ? 'match' : 'DRIFT',
        },
        { what: 'with any ISIN', value: num(withAnyIsin), reference: '—', note: '' },
        { what: 'with an indicative full mcap', value: num(withMcap), reference: '—', note: '' },
        { what: 'unique scrip codes', value: num(uniqueCodes), reference: num(scrips.length), note: uniqueCodes === scrips.length ? 'unique' : 'COLLIDING' },
        { what: 'unique scrip ids', value: num(uniqueIds), reference: num(scrips.length), note: uniqueIds === scrips.length ? 'unique' : 'COLLIDING' },
        { what: 'ISINs used by >1 scrip', value: num(duplicateIsins.length), reference: '0', note: duplicateIsins.length === 0 ? 'clean' : 'CHECK' },
      ],
    ),
  );

  if (skipped.length > 0) {
    process.stdout.write(`\n\n${num(skipped.length)} row(s) skipped for missing identifiers.\n`);
  }

  if (scrips.length !== REFERENCE.scrips || withIneIsin !== REFERENCE.withIneIsin) {
    process.stdout.write(
      '\n\nNOTE: the counts above differ from the reference measured on 2026-08-19.\n' +
        'That is expected over time — BSE lists and delists continuously. Update the\n' +
        'REFERENCE table in this script when you are satisfied the move is real.\n',
    );
  }

  if (scrips.length < FLOOR.scrips || withIneIsin < FLOOR.withIneIsin) {
    process.stderr.write(
      `\nREFUSING TO WRITE: ${num(scrips.length)} scrips / ${num(withIneIsin)} with an INE ISIN is\n` +
        `below the sanity floor (${num(FLOOR.scrips)} / ${num(FLOOR.withIneIsin)}). That is a broken read,\n` +
        'not a smaller universe. Nothing written.\n\n',
    );
    process.exit(1);
  }

  if (duplicateIsins.length > 0) {
    process.stdout.write(
      `\nWARNING: ${duplicateIsins.length} ISIN(s) map to more than one scrip; the resolver treats\n` +
        'an ambiguous ISIN as unresolved rather than picking one.\n',
    );
  }

  if (existsSync(OUT_PATH)) {
    try {
      const previous = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
      if (Number.isFinite(previous.scripCount) && previous.scripCount > scrips.length * 1.05) {
        process.stderr.write(
          `\nREFUSING TO WRITE: the existing master has ${num(previous.scripCount)} scrips and this run\n` +
            `collected ${num(scrips.length)} — more than a 5% drop. Re-run before replacing it.\n\n`,
        );
        process.exit(1);
      }
    } catch {
      /* an unreadable previous file is not a reason to block a good one */
    }
  }

  const payload = {
    source: 'BSE India — api.bseindia.com/BseIndiaAPI/api/ListofScripData (segment=Equity, status=Active)',
    note:
      'indicativeFullMcapInr selects the scrape universe only. It is BSE\'s Mktcap field converted ' +
      'from ₹ crore to rupees, struck at a moment this endpoint does not disclose, and must not ' +
      'render as a company\'s market cap. The authoritative full market cap comes from ' +
      'scripts/scrape-bse-freefloat.mjs, alongside the free float it is divided by.',
    capturedAt: new Date().toISOString(),
    scripCount: scrips.length,
    withIneIsinCount: withIneIsin,
    scrips,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `\n\nWrote ${OUT_PATH.replace(REPO + '/', '')} — ${num(scrips.length)} scrips, ` +
      `${num(withIneIsin)} with an INE ISIN.\n\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`\nUnhandled failure: ${error?.stack || error}\n\n`);
  process.exit(1);
});
