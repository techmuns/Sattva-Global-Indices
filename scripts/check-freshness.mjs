#!/usr/bin/env node
/**
 * check-freshness.mjs — is any feed on the committed record past its own
 * staleness threshold? Reads only; writes nothing; needs no network.
 *
 *   node scripts/check-freshness.mjs [--as-of YYYY-MM-DD] [--jobs-only] [--warn-only]
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS: THE SCREEN SAID STALE AND NOTHING ELSE DID
 * ---------------------------------------------------------------------------
 * The sources modal has always drawn a STALE badge on a feed past its own
 * `staleAfterDays`, and until now that comparison had exactly one reader — the
 * browser. So the dashboard could tell a portfolio manager, correctly, that the
 * BSE free float, the bhavcopy, the scrip master and the segment benchmarks were
 * all out of date, while every job in the repository reported green.
 *
 * That is not hypothetical. Between 1 and 21 Sep 2026 `daily-refresh.yml` failed
 * on 13 of its 15 scheduled runs and committed nothing for the last four trading
 * days, for three separate reasons — two count-based shrink guards tripping on a
 * universe that legitimately churns, and a verify-data check that named two
 * suspended scrip codes and so asserted a fact about the market. Every source
 * answered fine throughout. The record simply stopped moving, and the only thing
 * that noticed was the screen.
 *
 * §2.34 already drew the conclusion — "a red daily refresh for two consecutive
 * trading days is the only signal that a pipeline has stopped, and it is worth
 * alerting on for that reason" — and nothing was built. This is that alert.
 *
 * ---------------------------------------------------------------------------
 * IT ASSERTS A CONTRACT, NOT WHAT THE MARKET DID
 * ---------------------------------------------------------------------------
 * §2.34's rule binds this script as much as any other check: an assertion must
 * be about the code, the arithmetic or the contract, never about what the
 * numbers happened to be. So it does not test that prices moved, that a segment
 * returned anything in particular, or that today was a trading day. It tests one
 * contract: EVERY FEED IS AS FRESH AS ITS OWN STATED CADENCE SAYS IT SHOULD BE.
 *
 * And it reads that cadence from `feedRegistry` in public/js/data/companies.js —
 * the one owner — through the same `isFeedStale` predicate the modal's badge
 * uses. There is no threshold typed in this file. A tripwire that could disagree
 * with the badge would be worse than none, because the disagreement would be
 * invisible from both sides.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not distinguish a market holiday from a missed run. Every threshold in
 * the registry already carries a weekend's slack — the daily feeds sit at 4 days
 * against a Friday-to-Monday gap of 3 — and inventing a holiday calendar here
 * would put a second, unverifiable opinion about which days are sessions beside
 * the one BSE gives us by answering or not answering. If a long weekend trips
 * this, the dashboard is showing a reader STALE at the same moment, and the desk
 * should be told the same thing the desk's client is being told.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { feedRegistry, isFeedStale, feedAgeDays, staleAfterDaysFor } from '../public/js/data/companies.js';
import { renderTable } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const RECORD = join(REPO, 'public', 'data', 'companies.json');

function main() {
  const args = process.argv.slice(2);
  const argOf = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const warnOnly = args.includes('--warn-only');
  // ⚠ "A JOB HAS STOPPED" AND "A PERSON IS OWED A WORKBOOK" ARE DIFFERENT FACTS
  //
  // Two feeds here are refreshed by hand, and not by choice: BlackRock and
  // Vanguard both answer a datacentre IP with an HTML page under a 200 and an
  // Excel content-type (§3.8's "a 200 is not a contract", from the other side).
  // Measured 22 Sep 2026 on the SMIN holdings URL: 1,440,151 bytes of
  // `<!DOCTYPE html>`. No workflow can refresh those, so a red daily refresh
  // caused by one would stop meaning "the pipeline stopped" — and a red that
  // means two different things is a red people learn to wave through, which is
  // the failure §3.8.2 already named about a guard waived weekly.
  //
  // So --jobs-only narrows the FAILURE to feeds a workflow owns. It never
  // narrows the REPORT: a hand-dropped feed past its cadence is printed just as
  // loudly, named as waiting on a person, in both modes. daily-refresh.yml uses
  // it because that run genuinely cannot fix a workbook; freshness-watch.yml
  // does not, because telling the desk the dashboard is showing STALE is its
  // entire job, whoever has to act.
  const jobsOnly = args.includes('--jobs-only');
  const asOfArg = argOf('--as-of');
  const now = asOfArg ? new Date(`${asOfArg}T23:59:59Z`) : new Date();

  if (!existsSync(RECORD)) {
    process.stderr.write('\npublic/data/companies.json is missing. Run scripts/build-companies.mjs first.\n\n');
    process.exit(1);
  }

  const record = JSON.parse(readFileSync(RECORD, 'utf8'));
  const feeds = feedRegistry(record.asOf ?? {});

  process.stdout.write(`\nFeed freshness — the committed record, measured at ${now.toISOString().slice(0, 10)}\n\n`);

  const rows = feeds.map((feed) => {
    const age = feedAgeDays(feed, now);
    const limit = staleAfterDaysFor(feed);
    const stale = isFeedStale(feed, now);
    return {
      feed,
      age,
      limit,
      state: age === null ? 'no date' : (stale ? 'STALE' : 'ok'),
      stale,
      undated: age === null,
    };
  });

  process.stdout.write(renderTable(
    [
      { key: 'label', label: 'Feed', align: 'left' },
      { key: 'asOf', label: 'As of', align: 'left' },
      { key: 'age', label: 'Age', align: 'right' },
      { key: 'limit', label: 'Stale after', align: 'right' },
      { key: 'state', label: '', align: 'left' },
    ],
    rows.map((r) => ({
      label: r.feed.label,
      asOf: String(r.feed.raw ?? '—').slice(0, 24),
      age: r.age === null ? '—' : `${r.age.toFixed(1)}d`,
      limit: `${r.limit}d`,
      state: r.state,
    })),
  ));

  // A feed with no date at all is MISSING, which is a different fact from stale
  // (§2.4) and is reported as its own line rather than folded into the count.
  const undated = rows.filter((r) => r.undated);
  if (undated.length > 0) {
    process.stdout.write(
      `\n  ${undated.length} feed(s) carry no date at all — missing, which is not the same as stale: `
      + `${undated.map((r) => r.feed.label).join(', ')}\n`,
    );
  }

  const stale = rows.filter((r) => r.stale);
  const staleByJob = stale.filter((r) => r.feed.refreshedBy !== 'hand');
  const staleByHand = stale.filter((r) => r.feed.refreshedBy === 'hand');
  process.stdout.write(`\n  ${rows.length - stale.length - undated.length} of ${rows.length} feeds are within their own cadence.\n`);

  if (stale.length === 0) {
    process.stdout.write('\n  Nothing is stale. The dashboard is showing no STALE badge either — same predicate.\n\n');
    return;
  }

  // The failing set, and it is the only thing --jobs-only changes.
  const failing = jobsOnly ? staleByJob : stale;
  const fails = failing.length > 0 && !warnOnly;
  const write = fails ? process.stderr.write.bind(process.stderr) : process.stdout.write.bind(process.stdout);

  write(`\n${stale.length} FEED(S) PAST THEIR OWN CADENCE — the dashboard is showing a STALE badge on each:\n\n`);
  for (const r of stale) {
    const owner = r.feed.refreshedBy === 'hand'
      ? 'WAITING ON A PERSON — no workflow can refresh this'
      : 'a job owns this, and it has stopped';
    write(`  ${r.feed.label}  [${owner}]\n`);
    write(`    as of ${r.feed.raw} · ${r.age.toFixed(1)} days old · stale after ${r.limit}\n`);
    write(`    cadence: ${r.feed.cadence ?? 'unstated'}\n`);
    write(`    ${r.feed.detail}\n\n`);
  }
  if (jobsOnly && staleByHand.length > 0) {
    write(
      `  ${staleByHand.length} of those ${staleByHand.length === 1 ? 'is' : 'are'} hand-dropped `
      + `(${staleByHand.map((r) => r.feed.label).join(', ')}) and --jobs-only does NOT fail on `
      + 'them.\n  They are still stale, still badged STALE on screen, and still somebody\'s to fix.\n\n',
    );
  }
  write(
    'A feed past its cadence means the job that writes it has stopped, not that nothing moved.\n'
    + 'Check the workflow that owns it before assuming the market was quiet:\n'
    + '  bse / bhavcopy / bse-master / benchmarks  -> daily-refresh.yml\n'
    + '  nse / nse-universe                        -> weekly-nse-crosscheck.yml\n'
    + '  asm                                       -> asm-refresh.yml\n'
    + '  quote-stats                               -> monthly-float.yml\n'
    + '  ishares / ftse                            -> replaced by hand; BlackRock and Vanguard\n'
    + '                                               both serve a datacentre IP an HTML page.\n\n',
  );

  if (warnOnly) {
    process.stdout.write('  --warn-only: reporting without failing.\n\n');
    return;
  }
  if (failing.length === 0) {
    process.stdout.write('  --jobs-only: every stale feed is hand-dropped, so no workflow is at fault. Not failing.\n\n');
    return;
  }
  process.exit(1);
}

main();
