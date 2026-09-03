#!/usr/bin/env node
/**
 * fetch-price-history.mjs — each scrip's close across two MSCI price windows
 *                           -> public/data/price-history.json
 *
 *   node scripts/fetch-price-history.mjs               the two most recent CLOSED windows
 *   node scripts/fetch-price-history.mjs --review 2026-08
 *   node scripts/fetch-price-history.mjs --limit 4     first 4 sessions; WRITES NOTHING
 *
 * Zero dependencies. BSE has no bot protection, so plain fetch with a browser
 * user-agent and a referer is the whole requirement — see CLAUDE.md 3.8.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS: THE ONE-YEAR PROXY IS A DIFFERENT QUANTITY, NOT A NOISIER ONE
 * ---------------------------------------------------------------------------
 * The desk asked how a company performed against its segment from one review to
 * the next. The repo held one trading day of prices, so a first design reached
 * for the nearest thing available — Munshot's `yearlyChangePct` over a nominal
 * year — and deferred the real window to February 2027.
 *
 * Both readings were then computed for the same companies. For the 738 carrying
 * both, they disagree about whether the company out- or under-performed on 201
 * of 738 rows — 27.2%. On 117 of those (15.9% of all rows) BOTH readings exceed
 * 5 pp, so it is not two near-zero numbers jittering around parity; it is a
 * confident "+40.7 pp outperforming" against a confident "-5.3 pp
 * underperforming" for the same company (KEI). The proxy shares units with the
 * target quantity and is not a measurement of it.
 *
 * And the real window was never uncomputable. lib/bhavcopy.mjs is fully
 * date-parameterised and BSE serves the archive: all 20 business days of both
 * windows return a valid CSV whose own TradDt matches the date requested. What
 * was missing was a script, not data.
 *
 * ---------------------------------------------------------------------------
 * ⚠ RAW CLOSES ACROSS A BONUS ISSUE ARE A COLLAPSE THAT NEVER HAPPENED
 * ---------------------------------------------------------------------------
 * LICI closed at 829.90 on 27 May 2026 and at 411.45 on the 29th. Nothing went
 * wrong: it went ex-bonus 1:1. Read as a raw series that is -50.4%, and seven
 * such events fall inside the May->August 2026 quarter alone.
 *
 * This file does NOT try to detect them, and the first version's failure is
 * worth keeping on the record. It inferred actions from the bhavcopy itself, on
 * the premise that BSE adjusts `PrvsClsgPric` across an action — so a
 * disagreement with the previous session's close would be the action, free, for
 * every scrip. BSE does not: LICI's PrvsClsgPric on its own ex-date is 829.90,
 * exactly the raw close of the 27th. Continuity holds across a bonus and the
 * event is invisible to it. That detector found 0 actions across 303,018
 * comparisons in a quarter known to contain seven, and only a positive control —
 * "finding nothing means you are broken" — stopped it being written.
 *
 * Corporate actions therefore come from BSE's own published history, in
 * `fetch-corporate-actions.mjs`. The continuity check below stays, but as what
 * it actually is: an INTEGRITY check that the two sessions either side of a gap
 * are the sessions they claim to be. It is not, and never was, an action
 * detector.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS STORED, AND WHY IT IS THE RAW FIGURE
 * ---------------------------------------------------------------------------
 * `closes` are BSE's own published closes, unadjusted — tier 1, carried through
 * unchanged (2.1). `actions` is our derivation from them, labelled as ours, with
 * the arithmetic on the record so a reader can redo it. A consumer applies the
 * adjustment; this file does not bake one in. Storing an adjusted price would
 * put a number on the record that no exchange ever published.
 *
 * `firstSeen` distinguishes the two reasons a close is absent. A scrip that was
 * not yet listed and a scrip that did not trade are different facts, and index
 * -aligned nulls cannot tell them apart on their own (2.3, 2.4).
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { renderTable, num } from './lib/report.mjs';
import { bhavcopyUrl, assertBhavcopyShape, parseBhavcopy } from './lib/bhavcopy.mjs';
import { reviewCutoffs, REVIEW_MONTHS, closedReviews } from '../public/js/model/calendar.js';
import { REBALANCE_BASELINE } from '../public/js/config/thresholds.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const OUT_PATH = join(REPO, 'public/data/price-history.json');
const MASTER_PATH = join(REPO, 'public/data/bse-scrip-master.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const GAP_MS = 350;

/**
 * A close and the next session's PrvsClsgPric agree to the paisa in the normal
 * case — measured 303,018 comparisons across this quarter with 0 breaks. The
 * threshold is a rounding allowance, not a noise floor.
 */
const CONTINUITY_TOLERANCE_INR = 0.011;

/** Below this the window is not a window and nothing may be measured over it. */
const MIN_SESSIONS_PER_WINDOW = 8;

/**
 * A non-session is not a failure. BSE answers a URL for a date it has no file
 * for with its single-page-app shell: HTTP 200, content-type text/html, ~14 KB,
 * every time and identically. That is a weekend or an exchange holiday. Any
 * OTHER shape failure is a real problem and is recorded as one — the two must
 * not be folded together, or a format change would read as a long holiday.
 */
const looksLikeNonSession = (text, contentType) =>
  /html/i.test(contentType ?? '') && text.length < 50000 && !/TradDt/.test(text);

function parseArgs(argv) {
  const args = { review: null, limit: null, allowShrink: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--review') { args.review = argv[i + 1]; i += 1; }
    else if (argv[i] === '--limit') { args.limit = Number(argv[i + 1]); i += 1; }
    else if (argv[i] === '--allow-shrink') { args.allowShrink = true; }
  }
  return args;
}

/** Every calendar date from `from` to `to` inclusive, weekends dropped. */
function businessDates(from, to) {
  const dates = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/**
 * The two most recent reviews whose price window has CLOSED.
 *
 * A window that has not closed is a genuine, unfixable absence and must never be
 * measured over — this is the one state that stays "not computable" honestly.
 * The comparison is against the newest date the exchange has actually served,
 * never against the clock, so a build does not depend on when it ran.
 */
function closedWindows(latestSessionDate, explicitReview) {
  const candidates = [];
  const [y0] = latestSessionDate.split('-').map(Number);
  for (let year = y0 - 2; year <= y0 + 1; year += 1) {
    for (const month of REVIEW_MONTHS) {
      const cutoffs = reviewCutoffs(year, month);
      candidates.push({
        review: `${year}-${String(month).padStart(2, '0')}`,
        from: cutoffs.price.from,
        to: cutoffs.price.to,
        note: cutoffs.price.note,
        source: cutoffs.source,
      });
    }
  }
  candidates.sort((a, b) => a.to.localeCompare(b.to));
  const closed = candidates.filter((c) => c.to <= latestSessionDate);
  if (explicitReview) {
    const index = closed.findIndex((c) => c.review === explicitReview);
    if (index < 1) {
      throw new Error(
        `--review ${explicitReview} is not a review with a closed window and a closed predecessor. `
        + `Closed windows: ${closed.map((c) => c.review).join(', ')}`,
      );
    }
    return [closed[index - 1], closed[index]];
  }
  if (closed.length < 2) throw new Error('fewer than two review windows have closed');
  return closed.slice(-2);
}

/** `n` business days either side of `date`, inclusive of `date` itself. */
function businessDaysAround(date, n) {
  const step = (from, direction) => {
    const cursor = new Date(`${from}T00:00:00Z`);
    let counted = 0;
    while (counted < n) {
      cursor.setUTCDate(cursor.getUTCDate() + direction);
      const day = cursor.getUTCDay();
      if (day !== 0 && day !== 6) counted += 1;
    }
    return cursor.toISOString().slice(0, 10);
  };
  return { from: step(date, -1), to: step(date, +1) };
}

/**
 * The REBALANCE-DATE baselines — a different question from the price windows.
 *
 * `closedWindows` above returns the ten-day windows MSCI struck its market caps
 * in. These are the days the resulting composition took EFFECT and every
 * tracking fund actually traded. For the May 2026 review that is 29 May against
 * 17-30 April: six weeks apart, and the desk's question is baselined on the
 * former.
 *
 * Each baseline carries a span of business days either side of the effective
 * date. That is NOT a widening of the baseline — the point estimate is struck on
 * the effective date itself. It is the input to a sensitivity test: if the
 * baseline had been a session or two either side, would the sign survive?
 */
function baselineSpans(latestSessionDate) {
  const reviews = closedReviews(latestSessionDate, REBALANCE_BASELINE.offerCount);
  return reviews
    .filter((r) => r.effectiveDate <= latestSessionDate)
    .map((r) => {
      const around = businessDaysAround(r.effectiveDate, REBALANCE_BASELINE.sensitivityDays);
      return {
        review: r.review,
        label: r.label,
        effectiveDate: r.effectiveDate,
        from: around.from,
        // A sensitivity day AFTER the newest served session does not exist yet.
        // Clamping keeps the span honest rather than recording a phantom date.
        to: around.to > latestSessionDate ? latestSessionDate : around.to,
        sensitivityDays: REBALANCE_BASELINE.sensitivityDays,
      };
    });
}

async function fetchSession(date) {
  let response;
  try {
    response = await fetch(bhavcopyUrl(date), {
      headers: { 'user-agent': UA, referer: 'https://www.bseindia.com/' },
      signal: AbortSignal.timeout(60000),
    });
  } catch (error) {
    return { state: 'failed', reason: `network: ${error.name === 'TimeoutError' ? 'timed out' : error.message}` };
  }
  const contentType = response.headers.get('content-type');
  const text = await response.text();
  if (looksLikeNonSession(text, contentType)) return { state: 'non-session' };
  if (!response.ok) return { state: 'failed', reason: `HTTP ${response.status}` };

  // SHAPE, NEVER STATUS — 3.8. A 200 is not a contract.
  const shape = assertBhavcopyShape(text, { expectDate: date, contentType });
  if (!shape.ok) return { state: 'failed', reason: shape.problems.join('; ') };
  return { state: 'ok', parsed: parseBhavcopy(text), bytes: text.length };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  process.stdout.write('\nPer-stock price history — BSE bhavcopy across two MSCI price windows\n\n');

  if (!existsSync(MASTER_PATH)) {
    process.stderr.write('\npublic/data/bse-scrip-master.json is missing. Run fetch-bse-master.mjs first.\n\n');
    process.exit(1);
  }
  // THE UNIVERSE COMES FROM THE ACTIVE MASTER, never from a hand-entered list and
  // never from our own curated set — 3.8. A curated set drifts as coverage moves
  // and would silently redefine what "the universe" means between two runs.
  const master = JSON.parse(readFileSync(MASTER_PATH, 'utf8'));
  const known = new Map((master.scrips ?? []).map((s) => [String(s.scripCode), s]));
  process.stdout.write(`  universe: ${num(known.size)} active equity scrips from the BSE master\n`);

  // The latest session the exchange has actually served bounds which windows are
  // closed. Anchored on the committed prices file, not on the clock.
  const prices = JSON.parse(readFileSync(join(REPO, 'public/data/prices.json'), 'utf8'));
  const windows = closedWindows(prices.tradeDate, args.review);
  const baselines = baselineSpans(prices.tradeDate);
  process.stdout.write(
    `  windows:   ${windows.map((w) => `${w.review} (${w.from}..${w.to})`).join('  ->  ')}\n`
    + `  baselines: ${baselines.map((b) => `${b.review} eff ${b.effectiveDate} (${b.from}..${b.to})`).join('  ·  ')}\n`
    + `  anchored on the newest committed trade date ${prices.tradeDate}, not on the clock\n\n`,
  );

  // ONLY THE WINDOW DAYS. The first version walked all 73 business days between
  // the two windows so an action detector could keep an unbroken chain; that
  // detector was wrong (see the header) and the 53 sessions between the windows
  // bought nothing. 20 requests, about a minute.
  const windowDates = new Set(windows.flatMap((w) => businessDates(w.from, w.to)));
  // The baseline spans are fetched on the SAME pass. Kept as their own set so a
  // guard can tell which of the two a failed session belongs to: a hole in a
  // price window and a hole in a sensitivity span are different problems.
  const baselineDates = new Set(baselines.flatMap((b) => businessDates(b.from, b.to)));
  const keptDates = new Set([...windowDates, ...baselineDates]);
  let span = [...keptDates].sort();
  if (args.limit) span = span.slice(0, args.limit);

  // Every contiguous stretch continuity may be asserted across. Comparing two
  // sessions from different spans would compare across a gap of weeks and fail
  // on every scrip, which would mean nothing.
  const spans = [
    ...windows.map((w) => ({ from: w.from, to: w.to })),
    ...baselines.map((b) => ({ from: b.from, to: b.to })),
  ];

  // ---- walk the span, in order ------------------------------------------
  const closesByScrip = new Map();      // scripCode -> Map(date -> close)
  const firstSeen = new Map();          // scripCode -> first date it appeared at all
  const meta = new Map();               // scripCode -> {symbol, isin, name}
  let previousCloses = null;            // Map(scripCode -> close) from the last session
  let previousDate = null;
  const sessions = [];
  const nonSessions = [];
  const failed = [];
  const continuityBreaks = [];
  let continuityCompared = 0;

  for (const date of span) {
    const result = await fetchSession(date);
    await new Promise((resolve) => { setTimeout(resolve, GAP_MS); });

    if (result.state === 'non-session') { nonSessions.push(date); continue; }
    if (result.state === 'failed') {
      // A FAILURE IS NOT AN ABSENCE — 2.4. It is named, it is counted, and it
      // stops the write below if it lands inside a window.
      failed.push({ date, reason: result.reason });
      process.stdout.write(`  ${date}  FAILED — ${result.reason}\n`);
      previousCloses = null;   // the chain is broken; do not compare across the gap
      continue;
    }

    const rows = result.parsed.rows.filter((r) => known.has(r.scripCode) && r.close !== null);
    const closesNow = new Map();
    // The two windows are ten sessions each with 53 sessions between them, so
    // continuity may only be asserted INSIDE a window. Comparing across the gap
    // would fail on every scrip and mean nothing.
    const adjacent = previousDate !== null
      && sessions.length > 0
      && spans.some((w) => previousDate >= w.from && date <= w.to);
    let breaksToday = 0;

    for (const row of rows) {
      closesNow.set(row.scripCode, row.close);
      if (!firstSeen.has(row.scripCode)) firstSeen.set(row.scripCode, date);
      if (!meta.has(row.scripCode)) {
        meta.set(row.scripCode, { symbol: row.symbol, isin: row.isin, name: row.name });
      }
      if (keptDates.has(date)) {
        if (!closesByScrip.has(row.scripCode)) closesByScrip.set(row.scripCode, new Map());
        closesByScrip.get(row.scripCode).set(date, row.close);
      }

      // ---- the integrity check, on ADJACENT sessions only ----------------
      // Today's PrvsClsgPric must be yesterday's ClsPric. This says the two
      // files are the consecutive sessions they claim to be — it catches a
      // stale row copied forward, which a file-level TradDt check cannot see.
      // It is NOT an action detector: BSE carries PrvsClsgPric unadjusted, so a
      // bonus passes this cleanly. See the header.
      if (previousCloses && adjacent && row.prevClose !== null) {
        const before = previousCloses.get(row.scripCode);
        if (before !== undefined && before > 0 && row.prevClose > 0) {
          continuityCompared += 1;
          if (Math.abs(before - row.prevClose) > CONTINUITY_TOLERANCE_INR) {
            continuityBreaks.push({
              date, scripCode: row.scripCode, symbol: row.symbol,
              yesterdayClose: before, todayPrevClose: row.prevClose,
            });
            breaksToday += 1;
          }
        }
      }
    }

    previousCloses = closesNow;
    previousDate = date;
    sessions.push({ date, rows: rows.length, inWindow: windowDates.has(date), inBaseline: baselineDates.has(date) });
    process.stdout.write(
      `  ${date}  ${String(rows.length).padStart(5)} scrips`
      + `${windowDates.has(date) ? '  [window]  ' : baselineDates.has(date) ? '  [baseline]' : '           '}`
      + `${breaksToday ? `  ${breaksToday} CONTINUITY BREAK(S)` : ''}\n`,
    );
  }

  // ---- what did the windows actually get? --------------------------------
  const perWindow = windows.map((w) => {
    const dates = sessions.filter((s) => s.date >= w.from && s.date <= w.to).map((s) => s.date);
    return { ...w, dates, sessions: dates.length };
  });

  const perBaseline = baselines.map((b) => {
    const dates = sessions.filter((s) => s.date >= b.from && s.date <= b.to).map((s) => s.date);
    // ⚠ THE EFFECTIVE DATE MAY NOT BE AN INDIAN SESSION. MSCI's effective date
    // is a global index date and the Indian market can be shut on it. The
    // baseline then resolves to the nearest EARLIER session in the span, and
    // `resolvedDate`/`walkedBackDays` say so — never silently.
    const onOrBefore = dates.filter((d) => d <= b.effectiveDate);
    const resolved = onOrBefore.length ? onOrBefore[onOrBefore.length - 1] : null;
    return {
      ...b,
      dates,
      sessions: dates.length,
      resolvedDate: resolved,
      walkedBackDays: resolved
        ? Math.round((Date.parse(b.effectiveDate) - Date.parse(resolved)) / 86400000)
        : null,
      tradedOnEffectiveDate: resolved === b.effectiveDate,
    };
  });

  process.stdout.write('\n');
  process.stdout.write(renderTable(
    [
      { key: 'review', label: 'Review', align: 'left' },
      { key: 'window', label: 'Price window', align: 'left' },
      { key: 'sessions', label: 'Sessions', align: 'right' },
    ],
    perWindow.map((w) => ({ review: w.review, window: `${w.from} .. ${w.to}`, sessions: String(w.sessions) })),
  ));

  process.stdout.write(
    `\n\n  sessions fetched ${num(sessions.length)} · non-sessions (weekend or holiday) ${num(nonSessions.length)}`
    + ` · failed ${num(failed.length)}\n`
    + `  continuity comparisons ${num(continuityCompared)} within windows · breaks ${num(continuityBreaks.length)}\n\n`,
  );

  if (continuityBreaks.length > 0) {
    process.stdout.write(renderTable(
      [
        { key: 'symbol', label: 'Scrip', align: 'left' },
        { key: 'date', label: 'On', align: 'left' },
        { key: 'was', label: "Yesterday's close", align: 'right' },
        { key: 'now', label: "Today's PrvsClsg", align: 'right' },
      ],
      continuityBreaks.slice(0, 10).map((b) => ({
        symbol: b.symbol ?? b.scripCode,
        date: b.date,
        was: String(b.yesterdayClose),
        now: String(b.todayPrevClose),
      })),
    ));
    process.stdout.write('\n');
  }

  // ---- guards, before anything is written --------------------------------
  const checks = [];
  const check = (okay, label, detail) => { checks.push({ ok: okay, label, detail }); };

  for (const w of perWindow) {
    check(w.sessions >= MIN_SESSIONS_PER_WINDOW,
      `${w.review}'s price window has at least ${MIN_SESSIONS_PER_WINDOW} sessions`,
      `${w.sessions} session(s) in ${w.from}..${w.to}`);
  }
  const failedInWindow = failed.filter((f) => windowDates.has(f.date));
  check(failedInWindow.length === 0, 'no session inside a price window failed to fetch',
    failedInWindow.map((f) => `${f.date}: ${f.reason}`).join(' | ') || 'none');

  // A baseline is a SINGLE day, so a hole in it is not a thinner mean — it is a
  // missing baseline. The span either side exists to test sensitivity, and a
  // sensitivity test over one surviving candidate is not a test.
  for (const b of perBaseline) {
    check(b.resolvedDate !== null,
      `${b.review}'s rebalance date resolves to a session`,
      b.resolvedDate
        ? `${b.effectiveDate} -> ${b.resolvedDate}${b.tradedOnEffectiveDate ? '' : ` (walked back ${b.walkedBackDays}d — India was shut)`}`
        : `no session on or before ${b.effectiveDate} inside ${b.from}..${b.to}`);
    check(b.sessions >= 3,
      `${b.review}'s sensitivity span has at least 3 sessions`,
      `${b.sessions} session(s) in ${b.from}..${b.to}`);
  }
  /*
   * ⚠ A CAPTURE MAY NOT LOSE A BASELINE THE LAST ONE HAD.
   *
   * The set is derived from `closedReviews(prices.tradeDate)`, so a stale price
   * anchor quietly narrows it and the run reports success over a set missing the
   * very rebalance the screen should be baselined on. That is what happened on
   * 1 Sep 2026: the monthly job executed and passed while prices.json was frozen
   * at 28 Aug, so the August review — effective 31 Aug, and closed by then — was
   * never captured, and nothing said so.
   *
   * ⚠ AND THE OBVIOUS GUARD FOR IT CANNOT FAIL. Asking whether
   * `closedReviews(prices.tradeDate, 1)[0]` is among the captured baselines
   * reads the threshold from the value under test: both come from the same
   * anchor, so the newest closed review is in the set BY CONSTRUCTION, whatever
   * the anchor says. Written that way it passes on the exact 1 Sep state it was
   * meant to catch — measured, on anchor 2026-08-28: captured
   * {2026-05, 2026-02, 2025-11, 2025-08}, newest closed 2026-05, guard silent
   * while August is missing. That is §3.8's self-defeating guard, and it was
   * caught by an adversarial review of this very fix.
   *
   * The reference has to be something a stale anchor cannot move: the PREVIOUS
   * committed capture. A set that has lost a baseline the last one held is a
   * narrowing, whatever produced it — the same rule every other writer here
   * follows, and `--allow-shrink` is the deliberate way past it.
   */
  const previousHistory = existsSync(OUT_PATH) ? JSON.parse(readFileSync(OUT_PATH, 'utf8')) : null;
  const heldBefore = (previousHistory?.baselines ?? []).map((b) => b.review);
  const captured = new Set(perBaseline.map((b) => b.review));
  const lost = heldBefore.filter((review) => !captured.has(review));
  check(lost.length === 0 || args.allowShrink,
    'no rebalance baseline the last capture held has been lost',
    lost.length === 0
      ? `${captured.size} captured, ${heldBefore.length} held before`
      : `${lost.join(', ')} disappeared — anchored on prices.tradeDate ${prices.tradeDate}. `
        + 'A narrower set almost always means a stale price anchor: run fetch-bhavcopy.mjs first. '
        + 'Pass --allow-shrink if the reviews genuinely left the offer window.');

  const failedInBaseline = failed.filter((f) => baselineDates.has(f.date));
  check(failedInBaseline.length === 0, 'no session inside a rebalance baseline span failed to fetch',
    failedInBaseline.map((f) => `${f.date}: ${f.reason}`).join(' | ') || 'none');

  check(continuityBreaks.length === 0,
    'no session inside a window carries a row copied from the session before it',
    continuityBreaks.slice(0, 3).map((b) => `${b.symbol ?? b.scripCode} on ${b.date}`).join(' | ') || 'none');

  // A check that compared nothing passes vacuously. This is the denominator for
  // the one above and it has to be asserted separately — 2.5.
  check(continuityCompared > 1000,
    'the integrity check actually compared something — enough scrips across adjacent sessions',
    `${num(continuityCompared)} comparisons`);

  // Corporate actions are NOT detected here; they come from BSE's published
  // history. This asserts the join partner exists, because a window return
  // computed with no action data at all would silently read a bonus as a crash.
  const actionsPath = join(REPO, 'public/data/corporate-actions.json');
  check(existsSync(actionsPath),
    'corporate-actions.json exists — a raw close series is not usable without it',
    existsSync(actionsPath) ? 'present' : 'run scripts/fetch-corporate-actions.mjs');

  const failures = checks.filter((c) => !c.ok);
  for (const c of checks) process.stdout.write(`  ${c.ok ? 'ok   ' : 'FAIL '} ${c.label} — ${c.detail}\n`);

  if (args.limit) {
    process.stdout.write(`\n  --limit ${args.limit}: this was a reachability probe. Nothing written.\n\n`);
    return;
  }
  if (failures.length > 0) {
    process.stderr.write(`\nREFUSING TO WRITE — ${failures.length} check(s) failed.\n\n`);
    process.exit(1);
  }

  // ---- assemble ----------------------------------------------------------
  const dates = [...new Set([...perWindow, ...perBaseline].flatMap((w) => w.dates))].sort();
  const scrips = {};
  for (const [code, byDate] of closesByScrip) {
    const info = meta.get(code) ?? {};
    scrips[code] = {
      symbol: info.symbol ?? null,
      isin: info.isin ?? null,
      // Index-aligned to `dates`. null means the scrip did not trade that
      // session — which is a DIFFERENT fact from "not yet listed", and
      // firstSeen is what separates them. Never 0, never omitted (2.3).
      closes: dates.map((d) => byDate.get(d) ?? null),
      firstSeen: firstSeen.get(code) ?? null,
    };
  }

  const payload = {
    source: 'BSE bhavcopy — www.bseindia.com/download/BhavCopy/Equity, one CSV per trading session',
    note: 'Closes are BSE\'s own published figures, UNADJUSTED for corporate actions and carried '
      + 'through unchanged. An adjusted price is a number no exchange ever published, so this file '
      + 'does not contain one. Corporate actions come from corporate-actions.json, which reads BSE\'s '
      + 'own published history — they CANNOT be inferred from this file, because BSE carries '
      + 'PrvsClsgPric unadjusted and a bonus therefore passes a continuity check cleanly.',
    unit: 'rupees per share',
    capturedAt: new Date().toISOString(),
    scanFrom: span[0] ?? null,
    scanTo: span[span.length - 1] ?? null,
    sessionsScanned: sessions.length,
    nonSessions: nonSessions.length,
    failed,
    continuityCompared,
    continuityBreaks,
    continuityToleranceInr: CONTINUITY_TOLERANCE_INR,
    corporateActions: 'see public/data/corporate-actions.json — actions are not derivable from this file',
    windows: perWindow.map((w) => ({
      review: w.review,
      from: w.from,
      to: w.to,
      dates: w.dates,
      sessions: w.sessions,
      note: w.note,
      source: w.source,
    })),
    /**
     * The rebalance-date baselines — the day each review's composition took
     * EFFECT, which is not the window its market caps were struck in. See
     * REBALANCE_BASELINE in public/js/config/thresholds.mjs.
     */
    baselines: perBaseline.map((b) => ({
      review: b.review,
      label: b.label,
      effectiveDate: b.effectiveDate,
      resolvedDate: b.resolvedDate,
      walkedBackDays: b.walkedBackDays,
      tradedOnEffectiveDate: b.tradedOnEffectiveDate,
      from: b.from,
      to: b.to,
      dates: b.dates,
      sessions: b.sessions,
      sensitivityDays: b.sensitivityDays,
      note: 'The point estimate is struck on resolvedDate. The other dates in this span exist only '
        + 'to test how fragile the answer is to that choice — they do not widen the baseline.',
    })),
    dates,
    scripCount: Object.keys(scrips).length,
    scrips,
  };

  // A writer never replaces a good snapshot with a smaller one.
  if (existsSync(OUT_PATH) && !args.allowShrink) {
    const previous = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
    const was = previous.scripCount ?? 0;
    if (payload.scripCount < was) {
      process.stderr.write(
        `\nRefusing to shrink: ${num(was)} scrips on file, ${num(payload.scripCount)} in this run.\n`
        + 'Pass --allow-shrink if the universe genuinely got smaller.\n\n',
      );
      process.exit(1);
    }
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(payload)}\n`, 'utf8');
  process.stdout.write(
    `\nWrote ${OUT_PATH.replace(REPO + '/', '')} — ${num(payload.scripCount)} scrips × ${dates.length} sessions `
    + `(${perWindow.reduce((n, w) => n + w.sessions, 0)} in price windows, `
    + `${perBaseline.reduce((n, b) => n + b.sessions, 0)} in rebalance baselines).\n\n`,
  );
}

run().catch((error) => {
  process.stderr.write(`\nUnhandled failure: ${error?.stack || error}\n\n`);
  process.exit(1);
});
