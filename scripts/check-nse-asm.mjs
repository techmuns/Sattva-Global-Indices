/**
 * What changed on NSE's surveillance list, and is the list still fresh enough to
 * believe? Reads only — this script writes nothing into `public/data`.
 *
 * Two jobs, both of which the fortnightly refresh (`asm-refresh.yml`) needs:
 *
 *   1. `--before=<path>`  report the classification changes between a previous
 *                         snapshot and the one now committed: who entered ASM,
 *                         who came off it, who changed stage. Keyed on ISIN, so
 *                         a respelled NSE symbol is a respelling and not two
 *                         fabricated events (§3.9, §2.32) — see lib/asm-diff.mjs.
 *
 *   2. `--assert-fresh`   fail when the committed list is older than the desk's
 *                         window (ASM_REFRESH.staleAfterDays). This is what
 *                         turns "we attempt ASM daily" into a guarantee: the
 *                         daily and weekly attempts are both soft, so before
 *                         this nothing anywhere failed when the feed went stale.
 *
 * ⚠ The freshness test takes its threshold from config and its clock from the
 * runner — neither of which the file under test can move (§3.8). It reads
 * `capturedAt`, which is stamped by our own scraper on a successful write, and
 * NOT `asOf`, which is NSE's effective date for the list: NSE can leave a list
 * effective for weeks without us having re-read it, so `asOf` answers a
 * different question and would call a month-old read fresh.
 *
 * ⚠ A capturedAt in the FUTURE fails too. That is not freshness, it is a clock
 * or a bad write, and treating it as "very fresh" would let the one broken case
 * sail past the guard that exists to catch broken cases.
 *
 * Usage:
 *   node scripts/check-nse-asm.mjs --before=/tmp/asm-before.json --summary
 *   node scripts/check-nse-asm.mjs --assert-fresh
 */

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { diffAsmSnapshots, changeCount } from './lib/asm-diff.mjs';
import { num } from './lib/report.mjs';
import { ASM_REFRESH } from '../public/js/config/thresholds.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const ASM_PATH = join(REPO, 'public', 'data', 'nse-asm.json');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
const has = (name) => process.argv.includes(`--${name}`);

function readJson(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Lines for the GitHub step summary, if we are running in Actions. */
const summary = [];
function say(line = '') {
  process.stdout.write(`${line}\n`);
  summary.push(line);
}

function describe(row) {
  const name = row.companyName ?? row.symbol ?? row.isin;
  return `${row.symbol ?? '—'}  ${name}`;
}

function main() {
  const current = readJson(ASM_PATH);
  if (!current) {
    process.stderr.write(
      `\nCannot read ${ASM_PATH.replace(`${REPO}/`, '')}. That is an outage or a bad write, not an\n`
      + 'empty surveillance list — refusing to report either changes or freshness.\n\n',
    );
    process.exit(1);
  }

  const maxAgeDays = Number(arg('max-age-days') ?? ASM_REFRESH.staleAfterDays);

  say('');
  say(`## NSE ASM list — ${current.asOf ?? 'no effective date'}`);
  say('');
  say(`${num(current.totalFlagged ?? 0)} securities under surveillance `
    + `(${num(current.withIsin ?? 0)} joinable by ISIN, ${num((current.noIsin ?? []).length)} without one).`);

  // ---- 1. what changed ------------------------------------------------
  const beforePath = arg('before');
  if (!beforePath) {
    // ⚠ Silence here is not "nothing changed". This run did not compare two
    // lists, and saying nothing at all would let a reader supply the cheerful
    // reading themselves (§2.4).
    say('');
    say('**No comparison made** — this run did not re-read NSE, so it cannot say whether the list moved.');
  }
  if (beforePath) {
    const before = readJson(beforePath);
    const diff = diffAsmSnapshots(before, current);
    say('');
    if (!diff.comparable) {
      // §2.4 — say WHICH kind of nothing this is. "No changes" would be a lie.
      say(`**Changes: not comparable.** ${diff.reason}`);
    } else {
      const total = changeCount(diff);
      say(`**${num(total)} classification change(s)** against the previous list `
        + `(${num(diff.beforeCount)} securities then, ${num(diff.afterCount)} now, `
        + `${num(diff.unchanged)} unchanged).`);
      const section = (title, rows, render) => {
        if (!rows.length) return;
        say('');
        say(`### ${title} — ${num(rows.length)}`);
        for (const row of rows) say(`- ${render(row)}`);
      };
      section('Entered ASM', diff.entered, (r) => `${describe(r)} → **${r.to.survCode ?? r.to.stage}**`);
      section('Came off ASM', diff.left, (r) => `${describe(r)} (was ${r.from.survCode ?? r.from.stage})`);
      section('Reclassified', diff.reclassified,
        (r) => `${describe(r)}: ${r.from.survCode ?? r.from.stage} → **${r.to.survCode ?? r.to.stage}**`);
      // Reported, and deliberately NOT counted as an ASM event (§2.32).
      section('Symbol respelled by NSE (not an ASM event)', diff.respelled,
        (r) => `${r.companyName ?? r.isin}: ${r.from ?? '—'} → ${r.to ?? '—'}`);
      if (!total) {
        say('');
        say('No security entered, left or changed stage since the previous list.');
      }
    }
  }

  // A single line fit for a commit subject. Counts only, no names: the names
  // are in the step summary and a commit subject that lists 40 companies is a
  // commit subject nobody reads.
  if (has('oneline')) {
    const before = readJson(arg('before'));
    const diff = diffAsmSnapshots(before, current);
    const line = diff.comparable
      ? (changeCount(diff)
        ? `${changeCount(diff)} change(s): ${diff.entered.length} entered, ${diff.left.length} off, ${diff.reclassified.length} reclassified`
        : 'no classification change')
      : 'no comparable previous list';
    process.stderr.write(`ONELINE:${line}\n`);
  }

  // ---- 2. is it fresh enough to believe? -------------------------------
  const capturedAt = current.capturedAt ? new Date(current.capturedAt) : null;
  const ageDays = capturedAt && !Number.isNaN(capturedAt.valueOf())
    ? (Date.now() - capturedAt.valueOf()) / MS_PER_DAY
    : null;

  say('');
  if (ageDays === null) {
    say(`**Freshness: unknown** — no readable \`capturedAt\`. Threshold ${maxAgeDays} days.`);
  } else {
    say(`**Freshness:** last successfully read ${ageDays.toFixed(1)} day(s) ago `
      + `(threshold ${maxAgeDays} days — ${ASM_REFRESH.attribution}).`);
  }

  if (has('summary') && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`, 'utf8');
  }

  if (!has('assert-fresh')) {
    say('');
    return;
  }

  if (ageDays === null) {
    process.stderr.write('\nNo readable capturedAt — cannot establish freshness, so it is not asserted.\n\n');
    process.exit(1);
  }
  if (ageDays < 0) {
    // Not "extremely fresh". A future stamp is a broken clock or a bad write.
    process.stderr.write(
      `\ncapturedAt is ${Math.abs(ageDays).toFixed(1)} day(s) in the FUTURE (${current.capturedAt}).\n`
      + 'That is a clock or a write fault, not freshness.\n\n',
    );
    process.exit(1);
  }
  if (ageDays > maxAgeDays) {
    process.stderr.write(
      `\nThe committed ASM list was last read ${ageDays.toFixed(1)} days ago, beyond the ${maxAgeDays}-day\n`
      + 'window. The daily and weekly attempts are soft, so this is the first thing that fails when\n'
      + "NSE has been refusing us: the screen is showing surveillance stages that may have moved on.\n\n",
    );
    process.exit(1);
  }
  say('');
}

main();
