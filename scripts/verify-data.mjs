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
import { assertBhavcopyShape, parseBhavcopy, assertContinuity, continuityRecord } from './lib/bhavcopy.mjs';
import { parseRawQuote, quoteNumber, quoteText } from './lib/munshot.mjs';
import { buildIndex, resolveAll } from './lib/resolve.mjs';
import { assess, verdictFromRules } from '../public/js/model/assess.js';
import { observedBoundary, observedSizeCutoffs, rankByFreeFloat } from '../public/js/model/thresholds.js';
import { segmentOf } from '../public/js/model/segments.js';
import { seriesToMap, summarise, assertSeriesDates, comparableInInr } from '../public/js/model/benchmarks.js';
import { reviewCutoffs, CONVENTION } from '../public/js/model/calendar.js';
import * as MSCI from '../public/js/config/msci-methodology.mjs';
import { SEGMENT_BAND_ADJUSTMENT, SEGMENT_OVERLAP } from '../public/js/config/thresholds.mjs';
import { gimiCutoffs, assessGimi, reviewWindow, METHODOLOGIES, METHODOLOGY_IDS } from '../public/js/model/gimi.js';
import { METHODOLOGIES as STATE_METHODOLOGIES } from '../public/js/core/state.js';
import { inrFlow, pct, pp, signedPct, factorPct, count, cr, EM_DASH } from '../public/js/core/format.js';
import { parseRange, withinRange } from '../public/js/core/range.js';
import { feedRegistry } from '../public/js/data/companies.js';
import { relativeOf, windowMean, WINDOW_STATES, REBASE_STATES, adjustmentBetween, flowPressure } from '../public/js/model/relative.js';
import { RELATIVE_PERFORMANCE, REBALANCE_BASELINE } from '../public/js/config/thresholds.mjs';
import { closedReviews, chooseBaseline } from '../public/js/model/calendar.js';

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
    asm: readJson('public/data/nse-asm.json'),
    prices: readJson('public/data/prices.json'),
    reconciliation: readJson('public/data/share-reconciliation.json'),
    relativeBaselines: readJson('public/data/relative-baselines.json'),
    predictions: readJson('public/data/predictions-2026-08.json'),
    rebalance: readJson('public/data/rebalance-2026-08.json'),
    sources: loadSources(),
    // Injected so a check can be broken by swapping the thing it verifies.
    fn: { assertBhavcopyShape, assertContinuity, continuityRecord, parseRawQuote, resolveAll, inrFlow, pct, pp, signedPct, factorPct, count, parseRange, withinRange, chooseBaseline },
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
  asm: structuredClone(ctx.asm),
  prices: structuredClone(ctx.prices),
  reconciliation: structuredClone(ctx.reconciliation),
  relativeBaselines: structuredClone(ctx.relativeBaselines),
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
    what: 'India equity rows 168 / 453 / 414 and weight sums 11.360 / 99.442 / 21.271',
    clone: deepClone,
    run: (c) => {
      // Re-measured on 2026-09-03 when EEM and SMIN were refreshed for the
      // August review. EEMS was not re-downloaded and is unchanged. These
      // describe the COMMITTED WORKBOOKS, never the funds in general — a fresh
      // download legitimately moves every one of them, and the response is to
      // re-measure in the same commit, never to loosen the check.
      const EXPECT = {
        eem: { rows: 168, weight: '11.360' },
        smin: { rows: 453, weight: '99.442' },
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
    what: 'every EM-ETF/small-cap overlap is explained — by a stale sibling file or by a residual leg',
    clone: deepClone,
    run: (c) => {
      // ⚠ THIS CHECK USED TO ASSERT ZERO OVERLAPS, and the August 2026 files
      // broke it exactly as CLAUDE.md §2.15 said a future file would. Two
      // breaks, two different facts:
      //
      //   Laurus Labs  EEM (31 Aug) + EEMS (17 Aug) — it migrated up and the
      //                older workbook has not caught up. A date gap, not an
      //                overlap.
      //   Astral       EEM 0.0002% + SMIN 0.4387%, both 31 Aug — a migration
      //                caught mid-trade, the leg it is leaving nearly unwound.
      //
      // What must still be zero is an UNEXPLAINED overlap: same date, both legs
      // substantial. That would mean the segments genuinely are not disjoint
      // and every verdict resting on the derivation is void.
      const asOfByFund = c.companiesFile.holdingsAsOfByFund ?? {};
      const residualPct = SEGMENT_OVERLAP.residualShareOfLargerPct;
      const overlaps = [];
      for (const company of c.companies) {
        if (!heldBy(company, 'eem')) continue;
        const scFund = ['smin', 'eems'].find((f) => heldBy(company, f));
        if (!scFund) continue;
        const emAsOf = asOfByFund.eem ?? null;
        const scAsOf = asOfByFund[scFund] ?? null;
        const emUsd = company.funds.eem?.marketValueUsd ?? 0;
        const scUsd = company.funds[scFund]?.marketValueUsd ?? 0;
        const larger = Math.max(emUsd, scUsd);
        const share = larger > 0 ? (Math.min(emUsd, scUsd) / larger) * 100 : 100;
        const kind = emAsOf && scAsOf && emAsOf !== scAsOf
          ? 'stale-sibling'
          : share < residualPct ? 'residual' : 'unexplained';
        overlaps.push({ name: company.name, kind, scFund, share });
      }
      const unexplained = overlaps.filter((o) => o.kind === 'unexplained');
      empty(unexplained,
        'a same-dated overlap with two substantial legs means the segments are NOT disjoint and the '
        + 'whole segment derivation is void',
        (o) => `${o.name}: eem+${o.scFund}, smaller leg is ${o.share.toFixed(1)}% of the larger`);

      // The subset property cannot be tested across two dates. Reporting it as
      // a pass would be worse than failing it, so it is named as not measurable.
      const sminAsOf = asOfByFund.smin ?? null;
      const eemsAsOf = asOfByFund.eems ?? null;
      const comparable = !(sminAsOf && eemsAsOf) || sminAsOf === eemsAsOf;
      const eemsNotSmin = c.companies.filter((x) => heldBy(x, 'eems') && !heldBy(x, 'smin'));
      if (comparable) {
        empty(eemsNotSmin, 'EM Small-Cap must be a subset of India Small-Cap', (x) => x.name);
      }

      const sampled = c.companies.filter((x) => heldBy(x, 'eems')).length;
      const smin = c.companies.filter((x) => heldBy(x, 'smin')).length;
      const byKind = overlaps.reduce((acc, o) => ({ ...acc, [o.kind]: (acc[o.kind] ?? 0) + 1 }), {});
      return `${overlaps.length} overlap(s), 0 unexplained (${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'})`
        + ` · EM SC samples ${sampled} of India SC's ${smin}`
        + (comparable ? '' : ` · subset NOT MEASURABLE: smin ${sminAsOf} vs eems ${eemsAsOf}, ${eemsNotSmin.length} EM-SC-only`);
    },
    // Same date, both legs real — the one shape that voids the derivation.
    sabotage: (c) => {
      const em = c.companies.find((x) => heldBy(x, 'eem') && !heldBy(x, 'smin') && !heldBy(x, 'eems'));
      em.funds.smin = { weightPct: 0.5, quantity: 1, marketValueUsd: em.funds.eem.marketValueUsd };
      c.companiesFile.holdingsAsOfByFund = { eem: '2026-08-31', smin: '2026-08-31', eems: '2026-08-17' };
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
    id: 38,
    what: 'a typed range is validated before it is converted — "3,000" is three thousand, and what cannot be read is NAMED',
    clone: deepClone,
    run: (c) => {
      const { parseRange: parse, withinRange: within } = c.fn;
      const wrong = [];
      const check = (min, max, expected) => {
        const got = parse({ min, max });
        const same = got.min === expected.min && got.max === expected.max
          && got.active === Boolean(expected.active) && Boolean(got.error) === Boolean(expected.error);
        if (!same) {
          wrong.push(`{min:"${min}", max:"${max}"} → ${JSON.stringify({ min: got.min, max: got.max, active: got.active, error: got.error })}`
            + ` — expected ${JSON.stringify(expected)}`);
        }
      };

      // GROUPED DIGITS, both habits. This is the whole reason the module
      // exists: read the easy way, "3,000" is 3, and the answer is a table of
      // entirely the wrong companies with nothing on screen to say so.
      check('3,000', '8,000', { min: 3000, max: 8000, active: true });
      check('1,00,000', '2,00,000', { min: 100000, max: 200000, active: true });
      check('100,000', '200,000', { min: 100000, max: 200000, active: true });
      check('3500.5', '', { min: 3500.5, max: null, active: true });

      // The whole range typed into one box, which is how a person writes one
      // down — with the unit attached, because they were reading it off a
      // column headed ₹ Cr.
      check('3,000–8,000', '', { min: 3000, max: 8000, active: true });
      check('₹3,000 to ₹8,000 Cr', '', { min: 3000, max: 8000, active: true });
      check('3000..8000', '', { min: 3000, max: 8000, active: true });

      // One open end. A blank is an open end and NEVER a zero.
      check('', '', { min: null, max: null, active: false });
      check('3000', '', { min: 3000, max: null, active: true });
      check('', '8000', { min: null, max: 8000, active: true });
      check('>3000', '', { min: 3000, max: null, active: true });
      check('<8000', '', { min: null, max: 8000, active: true });
      check('3000+', '', { min: 3000, max: null, active: true });
      check('0', '', { min: 0, max: null, active: true });

      // EVERY REJECTION IS NAMED AND FILTERS NOTHING. `active: false` with an
      // error is the state that leaves all the rows on screen and says why;
      // anything that came back active here would be a guess, and anything
      // that came back silent would be an empty table reading as a finding.
      for (const [min, max] of [['abc', ''], ['3,,000', ''], ['3000,', ''], ['1.5.5', ''],
        ['3000-8000-9000', ''], ['..', ''], ['>', ''], ['8000', '3000'], ['3000-8000', '9000']]) {
        const got = parse({ min, max });
        if (got.active || !got.error) {
          wrong.push(`{min:"${min}", max:"${max}"} → active=${got.active} error=${got.error} — a rejection must be named and must not filter`);
        }
      }

      // BOTH ENDS INCLUDED, and a missing value in NO range in either
      // direction — it is not small, it is unmeasured (CLAUDE.md §2.3).
      const band = { min: 3000, max: 8000 };
      const containment = [
        [3000, true], [8000, true], [5000, true], [2999.99, false], [8000.01, false],
        [null, false], [undefined, false], [NaN, false],
      ];
      for (const [value, expected] of containment) {
        if (within(value, band) !== expected) wrong.push(`withinRange(${String(value)}, 3000–8000) must be ${expected}`);
      }
      // An open end is open, and a zero bound still excludes a missing value.
      if (!within(1e9, { min: 3000, max: null })) wrong.push('an open maximum must include a very large value');
      if (!within(1, { min: null, max: 8000 })) wrong.push('an open minimum must include a very small value');
      if (within(null, { min: 0, max: null })) wrong.push('a missing value must not fall into a range starting at zero');
      if (!within(0, { min: 0, max: null })) wrong.push('a genuine zero is a fact and must fall into a range starting at zero');

      empty(wrong, 'a typed figure read wrongly is a confident answer to a question nobody asked', (x) => x);
      return `${containment.length} containment cases + 23 parse cases · "3,000" → ${parse({ min: '3,000', max: '' }).min}`
        + ` · "abc" → ${parse({ min: 'abc', max: '' }).error}`;
    },
    sabotage: (c) => {
      // The naive reader, which stops at the first character that is not part
      // of a number and keeps whatever it had — "3,000" becomes 3 — and treats
      // anything it cannot read as no filter at all, silently. That IS what
      // parseFloat does; it is written out longhand here because assertion 5
      // bans the call itself from every source file in this repo, this one
      // included, and the two checks are meant to interlock rather than
      // exempt each other.
      c.fn.parseRange = (value) => {
        const read = (text) => {
          const head = String(text ?? '').match(/^\d+(\.\d+)?/);
          return head ? Number(head[0]) : null;
        };
        const min = read(value?.min);
        const max = read(value?.max);
        return { min, max, active: min !== null || max !== null, empty: min === null && max === null, error: null };
      };
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
    id: 55,
    what: 'the benchmark series reach the price date, or 1,230 index legs vanish behind a reason that names neither',
    clone: deepClone,
    run: (c) => {
      /*
       * ⚠ THE ORDER OF TWO SCRIPTS, ASSERTED AS A PROPERTY OF THE RECORD.
       *
       * Every relative reading pairs a company's BSE close against its
       * benchmark's close ON THE SAME DATE. If `fund-benchmarks.json` has not
       * been refreshed in the same pass as `prices.json`, `indexOn(latestDate)`
       * returns null for every company at once and 1,230 of 1,265 readings
       * collapse to `no-index-leg` — a stated absence per row, which is honest,
       * but one that names neither the benchmarks nor the date and reads as a
       * fact about the companies.
       *
       * The record can say this about itself, so it should: the newest close in
       * every benchmark series must reach the price date the record is struck
       * on. A weekend or holiday cannot break it, because the price date is
       * itself a session.
       */
      const benchmarks = c.companiesFile.benchmarks;
      ok(benchmarks?.funds?.length, 'the record carries benchmark series', JSON.stringify(Object.keys(benchmarks ?? {})));
      const priceDate = c.prices.tradeDate;
      const behind = [];
      for (const fund of benchmarks.funds) {
        const newest = fund.lastClose ?? fund.newestDate ?? fund.series?.[fund.series.length - 1]?.date ?? null;
        if (newest === null) { behind.push(`${fund.id ?? fund.fundId}: no series at all`); continue; }
        if (newest < priceDate) behind.push(`${fund.id ?? fund.fundId}: newest ${newest} vs price date ${priceDate}`);
      }
      empty(behind,
        'a benchmark series that stops before the price date empties the index leg of every row at once — '
        + 'run fetch-fund-benchmarks.mjs in the same pass as fetch-bhavcopy.mjs',
        (x) => x);

      // And the legs the record actually carries must not be mostly absent for
      // this reason, which is what the collapse looks like from the other side.
      const noIndexLeg = c.companies.filter((x) => x.sinceRebalance?.state === 'no-index-leg').length;
      ok(noIndexLeg < c.companies.length * 0.5,
        'the index leg is present for most companies',
        `${noIndexLeg} of ${c.companies.length} readings have no index leg`);

      return `${benchmarks.funds.length} benchmark series all reach ${priceDate} · `
        + `${noIndexLeg} of ${c.companies.length} rows without an index leg`;
    },
    sabotage: (c) => {
      // The benchmarks a day behind the prices — the state a catch-up run that
      // forgot fetch-fund-benchmarks.mjs leaves the record in.
      for (const fund of c.companiesFile.benchmarks.funds) {
        const back = new Date(`${c.prices.tradeDate}T00:00:00Z`);
        back.setUTCDate(back.getUTCDate() - 1);
        fund.lastClose = back.toISOString().slice(0, 10);
      }
    },
  }, ctx);

  await suite.check({
    id: 54,
    what: 'a SKIPPED continuity check round-trips its reason to disk — the missing half of check 18',
    clone: deepClone,
    run: (c) => {
      /*
       * ⚠ THE NEGATIVE CONTROL THAT WAS NOT THERE.
       *
       * Check 18 accepts a stated reason in place of a comparison. The fetcher
       * computed one. Nothing asserted that the reason SURVIVED SERIALISATION —
       * and it did not: the writer named four fields and dropped the rest. So
       * the two halves of a three-layer fix both passed their own tests while
       * the layer between them was missing, and one missed session became a
       * permanent lockout: no comparison possible, no reason on disk, check 18
       * red, commit skipped, gap still open tomorrow. Four weekdays of correctly
       * fetched prices were discarded that way, 31 Aug to 3 Sep 2026.
       */
      const gapCase = {
        compared: 0,
        failures: [],
        skipped: 0,
        against: '2026-08-28',
        skippedReason: 'the stored file is 2026-08-28; the session before 2026-09-03 is 2026-09-02, '
          + 'so the two files are not adjacent and continuity cannot hold across them',
        gapDays: 6,
      };
      const written = JSON.parse(JSON.stringify(c.fn.continuityRecord(gapCase)));
      ok(typeof written.skippedReason === 'string' && written.skippedReason.length > 0,
        'a skipped continuity block must carry its reason all the way to the file',
        JSON.stringify(written));
      equal(written.gapDays, 6, 'and the size of the gap that caused it');
      equal(written.compared, 0, 'the comparison count survives');
      equal(written.against, '2026-08-28', 'and what it would have been compared against');
      // The one deliberate rename, asserted so it cannot drift back.
      equal(written.noCounterpart, 0, 'skipped is written as noCounterpart — scrips with no counterpart, not a skipped check');
      ok(!('skipped' in written), 'and the ambiguous name does not also survive', JSON.stringify(written));

      // The same-day case names itself differently and must survive too.
      const carried = c.fn.continuityRecord({
        compared: 1229, failures: [], skipped: 3, against: '2026-09-02',
        carriedForwardFrom: '2026-09-03',
        note: 'this run re-fetched the same trade date',
      });
      equal(carried.carriedForwardFrom, '2026-09-03', 'a carried-forward record keeps what it was carried from');
      ok(typeof carried.note === 'string', 'and the note that explains it');

      // And check 18's own reader must accept what this writer produces —
      // asserting the two halves against each other rather than each alone.
      const readerAccepts = (record) => record.compared > 0
        || (typeof record.skippedReason === 'string' && record.skippedReason.length > 0)
        || typeof record.carriedForwardFrom === 'string';
      ok(readerAccepts(written), 'check 18 must accept a written gap record');
      ok(readerAccepts(carried), 'check 18 must accept a written carried-forward record');

      return `gap record keeps ${Object.keys(written).length} fields including its reason; `
        + `carried-forward record keeps ${Object.keys(carried).length}`;
    },
    sabotage: (c) => {
      // The whitelist that shipped: four fields, and the reason on the floor.
      c.fn.continuityRecord = (continuity) => ({
        against: continuity.against,
        compared: continuity.compared,
        failures: continuity.failures,
        noCounterpart: continuity.skipped,
      });
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
    id: 36,
    what: 'a relative return recomputes from the committed windows, and a missing leg never becomes a number',
    clone: deepClone,
    run: (c) => {
      const rp = c.companiesFile.relativePerformance;
      ok(rp, 'the relative-performance block is on the record', rp ? 'present' : 'absent');

      // ⚠ THE COERCION IS THE WHOLE POINT OF THIS CHECK.
      //
      // `null - 4.5` is -4.5 in JavaScript. Finite, sortable, plausible. A bare
      // subtraction would give every company with a missing leg a mild
      // underperformer reading that sorts AMONG the real ones rather than into
      // the missing group — and zero is a real value here (parity), so nothing
      // downstream could tell a fabricated reading from a genuine one.
      equal(relativeOf(null, 4.5), null, 'a null stock leg yields null, not minus the index');
      equal(relativeOf(4.5, null), null, 'a null index leg yields null');
      equal(relativeOf(undefined, 4.5), null, 'an undefined stock leg yields null');
      equal(relativeOf(NaN, 4.5), null, 'a NaN stock leg yields null');
      // And a partial window mean is null, not the mean of what happened to be
      // there — a mean over eight of ten sessions is a different window.
      equal(windowMean([1, 2, null, 4]), null, 'a window with a gap has no mean');

      const fabricated = c.companies.filter((x) => {
        const r = x.relativePerformance;
        return r && r.relativePct !== null && (r.stockPct === null || r.indexPct === null);
      });
      empty(fabricated, 'no company has a relative return without both legs', (x) => x.name);

      // Every state is one of the named ones, and every named state carries its
      // own words — a state with no sentence is an em dash with no reason.
      const unnamed = c.companies
        .filter((x) => x.relativePerformance && !WINDOW_STATES[x.relativePerformance.state]);
      empty(unnamed, 'every window state is one this model names', (x) => `${x.name}: ${x.relativePerformance.state}`);
      const wordless = Object.entries(WINDOW_STATES).filter(([, v]) => !v.detail || !v.label);
      empty(wordless, 'every named state carries its own explanation', ([k]) => k);

      // Recompute one leg from the raw inputs rather than trusting the record.
      const history = readJson('public/data/price-history.json');
      const actions = readJson('public/data/corporate-actions.json');
      const index = new Map(history.dates.map((d, i) => [d, i]));
      const [wFrom, wTo] = history.windows;
      const wrong = [];
      let rechecked = 0;
      for (const company of c.companies) {
        const r = company.relativePerformance;
        if (!r || r.stockPct === null || company.bseScripCode == null) continue;
        const scrip = history.scrips[String(company.bseScripCode)];
        if (!scrip) continue;
        const meanFrom = windowMean(wFrom.dates.map((d) => scrip.closes[index.get(d)] ?? null));
        const meanTo = windowMean(wTo.dates.map((d) => scrip.closes[index.get(d)] ?? null));
        if (meanFrom === null || meanTo === null) continue;
        const factor = r.adjustmentFactor ?? 1;
        const implied = ((meanTo - (meanFrom / factor)) / (meanFrom / factor)) * 100;
        rechecked += 1;
        if (Math.abs(implied - r.stockPct) > 0.01) {
          wrong.push(`${company.name}: stored ${r.stockPct}, price history implies ${implied.toFixed(3)}`);
        }
      }
      empty(wrong, 'every stock leg recomputes from the committed price history', (x) => x);
      ok(rechecked > 1000, 'enough legs were recomputed for that to mean something', `${rechecked} recomputed`);

      // A price series with UNKNOWN actions must never produce a return: a bonus
      // we cannot see reads as a collapse.
      const blind = c.companies.filter((x) => {
        const code = x.bseScripCode != null ? String(x.bseScripCode) : null;
        return x.relativePerformance?.relativePct !== null
          && x.relativePerformance
          && code && !actions.scrips[code];
      });
      empty(blind, 'no return is computed for a scrip whose corporate actions could not be read', (x) => x.name);

      const withReading = c.companies.filter((x) => x.relativePerformance?.relativePct !== null
        && x.relativePerformance).length;
      return `${withReading} of ${c.companies.length} companies have a reading · states `
        + `${Object.entries(rp.states).map(([k, v]) => `${k} ${v}`).join(', ')}`;
    },
    sabotage: (c) => {
      // The bare subtraction, which is the mistake a future author will make.
      for (const company of c.companies) {
        const r = company.relativePerformance;
        if (!r) continue;
        r.relativePct = r.stockPct - r.indexPct;
      }
    },
  }, ctx);

  await suite.check({
    id: 37,
    what: 'the relative reading never moves a verdict — swept across its whole plausible range',
    clone: deepClone,
    run: (c) => {
      // The reading is a MEASUREMENT beside a verdict, not an input to one. A
      // migration verdict turns on a rank by free-float market cap, and free
      // float is floatFactor x shares x price — so today's rank ALREADY contains
      // every past price move. Letting the trend move the verdict would count
      // the same evidence twice.
      //
      // Asserting that by sweeping is stronger than asserting it by reading the
      // code: the verdict multiset must not move for ANY value the reading could
      // take, including ones no market would produce.
      const before = {};
      for (const company of c.companies) {
        before[company.assessment.verdict] = (before[company.assessment.verdict] ?? 0) + 1;
      }
      const keyOf = (x) => x.isin ?? `bse:${x.bseScripCode}`;
      const context = {
        boundary: observedBoundary(c.companies, segmentOf),
        ranks: rankByFreeFloat(c.companies, keyOf),
        quarantined: new Set(c.companies.filter((x) => x.shareCountQuarantine).map(keyOf)),
        keyOf,
        segmentReturns: c.companiesFile.benchmarks?.adjustment?.segmentReturnsInrPct ?? null,
        // Without this every company falls to `unknown` on `no-size-cutoff` and
        // the sweep would "pass" by making the whole record refuse to answer.
        sizeCutoffs: observedSizeCutoffs(c.companies, (x) => x.segment),
      };
      const moved = [];
      for (const sweep of [-200, -100, -40, -15, 0, 15, 40, 100, 200]) {
        const after = {};
        for (const company of c.companies) {
          const withReading = {
            ...company,
            relativePerformance: {
              ...(company.relativePerformance ?? {}),
              relativePct: sweep,
              envelope: [sweep - 1, sweep + 1],
              robust: true,
              direction: sweep > 0 ? 'outperformed' : 'underperformed',
            },
            // ⚠ BOTH READINGS ARE SWEPT. The since-rebalance one is the reading
            // the three columns on screen show and the one the flow-pressure
            // chip beside the verdict is derived from, so it is the likelier of
            // the two to be wired into `assess` by a future author trying to
            // "reflect it in the verdict". Sweeping only the other would leave
            // exactly that change unguarded.
            sinceRebalance: {
              ...(company.sinceRebalance ?? {}),
              relativePct: sweep,
              sensitivity: [sweep - 1, sweep + 1],
              sensitivityWidthPp: 2,
              robust: true,
              direction: sweep > 0 ? 'outperformed' : 'underperformed',
            },
          };
          const verdict = assess(withReading, context).verdict;
          after[verdict] = (after[verdict] ?? 0) + 1;
        }
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
          if ((before[key] ?? 0) !== (after[key] ?? 0)) {
            moved.push(`at ${sweep}pp: ${key} ${before[key] ?? 0} -> ${after[key] ?? 0}`);
          }
        }
      }
      empty(moved, 'no value of either reading changes any verdict count', (x) => x);

      // And the flow-pressure classification, which is what the chip beside the
      // verdict renders, must be derivable WITHOUT a verdict — otherwise the two
      // are entangled and a future change to one silently moves the other.
      // It reads the verdict only to decide whether the row is worth MARKING.
      const sample = c.companies.find((x) => x.sinceRebalance?.robust);
      if (sample) {
        const withVerdict = flowPressure(sample.sinceRebalance, {
          segment: 'smallcap', verdict: 'stable', band: REBALANCE_BASELINE.bandPct,
        });
        const withoutVerdict = flowPressure(sample.sinceRebalance, {
          segment: 'smallcap', band: REBALANCE_BASELINE.bandPct,
        });
        equal(withoutVerdict.key, withVerdict.key,
          'the pressure direction is the same with or without a verdict — the verdict only decides whether it is MARKED');
        equal(withoutVerdict.notable, false, 'and with no verdict there is nothing to mark');
        equal(withVerdict.inrFlow, null,
          'a pressure direction never carries a rupee figure — no trade has been forced (2.11, 2.16)');
      }

      return `swept -200..+200 pp across ${c.companies.length} companies, both readings · verdict multiset unchanged at every point`;
    },
    sabotage: (c) => {
      // Make the verdict depend on it, which is the change this check forbids.
      for (const company of c.companies) {
        if (company.sinceRebalance?.robust) company.assessment.verdict = 'migration-up';
      }
    },
  }, ctx);

  await suite.check({
    id: 35,
    what: 'every dated feed on the record is in the freshness registry, and the oldest one governs',
    clone: deepClone,
    run: (c) => {
      // ⚠ A REGISTRY THAT OMITS A FEED OVERSTATES FRESHNESS SILENTLY.
      //
      // freshness().oldest is what the CSV banner prints as "the oldest of these
      // governs how current this file is". It ran over four feeds and left out
      // both inputs the relative-performance column depends on — and those were
      // the stale ones: quote-stats 19 Aug and fund-benchmarks 21 Aug against a
      // 27 Aug bhavcopy. A workbook measured to the 19th was stamped as current
      // to the 27th.
      //
      // The threshold is the RECORD's own asOf block, which the registry cannot
      // move: every dated key there must have a feed. A new feed added to the
      // build without one fails here rather than quietly not being counted.
      const asOf = c.companiesFile.asOf ?? {};
      const feeds = feedRegistry(asOf);
      const covered = new Set(feeds.map((f) => f.raw).filter(Boolean));
      const uncovered = Object.entries(asOf)
        .filter(([, value]) => value)
        .filter(([, value]) => !covered.has(value));
      empty(uncovered,
        'every dated key in the record\'s asOf block is carried by a freshness feed',
        ([key, value]) => `asOf.${key} = ${value} is on the record but in no feed`);

      const dated = feeds.filter((f) => f.date);
      ok(dated.length === feeds.length, 'every registered feed resolved to a date',
        feeds.filter((f) => !f.date).map((f) => f.id).join(', ') || 'all dated');

      const oldest = dated.reduce((a, b) => (a.date <= b.date ? a : b));
      // The consequence, not just the coverage: the oldest must actually be
      // older than the newest, or the registry is reporting one moment for
      // feeds that plainly move on different cadences.
      const newest = dated.reduce((a, b) => (a.date >= b.date ? a : b));
      ok(oldest.id !== newest.id, 'the feeds genuinely differ in age — one date for all of them is not a registry',
        `oldest ${oldest.id} ${oldest.date.toISOString().slice(0, 10)}, newest ${newest.id} ${newest.date.toISOString().slice(0, 10)}`);

      return `${feeds.length} feeds · oldest "${oldest.label}" ${oldest.date.toISOString().slice(0, 10)}`
        + ` · newest "${newest.label}" ${newest.date.toISOString().slice(0, 10)}`;
    },
    sabotage: (c) => {
      // Add a feed to the record without adding it to the registry — the exact
      // shape of the bug, and the one a future author will actually make.
      c.companiesFile.asOf.someNewFeedCapturedAt = '2020-01-01T00:00:00.000Z';
    },
  }, ctx);

  await suite.check({
    id: 34,
    what: 'every stored distance names the rule it was measured against, and reproduces from it',
    clone: deepClone,
    run: (c) => {
      // ⚠ THIS EXISTS BECAUSE TWO SEPARATE BUGS MET HERE.
      //
      // First, build-companies wrote company.assessment as an explicit allowlist
      // and silently dropped distanceRuleKey and methodology — so the field was
      // not null on the record, it was ABSENT on all 1,263, and the drill panel
      // only worked because the browser re-assesses in memory.
      //
      // Second, assess() fell back to "the last rule fired", which was the wrong
      // rule for three of the eight verdicts that carry a distance:
      // possible-inclusion is measured against the UPPER band while the lower
      // one fired last, exclusion-risk against the LOWER band while the upper
      // one fired last, and the final stable against the upper exclusion band
      // while a rank crossing may have been pushed after it. Each paired a real
      // percentage with an unrelated threshold, in the drill and in the export.
      //
      // The reproduction test is the load-bearing half: naming a rule is cheap,
      // and only recomputing the distance from that rule's own threshold proves
      // the name is the right one.
      const missing = c.companies.filter((x) => x.assessment && x.assessment.distanceRuleKey === undefined);
      empty(missing, 'distanceRuleKey survives the build\'s allowlist', (x) => x.name);
      const noMethod = c.companies.filter((x) => x.assessment && x.assessment.methodology === undefined);
      empty(noMethod, 'methodology survives the build\'s allowlist', (x) => x.name);

      const orphans = [];
      const wrong = [];
      let reproduced = 0;
      for (const company of c.companies) {
        const a = company.assessment;
        if (!a || a.distancePct === null || a.distancePct === undefined) continue;
        const rule = (a.rulesFired ?? []).find((r) => r.key === a.distanceRuleKey);
        if (!rule) { orphans.push(`${company.name}: names "${a.distanceRuleKey}", not in its own rulesFired`); continue; }
        // ⚠ THE INPUT COMES FROM THE RULE, NOT FROM A FIELD THIS CHECK PICKS.
        // It used to read company.freeFloatMcapInr, which was true only while
        // every rule compared free float. Since September 2026 the size rules
        // compare FULL market cap (GIMI p. 28) and the free-float ones do not,
        // so a check that assumed one quantity would have to be told which — and
        // a check that has to be told what it is measuring is measuring itself.
        // `rule.input` is what the rule actually compared, so this now proves
        // both halves at once: that the named rule is the right one, and that
        // the number it recorded is the number the distance was struck on.
        if (rule.unit !== 'inr' || !(rule.threshold > 0) || !Number.isFinite(rule.input)) continue;
        const implied = ((rule.input - rule.threshold) / rule.threshold) * 100;
        reproduced += 1;
        if (Math.abs(implied - a.distancePct) > 0.01) {
          wrong.push(`${company.name} (${a.verdict}): stored ${a.distancePct}, "${a.distanceRuleKey}" implies ${implied.toFixed(3)}`);
        }
      }
      empty(orphans, 'every distance names a rule present in its own audit trail', (x) => x);
      empty(wrong, 'every rupee distance recomputes from the threshold it names', (x) => x);
      ok(reproduced > 500, 'enough distances were actually recomputed for that to mean something',
        `${reproduced} recomputed`);

      const tally = {};
      for (const company of c.companies) {
        const a = company.assessment;
        if (a?.distanceRuleKey) tally[`${a.verdict}->${a.distanceRuleKey}`] = (tally[`${a.verdict}->${a.distanceRuleKey}`] ?? 0) + 1;
      }
      return `${reproduced} rupee distances recomputed, 0 wrong · ${Object.keys(tally).length} verdict/rule pairings`;
    },
    sabotage: (c) => {
      // The bug itself: point every distance at the last rule fired, which is
      // what the fallback did before every call site named its own.
      for (const company of c.companies) {
        const a = company.assessment;
        if (!a?.rulesFired?.length) continue;
        a.distanceRuleKey = a.rulesFired[a.rulesFired.length - 1].key;
      }
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
          const rawForRule = r.key === 'desk-inclusion-band' ? r.band.rawInclusion.highInr
            : r.key === 'desk-exclusion-band' ? r.band.rawExclusion.lowInr : null;
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

      /*
       * ⚠ WHETHER IT FIRED IS A FACT ABOUT THE MARKET, NOT ABOUT THE CODE.
       *
       * This used to assert `floated.length > 0` unconditionally, and that
       * turned a quarterly market condition into a build failure. §2.24 is
       * explicit that the adjustment is RECORDED AND NOT APPLIED below
       * `minMovePct` (1%), because a segment that moved a fraction of a percent
       * cannot meaningfully have moved MSCI's cut-off. In the days right after
       * a review the window from the last effective date is a few sessions
       * long, so the move is inside the dead band and NOTHING floats — by
       * design.
       *
       * Measured on the run that exposed it: the August 2026 review took effect
       * on 31 Aug, and from the first build after it INDA read −0.52% and SMIN
       * −0.21% over 31 Aug → 3 Sep. Nothing floated, this check went red, and
       * the daily refresh threw away four consecutive days of correctly fetched
       * prices — 31 Aug, 1, 2 and 3 September — because the commit step is
       * gated on the whole suite. It would have done so after every February,
       * May, August and November review for as long as the segment stayed
       * inside 1%.
       *
       * So the expectation is DERIVED FROM THE SAME MEASURED INPUT THE RULE
       * READS, rather than asserted against whatever data is in front of it: it
       * must have fired if and only if some segment cleared the dead band.
       */
      const moves = Object.entries(adj.segmentReturnsInrPct ?? {});
      ok(moves.length > 0, 'the adjustment records the segment moves it was decided on', JSON.stringify(adj));
      const clears = moves.filter(([, pctMove]) => Math.abs(pctMove) >= adj.minMovePct);
      const movesLabel = moves.map(([seg, pctMove]) => `${seg} ${pctMove > 0 ? '+' : ''}${pctMove}%`).join(', ');

      if (clears.length > 0) {
        ok(floated.length > 0,
          'a segment cleared the dead band, so the adjustment must have fired',
          `${movesLabel} against minMovePct ${adj.minMovePct} — but ${floated.length} floated rules`);
      } else {
        equal(floated.length, 0,
          `no segment cleared ±${adj.minMovePct}% (${movesLabel}), so nothing may have floated`);
      }

      return clears.length > 0
        ? `${floated.length} floated band rules across ${c.companies.length} companies · ${movesLabel}`
        : `0 floated, correctly: every segment inside the ±${adj.minMovePct}% dead band (${movesLabel}) — `
          + 'recorded, not applied';
    },
    sabotage: (c) => {
      // Strip the raw band: the screen would then show an adjusted number with
      // nothing to compare it against. On a record where nothing floated, that
      // sabotage has nothing to bite on — so also break the OTHER half, the one
      // that now decides what to expect: claim a segment moved far enough to
      // float while no rule floated.
      let touched = 0;
      for (const company of c.companies) {
        for (const r of company.assessment?.rulesFired ?? []) {
          if (r.band?.applied) { r.band.rawInclusion = null; r.band.rawExclusion = null; touched += 1; }
        }
      }
      if (touched === 0) {
        const adj = c.companiesFile.benchmarks.adjustment;
        adj.segmentReturnsInrPct = Object.fromEntries(
          Object.keys(adj.segmentReturnsInrPct ?? { standard: 0 }).map((seg) => [seg, adj.minMovePct * 10]),
        );
      }
    },
  }, ctx);

  /* ── MSCI's own published rules ─────────────────────────────────────────*/
  await suite.check({
    id: 43,
    what: 'the baseline is the newest rebalance with a SESSION AFTER IT, and one that has none is named rather than defaulted to',
    clone: deepClone,
    run: (c) => {
      const context = c.companiesFile.sinceRebalance ?? null;
      ok(context, 'the record must carry its rebalance-baseline context');
      const chosen = context.baselines.find((b) => b.review === context.defaultReview);
      ok(chosen, 'the default baseline must be one of the captured ones', context.defaultReview);

      // On the committed record: the window has to have a length.
      const baselineDate = chosen.resolvedDate ?? chosen.effectiveDate;
      ok(baselineDate < context.latestDate,
        'the default baseline must have at least one session after it — a zero-length window prints as +0.0% '
        + 'on every company and reads as "nothing moved" when it means "nothing has happened yet"',
        `baseline ${baselineDate} vs latest close ${context.latestDate}`);

      // And no captured baseline that IS measurable was passed over for it.
      const newerMeasurable = context.baselines.filter(
        (b) => (b.resolvedDate ?? b.effectiveDate) < context.latestDate
          && (b.resolvedDate ?? b.effectiveDate) > baselineDate,
      );
      empty(newerMeasurable, 'the default must be the NEWEST measurable rebalance, not merely a measurable one',
        (b) => `${b.review} @ ${b.resolvedDate ?? b.effectiveDate} is newer and measurable`);

      // ⚠ THE RULE ITSELF, ON DATES THIS RECORD DOES NOT HAPPEN TO CONTAIN.
      // The committed data has no rebalance sitting on the newest close, so
      // asserting only against it would leave the walk-back — the whole reason
      // the rule exists — untested until the day it fires in production. These
      // are the August 2026 dates: the review takes effect on 31 Aug, and the
      // first session that can measure anything from it is 1 Sep.
      const captured = [
        { review: '2026-08', effectiveDate: '2026-08-31', resolvedDate: '2026-08-31' },
        { review: '2026-05', effectiveDate: '2026-05-29', resolvedDate: '2026-05-29' },
        { review: '2026-02', effectiveDate: '2026-02-27', resolvedDate: '2026-02-27' },
      ];
      const onTheDay = c.fn.chooseBaseline(captured, '2026-08-31');
      equal(onTheDay.defaultReview, '2026-05',
        'on the rebalance day itself the baseline must stay on the previous review — there is nothing to measure yet');
      equal(onTheDay.awaitingSession.map((b) => b.review).join(','), '2026-08',
        'and the review it stepped over must be named, so the screen can say a rebalance has happened');

      const dayAfter = c.fn.chooseBaseline(captured, '2026-09-01');
      equal(dayAfter.defaultReview, '2026-08',
        'one session later the baseline must move on its own — no date is edited anywhere to make this happen');
      equal(dayAfter.awaitingSession.length, 0, 'and nothing is left awaiting');

      // A walked-back baseline is judged on the date it RESOLVED to, not the
      // published one: India was shut on the effective date and the reading is
      // struck on the session before it.
      const walked = c.fn.chooseBaseline(
        [{ review: '2026-08', effectiveDate: '2026-08-31', resolvedDate: '2026-08-28' }, ...captured.slice(1)],
        '2026-08-31',
      );
      equal(walked.defaultReview, '2026-08',
        'a baseline that walked back to an earlier session HAS a session after it, and must be used');

      return `default ${context.defaultReview} @ ${baselineDate} vs latest ${context.latestDate} · `
        + `${context.awaitingSession?.length ?? 0} awaiting a session · walk-back proved on 31 Aug/1 Sep 2026`;
    },
    sabotage: (c) => {
      // The version that only asks whether the date has passed. It defaults to
      // a rebalance struck on the newest close, and every reading it produces
      // is a zero that is not a zero.
      c.fn.chooseBaseline = (baselines, latestDate) => {
        const dated = (b) => b.resolvedDate ?? b.effectiveDate;
        const ordered = [...baselines].sort((a, b) => dated(b).localeCompare(dated(a)));
        const measurable = ordered.filter((b) => dated(b) <= latestDate);
        return { defaultReview: measurable[0]?.review ?? null, awaitingSession: [], measurable };
      };
    },
  }, ctx);

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

  suite.section("The desk's baseline — since the last rebalance");

  await suite.check({
    id: 42,
    what: 'the baseline is the rebalance EFFECTIVE date, not the price window MSCI struck its caps in',
    clone: deepClone,
    run: (c) => {
      const context = c.companiesFile.sinceRebalance;
      ok(context, 'the since-rebalance block is on the record', context ? 'present' : 'absent');

      // ⚠ THIS IS THE CONFUSION THE WHOLE FEATURE TURNS ON, AND BOTH DATES ARE
      // REAL DATES IN THIS FILE. A baseline silently taken from the price window
      // would be six weeks early, would still produce a plausible number on every
      // row, and nothing else would notice.
      const history = readJson('public/data/price-history.json');
      const priceWindowDates = new Set(history.windows.flatMap((w) => [w.from, w.to, ...w.dates]));
      const wrong = [];
      for (const baseline of context.baselines) {
        const [year, month] = baseline.review.split('-').map(Number);
        const cutoffs = reviewCutoffs(year, month);
        if (baseline.effectiveDate >= cutoffs.price.from && baseline.effectiveDate <= cutoffs.price.to) {
          wrong.push(`${baseline.review}: effective ${baseline.effectiveDate} sits INSIDE its own price window `
            + `${cutoffs.price.from}..${cutoffs.price.to}`);
        }
        if (priceWindowDates.has(baseline.resolvedDate)) {
          wrong.push(`${baseline.review}: baseline ${baseline.resolvedDate} is a captured price-window session`);
        }
        // The effective date is the last business day of the review month; the
        // price window is in the month BEFORE it. So the baseline must be later,
        // and by about a month.
        const gapDays = Math.round((Date.parse(baseline.effectiveDate) - Date.parse(cutoffs.price.to)) / 86400000);
        if (gapDays < 20) {
          wrong.push(`${baseline.review}: only ${gapDays} day(s) after its price window closed — expected about a month`);
        }
      }
      empty(wrong, 'every baseline is a rebalance date and none is a price-window date', (x) => x);

      // And the set is derived from the calendar, not typed: each review's
      // effective date must be the one closedReviews() computes for it.
      const fromCalendar = new Map(
        closedReviews(c.prices.tradeDate, 12).map((r) => [r.review, r.effectiveDate]),
      );
      const drifted = context.baselines.filter((b) => fromCalendar.get(b.review) !== b.effectiveDate);
      empty(drifted, 'every baseline date reproduces from the review calendar',
        (b) => `${b.review}: record ${b.effectiveDate}, calendar ${fromCalendar.get(b.review)}`);

      // A baseline that walked back must SAY it did — an em dash with no reason
      // and a date silently moved are the same failure (2.4).
      const silent = context.baselines.filter((b) => !b.tradedOnEffectiveDate && b.walkedBackDays === null);
      empty(silent, 'a baseline that could not be struck on its own date states how far it walked', (b) => b.review);

      return `${context.baselines.length} baselines · default ${context.defaultReview} `
        + `(${context.baselines.find((b) => b.review === context.defaultReview)?.effectiveDate}) `
        + `-> ${context.latestDate} · price windows ${history.windows.map((w) => `${w.from}..${w.to}`).join(', ')}`;
    },
    sabotage: (c) => {
      // The mistake itself: baseline the reading on MSCI's price window instead
      // of on the day the review took effect.
      const history = readJson('public/data/price-history.json');
      for (const baseline of c.companiesFile.sinceRebalance.baselines) {
        baseline.effectiveDate = history.windows[0].to;
        baseline.resolvedDate = history.windows[0].to;
      }
    },
  }, ctx);

  await suite.check({
    id: 39,
    what: 'a since-rebalance leg recomputes from the committed closes, and a missing leg never becomes a number',
    clone: deepClone,
    run: (c) => {
      const context = c.companiesFile.sinceRebalance;
      const history = readJson('public/data/price-history.json');
      const actions = readJson('public/data/corporate-actions.json');
      const dateIndex = new Map(history.dates.map((d, i) => [d, i]));
      const baseline = history.baselines.find((b) => b.review === context.defaultReview);
      ok(baseline, 'the default baseline was actually captured', context.defaultReview);

      // ---- the coercion, again, on this reading's own arithmetic ----------
      // `null - 4.5` is -4.5. A bare subtraction would give every company with a
      // missing leg a mild-underperformer reading that sorts among the real ones.
      equal(relativeOf(null, 4.5), null, 'a null stock leg yields null, not minus the index');
      equal(relativeOf(4.5, null), null, 'a null index leg yields null');

      // ---- the half-open action interval ---------------------------------
      // The bounds here are NOT the bounds of the window-to-window reading, and
      // getting them wrong is a silent 2x error on a bonus. A close on the ex-date
      // is already post-action, so an action ex ON the baseline is excluded and
      // one ex ON the latest date must be applied.
      const bonus = (exDate) => [{ exDate, purpose: 'Bonus issue 1:1', priceFactor: 2, quantifiable: true }];
      equal(adjustmentBetween(bonus('2026-05-29'), '2026-05-29', '2026-08-28').factor, 1,
        'an action ex ON the baseline date is already in that close — not applied');
      equal(adjustmentBetween(bonus('2026-08-28'), '2026-05-29', '2026-08-28').factor, 2,
        'an action ex ON the latest date IS applied — that close is post-action and the baseline is not');
      equal(adjustmentBetween(bonus('2026-08-29'), '2026-05-29', '2026-08-28').factor, 1,
        'an action after the latest date is not applied');
      equal(adjustmentBetween([{ exDate: '2026-07-01', purpose: 'Spin Off', priceFactor: null, quantifiable: false }],
        '2026-05-29', '2026-08-28').state, 'unquantifiable-action',
        'an action with no published ratio refuses the reading rather than assuming 1.0');

      const fabricated = c.companies.filter((x) => {
        const r = x.sinceRebalance;
        return r && r.relativePct !== null && (r.stockPct === null || r.indexPct === null);
      });
      empty(fabricated, 'no company has a delta without both legs', (x) => x.name);

      // ---- the delta is GEOMETRIC, not the difference of the two columns --
      //
      // ⚠ THIS ASSERTION WAS MISSING ON THE FIRST WRITING OF THIS CHECK, and
      // `--prove` caught it: the sabotage replaced every delta with
      // `stockPct - indexPct` and the check passed, because it verified both
      // legs and never the relationship between them. A check that cannot fail
      // is not a check (2.22).
      //
      // The two returns compound, so subtracting them is a different number. It
      // is a SMALL difference on small returns, which is what makes it dangerous
      // — it would look right on most rows and be wrong on exactly the movers
      // the desk is reading the column for.
      const TOLERANCE_PP = 0.005;
      const notGeometric = [];
      let widest = 0;
      let widestName = null;
      let discriminating = 0;
      for (const company of c.companies) {
        const r = company.sinceRebalance;
        if (!r || r.relativePct === null) continue;
        const expected = relativeOf(r.stockPct, r.indexPct);
        if (Math.abs(expected - r.relativePct) > TOLERANCE_PP) {
          notGeometric.push(`${company.name}: stored ${r.relativePct}, (1+s)/(1+i)-1 = ${expected.toFixed(3)}`);
        }
        // How far the arithmetic difference sits from the geometric one on THIS
        // row. Rows where that exceeds the tolerance above are the rows on which
        // the assertion can actually tell the two formulas apart.
        const gap = Math.abs((r.stockPct - r.indexPct) - expected);
        if (gap > TOLERANCE_PP) discriminating += 1;
        if (gap > widest) { widest = gap; widestName = company.name; }
      }
      empty(notGeometric, 'every delta is (1 + stock) / (1 + index) - 1', (x) => x);

      /*
       * ⚠ THE DISCRIMINATION IS ABOUT THIS CHECK'S TOLERANCE, NOT ABOUT THE
       * SIZE OF THE MARKET'S MOVE.
       *
       * This used to require the widest gap to exceed 1 pp, and that is a
       * statement about the window rather than about the code. The two formulas
       * differ by roughly stock x index, so the gap scales with the PRODUCT of
       * the two returns: across a quarter it is pp-sized (WELCORP: +119.7%
       * against SMIN's +4.5% is 115.2 pp apart arithmetically and 110.0%
       * geometrically), and across the three sessions since a rebalance, where
       * both legs are around a percent, it is necessarily hundredths of a point.
       *
       * Measured on the first record baselined on the August 2026 review: widest
       * gap 0.08 pp. The old assertion could not have passed, and would have
       * failed for weeks after every review — the same failure mode as check 27,
       * on a different check, and the reason both are worth stating as a class:
       * AN ASSERTION ABOUT WHAT THE MARKET DID IS NOT AN ASSERTION ABOUT THE
       * CODE, and it will hold the pipeline hostage on the day the market
       * declines to cooperate.
       *
       * What the check actually needs is that it COULD have caught a stored
       * arithmetic difference — i.e. at least one row where the two formulas are
       * further apart than the tolerance this check compares with. That is true
       * at any window length where the legs are non-zero, and it is exactly what
       * `--prove`'s sabotage exercises.
       */
      ok(discriminating > 0,
        'at least one row must separate the two formulas by more than this check\'s own tolerance, '
        + 'or a stored arithmetic difference would pass unnoticed',
        `0 of ${c.companies.length} rows differ by more than ${TOLERANCE_PP} pp`);

      const unnamed = c.companies.filter((x) => x.sinceRebalance && !REBASE_STATES[x.sinceRebalance.state]);
      empty(unnamed, 'every state is one this model names', (x) => `${x.name}: ${x.sinceRebalance.state}`);
      const wordless = Object.entries(REBASE_STATES).filter(([, v]) => !v.detail || !v.label);
      empty(wordless, 'every named state carries its own explanation', ([k]) => k);

      // ---- recompute the stock leg from the raw closes --------------------
      const wrong = [];
      let rechecked = 0;
      for (const company of c.companies) {
        const r = company.sinceRebalance;
        if (!r || r.stockPct === null || company.bseScripCode == null) continue;
        const scrip = history.scrips[String(company.bseScripCode)];
        if (!scrip) continue;
        const at = scrip.closes[dateIndex.get(r.baselineDate)];
        if (!(at > 0) || !(company.priceInr > 0)) continue;
        const from = at / (r.adjustmentFactor ?? 1);
        const implied = ((company.priceInr - from) / from) * 100;
        rechecked += 1;
        if (Math.abs(implied - r.stockPct) > 0.01) {
          wrong.push(`${company.name}: stored ${r.stockPct}, closes imply ${implied.toFixed(3)}`);
        }
      }
      empty(wrong, 'every stock leg recomputes from the committed baseline close and the committed price', (x) => x);
      ok(rechecked > 1000, 'enough legs were recomputed for that to mean something', `${rechecked} recomputed`);

      // ---- and the index leg, in RUPEES, on exactly those two dates -------
      const fx = seriesToMap(c.benchmarks.fx.series);
      const legWrong = [];
      let legsChecked = 0;
      for (const company of c.companies) {
        const r = company.sinceRebalance;
        if (!r || r.indexPct === null) continue;
        const fund = c.benchmarks.funds.find((f) => f.symbol === r.benchmarkSymbol);
        if (!fund) { legWrong.push(`${company.name}: no benchmark ${r.benchmarkSymbol}`); continue; }
        const closes = seriesToMap(fund.series);
        // EXACT dates on both legs. A walk-back on either would difference two
        // different windows and call the result relative performance.
        const a = closes.get(r.baselineDate) * fx.get(r.baselineDate);
        const b = closes.get(r.latestDate) * fx.get(r.latestDate);
        if (!(a > 0) || !(b > 0)) { legWrong.push(`${company.name}: no exact index leg`); continue; }
        legsChecked += 1;
        const implied = ((b - a) / a) * 100;
        if (Math.abs(implied - r.indexPct) > 0.01) {
          legWrong.push(`${company.name}: stored index ${r.indexPct}, series implies ${implied.toFixed(3)}`);
        }
      }
      empty(legWrong, 'every index leg recomputes in rupees from the same two dates', (x) => x);

      // A blind action history must never produce a return.
      const blind = c.companies.filter((x) => {
        const code = x.bseScripCode != null ? String(x.bseScripCode) : null;
        return x.sinceRebalance?.relativePct != null && code && !actions.scrips[code];
      });
      empty(blind, 'no return is computed for a scrip whose corporate actions could not be read', (x) => x.name);

      const withReading = c.companies.filter((x) => x.sinceRebalance?.relativePct != null).length;
      const robust = c.companies.filter((x) => x.sinceRebalance?.robust).length;
      // If every direction shared a sign, the two legs would be struck on
      // different dates — the same tripwire passive drift carries.
      const up = c.companies.filter((x) => x.sinceRebalance?.direction === 'outperformed').length;
      const down = c.companies.filter((x) => x.sinceRebalance?.direction === 'underperformed').length;
      ok(up > 0 && down > 0,
        'both directions occur — a universe that all outperformed its own segment would mean two different dates',
        `${up} outperformed, ${down} underperformed`);

      return `${withReading} of ${c.companies.length} have a reading · ${robust} robust `
        + `(${up} up, ${down} down) · ${rechecked} stock legs and ${legsChecked} index legs recomputed `
        + `· geometric vs arithmetic separated on ${discriminating} rows, widest ${widest.toFixed(3)} pp `
        + `at ${widestName}`;
    },
    sabotage: (c) => {
      // The bare subtraction, on this reading.
      for (const company of c.companies) {
        const r = company.sinceRebalance;
        if (!r || r.stockPct === null) continue;
        r.relativePct = r.stockPct - r.indexPct;
      }
    },
  }, ctx);

  await suite.check({
    id: 40,
    what: 'the alternate baselines cover every company, share the default\'s shape, and are genuinely different readings',
    clone: deepClone,
    run: (c) => {
      const context = c.companiesFile.sinceRebalance;
      const file = c.relativeBaselines;

      equal(file.defaultReview, context.defaultReview,
        'the alternates file and the record agree on which baseline is the default');
      ok(!(context.defaultReview in file.readings),
        'the default is NOT duplicated into the alternates file — one copy, in companies.json',
        Object.keys(file.readings).join(', '));

      const expected = context.baselines.map((b) => b.review).filter((r) => r !== context.defaultReview);
      equal(JSON.stringify(Object.keys(file.readings).sort()), JSON.stringify(expected.sort()),
        'every non-default baseline on the record has readings in the file');

      // ⚠ THE SHAPES MUST MATCH. The interface swaps between the inline reading
      // and these when a reader re-bases, so a field present in one and absent
      // in the other renders as an em dash for half the baselines only.
      const keyOf = (x) => x.isin ?? `bse:${x.bseScripCode}`;
      const sample = c.companies.find((x) => x.sinceRebalance?.relativePct != null);
      const inlineKeys = Object.keys(sample.sinceRebalance).sort();
      const shapeWrong = [];
      for (const [review, byKey] of Object.entries(file.readings)) {
        equal(Object.keys(byKey).length, c.companies.length,
          `${review} carries a reading slot for every company`);
        const alt = byKey[keyOf(sample)];
        if (!alt) { shapeWrong.push(`${review}: no reading for ${sample.name}`); continue; }
        if (alt.relativePct === null) continue;
        const altKeys = Object.keys(alt).sort();
        if (JSON.stringify(altKeys) !== JSON.stringify(inlineKeys)) {
          shapeWrong.push(`${review}: fields ${altKeys.join(',')} vs inline ${inlineKeys.join(',')}`);
        }
      }
      empty(shapeWrong, 'an alternate reading has the same fields as the inline one', (x) => x);

      // And they must actually differ. Four identical baselines would be a
      // picker that changes nothing — the failure a reader could never see.
      const moved = [];
      for (const [review, byKey] of Object.entries(file.readings)) {
        let differing = 0;
        let compared = 0;
        for (const company of c.companies) {
          const inline = company.sinceRebalance;
          const alt = byKey[keyOf(company)];
          if (!inline || !alt || inline.relativePct === null || alt.relativePct === null) continue;
          compared += 1;
          if (Math.abs(inline.relativePct - alt.relativePct) > 0.01) differing += 1;
        }
        ok(compared > 500, `${review} overlaps the default on enough companies to compare`, `${compared} compared`);
        ok(differing > compared * 0.9,
          `${review} is a genuinely different baseline, not a copy of the default`,
          `${differing} of ${compared} differ`);
        // Each baseline must be struck on ITS OWN date, not the default's.
        const alt = byKey[keyOf(c.companies.find((x) => byKey[keyOf(x)]?.baselineDate))];
        const meta = context.baselines.find((b) => b.review === review);
        if (alt && alt.baselineDate !== (meta.resolvedDate ?? meta.effectiveDate)) {
          moved.push(`${review}: readings struck on ${alt.baselineDate}, baseline says ${meta.resolvedDate}`);
        }
      }
      empty(moved, 'each alternate is struck on its own rebalance date', (x) => x);

      return `${Object.keys(file.readings).length} alternates (${Object.keys(file.readings).join(', ')}) `
        + `× ${c.companies.length} companies · default ${context.defaultReview} inline`;
    },
    sabotage: (c) => {
      // The picker that changes nothing: every alternate becomes a copy of the
      // default, which is exactly what a mis-keyed lookup would produce — and
      // the one failure a reader could never see, because every column would
      // still be full of plausible numbers.
      const keyOf = (x) => x.isin ?? `bse:${x.bseScripCode}`;
      for (const review of Object.keys(c.relativeBaselines.readings)) {
        for (const company of c.companies) {
          c.relativeBaselines.readings[review][keyOf(company)] = company.sinceRebalance;
        }
      }
    },
  }, ctx);

  await suite.check({
    id: 41,
    what: 'one trading date carries one close — a duplicate bar would make every rupee return ambiguous',
    clone: deepClone,
    run: (c) => {
      // ⚠ THIS CHECK EXISTS BECAUSE THE BUG IT CATCHES SHIPPED. The committed
      // fund-benchmarks.json carried USDINR=X twice on 2026-08-28 — 95.4704 and
      // 95.3600, 0.12% apart. Yahoo appends a live bar for the current session
      // beside that session's daily bar and both label the same date.
      //
      // Every consumer builds a Map from the series, so whichever bar came last
      // silently won. Nothing looked wrong; RELIANCE's index leg was 1.328%
      // against the 1.445% a reader recomputing by hand would get, and there was
      // no way to see why.
      const series = [
        [c.benchmarks.fx.symbol, c.benchmarks.fx.series],
        ...c.benchmarks.funds.map((f) => [f.symbol, f.series]),
      ];
      const dupes = [];
      for (const [symbol, points] of series) {
        const seen = new Set();
        for (const point of points) {
          if (seen.has(point.date)) dupes.push(`${symbol}: ${point.date}`);
          seen.add(point.date);
        }
      }
      empty(dupes, 'no series carries two bars for one trading date', (x) => x);

      // And the guard that is supposed to catch it must actually say so, rather
      // than the absence being luck.
      const withDupe = [...c.benchmarks.fx.series, { ...c.benchmarks.fx.series[0] }];
      const verdict = assertSeriesDates(withDupe);
      ok(!verdict.ok && verdict.problems.some((p) => /duplicate/i.test(p)),
        'assertSeriesDates reports a duplicated date as a problem',
        JSON.stringify(verdict.problems));

      return `${series.length} series · ${series.reduce((n, [, p]) => n + p.length, 0)} bars · no date twice`;
    },
    sabotage: (c) => {
      // The bug: a second bar for the newest date, at a slightly different rate,
      // exactly as Yahoo's live bar arrives.
      const last = c.benchmarks.fx.series[c.benchmarks.fx.series.length - 1];
      c.benchmarks.fx.series.push({ date: last.date, close: last.close * 1.0012 });
    },
  }, ctx);

  /* ── scoring a review that has happened ─────────────────────────────────*/
  suite.section('The rebalance scorecard');

  await suite.check({
    id: 44,
    what: 'the scored forecast PREDATES the review and is not the live record wearing a date',
    clone: deepClone,
    run: (c) => {
      // ⚠ THE CHECK THE WHOLE SCORECARD RESTS ON.
      //
      // Verdicts recompute from whatever holdings are committed. Regenerate the
      // snapshot after the workbooks are refreshed and every verdict silently
      // becomes hindsight — the model marked against the answer sheet, scoring
      // beautifully and meaning nothing. Nothing in the output file distinguishes
      // the two cases, so it has to be established here.
      //
      // Two independent things must hold, and neither implies the other:
      //   1. THE DATE. The forecast's holdings predate the effective date. Its
      //      threshold is the calendar's effective date, which the snapshot
      //      cannot move — the §3.8 rule about a guard's own threshold.
      //   2. THE CONTENT. The frozen verdicts genuinely DIFFER from what the
      //      live record says today. A snapshot regenerated post-hoc would be
      //      identical to the record on every row, and would pass (1) whenever
      //      somebody had also edited the date.
      const forecast = c.predictions;
      const effective = forecast.effectiveDate;
      const holdingsAsOf = forecast.forecastFrom?.asOf?.isharesHoldings ?? null;
      ok(typeof holdingsAsOf === 'string', 'the forecast must state the holdings it was struck on');
      ok(holdingsAsOf < effective,
        'the forecast must have been struck BEFORE the review took effect, or it is hindsight',
        `holdings ${holdingsAsOf} vs effective ${effective}`);

      // The calendar decides the effective date, not the file.
      const fromCalendar = reviewCutoffs(Number(forecast.review.slice(0, 4)), Number(forecast.review.slice(5)));
      ok(fromCalendar.price.from === forecast.priceWindow.from && fromCalendar.price.to === forecast.priceWindow.to,
        "the forecast's price window must be the calendar's, not a window typed into the file",
        `${forecast.priceWindow.from}..${forecast.priceWindow.to} vs ${fromCalendar.price.from}..${fromCalendar.price.to}`);

      const live = new Map(c.companies.map((x) => [x.isin, x.assessment?.verdict ?? null]));
      let compared = 0;
      let differ = 0;
      for (const company of forecast.companies) {
        if (!live.has(company.isin)) continue;
        compared += 1;
        if (live.get(company.isin) !== company.verdict) differ += 1;
      }
      ok(compared > 0, 'the forecast and the record must share companies to compare');
      ok(differ > 0,
        'the frozen forecast is IDENTICAL to the live record on every company — either nothing moved at '
        + 'this review, or the snapshot was regenerated after the outcome landed and is not a forecast',
        `${compared} compared, 0 differ`);
      return `forecast struck on holdings of ${holdingsAsOf}, ${effective} effective · `
        + `${differ} of ${compared} verdicts have since changed, so the frozen file is not the live record`;
    },
    // Regenerate the snapshot from today's record — the one mistake that makes
    // the scorecard worthless while making it look perfect.
    sabotage: (c) => {
      const live = new Map(c.companies.map((x) => [x.isin, x.assessment?.verdict ?? null]));
      for (const company of c.predictions.companies) {
        if (live.has(company.isin)) company.verdict = live.get(company.isin);
      }
    },
  }, ctx);

  await suite.check({
    id: 45,
    what: 'the scorecard counts what it says it counts, and never scores a refusal to call',
    clone: deepClone,
    run: (c) => {
      const r = c.rebalance;
      const s = r.scorecard;
      const CLAIMS = {
        'likely-inclusion': 'entered',
        'possible-inclusion': 'entered',
        'likely-exclusion': 'exited',
        'exclusion-risk': 'exited',
        'migration-up': 'migration-up',
        'migration-down': 'migration-down',
        stable: 'no-change',
      };
      // Every headline figure re-derived from the companies array, so a summary
      // block cannot drift from the rows it claims to summarise.
      const scorable = r.companies.filter((x) => x.inForecast && x.predictedVerdict && x.predictedVerdict !== 'unknown');
      const flagged = scorable.filter((x) => x.claimsAMove);
      const moved = scorable.filter((x) => x.event !== 'no-change');
      equal(s.scored, scorable.length, 'the scored population');
      equal(s.precision.flagged, flagged.length, 'companies flagged as moving');
      equal(s.precision.moved, flagged.filter((x) => x.event !== 'no-change').length, 'flagged companies that moved');
      equal(s.recall.moved, moved.length, 'companies that moved');
      equal(s.recall.flagged, moved.filter((x) => x.claimsAMove).length, 'moved companies that were flagged');

      // AN "unknown" VERDICT IS A REFUSAL TO CALL, NOT A WRONG CALL. Folding it
      // into either column would turn honesty into a score — in either
      // direction — so it must appear in neither.
      const unknowns = r.companies.filter((x) => x.predictedVerdict === 'unknown');
      empty(unknowns.filter((x) => x.predictedClaim !== null),
        'an "unknown" verdict must carry no claim, so it can be scored neither right nor wrong',
        (x) => `${x.name}: claim ${x.predictedClaim}`);
      equal(s.unknownAtForecast, unknowns.length, 'unknowns counted apart');
      ok(scorable.every((x) => x.predictedVerdict !== 'unknown'), 'no unknown reached the scored population');

      // The claim mapping is the one in the builder, re-stated here rather than
      // imported: a mapping that agreed with itself would test nothing.
      const mismatched = scorable.filter((x) => CLAIMS[x.predictedVerdict] !== x.predictedClaim);
      empty(mismatched, 'every verdict maps to the event it claims',
        (x) => `${x.name}: ${x.predictedVerdict} claimed ${x.predictedClaim}`);

      // Only re-read funds may be evidence: a fund whose workbook did not move
      // says nothing about what this review did.
      const reRead = new Set(r.funds.reRead);
      ok(reRead.size > 0, 'at least one fund must have been re-read');
      empty(r.funds.notReRead.filter((id) => reRead.has(id)),
        'a fund cannot be both re-read and not re-read', (id) => id);
      return `${s.scored} scored · ${s.precision.moved} of ${s.precision.flagged} flagged moved · `
        + `${s.recall.flagged} of ${s.recall.moved} movers flagged · ${s.unknownAtForecast} refusals not scored · `
        + `compared over ${[...reRead].join(', ')}`;
    },
    // Score the refusals as correct no-change calls — the change that makes the
    // headline better by counting the rows the model declined to judge.
    sabotage: (c) => {
      for (const row of c.rebalance.companies) {
        if (row.predictedVerdict === 'unknown') row.predictedClaim = 'no-change';
      }
      c.rebalance.scorecard.unknownAtForecast = 0;
    },
  }, ctx);


  suite.section('The recalibrated verdict — MSCI geometry on observed cutoffs');

  await suite.check({
    id: 46,
    what: "every bar a verdict is decided against is MSCI's published ratio times a cutoff the record can reproduce",
    clone: deepClone,
    run: (c) => {
      // ⚠ THIS IS THE CHECK THAT KEEPS A DESK NUMBER FROM WEARING MSCI'S FACE.
      //
      // After the August 2026 review the verdicts stopped being decided by the
      // desk's rupee bands and started being decided by MSCI's published ratios
      // — 2/3 out, 1.5x in, 50% minimum free float with 2/3 relief, a 0.15 FIF
      // floor. Every one of those is a number MSCI prints and we cite; none may
      // be quietly nudged to make a screen look better (§2.25).
      //
      // Two halves, and the second is the load-bearing one:
      //   1. each bar is exactly ratio x cutoff, recomputed here from the
      //      methodology module rather than read off the record;
      //   2. each CUTOFF is the Nth company by full market cap across the WHOLE
      //      record, where N is the observed constituent count — recomputed the
      //      same way. A cutoff typed in, or read off one segment, would pass
      //      the first half and fail this one.
      const m = c.companiesFile.model;
      const cut = m.sizeCutoffs;
      const bars = m.sizeBars;
      ok(cut && bars, 'the cutoffs and the bars are both on the record', JSON.stringify(Object.keys(m)));

      // --- the cutoffs, from the record's own companies -------------------
      const measurable = c.companies.filter((x) => Number.isFinite(x.fullMcapInr) && Number.isFinite(x.freeFloatMcapInr));
      const ranked = [...measurable].sort((a, b) => b.fullMcapInr - a.fullMcapInr);
      const stdCount = measurable.filter((x) => x.segment === 'standard').length;
      const scCount = measurable.filter((x) => x.segment === 'smallcap').length;
      equal(cut.standardCount, stdCount, 'the Standard count is the constituents we can size');
      equal(cut.imiCount, stdCount + scCount, 'the IMI count is Standard plus Small Cap');
      equal(cut.rankedCount, ranked.length, 'the ranking covers every company carrying BOTH sizes');
      equal(cut.excludedForMissingSize, c.companies.length - ranked.length,
        'a company missing either size is counted out, never ranked as a zero');
      equal(cut.standard.inr, ranked[stdCount - 1].fullMcapInr, 'the Standard cutoff is the Nth by FULL market cap');
      equal(cut.imi.inr, ranked[stdCount + scCount - 1].fullMcapInr, 'the IMI cutoff is the Nth by FULL market cap');

      // --- the bars, from MSCI's own published ratios ----------------------
      const near = (a, b, what) => ok(Math.abs(a - b) < 1, what, `${a} vs ${b}`);
      near(bars.entryFullInr, cut.imi.inr * MSCI.BUFFERS.upperMultiple, "the entry bar is MSCI's 1.5x entry buffer");
      near(bars.exitFullInr, cut.imi.inr * MSCI.BUFFERS.lowerMultiple, "the deletion bar is MSCI's 2/3 lower buffer");
      near(bars.entryFreeFloatInr, cut.imi.inr * MSCI.MIN_FREE_FLOAT_MCAP.newConstituentMultipleOfCutoff,
        "the new-constituent free-float minimum is MSCI's 50% of the cutoff");
      near(bars.exitFreeFloatInr,
        cut.imi.inr * MSCI.MIN_FREE_FLOAT_MCAP.newConstituentMultipleOfCutoff * MSCI.MIN_FREE_FLOAT_MCAP.existingConstituentRelief,
        "an incumbent's free-float minimum carries MSCI's 2/3 relief");
      near(bars.migrationUpFullInr, cut.standard.inr * MSCI.BUFFERS.upperMultiple, 'the migration-up bar is the upper buffer on the Standard cutoff');
      near(bars.migrationDownFullInr, cut.standard.inr * MSCI.BUFFERS.lowerMultiple, 'the migration-down bar is the lower buffer on the Standard cutoff');
      equal(bars.fifFloor, MSCI.MIN_FIF.floor, "the FIF floor is MSCI's published 0.15");

      // --- and there is a GAP between the two bars, which is the whole point -
      // The exit bar sits below the cutoff and the entry bar above it, and the
      // 2.25x between them is the hysteresis. Collapsing either onto the cutoff
      // turns the pair back into one bright line, which is precisely the model
      // that called 39 migrations in a quarter that had 3.
      ok(MSCI.BUFFERS.lowerMultiple < 1 && MSCI.BUFFERS.upperMultiple > 1,
        'the exit bar is below the cutoff and the entry bar above it',
        `${MSCI.BUFFERS.lowerMultiple} / ${MSCI.BUFFERS.upperMultiple}`);
      ok(MSCI.BUFFERS.upperMultiple / MSCI.BUFFERS.lowerMultiple > 2,
        'and the gap between them is wide enough to be hysteresis rather than rounding',
        `${(MSCI.BUFFERS.upperMultiple / MSCI.BUFFERS.lowerMultiple).toFixed(2)}x`);
      ok(bars.exitFullInr < cut.imi.inr && cut.imi.inr < bars.entryFullInr,
        'and the record shows the two bars straddling the cutoff in rupees',
        `₹${cr(bars.exitFullInr)} < ₹${cr(cut.imi.inr)} < ₹${cr(bars.entryFullInr)} Cr`);

      // --- and the cutoff is compared against MSCI'S OWN published range -----
      // ⚠ IT DOES NOT LAND INSIDE IT, AND THAT MUST NOT BE QUIETLY DROPPED.
      // §2.26 recorded the coverage-walk cutoff landing inside MSCI's reference
      // range as corroboration. The rank-derived one does not: it is 1.41x above
      // the top of the range, because our constituent count comes from funds
      // that SAMPLE the index. Citing MSCI's pages for the ratios while hiding
      // that the bar they scale sits 40% above MSCI's own reference would be a
      // tier-3 figure wearing a tier-1 face.
      const ref = m.sizeCutoffReference;
      ok(ref, 'the cutoff is compared against MSCI\'s published reference range on the record', JSON.stringify(Object.keys(m)));
      ok(Number.isFinite(ref.ourCutoffUsdM) && Number.isFinite(ref.multipleOfRangeHigh),
        'and the comparison is a computed figure, not a sentence', JSON.stringify(ref));
      equal(ref.msciReferenceUsdM, MSCI.GLOBAL_MIN_SIZE_REFERENCE.emerging.imi,
        "the reference is MSCI's own EM IMI figure, read from the methodology module");
      ok(typeof ref.note === 'string' && /biased high/i.test(ref.note),
        'and the record says which way the bias runs, in words',
        ref.note?.slice(0, 80));
      ok(ref.inside === (ref.ourCutoffUsdM >= ref.msciRangeUsdM.low && ref.ourCutoffUsdM <= ref.msciRangeUsdM.high),
        '`inside` agrees with the numbers beside it — a disclosure that disagrees with its own figures is worse than none',
        `${ref.ourCutoffUsdM} vs ${ref.msciRangeUsdM.low}..${ref.msciRangeUsdM.high}, inside=${ref.inside}`);

      return `Standard ₹${cr(cut.standard.inr)} Cr (rank ${cut.standardCount}) · `
        + `IMI ₹${cr(cut.imi.inr)} Cr (rank ${cut.imiCount}) of ${cut.rankedCount} · `
        + `${cut.excludedForMissingSize} excluded for a missing size · `
        + `IMI cutoff USD ${ref.ourCutoffUsdM}m vs MSCI's published USD ${ref.msciRangeUsdM.low}-${Math.round(ref.msciRangeUsdM.high)}m `
        + `(${ref.multipleOfRangeHigh}x the top — biased high)`;
    },
    // Nudge one bar by 5%: the shape of the change a future author makes to get
    // a column to look right, and the one that would silently turn MSCI's
    // published ratio into somebody's preference.
    sabotage: (c) => { c.companiesFile.model.sizeBars.exitFullInr *= 1.05; },
  }, ctx);

  await suite.check({
    id: 47,
    what: 'the cutoff is drawn from the whole universe, so a constituent can actually fall below it',
    clone: deepClone,
    run: (c) => {
      // ⚠ THE GUARD-READS-ITS-OWN-THRESHOLD TRAP, IN ITS SIZE-CUTOFF FORM.
      //
      // The smallest Standard constituent IS the Standard floor, so a cutoff
      // read off the constituents could never be crossed by one of them and
      // every migration and deletion rule would be decoration (§3.8, §2.14).
      // Ranking the whole record — constituents and unheld companies together —
      // is what makes the test able to fire, and the proof it fires is that
      // constituents are found below the bars.
      const bars = c.companiesFile.model.sizeBars;
      const sc = c.companies.filter((x) => x.segment === 'smallcap' && Number.isFinite(x.fullMcapInr));
      const std = c.companies.filter((x) => x.segment === 'standard' && Number.isFinite(x.fullMcapInr));
      const belowExit = sc.filter((x) => x.fullMcapInr < bars.exitFullInr);
      const belowMigration = std.filter((x) => x.fullMcapInr < bars.migrationDownFullInr);
      ok(belowExit.length > 0,
        'Small Cap constituents are found below the deletion buffer — the test can fire',
        `${belowExit.length} of ${sc.length}`);
      ok(belowMigration.length > 0,
        'Standard constituents are found below the migration buffer — the test can fire',
        `${belowMigration.length} of ${std.length}`);
      // And it must not fire on everybody: a bar under which every constituent
      // sits is as useless as one under which none does.
      ok(belowExit.length < sc.length / 2, 'the deletion bar does not flag half the segment',
        `${belowExit.length} of ${sc.length}`);

      // The verdicts that follow must exist on the record, or the rules above
      // are being measured while something else decides what is shown.
      const counts = c.companiesFile.model.verdictCounts;
      for (const key of ['likely-exclusion', 'exclusion-risk', 'likely-inclusion', 'migration-down']) {
        ok((counts[key] ?? 0) > 0, `the record carries at least one ${key}`, JSON.stringify(counts));
      }
      return `${belowExit.length} of ${sc.length} Small Cap below the deletion buffer · `
        + `${belowMigration.length} of ${std.length} Standard below the migration buffer`;
    },
    // Re-derive the cutoff from the SEGMENT rather than from the universe, which
    // is the circular version: it lands at the smallest constituent, and then
    // nothing can be below it.
    sabotage: (c) => {
      const sc = c.companies.filter((x) => x.segment === 'smallcap' && Number.isFinite(x.fullMcapInr));
      const floor = Math.min(...sc.map((x) => x.fullMcapInr));
      c.companiesFile.model.sizeBars.exitFullInr = floor;
    },
  }, ctx);

  await suite.check({
    id: 48,
    what: 'the retrospective score is replayed from the frozen forecast, differs from it, and says it is in-sample',
    clone: deepClone,
    run: (c) => {
      // ⚠ A MODEL SCORED ON THE REVIEW THAT MOTIVATED IT IS ANSWERING A QUESTION
      // IT HAS ALREADY SEEN. That is worth publishing and it is not a track
      // record, and the difference has to be on the file rather than in
      // somebody's memory of the commit message.
      const r = c.rebalance.retrospective;
      ok(r, 'the retrospective block is on the file', JSON.stringify(Object.keys(c.rebalance)));
      equal(r.inSample, true, 'the retrospective declares itself in-sample');
      ok(typeof r.caveat === 'string' && /in-sample/i.test(r.caveat),
        'and says so in words a reader will see, not only in a boolean', r.caveat);
      ok(r.replayedFrom.includes('predictions-'),
        'it names the frozen file it was replayed from', r.replayedFrom);

      // It must be a DIFFERENT model, or the block is decoration. Recomputing
      // the old verdicts would give exactly the forecast's own numbers.
      const changed = r.precision.flagged !== r.asForecast.flagged
        || r.precision.rightEvent !== r.asForecast.rightEvent;
      ok(changed, 'the recalibrated rules reach a different answer from the frozen ones',
        `now ${r.precision.rightEvent}/${r.precision.flagged}, as forecast ${r.asForecast.rightEvent}/${r.asForecast.flagged}`);

      // Both denominators, both scores — never one blended figure (§2.5, §2.32).
      ok(r.precision.flagged > 0 && r.recall.moved > 0, 'both denominators are on the block',
        JSON.stringify({ flagged: r.precision.flagged, moved: r.recall.moved }));
      equal(r.recall.rightEvent, r.precision.rightEvent,
        'the same hits are counted in both directions, so the two figures cannot drift apart');
      // What it STILL gets wrong is named, not summarised away.
      ok(Array.isArray(r.stillMissed), 'the movers it would still miss are listed', typeof r.stillMissed);
      equal(r.stillMissed.length, r.recall.moved - r.recall.rightEvent,
        'the misses list is complete — every mover it did not name is on it');

      return `as forecast ${r.asForecast.rightEvent}/${r.asForecast.flagged} · `
        + `retrospectively ${r.precision.rightEvent}/${r.precision.flagged} of ${r.recall.moved} movers · `
        + `${r.stillMissed.length} still missed · in-sample`;
    },
    // The change that makes the number look like a forecast record.
    sabotage: (c) => { c.rebalance.retrospective.inSample = false; },
  }, ctx);

  await suite.check({
    id: 49,
    what: "the FIF floor is a factor, never a rupee figure, and it is MSCI's number applied to a proxy",
    clone: deepClone,
    run: (c) => {
      // ₹0 Cr is not a rounding artefact of 0.15 — it is a different number
      // (§2.26). And the exchange float factor is NOT MSCI's Foreign Inclusion
      // Factor: MSCI's nets foreign ownership limits. Saying so is the whole
      // difference between citing a rule and claiming one.
      const rules = [];
      for (const company of c.companies) {
        for (const r of company.assessment?.rulesFired ?? []) if (r.key === 'fif-floor') rules.push({ company, r });
      }
      ok(rules.length > 0, 'the FIF floor fires somewhere on the record', `${rules.length} rules`);
      empty(rules.filter(({ r }) => r.unit !== 'factor'),
        'every FIF rule declares its unit as a factor', ({ company }) => company.name);
      empty(rules.filter(({ r }) => r.threshold !== MSCI.MIN_FIF.floor),
        "every FIF rule uses MSCI's published floor", ({ company, r }) => `${company.name}: ${r.threshold}`);
      empty(rules.filter(({ r }) => r.thresholdSource !== 'msci'),
        'and attributes it to MSCI', ({ company, r }) => `${company.name}: ${r.thresholdSource}`);
      empty(rules.filter(({ r }) => !/proxy/i.test(r.note ?? '')),
        'and says on its face that the exchange float factor is a PROXY for FIF, not FIF',
        ({ company }) => company.name);

      const below = rules.filter(({ r }) => r.result === 'below');
      const heldBelow = below.filter(({ company }) => company.segment !== 'outside');
      return `${rules.length} FIF rules · ${below.length} below ${MSCI.MIN_FIF.floor} · `
        + `${heldBelow.length} of those held by a fund`;
    },
    // Render MSCI's 0.15 as rupees, which is how a factor becomes "₹0 Cr".
    sabotage: (c) => {
      for (const company of c.companies) {
        for (const r of company.assessment?.rulesFired ?? []) if (r.key === 'fif-floor') r.unit = 'inr';
      }
    },
  }, ctx);


  await suite.check({
    id: 50,
    what: 'the cutoff re-prices with the companies, so a verdict does not turn on which day the record was struck',
    clone: deepClone,
    run: (c) => {
      // ⚠ THIS IS THE PROPERTY A FIXED RUPEE BAND CANNOT HAVE, AND IT IS THE
      // REASON THE RECALIBRATION USES A RANK-DERIVED CUTOFF INSTEAD OF ONE.
      //
      // MSCI prices a review on one of the last ten business days of the month
      // BEFORE the review month and does not say which (GIMI p. 49, §2.12.2).
      // Our record is struck on the latest committed close, four to six weeks
      // later. A bar fixed in rupees is then compared against market caps that
      // have drifted underneath it — measured over 1,204 companies between the
      // August window and 28 Aug 2026, full market cap moved p10 -8.9% /
      // median +0.9% / p90 +20.0% — and a verdict flips because the RECORD moved,
      // not because the company did.
      //
      // A cutoff that is the Nth company by full market cap moves with the same
      // prices as the company being tested, so the comparison survives the
      // shift. This proves it on the committed record: re-strike every size on
      // MSCI's own ten-day window and the verdicts must very largely hold.
      // Read here rather than carried on the context: the clone this check
      // sabotages is the COMPANIES, and the history is an independent file the
      // sabotage must not be able to move.
      const history = readJson('public/data/price-history.json');
      const win = history.windows.find((w) => w.review === c.companiesFile.model.nextReview?.review)
        ?? history.windows[history.windows.length - 1];
      ok(win, 'a price window is on the record to re-strike against', JSON.stringify(history.windows?.map((w) => w.review)));
      const at = new Map(history.dates.map((d, i) => [d, i]));
      const keyOf = (x) => x.isin ?? `bse:${x.bseScripCode}`;
      const slots = win.dates.map((d) => at.get(d)).filter((i) => i !== undefined);
      equal(slots.length, win.dates.length, 'every session in the window is in the scanned range');

      // The window MEAN, because MSCI does not say which of the ten it used and
      // no single day is privileged (§2.12.2).
      const meanClose = (code) => {
        const scrip = history.scrips[String(code)];
        if (!scrip) return null;
        const closes = slots.map((i) => scrip.closes[i]).filter((x) => Number.isFinite(x));
        return closes.length === slots.length ? closes.reduce((a, b) => a + b, 0) / closes.length : null;
      };

      // ⚠ THE FACTOR AND THE SHARE COUNT ARE HELD, ONLY THE PRICE MOVES (§2.9).
      // Re-deriving a float factor from a historical price would fold a price
      // difference into a float difference and measure nothing.
      let restruck = 0;
      const asWindow = c.companies.map((company) => {
        const price = company.bseScripCode == null ? null : meanClose(company.bseScripCode);
        if (!Number.isFinite(price) || !Number.isFinite(company.sharesOutstanding) || !Number.isFinite(company.floatFactor)) {
          return company;
        }
        restruck += 1;
        const fullMcapInr = company.sharesOutstanding * price;
        return { ...company, fullMcapInr, freeFloatMcapInr: company.floatFactor * fullMcapInr };
      });
      ok(restruck > c.companies.length * 0.8, 'most of the record could be re-struck on that window',
        `${restruck} of ${c.companies.length}`);

      const context = (rows) => ({
        quarantined: new Set(rows.filter((x) => x.shareCountQuarantine).map(keyOf)),
        keyOf,
        segmentReturns: null,
        sizeCutoffs: observedSizeCutoffs(rows, (x) => x.segment),
      });
      const verdictsOn = (rows) => {
        const ctx = context(rows);
        const out = new Map();
        for (const company of rows) out.set(keyOf(company), assess(company, ctx).verdict);
        return out;
      };
      const now = verdictsOn(c.companies);
      const then = verdictsOn(asWindow);
      const moved = [...now.keys()].filter((k) => now.get(k) !== then.get(k));
      const movedPct = (moved.length / now.size) * 100;

      // The cutoffs must MOVE — if they did not, the re-strike did nothing and
      // this check would be comparing a record with itself.
      const cutNow = observedSizeCutoffs(c.companies, (x) => x.segment);
      const cutThen = observedSizeCutoffs(asWindow, (x) => x.segment);
      ok(cutNow.imi.inr !== cutThen.imi.inr && cutNow.standard.inr !== cutThen.standard.inr,
        'the re-strike genuinely moved both cutoffs, so this is not a comparison with itself',
        `IMI ₹${cr(cutNow.imi.inr)} -> ₹${cr(cutThen.imi.inr)} Cr`);

      ok(movedPct < 5, 'a six-week price shift moves few verdicts, because the bar moved with the companies',
        `${moved.length} of ${now.size} verdicts (${movedPct.toFixed(1)}%)`);

      // ⚠ AND THE OBVIOUS COMPARISON IS NOT ASSERTED, BECAUSE IT IS NOT TRUE HERE.
      //
      // It is tempting to add "and a bar frozen in rupees moves more". Measured
      // on this record it does not: across this window the derived deletion bar
      // flags 23 companies then 19 (14 changing sides) while a bar frozen at
      // today's rupee level flags 23 then 22 (11 changing sides). The reason is
      // that the window is quiet — the IMI cutoff moves 2.2% — so there is
      // almost nothing for a floating bar to buy, and on a small move the extra
      // motion of the bar itself is the larger effect.
      //
      // The case for deriving the cutoff is §2.24's and it is about a market
      // that has MOVED, which this five-week window has not. Asserting it here
      // would be reading a preference out of a quiet quarter — the same error
      // the AUC sentence made in the calibration record. So the counts are
      // reported and nothing is claimed from them.
      const flaggedBy = (rows, bar) => new Set(rows
        .filter((x) => x.segment === 'smallcap' && Number.isFinite(x.fullMcapInr) && x.fullMcapInr < bar)
        .map(keyOf));
      const derivedNow = flaggedBy(c.companies, cutNow.imi.inr * MSCI.BUFFERS.lowerMultiple);
      const derivedThen = flaggedBy(asWindow, cutThen.imi.inr * MSCI.BUFFERS.lowerMultiple);
      const churn = [...derivedNow].filter((k) => !derivedThen.has(k)).length
        + [...derivedThen].filter((k) => !derivedNow.has(k)).length;

      return `${restruck} re-struck on ${win.from}..${win.to} · ${moved.length} of ${now.size} verdicts move `
        + `(${movedPct.toFixed(1)}%) · IMI cutoff ₹${cr(cutNow.imi.inr)} -> ₹${cr(cutThen.imi.inr)} Cr · `
        + `${churn} companies change sides of the deletion bar`;
    },
    /**
     * ⚠ A UNIFORM SABOTAGE IS SURVIVED, AND THAT IS THE CHECK WORKING.
     *
     * The first attempt scaled every share count by 1.6. Nothing moved, because
     * the cutoff is derived from the same rows: multiply the whole universe by a
     * constant and every rank, every ratio and every verdict is unchanged. That
     * is precisely the invariance being asserted, so the sabotage was proving
     * the check rather than breaking it — a false negative that would have
     * counted as a tick.
     *
     * What breaks the property is a share count that moves for PART of the
     * universe, which is also the real defect shape: a feed that updated some
     * companies and not others. The Small Cap segment then re-prices against a
     * cutoff set by everybody else, and verdicts move because the record moved.
     */
    sabotage: (c) => {
      for (const company of c.companies) {
        if (company.segment === 'smallcap' && Number.isFinite(company.sharesOutstanding)) {
          company.sharesOutstanding *= 2.5;
        }
      }
    },
  }, ctx);

  suite.section('NSE Additional Surveillance Measure');

  await suite.check({
    id: 51,
    what: "every ASM stage on a company is NSE's own, joined by ISIN and carried through unchanged",
    clone: deepClone,
    run: (c) => {
      // The join key is ISIN and nothing else (§3.9). A stage carried on a
      // company must be byte-identical to what NSE published for that ISIN — no
      // re-banding, no re-wording, no symbol-matched guess.
      const bySrcIsin = new Map((c.asm.companies ?? []).map((r) => [r.isin, r]));
      const meta = c.companiesFile.asm;
      ok(meta && meta.available === true,
        'the record declares the ASM feed available so a null means "not flagged", not "unknown"',
        JSON.stringify(meta?.available));

      const wrongStage = [];   // flagged, but not what NSE published for this ISIN
      const missedJoin = [];   // ISIN is in NSE's list but the company is not flagged
      let flagged = 0;
      for (const co of c.companies) {
        if (co.asm) {
          flagged += 1;
          const src = bySrcIsin.get(co.isin);
          if (!src
            || src.survCode !== co.asm.survCode
            || src.stage !== co.asm.stage
            || src.survDesc !== co.asm.survDesc
            || src.category !== co.asm.category) {
            wrongStage.push(`${co.isin} ${co.name}: record ${JSON.stringify(co.asm.survCode)} vs source ${JSON.stringify(src?.survCode ?? null)}`);
          }
        } else if (co.isin && bySrcIsin.has(co.isin)) {
          missedJoin.push(`${co.isin} ${co.name}`);
        }
      }
      empty(wrongStage, "no company carries an ASM stage that differs from NSE's own", (x) => x);
      empty(missedJoin, "no company whose ISIN is on NSE's ASM list was left unflagged", (x) => x);
      return `${flagged} of ${c.companies.length} companies flagged · ${bySrcIsin.size} in NSE's list · joined by ISIN`;
    },
    sabotage: (c) => {
      // Re-band a flagged company's stage to something NSE never published: a
      // fabricated stage that looks authoritative is exactly the tier-1 lie.
      const victim = c.companies.find((co) => co.asm);
      victim.asm.survCode = 'LTASM - IX (99)';
    },
  }, ctx);

  await suite.check({
    id: 52,
    what: 'the ASM coverage meta is MEASURED from the records — the count and the stage legend, never typed',
    clone: deepClone,
    run: (c) => {
      const meta = c.companiesFile.asm;
      ok(meta, 'the record carries an ASM meta block', JSON.stringify(meta));
      const actualFlagged = c.companies.filter((co) => co.asm).length;
      equal(meta.flaggedInUniverse, actualFlagged, 'flaggedInUniverse equals the number of flagged companies');

      const legend = meta.stagesInUniverse ?? {};
      const legendSum = Object.values(legend).reduce((a, n) => a + n, 0);
      equal(legendSum, actualFlagged, 'the stage legend sums to the flagged count');
      const recomputed = {};
      for (const co of c.companies) {
        if (!co.asm) continue;
        const code = co.asm.survCode ?? co.asm.stage ?? '(unknown stage)';
        recomputed[code] = (recomputed[code] ?? 0) + 1;
      }
      const mismatched = Object.keys({ ...legend, ...recomputed })
        .filter((k) => (legend[k] ?? 0) !== (recomputed[k] ?? 0));
      empty(mismatched, 'every stage in the legend matches the count of rows carrying it',
        (k) => `${k}: legend ${legend[k] ?? 0} vs actual ${recomputed[k] ?? 0}`);

      ok(typeof meta.available === 'boolean', 'available is a boolean', JSON.stringify(meta.available));
      ok(meta.totalFlagged >= meta.flaggedInUniverse,
        "NSE's whole list is at least as large as the part inside the universe",
        `${meta.totalFlagged} < ${meta.flaggedInUniverse}`);
      return `${actualFlagged} flagged in-universe of ${meta.totalFlagged} on NSE's list · legend ${Object.keys(legend).length} stages, measured`;
    },
    sabotage: (c) => {
      // Type a count that no longer matches the rows: the stale-denominator bug
      // this project exists to prevent (§2.5), wearing an ASM hat.
      c.companiesFile.asm.flaggedInUniverse += 1;
    },
  }, ctx);

  await suite.check({
    id: 53,
    what: 'ASM qualifies the forced FLOW and never the verdict — only where a trade is implied, attributed to the desk',
    clone: deepClone,
    run: (c) => {
      const TRADE = new Set(['likely-inclusion', 'possible-inclusion', 'migration-up', 'migration-down', 'exclusion-risk', 'likely-exclusion']);
      const misplaced = [];   // the constraint present where it must not be, or absent where it must be
      const notInert = [];    // the asm rule changed the verdict its replay recovers
      const claimsMsci = [];  // the qualifier presented as MSCI's rule (§2.25)
      const flowsUnmarked = [];
      let binding = 0;

      for (const co of c.companies) {
        const a = co.assessment;
        if (!a) continue;
        const rules = a.rulesFired ?? [];
        const asmRule = rules.find((r) => r.key === 'asm-flow-constraint') ?? null;
        const constraint = co.flowEstimate?.asmConstraint ?? null;
        const isBinding = a.asm?.binding === true;

        if (isBinding) {
          binding += 1;
          if (!co.asm) misplaced.push(`${co.name}: binding but not under ASM`);
          if (!TRADE.has(a.verdict)) misplaced.push(`${co.name}: binding but verdict "${a.verdict}" implies no trade`);
          if (!asmRule) misplaced.push(`${co.name}: binding but no asm-flow-constraint rule`);
          if (!constraint) misplaced.push(`${co.name}: binding but the flow carries no asmConstraint`);
          else {
            if (constraint.mandated !== false) misplaced.push(`${co.name}: asmConstraint.mandated is not false`);
            if (constraint.survCode !== co.asm.survCode) misplaced.push(`${co.name}: constraint survCode ${constraint.survCode} != ${co.asm.survCode}`);
            if (/\bMSCI\b/.test(constraint.attribution ?? '') && !/not an MSCI/i.test(constraint.attribution ?? '')) {
              claimsMsci.push(`${co.name}: constraint attributes MSCI`);
            }
          }
          for (const f of co.flowEstimate?.flows ?? []) {
            if (f && f.constrainedByAsm !== true) flowsUnmarked.push(`${co.name}/${f.fundId}`);
          }
        } else {
          if (constraint) misplaced.push(`${co.name}: NOT binding but the flow carries an asmConstraint`);
          if (asmRule) misplaced.push(`${co.name}: NOT binding but carries an asm-flow-constraint rule`);
        }

        // The rule must be INERT to the verdict: the size verdict is recovered
        // with the rule present AND with it removed (§2.16).
        if (asmRule) {
          if (asmRule.thresholdSource === 'msci') claimsMsci.push(`${co.name}: asm rule sourced to MSCI`);
          const without = rules.filter((r) => r.key !== 'asm-flow-constraint');
          if (verdictFromRules(rules) !== a.verdict || verdictFromRules(without) !== a.verdict) {
            notInert.push(`${co.name}: the asm rule alters the replayed verdict`);
          }
        }
      }

      empty(misplaced, 'the ASM flow constraint rides only on ASM names with a trade implied, and always on those', (x) => x);
      empty(flowsUnmarked, 'every flow on an ASM-constrained name is marked constrainedByAsm', (x) => x);
      empty(claimsMsci, "the ASM qualifier is the desk's, never presented as MSCI's rule", (x) => x);
      empty(notInert, 'the ASM rule is inert to the verdict — it qualifies the flow, it never decides the verdict', (x) => x);
      ok(binding > 0, 'at least one ASM name carries a bound forced-flow constraint', String(binding));
      return `${binding} ASM names with a bound forced flow · verdict unmoved by the ASM rule · attributed to the desk`;
    },
    sabotage: (c) => {
      // Present an ASM-restricted flow as a mandated one — the exact lie the
      // qualifier exists to prevent.
      const victim = c.companies.find((co) => co.assessment?.asm?.binding && co.flowEstimate?.asmConstraint);
      victim.flowEstimate.asmConstraint.mandated = true;
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
