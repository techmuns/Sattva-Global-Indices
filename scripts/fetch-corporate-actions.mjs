#!/usr/bin/env node
/**
 * fetch-corporate-actions.mjs — BSE's own corporate-action history, per scrip
 *                               -> public/data/corporate-actions.json
 *
 *   node scripts/fetch-corporate-actions.mjs
 *   node scripts/fetch-corporate-actions.mjs --limit 20   probe; WRITES NOTHING
 *
 * Zero dependencies. `api.bseindia.com` has no bot protection — 3.8.
 *
 * ---------------------------------------------------------------------------
 * WHY: A RAW CLOSE ACROSS A BONUS ISSUE IS A COLLAPSE THAT NEVER HAPPENED
 * ---------------------------------------------------------------------------
 * LICI closed at 829.90 on 27 May 2026 and at 411.45 on the 29th. Nothing went
 * wrong: it went ex-bonus 1:1, every holder woke up with twice as many shares,
 * and the position was worth what it was worth the day before. Read as a raw
 * price series that is -50.4%, and it sorts, ranks and corroborates a
 * migration-down verdict perfectly happily.
 *
 * Seven such events fall inside the May->August 2026 review quarter alone.
 *
 * ---------------------------------------------------------------------------
 * ⚠ THE OBVIOUS DETECTOR DOES NOT WORK, AND IT FAILS SILENTLY
 * ---------------------------------------------------------------------------
 * The first attempt inferred actions from the bhavcopy itself, on the premise
 * that BSE adjusts `PrvsClsgPric` across an action — so a disagreement with the
 * previous session's close would be the action, free, for every scrip.
 *
 * BSE does not. Measured on LICI's own ex-date: close 411.45 on 2026-05-29
 * against a PrvsClsgPric of 829.90, which is EXACTLY the raw close of the 27th.
 * The previous close is carried unadjusted, so continuity holds across a bonus
 * and the split is invisible to it. That detector found 0 actions across 303,018
 * comparisons in a quarter known to contain seven, and only a positive control —
 * "finding nothing means you are broken" — stopped it being written.
 *
 * And there is no rescuing it from prices alone: with PrvsClsgPric raw, a 1:1
 * bonus and a genuine 50% crash are the same two numbers. A ratio-near-a-simple
 * -fraction heuristic would flag real crashes and miss small bonuses. Whether a
 * number is real is not a thing to guess at.
 *
 * ---------------------------------------------------------------------------
 * SO IT COMES FROM THE SOURCE, AND THE SOURCE IS BETTER THAN THE ALTERNATIVE
 * ---------------------------------------------------------------------------
 * `api.bseindia.com/BseIndiaAPI/api/DefaultData/w?scripcode=N` returns that
 * scrip's whole corporate-action history — ex-date and purpose, verbatim.
 *
 * It beats the repo's existing quote-stats fields on every axis. quote-stats
 * reaches 749 of 1,263 companies and 887 of 1,263 carry no action information at
 * all; this endpoint answers for every scrip in the master. quote-stats stores
 * ONE event, so two actions in a window are invisible; this returns all of them.
 * quote-stats calls LICI a "2:1 split"; BSE calls it a 1:1 BONUS, which is what
 * it was — the price effect is the same but the fact is not.
 *
 * Cross-checked on all seven of the quarter's events, the two sources agree
 * exactly once BSE's ratio is read correctly:
 *
 *     LICI        Bonus issue 1:1                    quote-stats 2:1   ✓
 *     TRENT       Bonus issue 1:2                    quote-stats 3:2   ✓
 *     ANANDRATHI  Bonus issue 1:1                    quote-stats 2:1   ✓
 *     ZFCVINDIA   Bonus issue 5:1                    quote-stats 6:1   ✓
 *     CUB         Bonus issue 1:3                    quote-stats 4:3   ✓
 *     BRIGADE     Bonus issue 1:3                    quote-stats 4:3   ✓
 *     JLHL        Stock Split From Rs.10/- to Rs.2/-  quote-stats 5:1   ✓
 *
 * ---------------------------------------------------------------------------
 * WHAT IS STORED
 * ---------------------------------------------------------------------------
 * BSE's `Ex_date` and `Purpose` strings, VERBATIM — tier 1. `priceFactor` is our
 * reading of the purpose text and is labelled as ours, with the rule that
 * produced it named on the record so it can be checked rather than trusted.
 *
 * A purpose we cannot parse is `priceFactor: null` with `parsed: false`, never
 * 1.0. A factor of 1 would say "this action does not move the price", which is a
 * claim; null says we did not read it, which is the truth (2.3).
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { renderTable, num } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const OUT_PATH = join(REPO, 'public/data/corporate-actions.json');

const API = 'https://api.bseindia.com/BseIndiaAPI/api';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CONCURRENCY = 4;
const GAP_MS = 250;

/**
 * Which purposes move the price mechanically, and by how much.
 *
 * ⚠ THE DIRECTION IS THE THING TO GET RIGHT. `priceFactor` is what the price is
 * DIVIDED by across the ex-date, i.e. how many shares one share became.
 *
 *   "Bonus issue a:b"  ->  a free shares for every b held  ->  (a + b) / b
 *   "Stock Split From Rs.X/- to Rs.Y/-"  ->  face value X becomes Y  ->  X / Y
 *
 * Getting this inverted turns a halving into a doubling, and both look like
 * plausible numbers. It is cross-checked against the OBSERVED price move in
 * build-companies, which is a source this parser cannot influence.
 *
 * Dividends are deliberately NOT here. An ex-dividend drop is a real price
 * change that a real holder experiences, the index leg is also a price return
 * with distributions stripped the same way, and adjusting for it would put both
 * legs on different conventions. See 2.11.
 */
const PRICE_AFFECTING = [
  {
    kind: 'bonus',
    test: /bonus\s+issue\s+(\d+)\s*:\s*(\d+)/i,
    factor: (m) => (Number(m[1]) + Number(m[2])) / Number(m[2]),
    rule: '"Bonus issue a:b" = a free shares per b held, so one share becomes (a+b)/b',
  },
  {
    kind: 'split',
    // Note the double space BSE actually serves in "Stock  Split". \s+ handles
    // it; a literal single space would match nothing and the guard below would
    // have caught that, which is why the guard exists.
    test: /stock\s+split\s+from\s+rs\.?\s*([\d.]+)\s*\/?-?\s*to\s+rs\.?\s*([\d.]+)/i,
    factor: (m) => Number(m[1]) / Number(m[2]),
    rule: '"Stock Split From Rs.X to Rs.Y" = face value X becomes Y, so one share becomes X/Y',
  },
  {
    kind: 'consolidation',
    test: /consolidat\w*\s+from\s+rs\.?\s*([\d.]+)\s*\/?-?\s*to\s+rs\.?\s*([\d.]+)/i,
    factor: (m) => Number(m[1]) / Number(m[2]),
    rule: '"Consolidation From Rs.X to Rs.Y" = face value X becomes Y; X/Y is below 1, so the price rises',
  },
];

/**
 * Actions that move the price but do NOT say by how much.
 *
 * ⚠ THESE ARE NOT PARSE FAILURES AND MUST NOT BE TREATED AS ONE.
 *
 * "Right Issue of Equity Shares" is the whole string BSE serves — no ratio, no
 * subscription price, and the ex-rights adjustment needs both. A spin-off's drop
 * is the value of what was spun off, which is not in the text either. The
 * numbers are absent at the source; no amount of parsing recovers them.
 *
 * So they are carried with `priceFactor: null` and `quantifiable: false`, and a
 * company carrying one inside a window gets a STATED ABSENCE for that window's
 * return rather than a number computed from a series with a step in it. That is
 * the honest answer, and it is a different answer from "no action here".
 */
const UNQUANTIFIABLE = [
  { kind: 'rights', test: /right\s+issue/i },
  { kind: 'demerger', test: /spin\s*.?\s*off|scheme\s+of\s+arrangement|demerg/i },
  { kind: 'capital-reduction', test: /reduction\s+of\s+capital/i },
  // A split with no ratio given. BSE serves the ratio in the "Stock Split From"
  // form and not in this one; both are splits and only one is readable.
  { kind: 'subdivision', test: /sub\s*.?\s*division/i },
  // The reverse, also without a ratio: "Consolidation of Shares" as against
  // "Consolidation From Rs.1/- to Rs.10/-", which IS quantified above. Four of
  // these exist across the universe and the recognition guard is what found
  // them — a 300-scrip vocabulary probe had not seen one.
  { kind: 'consolidation', test: /consolidat/i },
  { kind: 'delisting', test: /delisting|resolution\s+plan/i },
];

/**
 * Purposes that are NOT mechanical price events, listed so the guard below can
 * tell "we decided this does not move the price" from "we did not recognise it".
 *
 * A buyback is a tender offer: the share count falls, but there is no ex-date
 * step in the price the way a bonus has one. REIT and InvIT income
 * distributions are dividends by another name, and dividends are excluded on
 * both legs — see the payload's `scope` note.
 */
const NOT_MECHANICAL = [
  /dividend/i,
  // A tender offer. The share count falls, but there is no ex-date step in the
  // price the way a bonus has one.
  /buy\s*back/i,
  // REIT and InvIT payouts. "Income Distribution" and "Return of Capital" are
  // both distributions by another name, and distributions are excluded on both
  // legs — see the payload's `scope` note.
  /income\s+distribution/i,
  /return\s+of\s+capital/i,
  // Meetings and paperwork. An EGM is a date in a calendar; a certificate
  // exchange swaps paper for the same number of shares.
  /e-?voting|e\.?\s*g\.?\s*m\.?|annual\s+general|exchange\s+of\s+share/i,
  /^general$/i,
  /^$/,
];

/** BSE serves "29 May 2026". Returns ISO, or null if it is not a date. */
function isoDate(text) {
  const parsed = Date.parse(`${String(text ?? '').trim()} UTC`);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}

/**
 * Read one purpose string.
 *
 * Returns null when the purpose is not a mechanical price event at all, an
 * object with a factor when the string carries one, and an object with
 * `quantifiable: false` when it names a real price event without the numbers.
 * `kind: 'unrecognised'` is the failure case and is the only one that goes red.
 */
export function readPurpose(purpose) {
  const text = String(purpose ?? '').trim();

  for (const shape of PRICE_AFFECTING) {
    const match = text.match(shape.test);
    if (!match) continue;
    const factor = shape.factor(match);
    if (!Number.isFinite(factor) || !(factor > 0)) {
      return { kind: shape.kind, priceFactor: null, quantifiable: false, rule: shape.rule };
    }
    return { kind: shape.kind, priceFactor: Number(factor.toFixed(6)), quantifiable: true, rule: shape.rule };
  }

  for (const shape of UNQUANTIFIABLE) {
    if (shape.test.test(text)) {
      return { kind: shape.kind, priceFactor: null, quantifiable: false, rule: null };
    }
  }

  if (NOT_MECHANICAL.some((shape) => shape.test(text))) return null;

  // Something we have never seen. It might move a price and it might not, and
  // guessing either way is the thing this file exists to avoid — so it is
  // surfaced as a failure and a human decides which list it belongs on.
  return { kind: 'unrecognised', priceFactor: null, quantifiable: false, rule: null };
}

async function fetchScrip(scripCode) {
  try {
    const response = await fetch(`${API}/DefaultData/w?scripcode=${encodeURIComponent(scripCode)}`, {
      headers: { 'user-agent': UA, referer: 'https://www.bseindia.com/', accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const json = await response.json();
    if (!Array.isArray(json)) return { ok: false, reason: 'response was not a JSON array' };
    return { ok: true, rows: json };
  } catch (error) {
    return { ok: false, reason: `network: ${error.name === 'TimeoutError' ? 'timed out' : error.message}` };
  }
}

async function run() {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : null;

  process.stdout.write('\nCorporate actions — BSE per-scrip history\n\n');

  const companiesFile = JSON.parse(readFileSync(join(REPO, 'public/data/companies.json'), 'utf8'));
  const targets = companiesFile.companies
    .filter((c) => c.bseScripCode != null)
    .map((c) => ({ scripCode: String(c.bseScripCode), name: c.name, isin: c.isin, symbol: c.nseSymbol }));
  const universe = limit ? targets.slice(0, limit) : targets;

  process.stdout.write(
    `  ${num(targets.length)} of ${num(companiesFile.companies.length)} companies carry a BSE scrip code`
    + `${limit ? ` — probing the first ${limit}` : ''}\n\n`,
  );

  const byScrip = {};
  const failed = [];
  let done = 0;
  let queue = 0;

  const worker = async () => {
    while (queue < universe.length) {
      const target = universe[queue];
      queue += 1;
      const result = await fetchScrip(target.scripCode);
      done += 1;
      if (done % 100 === 0) process.stdout.write(`  ${done} of ${universe.length}\n`);
      if (!result.ok) {
        // A FAILURE IS NOT AN EMPTY HISTORY — 2.4. A scrip we could not read has
        // UNKNOWN actions, which is a different fact from "no actions", and the
        // difference decides whether its return may be shown at all.
        failed.push({ scripCode: target.scripCode, name: target.name, reason: result.reason });
        continue;
      }
      const actions = [];
      for (const row of result.rows) {
        const date = isoDate(row.Ex_date);
        const read = readPurpose(row.Purpose);
        if (!read) continue;              // a dividend or a meeting; not structural
        actions.push({
          exDate: date,
          exDateRaw: String(row.Ex_date ?? '').trim() || null,
          purpose: String(row.Purpose ?? '').trim(),
          kind: read.kind,
          priceFactor: read.priceFactor,
          // TRUE only when a factor was recovered. An action a reader can see
          // named but cannot see quantified is the point of this field.
          quantifiable: read.quantifiable,
          factorRule: read.rule,
        });
      }
      actions.sort((a, b) => String(a.exDate).localeCompare(String(b.exDate)));
      byScrip[target.scripCode] = { symbol: target.symbol, isin: target.isin, actions };
      await new Promise((resolve) => { setTimeout(resolve, GAP_MS); });
    }
  };

  const started = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);

  const read = Object.keys(byScrip).length;
  const withAction = Object.values(byScrip).filter((s) => s.actions.length > 0).length;
  const unrecognised = Object.values(byScrip)
    .flatMap((s) => s.actions.filter((a) => a.kind === 'unrecognised'));
  const unquantifiable = Object.values(byScrip)
    .flatMap((s) => s.actions.filter((a) => a.kind !== 'unrecognised' && !a.quantifiable));

  process.stdout.write(
    `\n  read ${num(read)} of ${num(universe.length)} scrips in ${elapsed}s · failed ${num(failed.length)}\n`
    + `  ${num(withAction)} carry at least one price-affecting action · `
    + `${num(unquantifiable.length)} action(s) named without a ratio · `
    + `${num(unrecognised.length)} purpose(s) we have never seen\n\n`,
  );

  // Everything inside the two most recent review windows, which is what the
  // relative-performance model has to know about.
  const priceHistoryPath = join(REPO, 'public/data/price-history.json');
  let windowFrom = null;
  let windowTo = null;
  if (existsSync(priceHistoryPath)) {
    const ph = JSON.parse(readFileSync(priceHistoryPath, 'utf8'));
    windowFrom = ph.windows?.[0]?.from ?? null;
    windowTo = ph.windows?.[ph.windows.length - 1]?.to ?? null;
  }
  if (windowFrom && windowTo) {
    const inQuarter = [];
    for (const [code, entry] of Object.entries(byScrip)) {
      for (const action of entry.actions) {
        if (action.exDate && action.exDate >= windowFrom && action.exDate <= windowTo) {
          inQuarter.push({ code, symbol: entry.symbol, ...action });
        }
      }
    }
    process.stdout.write(`  inside the review quarter ${windowFrom} .. ${windowTo}:\n\n`);
    process.stdout.write(renderTable(
      [
        { key: 'symbol', label: 'Symbol', align: 'left' },
        { key: 'exDate', label: 'Ex-date', align: 'left' },
        { key: 'purpose', label: 'BSE\'s own words', align: 'left' },
        { key: 'factor', label: 'Price ÷', align: 'right' },
      ],
      inQuarter.map((a) => ({
        symbol: a.symbol ?? a.code,
        exDate: a.exDate,
        purpose: a.purpose.slice(0, 38),
            factor: a.priceFactor === null ? `${a.kind} — no ratio published` : a.priceFactor.toFixed(4),
      })),
    ));
    process.stdout.write('\n');
  }

  // ---- guards ------------------------------------------------------------
  const checks = [];
  const check = (okay, label, detail) => { checks.push({ ok: okay, label, detail }); };

  check(read >= universe.length * 0.95, 'at least 95% of scrips answered',
    `${num(read)} of ${num(universe.length)}`);
  // THE POSITIVE CONTROL, again. An action feed that finds no actions across the
  // whole universe is indistinguishable from a broken one.
  check(withAction > 0, 'the feed carries actions at all — none across the universe means it is broken',
    `${num(withAction)} scrip(s)`);
  // The guard is on RECOGNITION, not on quantification. "Right Issue of Equity
  // Shares" carries no ratio at the source and never will; a purpose we have
  // never seen is the thing that needs a human, because it might be a bonus in
  // wording we do not match and would then pass through as a clean return.
  check(unrecognised.length === 0,
    'every purpose is recognised — a new wording could be a bonus we fail to see',
    [...new Set(unrecognised.map((a) => `"${a.purpose}"`))].slice(0, 5).join(' | ') || 'none');
  // Both categories must be non-empty on a universe this size, or the
  // classifier has collapsed into one branch and stopped discriminating.
  check(unquantifiable.length > 0 || universe.length < 100,
    'the unquantifiable category is populated — a classifier with one live branch is not classifying',
    `${num(unquantifiable.length)} action(s)`);

  const failures = checks.filter((c) => !c.ok);
  for (const c of checks) process.stdout.write(`  ${c.ok ? 'ok   ' : 'FAIL '} ${c.label} — ${c.detail}\n`);

  if (limit) {
    process.stdout.write(`\n  --limit ${limit}: this was a probe. Nothing written.\n\n`);
    return;
  }
  if (failures.length > 0) {
    process.stderr.write(`\nREFUSING TO WRITE — ${failures.length} check(s) failed.\n\n`);
    process.exit(1);
  }

  const payload = {
    source: `BSE — ${API}/DefaultData/w?scripcode=N, one request per scrip`,
    note: 'Ex_date and Purpose are BSE\'s own strings, carried through unchanged. priceFactor is OUR '
      + 'reading of the purpose text — the number a price is DIVIDED by across the ex-date, i.e. how '
      + 'many shares one share became — and factorRule names the rule that produced it so it can be '
      + 'checked rather than trusted. A purpose naming something structural that we could not read is '
      + 'priceFactor null with parsed false, never 1.0: a factor of 1 would assert the action does not '
      + 'move the price, which is a claim; null says we did not read it, which is the truth.',
    scope: 'Only price-affecting purposes are kept. Dividends are excluded on purpose: an ex-dividend '
      + 'drop is a real price change a real holder experiences, and the index leg is a price return '
      + 'with distributions stripped the same way, so adjusting one leg and not the other would put '
      + 'them on different conventions.',
    capturedAt: new Date().toISOString(),
    universeFrom: 'the BSE scrip codes present in companies.json',
    scripsRequested: universe.length,
    scripsRead: read,
    scripsWithAction: withAction,
    // A scrip in here has UNKNOWN actions, which is not the same as none.
    failed,
    scrips: byScrip,
  };

  if (existsSync(OUT_PATH) && !process.argv.includes('--allow-shrink')) {
    const previous = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
    if (read < (previous.scripsRead ?? 0)) {
      process.stderr.write(
        `\nRefusing to shrink: ${num(previous.scripsRead)} scrips on file, ${num(read)} in this run.\n`
        + 'Pass --allow-shrink if the universe genuinely got smaller.\n\n',
      );
      process.exit(1);
    }
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(payload)}\n`, 'utf8');
  process.stdout.write(`\nWrote ${OUT_PATH.replace(REPO + '/', '')} — ${num(read)} scrips, ${num(withAction)} with an action.\n\n`);
}

// Only when RUN, never when imported. verify-data imports readPurpose to test
// the classifier against the committed record, and a bare run() at module scope
// meant that import started a four-minute scrape of BSE as a side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    process.stderr.write(`\nUnhandled failure: ${error?.stack || error}\n\n`);
    process.exit(1);
  });
}
