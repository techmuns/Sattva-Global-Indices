#!/usr/bin/env node
/**
 * build-rebalance.mjs — what the review actually did, and how the forecast fared.
 *
 *   node scripts/build-rebalance.mjs --review=2026-08
 *
 * Reads the FROZEN forecast (predictions-<review>.json, written before the
 * review took effect) and the CURRENT record (companies.json, built from the
 * post-rebalance workbooks), and writes rebalance-<review>.json.
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING THAT MAKES THIS WORTH READING
 * ---------------------------------------------------------------------------
 * The forecast is never recomputed here. It is read from a file that could only
 * be written from a record predating the effective date. Recomputing verdicts
 * against post-rebalance holdings would score the model on the answer sheet and
 * would look excellent. See snapshot-predictions.mjs.
 *
 * ---------------------------------------------------------------------------
 * ⚠ ONLY A RE-READ FUND IS EVIDENCE ABOUT WHAT CHANGED
 * ---------------------------------------------------------------------------
 * EEM and SMIN were re-downloaded after the August 2026 review; EEMS was not.
 * A company that left India Small-Cap at the review is still in the fortnight-old
 * EM Small-Cap file, so a segment derived from all three funds would read it as
 * "still small cap" and score the exit as a miss that never happened.
 *
 * So both sides of every comparison are restricted to the funds whose workbook
 * actually moved between the snapshot and now. That is measured per fund from
 * the dates — never a hard-coded list — and the funds left out are named on the
 * output, because "we did not look" and "nothing happened" are different facts.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { STANDARD_FUND, SMALLCAP_FUNDS, SEGMENTS } from '../public/js/model/segments.js';
import { SEGMENT_OVERLAP, AUGUST_2026_CALIBRATION } from '../public/js/config/thresholds.mjs';
import { assess } from '../public/js/model/assess.js';
import { observedSizeCutoffs } from '../public/js/model/thresholds.js';
import { renderTable, num } from './lib/report.mjs';
import { CheckList } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const DATA = join(REPO, 'public', 'data');

/**
 * What a verdict CLAIMED would happen, as an event key. `stable` claims the
 * absence of an event, which is a claim too — just a much cheaper one to get
 * right, which is why it is scored in its own block.
 */
const VERDICT_CLAIMS = {
  'likely-inclusion': 'entered',
  'possible-inclusion': 'entered',
  'likely-exclusion': 'exited',
  'exclusion-risk': 'exited',
  'migration-up': 'migration-up',
  'migration-down': 'migration-down',
  stable: 'no-change',
  unknown: null, // an explicit refusal to call it — never scored as either
};

export const EVENTS = {
  entered: { key: 'entered', label: 'Entered the index', detail: 'Outside MSCI India IMI before the review, a constituent after it.' },
  exited: { key: 'exited', label: 'Left the index', detail: 'A constituent before the review, outside MSCI India IMI after it.' },
  'migration-up': { key: 'migration-up', label: 'Migrated up', detail: 'Moved from the Small Cap segment into Standard: small-cap funds sell, the EM ETF buys.' },
  'migration-down': { key: 'migration-down', label: 'Migrated down', detail: 'Moved from Standard into Small Cap: the EM ETF sells, small-cap funds buy.' },
  'no-change': { key: 'no-change', label: 'No segment change', detail: 'In the same segment before and after. Its weight may still have moved.' },
};

/**
 * Segment, considering only the funds named in `allowed`.
 *
 * Mirrors model/segments.js — including the overlap tie-break — but over a
 * restricted fund set, because a fund whose workbook did not move carries no
 * evidence about what this review did.
 */
export function segmentFrom(funds, allowed) {
  const standard = allowed.includes(STANDARD_FUND) ? funds?.[STANDARD_FUND] ?? null : null;
  const scFund = SMALLCAP_FUNDS.filter((f) => allowed.includes(f)).find((f) => funds?.[f]);
  const smallCap = scFund ? funds[scFund] : null;
  if (standard && !smallCap) return 'standard';
  if (!standard && smallCap) return 'smallcap';
  if (!standard && !smallCap) return 'outside';
  // Both, on files of the same date: the larger position decides (SEGMENT_OVERLAP).
  return (standard.marketValueUsd ?? -1) >= (smallCap.marketValueUsd ?? -1) ? 'standard' : 'smallcap';
}

/** Old segment -> new segment, as one of EVENTS. */
export function eventFor(before, after) {
  if (before === after) return 'no-change';
  if (before === 'outside') return 'entered';
  if (after === 'outside') return 'exited';
  if (before === 'smallcap' && after === 'standard') return 'migration-up';
  if (before === 'standard' && after === 'smallcap') return 'migration-down';
  return 'no-change';
}

/**
 * ---------------------------------------------------------------------------
 * WHAT THE MODEL WOULD SAY NOW, ABOUT A REVIEW IT WAS CHANGED AFTER
 * ---------------------------------------------------------------------------
 * The scorecard above is the record: it is what was actually forecast, and
 * nothing may change it. But the rules were rewritten BECAUSE of what that
 * scorecard showed (AUGUST_2026_CALIBRATION), and a change made for a reason has
 * to be able to show that it addresses the reason.
 *
 * So the CURRENT rules are replayed over the FROZEN inputs — the sizes, segments
 * and fund membership as they stood on 17 Aug 2026, from predictions-<review>.json
 * and from nothing else — and scored against the same outcome.
 *
 * ⚠ THIS FIGURE IS IN-SAMPLE AND IT IS NOT A TRACK RECORD.
 *
 * The rules were designed knowing this outcome. No threshold in them was fitted
 * to it — every ratio is MSCI's, cited to a page, and every rupee cutoff is
 * derived from a constituent count — but the DECISION to use MSCI's geometry
 * rather than the desk's bands was taken after reading the result. A model
 * scored on the review that motivated it is answering a question it has already
 * seen. `inSample: true` travels with the number, every surface repeats it, and
 * CLAUDE.md §2.13 is unchanged: one review is one data point and there is still
 * no probability anywhere in this product.
 *
 * ⚠ AND TWO INPUTS COULD NOT BE RECONSTRUCTED, so they are stated rather than
 * guessed:
 *
 *  - `floatFactor` is recovered as freeFloatMcap / fullMcap. That is its
 *    definition (§2.9) and both halves are on the snapshot, so it is exact — not
 *    an approximation.
 *  - `segmentReturns` is NOT on the snapshot, so the desk's bands are replayed
 *    UNFLOATED. That changes nothing about a verdict, because after this change
 *    no verdict branches on a desk band; it is recorded because a reader
 *    comparing the desk-band rule between the two runs would otherwise see a
 *    difference with no stated cause.
 *  - the quarantine set is recovered from the snapshot's own deciding rule,
 *    which names `share-count-quarantined` where it fired.
 */
function scoreRetrospectively(predictions, rows, asForecast) {
  const eventByIsin = new Map(rows.map((r) => [r.isin, r.event]));

  // Rebuild just enough of a company record for the rules engine, from the
  // frozen snapshot alone. Nothing from the post-rebalance record is read.
  const frozen = predictions.companies.map((c) => ({
    isin: c.isin,
    name: c.name,
    nseSymbol: c.nseSymbol ?? null,
    segment: c.segment,
    freeFloatMcapInr: c.freeFloatMcapInr ?? null,
    fullMcapInr: c.fullMcapInr ?? null,
    floatFactor: Number.isFinite(c.freeFloatMcapInr) && Number.isFinite(c.fullMcapInr) && c.fullMcapInr > 0
      ? c.freeFloatMcapInr / c.fullMcapInr
      : null,
    funds: c.funds ?? {},
    held: c.held === true,
  }));

  const keyOf = (c) => c.isin;
  const quarantined = new Set(predictions.companies
    .filter((c) => c.decidingRule?.key === 'share-count-quarantined')
    .map((c) => c.isin));
  const sizeCutoffs = observedSizeCutoffs(frozen, (c) => c.segment);
  const context = { quarantined, keyOf, segmentReturns: null, sizeCutoffs };

  const tally = {};
  let flagged = 0;
  let flaggedAndMoved = 0;
  let flaggedRight = 0;
  const namedIsins = new Set();
  const matrix = {};
  for (const company of frozen) {
    const { verdict } = assess(company, context);
    tally[verdict] = (tally[verdict] ?? 0) + 1;
    const claim = VERDICT_CLAIMS[verdict] ?? null;
    const event = eventByIsin.get(company.isin) ?? null;
    if (claim === null || event === null) continue;
    matrix[claim] ??= {};
    matrix[claim][event] = (matrix[claim][event] ?? 0) + 1;
    if (claim === 'no-change') continue;
    flagged += 1;
    if (event !== 'no-change') flaggedAndMoved += 1;
    if (event === claim) { flaggedRight += 1; namedIsins.add(company.isin); }
  }

  const moved = rows.filter((r) => r.inForecast && r.event !== 'no-change');

  return {
    label: 'What the rules as they stand today would have said about this review',
    inSample: true,
    caveat:
      'IN-SAMPLE, and not a track record. These rules were designed after this review was scored. No '
      + "threshold in them was fitted to it — every ratio is MSCI's, cited to a page — but the choice "
      + 'of geometry was made knowing the answer. One review is still one data point.',
    replayedFrom: 'predictions-' + predictions.review + '.json, and nothing else',
    unfloatedDeskBands: true,
    sizeCutoffs,
    verdictTally: tally,
    precision: {
      label: 'Of the companies these rules would flag, how many moved',
      flagged,
      moved: flaggedAndMoved,
      rightEvent: flaggedRight,
    },
    recall: {
      label: 'Of the companies that moved, how many these rules would flag',
      moved: moved.length,
      rightEvent: flaggedRight,
    },
    matrix,
    changes: AUGUST_2026_CALIBRATION.changes,
    attribution: AUGUST_2026_CALIBRATION.attribution,
    /** Movers these rules still would not have named, by event. */
    stillMissed: moved
      .filter((r) => !namedIsins.has(r.isin))
      .map((r) => ({ isin: r.isin, name: r.name, event: r.event }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    asForecast: {
      flagged: asForecast.precision.flagged,
      rightEvent: asForecast.precision.rightEvent,
      moved: asForecast.recall.moved,
    },
  };
}

export function buildRebalance(predictions, record) {
  const checks = new CheckList('rebalance');

  // ---- which funds are evidence -----------------------------------------
  // A fund is evidence iff its workbook moved between the snapshot and now.
  const beforeDates = predictions.forecastFrom?.asOf ?? {};
  const afterByFund = record.holdingsAsOfByFund ?? {};
  const snapshotHoldings = beforeDates.isharesHoldings ?? null;
  const fundIds = Object.keys(afterByFund);
  const reRead = fundIds.filter((id) => snapshotHoldings && afterByFund[id] && afterByFund[id] > snapshotHoldings);
  const notReRead = fundIds.filter((id) => !reRead.includes(id));

  checks.assert(reRead.length > 0,
    'at least one fund was re-read after the snapshot, or there is nothing to compare',
    `snapshot holdings ${snapshotHoldings}; funds ${JSON.stringify(afterByFund)}`);
  checks.assert(snapshotHoldings !== null && snapshotHoldings < predictions.effectiveDate,
    'the forecast predates the review it is being scored against',
    `snapshot holdings ${snapshotHoldings} vs effective ${predictions.effectiveDate}`);

  const before = new Map(predictions.companies.map((c) => [c.isin, c]));
  const after = new Map(record.companies.map((c) => [c.isin, c]));

  const rows = [];
  for (const [isin, now] of after) {
    const was = before.get(isin) ?? null;
    const segmentBefore = was ? segmentFrom(was.funds, reRead) : null;
    const segmentAfter = segmentFrom(now.funds, reRead);
    // A company absent from the forecast could not have been predicted. That is
    // its own state — never a miss, and never quietly dropped.
    const event = was ? eventFor(segmentBefore, segmentAfter) : (segmentAfter === 'outside' ? 'no-change' : 'entered');

    const weights = {};
    for (const id of fundIds) {
      const w0 = was?.funds?.[id]?.weightPct ?? null;
      const w1 = now.funds?.[id]?.weightPct ?? null;
      // null on either side is NOT HELD, and a delta against "not held" is not
      // a number — it is an entry or an exit, which the event already says.
      weights[id] = {
        before: w0,
        after: w1,
        deltaPp: w0 !== null && w1 !== null ? w1 - w0 : null,
        comparable: reRead.includes(id),
      };
    }

    rows.push({
      isin,
      name: now.name,
      nseSymbol: now.nseSymbol ?? null,
      event,
      segmentBefore,
      segmentAfter,
      inForecast: Boolean(was),
      predictedVerdict: was?.verdict ?? null,
      predictedClaim: was ? VERDICT_CLAIMS[was.verdict] ?? null : null,
      claimsAMove: was?.claimsAMove ?? false,
      freeFloatMcapInrBefore: was?.freeFloatMcapInr ?? null,
      freeFloatMcapInrAfter: now.freeFloatMcapInr ?? null,
      distancePctAtForecast: was?.distancePct ?? null,
      decidingRule: was?.decidingRule ?? null,
      weights,
    });
  }

  // A company in the forecast but absent from the current record: it left the
  // universe entirely rather than merely the index.
  const droppedFromRecord = [...before.keys()].filter((isin) => !after.has(isin))
    .map((isin) => ({ isin, name: before.get(isin).name, predictedVerdict: before.get(isin).verdict }));

  // ---- the scorecard -----------------------------------------------------
  // Scored ONLY over companies that were in the forecast and carried a callable
  // verdict. `unknown` is an explicit refusal to call and is counted apart:
  // folding it into either column would turn honesty into a score.
  const scorable = rows.filter((r) => r.inForecast && r.predictedClaim !== null);
  const unknownAtForecast = rows.filter((r) => r.inForecast && r.predictedVerdict === 'unknown');
  const notInForecast = rows.filter((r) => !r.inForecast);

  const moved = scorable.filter((r) => r.event !== 'no-change');
  const flagged = scorable.filter((r) => r.claimsAMove);
  const flaggedAndMoved = flagged.filter((r) => r.event !== 'no-change');
  const flaggedRight = flagged.filter((r) => r.event === r.predictedClaim);
  const movedAndFlagged = moved.filter((r) => r.claimsAMove);
  const movedAndCalledRight = moved.filter((r) => r.event === r.predictedClaim);

  const stableCalls = scorable.filter((r) => r.predictedClaim === 'no-change');
  const stableRight = stableCalls.filter((r) => r.event === 'no-change');

  // Confusion matrix: predicted claim × actual event, both keyed the same way.
  const matrix = {};
  for (const row of scorable) {
    const p = row.predictedClaim;
    matrix[p] ??= {};
    matrix[p][row.event] = (matrix[p][row.event] ?? 0) + 1;
  }

  const scorecard = {
    scored: scorable.length,
    ofCompanies: rows.length,
    unknownAtForecast: unknownAtForecast.length,
    notInForecast: notInForecast.length,
    // THE TWO NUMBERS A DESK ACTUALLY WANTS, each with its denominator (§2.5).
    precision: {
      label: 'Of the companies we flagged as moving, how many moved',
      flagged: flagged.length,
      moved: flaggedAndMoved.length,
      rightEvent: flaggedRight.length,
    },
    recall: {
      label: 'Of the companies that moved, how many we flagged',
      moved: moved.length,
      flagged: movedAndFlagged.length,
      rightEvent: movedAndCalledRight.length,
    },
    // Reported, and reported as what it is.
    stable: {
      label: 'No-change calls that held',
      calls: stableCalls.length,
      right: stableRight.length,
      caveat:
        'A universe that mostly does not move makes these nearly free. This figure is a true-negative '
        + 'rate, it will always look high, and it is not evidence the model works.',
    },
    matrix,
  };

  const eventTally = {};
  for (const row of rows) eventTally[row.event] = (eventTally[row.event] ?? 0) + 1;

  const retrospective = scoreRetrospectively(predictions, rows, scorecard);


  return {
    checks,
    payload: {
      source: 'the frozen forecast in predictions-<review>.json against the post-rebalance companies.json',
      note:
        'THE FORECAST IS READ, NEVER RECOMPUTED. Every verdict scored here was written before the '
        + 'review took effect. Only funds whose workbook moved between the two dates are treated as '
        + 'evidence of what changed — a fund that was not re-read says nothing, which is different '
        + 'from saying nothing changed.',
      review: predictions.review,
      reviewLabel: predictions.reviewLabel,
      effectiveDate: predictions.effectiveDate,
      effectiveDateAssumed: predictions.effectiveDateAssumed,
      priceWindow: predictions.priceWindow,
      builtAt: new Date().toISOString(),
      forecast: {
        holdingsAsOf: snapshotHoldings,
        builtAt: predictions.forecastFrom?.builtAt ?? null,
        frozenAt: predictions.frozenAt ?? null,
        companies: predictions.companies.length,
      },
      outcome: {
        holdingsAsOfByFund: afterByFund,
        builtAt: record.builtAt ?? null,
      },
      funds: {
        reRead,
        notReRead,
        note: notReRead.length
          ? `${notReRead.join(', ')} was not re-downloaded for this review, so its membership after the `
            + 'rebalance is UNKNOWN. It is excluded from every comparison rather than assumed unchanged.'
          : 'every fund was re-read for this review',
        names: Object.fromEntries(fundIds.map((id) => [id, record.coverage?.byFund?.[id]?.shortName ?? id])),
      },
      segmentRule: SEGMENT_OVERLAP.rule,
      eventTypes: EVENTS,
      eventTally,
      scorecard,
      retrospective,
      droppedFromRecord,
      companies: rows,
    },
  };
}

function main() {
  const args = process.argv.slice(2);
  const review = (args.find((a) => a.startsWith('--review=')) ?? '').split('=')[1] ?? '';
  const predictionsPath = join(DATA, `predictions-${review}.json`);
  if (!existsSync(predictionsPath)) {
    process.stderr.write(
      `\n  No frozen forecast at ${predictionsPath}.\n\n`
      + '  A rebalance cannot be scored without one, and one cannot honestly be written now:\n'
      + '  snapshot-predictions.mjs refuses to run against a record that already carries the\n'
      + '  outcome. The forecast had to be frozen before the workbooks were refreshed.\n\n',
    );
    process.exit(2);
  }

  const predictions = JSON.parse(readFileSync(predictionsPath, 'utf8'));
  const record = JSON.parse(readFileSync(join(DATA, 'companies.json'), 'utf8'));
  const { checks, payload } = buildRebalance(predictions, record);

  const outPath = join(DATA, `rebalance-${review}.json`);
  if (!checks.passed) {
    process.stderr.write(`\nREFUSING TO WRITE ${outPath} — ${checks.failures.length} check(s) failed:\n\n`);
    checks.print();
    process.stderr.write('\n');
    process.exit(1);
  }
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);

  const s = payload.scorecard;
  process.stdout.write(
    `\n  ${payload.reviewLabel} review — effective ${payload.effectiveDate}\n\n`
    + `  forecast from holdings as of ${payload.forecast.holdingsAsOf}\n`
    + `  outcome from ${Object.entries(payload.outcome.holdingsAsOfByFund).map(([k, v]) => `${k} ${v}`).join(', ')}\n`
    + `  compared over ${payload.funds.reRead.join(', ')} only`
    + (payload.funds.notReRead.length ? ` — ${payload.funds.notReRead.join(', ')} not re-read\n\n` : '\n\n'),
  );
  process.stdout.write(renderTable(
    [{ key: 'event', label: 'What happened' }, { key: 'n', label: 'Companies', align: 'right' }],
    Object.entries(payload.eventTally).sort((a, b) => b[1] - a[1])
      .map(([event, n]) => ({ event: EVENTS[event]?.label ?? event, n: num(n) })),
  ));
  process.stdout.write(
    `\n  Scorecard, over ${num(s.scored)} companies that carried a callable verdict\n\n`
    + `    flagged as moving      ${num(s.precision.flagged)}\n`
    + `      of those, moved      ${num(s.precision.moved)}\n`
    + `      right event named    ${num(s.precision.rightEvent)}\n\n`
    + `    actually moved         ${num(s.recall.moved)}\n`
    + `      of those, flagged    ${num(s.recall.flagged)}\n`
    + `      right event named    ${num(s.recall.rightEvent)}\n\n`
    + `    no-change calls        ${num(s.stable.right)} of ${num(s.stable.calls)} held`
    + '   (a true-negative rate; it will always look high)\n\n'
    + `    ${num(s.unknownAtForecast)} carried "unknown" at forecast time and are not scored either way\n`
    + `    ${num(s.notInForecast)} were not in the record when the forecast was made\n\n`
    + `  wrote ${outPath}\n\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
