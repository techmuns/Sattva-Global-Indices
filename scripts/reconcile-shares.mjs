#!/usr/bin/env node
/**
 * reconcile-shares.mjs — investigate share-count disagreements between BSE and
 * Munshot, and quarantine what cannot be resolved.
 *
 *   node scripts/reconcile-shares.mjs [--threshold 10] [--out public/data/share-reconciliation.json]
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS LOAD-BEARING
 * ---------------------------------------------------------------------------
 * `sharesOutstanding` is derived from BSE (`MktCapFull / LTP`), and every
 * downstream number rests on it:
 *
 *     free-float mcap = floatFactor × sharesOutstanding × price
 *     verdict         = free-float mcap vs the thresholds
 *     flow            = target weight × fund AUM
 *
 * So a wrong share count does not produce a visibly broken row. It produces a
 * confident, well-formatted, WRONG verdict — which is the worst failure this
 * tool can have. Any company whose share count we cannot corroborate is
 * quarantined: its verdict becomes `unknown` with the reason attached, rather
 * than a confident answer computed on a suspect input.
 *
 * ---------------------------------------------------------------------------
 * HOW A DISAGREEMENT IS ADJUDICATED
 * ---------------------------------------------------------------------------
 * Munshot's market cap is NSE-priced, ours is BSE-priced, so a small gap is
 * expected and means nothing. What matters is the SHARE COUNT each implies:
 *
 *     ourShares     = bse.fullMcapInr      / bse.priceInr        (both BSE)
 *     munshotShares = munshot.marketCapInr / munshot.price       (both Munshot)
 *
 * Each division stays inside one source, so no price difference leaks in. The
 * ratio of the two is then the whole story, and it is usually not a smear —
 * it is an exact rational number, because corporate actions are exact:
 * a 10:1 split is 10×, a 1:1 bonus is 2×, a 3-for-2 bonus is 1.5×.
 *
 * An exact ratio tells you a corporate action is involved. It does NOT tell you
 * which side missed it. Only a THIRD source can do that, and this project has
 * exactly one: NSE's published free-float market cap. Where NSE covers the
 * company, `nse.freeFloatMcapInr / (floatFactor × price)` gives an independent
 * share count. Where it does not, the disagreement is reported with its likely
 * cause and the company is QUARANTINED — a hypothesis is not a resolution.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { fetchBatchChunk } from './lib/munshot.mjs';
import { renderTable, num, round } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const rel = (p) => p.replace(`${REPO}/`, '');

/** Ratios a corporate action can produce. */
const CORPORATE_ACTION_RATIOS = [
  { value: 10, label: '10:1 split (or 9:1 bonus)' },
  { value: 5, label: '5:1 split' },
  { value: 4, label: '4:1 split (or 3:1 bonus)' },
  { value: 3, label: '3:1 split (or 2:1 bonus)' },
  { value: 2.5, label: '5-for-2 bonus' },
  { value: 2, label: '2:1 split (or 1:1 bonus)' },
  { value: 1.5, label: '3-for-2 bonus (1:2)' },
  { value: 1.25, label: '5-for-4 bonus (1:4)' },
];

/** Is `ratio` an exact corporate-action ratio, or its reciprocal? */
function classifyRatio(ratio, tolerance = 0.002) {
  for (const candidate of CORPORATE_ACTION_RATIOS) {
    if (Math.abs(ratio - candidate.value) / candidate.value <= tolerance) {
      return { exact: true, factor: candidate.value, direction: 'munshot-higher', label: candidate.label };
    }
    const inverse = 1 / candidate.value;
    if (Math.abs(ratio - inverse) / inverse <= tolerance) {
      return { exact: true, factor: candidate.value, direction: 'munshot-lower', label: candidate.label };
    }
  }
  return { exact: false, factor: null, direction: null, label: null };
}

function readJson(name) {
  const path = join(REPO, 'public', 'data', name);
  if (!existsSync(path)) {
    process.stderr.write(`Missing public/data/${name}.\n\n`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function main() {
  const args = process.argv.slice(2);
  const argOf = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
  const threshold = Number(argOf('--threshold', '10'));
  const outPath = join(REPO, argOf('--out', 'public/data/share-reconciliation.json'));
  const token = process.env.MUNS_TOKEN || undefined;

  const companies = readJson('companies.json').companies;
  const stats = readJson('quote-stats.json').stats;
  const nseFloat = readJson('nse-freefloat.json');
  const nseBySymbol = new Map(nseFloat.companies.map((c) => [c.symbol, c]));

  process.stdout.write('\nShare-count reconciliation — BSE vs Munshot\n\n');

  // ---- 1. gap for every company that has both figures ---------------------
  const compared = [];
  for (const company of companies) {
    if (!company.nseSymbol || !company.fullMcapInr || !company.sharesOutstanding) continue;
    const stat = stats[company.nseSymbol];
    if (!stat?.munshotMarketCapInr) continue;
    compared.push({
      company,
      munshotMarketCapInr: stat.munshotMarketCapInr,
      lastSplitFactor: stat.lastSplitFactor ?? null,
      lastSplitDate: stat.lastSplitDate ?? null,
      gapPct: ((stat.munshotMarketCapInr - company.fullMcapInr) / company.fullMcapInr) * 100,
    });
  }

  const abs = compared.map((c) => Math.abs(c.gapPct)).sort((a, b) => a - b);
  const median = abs.length ? abs[Math.floor(abs.length / 2)] : null;
  const outliers = compared
    .filter((c) => Math.abs(c.gapPct) > threshold)
    .sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct));

  process.stdout.write(
    renderTable(
      [{ key: 'what', label: 'Measure', align: 'left' }, { key: 'n', label: 'Value', align: 'right' }],
      [
        { what: 'companies with both a BSE and a Munshot market cap', n: num(compared.length) },
        { what: 'median absolute gap', n: median === null ? '—' : `${median.toFixed(3)}%` },
        { what: `over ${threshold}% — investigated below`, n: num(outliers.length) },
        { what: 'over 5%', n: num(compared.filter((c) => Math.abs(c.gapPct) > 5).length) },
      ],
    ),
  );

  if (outliers.length === 0) {
    process.stdout.write('\n\nNo outliers. Nothing to reconcile.\n\n');
  }

  // ---- 2. Munshot's own price, so its share count can be computed ---------
  const symbols = outliers.map((o) => o.company.nseSymbol);
  const quotes = symbols.length ? (await fetchBatchChunk(symbols, { token, timeoutMs: 20000 })).quotes : {};

  // ---- 3. adjudicate ------------------------------------------------------
  const findings = [];
  for (const outlier of outliers) {
    const { company } = outlier;
    const quote = quotes[company.nseSymbol];
    const munshotShares = quote?.price ? outlier.munshotMarketCapInr / quote.price : null;
    const ratio = munshotShares ? munshotShares / company.sharesOutstanding : null;
    const shape = ratio === null ? { exact: false } : classifyRatio(ratio);

    // The only third source this project has.
    const nse = nseBySymbol.get(company.nseSymbol) ?? null;
    let thirdSource = null;
    if (nse && company.floatFactor && company.priceInr) {
      // NSE publishes free-float mcap; divide by the factor and the price to get
      // an independent TOTAL share count. Both NSE halves stay together.
      const nseImpliedTotal = nse.impliedFreeFloatShares / company.floatFactor;
      const vsOurs = nseImpliedTotal / company.sharesOutstanding;
      const vsMunshot = munshotShares ? nseImpliedTotal / munshotShares : null;
      thirdSource = {
        source: 'nse-preopen',
        impliedTotalShares: Math.round(nseImpliedTotal),
        ratioToOurs: round(vsOurs, 4),
        ratioToMunshot: vsMunshot === null ? null : round(vsMunshot, 4),
        // Whichever it lands on within 2% is the count NSE agrees with.
        agreesWith: Math.abs(vsOurs - 1) < 0.02 ? 'bse' : (vsMunshot !== null && Math.abs(vsMunshot - 1) < 0.02 ? 'munshot' : 'neither'),
      };
    }

    let status;
    let cause;
    if (thirdSource?.agreesWith === 'bse') {
      status = 'resolved-bse';
      cause = `NSE's published free float implies ${num(thirdSource.impliedTotalShares)} total shares, matching BSE`
        + `${shape.exact ? ` — Munshot is out by exactly ${shape.label}` : ''}`
        + `${outlier.lastSplitDate ? `, consistent with the ${outlier.lastSplitFactor} split it records on ${outlier.lastSplitDate}` : ''}.`;
    } else if (thirdSource?.agreesWith === 'munshot') {
      status = 'resolved-munshot';
      cause = `NSE's published free float implies ${num(thirdSource.impliedTotalShares)} total shares, matching MUNSHOT, not BSE. `
        + 'Our share count is derived from BSE, so it is the suspect one.';
    } else {
      status = 'quarantine';
      cause = shape.exact
        ? `The two share counts differ by exactly ${shape.label} (${ratio.toFixed(4)}×), so a corporate action is involved — `
          + 'but no third source covers this company, so which side missed it cannot be established. '
          + 'BSE is internally consistent and its price is confirmed by the bhavcopy, which makes a stale Munshot count the '
          + 'likelier explanation; that is a hypothesis, not a resolution.'
        : `The share counts differ by ${ratio === null ? 'an unknown factor' : `${ratio.toFixed(4)}×`}, which is not a corporate-action ratio, `
          + 'and no third source covers this company. Cause undetermined.';
    }

    findings.push({
      isin: company.isin,
      nseSymbol: company.nseSymbol,
      bseScripCode: company.bseScripCode,
      name: company.name,
      status,
      cause,
      gapPct: round(outlier.gapPct, 3),
      ourSharesOutstanding: company.sharesOutstanding,
      munshotImpliedShares: munshotShares === null ? null : Math.round(munshotShares),
      shareRatio: ratio === null ? null : round(ratio, 4),
      exactCorporateActionRatio: shape.exact ? shape.label : null,
      bsePriceInr: company.priceInr,
      munshotPriceInr: quote?.price ?? null,
      lastSplitFactor: outlier.lastSplitFactor,
      lastSplitDate: outlier.lastSplitDate,
      thirdSource,
    });
  }

  const quarantined = findings.filter((f) => f.status === 'quarantine');

  process.stdout.write('\n\nOutliers\n\n');
  process.stdout.write(
    renderTable(
      [
        { key: 'name', label: 'Company', align: 'left' },
        { key: 'sym', label: 'NSE', align: 'left' },
        { key: 'gap', label: 'Mcap gap', align: 'right' },
        { key: 'ratio', label: 'Share ratio', align: 'right' },
        { key: 'action', label: 'Exact ratio?', align: 'left' },
        { key: 'third', label: 'Third source', align: 'left' },
        { key: 'status', label: 'Status', align: 'left' },
      ],
      findings.map((f) => ({
        name: f.name.slice(0, 30),
        sym: f.nseSymbol,
        gap: `${f.gapPct > 0 ? '+' : ''}${f.gapPct.toFixed(1)}%`,
        ratio: f.shareRatio === null ? '—' : f.shareRatio.toFixed(4),
        action: f.exactCorporateActionRatio ?? 'no',
        third: f.thirdSource ? f.thirdSource.agreesWith : 'none',
        status: f.status,
      })),
    ),
  );

  process.stdout.write('\n\nFindings\n');
  for (const f of findings) {
    process.stdout.write(`\n  ${f.name} (${f.nseSymbol} / ${f.bseScripCode}) — ${f.status.toUpperCase()}\n`);
    process.stdout.write(`    ours ${num(f.ourSharesOutstanding)} shares @ ₹${f.bsePriceInr} (BSE)\n`);
    process.stdout.write(`    munshot ${f.munshotImpliedShares === null ? '—' : num(f.munshotImpliedShares)} shares @ ₹${f.munshotPriceInr ?? '—'} (NSE)\n`);
    process.stdout.write(`    ${f.cause}\n`);
  }

  process.stdout.write(
    `\n\n${num(quarantined.length)} company(ies) quarantined. Their verdicts become "unknown" with the reason attached —\n` +
    'a verdict computed from a share count we do not trust is worse than no verdict.\n',
  );

  const payload = {
    source: 'BSE (MktCapFull / LTP) vs Munshot (Market Cap / Current Price), adjudicated against NSE pre-open where it covers the company',
    note:
      'Share counts, not market caps: each side\'s count is derived inside its own source so no price difference leaks in. '
      + 'An exact rational ratio means a corporate action is involved but does NOT say which side missed it — only a third '
      + 'source can, and NSE pre-open covers 261 symbols. Anything not resolved by a third source is quarantined.',
    generatedAt: new Date().toISOString(),
    thresholdPct: threshold,
    comparedCount: compared.length,
    medianAbsGapPct: median === null ? null : round(median, 3),
    outlierCount: outliers.length,
    quarantinedCount: quarantined.length,
    quarantinedIsins: quarantined.map((f) => f.isin).filter(Boolean),
    findings,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stdout.write(`\nWrote ${rel(outPath)}.\n\n`);
}

main().catch((error) => {
  process.stderr.write(`\nUnhandled failure: ${error?.stack || error}\n\n`);
  process.exit(1);
});
