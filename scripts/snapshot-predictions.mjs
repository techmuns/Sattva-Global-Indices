#!/usr/bin/env node
/**
 * snapshot-predictions.mjs — freeze what we forecast, BEFORE the answer lands.
 *
 *   node scripts/snapshot-predictions.mjs --review=2026-08
 *
 * ---------------------------------------------------------------------------
 * ⚠ THIS SCRIPT EXISTS BECAUSE A SCORECARD IS TRIVIAL TO FAKE BY ACCIDENT
 * ---------------------------------------------------------------------------
 * The screener recomputes every verdict from whatever holdings are committed.
 * Import a post-rebalance holdings file and the verdicts recompute against the
 * new membership — and then "how many did we get right" is the model being
 * graded on the answer sheet. It would score beautifully and mean nothing.
 *
 * So the forecast is frozen into a file of its own, from a record whose
 * holdings PREDATE the review's effective date, and the scorer reads that file
 * rather than the live record. Two refusals enforce it:
 *
 *   1. It will not write from a record whose iShares holdings are dated on or
 *      after the review's effective date. The effective date comes from
 *      model/calendar.js — a source the record under test cannot move, which
 *      is the whole point of CLAUDE.md §3.8's guard rule.
 *   2. It will not overwrite an existing snapshot without --force. A snapshot
 *      regenerated after the rebalance is not a prediction, however honestly
 *      it was meant, and nothing downstream could tell the difference.
 *
 * WHAT IT ALSO CARRIES, and why. Once fresh workbooks replace the fixtures, the
 * old fund membership is gone from the working tree — and the old membership is
 * one half of every "did this company enter or leave" question. So the snapshot
 * records each company's weight in each fund as well as its verdict. The
 * scorer needs no workbook older than the one on disk.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { closedReviews, reviewCutoffs } from '../public/js/model/calendar.js';
import { renderTable, num } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const RECORD_PATH = join(REPO, 'public', 'data', 'companies.json');

const outPathFor = (review) => join(REPO, 'public', 'data', `predictions-${review}.json`);

/** The verdicts that CLAIM something will happen. Everything else is a
 *  no-change call, and the two are scored separately downstream because a
 *  universe that mostly does not move makes true negatives free. */
const CLAIMS_A_MOVE = new Set([
  'likely-inclusion',
  'possible-inclusion',
  'likely-exclusion',
  'exclusion-risk',
  'migration-up',
  'migration-down',
]);

function parseArgs(argv) {
  const args = argv.slice(2);
  const review = (args.find((a) => a.startsWith('--review=')) ?? '').split('=')[1] ?? '';
  return { review, force: args.includes('--force') };
}

/**
 * The review being forecast, resolved from the calendar rather than typed.
 *
 * `closedReviews` answers newest-first from a date, so it is asked as of the
 * end of the review's own year and the review is picked out by id. Asking it
 * from a far-future date would return that era's reviews instead — the count
 * limits how many come back, not how far they reach.
 */
function resolveReview(review) {
  const match = /^(\d{4})-(\d{2})$/.exec(review);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const found = closedReviews(`${year}-12-31`, 4).find((r) => r.review === review);
  if (!found) return null;
  return { ...found, cutoffs: reviewCutoffs(year, month) };
}

export function buildSnapshot(record, review) {
  const companies = record.companies.map((company) => {
    const assessment = company.assessment ?? null;
    const decidingRule = assessment
      ? (assessment.rulesFired ?? []).find((r) => r.key === assessment.distanceRuleKey) ?? null
      : null;
    return {
      isin: company.isin,
      name: company.name,
      nseSymbol: company.nseSymbol ?? null,
      // The forecast itself.
      verdict: assessment?.verdict ?? null,
      claimsAMove: assessment ? CLAIMS_A_MOVE.has(assessment.verdict) : false,
      segment: company.segment ?? null,
      distancePct: assessment?.distancePct ?? null,
      decidingRule: decidingRule
        ? {
          key: decidingRule.key,
          label: decidingRule.label,
          threshold: decidingRule.threshold,
          thresholdSource: decidingRule.thresholdSource,
          unit: decidingRule.unit ?? null,
          result: decidingRule.result,
        }
        : null,
      // The size the forecast was made on, so a reader can see how close to its
      // own threshold each call was without re-deriving it.
      freeFloatMcapInr: company.freeFloatMcapInr ?? null,
      fullMcapInr: company.fullMcapInr ?? null,
      // THE OTHER HALF OF EVERY "did it enter or leave" QUESTION. Fresh
      // workbooks overwrite the fixtures; this is what survives of the old
      // membership. A null weight is NOT HELD — never a zero.
      funds: Object.fromEntries(
        Object.entries(company.funds ?? {}).map(([id, holding]) => [
          id,
          holding ? { weightPct: holding.weightPct ?? null, marketValueUsd: holding.marketValueUsd ?? null } : null,
        ]),
      ),
      held: company.held === true,
    };
  });

  const tally = {};
  for (const c of companies) tally[c.verdict ?? 'none'] = (tally[c.verdict ?? 'none'] ?? 0) + 1;

  return {
    source: 'public/data/companies.json, frozen before the review took effect',
    note:
      'THE FORECAST, NOT THE OUTCOME. Every verdict here was computed from holdings dated '
      + `${record.asOf?.isharesHoldings} — before the ${review.label} review took effect on `
      + `${review.effectiveDate}. Nothing in this file may be regenerated from a record that `
      + 'contains the outcome; snapshot-predictions.mjs refuses to, and verify-data asserts it.',
    review: review.review,
    reviewLabel: review.label,
    effectiveDate: review.effectiveDate,
    effectiveDateAssumed: review.assumed === true,
    priceWindow: review.cutoffs.price,
    forecastFrom: {
      builtAt: record.builtAt ?? null,
      asOf: record.asOf ?? null,
    },
    claimsAMove: [...CLAIMS_A_MOVE],
    verdictTally: tally,
    frozenAt: new Date().toISOString(),
    companies,
  };
}

function main() {
  const { review: reviewId, force } = parseArgs(process.argv);
  const review = resolveReview(reviewId);
  if (!review) {
    process.stderr.write(
      `\n  snapshot-predictions needs --review=YYYY-MM naming a review in the calendar.\n`
      + `  Got ${JSON.stringify(reviewId)}.\n\n`,
    );
    process.exit(2);
  }

  const outPath = outPathFor(review.review);
  if (existsSync(outPath) && !force) {
    process.stderr.write(
      `\n  ${outPath} already exists and will NOT be overwritten.\n\n`
      + '  A prediction snapshot is only a prediction the first time it is written. Regenerating\n'
      + '  it from a record that already carries the outcome would produce a file nothing\n'
      + '  downstream could distinguish from a forecast. Pass --force only if you are certain the\n'
      + '  source record still predates the review.\n\n',
    );
    process.exit(1);
  }

  const record = JSON.parse(readFileSync(RECORD_PATH, 'utf8'));
  const holdingsAsOf = record.asOf?.isharesHoldings ?? null;

  // ---- THE ANTI-CIRCULARITY GUARD ---------------------------------------
  // The threshold is the calendar's effective date, which this record cannot
  // influence. Reading it off the record itself would be the guard-reads-its-
  // own-threshold trap in §3.8.
  if (typeof holdingsAsOf !== 'string') {
    process.stderr.write('\n  The record does not state asOf.isharesHoldings, so it cannot be shown to predate the review.\n\n');
    process.exit(1);
  }
  if (holdingsAsOf >= review.effectiveDate) {
    process.stderr.write(
      `\n  REFUSING TO WRITE. The record's iShares holdings are dated ${holdingsAsOf}, on or after\n`
      + `  the ${review.label} review's effective date of ${review.effectiveDate}. Verdicts computed from\n`
      + '  those holdings already contain the outcome, so they are not a forecast of it — scoring\n'
      + '  them would be grading the model on the answer sheet.\n\n'
      + '  Snapshot from a record built BEFORE the rebalance, or do not snapshot at all.\n\n',
    );
    process.exit(1);
  }

  const snapshot = buildSnapshot(record, review);
  writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);

  const claimed = snapshot.companies.filter((c) => c.claimsAMove).length;
  process.stdout.write(
    `\n  Prediction snapshot — ${review.label} review\n\n`
    + `  forecast from holdings as of ${holdingsAsOf}, ${review.effectiveDate} effective date\n`
    + `  MSCI priced somewhere in ${snapshot.priceWindow.from}..${snapshot.priceWindow.to} and does not say which day\n\n`,
  );
  process.stdout.write(renderTable(
    [{ key: 'verdict', label: 'Verdict' }, { key: 'n', label: 'Companies', align: 'right' }],
    Object.entries(snapshot.verdictTally)
      .sort((a, b) => b[1] - a[1])
      .map(([verdict, n]) => ({ verdict, n: num(n) })),
  ));
  process.stdout.write(
    `\n  ${num(claimed)} of ${num(snapshot.companies.length)} companies carry a verdict that CLAIMS A MOVE;\n`
    + `  the other ${num(snapshot.companies.length - claimed)} are no-change calls and are scored separately —\n`
    + '  a universe that mostly does not move makes true negatives free.\n\n'
    + `  wrote ${outPath}\n\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
