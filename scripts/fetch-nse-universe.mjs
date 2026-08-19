#!/usr/bin/env node
/**
 * fetch-nse-universe.mjs — niftyindices constituent CSVs -> public/data/nse-universe.json
 *
 *   node scripts/fetch-nse-universe.mjs
 *
 * The NSE symbol <-> ISIN bridge, and the only clean one available. Two CSVs,
 * no bot protection, no headers required.
 *
 * WHY THIS FILE EXISTS AT ALL
 *   BSE's `scrip_id` looks exactly like an NSE symbol and very nearly always is
 *   one. Measured on the committed data: anchored on ISIN, scrip_id equals the
 *   NSE symbol for 747 of the 747 companies present in both sets, and differs
 *   for none. That is a good record and it is still not a licence to treat one
 *   as the other — "always so far, over the 750 largest names" is exactly the
 *   assumption that produces one wrong row in the long tail that nobody catches,
 *   and one wrong row here is a portfolio manager trading the wrong company.
 *   So the NSE symbol is only ever ASSERTED from this file, keyed on ISIN. Where
 *   this file has no entry, `nseSymbol` is null and stays null.
 *
 *   Nifty 500 is a strict subset of Nifty Total Market; both are read so the
 *   union is on the record and a change to either is visible.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { renderTable, num } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const OUT_PATH = join(REPO, 'public', 'data', 'nse-universe.json');

const SOURCES = [
  { key: 'nifty500', url: 'https://www.niftyindices.com/IndexConstituent/ind_nifty500list.csv' },
  { key: 'niftytotalmarket', url: 'https://niftyindices.com/IndexConstituent/ind_niftytotalmarket_list.csv' },
];

const FLOOR_SYMBOLS = 400;

/**
 * Split one CSV line, honouring double quotes. Company names contain commas
 * ("Bajaj Holdings & Investment Ltd." is fine, but several are not), so a
 * naive split on "," mis-columns those rows and would silently pair a name
 * fragment with the wrong ISIN.
 */
function splitCsvLine(line) {
  const cells = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cell += '"'; i += 1; } else { inQuotes = false; }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells.map((c) => c.trim());
}

function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').trim().split(/\r?\n/);
  if (lines.length < 2) return { headers: [], records: [] };
  const headers = splitCsvLine(lines[0]);
  const index = new Map(headers.map((h, i) => [h, i]));
  const records = [];
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue;
    const cells = splitCsvLine(lines[i]);
    records.push({
      get: (header) => {
        const at = index.get(header);
        return at === undefined ? null : (cells[at] ?? null);
      },
    });
  }
  return { headers, records };
}

/** curl straight to text — the CSV endpoints return text/csv, not JSON. */
import { execFile } from 'node:child_process';
const STATUS = '\n__CURL_HTTP_STATUS__';
function curlText(url) {
  return new Promise((resolve) => {
    execFile(
      'curl',
      [
        '-s', '-S', '--fail-with-body',
        '--retry', '4', '--retry-delay', '5', '--retry-all-errors',
        '--max-time', '40', '--compressed',
        '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        '-w', `${STATUS}%{http_code}`,
        url,
      ],
      { maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          resolve({ ok: false, reason: `curl failed: ${String(stderr || error.message).trim().split('\n')[0]}` });
          return;
        }
        const at = stdout.lastIndexOf(STATUS);
        if (at === -1) { resolve({ ok: false, reason: 'curl produced no status line' }); return; }
        const status = Number.parseInt(stdout.slice(at + STATUS.length).trim(), 10);
        if (status !== 200) { resolve({ ok: false, reason: `HTTP ${status}` }); return; }
        resolve({ ok: true, text: stdout.slice(0, at) });
      },
    );
  });
}

async function main() {
  process.stdout.write('\nNSE universe — niftyindices.com constituent CSVs (symbol <-> ISIN)\n\n');

  const bySymbol = new Map();
  const stats = [];
  const failed = [];
  const placeholders = [];

  for (const source of SOURCES) {
    const result = await curlText(source.url);
    if (!result.ok) {
      failed.push({ key: source.key, url: source.url, reason: result.reason });
      process.stdout.write(`  ${source.key.padEnd(18)} FAIL ${result.reason}\n`);
      continue;
    }
    const { headers, records } = parseCsv(result.text);
    for (const header of ['Company Name', 'Symbol', 'ISIN Code']) {
      if (!headers.includes(header)) {
        failed.push({ key: source.key, url: source.url, reason: `missing column "${header}" (have: ${headers.join(', ')})` });
      }
    }
    if (failed.some((f) => f.key === source.key)) {
      process.stdout.write(`  ${source.key.padEnd(18)} FAIL unexpected columns\n`);
      continue;
    }

    let fresh = 0;
    let malformed = 0;
    for (const record of records) {
      const symbol = String(record.get('Symbol') ?? '').trim();
      const isin = String(record.get('ISIN Code') ?? '').trim();
      const name = String(record.get('Company Name') ?? '').trim();
      // NSE carries demerger placeholders in these lists: real index rows whose
      // ISIN begins DUM rather than IN, standing in for an entity that has been
      // demerged but has not started trading. They are not securities and must
      // not enter the symbol map — but they are not malformed data either, so
      // they are recorded by name rather than dropped silently. They are the
      // NSE-side counterpart of the iShares rows whose ticker is `--`.
      if (symbol !== '' && /^DUM/.test(isin)) {
        placeholders.push({ symbol, isin, name, source: source.key, reason: 'NSE demerger placeholder — not a traded security' });
        continue;
      }
      if (symbol === '' || !/^IN[A-Z0-9]{10}$/.test(isin)) { malformed += 1; continue; }
      const existing = bySymbol.get(symbol);
      if (existing) {
        if (existing.isin !== isin) {
          failed.push({
            key: source.key,
            url: source.url,
            reason: `symbol ${symbol} carries ISIN ${isin} here and ${existing.isin} in ${existing.sources.join('/')}`,
          });
        }
        if (!existing.sources.includes(source.key)) existing.sources.push(source.key);
        continue;
      }
      bySymbol.set(symbol, {
        symbol,
        isin,
        name,
        industry: String(record.get('Industry') ?? '').trim() || null,
        series: String(record.get('Series') ?? '').trim() || null,
        sources: [source.key],
      });
      fresh += 1;
    }
    stats.push({ key: source.key, rows: records.length, added: fresh, malformed });
    process.stdout.write(
      `  ${source.key.padEnd(18)} ok   ${String(records.length).padStart(4)} rows, ${String(fresh).padStart(4)} new` +
        `${malformed ? `, ${malformed} malformed` : ''}\n`,
    );
  }

  const symbols = [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));

  process.stdout.write('\n');
  process.stdout.write(
    renderTable(
      [
        { key: 'key', label: 'Source', align: 'left' },
        { key: 'rows', label: 'Rows', align: 'right' },
        { key: 'added', label: 'New in union', align: 'right' },
        { key: 'malformed', label: 'Skipped', align: 'right' },
      ],
      stats.map((s) => ({ key: s.key, rows: num(s.rows), added: num(s.added), malformed: num(s.malformed) })),
    ),
  );

  const isinCounts = new Map();
  for (const s of symbols) isinCounts.set(s.isin, (isinCounts.get(s.isin) ?? 0) + 1);
  const duplicateIsins = [...isinCounts.entries()].filter(([, n]) => n > 1);

  process.stdout.write(
    `\n\nUnion: ${num(symbols.length)} distinct NSE symbols with an ISIN.` +
      ` ISINs used by more than one symbol: ${duplicateIsins.length}.\n`,
  );
  if (placeholders.length > 0) {
    process.stdout.write(
      `\nNSE demerger placeholders excluded from the symbol map (recorded in placeholders[]):\n`,
    );
    for (const p of placeholders) {
      process.stdout.write(`  ${p.symbol.padEnd(12)} ${p.isin.padEnd(13)} ${p.name}\n`);
    }
  }
  if (failed.length > 0) {
    process.stdout.write('\nProblems (recorded in failed[]):\n');
    for (const f of failed) process.stdout.write(`  ${f.key}: ${f.reason}\n`);
  }

  if (symbols.length < FLOOR_SYMBOLS) {
    process.stderr.write(
      `\nREFUSING TO WRITE: ${num(symbols.length)} symbols is below the sanity floor of ${num(FLOOR_SYMBOLS)}.\n` +
        'A short read here would silently weaken every ISIN-based resolution downstream.\n\n',
    );
    process.exit(1);
  }
  if (duplicateIsins.length > 0) {
    process.stdout.write(
      '\nWARNING: an ISIN maps to more than one symbol; the resolver treats those as ambiguous.\n',
    );
  }

  const payload = {
    source: 'niftyindices.com index constituent CSVs',
    note:
      'The authoritative NSE symbol <-> ISIN mapping for this project. BSE scrip_id is never used ' +
      'as a substitute, however often the two agree.',
    capturedAt: new Date().toISOString(),
    sources: SOURCES,
    symbolCount: symbols.length,
    symbols,
    placeholders,
    failed,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stdout.write(`\nWrote ${OUT_PATH.replace(REPO + '/', '')} — ${num(symbols.length)} symbols.\n\n`);
}

main().catch((error) => {
  process.stderr.write(`\nUnhandled failure: ${error?.stack || error}\n\n`);
  process.exit(1);
});
