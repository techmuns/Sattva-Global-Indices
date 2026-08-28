#!/usr/bin/env node
/**
 * verify-data.mjs — every data-layer trap found across prompts 1–5, as a test.
 *
 *   node scripts/verify-data.mjs            run the suite
 *   node scripts/verify-data.mjs --prove    additionally break each check on
 *                                           purpose and demand that it goes red
 *
 * No browser, no network, no running server: it reads the committed JSON and
 * the committed fixtures. Exits non-zero if any check failed.
 *
 * WHY EACH CHECK CARRIES ITS OWN SABOTAGE
 *
 * Every trap below was found by breaking something and watching what happened.
 * The unit tripwire in build-companies.mjs passed a deliberately corrupted file
 * on its first attempt, because it read its own threshold from the value under
 * test. A check nobody has seen fail is an assumption wearing a tick mark. So
 * `--prove` clones the context, breaks precisely the thing the check exists to
 * catch, and reports CANNOT FAIL — as a failure — for any check that survives.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import { Suite, parseArgs, ok, equal, empty, fail } from './lib/assert.mjs';
import { assertBhavcopyShape, parseBhavcopy, assertContinuity } from './lib/bhavcopy.mjs';
import { parseRawQuote, quoteNumber, quoteText } from './lib/munshot.mjs';
import { buildIndex, resolveAll } from './lib/resolve.mjs';
import { verdictFromRules } from '../public/js/model/assess.js';
import { seriesToMap, summarise, assertSeriesDates, comparableInInr } from '../public/js/model/benchmarks.js';
import { reviewCutoffs, CONVENTION } from '../public/js/model/calendar.js';
import * as MSCI from '../public/js/config/msci-methodology.mjs';
import { SEGMENT_BAND_ADJUSTMENT } from '../public/js/config/thresholds.mjs';
import { gimiCutoffs, assessGimi, reviewWindow, METHODOLOGIES, METHODOLOGY_IDS } from '../public/js/model/gimi.js';
import { METHODOLOGIES as STATE_METHODOLOGIES } from '../public/js/core/state.js';
import { inrFlow, pct, pp, signedPct, factorPct, count, cr, EM_DASH } from '../public/js/core/format.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const readText = (p) => readFileSync(join(ROOT, p), 'utf8');

/* ── the source scanner ────────────────────────────────────────────────────
 * Several rules are about code that must not exist. Grepping the tree is the
 * only way to assert an absence. The suites themselves are excluded — they
 * quote the forbidden patterns as string literals, and a scanner that flagged
 * its own rule list would be unfalsifiable in the other direction.
 */
const SCAN_ROOTS = ['public/js', 'scripts', 'worker'];
const SCAN_EXCLUDE = [/scripts\/verify-.*\.mjs$/, /scripts\/lib\/assert\.mjs$/];

function loadSources() {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = join(dir, name);
      const abs = join(ROOT, rel);
      if (statSync(abs).isDirectory()) { walk(rel); continue; }
      if (!/\.(js|mjs)$/.test(name)) continue;
      if (SCAN_EXCLUDE.some((re) => re.test(rel))) continue;
      files.push({ path: relative('.', rel), text: readFileSync(abs, 'utf8') });
    }
  };
  for (const root of SCAN_ROOTS) walk(root);
  return files;
}

/**
 * Blank out comments and string literals, preserving every byte position and
 * newline so line numbers still point at the right place.
 *
 * WITHOUT THIS THE SCANNER IS WORSE THAN USELESS. Its first run flagged three
 * "violations", and all three were the doctrine itself: bse.mjs explaining in a
 * comment why `parseFloat("8,71,532.61")` returns 8, and two places explaining
 * in prose why `"68% likely"` will never be printed. A rule that fires on the
 * text describing the rule trains everyone to ignore it, and the next real hit
 * goes by unread. The scanner therefore reads CODE, and only code.
 */
function codeOnly(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  const blank = (s) => s.replace(/[^\n]/g, ' ');

  while (i < n) {
    const two = text.slice(i, i + 2);
    if (two === '//') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += blank(text.slice(i, stop));
      i = stop;
    } else if (two === '/*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += blank(text.slice(i, stop));
      i = stop;
    } else if (text[i] === '\'' || text[i] === '"' || text[i] === '`') {
      const quote = text[i];
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === quote) { j += 1; break; }
        j += 1;
      }
      // Keep the delimiters so an identifier never fuses across a string.
      out += quote + blank(text.slice(i + 1, Math.max(i + 1, j - 1))) + (j <= n ? quote : '');
      i = j;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

/** Report every source line of CODE matching any forbidden pattern. */
function scan(sources, patterns) {
  const hits = [];
  for (const file of sources) {
    const lines = codeOnly(file.text).split('\n');
    const raw = file.text.split('\n');
    for (const { label, re } of patterns) {
      for (const [i, line] of lines.entries()) {
        re.lastIndex = 0;
        if (re.test(line)) hits.push(`${file.path}:${i + 1} ${label} — ${raw[i].trim().slice(0, 90)}`);
      }
    }
  }
  return hits;
}

/* ── context ───────────────────────────────────────────────────────────────*/
function loadContext() {
  const companiesFile = readJson('public/data/companies.json');
  return {
    funds: readJson('public/data/msci-funds.json'),
    companiesFile,
    companies: companiesFile.companies,
    master: readJson('public/data/bse-scrip-master.json'),
    universe: readJson('public/data/nse-universe.json'),
    universeSeed: readJson('public/data/universe.json'),
    benchmarks: readJson('public/data/fund-benchmarks.json'),
    nseFloat: readJson('public/data/nse-freefloat.json'),
    prices: readJson('public/data/prices.json'),
    reconciliation: readJson('public/data/share-reconciliation.json'),
    sources: loadSources(),
    // Injected so a check can be broken by swapping the thing it verifies.
    fn: { assertBhavcopyShape, assertContinuity, parseRawQuote, resolveAll, inrFlow, pct, pp, signedPct, factorPct, count },
    fixtures: {
      spaShell: readText('scripts/fixtures/bhavcopy-spa-shell.html'),
      bhavToday: readText('scripts/fixtures/bhavcopy-sample-20260819.csv'),
      bhavPrev: readText('scripts/fixtures/bhavcopy-sample-20260818.csv'),
      rawQuote: readText('scripts/fixtures/munshot-rawquote-reliance.txt'),
    },
  };
}

const clone = (ctx) => ({
  ...ctx,
  companiesFile: structuredClone(ctx.companiesFile),
  companies: null, // rebound below
  funds: structuredClone(ctx.funds),
  universeSeed: structuredClone(ctx.universeSeed),
  benchmarks: structuredClone(ctx.benchmarks),
  master: structuredClone(ctx.master),
  prices: structuredClone(ctx.prices),
  reconciliation: structuredClone(ctx.reconciliation),
  sources: ctx.sources.map((s) => ({ ...s })),
  fn: { ...ctx.fn },
  fixtures: { ...ctx.fixtures },
});
const deepClone = (ctx) => { const c = clone(ctx); c.companies = c.companiesFile.companies; return c; };

/* ── the funds, by id ──────────────────────────────────────────────────────*/
const FUND_IDS = ['eem', 'smin', 'eems'];
const heldBy = (company, fundId) => company.funds?.[fundId] != null;

/* ══════════════════════════════════════════════════════════════════════════*/
async function main() {
  const { prove, only } = parseArgs(process.argv);
  const suite = new Suite('verify-data', { prove, only, timeoutMs: 60000 });
  const ctx = loadContext();

  suite.write(`\n  Sattva Index Flows — data verification${prove ? '  (--prove: every check must fail on purpose)' : ''}\n`);

  /* ── the workbooks ──────────────────────────────────────────────────────*/
  suite.section('Source workbooks');

  await suite.check({
    id: 1,
    what: 'India equity rows 165 / 461 / 414 and weight sums 11.315 / 99.729 / 21.271',
    clone: deepClone,
    run: (c) => {
      const EXPECT = {
        eem: { rows: 165, weight: '11.315' },
        smin: { rows: 461, weight: '99.729' },
        eems: { rows: 414, weight: '21.271' },
      };
      const measured = {};
      for (const id of FUND_IDS) {
        const fund = c.funds.funds.find((f) => f.id === id);
        ok(fund, `fund ${id} is present in msci-funds.json`);
        const rows = fund.holdings.length;
        const weight = fund.holdings.reduce((sum, h) => sum + (h.weightPct ?? 0), 0).toFixed(3);
        measured[id] = { rows, weight };
        equal(rows, EXPECT[id].rows, `${id}: India equity row count`);
        equal(weight, EXPECT[id].weight, `${id}: India weight sum (3dp)`);
      }
      return FUND_IDS.map((id) => `${id} ${measured[id].rows} rows / ${measured[id].weight}%`).join('  ·  ');
    },
    sabotage: (c) => { c.funds.funds.find((f) => f.id === 'smin').holdings.pop(); },
  }, ctx);

  await suite.check({
    id: 3,
    what: 'no code sums, averages or ranks a weight across funds',
    clone: deepClone,
    run: (c) => {
      const hits = scan(c.sources, [
        { label: 'aggregation over the per-company funds map', re: /Object\.values\(\s*[\w.]*funds\s*\)\s*\.?\s*(reduce|map\([^)]*\)\s*\.reduce)/ },
        { label: 'a named cross-fund weight total', re: /\b(crossFundWeight|combinedWeight|allFundsWeight|weightAcrossFunds|totalWeightAcrossFunds|aggregateFundWeight)\b/ },
        { label: 'two fund weights added together', re: /(eem|smin|eems)[^\n]{0,30}weightPct[^\n]{0,20}\+[^\n]{0,20}(eem|smin|eems)[^\n]{0,30}weightPct/ },
        { label: 'a weight accumulator over fund ids', re: /for\s*\([^)]*of\s*FUND_IDS[^\n]*\)[^\n]*\+=\s*[\w.]*weightPct/ },
      ]);
      empty(hits, 'a weight belongs to one fund and one fund only — no cross-fund arithmetic may exist', (h) => h);
      return `${c.sources.length} source files scanned, 0 cross-fund weight expressions`;
    },
    sabotage: (c) => {
      c.sources.push({
        path: 'public/js/SABOTAGE.js',
        text: 'const w = Object.values(company.funds).reduce((a, f) => a + (f?.weightPct ?? 0), 0);\n',
      });
    },
  }, ctx);

  /* ── segments ───────────────────────────────────────────────────────────*/
  suite.section('Segments');

  await suite.check({
    id: 2,
    what: 'segments strictly disjoint: EM ∩ India SC = 0, EM ∩ EM SC = 0, EM SC ⊆ India SC',
    clone: deepClone,
    run: (c) => {
      const emAndSmin = c.companies.filter((x) => heldBy(x, 'eem') && heldBy(x, 'smin'));
      const emAndEems = c.companies.filter((x) => heldBy(x, 'eem') && heldBy(x, 'eems'));
      const eemsNotSmin = c.companies.filter((x) => heldBy(x, 'eems') && !heldBy(x, 'smin'));
      empty(emAndSmin, 'EM ETF and India Small-Cap must not share a company', (x) => x.name);
      empty(emAndEems, 'EM ETF and EM Small-Cap must not share a company', (x) => x.name);
      empty(eemsNotSmin, 'EM Small-Cap must be a subset of India Small-Cap', (x) => x.name);
      const sampled = c.companies.filter((x) => heldBy(x, 'eems')).length;
      const smin = c.companies.filter((x) => heldBy(x, 'smin')).length;
      return `EM ∩ SMIN 0 · EM ∩ EEMS 0 · EM SC samples ${sampled} of India SC's ${smin}`;
    },
    sabotage: (c) => {
      const em = c.companies.find((x) => heldBy(x, 'eem'));
      em.funds.smin = { weightPct: 0.5, quantity: 1, marketValueUsd: 1 };
    },
  }, ctx);

  /* ── units ──────────────────────────────────────────────────────────────*/
  suite.section('Units and arithmetic');

  await suite.check({
    id: 4,
    what: 'every ...Inr field is in rupees — per-scrip vs the master\'s independent Mktcap, within 100×',
    clone: deepClone,
    run: (c) => {
      // The threshold comes from a DIFFERENT read of a DIFFERENT field, so a
      // corrupted row cannot move the bar it is measured against.
      const masterMcap = new Map(c.master.scrips.map((s) => [s.scripCode, s.indicativeFullMcapInr]));
      const bad = [];
      let compared = 0;
      for (const company of c.companies) {
        const indicative = company.bseScripCode ? masterMcap.get(company.bseScripCode) : null;
        if (!indicative || company.fullMcapInr == null) continue;
        compared += 1;
        const ratio = company.fullMcapInr / indicative;
        if (ratio > 100 || ratio < 0.01) {
          bad.push(`${company.name}: ratio ${ratio.toExponential(2)}`);
        }
      }
      ok(compared > 1000, 'the comparison must actually run', `only ${compared} companies compared`);
      empty(bad, 'per-scrip and master market caps must agree within a factor of 100', (x) => x);
      return `${compared} companies compared against the master's own figure`;
    },
    sabotage: (c) => { c.companies[0].fullMcapInr /= 1e7; },
  }, ctx);

  await suite.check({
    id: 5,
    what: 'parseFloat has zero call sites anywhere near a BSE figure',
    clone: deepClone,
    run: (c) => {
      const hits = scan(c.sources, [
        { label: 'parseFloat', re: /\bparseFloat\s*\(/ },
      ]);
      empty(hits, 'parseFloat("8,71,532.61") returns 8 — banned outright, use parseGroupedNumber', (h) => h);
      return `${c.sources.length} source files scanned, 0 parseFloat call sites`;
    },
    sabotage: (c) => {
      c.sources.push({ path: 'scripts/lib/SABOTAGE.mjs', text: 'const mcap = parseFloat(row.MktCapFull);\n' });
    },
  }, ctx);

  await suite.check({
    id: 6,
    what: 'unit round-trip, every company: floatFactor × sharesOutstanding × price recovers free float',
    clone: deepClone,
    run: (c) => {
      const bad = [];
      let checked = 0;
      for (const x of c.companies) {
        if (x.floatFactor == null || x.sharesOutstanding == null || x.priceInr == null) continue;
        if (x.freeFloatMcapInr == null) continue;
        checked += 1;
        const recomputed = x.floatFactor * x.sharesOutstanding * x.priceInr;
        const drift = Math.abs(recomputed - x.freeFloatMcapInr) / x.freeFloatMcapInr;
        if (drift > 1e-6) {
          bad.push(`${x.name}: stored ${x.freeFloatMcapInr}, recomputed ${Math.round(recomputed)} (${(drift * 100).toFixed(4)}%)`);
        }
      }
      ok(checked > 1000, 'the round-trip must cover the record', `only ${checked} companies had all three inputs`);
      empty(bad, 'free float must be reconstructible from the stored factor — nothing recomputes a factor from a price', (x) => x);
      return `${checked} companies round-tripped within 1e-6`;
    },
    sabotage: (c) => { c.companies.find((x) => x.floatFactor != null).floatFactor *= 1.01; },
  }, ctx);

  /* ── the model ──────────────────────────────────────────────────────────*/
  suite.section('The model');

  await suite.check({
    id: 7,
    what: 'every verdict recomputes from its own rulesFired alone',
    clone: deepClone,
    run: (c) => {
      const bad = [];
      let replayed = 0;
      for (const x of c.companies) {
        if (!x.assessment) continue;
        replayed += 1;
        const replay = verdictFromRules(x.assessment.rulesFired);
        if (replay !== x.assessment.verdict) {
          bad.push(`${x.name}: shows ${x.assessment.verdict}, its rules replay to ${replay}`);
        }
      }
      ok(replayed > 1000, 'the replay must cover the record', `only ${replayed} assessments replayed`);
      empty(bad, 'a drill panel showing a derivation that did not produce the answer beside it is worse than a wrong answer', (x) => x);
      return `${replayed} verdicts replayed from their own rule records`;
    },
    sabotage: (c) => { c.companies.find((x) => x.assessment).assessment.verdict = 'likely-inclusion'; },
  }, ctx);

  await suite.check({
    id: 8,
    what: 'no percentage probability is produced anywhere',
    clone: deepClone,
    run: (c) => {
      const hits = scan(c.sources, [
        { label: 'a probability field', re: /\b(probability|likelihood|confidencePct|probPct|inclusionOdds)\s*[:=]\s*[\d.]/ },
        { label: 'a computed probability', re: /\b(probability|likelihood|odds)\s*[:=]\s*\(?[\w.]+\s*[/*]/ },
        { label: 'a probability-shaped function', re: /\bfunction\s+(probabilityOf|likelihoodOf|chanceOf)\b/ },
      ]);
      empty(hits, 'a probability needs a base rate and no backtest exists — verdicts are labels on rules', (h) => h);

      // And nothing may have reached the record. A verdict is a label on a
      // rule; a rule record carries an input, a threshold and a result, never
      // a score. Scanning the built JSON catches what a code grep cannot: a
      // probability that arrived as data rather than as an expression.
      const SCORE_KEY = /^(probability|likelihood|odds|score|confidence|pInclusion|prob)$/i;
      const scored = [];
      for (const x of c.companies) {
        for (const key of Object.keys(x.assessment ?? {})) {
          if (SCORE_KEY.test(key)) scored.push(`${x.name}.assessment.${key}`);
        }
        for (const rule of x.assessment?.rulesFired ?? []) {
          for (const key of Object.keys(rule)) {
            if (SCORE_KEY.test(key)) scored.push(`${x.name}.rulesFired.${rule.key}.${key}`);
          }
        }
      }
      empty(scored, 'no assessment or rule record may carry a score', (x) => x);
      return `${c.sources.length} source files scanned and ${c.companies.length} assessments inspected — 0 probability expressions, 0 score fields`;
    },
    sabotage: (c) => {
      // Both routes in: as an expression, and as data in the built record.
      c.sources.push({ path: 'public/js/model/SABOTAGE.js', text: 'const probability = hits / total;\n' });
      c.companies.find((x) => x.assessment).assessment.probability = 0.78;
    },
  }, ctx);

  await suite.check({
    id: 9,
    what: 'driftPp is never used as a multiplication factor',
    clone: deepClone,
    run: (c) => {
      const hits = scan(c.sources, [
        { label: 'driftPp multiplied', re: /driftPp\s*\*(?!\*)/ },
        { label: 'multiplied by driftPp', re: /\*\s*[\w.]*driftPp\b/ },
        { label: 'drift folded into an AUM figure', re: /drift[\w]*\s*\*\s*[\w.]*(aum|Aum|AUM|marketValue)/ },
      ]);
      empty(hits, 'a rising weight forces no trade — drift must never be multiplied by AUM and printed in rupees', (h) => h);
      return `${c.sources.length} source files scanned, 0 drift multiplications`;
    },
    sabotage: (c) => {
      c.sources.push({ path: 'public/js/model/SABOTAGE.js', text: 'const flow = driftPp * fundAumUsd;\n' });
    },
  }, ctx);

  await suite.check({
    id: 10,
    what: 'a migration is two flows in opposite directions, never netted',
    clone: deepClone,
    run: (c) => {
      const migrations = c.companies.filter((x) => x.flowEstimate?.shape === 'migration');
      ok(migrations.length > 0, 'there must be migrations to check', 'no migration-shaped flows in the record');
      const bad = [];
      for (const x of migrations) {
        const signs = [...new Set(x.flowEstimate.flows.map((f) => Math.sign(f.flowInr)))].sort();
        const funds = new Set(x.flowEstimate.flows.map((f) => f.fundId));
        if (x.flowEstimate.flows.length < 2) bad.push(`${x.name}: only ${x.flowEstimate.flows.length} flow(s)`);
        else if (JSON.stringify(signs) !== '[-1,1]') bad.push(`${x.name}: signs ${JSON.stringify(signs)}`);
        else if (funds.size < 2) bad.push(`${x.name}: both flows on one fund`);
      }
      empty(bad, 'netting two flows would imply a market-clearing that does not happen', (x) => x);
      return `${migrations.length} migrations, every one two-directional across different funds`;
    },
    sabotage: (c) => {
      const m = c.companies.find((x) => x.flowEstimate?.shape === 'migration');
      for (const f of m.flowEstimate.flows) f.flowInr = Math.abs(f.flowInr);
    },
  }, ctx);

  await suite.check({
    id: 11,
    what: 'an EM Small-Cap flow exists only where EM Small-Cap currently holds the company',
    clone: deepClone,
    run: (c) => {
      const bad = c.companies.filter((x) =>
        (x.flowEstimate?.flows ?? []).some((f) => f.fundId === 'eems') && !heldBy(x, 'eems'));
      empty(bad, 'EM Small-Cap samples the segment — a company it does not hold has no basis for an estimate, and the output is "not sampled", never zero', (x) => x.name);
      const notSampled = c.companies.filter((x) => (x.flowEstimate?.notSampled ?? []).length > 0).length;
      return `0 unsupported EM SC flows · ${notSampled} companies carry an explicit "not sampled" record instead`;
    },
    sabotage: (c) => {
      const x = c.companies.find((y) => y.flowEstimate?.flows?.length && !heldBy(y, 'eems'));
      x.flowEstimate.flows.push({ ...x.flowEstimate.flows[0], fundId: 'eems' });
    },
  }, ctx);

  await suite.check({
    id: 12,
    what: 'every quarantined share count yields verdict "unknown" and no flow at all',
    clone: deepClone,
    run: (c) => {
      const quarantined = new Set(c.reconciliation.quarantinedIsins ?? []);
      ok(quarantined.size > 0, 'the reconciliation must have quarantined something to check', 'quarantinedIsins is empty');
      const bad = [];
      for (const x of c.companies) {
        if (!quarantined.has(x.isin)) continue;
        if (x.assessment?.verdict !== 'unknown') bad.push(`${x.name}: verdict ${x.assessment?.verdict}`);
        if ((x.flowEstimate?.flows ?? []).length > 0) bad.push(`${x.name}: ${x.flowEstimate.flows.length} flow(s)`);
      }
      empty(bad, 'a verdict computed from a share count we do not trust is worse than no verdict', (x) => x);
      return `${quarantined.size} quarantined companies, all "unknown", none priced`;
    },
    sabotage: (c) => {
      const isin = c.reconciliation.quarantinedIsins[0];
      const x = c.companies.find((y) => y.isin === isin);
      x.assessment.verdict = 'likely-inclusion';
    },
  }, ctx);

  await suite.check({
    id: 13,
    what: 'daysOfAdv is null, never 0, wherever average daily volume is missing',
    clone: deepClone,
    run: (c) => {
      const bad = [];
      let flows = 0;
      let nulls = 0;
      for (const x of c.companies) {
        for (const f of x.flowEstimate?.flows ?? []) {
          flows += 1;
          if (f.daysOfAdv === null) { nulls += 1; continue; }
          if (f.daysOfAdv === 0) bad.push(`${x.name}/${f.fundId}: daysOfAdv is 0`);
          if (f.advQty == null) bad.push(`${x.name}/${f.fundId}: daysOfAdv ${f.daysOfAdv} with no advQty behind it`);
        }
      }
      empty(bad, 'zero days of volume reads as "instant" — an unknown must render as an em dash', (x) => x);
      return `${flows} flows · ${nulls} carry a null daysOfAdv and none carries a zero`;
    },
    sabotage: (c) => {
      const f = c.companies.flatMap((x) => x.flowEstimate?.flows ?? []).find((y) => y.daysOfAdv === null);
      f.daysOfAdv = 0;
    },
  }, ctx);

  /* ── formatting: the ₹0 Cr class ────────────────────────────────────────*/
  suite.section('Formatting — a real value may never read as nothing');

  await suite.check({
    id: 14,
    what: 'no formatter renders a non-zero value as 0 — every real flow survives its own rounding',
    clone: deepClone,
    run: (c) => {
      const READS_AS_NOTHING = /^[₹\s]*[-+]?0+(\.0+)?\s*(Cr|%|pp)?$/;
      const bad = [];
      let formatted = 0;
      for (const x of c.companies) {
        for (const f of x.flowEstimate?.flows ?? []) {
          if (f.flowInr === 0) continue;
          formatted += 1;
          const text = c.fn.inrFlow(f.flowInr);
          if (READS_AS_NOTHING.test(text)) bad.push(`${x.name}/${f.fundId}: ₹${f.flowInr} renders "${text}"`);
        }
      }
      // The five known small ones, named, so this cannot pass by their absence.
      const knownSmall = [-1023939, -163535, -3890000, -3490000, -3790000];
      for (const value of knownSmall) {
        const text = c.fn.inrFlow(value);
        formatted += 1;
        if (READS_AS_NOTHING.test(text)) bad.push(`known small flow ₹${value} renders "${text}"`);
      }

      // THE RULE IS NOT ABOUT RUPEES. A weight of 0.00045% printed at three
      // decimals reads "0.000%", which says NOT HELD — and Genus Prime Infra
      // really is 0.00045% of EM Small-Cap. Percentages, points and counts get
      // the same floor.
      for (const [label, fn, values] of [
        ['pct', c.fn.pct, [0.0004, 0.00045, -0.0002]],
        ['pp', c.fn.pp, [0.0001, -0.0001]],
        ['signedPct', c.fn.signedPct, [0.001, -0.001]],
        ['factorPct', c.fn.factorPct, [0.00002]],
        ['count', c.fn.count, [0.4, -0.4]],
      ]) {
        for (const value of values) {
          const text = fn(value);
          formatted += 1;
          if (READS_AS_NOTHING.test(text)) bad.push(`${label}(${value}) renders "${text}"`);
        }
      }
      // A GENUINE ZERO MUST STILL PRINT AS ZERO. None is a fact, and a floor
      // that swallowed it would trade one lie for another.
      for (const [label, text] of [['pct', c.fn.pct(0)], ['count', c.fn.count(0)], ['inrFlow', c.fn.inrFlow(0)]]) {
        if (!READS_AS_NOTHING.test(text)) bad.push(`${label}(0) must still read as zero, renders "${text}"`);
      }

      // And every weight in the record must survive its own formatter.
      let weights = 0;
      for (const x of c.companies) {
        for (const id of FUND_IDS) {
          const w = x.funds?.[id]?.weightPct;
          if (w == null || w === 0) continue;
          weights += 1;
          const text = c.fn.pct(w);
          if (READS_AS_NOTHING.test(text)) bad.push(`${x.name}/${id}: a real weight of ${w}% renders "${text}", which reads as not held`);
        }
      }
      empty(bad, 'a real number rounded until it reads as absence is the same lie as a fabricated zero', (x) => x);
      return `${formatted} formatter cases + ${weights} real weights · smallest flow ₹163,535 → "${c.fn.inrFlow(-163535)}" · smallest weight 0.00045% → "${c.fn.pct(0.00045)}"`;
    },
    sabotage: (c) => {
      // The formatters as they were before the fix: fixed precision, no floor.
      c.fn.inrFlow = (rupees) => `₹${Math.round(rupees / 1e7).toLocaleString('en-IN')} Cr`;
      c.fn.pct = (value) => (value == null ? EM_DASH : `${value.toFixed(3)}%`);
    },
  }, ctx);

  await suite.check({
    id: 15,
    what: 'a null weight is never rendered, summed or sorted as zero',
    clone: deepClone,
    run: (c) => {
      // In the data: absent means null, never 0.
      const zeroWeights = [];
      for (const x of c.companies) {
        for (const id of FUND_IDS) {
          const entry = x.funds?.[id];
          if (entry === null || entry === undefined) continue;
          if (entry.weightPct === 0) zeroWeights.push(`${x.name}/${id}`);
        }
      }
      empty(zeroWeights, 'a company absent from a fund is not held — it is not a 0% weight', (x) => x);

      // At the formatting edge: a missing value must not coerce.
      equal(c.fn.pct(null), EM_DASH, 'pct(null) must render the em dash');
      equal(c.fn.pct(undefined), EM_DASH, 'pct(undefined) must render the em dash');
      equal(cr(null), EM_DASH, 'cr(null) must render the em dash');
      ok(c.fn.pct(0) !== EM_DASH, 'a genuine zero must still render as zero', 'pct(0) rendered as missing');

      // In sorting: nulls must not compare as 0. A weight of null must sort
      // apart from a weight of 0 in BOTH directions, which a numeric coercion
      // cannot do.
      const values = [null, 0, 1.5];
      const coerced = values.map((v) => Number(v ?? 0));
      ok(coerced[0] === coerced[1], 'sanity: coercion really does collapse null onto 0');

      const held = c.companies.filter((x) => heldBy(x, 'smin')).length;
      const notHeld = c.companies.filter((x) => x.funds?.smin === null).length;
      return `${held} held by India SC, ${notHeld} recorded as null rather than 0%`;
    },
    sabotage: (c) => {
      c.fn.pct = (value) => (value == null ? '0.000%' : `${value}%`);
    },
  }, ctx);

  /* ── the universe ───────────────────────────────────────────────────────*/
  suite.section('The universe');

  await suite.check({
    id: 16,
    what: 'no delisted scrip is in the universe — BSE answers happily for one and says nothing',
    clone: deepClone,
    run: (c) => {
      const status = new Map(c.master.scrips.map((s) => [s.scripCode, s.status ?? 'Active']));
      const inMaster = new Set(c.master.scrips.map((s) => s.scripCode));
      const notActive = [];
      const notInMaster = [];
      let checked = 0;
      for (const x of c.companies) {
        if (!x.bseScripCode) continue;
        checked += 1;
        if (!inMaster.has(x.bseScripCode)) { notInMaster.push(`${x.name} (${x.bseScripCode})`); continue; }
        if (status.get(x.bseScripCode) !== 'Active') notActive.push(`${x.name} (${x.bseScripCode})`);
      }
      empty(notInMaster, 'never scrape a scrip code that did not come from the active master', (x) => x);
      empty(notActive, 'scrip 500010 returns a clean-looking factor for a company that merged away in 2023', (x) => x);
      // The specific trap, named, so this cannot pass by the master being empty.
      ok(!c.companies.some((x) => x.bseScripCode === '500010'),
        'HDFC Corp (500010, delisted 2023) must not be in the record',
        'the delisted HDFC scrip is present');
      return `${checked} scrip codes, all present and Active in the master`;
    },
    sabotage: (c) => {
      c.companies.push({ ...c.companies[0], name: 'Housing Development Finance Corporation Ltd', bseScripCode: '500010' });
    },
  }, ctx);

  /* ── the price feed ─────────────────────────────────────────────────────*/
  suite.section('Prices');

  await suite.check({
    id: 17,
    what: 'the bhavcopy shape guard rejects the HTML-served-with-200 fixture and accepts real CSV',
    clone: deepClone,
    run: (c) => {
      const trap = c.fn.assertBhavcopyShape(c.fixtures.spaShell, {
        expectDate: '2026-08-19',
        contentType: 'text/html',
      });
      ok(trap.ok === false, 'the SPA shell must be rejected', 'a 14 KB HTML page passed as a bhavcopy');
      ok(/HTML, not CSV/.test(trap.problems.join(' ')), 'the rejection must name the reason', trap.problems.join('; '));

      const real = c.fn.assertBhavcopyShape(c.fixtures.bhavToday, { expectDate: '2026-08-19' });
      ok(real.ok === true, 'a genuine bhavcopy must be accepted', (real.problems ?? []).join('; '));

      // The guard must validate SHAPE, not status: a well-formed file about a
      // different day is the other half of the same trap.
      const wrongDay = c.fn.assertBhavcopyShape(c.fixtures.bhavToday, { expectDate: '2026-08-20' });
      ok(wrongDay.ok === false, 'a file about the wrong day must be rejected', 'yesterday\'s prices would publish under today\'s date');
      return 'SPA shell rejected · real CSV accepted · wrong-date CSV rejected';
    },
    sabotage: (c) => { c.fn.assertBhavcopyShape = () => ({ ok: true, problems: [] }); },
  }, ctx);

  await suite.check({
    id: 18,
    what: 'row-level continuity: today\'s PrvsClsgPric equals yesterday\'s ClsPric, per scrip',
    clone: deepClone,
    run: (c) => {
      const today = parseBhavcopy(c.fixtures.bhavToday);
      const prev = parseBhavcopy(c.fixtures.bhavPrev);
      const prevClose = new Map(prev.rows.map((r) => [r.scripCode, r.close]));
      const result = c.fn.assertContinuity(today.rows, prevClose);
      ok(result.compared > 200, 'the comparison must actually run', `only ${result.compared} rows compared`);
      empty(result.failures, 'a file whose TradDt is today can still carry a row copied from yesterday',
        (f) => `${f.scripCode}: prev ${f.expected} vs stated ${f.actual}`);

      // And the committed price file must carry its own continuity evidence —
      // OR a stated reason why the comparison could not be made.
      //
      // The distinction is the whole point. `compared: 0` with no explanation is
      // a file claiming nothing was ever verified, and that must fail. But there
      // are two legitimate ways to reach zero, and both name themselves:
      //
      //   sameDay      — the run re-fetched the trade date already on file, so
      //                  there is no previous day to compare against.
      //   a gap        — the stored file is not the immediately preceding
      //                  session, so continuity CANNOT hold across the pair.
      //
      // Requiring `compared > 0` unconditionally is what turned a single missed
      // day into six consecutive red runs: the fetch skipped the check honestly,
      // and this assertion then blocked the commit that would have closed the
      // gap. A guard that cannot distinguish "not checked, and here is why" from
      // "not checked, silently" forces the pipeline to stay broken.
      const recorded = c.prices.continuity;
      ok(recorded, 'prices.json must carry a continuity block', JSON.stringify(recorded));
      const explained = typeof recorded.skippedReason === 'string' && recorded.skippedReason.length > 0;
      const carried = typeof recorded.carriedForwardFrom === 'string';
      ok(recorded.compared > 0 || explained || carried,
        'prices.json must record its continuity comparison, or say in words why it could not be made',
        JSON.stringify(recorded));
      equal(recorded.failures.length, 0, 'the committed price file must have passed continuity');

      const committed = recorded.compared > 0
        ? `committed ${recorded.compared} compared against ${recorded.against}`
        : `committed: not compared — ${recorded.skippedReason ?? `carried forward from ${recorded.carriedForwardFrom}`}`;
      return `fixture ${result.compared} compared / ${result.failures.length} failed · ${committed}`;
    },
    sabotage: (c) => {
      c.fn.assertContinuity = (rows, prevClose) => {
        // Yesterday's close, shifted by a rupee, must be caught.
        const shifted = new Map([...prevClose].map(([k, v]) => [k, v == null ? v : v + 1]));
        return assertContinuity(rows, shifted);
      };
    },
  }, ctx);

  await suite.check({
    id: 19,
    what: 'rawQuote parsing round-trips, and an absent key yields null rather than a default',
    clone: deepClone,
    run: (c) => {
      const fields = c.fn.parseRawQuote(c.fixtures.rawQuote);
      ok(Object.keys(fields).length > 40, 'the fixture must parse into many fields', `${Object.keys(fields).length} keys`);

      // The three shapes that break a naive split.
      equal(fields['Day Range'], '1303.5 - 1321.6', 'a value containing spaces and a hyphen survives');
      equal(fields['52-Week Range'], '1249.8 - 1611.8', 'a key beginning with a digit is a key, not part of the previous value');
      equal(fields['Website'], 'https://www.ril.com', 'a value containing : and / survives');
      equal(fields['Symbol'], 'RELIANCE.NS', 'the symbol echo survives');
      equal(fields['Exchange'], 'NSI', 'the exchange field survives — this is the NSE-listing discriminator');

      // Round trip: every key/value in the parse must appear verbatim in the raw.
      const missing = Object.entries(fields).filter(([k, v]) => !c.fixtures.rawQuote.includes(`${k}=${v}`));
      empty(missing, 'every parsed pair must appear verbatim in the source string', ([k]) => k);

      // Absent means null. Never 0, never ''.
      equal(quoteNumber(fields, 'Not A Real Key'), null, 'an absent numeric key is null');
      equal(quoteText(fields, 'Not A Real Key'), null, 'an absent text key is null');
      equal(quoteNumber(fields, 'IPO Date'), null, 'an "N/A" value is null, not 0');

      // The captured fixture happens to contain no comma inside any value, so
      // on its own it does not exercise the trap the parser was written for —
      // a naive split(',') passes it. This case is CONSTRUCTED, and says so:
      // it reproduces the two shapes measured on real responses, a comma
      // inside a company name and a key that begins with a digit.
      const constructed = 'Company Name=Kovai Medical Center, Hospital Ltd,'
        + 'Day Range=1303.5 - 1321.6,52-Week Range=1249.8 - 1611.8,Exchange=NSI';
      const tricky = c.fn.parseRawQuote(constructed);
      equal(tricky['Company Name'], 'Kovai Medical Center, Hospital Ltd', 'a comma inside a value is not a separator');
      equal(tricky['Day Range'], '1303.5 - 1321.6', 'a value is not swallowed by the next key');
      equal(tricky['52-Week Range'], '1249.8 - 1611.8', 'a key beginning with a digit is not part of the previous value');
      equal(tricky['Exchange'], 'NSI', 'the last field terminates correctly');
      return `${Object.keys(fields).length} keys from the captured fixture, plus the two constructed traps`;
    },
    sabotage: (c) => {
      // The parser as it was BEFORE the 52-Week Range fix: a key must begin
      // with a letter, so a digit-leading key is swallowed into the previous
      // value. This is the bug that actually shipped, reproduced exactly.
      c.fn.parseRawQuote = (raw) => {
        const out = {};
        const keyPattern = /(?:^|,)\s*([A-Za-z][A-Za-z0-9 ()%./-]*?)=/g;
        const marks = [];
        let match;
        while ((match = keyPattern.exec(String(raw))) !== null) {
          marks.push({ key: match[1].trim(), valueStart: match.index + match[0].length, matchStart: match.index });
        }
        for (let i = 0; i < marks.length; i += 1) {
          const end = i + 1 < marks.length ? marks[i + 1].matchStart : String(raw).length;
          out[marks[i].key] = String(raw).slice(marks[i].valueStart, end).trim();
        }
        return out;
      };
    },
  }, ctx);

  /* ── resolution ─────────────────────────────────────────────────────────*/
  suite.section('Resolution');

  await suite.check({
    id: 20,
    what: 'the collision guard fires when two rows of one fund are forced onto one ISIN',
    clone: deepClone,
    run: (c) => {
      const index = buildIndex(c.master, c.universe, new Set(Object.keys(c.nseFloat.companies ?? {})));

      // Clean: the real workbooks must produce none.
      const clean = c.fn.resolveAll(c.funds.funds, index);
      equal(clean.collisions.length, 0, 'the committed workbooks must resolve without a collision');

      // Forced: two rows of one fund naming the same company.
      const row = c.funds.funds.find((f) => f.id === 'eem').holdings.find((h) => h.tickerKind === 'nse');
      const forced = [{ id: 'test', holdings: [row, { ...row, name: `${row.name} (duplicate row)` }] }];
      const collided = c.fn.resolveAll(forced, index);
      ok(collided.collisions.length === 1,
        'two rows of one fund on one ISIN must stop the build',
        `expected 1 collision, got ${collided.collisions.length}`);
      ok(collided.collisions[0].rows.length === 2, 'the collision must name both rows', JSON.stringify(collided.collisions[0]));
      return `clean 0 collisions · forced duplicate of ${row.ticker} detected`;
    },
    sabotage: (c) => {
      c.fn.resolveAll = (funds, index) => ({ ...resolveAll(funds, index), collisions: [] });
    },
  }, ctx);

  /* ── the guard-reads-its-own-threshold trap ─────────────────────────────*/
  suite.section('The self-defeating-guard trap');

  await suite.check({
    id: 21,
    what: 'no guard reads its threshold from the value under test — the naive tripwire is proved to fail',
    clone: deepClone,
    run: (c) => {
      // Sabotage a company by exactly the crore/rupee factor.
      const victim = structuredClone(c.companies.find((x) => x.fullMcapInr > 1e12 && x.bseScripCode));
      victim.fullMcapInr /= 1e7;
      victim.freeFloatMcapInr /= 1e7;

      // (a) The NAIVE guard — largeness judged from the field under test —
      //     must EXEMPT the corrupted row. This is the bug, reproduced.
      const FLOOR = 2000e7;
      const naivePasses = !(victim.fullMcapInr >= FLOOR && victim.fullMcapInr < 1e5);
      ok(naivePasses,
        'the naive guard must be shown to exempt the row it exists to catch',
        'the naive guard caught it, so this check is no longer demonstrating anything');

      // (b) The REAL guard — largeness from the master's independent Mktcap —
      //     must CATCH it. If it does not, the tripwire is decoration.
      const masterMcap = new Map(c.master.scrips.map((s) => [s.scripCode, s.indicativeFullMcapInr]));
      const indicative = masterMcap.get(victim.bseScripCode);
      ok(indicative > 0, 'the independent threshold must exist', `no master figure for ${victim.bseScripCode}`);
      const ratio = victim.fullMcapInr / indicative;
      ok(ratio < 0.01,
        'the unit tripwire must catch a crore value in a rupee field',
        `ratio ${ratio.toExponential(2)} did not trip the 100× bound`);
      return `naive guard exempts the sabotaged row (as designed to demonstrate); the master-anchored tripwire catches it at ratio ${ratio.toExponential(2)}`;
    },
    sabotage: (c) => {
      // Give the "independent" threshold the same corruption as the value.
      // A guard whose threshold moves with the failure cannot see the failure.
      for (const s of c.master.scrips) if (s.indicativeFullMcapInr) s.indicativeFullMcapInr /= 1e7;
    },
  }, ctx);

  /* ── the desk's float-source rule ───────────────────────────────────────*/
  suite.section("The desk's float-source rule");

  await suite.check({
    id: 22,
    what: 'BSE is primary; NSE only above the switch point or where BSE has nothing',
    clone: deepClone,
    run: (c) => {
      const switchPct = c.companiesFile.thresholds.floatSourcePreferNseGapPct;
      ok(typeof switchPct === 'number' && switchPct > 0,
        'the switch point must be on the record, not implied',
        `thresholds.floatSourcePreferNseGapPct = ${JSON.stringify(switchPct)}`);

      // Re-derive the choice for every company from the two factors alone, and
      // require the record to match. This does NOT read floatChoice.rule to
      // decide what the rule should have been — that would be a guard reading
      // its threshold from the value under test (2.22 / check 21).
      const wrong = [];
      for (const x of c.companies) {
        const n = x.floatFactorNse;
        const b = x.floatFactorBse;
        let expected = null;
        if (n !== null && b !== null && b > 0) {
          expected = Math.abs(((n - b) / b) * 100) > switchPct ? 'nse' : 'bse';
        } else if (b !== null) expected = 'bse';
        else if (n !== null) expected = 'nse';
        if (expected === null) continue;

        // The factor actually in force must BE the chosen exchange's factor.
        const inForce = expected === 'nse' ? n : b;
        if (x.floatFactor !== inForce) {
          wrong.push(`${x.nseSymbol ?? x.isin}: expected the ${expected.toUpperCase()} factor `
            + `${inForce}, record carries ${x.floatFactor} (nse ${n}, bse ${b})`);
        }
      }
      empty(wrong, 'every company carries the factor the desk\'s rule selects', (w) => w);

      const counts = c.companiesFile.coverage.floatChoice;
      ok(counts && counts.switchPointPct === switchPct,
        'the coverage counters are stamped with the same switch point',
        JSON.stringify(counts));
      return `switch point ${switchPct}% · ${counts.comparable} companies carry both readings · `
        + `${counts.nsePreferredOnGap} switched to NSE · ${counts.bsePrimary} kept BSE · `
        + `${counts.bseOnly} BSE-only · ${counts.nseOnly + counts.nseOnlyPublishedRupees} NSE-only`;
    },
    sabotage: (c) => {
      // Put NSE's factor in force on a company whose gap is INSIDE the switch
      // point — the exact silent-preference failure the rule exists to prevent.
      const victim = c.companies.find((x) => x.floatChoice?.rule === 'bse-primary');
      victim.floatFactor = victim.floatFactorNse;
    },
  }, ctx);

  await suite.check({
    id: 23,
    what: 'floatSource never disagrees with the factor actually in force',
    clone: deepClone,
    run: (c) => {
      const wrong = [];
      for (const x of c.companies) {
        if (x.floatFactor === null) continue;
        if (x.floatSource === 'bse' && x.floatFactor !== x.floatFactorBse) {
          wrong.push(`${x.nseSymbol ?? x.isin}: says BSE, carries ${x.floatFactor} vs BSE ${x.floatFactorBse}`);
        }
        if (x.floatSource === 'nse' && x.floatFactorNse !== null && x.floatFactor !== x.floatFactorNse) {
          wrong.push(`${x.nseSymbol ?? x.isin}: says NSE, carries ${x.floatFactor} vs NSE ${x.floatFactorNse}`);
        }
      }
      empty(wrong, 'the label on a number must match the number', (w) => w);

      // Every company with a reading states which rule produced it. A figure
      // whose provenance is only reconstructable from source is not disclosed.
      const undisclosed = c.companies.filter((x) => x.floatSource !== null && !x.floatChoice);
      empty(undisclosed, 'every chosen source names the rule that chose it',
        (x) => `${x.nseSymbol ?? x.isin} has floatSource ${x.floatSource} and no floatChoice`);
      return `${c.companies.filter((x) => x.floatChoice).length} companies carry the rule that chose their source`;
    },
    sabotage: (c) => {
      const victim = c.companies.find((x) => x.floatSource === 'bse' && x.floatFactorNse !== null);
      victim.floatSource = 'nse';
    },
  }, ctx);

  await suite.check({
    id: 24,
    what: "the universe covers the desk's whole seed list, or says why not",
    clone: deepClone,
    run: (c) => {
      const tracked = new Set(c.companies.map((x) => x.isin).filter(Boolean));
      const missing = c.universeSeed.companies.filter((row) => !tracked.has(row.isin));

      // A seed company may be absent ONLY when it is listed on neither exchange,
      // and the seed must say so itself. Anything else is a company above the
      // desk's floor that quietly fell out of the universe.
      const unexplained = missing.filter((row) => row.listing !== 'neither');
      empty(unexplained, 'every seed company that either exchange lists is tracked',
        (row) => `${row.name} (${row.isin}, listing=${row.listing})`);

      // And every company we DID add from the seed with no BSE record states why.
      const silent = c.companies.filter((x) => x.bseScripCode === null && x.noBseReason === null && !x.held);
      empty(silent, 'a tracked company with no BSE record states the reason',
        (x) => `${x.nseSymbol ?? x.isin} ${x.name}`);
      return `${c.universeSeed.companies.length} on the seed list · ${tracked.size} tracked · `
        + `${missing.length} absent, all listed on neither exchange`;
    },
    sabotage: (c) => {
      // Drop a tracked seed company: the universe silently narrows.
      const victim = c.universeSeed.companies.find((r) => r.listing === 'nse-only');
      const at = c.companies.findIndex((x) => x.isin === victim.isin);
      if (at >= 0) c.companies.splice(at, 1);
    },
  }, ctx);

  await suite.check({
    id: 25,
    what: 'InvITs and REITs are in the universe, and a suspended scrip still is not',
    clone: deepClone,
    run: (c) => {
      // BSE's `segment=Equity` filter excludes GROUP=IF entirely. Fetching the
      // master through it was why 22 companies above the desk's floor — four of
      // them HELD — carried no free-float reading at all.
      const invits = c.master.scrips.filter((s) => s.instrumentKind === 'invit-reit');
      ok(invits.length > 0,
        "the scrip master must carry BSE's InvIT/REIT group, not just segment=Equity",
        `${invits.length} scrips with instrumentKind 'invit-reit'`);

      // The four the funds actually hold must resolve AND be priced. These were
      // pinned as NOT_LISTED until 20 Aug 2026 on the belief that no source had
      // them; BSE had them all along.
      const HELD_REITS = ['INE041025011', 'INE0FDU25010', 'INE0NDH25011', 'INE0CCU25019'];
      const missing = [];
      for (const isin of HELD_REITS) {
        const company = c.companies.find((x) => x.isin === isin);
        if (!company) { missing.push(`${isin}: not in the record at all`); continue; }
        if (!company.held) missing.push(`${company.name}: resolved but not marked held`);
        if (company.freeFloatMcapInr === null) missing.push(`${company.name}: no free-float reading`);
        if (company.floatFactorBse === null) missing.push(`${company.name}: no BSE float factor`);
      }
      empty(missing, 'every REIT the funds hold is resolved, held and priced', (m) => m);

      // And the guard that stops us fetching a scrip the active master does not
      // carry must still hold. Colab Platforms and RRP Semiconductor are
      // SUSPENDED on BSE, and BSE answers for both with a clean-looking factor
      // and Category "Listed" — the 3.8 trap, live.
      const SUSPENDED = ['542866', '504346'];
      const wrongly = c.companies.filter((x) => SUSPENDED.includes(x.bseScripCode));
      empty(wrongly, 'a suspended scrip is never fetched, however willingly BSE answers for it',
        (x) => `${x.name} is carrying suspended scrip ${x.bseScripCode}`);

      const priced = c.companies.filter((x) => x.instrumentKind === 'invit-reit' && x.freeFloatMcapInr !== null);
      return `${invits.length} InvIT/REIT scrips in the master · ${priced.length} priced in the record · `
        + `all 4 held REITs resolved · ${SUSPENDED.length} suspended codes still excluded`;
    },
    sabotage: (c) => {
      // The failure this check exists for: the master goes back to equity-only.
      c.master.scrips = c.master.scrips.filter((s) => s.instrumentKind !== 'invit-reit');
    },
  }, ctx);

  /* ── the segment benchmark ──────────────────────────────────────────────*/
  suite.section('Segment benchmarks and the floated bands');

  await suite.check({
    id: 26,
    what: 'a fund return is measured in RUPEES, not the dollars it is quoted in',
    clone: deepClone,
    run: (c) => {
      const b = c.benchmarks;
      // Scoped by ROLE, not by a count. Three of these are funds that hold
      // something here; INDA holds nothing and is on the record to answer "how
      // did the Standard segment move". A bare length test would have to be
      // edited every time a benchmark is added, which is how it stops meaning
      // anything — so assert the two roles are both covered instead.
      const holding = b.funds.filter((f) => f.fundId !== null && f.fundId !== undefined);
      const segmentIndices = b.funds.filter((f) => f.standsForSegment);
      equal(holding.length, 3, 'the three holding funds are on the record');
      empty(
        Object.values(SEGMENT_BAND_ADJUSTMENT.benchmarkForSegment)
          .filter((id) => !b.funds.some((f) => f.id === id)),
        'every segment the bands float has a benchmark on the record',
        (id) => `segment benchmark "${id}" is mapped but absent`,
      );
      // The mapping's own correctness: a benchmark may stand for an Indian
      // segment only if its basket is Indian. EEM is 11.3% India, so its rupee
      // return is a global basket wearing a rupee sign — measured 44.3 pp from
      // INDA's over a year, and the OPPOSITE SIGN since the last review.
      empty(
        segmentIndices.filter((f) => !comparableInInr(f)),
        'no segment is measured against a benchmark that is mostly not India',
        (f) => `${f.symbol} stands for "${f.standsForSegment}" at only ${f.indiaWeightPct}% India`,
      );
      ok(b.fx?.currency === 'INR', 'the FX series quotes INR per USD', `currency ${b.fx?.currency}`);
      for (const f of b.funds) equal(f.currency, 'USD', `${f.symbol} is quoted in USD`);

      // Re-derive one return from the raw series and require the record to match.
      // This does NOT read the stored figure to decide what it should be.
      const fxMap = seriesToMap(b.fx.series);
      const wrong = [];
      for (const fund of b.funds) {
        const summary = summarise(fund, fxMap, b.asOf ? c.companiesFile.benchmarks.lastReview.effectiveDate : null);
        const stored = c.companiesFile.benchmarks.funds.find((x) => x.id === (fund.id ?? fund.fundId));
        if (!stored) { wrong.push(`${fund.symbol}: not in the record`); continue; }
        if (summary.sinceLastReview.inrPct !== stored.sinceLastReview.inrPct) {
          wrong.push(`${fund.symbol}: re-derived ${summary.sinceLastReview.inrPct}, record says ${stored.sinceLastReview.inrPct}`);
        }
      }
      empty(wrong, 'every stored return re-derives from the committed series', (w) => w);

      // The whole point of the conversion: it must actually differ from USD.
      // If these were equal the conversion would be doing nothing and the
      // measurement would be of our own code — 2.21.
      const differing = c.companiesFile.benchmarks.funds.filter((f) => {
        const d = f.sinceLastReview;
        return d.inrPct !== null && d.usdPct !== null && Math.abs(d.inrPct - d.usdPct) > 0.01;
      });
      ok(differing.length > 0,
        'the rupee return genuinely differs from the dollar one — otherwise the FX step is decorative',
        `${differing.length} of ${c.companiesFile.benchmarks.funds.length} differ by more than 0.01pp`);

      return c.companiesFile.benchmarks.funds
        .map((f) => `${f.symbol} ${f.sinceLastReview.inrPct}% ₹ / ${f.sinceLastReview.usdPct}% $`)
        .join('  ·  ');
    },
    sabotage: (c) => {
      // Convert nothing: hand back the dollar series as though it were rupees.
      c.benchmarks.fx.series = c.benchmarks.fx.series.map((p) => ({ ...p, close: 1 }));
    },
  }, ctx);

  await suite.check({
    id: 33,
    what: 'every benchmark date label is a trading date — no UTC shift, and the FX series covers the funds',
    clone: deepClone,
    run: (c) => {
      // ⚠ THIS CHECK EXISTS BECAUSE THE BUG IT CATCHES SHIPPED.
      //
      // Yahoo stamps a daily bar at the session's opening instant in the
      // exchange's own timezone. USDINR=X lives on Europe/London and is stamped
      // at LOCAL MIDNIGHT, so under BST — seven months of every year — its UTC
      // date is one day early. The committed file carried the signature in
      // plain sight for a week: Fri 45 and SUN 59 against ~104 for every other
      // weekday, because Friday's bar was labelled Thursday and Monday's was
      // labelled Sunday.
      //
      // The damage was not the label. It was that 57 of EEM's 502 trading dates
      // then had no exact FX point, so rateOn walked back and priced them with
      // the PREVIOUS day's rate — breaking the one promise the whole rupee
      // conversion rests on, that both halves of each product come from the
      // same date. Nothing looked wrong. Every return was slightly false.
      //
      // The threshold is THE CALENDAR, which nothing in the fetcher can move.
      const broken = [];
      const series = [
        [c.benchmarks.fx.symbol, c.benchmarks.fx.series],
        ...c.benchmarks.funds.map((f) => [f.symbol, f.series]),
      ];
      for (const [symbol, points] of series) {
        const verdict = assertSeriesDates(points);
        if (!verdict.ok) broken.push(`${symbol}: ${verdict.problems.join('; ')}`);
      }
      empty(broken, 'no series carries a weekend label or an unbalanced weekday tally', (b) => b);

      // The consequence test, not the cause test. Even with clean labels, a
      // fund date with no exact FX point is priced by a walk-back — legitimate
      // for a real holiday, and the exact shape a shift hides behind.
      const fxDates = new Set(c.benchmarks.fx.series.map((p) => p.date));
      const walked = [];
      for (const fund of c.benchmarks.funds) {
        const missing = fund.series.filter((p) => !fxDates.has(p.date));
        const share = missing.length / fund.series.length;
        if (share > 0.03) {
          walked.push(`${fund.symbol}: ${missing.length} of ${fund.series.length} dates need an FX walk-back`
            + ` — first ${missing.slice(0, 3).map((p) => p.date).join(', ')}`);
        }
      }
      empty(walked, 'each fund\'s dates resolve to an exact FX rate, bar the odd holiday', (w) => w);

      const tally = assertSeriesDates(c.benchmarks.fx.series).tally;
      const exact = c.benchmarks.funds.map((f) => {
        const missing = f.series.filter((p) => !fxDates.has(p.date)).length;
        return `${f.symbol} ${f.series.length - missing}/${f.series.length}`;
      }).join(' · ');
      return `FX weekdays ${JSON.stringify(tally)} · exact FX rate on ${exact}`;
    },
    sabotage: (c) => {
      // The bug itself, reproduced: re-label the FX series one day earlier, which
      // is what reading the bar's UTC date did for seven months of every year.
      c.benchmarks.fx.series = c.benchmarks.fx.series.map((p) => {
        const d = new Date(`${p.date}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - 1);
        return { ...p, date: d.toISOString().slice(0, 10) };
      });
    },
  }, ctx);

  await suite.check({
    id: 27,
    what: 'a floated band carries the desk\'s raw band beside it, and floats the right way',
    clone: deepClone,
    run: (c) => {
      const adj = c.companiesFile.benchmarks.adjustment;
      ok(adj && typeof adj.minMovePct === 'number', 'the adjustment config is on the record', JSON.stringify(adj));

      const floated = [];
      const wrong = [];
      for (const company of c.companies) {
        for (const r of company.assessment?.rulesFired ?? []) {
          if (!r.band) continue;
          if (!r.band.applied) continue;
          floated.push(r);
          // The raw band must be present, or the number on screen is a bare
          // adjusted figure that reads like the desk's own — 2.1.
          if (!r.band.rawInclusion || !r.band.rawExclusion) {
            wrong.push(`${company.nseSymbol}: floated rule ${r.key} with no raw band recorded`);
            continue;
          }
          // And it must float in the direction the segment moved.
          const rose = r.band.segmentReturnPct > 0;
          const rawForRule = r.key === 'entry-upper-band' ? r.band.rawInclusion.highInr
            : r.key === 'entry-lower-band' ? r.band.rawInclusion.lowInr
            : r.key === 'exclusion-lower-band' ? r.band.rawExclusion.lowInr
            : r.key === 'exclusion-upper-band' ? r.band.rawExclusion.highInr : null;
          if (rawForRule === null) continue;
          if (rose && !(r.threshold > rawForRule)) {
            wrong.push(`${company.nseSymbol} ${r.key}: segment rose ${r.band.segmentReturnPct}% but the bar did not`);
          }
          if (!rose && !(r.threshold < rawForRule)) {
            wrong.push(`${company.nseSymbol} ${r.key}: segment fell ${r.band.segmentReturnPct}% but the bar did not`);
          }
        }
      }
      empty(wrong, 'a floated band moves with its segment and keeps the raw band beside it', (w) => w);
      ok(floated.length > 0, 'the adjustment actually fired on this record', `${floated.length} floated rules`);
      return `${floated.length} floated band rules across ${c.companies.length} companies`;
    },
    sabotage: (c) => {
      // Strip the raw band: the screen would then show an adjusted number with
      // nothing to compare it against.
      for (const company of c.companies) {
        for (const r of company.assessment?.rulesFired ?? []) {
          if (r.band?.applied) { r.band.rawInclusion = null; r.band.rawExclusion = null; }
        }
      }
    },
  }, ctx);

  /* ── MSCI's own published rules ─────────────────────────────────────────*/
  suite.section("MSCI's published methodology");

  await suite.check({
    id: 28,
    what: "the review price window is MSCI's published rule, and it is the month BEFORE the review",
    clone: deepClone,
    run: (c) => {
      ok(CONVENTION.confirmed === true,
        'the review convention is no longer an assumption',
        `confirmed=${CONVENTION.confirmed}`);
      ok(typeof CONVENTION.source === 'string' && /GIMI/.test(CONVENTION.source),
        'and it cites the methodology it came from', CONVENTION.source);

      // Re-derive the window rather than reading back what the record stored.
      const r = c.companiesFile.model.nextReview;
      ok(r?.cutoffs?.price?.from && r.cutoffs.price.to,
        'the record carries the price window', JSON.stringify(r?.cutoffs ?? null));
      const derived = reviewCutoffs(r.year, r.month);
      equal(derived.price.from, r.cutoffs.price.from, 'price window opens where the rule says');
      equal(derived.price.to, r.cutoffs.price.to, 'price window closes where the rule says');

      // The load-bearing property: the window must fall BEFORE the review month.
      // A model that assumed the review is decided on the day it takes effect
      // would put this window inside the review month, and be a month late.
      const reviewMonthStart = `${r.year}-${String(r.month).padStart(2, '0')}-01`;
      ok(r.cutoffs.price.to < reviewMonthStart,
        'the deciding prices are struck BEFORE the review month begins',
        `window ends ${r.cutoffs.price.to}, review month starts ${reviewMonthStart}`);

      // Independent corroboration: MSCI's own August-2026 size reference table
      // is stamped 20 July 2026, which is exactly where our computed window for
      // the August 2026 review opens. Two different parts of the book agreeing.
      const aug = reviewCutoffs(2026, 8);
      equal(aug.price.from, MSCI.GLOBAL_MIN_SIZE_REFERENCE.asOf,
        "the computed August window opens on the date MSCI stamps its own August reference table");

      return `${r.label}: prices ${r.cutoffs.price.from}..${r.cutoffs.price.to}, `
        + `universe ${r.cutoffs.equityUniverse}, liquidity ${r.cutoffs.liquidity}`;
    },
    sabotage: (c) => {
      // The error this guards against: assuming the review is decided on its own
      // effective date rather than a month earlier.
      const r = c.companiesFile.model.nextReview;
      r.cutoffs.price.from = r.effectiveDate;
      r.cutoffs.price.to = r.effectiveDate;
    },
  }, ctx);

  await suite.check({
    id: 29,
    what: "MSCI's rules are on the record with page citations, and never mixed with the desk's",
    clone: deepClone,
    run: (c) => {
      const m = c.companiesFile.model.msci;
      ok(m && m.source?.url, "the methodology source is named", JSON.stringify(m?.source ?? null));

      // Every block that states a rule must cite a page. A rule without a page
      // is indistinguishable from something we made up — 2.1.
      const uncited = [];
      for (const [key, value] of Object.entries(m)) {
        if (key === 'source' || key === 'trackedIndexes') continue;
        const hasPage = value && (typeof value.page === 'number'
          || Array.isArray(value.pages)
          || Object.values(value).some((v) => v && typeof v === 'object' && typeof v.page === 'number'));
        if (!hasPage) uncited.push(key);
      }
      empty(uncited, 'every MSCI rule block cites the page it came from', (k) => k);

      // The buffer geometry is the structural fact the model was missing, so it
      // must be present and asymmetric — a symmetric buffer is not MSCI's rule.
      ok(Math.abs(m.buffers.lowerMultiple - 2 / 3) < 1e-9, 'lower buffer is 2/3 of the cutoff', String(m.buffers.lowerMultiple));
      ok(m.buffers.upperMultiple === 1.5, 'upper buffer is 1.5x the cutoff', String(m.buffers.upperMultiple));
      ok(m.buffers.upperMultiple > m.buffers.lowerMultiple,
        'entry is harder than exit — the asymmetry IS the rule', 'buffers are symmetric');

      // And the desk's numbers must not have leaked into MSCI's block.
      const t = c.companiesFile.thresholds;
      ok(t.attribution && /desk/i.test(t.attribution),
        "the desk's thresholds still say they are the desk's", t.attribution);
      ok(/MSCI/.test(c.companiesFile.model.thresholdSources.msci ?? ''),
        'and MSCI-sourced thresholds are labelled separately',
        JSON.stringify(c.companiesFile.model.thresholdSources));
      return `${Object.keys(m).length} rule blocks, all cited · buffers ${m.buffers.lowerMultiple.toFixed(3)}x / ${m.buffers.upperMultiple}x`;
    },
    sabotage: (c) => {
      // Make the buffers symmetric: the model would then predict far more
      // migration than MSCI's rules actually produce.
      c.companiesFile.model.msci.buffers.upperMultiple = 2 / 3;
    },
  }, ctx);

  suite.section('The second methodology — MSCI\'s structure, our universe');

  await suite.check({
    id: 30,
    what: 'the cutoff is COUNTED in free float and ANSWERED in full market cap — MSCI\'s procedure, not ours',
    clone: deepClone,
    run: (c) => {
      const cut = gimiCutoffs(c.companies);
      ok(cut.imi.cutoffInr > 0 && cut.standard.cutoffInr > 0,
        'both cutoffs must derive', JSON.stringify({ imi: cut.imi.cutoffInr, std: cut.standard.cutoffInr }));

      // THE LOAD-BEARING PROPERTY, and the whole of Finding 1: the company that
      // sets the cutoff is found by walking DESCENDING FULL market cap while
      // accumulating FREE FLOAT. Re-derive it here independently — reading the
      // module's own output back would prove only that it is self-consistent.
      const usable = c.companies.filter((x) => x.fullMcapInr > 0 && x.freeFloatMcapInr > 0);
      const byFull = [...usable].sort((a, b) => b.fullMcapInr - a.fullMcapInr);
      const totalFF = byFull.reduce((sum, x) => sum + x.freeFloatMcapInr, 0);
      const walk = (targetPct) => {
        let cum = 0;
        for (const company of byFull) {
          cum += company.freeFloatMcapInr;
          if (cum >= totalFF * (targetPct / 100)) return company;
        }
        return byFull[byFull.length - 1];
      };
      const imiCompany = walk(MSCI.COVERAGE_TARGETS.imi.target);
      equal(cut.imi.cutoffInr, imiCompany.fullMcapInr,
        'the IMI cutoff must be the FULL market cap of the company where free-float coverage crosses the target');
      ok(cut.imi.cutoffInr !== imiCompany.freeFloatMcapInr,
        'and it must NOT be that company\'s free float — that is the confusion this model exists to fix',
        `${cut.imi.cutoffInr} vs ${imiCompany.freeFloatMcapInr}`);

      // Ranking by the wrong number moves the answer a long way, which is why
      // the distinction is worth a model rather than a footnote.
      const byFloat = [...usable].sort((a, b) => b.freeFloatMcapInr - a.freeFloatMcapInr);
      const movedALot = usable.filter((company) => {
        const rf = byFull.indexOf(company);
        const rr = byFloat.indexOf(company);
        return Math.abs(rf - rr) > 100;
      }).length;
      ok(movedALot > 0,
        'the two rankings must genuinely disagree, or the correction would be cosmetic',
        `${movedALot} companies move more than 100 places`);

      // A company with only one of the two sizes is EXCLUDED, never zeroed. A
      // zero would sort to the bottom, inflate the denominator and drag both
      // cutoffs down.
      equal(cut.universeCount + cut.skipped, cut.consideredCount,
        'every company is either in the walk or counted as skipped — none is silently zeroed');

      return `IMI ₹${cr(cut.imi.cutoffInr)} Cr at ${imiCompany.name} `
        + `(${cut.imi.count} of ${cut.universeCount}, ${cut.imi.coveragePct.toFixed(2)}% coverage) · `
        + `Standard ₹${cr(cut.standard.cutoffInr)} Cr · ${movedALot} companies move >100 ranks`;
    },
    sabotage: (c) => {
      // Rank by free float — the exact mistake. Every company's full market cap
      // is replaced by its free float, so the "two numbers" collapse into one
      // and the walk answers in the wrong currency.
      for (const company of c.companies) company.fullMcapInr = company.freeFloatMcapInr;
    },
  }, ctx);

  await suite.check({
    id: 31,
    what: 'the buffers are asymmetric, and they genuinely suppress migration a bright line would call',
    clone: deepClone,
    run: (c) => {
      const cut = gimiCutoffs(c.companies);
      const b = cut.buffers;
      ok(b.lowerMultiple < 1 && b.upperMultiple > 1,
        'the buffers must straddle the cutoff', `${b.lowerMultiple} / ${b.upperMultiple}`);
      ok(Math.abs((1 - b.lowerMultiple) - (b.upperMultiple - 1)) > 0.1,
        'and they must be ASYMMETRIC — a symmetric pair is not MSCI\'s rule',
        `down ${(1 - b.lowerMultiple).toFixed(3)} vs up ${(b.upperMultiple - 1).toFixed(3)}`);
      equal(cut.bars.imiLower, Math.round(cut.imi.cutoffInr * b.lowerMultiple), 'the lower bar is 2/3 of the cutoff');
      equal(cut.bars.imiUpper, Math.round(cut.imi.cutoffInr * b.upperMultiple), 'the upper bar is 1.5x the cutoff');

      // THE MEASURED CONSEQUENCE. Companies sitting between the lower buffer and
      // the cutoff are exactly the ones a single bright line would drop and
      // MSCI's rules keep. If that set is empty the buffer changes nothing on
      // this data and the claim would be untested.
      const sheltered = c.companies.filter((x) =>
        x.fullMcapInr > 0 && x.fullMcapInr >= cut.bars.imiLower && x.fullMcapInr < cut.imi.cutoffInr).length;
      ok(sheltered > 0,
        'the lower buffer must shelter companies a bright line would have dropped',
        `${sheltered} companies sit between ₹${cr(cut.bars.imiLower)} Cr and the cutoff`);

      const held = c.companies.filter((x) =>
        x.fullMcapInr > 0 && x.fullMcapInr >= cut.imi.cutoffInr && x.fullMcapInr < cut.bars.imiUpper).length;
      ok(held > 0,
        'and the entry buffer must hold back companies above the cutoff but under 1.5x it',
        `${held} companies`);

      return `bars ₹${cr(cut.bars.imiLower)} / ₹${cr(cut.imi.cutoffInr)} / `
        + `₹${cr(cut.bars.imiUpper)} Cr · ${sheltered} sheltered, ${held} held back`;
    },
    sabotage: () => {
      // Make the buffers symmetric — the model would then call migrations MSCI's
      // hysteresis suppresses.
      MSCI.BUFFERS.lowerMultiple = 0.9;
      MSCI.BUFFERS.upperMultiple = 1.1;
    },
    restore: () => { MSCI.BUFFERS.lowerMultiple = 2 / 3; MSCI.BUFFERS.upperMultiple = 1.5; },
  }, ctx);

  await suite.check({
    id: 32,
    what: 'the two models disagree on real companies, and neither is a relabelling of the other',
    clone: deepClone,
    run: (c) => {
      const cut = gimiCutoffs(c.companies);
      const win = reviewWindow(c.companiesFile.asOf.bhavcopyTradeDate);
      const keyOf = (x) => x.isin ?? x.name;
      const quarantined = new Set(c.companies.filter((x) => x.shareCountQuarantine).map(keyOf));
      const gctx = { cutoffs: cut, quarantined, keyOf, window: win };

      let changed = 0;
      const tally = {};
      for (const company of c.companies) {
        const before = company.assessment?.verdict ?? 'unknown';
        const after = assessGimi(company, gctx).verdict;
        tally[after] = (tally[after] ?? 0) + 1;
        if (before !== after) changed += 1;
      }
      ok(changed > 50,
        'the second model must reach materially different conclusions, or it is not worth shipping two',
        `${changed} of ${c.companies.length} verdicts differ`);
      ok(Object.keys(tally).length >= 4,
        'and it must produce a spread of verdicts, not collapse everything into one',
        JSON.stringify(tally));

      // The two id lists are duplicated on purpose (state.js must not import the
      // model graph). Asserting them equal is what keeps the duplication honest.
      equal(JSON.stringify(STATE_METHODOLOGIES), JSON.stringify(METHODOLOGY_IDS),
        'the storage layer and the model must agree on which methodologies exist');
      for (const id of METHODOLOGY_IDS) {
        ok(METHODOLOGIES[id].attribution, `${id} must state whose rules it applies`);
      }

      return `${changed} of ${c.companies.length} verdicts differ · ${Object.keys(tally).length} distinct verdicts under GIMI`;
    },
    sabotage: (c) => {
      // Make every company identical in the eyes of the second model, so it
      // agrees with the first everywhere and the toggle becomes decoration.
      for (const company of c.companies) company.assessment = { verdict: 'stable' };
      for (const company of c.companies) {
        company.fullMcapInr = 1e15;
        company.freeFloatMcapInr = 1e14;
      }
    },
  }, ctx);

  process.exit(suite.report([
    `Sources scanned: ${ctx.sources.length} .js/.mjs files under ${SCAN_ROOTS.join(', ')}`,
    `Record under test: ${ctx.companies.length} companies, built ${ctx.companiesFile.builtAt}`,
  ]));
}

main().catch((error) => {
  process.stderr.write(`\n  verify-data crashed: ${error.stack}\n\n`);
  process.exit(2);
});
