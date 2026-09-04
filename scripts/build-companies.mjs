#!/usr/bin/env node
/**
 * build-companies.mjs — everything -> public/data/companies.json
 *
 *   node scripts/build-companies.mjs
 *
 * The one record the interface will read. Reads only committed JSON; makes no
 * network requests, so it is cheap to re-run and fully reproducible.
 *
 * Inputs:
 *   msci-funds.json       iShares holdings and weights, per fund       (tier 1)
 *   bse-scrip-master.json the listed-equity universe and its ISINs     (tier 1)
 *   nse-universe.json     the NSE symbol <-> ISIN bridge               (tier 1)
 *   nse-freefloat.json    NSE free-float market cap, 261 symbols       (tier 1)
 *   bse-freefloat.json    BSE free float and full mcap, ~1,200 scrips  (tier 1)
 *
 * ---------------------------------------------------------------------------
 * TWO SOURCES FOR ONE NUMBER
 * ---------------------------------------------------------------------------
 * NSE and BSE both publish free-float market cap and they do not agree. For
 * RELIANCE the implied float factor is about 0.4978 from NSE and 0.4926 from
 * BSE — roughly 1% apart, and that gap is a real difference in float
 * definition, not a price-timestamp artefact.
 *
 * The rules, which are the desk's and are not negotiable:
 *
 *   1. BSE IS PRIMARY. It is the only source that can carry the screen: BSE
 *      serves a factor for 1,198 of 1,198 active scrips above ₹2,000 Cr, while
 *      NSE publishes free float for about 250 symbols in total.
 *   2. NSE WINS WHERE THE TWO MATERIALLY DISAGREE — above
 *      FLOAT_SOURCE_PREFER_NSE_GAP_PCT (2%) — because the desk's understanding
 *      is that MSCI follows NSE. Below that the gap is definitional noise.
 *   3. NSE IS THE SOURCE WHERE BSE HAS NOTHING. BSE Ltd, CDSL and TSF
 *      Investments are NSE-only listings and never appear in BSE's master.
 *   4. NEVER AVERAGE OR BLEND. Every company carries `floatSource`, and where
 *      both readings exist BOTH factors stay on the record so the disagreement
 *      is inspectable rather than resolved away.
 *   5. THE RULE THAT CHOSE TRAVELS WITH THE NUMBER. `floatChoice` names which
 *      rule fired, the measured gap and the threshold it was tested against.
 *   6. THE SOURCE TRAVELS WITH THE NUMBER — to the screen, to the drill-down,
 *      and to row 1 of any export.
 *   7. NOTHING SUMS OR RANKS ACROSS THE TWO WITHOUT SAYING SO.
 *
 * The gap is measured on the DIMENSIONLESS FACTOR, never on a rupee figure: two
 * rupee free floats differ by the price difference as well as the float
 * difference, so a 2% test on them would fire on price noise.
 *
 * ---------------------------------------------------------------------------
 * HOW NSE'S FACTOR IS DERIVED WITHOUT MIXING PRICES
 * ---------------------------------------------------------------------------
 *     nseFloatShares = nse.freeFloatMcapInr / nse.iep        (both NSE)
 *     totalShares    = bse.fullMcapInr      / bse.priceInr   (both BSE)
 *     floatFactorNse = nseFloatShares / totalShares
 *
 * Each division stays inside one source, so no price difference leaks into the
 * result. The two are only combined in the SHARE COUNT domain, where a share is
 * a share regardless of which exchange quoted it. Dividing BSE's market cap by
 * NSE's price would fold a price gap into a float gap and make the whole
 * comparison meaningless.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildIndex, resolveAll, seedSymbolConflicts, CONFIRMED, NOT_LISTED } from './lib/resolve.mjs';
import {
  recomputeFreeFloat, choosePrice, dayChangePct, passiveDrift, flowPrimitives,
} from './lib/recompute.mjs';
// The model runs in the browser AND here. Same modules, different inputs: the
// build assesses against the committed EOD price, the browser re-assesses
// against whatever price is in force. Verdicts are therefore stored as the EOD
// verdict, exactly as freeFloatMcapInr already is.
import { observedBoundary, observedSizeCutoffs, rankByFreeFloat } from '../public/js/model/thresholds.js';
import { segmentOf, assertDisjoint, segmentFloatTotals } from '../public/js/model/segments.js';
import { assess, verdictFromRules, barsFrom, VERDICTS, DISCLOSURE } from '../public/js/model/assess.js';
import { estimateFlows } from '../public/js/model/flows.js';
import { nextReview, previousReview, reviewCutoffs, chooseBaseline } from '../public/js/model/calendar.js';
import * as MSCI from '../public/js/config/msci-methodology.mjs';
import { seriesToMap, summarise, rateOn, FUND_BENCHMARKS } from '../public/js/model/benchmarks.js';
import { assessRelative, assessSinceRebalance, WINDOW_STATES, REBASE_STATES } from '../public/js/model/relative.js';
import {
  SEGMENT_BAND_ADJUSTMENT, RELATIVE_PERFORMANCE, REBALANCE_BASELINE,
  AUGUST_2026_CALIBRATION, DESK_BAND_ROLE, FTSE_JOIN,
} from '../public/js/config/thresholds.mjs';
import { buildFtseIndex, resolveFtseHoldings, assertCurrency } from './lib/ftse-resolve.mjs';
import { renderTable, num, round, CheckList } from './lib/report.mjs';
import {
  SCRAPE_UNIVERSE_MIN_FULL_MCAP_INR,
  FLOAT_FACTOR_DISAGREEMENT_REVIEW_PCT,
  FLOAT_SOURCE_PREFER_NSE_GAP_PCT,
  FLOAT_SOURCE_RULE,
  toCrore,
} from '../public/js/config/thresholds.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const OUT_PATH = join(REPO, 'public', 'data', 'companies.json');
/**
 * The alternate rebalance baselines.
 *
 * Kept OUT of companies.json deliberately. The default baseline's reading is
 * on every company record and paints on first load; the alternates are only
 * needed if a reader actually re-bases the screen, and putting four of them
 * inline would add roughly 700 KB to a file every visitor downloads to answer
 * a question most of them never ask.
 */
const BASELINES_PATH = join(REPO, 'public', 'data', 'relative-baselines.json');

const rel = (p) => p.replace(`${REPO}/`, '');

function requireFile(name, how) {
  const path = join(REPO, 'public', 'data', name);
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  process.stderr.write(`\nMissing ${rel(path)}. Run \`${how}\` first.\n\n`);
  process.exit(1);
  return null;
}

function main() {
  const funds = requireFile('msci-funds.json', 'node scripts/import-ishares.mjs');
  const master = requireFile('bse-scrip-master.json', 'node scripts/fetch-bse-master.mjs');
  const nseUniverse = requireFile('nse-universe.json', 'node scripts/fetch-nse-universe.mjs');
  const nseFreeFloat = requireFile('nse-freefloat.json', 'node scripts/scrape-nse-freefloat.mjs');
  const bseFreeFloat = requireFile('bse-freefloat.json', 'node scripts/scrape-bse-freefloat.mjs');
  const prices = requireFile('prices.json', 'node scripts/fetch-bhavcopy.mjs');
  const universeSeed = requireFile('universe.json', 'node scripts/import-universe.mjs');
  // Optional. Absent means the bands stay raw and every rule says so — never a
  // silently unadjusted band presented as an adjusted one.
  const benchmarksPath = join(REPO, 'public', 'data', 'fund-benchmarks.json');
  const benchmarks = existsSync(benchmarksPath) ? JSON.parse(readFileSync(benchmarksPath, 'utf8')) : null;

  // ---- the review calendar is anchored to the RECORD, not to the clock ----
  // `nextReview()` defaults to `new Date()`, which is right for the interface —
  // a reader wants days remaining from now. It is wrong here: this build writes
  // a COMMITTED ARTEFACT, and a field that moves with the calendar makes that
  // artefact irreproducible. CI rebuilds and compares, so the same inputs
  // rebuilt a day later differed by exactly one leaf,
  // `model.nextReview.daysRemaining` (12 -> 11), and the job failed.
  //
  // The anchor is the bhavcopy trade date: it is the moment the prices in this
  // record are struck at, so "days until the review" is measured from the same
  // instant as every distance the review is about. Any other committed as-of
  // would do; the clock would not.
  const reviewAnchor = new Date(`${prices.tradeDate}T00:00:00Z`);
  if (Number.isNaN(reviewAnchor.getTime())) {
    process.stderr.write(
      `\nprices.json has no usable tradeDate (${JSON.stringify(prices.tradeDate)}), so the review\n`
      + 'calendar cannot be anchored to the record. Run `node scripts/fetch-bhavcopy.mjs` first.\n\n',
    );
    process.exit(1);
  }
  // Optional: monthly Munshot statistics. Absent is a smaller record, not a
  // failure — the site must build from the committed exchange data alone.
  const quoteStatsPath = join(REPO, 'public', 'data', 'quote-stats.json');
  const quoteStats = existsSync(quoteStatsPath) ? JSON.parse(readFileSync(quoteStatsPath, 'utf8')) : null;
  // Companies whose share count could not be corroborated. Their verdicts
  // become `unknown` rather than a confident answer on a suspect input.
  const reconPath = join(REPO, 'public', 'data', 'share-reconciliation.json');
  const reconciliation = existsSync(reconPath) ? JSON.parse(readFileSync(reconPath, 'utf8')) : null;

  // ---- the review-quarter relative-performance inputs ---------------------
  // Optional together, and USELESS APART. A price series with no corporate-action
  // data reads a 1:1 bonus as a 50% collapse, so if either is missing the reading
  // is a stated absence for every company rather than a number for some of them.
  const priceHistoryPath = join(REPO, 'public', 'data', 'price-history.json');
  const priceHistory = existsSync(priceHistoryPath) ? JSON.parse(readFileSync(priceHistoryPath, 'utf8')) : null;
  const actionsPath = join(REPO, 'public', 'data', 'corporate-actions.json');
  const corporateActions = existsSync(actionsPath) ? JSON.parse(readFileSync(actionsPath, 'utf8')) : null;

  // NSE's Additional Surveillance Measure list. Optional and allowed to fail like
  // every other NSE feed (§3.7 — the edge throttles a datacentre IP). Absent means
  // ASM STATUS IS UNKNOWN for every company, not that nothing is under surveillance
  // (§2.4). `asmMeta.available` below carries that distinction to the browser so a
  // company's null ASM field can be read as "not flagged" or "we could not check".
  const asmPath = join(REPO, 'public', 'data', 'nse-asm.json');
  const asmData = existsSync(asmPath) ? JSON.parse(readFileSync(asmPath, 'utf8')) : null;

  // Vanguard's FTSE Emerging Markets book. A SECOND OPINION and nothing more:
  // FTSE runs its own index, with its own constituents, size rules and review
  // calendar, so this file feeds no MSCI segment, cutoff, verdict or flow. It is
  // attached to companies AFTER they are assembled and lands in its own `ftse`
  // field — never in `funds`, never in `held` — so no MSCI derivation can reach
  // it even by accident. verify-data proves that by moving these weights and
  // asserting not one verdict follows.
  const ftsePath = join(REPO, 'public', 'data', 'ftse-funds.json');
  const ftseData = existsSync(ftsePath) ? JSON.parse(readFileSync(ftsePath, 'utf8')) : null;
  // INR per CAD, its own feed rather than a column in fund-benchmarks.json: that
  // file's fund series must reach the committed price date (verify-data 55), so
  // chaining a currency lookup to four ETFs' publication schedule would block the
  // FTSE join on any day one of them lagged. See scripts/fetch-ftse-fx.mjs.
  const ftseFxPath = join(REPO, 'public', 'data', 'ftse-fx.json');
  const ftseFx = existsSync(ftseFxPath) ? JSON.parse(readFileSync(ftseFxPath, 'utf8')) : null;

  const checks = new CheckList('build');

  const nseFloatBySymbol = new Map(nseFreeFloat.companies.map((c) => [c.symbol, c]));
  const bseByCode = new Map(bseFreeFloat.scrips.map((s) => [s.scripCode, s]));
  const bseByIsin = new Map();
  for (const scrip of bseFreeFloat.scrips) {
    if (scrip.isin && !bseByIsin.has(scrip.isin)) bseByIsin.set(scrip.isin, scrip);
  }

  // ---- the ASM list, keyed on ISIN --------------------------------------
  // Joined on ISIN and nothing else (§3.9): NSE's ASM feed carries the ISIN, so a
  // symbol match is never needed and never risked. A company under ASM gets its
  // stage carried through unchanged; every other company's `asm` field is null,
  // and `asmMeta.available` says whether that null means "not flagged" or "the
  // feed did not load and we could not check".
  const asmByIsin = new Map();
  for (const row of asmData?.companies ?? []) {
    if (row.isin && !asmByIsin.has(row.isin)) asmByIsin.set(row.isin, row);
  }

  const index = buildIndex(master, nseUniverse, new Set(nseFloatBySymbol.keys()), universeSeed);

  // Two files now name an NSE symbol for an ISIN. Where both speak they must
  // agree: a disagreement means one of them has the wrong company attached to
  // that ISIN, and every float reading keyed on the symbol would then belong to
  // somebody else. Nothing downstream could see it, so it stops the build.
  const symbolConflicts = seedSymbolConflicts(index);
  checks.assert(
    symbolConflicts.length === 0,
    'nse-universe.json and the seed list name the same NSE symbol for every shared ISIN',
    symbolConflicts.slice(0, 6)
      .map((c) => `${c.isin} ${c.name}: nse-universe says ${c.fromNseUniverse}, seed says ${c.fromSeed}`)
      .join(' | '),
  );
  const { resolved, unresolved, collisions, methodCounts } = resolveAll(funds.funds, index);

  // A collision means one of two rows in the same fund is the wrong company.
  // That is invisible downstream — both rows look perfectly well-formed — so it
  // stops the build rather than being reported and shipped.
  checks.assert(
    collisions.length === 0,
    'no two holdings of one fund resolve to the same ISIN',
    collisions
      .map((c) => `${c.fundId}/${c.isin}: ${c.rows.map((r) => `${r.ticker} "${r.name}" (row ${r.rowIndex}, ${r.method})`).join(' vs ')}`)
      .join(' | '),
  );

  // ---- assemble one record per company ----------------------------------
  /** @type {Map<string, object>} keyed by ISIN, or by `bse:CODE` when no ISIN. */
  const companies = new Map();
  const keyFor = (r) => r.isin ?? (r.bseScripCode ? `bse:${r.bseScripCode}` : null);

  for (const record of resolved) {
    const key = keyFor(record);
    if (key === null) continue;

    let company = companies.get(key);
    if (!company) {
      const bse = record.bseScripCode
        ? (bseByCode.get(record.bseScripCode) ?? null)
        : (record.isin ? (bseByIsin.get(record.isin) ?? null) : null);
      company = {
        isin: record.isin,
        name: bse?.name ?? record.resolvedName ?? record.holding.name,
        nseSymbol: record.nseSymbol,
        nseSymbolSource: record.nseSymbolSource ?? null,
        bseScripCode: record.bseScripCode,
        // A HELD company with no BSE scrip code needs the same stated reason an
        // unheld one gets. It is the case that matters most — a position we hold
        // and cannot price is a hole in the product, and an em dash with no
        // explanation reads as a fact about the company (2.3).
        noBseReason: record.bseScripCode ? null
          : 'not on BSE at all — an NSE-only listing, checked against every one of BSE\'s '
            + '12,685 active scrips by ISIN. NSE publishes free float for about 250 symbols '
            + 'and this is not one of them, so no exchange publishes a figure for it.',
        sector: bse?.sector ?? null,
        sectorSource: bse?.sector ? 'bse' : null,
        instrumentKind: bse?.instrumentKind ?? null,
        _bse: bse,
        funds: { eem: null, smin: null, eems: null },
        _resolutions: [],
      };
      companies.set(key, company);
    }
    // `null` in `funds` means NOT HELD by that fund. It is never 0 — a 0%
    // weight and an absent holding are different facts and sort differently.
    company.funds[record.fundId] = {
      weightPct: record.holding.weightPct,
      quantity: record.holding.quantity,
      marketValueUsd: record.holding.marketValueUsd,
    };
    company._resolutions.push(record.resolution);
  }

  /**
   * The NSE symbol for an ISIN, unique-or-nothing, from the index membership
   * first and the desk's seed list second. Never inferred from a BSE scrip id.
   */
  const symbolFor = (isin) => {
    if (!isin) return null;
    const hits = index.nseByIsin.get(isin);
    if (hits && hits.length === 1) return { symbol: hits[0].symbol, source: 'nse-universe' };
    const seeded = index.seedByIsin.get(isin);
    if (seeded?.nseSymbol) return { symbol: seeded.nseSymbol, source: 'seed' };
    return null;
  };

  // Companies large enough to matter that no fund holds — the inclusion
  // candidates, and the reason the BSE universe was scraped at all.
  for (const scrip of bseFreeFloat.scrips) {
    const key = scrip.isin ?? `bse:${scrip.scripCode}`;
    if (companies.has(key)) continue;
    const symbol = symbolFor(scrip.isin);
    companies.set(key, {
      isin: scrip.isin,
      name: scrip.name,
      nseSymbol: symbol?.symbol ?? null,
      nseSymbolSource: symbol?.source ?? null,
      bseScripCode: scrip.scripCode,
      sector: scrip.sector,
      sectorSource: scrip.sector ? 'bse' : null,
      instrumentKind: scrip.instrumentKind ?? null,
      _bse: scrip,
      funds: { eem: null, smin: null, eems: null },
      _resolutions: [{ method: 'not-held', via: 'bse-universe', confidence: 'exact' }],
    });
  }

  // Companies on the desk's list that the two loops above cannot reach.
  //
  // The BSE loop can only see what BSE's equity master carries, so an NSE-ONLY
  // listing is invisible to it however large: BSE Ltd (₹1.34 lakh Cr), CDSL
  // (₹28,129 Cr) and TSF Investments (₹9,433 Cr) are all real, all above the
  // floor, and none is in BSE's master at all. Leaving them out would define the
  // universe as "the ones one exchange happens to list", which is the same error
  // class as rendering a missing value as zero.
  //
  // They are added with no BSE record, so full market cap, share count and the
  // BSE price are all null and stay null. Their free float can only come from
  // NSE's published rupee figure, which the float block below already handles.
  let fromSeedOnly = 0;
  const seedNotListed = [];
  for (const row of universeSeed.companies) {
    const key = row.isin ?? (row.bseScripCode ? `bse:${row.bseScripCode}` : null);
    if (key === null || companies.has(key)) continue;
    if (row.listing === 'neither') {
      // On the desk's screen but on no exchange we read. Recorded with the
      // reason rather than dropped, and never counted as a tracked company.
      seedNotListed.push({
        isin: row.isin,
        name: row.name,
        screenerFullMcapInr: row.screenerFullMcapInr,
        reason: 'the seed list gives neither a BSE code nor an NSE code, so neither '
          + 'exchange can be asked for a price or a free float',
      });
      continue;
    }
    fromSeedOnly += 1;
    // WHY this company has no BSE record, in words, because "no reading" with no
    // reason is the absence that reads as a fact about the company — 2.3/2.4.
    //
    // This used to catch the REITs and InvITs too, wrongly: BSE files them under
    // GROUP=IF, outside `segment=Equity`, and publishes free float for all of
    // them. The master is now fetched wide enough to see them, so what is left
    // here is the genuine article — scrips BSE has SUSPENDED, and companies that
    // are not on BSE at all.
    const seedCode = row.bseScripCode;
    const noBseReason = seedCode
      ? `the seed list gives BSE code ${seedCode}, but that code is not in BSE's active `
        + 'master under any segment — BSE has it Suspended. Not fetched: BSE answers for a '
        + 'suspended scrip with a clean-looking factor and Category "Listed", and the active '
        + 'master is the only thing that says otherwise.'
      : 'not on BSE at all — an NSE-only listing, checked against every one of BSE\'s '
        + '12,685 active scrips by ISIN. NSE publishes free float for about 250 symbols '
        + 'and this is not one of them, so no exchange publishes a figure for it.';
    companies.set(key, {
      isin: row.isin,
      name: row.name,
      nseSymbol: row.nseSymbol,
      nseSymbolSource: row.nseSymbol ? 'seed' : null,
      // Deliberately NOT row.bseScripCode: a code the active master does not
      // carry is not a scrip we may fetch — 3.8's delisted trap. If BSE had a
      // live row for this company the BSE loop above would already own it.
      bseScripCode: null,
      seedBseScripCode: seedCode,
      noBseReason,
      sector: row.industry ?? row.industryGroup ?? null,
      sectorSource: row.industry || row.industryGroup ? 'seed' : null,
      _bse: null,
      funds: { eem: null, smin: null, eems: null },
      _resolutions: [{ method: 'not-held', via: 'seed', confidence: 'exact' }],
    });
  }

  // ---- float: BSE primary, NSE where the two materially disagree ---------
  const disagreements = [];
  const out = [];
  /** company key -> the float factor finally in force, for the coverage pass. */
  const floatByKey = new Map();

  for (const [key, company] of companies) {
    const bse = company._bse;
    const nse = company.nseSymbol ? (nseFloatBySymbol.get(company.nseSymbol) ?? null) : null;

    const fullMcapInr = bse?.fullMcapInr ?? null;
    const priceInr = bse?.priceInr ?? null;
    const sharesOutstanding = bse?.sharesOutstanding ?? null;
    const floatFactorBse = bse?.floatFactor ?? null;

    // NSE's factor, derived without ever dividing across sources by a price.
    let floatFactorNse = null;
    if (nse && nse.impliedFreeFloatShares !== null && sharesOutstanding !== null && sharesOutstanding > 0) {
      const factor = nse.impliedFreeFloatShares / sharesOutstanding;
      // A factor above 1 means the two sources disagree about the share count
      // itself (usually an unprocessed corporate action), not about float. It
      // is not a float reading and must not be presented as one.
      floatFactorNse = factor > 0 && factor <= 1.02 ? round(factor, 6) : null;
    }

    // ---- which exchange's factor is in force, and WHY --------------------
    //
    // The desk's rule, in the desk's own words: BSE is primary; where NSE also
    // publishes and the two differ by more than FLOAT_SOURCE_PREFER_NSE_GAP_PCT,
    // NSE wins; where BSE has nothing, NSE is the source.
    //
    // The gap is measured on the dimensionless FACTOR, not on a rupee figure —
    // 2.9. A rupee free float is struck at one moment's price, so two rupee
    // figures from two exchanges differ by the price difference as well as the
    // float difference, and a 2% test on them would fire on price noise.
    //
    // The choice is a tier-3 judgement made by a rule we wrote, so the rule that
    // fired travels with the number rather than being reconstructable only from
    // the source code.
    let floatGapPct = null;
    if (floatFactorNse !== null && floatFactorBse !== null && floatFactorBse > 0) {
      floatGapPct = round(((floatFactorNse - floatFactorBse) / floatFactorBse) * 100, 3);
    }

    let floatFactor = null;
    let floatChoice = null;
    if (floatFactorBse !== null && floatFactorNse !== null) {
      const beyond = Math.abs(floatGapPct) > FLOAT_SOURCE_PREFER_NSE_GAP_PCT;
      floatFactor = beyond ? floatFactorNse : floatFactorBse;
      floatChoice = {
        rule: beyond ? 'nse-preferred-on-material-gap' : 'bse-primary',
        chose: beyond ? 'nse' : 'bse',
        gapPct: floatGapPct,
        thresholdPct: FLOAT_SOURCE_PREFER_NSE_GAP_PCT,
        why: beyond
          ? `both exchanges publish and they differ by ${Math.abs(floatGapPct).toFixed(3)}%, `
            + `beyond the desk's ${FLOAT_SOURCE_PREFER_NSE_GAP_PCT}% switch point, so NSE is used`
          : `both exchanges publish and they differ by ${Math.abs(floatGapPct).toFixed(3)}%, `
            + `within the desk's ${FLOAT_SOURCE_PREFER_NSE_GAP_PCT}% switch point, so BSE stands`,
      };
    } else if (floatFactorBse !== null) {
      floatFactor = floatFactorBse;
      floatChoice = {
        rule: 'bse-only', chose: 'bse', gapPct: null, thresholdPct: FLOAT_SOURCE_PREFER_NSE_GAP_PCT,
        why: 'NSE publishes no free float for this company, so there is nothing to compare',
      };
    } else if (floatFactorNse !== null) {
      floatFactor = floatFactorNse;
      floatChoice = {
        rule: 'nse-only', chose: 'nse', gapPct: null, thresholdPct: FLOAT_SOURCE_PREFER_NSE_GAP_PCT,
        why: 'BSE has no float reading for this company',
      };
    }

    // Free float in rupees is the number the desk actually screens on, and it is
    // available in two different ways. A factor times a full market cap is the
    // preferred one because it survives tomorrow's price. But an NSE-only listing
    // — BSE Ltd and CDSL are real examples — has no BSE full market cap to divide
    // by, so no factor can be formed, while NSE publishes the rupee free float
    // outright. Reporting "no reading" there would be discarding a measurement we
    // hold, which is the mirror image of inventing one we do not.
    let freeFloatMcapInr = null;
    let freeFloatBasis = null;
    let floatSource = null;
    if (floatFactor !== null && fullMcapInr !== null) {
      freeFloatMcapInr = Math.round(floatFactor * fullMcapInr);
      freeFloatBasis = 'floatFactor × fullMcapInr';
      floatSource = floatChoice.chose;
    } else if (nse && nse.freeFloatMcapInr !== null && nse.freeFloatMcapInr > 0) {
      freeFloatMcapInr = Math.round(nse.freeFloatMcapInr);
      freeFloatBasis = 'NSE published free-float market cap (no full market cap available, so no factor)';
      floatSource = 'nse';
      floatChoice = floatChoice ?? {
        rule: 'nse-only-published-rupees', chose: 'nse', gapPct: null,
        thresholdPct: FLOAT_SOURCE_PREFER_NSE_GAP_PCT,
        why: 'not in BSE\'s equity master, so there is no full market cap to form a factor '
          + 'from; NSE publishes the rupee free float directly',
      };
    }

    if (floatFactorNse !== null && floatFactorBse !== null && floatFactorBse > 0) {
      disagreements.push({
        isin: company.isin,
        name: company.name,
        nseSymbol: company.nseSymbol,
        floatFactorNse,
        floatFactorBse,
        // Signed, relative to BSE, so the direction of the gap is visible.
        gapPct: round(((floatFactorNse - floatFactorBse) / floatFactorBse) * 100, 3),
        fullMcapInr,
      });
    }

    // ---- price and recompute -------------------------------------------
    // The EOD bhavcopy close is the committed floor. A live NSE quote overlays
    // this IN MEMORY in the browser and is never written here.
    const eod = company.bseScripCode ? (prices.prices?.[company.bseScripCode] ?? null) : null;
    const chosen = choosePrice({ eod, live: null });

    // What the exchange published at capture, kept so the recompute can be
    // compared against it rather than quietly replacing it.
    const freeFloatMcapAtCaptureInr = freeFloatMcapInr;

    const recomputed = recomputeFreeFloat(floatFactor, sharesOutstanding, chosen.price);
    if (recomputed.value !== null) {
      freeFloatMcapInr = recomputed.value;
      freeFloatBasis = recomputed.basis;
    }

    const stats = company.nseSymbol ? (quoteStats?.stats?.[company.nseSymbol] ?? null) : null;

    floatByKey.set(key, freeFloatMcapInr);

    const held = Object.values(company.funds).some((f) => f !== null);
    const methods = company._resolutions.map((r) => r.method);
    out.push({
      isin: company.isin,
      name: company.name,
      nseSymbol: company.nseSymbol,
      nseSymbolSource: company.nseSymbolSource ?? null,
      bseScripCode: company.bseScripCode,
      // The code the seed named, kept visible but never fetched, plus the reason
      // it is not the working scrip code.
      seedBseScripCode: company.seedBseScripCode ?? null,
      noBseReason: company.noBseReason ?? null,
      // 'equity' | 'invit-reit' | null. BSE's own GROUP code decides it.
      instrumentKind: company.instrumentKind ?? null,
      sector: company.sector,
      sectorSource: company.sectorSource,
      fullMcapInr,
      sharesOutstanding, // DERIVED: fullMcapInr / priceInr, both BSE
      priceInr,
      priceSource: priceInr === null ? null : 'bse',
      priceAsOf: bse?.priceAsOf ?? null,
      floatFactor,
      floatSource,
      // The rule that picked the source, on the record beside the number it
      // picked — a reader must be able to see WHY this row is BSE and that one
      // is NSE without opening the build script.
      floatChoice,
      floatFactorNse,
      floatFactorBse,
      floatGapPct,
      freeFloatMcapInr,
      freeFloatBasis, // the formula, on the record with the number
      // What the exchange published when the float file was captured. Kept
      // beside the recomputed figure so the two can be compared rather than
      // one silently replacing the other.
      freeFloatMcapAtCaptureInr,

      // ---- price, EOD. The live tier overlays this in the browser only. ----
      priceInr: chosen.price,
      prevCloseInr: chosen.prevClose,
      priceDate: chosen.date,
      priceStaleDays: chosen.staleDays,
      priceSource: chosen.source,
      priceTier: chosen.tier,
      priceExchange: chosen.exchange,
      // A stock that did not trade has NO day change. Not 0.0%.
      dayChangePct: round(dayChangePct(chosen.price, chosen.prevClose), 4),

      // ---- monthly statistics, NSE-sourced where available ----------------
      advQty: stats?.advQty ?? null,
      advSource: stats?.advSource ?? null,
      yearlyChangePct: stats?.yearlyChangePct ?? null,
      lastSplitFactor: stats?.lastSplitFactor ?? null,
      lastSplitDate: stats?.lastSplitDate ?? null,

      // ---- NSE Additional Surveillance Measure stage, if any --------------
      // NSE's published surveillance stage, carried through unchanged (tier 1).
      // null means NOT UNDER ASM when the feed loaded, and UNKNOWN when it did
      // not — the two are told apart by `asm.available` at the top of the record,
      // never here, because a per-company null cannot carry that distinction
      // (§2.3/§2.4). Joined on ISIN alone (§3.9).
      asm: (() => {
        const flag = company.isin ? (asmByIsin.get(company.isin) ?? null) : null;
        if (!flag) return null;
        return {
          category: flag.category,
          stage: flag.stage,
          survCode: flag.survCode,
          survDesc: flag.survDesc,
          asmDate: flag.asmDate,
        };
      })(),

      held,
      funds: company.funds,
      resolution: {
        method: methods[0] ?? 'not-held',
        via: company._resolutions[0]?.via ?? 'bse-universe',
        confidence: company._resolutions[0]?.confidence ?? 'exact',
      },
    });
  }

  out.sort((a, b) => (b.fullMcapInr ?? 0) - (a.fullMcapInr ?? 0));

  // ---- the FTSE book, joined and PROVED by a price it never states --------
  //
  // Vanguard publishes no ISIN (§3.9's only trusted key), so each holding is
  // proposed from a name and a house ticker and then arbitrated by arithmetic:
  // market value / shares is an implied share price in CAD, and converted at the
  // holdings-date rate it must equal the close this project already holds for
  // that company on that day — a figure from BSE, fetched by another script, for
  // a date the workbook fixes rather than we do.
  //
  // ⚠ THE MONEY COLUMN IS CANADIAN DOLLARS AND THE FILE NEVER SAYS SO. Read as
  // USD every rupee figure here would be 40.65% too large. `assertCurrency`
  // re-measures that on every build rather than trusting the fund's name.
  let ftseMeta = null;
  const ftseByIsin = new Map();
  if (ftseData) {
    const fund = ftseData.funds[0];

    // The FX rate for the holdings date. Both halves of a converted figure must
    // come from the same date (§3.8.2), so an exact hit is used where there is
    // one and any walk-back is recorded rather than absorbed.
    const cadSeries = ftseFx?.series ?? [];
    const exactFx = cadSeries.find((p) => p.date === fund.asOf) ?? null;
    const walkedFx = exactFx ?? [...cadSeries].reverse().find((p) => p.date <= fund.asOf) ?? null;
    const cadInr = walkedFx?.close ?? null;

    // The price basis: our own closes on the workbook's own date where we have
    // them. A basis struck days away is still useful — a wrong company is out by
    // multiples, not by a few sessions — but it is a weaker test and says so.
    const dates = priceHistory?.dates ?? [];
    const exactAt = dates.indexOf(fund.asOf);
    let basisDate = exactAt >= 0 ? fund.asOf : null;
    let gapSessions = 0;
    if (basisDate === null && dates.length) {
      const target = Date.parse(fund.asOf);
      let best = null;
      dates.forEach((d, i) => {
        const gap = Math.abs(Date.parse(d) - target);
        if (best === null || gap < best.gap) best = { d, i, gap };
      });
      // How far off the record we had to reach, counted in sessions we hold.
      const wouldBe = dates.findIndex((d) => d > fund.asOf);
      gapSessions = Math.abs((wouldBe < 0 ? dates.length : wouldBe) - best.i);
      if (gapSessions <= FTSE_JOIN.maxBasisGapSessions) basisDate = best.d;
    }
    const basisAt = basisDate ? dates.indexOf(basisDate) : -1;
    const closeByIsin = new Map();
    if (basisAt >= 0) {
      for (const scrip of Object.values(priceHistory.scrips ?? {})) {
        if (scrip.isin && scrip.closes?.[basisAt] != null) closeByIsin.set(scrip.isin, scrip.closes[basisAt]);
      }
    }
    const exactBasis = basisDate === fund.asOf;
    const basis = {
      date: basisDate,
      exact: exactBasis,
      closeByIsin,
      cadInr,
      tolerancePct: exactBasis ? FTSE_JOIN.joinTolerancePct : FTSE_JOIN.approximateTolerancePct,
    };

    const { results, methods, collisions } = resolveFtseHoldings(fund.holdings, buildFtseIndex(out), basis);

    // Two rows resolving to one company means one of them is the wrong company,
    // and both look well-formed downstream. Same rule as the MSCI resolver.
    checks.assert(collisions.length === 0,
      'no two FTSE holdings resolve to the same company',
      collisions.map((c) => `${c.isin}: ${c.names.join(' / ')}`).join('; ') || 'none');

    const currency = assertCurrency(results, { tolerancePct: FTSE_JOIN.currencyTolerancePct });
    checks.assert(currency.ok,
      `the FTSE book is struck in ${fund.currency} — implied prices agree with our own closes`,
      currency.ok
        ? `median ratio ${currency.median.toFixed(4)} across ${num(currency.compared)} rows`
        : currency.reason);
    if (!currency.ok) {
      process.stderr.write(`\n${currency.reason}\n\n`);
      process.exit(1);
    }

    for (const r of results) {
      if (!r.isin || ftseByIsin.has(r.isin)) continue;
      ftseByIsin.set(r.isin, {
        fundId: fund.id,
        fundShortName: fund.shortName,
        indexFamily: fund.indexFamily,
        ticker: r.holding.ticker,
        publishedName: r.holding.publishedName,
        // Vanguard's own percent OF THE WHOLE FUND. Not comparable with any MSCI
        // weight on this record — different fund, different denominator (§3.5).
        weightPct: r.holding.weightPct,
        weightPctPublished: r.holding.weightPctPublished,
        // Vanguard already rounded this one to nothing before we saw it; the
        // market value is the figure that survives (§2.20).
        weightRoundedToZero: r.holding.weightRoundedToZero,
        marketValueCad: r.holding.marketValueCad,
        quantity: r.holding.quantity,
        sector: r.holding.sector,
        asOf: fund.asOf,
        currency: fund.currency,
        join: {
          method: r.method,
          priceRatio: r.priceCheck?.ratio ?? null,
          priceCheck: r.priceCheck?.status ?? 'unavailable',
          basisDate: r.priceCheck?.date ?? null,
          tolerancePct: r.priceCheck?.tolerancePct ?? null,
        },
      });
    }

    const unresolvedRows = results.filter((r) => !r.isin);
    ftseMeta = {
      available: true,
      fundId: fund.id,
      fundName: fund.name,
      shortName: fund.shortName,
      indexFamily: fund.indexFamily,
      currency: fund.currency,
      asOf: fund.asOf,
      downloadedOn: fund.downloadedOn,
      note: ftseData.note,
      // Every count with its denominator (§2.5).
      indiaRows: fund.indiaRows,
      resolved: results.length - unresolvedRows.length,
      indiaWeightPct: fund.indiaWeightPct,
      resolvedWeightPct: results.filter((r) => r.isin).reduce((a, r) => a + (r.holding.weightPct ?? 0), 0),
      weightsExcludeCashAndFutures: fund.weightsExcludeCashAndFutures,
      totalWeightPct: fund.totalWeightPct,
      indiaMarketValueCad: fund.indiaMarketValueCad,
      totalMarketValueCad: fund.totalMarketValueCad,
      methods,
      currencyCheck: {
        medianPriceRatio: currency.median,
        compared: currency.compared,
        tolerancePct: FTSE_JOIN.currencyTolerancePct,
        establishedBy: ftseData.currency.establishedBy,
      },
      priceBasis: {
        date: basisDate,
        exact: exactBasis,
        gapSessions,
        cadInr,
        fxDate: walkedFx?.date ?? null,
        fxWalkedBack: Boolean(walkedFx && !exactFx),
        tolerancePct: basis.tolerancePct,
      },
      // Kept and named, never dropped: a holding we could not place is a gap in
      // our join, not an absence from the fund (§2.3, §2.4).
      unresolved: unresolvedRows.map((r) => ({
        ticker: r.holding.ticker,
        publishedName: r.holding.publishedName,
        nameKind: r.holding.nameKind,
        weightPct: r.holding.weightPct,
        marketValueCad: r.holding.marketValueCad,
        reason: r.reason,
      })),
    };
  }

  for (const company of out) {
    // A company FTSE does not hold has no FTSE row. That is "not held by this
    // fund" when the book loaded, and "we could not check" when it did not —
    // told apart by the top-level `ftse.available`, never by this null (§2.3).
    company.ftse = company.isin ? (ftseByIsin.get(company.isin) ?? null) : null;
  }

  // ---- passive drift and flow primitives ---------------------------------
  //
  // READ THE HEADER OF lib/recompute.mjs BEFORE CHANGING THIS.
  //
  // A stock's index weight rising on price alone forces NO trade: the fund's
  // holding gains value in exactly the same proportion as the weight does.
  // Drift is shown because it is how a stock closing on a size cut-off becomes
  // visible — never because it implies a purchase. `requiresTrade` is false on
  // every record here by construction.
  //
  // Weight drifts relative to the BASKET, not in absolute terms: the other
  // holdings moved too. So each fund's own capitalisation-weighted return is
  // computed first, and a stock's drift is its return measured against that.
  const byKeyRecord = new Map(out.map((c) => [c.isin ?? `bse:${c.bseScripCode}`, c]));

  const fundBasket = {};
  for (const fund of funds.funds) {
    let now = 0;
    let atCapture = 0;
    let members = 0;
    for (const record of resolved) {
      if (record.fundId !== fund.id) continue;
      const company = byKeyRecord.get(keyFor(record));
      if (!company) continue;
      if (company.freeFloatMcapInr === null || company.freeFloatMcapAtCaptureInr === null) continue;
      now += company.freeFloatMcapInr;
      atCapture += company.freeFloatMcapAtCaptureInr;
      members += 1;
    }
    fundBasket[fund.id] = {
      members,
      basketReturn: atCapture > 0 ? now / atCapture : null,
      coveredFreeFloatNowInr: now,
      coveredFreeFloatAtCaptureInr: atCapture,
    };
  }

  for (const record of resolved) {
    const company = byKeyRecord.get(keyFor(record));
    if (!company) continue;
    const basket = fundBasket[record.fundId];
    if (!basket?.basketReturn) continue;
    if (company.freeFloatMcapInr === null || !(company.freeFloatMcapAtCaptureInr > 0)) continue;

    const stockReturn = company.freeFloatMcapInr / company.freeFloatMcapAtCaptureInr;
    const drift = passiveDrift(record.holding.weightPct, stockReturn, basket.basketReturn);
    if (!drift) continue;

    company.passiveDrift = company.passiveDrift ?? {};
    company.passiveDrift[record.fundId] = {
      weightAtCapturePct: round(drift.weightAtCapturePct, 6),
      impliedWeightNowPct: round(drift.impliedWeightNowPct, 6),
      driftPp: round(drift.driftPp, 6),
      requiresTrade: drift.requiresTrade, // always false — price never forces a trade
    };
  }
  for (const company of out) {
    if (company.passiveDrift === undefined) company.passiveDrift = null;
  }

  // The FX rate is the WORKBOOK's own, as of the holdings date — never a live
  // one. Pairing a live rate with a month-old AUM would be precision on one
  // input pretending to be precision on the answer.
  const workbookFxRate = (() => {
    for (const fund of funds.funds) {
      for (const holding of fund.holdings) {
        if (Number.isFinite(holding.fxRate)) return holding.fxRate;
      }
    }
    return null;
  })();

  const flowPrimitivesByFund = {};
  for (const fund of funds.funds) {
    const primitives = flowPrimitives(fund, workbookFxRate);
    if (!primitives) continue;
    flowPrimitivesByFund[fund.id] = {
      shortName: fund.shortName,
      ...primitives,
      basketReturn: round(fundBasket[fund.id]?.basketReturn ?? null, 8),
      driftMembers: fundBasket[fund.id]?.members ?? 0,
      note:
        'INPUTS to a flow calculation, not a flow. No index event has been identified yet, so no ' +
        'rupee flow figure exists anywhere in this build.',
    };
  }


  // ---- segments, boundary, verdicts and flows ----------------------------
  //
  // The segment derivation rests on the three funds being disjoint. That is a
  // measured fact on the committed data, not an assumption, so it is re-checked
  // here every build: if a future holdings file breaks it, the derivation is
  // invalid and this must fail rather than silently pick a segment.
  // ⚠ THE OVERLAP IS CLASSIFIED, NOT JUST COUNTED. See segments.js: an overlap
  // whose two workbooks are dated differently, or whose losing leg is a residue
  // of the winning one, is a migration being read through two funds rather than
  // a break in the segment structure. Only an unexplained overlap — same date,
  // both legs substantial — invalidates the derivation, and that still fails.
  const holdingsAsOfByFund = Object.fromEntries(funds.funds.map((f) => [f.id, f.asOf ?? null]));
  const disjoint = assertDisjoint(out, holdingsAsOfByFund);
  checks.assert(
    disjoint.ok,
    'every EM-ETF/small-cap overlap is explained by a stale sibling file or a residual leg',
    disjoint.violations.slice(0, 5).map((v) => `${v.name}: ${v.funds.join('+')}`).join(' | '),
  );
  // The subset property cannot be tested across two dates, and passing it
  // anyway would be worse than failing it: EM SC "holding what India SC lacks"
  // is precisely what a stale EM SC file looks like after a review. `null` is
  // NOT MEASURABLE, and it is reported in those words rather than rounded to a
  // tick (§2.4).
  if (disjoint.emSmallCapSubsetComparable) {
    checks.assert(
      disjoint.emSmallCapIsSubset,
      'EM Small-Cap holds no India company that India Small-Cap lacks (it samples the segment)',
      disjoint.emSmallCapOnly.slice(0, 5).map((c) => c.name).join(' | '),
    );
  } else {
    checks.skip(
      'EM Small-Cap ⊆ India Small-Cap is NOT MEASURABLE — the two workbooks are dated '
      + `${disjoint.emSmallCapSubsetAsOf.smin} and ${disjoint.emSmallCapSubsetAsOf.eems}, so the `
      + `${disjoint.emSmallCapOnly.length} companies EM SC holds and India SC lacks are what a stale `
      + 'file looks like after a review, not a break in the sampling relationship',
    );
  }

  const keyOfCompany = (c) => c.isin ?? `bse:${c.bseScripCode}`;
  const boundary = observedBoundary(out, segmentOf);
  // The two size-segment cutoffs the verdicts are decided against: the Nth
  // company by FULL market cap across the whole record, where N is the number of
  // India names the funds show MSCI holding in that segment. See
  // observedSizeCutoffs() for why the coverage walk in gimi.js is not used here.
  const sizeCutoffs = observedSizeCutoffs(out, segmentOf);
  const ranks = rankByFreeFloat(out, keyOfCompany);
  const floatTotals = segmentFloatTotals(out);
  const quarantined = new Set(reconciliation?.quarantinedIsins ?? []);

  // ---- how far has each segment moved since the last review? -------------
  // The desk's rupee bands are absolute; MSCI's cut-offs are not. Floating the
  // bands by the segment's own price return is what makes a verdict account for
  // the index rather than only the company. Measured in RUPEES — see
  // model/benchmarks.js for why the dollar figure would be wrong by 9-13 points.
  //
  // ⚠ THE SAME ZERO-LENGTH WINDOW AS §2.12.3, ARRIVING ON A DIFFERENT PATH.
  //
  // `previousReview` is inclusive: on the day a review takes effect it returns
  // THAT review, with daysSince 0. The segment return is then struck over a
  // window of no elapsed time and comes out 0.000% for every segment — not a
  // segment that did not move, but a segment that has not been given a chance
  // to. Below `minMovePct` nothing floats, so on 31 Aug 2026 the record carried
  // no floated band at all and the daily refresh went red on verify-data 27 and
  // threw away four days of correctly fetched prices.
  //
  // `sinceRebalance` was given this walk-back on 1 Sep 2026 through
  // `chooseBaseline`; the band adjustment was not, and this is the same rule for
  // the same reason: a baseline needs a session strictly after it, or the
  // reading it produces is a fabricated zero.
  let lastReview = previousReview(reviewAnchor);
  if (lastReview && lastReview.effectiveDate >= prices.tradeDate) {
    const dayBefore = new Date(`${lastReview.effectiveDate}T00:00:00Z`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    const stepped = previousReview(dayBefore);
    process.stdout.write(
      `  band adjustment: the ${lastReview.label} review took effect ${lastReview.effectiveDate}, which is not\n`
      + `                   before the newest close ${prices.tradeDate}, so there is no session to measure over.\n`
      + `                   Baselined on ${stepped ? `${stepped.label} (${stepped.effectiveDate})` : 'nothing — no earlier review'} instead.\n`,
    );
    lastReview = stepped;
  }
  const fxMap = benchmarks ? seriesToMap(benchmarks.fx?.series ?? []) : null;
  // Keyed on the BENCHMARK id, not the fund id. INDA holds nothing here and has
  // fundId null, so a fund-keyed map would silently drop the Standard segment's
  // index — see the header of benchmarks.js on why those are two different jobs.
  const benchmarkById = {};
  if (benchmarks) {
    for (const fund of benchmarks.funds ?? []) {
      benchmarkById[fund.id ?? fund.fundId] = summarise(fund, fxMap, lastReview?.effectiveDate ?? null);
    }
  }
  const segmentReturns = {};
  for (const [segment, benchmarkId] of Object.entries(SEGMENT_BAND_ADJUSTMENT.benchmarkForSegment)) {
    segmentReturns[segment] = benchmarkById[benchmarkId]?.sinceLastReview?.inrPct ?? null;
  }

  // ---- relative performance, review window to review window --------------
  // Computed HERE and stored, not recomputed in the browser: this is a
  // historical window and no live price moves it. It is also 980 KB of price
  // history and 343 KB of corporate actions, which the browser has no reason to
  // download to answer a question whose answer cannot change during a session.
  const relativeByKey = new Map();
  const relativeStates = {};
  let relativeContext = null;
  if (priceHistory && corporateActions && benchmarks) {
    const dateIndex = new Map(priceHistory.dates.map((d, i) => [d, i]));
    const [windowFrom, windowTo] = priceHistory.windows;
    const fxForWindows = seriesToMap(benchmarks.fx?.series ?? []);

    // The index leg, in RUPEES, on exactly the Indian window dates. Both halves
    // of each product come from the same date; nothing is walked back, because a
    // fund CLOSE does not persist across a day the way an FX rate does.
    const indexCloses = {};
    for (const descriptor of FUND_BENCHMARKS) {
      const fund = (benchmarks.funds ?? []).find((f) => (f.id ?? f.fundId) === descriptor.id);
      if (!fund) continue;
      const closes = seriesToMap(fund.series ?? []);
      const inrOn = (date) => {
        const close = closes.get(date);
        const fx = rateOn(fxForWindows, date, 0);   // 0: the SAME date or nothing
        return close > 0 && fx?.rate > 0 ? close * fx.rate : null;
      };
      indexCloses[descriptor.id] = {
        descriptor,
        from: windowFrom.dates.map(inrOn),
        to: windowTo.dates.map(inrOn),
      };
    }

    for (const company of out) {
      const key = keyOfCompany(company);
      const code = company.bseScripCode != null ? String(company.bseScripCode) : null;
      const scrip = code ? priceHistory.scrips[code] : null;
      const actionRecord = code ? corporateActions.scrips[code] : null;
      const benchmarkId = RELATIVE_PERFORMANCE.benchmarkForSegment[segmentOf(company)] ?? null;
      const leg = benchmarkId ? indexCloses[benchmarkId] : null;

      const reading = assessRelative({
        hasPriceHistory: Boolean(scrip),
        closesFrom: windowFrom.dates.map((d) => scrip?.closes[dateIndex.get(d)] ?? null),
        closesTo: windowTo.dates.map((d) => scrip?.closes[dateIndex.get(d)] ?? null),
        indexFrom: leg?.from ?? [],
        indexTo: leg?.to ?? [],
        // NULL, not [], when BSE could not be read for this scrip. Unknown
        // actions are not the same fact as no actions, and only one of them
        // permits a return to be computed.
        actions: actionRecord ? actionRecord.actions : null,
        windowFromFrom: windowFrom.from,
        windowFromTo: windowFrom.to,
        windowToFrom: windowTo.from,
        windowToTo: windowTo.to,
        benchmark: leg?.descriptor ?? null,
      });
      relativeByKey.set(key, reading);
      relativeStates[reading.state] = (relativeStates[reading.state] ?? 0) + 1;
    }

    relativeContext = {
      from: { review: windowFrom.review, from: windowFrom.from, to: windowFrom.to, sessions: windowFrom.dates.length },
      to: { review: windowTo.review, from: windowTo.from, to: windowTo.to, sessions: windowTo.dates.length },
      benchmarkForSegment: RELATIVE_PERFORMANCE.benchmarkForSegment,
      bandPct: RELATIVE_PERFORMANCE.bandPct,
      nearBoundaryPct: RELATIVE_PERFORMANCE.nearBoundaryPct,
      basis: RELATIVE_PERFORMANCE.basis,
      attribution: RELATIVE_PERFORMANCE.attribution,
      windowNote: windowFrom.note,
      windowSource: windowFrom.source,
      states: relativeStates,
      stateMeanings: WINDOW_STATES,
      priceHistoryCapturedAt: priceHistory.capturedAt,
      actionsCapturedAt: corporateActions.capturedAt,
    };
  }

  // ---- since the REBALANCE DATE — the desk's own baseline ----------------
  //
  // ⚠ A DIFFERENT BASELINE FROM THE BLOCK ABOVE, AND A DIFFERENT NUMBER.
  //
  // Above measures MSCI's price window to MSCI's price window: 17-30 April to
  // 20-31 July for the August review. This measures from the day the May review
  // took EFFECT — 29 May — to the latest committed close. Six weeks apart at the
  // near end, and the desk asked for the latter.
  //
  // Every baseline the fetcher captured is computed, not only the default one,
  // so the reader can re-base the whole screen onto an earlier rebalance without
  // the browser needing the 2 MB of price history this loop reads.
  const rebaseByReview = new Map();     // review -> Map(companyKey -> reading)
  let rebaseContext = null;
  if (priceHistory && corporateActions && benchmarks && (priceHistory.baselines ?? []).length > 0) {
    const dateIndex = new Map(priceHistory.dates.map((d, i) => [d, i]));
    const fxForBaselines = seriesToMap(benchmarks.fx?.series ?? []);

    // The index leg in RUPEES on an EXACT date. `rateOn(..., 0)` means the same
    // date or nothing: a fund close does not persist across a day the way an FX
    // rate does, and walking either leg back would difference two different
    // dates and call the result relative performance.
    const indexInr = {};
    for (const descriptor of FUND_BENCHMARKS) {
      const fund = (benchmarks.funds ?? []).find((f) => (f.id ?? f.fundId) === descriptor.id);
      if (!fund) continue;
      const closes = seriesToMap(fund.series ?? []);
      indexInr[descriptor.id] = {
        descriptor,
        on: (date) => {
          const close = closes.get(date);
          const fx = rateOn(fxForBaselines, date, 0);
          return close > 0 && fx?.rate > 0 ? close * fx.rate : null;
        },
      };
    }

    const latestDate = prices.tradeDate;
    const rebaseStates = {};

    for (const baseline of priceHistory.baselines) {
      const byKey = new Map();
      const states = {};
      for (const company of out) {
        const key = keyOfCompany(company);
        const code = company.bseScripCode != null ? String(company.bseScripCode) : null;
        const scrip = code ? priceHistory.scrips[code] : null;
        const actionRecord = code ? corporateActions.scrips[code] : null;
        const benchmarkId = REBALANCE_BASELINE.benchmarkForSegment[segmentOf(company)] ?? null;
        const leg = benchmarkId ? indexInr[benchmarkId] : null;

        const reading = assessSinceRebalance({
          hasPriceHistory: Boolean(scrip),
          candidates: (baseline.dates ?? []).map((d) => ({
            date: d,
            close: scrip?.closes[dateIndex.get(d)] ?? null,
          })),
          baselineDate: baseline.resolvedDate,
          // ⚠ THE LATEST END IS THE COMMITTED EOD CLOSE, NEVER A LIVE QUOTE.
          // A live price is an NSE quote and the baseline is a BSE close, so
          // folding one in would put an exchange change inside a return — 2.10.
          latestClose: company.priceInr,
          latestDate,
          indexOn: (d) => leg?.on(d) ?? null,
          // NULL, not [], when BSE could not be read for this scrip: unknown
          // actions are not the same fact as no actions.
          actions: actionRecord ? actionRecord.actions : null,
          firstSeen: scrip?.firstSeen ?? null,
          benchmark: leg?.descriptor ?? null,
          band: REBALANCE_BASELINE.bandPct,
        });
        byKey.set(key, reading);
        states[reading.state] = (states[reading.state] ?? 0) + 1;
      }
      rebaseByReview.set(baseline.review, byKey);
      rebaseStates[baseline.review] = states;
    }

    /*
     * THE DEFAULT IS THE MOST RECENT REBALANCE THERE IS SOMETHING TO MEASURE
     * FROM, resolved against the newest session the exchange served — never
     * against the clock, so a build does not depend on when it ran.
     *
     * ⚠ "PASSED" IS NOT ENOUGH: A BASELINE NEEDS A SESSION AFTER IT.
     *
     * A review whose effective date IS the newest committed close gives a
     * window of zero length, and a zero-length window is not a zero return —
     * but it prints as one. Every company would read +0.0% against its index,
     * on three columns at once, and a reader would take that as "nothing has
     * moved since the rebalance" when it means "nothing has happened yet"
     * (CLAUDE.md §2.3, by the same route as a fabricated zero).
     *
     * That is not hypothetical: the August 2026 review takes effect on
     * 31 Aug 2026, and the first session that can measure anything from it is
     * 1 Sep. So the default walks back to the newest baseline with at least one
     * session strictly after it, and RECORDS the one it skipped and why —
     * `awaitingSession` travels to the screen, which says a rebalance has
     * happened that these columns cannot speak to yet. The moment a later
     * session lands, the next build moves the default on its own.
     */
    const choice = chooseBaseline(priceHistory.baselines, latestDate);
    const measurable = choice.measurable;
    const awaitingSession = choice.awaitingSession.map((b) => ({
      review: b.review,
      label: b.label,
      effectiveDate: b.effectiveDate,
      resolvedDate: b.resolvedDate ?? b.effectiveDate,
      reason: 'the rebalance date is the newest committed close, so there is no session after it to '
        + 'measure a return over — a window of zero length is not a return of zero',
    }));
    if (!measurable.length) {
      throw new Error(
        'No captured baseline has a session after it, so nothing can be measured from any rebalance. '
        + `Latest close ${latestDate}; captured ${priceHistory.baselines.map((b) => `${b.review}@${b.resolvedDate ?? b.effectiveDate}`).join(', ')}`,
      );
    }
    const defaultReview = REBALANCE_BASELINE.defaultReview ?? choice.defaultReview;
    if (!rebaseByReview.has(defaultReview)) {
      throw new Error(
        `REBALANCE_BASELINE.defaultReview is ${defaultReview}, which has no captured baseline. `
        + `Captured: ${priceHistory.baselines.map((b) => b.review).join(', ')}`,
      );
    }

    rebaseContext = {
      defaultReview,
      // Captured, in effect, and still not measurable — see above. Empty on
      // every ordinary build; non-empty for the few days after a rebalance.
      awaitingSession,
      latestDate,
      latestSource: 'the committed BSE bhavcopy close — never a live quote, which would put an '
        + 'exchange change inside a return',
      baselines: priceHistory.baselines.map((b) => ({
        review: b.review,
        label: b.label,
        effectiveDate: b.effectiveDate,
        resolvedDate: b.resolvedDate,
        walkedBackDays: b.walkedBackDays,
        tradedOnEffectiveDate: b.tradedOnEffectiveDate,
        sensitivitySpan: { from: b.from, to: b.to, sessions: b.sessions, days: b.sensitivityDays },
        states: rebaseStates[b.review],
      })),
      benchmarkForSegment: REBALANCE_BASELINE.benchmarkForSegment,
      bandPct: REBALANCE_BASELINE.bandPct,
      basis: REBALANCE_BASELINE.basis,
      attribution: REBALANCE_BASELINE.attribution,
      stateMeanings: REBASE_STATES,
      // The one thing this reading is not allowed to do, on the record and not
      // only on the screen — it travels into the export and into anything
      // reading the file directly.
      doesNotMoveVerdict:
        'This reading is evidence beside a verdict and never an input to one. A verdict turns on a '
        + 'rank by free-float market cap, and free float is float factor x shares x price — so '
        + "today's rank already contains this reading's price move. Letting it move the verdict "
        + 'would count the same evidence twice.',
      noTradeImplied:
        'A rising weight forces no trade. An index fund holds each member in proportion to its '
        + 'weight, so a price move changes both by the same proportion. Only a review forces a '
        + 'trade, which is why this carries a direction and never a rupee figure.',
      priceHistoryCapturedAt: priceHistory.capturedAt,
      actionsCapturedAt: corporateActions.capturedAt,
    };
  }

  const assessContext = { boundary, ranks, quarantined, keyOf: keyOfCompany, segmentReturns, sizeCutoffs };
  const flowContext = { flowPrimitives: flowPrimitivesByFund, segmentFloatTotals: floatTotals };

  const verdictCounts = {};
  const replayFailures = [];
  for (const company of out) {
    const assessment = assess(company, assessContext);
    const replayed = verdictFromRules(assessment.rulesFired);
    if (replayed !== assessment.verdict) {
      replayFailures.push(`${company.name}: assess() said ${assessment.verdict}, replay said ${replayed}`);
    }

    const { flows, notSampled, shape, asmConstraint } = estimateFlows(company, assessment, flowContext);

    company.segment = assessment.segment;
    company.assessment = {
      verdict: assessment.verdict,
      distancePct: assessment.distancePct,
      // The NSE ASM qualifier: the stage, and whether it BINDS a forced flow.
      // A qualifier on the flow, never on the verdict (§2.16 / config ASM_FLOW_
      // CONSTRAINT). Allowlisted here or it would exist only on screen.
      asm: assessment.asm,
      // ⚠ AN ALLOWLIST SILENTLY DROPS WHAT IT DOES NOT NAME. These two were
      // computed by assess() and thrown away here, so nothing reading
      // companies.json could tell which threshold a distance was measured
      // against or which model produced a verdict — the drill worked only
      // because the browser re-assesses in memory. Anything added to the
      // assessment must be added here too, or it exists only on screen.
      distanceRuleKey: assessment.distanceRuleKey,
      methodology: assessment.methodology,
      rulesFired: assessment.rulesFired,
      notes: assessment.notes,
      // Stated on the record, not only on the screen — this travels into the
      // export and into anything that reads the file directly.
      disclosure: DISCLOSURE,
      basis: 'end-of-day price; the interface re-assesses against a live price when one is in force',
    };
    company.flowEstimate = flows.length || notSampled.length
      ? { shape, flows, notSampled, asmConstraint: asmConstraint ?? null }
      : null;
    // A MEASUREMENT beside the verdict, never an input to it — see the header of
    // model/relative.js on why a rank already contains every past price move.
    company.relativePerformance = relativeByKey.get(keyOfCompany(company)) ?? null;
    // The desk's baseline: since the last rebalance took effect. Only the
    // DEFAULT baseline rides in companies.json; the alternates go to their own
    // file, fetched only if a reader actually re-bases the screen.
    // ⚠ THE SAME SHAPE AS THE ALTERNATES FILE, deliberately. The interface swaps
    // between the two when a reader re-bases the screen, so a reading that
    // carried its prose inline here and looked it up there would need two render
    // paths and would drift. `state` is the key into REBASE_STATES, which the
    // browser imports from the model — one copy of each sentence, not 1,265.
    company.sinceRebalance = (() => {
      if (!rebaseContext) return null;
      const reading = rebaseByReview.get(rebaseContext.defaultReview)?.get(keyOfCompany(company));
      if (!reading) return null;
      const { reason, label, benchmarkName, ...lean } = reading;
      return lean;
    })();
    if (quarantined.has(keyOfCompany(company))) {
      const finding = reconciliation.findings.find((f) => f.isin === company.isin);
      company.shareCountQuarantine = { reason: finding?.cause ?? 'share count could not be corroborated', gapPct: finding?.gapPct ?? null };
    } else {
      company.shareCountQuarantine = null;
    }

    verdictCounts[assessment.verdict] = (verdictCounts[assessment.verdict] ?? 0) + 1;
  }

  // A verdict whose recorded derivation does not reproduce it is worse than a
  // wrong verdict: the drill would show a derivation that did not produce the
  // answer beside it, which looks checkable and is not.
  checks.assert(
    replayFailures.length === 0,
    'every verdict is reproducible from its own rulesFired record',
    replayFailures.slice(0, 5).join(' | '),
  );

  // No quarantined company may carry a confident verdict.
  const confidentQuarantine = out.filter(
    (c) => c.shareCountQuarantine && c.assessment.verdict !== 'unknown',
  );
  checks.assert(
    confidentQuarantine.length === 0,
    'no company with a quarantined share count carries a confident verdict',
    confidentQuarantine.slice(0, 5).map((c) => `${c.name}=${c.assessment.verdict}`).join(' | '),
  );

  // `stable` and `unknown` never produce a rupee figure.
  const stableWithFlow = out.filter(
    (c) => ['stable', 'unknown'].includes(c.assessment.verdict) && (c.flowEstimate?.flows?.length ?? 0) > 0,
  );
  checks.assert(
    stableWithFlow.length === 0,
    'no stable or unknown verdict carries a rupee flow figure',
    stableWithFlow.slice(0, 5).map((c) => c.name).join(' | '),
  );

  // A migration is two flows in opposite directions, never netted.
  const badMigrations = out.filter((c) => {
    if (c.flowEstimate?.shape !== 'migration') return false;
    const dirs = new Set(c.flowEstimate.flows.map((f) => f.direction));
    return !(dirs.has('buy') && dirs.has('sell'));
  });
  checks.assert(
    badMigrations.length === 0,
    'every migration carries both a buy and a sell, in different funds',
    badMigrations.slice(0, 5).map((c) => c.name).join(' | '),
  );

  // EM Small-Cap only ever gets a flow for a company it currently samples.
  const badEmSc = out.filter((c) =>
    (c.flowEstimate?.flows ?? []).some((f) => f.fundId === 'eems' && !c.funds?.eems),
  );
  checks.assert(
    badEmSc.length === 0,
    'EM Small-Cap gets a flow only for companies it currently holds',
    badEmSc.slice(0, 5).map((c) => c.name).join(' | '),
  );

  // daysOfAdv is null, never zero, where the volume is unknown.
  const zeroAdv = out.filter((c) =>
    (c.flowEstimate?.flows ?? []).some((f) => f.advQty === null && f.daysOfAdv !== null),
  );
  checks.assert(
    zeroAdv.length === 0,
    'daysOfAdv is null where average daily volume is unknown',
    zeroAdv.slice(0, 5).map((c) => c.name).join(' | '),
  );

  // ---- the unit tripwire -------------------------------------------------
  // BSE publishes ₹ crore; everything here is rupees. A crore value that leaks
  // into a rupee field is a ten-million-fold error that looks like a formatting
  // bug and reads as a plausible small number.
  //
  // The obvious check — "no ...Inr field below ₹1e5 for a company above the
  // ₹2,000 Cr floor" — is necessary and NOT sufficient, and the reason is worth
  // stating because it took a deliberate sabotage run to notice:
  //
  //   1. Deciding "is this company large?" from the value under test is
  //      self-defeating. Divide Reliance's market cap by 1e7 and it drops below
  //      the ₹2,000 Cr floor, so the corrupted row exempts itself from the
  //      check that exists to catch it. Largeness is therefore judged from the
  //      BSE master's own indicative figure — a separate read of a separate
  //      field, which the corruption does not touch.
  //   2. A ₹1e5 floor is far too low for a large company anyway. ₹17.7 lakh
  //      crore divided by 1e7 is still ₹17.7 lakh, comfortably over the floor.
  //
  // So the load-bearing assertion is the third one: the per-scrip market cap and
  // the master's independently-fetched indicative market cap must agree to
  // within a factor of 100. They are struck at different moments and will never
  // be equal, but they cannot be a million times apart unless a unit was lost.
  const UNIT_FLOOR_INR = 1e5;
  const MAX_MAGNITUDE_RATIO = 100;
  const inrFields = ['fullMcapInr', 'freeFloatMcapInr'];
  const masterMcapByCode = new Map(
    master.scrips.map((s2) => [s2.scripCode, s2.indicativeFullMcapInr]),
  );

  const unitSuspects = [];
  const magnitudeSuspects = [];
  for (const company of out) {
    const indicative = company.bseScripCode ? masterMcapByCode.get(company.bseScripCode) : null;

    // Largeness from the master, never from the field under test.
    const large = (indicative ?? 0) >= SCRAPE_UNIVERSE_MIN_FULL_MCAP_INR;
    if (large) {
      for (const field of inrFields) {
        const value = company[field];
        if (value !== null && value < UNIT_FLOOR_INR) {
          unitSuspects.push(`${company.name} (${company.bseScripCode ?? company.isin}) ${field}=${value}`);
        }
      }
    }

    if (indicative !== null && indicative !== undefined && indicative > 0 && company.fullMcapInr !== null) {
      const ratio = company.fullMcapInr / indicative;
      if (ratio > MAX_MAGNITUDE_RATIO || ratio < 1 / MAX_MAGNITUDE_RATIO) {
        magnitudeSuspects.push(
          `${company.name} (${company.bseScripCode}): per-scrip ₹${num(company.fullMcapInr)} vs master ₹${num(indicative)} — ratio ${ratio.toExponential(2)}`,
        );
      }
    }
  }
  checks.assert(
    unitSuspects.length === 0,
    `no ...Inr field below ₹${num(UNIT_FLOOR_INR)} for a company the BSE master sizes above the ₹${num(Math.round(toCrore(SCRAPE_UNIVERSE_MIN_FULL_MCAP_INR)))} Cr floor`,
    unitSuspects.slice(0, 10).join(' | '),
  );
  checks.assert(
    magnitudeSuspects.length === 0,
    `per-scrip and master market caps agree within a factor of ${MAX_MAGNITUDE_RATIO} (the unit tripwire)`,
    magnitudeSuspects.slice(0, 10).join(' | '),
  );
  checks.assert(
    out.every((c) => c.floatFactor === null || (c.floatFactor > 0 && c.floatFactor <= 1.02)),
    'every float factor is in (0, 1.02]',
    out.filter((c) => c.floatFactor !== null && (c.floatFactor <= 0 || c.floatFactor > 1.02))
      .slice(0, 5).map((c) => `${c.name}=${c.floatFactor}`).join(' | '),
  );
  // floatSource 'nse' means the reading came from NSE, in one of exactly two
  // ways: a factor we derived, or a rupee free float NSE published outright for
  // a company with no full market cap to divide by. Anything else claiming NSE
  // provenance has nothing behind it.
  checks.assert(
    out.every((c) => c.floatSource !== 'nse'
      || c.floatFactorNse !== null
      || (c.freeFloatMcapInr !== null && c.freeFloatBasis?.startsWith('NSE published'))),
    'floatSource "nse" always has either an NSE factor or an NSE-published market cap behind it',
    out.filter((c) => c.floatSource === 'nse' && c.floatFactorNse === null
      && !(c.freeFloatMcapInr !== null && c.freeFloatBasis?.startsWith('NSE published')))
      .slice(0, 5).map((c) => c.name).join(' | '),
  );
  checks.assert(
    out.every((c) => c.floatSource !== 'bse' || c.floatFactorBse !== null),
    'floatSource "bse" always has a BSE factor behind it',
    out.filter((c) => c.floatSource === 'bse' && c.floatFactorBse === null)
      .slice(0, 5).map((c) => c.name).join(' | '),
  );
  // The recompute must be reversible: floatFactor x shares x price recovers the
  // stored free float. A relative tolerance because sharesOutstanding is itself
  // a rounded integer, so the product cannot be bit-exact.
  const roundTripFailures = [];
  for (const company of out) {
    if (company.freeFloatMcapInr === null || company.floatFactor === null) continue;
    if (company.sharesOutstanding === null || company.priceInr === null) continue;
    const expected = company.floatFactor * company.sharesOutstanding * company.priceInr;
    if (expected <= 0) continue;
    const relative = Math.abs(company.freeFloatMcapInr - expected) / expected;
    if (relative > 1e-6) {
      roundTripFailures.push(`${company.name}: stored ${company.freeFloatMcapInr} vs ${Math.round(expected)} (rel ${relative.toExponential(2)})`);
    }
  }
  checks.assert(
    roundTripFailures.length === 0,
    'floatFactor × sharesOutstanding × price recovers freeFloatMcapInr for every company',
    roundTripFailures.slice(0, 5).join(' | '),
  );

  // If every drift shares a sign, the drift is measuring the market's move
  // rather than each stock's move relative to it — almost always prices from
  // two different dates. A one-sided distribution is a bug, not a finding.
  const driftValues = out
    .flatMap((c) => Object.values(c.passiveDrift ?? {}))
    .map((d) => d.driftPp)
    .filter((v) => Number.isFinite(v) && v !== 0);
  const positiveDrift = driftValues.filter((v) => v > 0).length;
  const negativeDrift = driftValues.filter((v) => v < 0).length;
  checks.assert(
    driftValues.length === 0 || (positiveDrift > 0 && negativeDrift > 0),
    'passive drift is both-signed (a one-sided distribution means prices from different dates)',
    `${positiveDrift} positive, ${negativeDrift} negative of ${driftValues.length}`,
  );

  checks.assert(
    out.every((c) => Object.values(c.passiveDrift ?? {}).every((d) => d.requiresTrade === false)),
    'no passive-drift record claims a trade is required',
    'price movement never forces an index fund to trade',
  );

  checks.assert(
    out.every((c) => (c.freeFloatMcapInr === null) === (c.freeFloatBasis === null)),
    'a free-float figure and its stated formula are always both present or both absent',
    out.filter((c) => (c.freeFloatMcapInr === null) !== (c.freeFloatBasis === null))
      .slice(0, 5).map((c) => c.name).join(' | '),
  );

  // Every ASM stage carried on a company is NSE's OWN, joined by ISIN alone and
  // carried through unchanged — never invented, and never a symbol match (§3.9).
  // Both directions: a flagged company matches the source exactly, and a null
  // company whose ISIN IS in the source is a missed join, not "not flagged".
  const asmOffenders = out.filter((c) => {
    if (c.asm !== null) {
      const src = asmByIsin.get(c.isin);
      return !src
        || src.survCode !== c.asm.survCode
        || src.stage !== c.asm.stage
        || src.survDesc !== c.asm.survDesc
        || src.category !== c.asm.category;
    }
    // asm is null: only legitimate if the feed did not load, or this ISIN is
    // genuinely absent from NSE's list.
    return asmData !== null && c.isin && asmByIsin.has(c.isin);
  });
  checks.assert(
    asmOffenders.length === 0,
    "every ASM stage on a company is NSE's own, joined by ISIN and carried unchanged",
    asmOffenders.slice(0, 5).map((c) => `${c.isin} ${c.name}`).join(' | '),
  );

  // ---- coverage: every denominator the UI will print ---------------------
  const coverage = {
    companies: out.length,
    held: out.filter((c) => c.held).length,
    notHeld: out.filter((c) => !c.held).length,
    // The usable screening number.
    withFloat: out.filter((c) => c.freeFloatMcapInr !== null).length,
    // The subset that also has a price-independent factor, i.e. the ones a daily
    // price move can re-value without a fresh scrape. Strictly smaller, and the
    // difference is worth seeing.
    withFloatFactor: out.filter((c) => c.floatFactor !== null).length,
    floatFromNse: out.filter((c) => c.floatSource === 'nse').length,
    floatFromBse: out.filter((c) => c.floatSource === 'bse').length,
    // How the desk's BSE-primary rule actually landed. Derived here so nothing
    // downstream — screen, caption or doc — has to type a count that will go
    // stale on the next refresh.
    floatChoice: {
      bsePrimary: out.filter((c) => c.floatChoice?.rule === 'bse-primary').length,
      bseOnly: out.filter((c) => c.floatChoice?.rule === 'bse-only').length,
      nsePreferredOnGap: out.filter((c) => c.floatChoice?.rule === 'nse-preferred-on-material-gap').length,
      nseOnly: out.filter((c) => c.floatChoice?.rule === 'nse-only').length,
      nseOnlyPublishedRupees: out.filter((c) => c.floatChoice?.rule === 'nse-only-published-rupees').length,
      comparable: out.filter((c) => c.floatGapPct !== null).length,
      switchPointPct: FLOAT_SOURCE_PREFER_NSE_GAP_PCT,
    },
    withoutFloat: out.filter((c) => c.freeFloatMcapInr === null).length,
    withBothFactors: disagreements.length,
    // Price tiers. `live` never appears here — it exists only in the browser.
    pricedEod: out.filter((c) => c.priceTier === 'eod').length,
    pricedStale: out.filter((c) => c.priceTier === 'stale').length,
    unpriced: out.filter((c) => c.priceTier === null).length,
    // How many rows a live quote could EVER reach. Munshot is keyed on NSE
    // tickers, so a company with no asserted NSE symbol stays on EOD for ever.
    liveEligible: out.filter((c) => c.nseSymbol !== null).length,
    liveIneligible: out.filter((c) => c.nseSymbol === null).length,
    withAdv: out.filter((c) => c.advQty !== null).length,
    // NSE Additional Surveillance Measure. `asmFlagged` is companies IN THE
    // UNIVERSE under ASM; the full NSE list is larger, since many ASM names sit
    // below the desk's floor and are not tracked here. `null` when the feed did
    // not load — never 0, which would read as "nobody is under ASM" (§2.4).
    asmFlagged: asmData ? out.filter((c) => c.asm !== null).length : null,
    byFund: {},
  };

  const companiesByFundRow = new Map();
  for (const record of resolved) {
    const key = keyFor(record);
    if (key !== null) companiesByFundRow.set(`${record.fundId}:${record.rowIndex}`, key);
  }
  for (const fund of funds.funds) {
    const holdings = fund.holdings.length;
    const fundResolved = resolved.filter((r) => r.fundId === fund.id);
    const fundUnresolved = unresolved.filter((r) => r.fundId === fund.id);
    let withFloatCount = 0;
    let weightWithFloat = 0;
    for (const record of fundResolved) {
      const key = companiesByFundRow.get(`${record.fundId}:${record.rowIndex}`);
      if (key !== undefined && floatByKey.get(key) !== null && floatByKey.get(key) !== undefined) {
        withFloatCount += 1;
        weightWithFloat += record.holding.weightPct ?? 0;
      }
    }
    coverage.byFund[fund.id] = {
      shortName: fund.shortName,
      holdings,
      resolved: fundResolved.length,
      unresolved: fundUnresolved.length,
      withFloat: withFloatCount,
      indiaWeightPct: fund.indiaWeightPct,
      weightResolved: round(fundResolved.reduce((a, r) => a + (r.holding.weightPct ?? 0), 0), 5),
      weightWithFloat: round(weightWithFloat, 5),
    };
  }

  // ---- report ------------------------------------------------------------
  process.stdout.write('\nCompany record build\n\n');
  process.stdout.write(
    renderTable(
      [
        { key: 'fund', label: 'Fund', align: 'left' },
        { key: 'resolved', label: 'Resolved', align: 'right' },
        { key: 'withFloat', label: 'With free float', align: 'right' },
        { key: 'weight', label: 'India weight covered', align: 'right' },
        { key: 'pct', label: '% of weight', align: 'right' },
      ],
      funds.funds.map((f) => {
        const c = coverage.byFund[f.id];
        return {
          fund: c.shortName,
          resolved: `${num(c.resolved)} of ${num(c.holdings)}`,
          withFloat: `${num(c.withFloat)} of ${num(c.holdings)}`,
          weight: `${c.weightWithFloat.toFixed(3)} of ${c.indiaWeightPct.toFixed(3)}`,
          pct: `${((c.weightWithFloat / c.indiaWeightPct) * 100).toFixed(1)}%`,
        };
      }),
    ),
  );

  process.stdout.write('\n\nResolution method histogram (holding rows across all three funds)\n\n');
  process.stdout.write(
    renderTable(
      [
        { key: 'method', label: 'Method', align: 'left' },
        { key: 'n', label: 'Rows', align: 'right' },
        { key: 'what', label: 'What it proves', align: 'left' },
      ],
      Object.entries(methodCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([method, n]) => ({
          method,
          n: num(n),
          what: {
            scrip_id: "exact match on BSE's own scrip id",
            scrip_code: 'exact match on the numeric BSE scrip code',
            isin: 'ticker -> NSE symbol -> ISIN -> BSE scrip',
            name: 'exact normalised name, unique in the BSE master',
            confirmed: 'hand-checked and pinned by ISIN',
            none: 'not resolved — kept with a stated reason',
          }[method] ?? '',
        })),
    ),
  );

  process.stdout.write('\n\nFloat coverage across the whole company record\n\n');
  process.stdout.write(
    renderTable(
      [
        { key: 'what', label: 'Measure', align: 'left' },
        { key: 'n', label: 'Count', align: 'right' },
      ],
      [
        { what: 'companies in the record', n: num(coverage.companies) },
        { what: '— held by at least one fund', n: `${num(coverage.held)} of ${num(coverage.companies)}` },
        { what: '— not held (inclusion candidates)', n: `${num(coverage.notHeld)} of ${num(coverage.companies)}` },
        { what: 'with a free-float market cap', n: `${num(coverage.withFloat)} of ${num(coverage.companies)}` },
        { what: '— from NSE (material gap, or BSE has nothing)', n: num(coverage.floatFromNse) },
        { what: '— from BSE (the primary source)', n: num(coverage.floatFromBse) },
        { what: 'also with a price-independent factor', n: `${num(coverage.withFloatFactor)} of ${num(coverage.withFloat)}` },
        { what: 'with NO float reading at all', n: num(coverage.withoutFloat) },
        { what: 'with BOTH readings (comparable)', n: num(coverage.withBothFactors) },
      ],
    ),
  );

  // ---- NSE vs BSE disagreement ------------------------------------------
  const sorted = [...disagreements].sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct));
  const absGaps = disagreements.map((d) => Math.abs(d.gapPct)).sort((a, b) => a - b);
  const median = absGaps.length
    ? (absGaps.length % 2
      ? absGaps[(absGaps.length - 1) / 2]
      : (absGaps[absGaps.length / 2 - 1] + absGaps[absGaps.length / 2]) / 2)
    : null;
  const overThreshold = sorted.filter((d) => Math.abs(d.gapPct) > FLOAT_FACTOR_DISAGREEMENT_REVIEW_PCT);

  process.stdout.write(
    `\n\nNSE vs BSE float factor — ${num(disagreements.length)} companies where both publish a reading\n` +
      `  median |gap| ${median === null ? '—' : `${median.toFixed(3)}%`}` +
      `   worst |gap| ${sorted.length ? `${Math.abs(sorted[0].gapPct).toFixed(3)}%` : '—'}` +
      `   over ${FLOAT_FACTOR_DISAGREEMENT_REVIEW_PCT}%: ${num(overThreshold.length)}\n\n`,
  );
  process.stdout.write(
    renderTable(
      [
        { key: 'name', label: 'Company', align: 'left' },
        { key: 'sym', label: 'NSE', align: 'left' },
        { key: 'nse', label: 'NSE factor', align: 'right' },
        { key: 'bse', label: 'BSE factor', align: 'right' },
        { key: 'gap', label: 'Gap vs BSE', align: 'right' },
        { key: 'mcap', label: 'Full mcap ₹Cr', align: 'right' },
      ],
      sorted.slice(0, 10).map((d) => ({
        name: d.name.slice(0, 34),
        sym: d.nseSymbol ?? '—',
        nse: d.floatFactorNse.toFixed(4),
        bse: d.floatFactorBse.toFixed(4),
        gap: `${d.gapPct >= 0 ? '+' : ''}${d.gapPct.toFixed(2)}%`,
        mcap: d.fullMcapInr === null ? '—' : num(Math.round(toCrore(d.fullMcapInr))),
      })),
    ),
  );
  process.stdout.write(
    '\n\n  These are two different float DEFINITIONS, not two attempts at one number.\n' +
      '  NSE is used wherever it exists because MSCI follows NSE; BSE fills the gaps.\n' +
      '  Neither is averaged into the other and both stay on every record.\n',
  );

  // ---- the model ---------------------------------------------------------
  process.stdout.write('\n\nSegments — derived from the holdings, disjointness re-checked every build\n\n');
  process.stdout.write(
    renderTable(
      [
        { key: 'segment', label: 'Segment', align: 'left' },
        { key: 'n', label: 'Companies', align: 'right' },
        { key: 'median', label: 'Median free float', align: 'right' },
      ],
      [
        { segment: 'MSCI India Standard (EM ETF)', n: num(disjoint.counts.standard), median: `₹${num(Math.round(toCrore(boundary.standardMedianInr)))} Cr` },
        { segment: 'MSCI India Small Cap', n: num(disjoint.counts.smallcap), median: `₹${num(Math.round(toCrore(boundary.smallCapMedianInr)))} Cr` },
        { segment: 'Outside MSCI India IMI', n: num(disjoint.counts.outside), median: `₹${num(Math.round(toCrore(boundary.outsideMedianInr)))} Cr` },
      ],
    ),
  );
  process.stdout.write(
    `\n  disjoint: ${disjoint.ok ? 'yes — no company in two segments' : 'NO — VIOLATIONS'}` +
    ` | EM Small-Cap is a strict subset of India Small-Cap: ${disjoint.emSmallCapIsSubset ? 'yes' : 'NO'}` +
    ` (${num(disjoint.emSmallCapSampled)} of ${num(disjoint.indiaSmallCapTotal)} sampled)\n`,
  );

  process.stdout.write('\n\nObserved boundary — measured from current constituents, not assumed\n\n');
  process.stdout.write(
    renderTable(
      [
        { key: 'what', label: 'Measure', align: 'left' },
        { key: 'v', label: 'Value', align: 'right' },
        { key: 'who', label: 'Company', align: 'left' },
      ],
      [
        { what: 'Standard floor (smallest Standard constituent)', v: `₹${num(Math.round(toCrore(boundary.standardFloorInr)))} Cr`, who: boundary.standardFloorCompany?.name ?? '—' },
        { what: 'Small Cap ceiling (largest Small Cap constituent)', v: `₹${num(Math.round(toCrore(boundary.smallCapCeilingInr)))} Cr`, who: boundary.smallCapCeilingCompany?.name ?? '—' },
        { what: 'overlap width', v: `₹${num(Math.round(toCrore(boundary.overlapWidthInr)))} Cr`, who: `${boundary.overlapRatio?.toFixed(2)}x` },
        { what: 'companies inside the overlap', v: num(boundary.overlapCount), who: `standard ${boundary.overlapBySegment.standard} · small cap ${boundary.overlapBySegment.smallcap} · outside ${boundary.overlapBySegment.outside}` },
        { what: `rank cutoff (${boundary.standardCount}th largest free float)`, v: `₹${num(Math.round(toCrore(boundary.rankCutoffInr)))} Cr`, who: boundary.rankCutoffCompany?.name ?? '—' },
      ],
    ),
  );
  process.stdout.write(
    '\n\n  The Standard floor cannot classify a Standard constituent — it IS the smallest one, so a\n' +
    '  "below the floor" test can never fire. The rank cutoff is the non-circular discriminator:\n' +
    '  it compares each company against the whole universe rather than against its own segment.\n',
  );

  process.stdout.write('\n\nVerdicts\n\n');
  process.stdout.write(
    renderTable(
      [
        { key: 'verdict', label: 'Verdict', align: 'left' },
        { key: 'n', label: 'Companies', align: 'right' },
        { key: 'what', label: 'Rule', align: 'left' },
      ],
      Object.keys(VERDICTS)
        .filter((k) => verdictCounts[k])
        .map((k) => ({ verdict: VERDICTS[k].label, n: `${num(verdictCounts[k])} of ${num(out.length)}`, what: VERDICTS[k].detail })),
    ),
  );
  const review = nextReview(reviewAnchor);
  process.stdout.write(
    `\n\n  ${DISCLOSURE}\n` +
    `  Next review (ASSUMED): ${review?.label ?? '—'}, effective ${review?.effectiveDate ?? '—'}, ${review?.daysRemaining ?? '—'} days away.\n` +
    `  ${num(quarantined.size)} company(ies) carry "unknown" because their share count could not be corroborated.\n`,
  );

  // ---- unresolved --------------------------------------------------------
  process.stdout.write(
    `\n\nUnresolved holdings — ${num(unresolved.length)} rows kept with a stated reason\n\n`,
  );
  const unresolvedOut = unresolved
    .map((r) => ({
      fundId: r.fundId,
      rowIndex: r.rowIndex,
      ticker: r.holding.ticker,
      name: r.holding.name,
      weightPct: r.holding.weightPct,
      reason: r.reason,
    }))
    .sort((a, b) => (b.weightPct ?? 0) - (a.weightPct ?? 0));
  for (const u of unresolvedOut) {
    process.stdout.write(
      `  ${u.fundId.padEnd(5)} ${String(u.ticker).padEnd(11)} ${String(round(u.weightPct, 5)).padStart(8)}%  ${u.name}\n` +
        `        ${u.reason}\n`,
    );
  }

  // A SKIP IS A RESULT AND IS ALWAYS PRINTED. A build that quietly stops
  // testing something and still reports a clean sheet manufactures confidence
  // rather than providing it — so the skips go out on every run, passing or
  // failing, before the write decision.
  if (checks.skipped.length > 0) {
    process.stdout.write(`\nNot measurable on this record — ${checks.skipped.length} check(s) skipped:\n\n`);
    checks.printSkips();
    process.stdout.write('\n');
  }

  if (!checks.passed) {
    process.stderr.write(`\nREFUSING TO WRITE ${rel(OUT_PATH)} — ${checks.failures.length} check(s) failed:\n\n`);
    checks.print();
    process.stderr.write('\n');
    process.exit(1);
  }

  const payload = {
    source: 'iShares holdings + NSE pre-open free float + BSE free float + niftyindices ISIN map',
    note:
      'floatFactor is dimensionless and price-independent. NSE wins wherever it publishes a reading '
      + 'because MSCI follows NSE; BSE fills gaps only. The two are never averaged, and where both '
      + 'exist both are kept so the disagreement stays inspectable. Every monetary field is RUPEES. '
      + 'A null in funds{} means NOT HELD by that fund — it is not a zero weight.',
    builtAt: new Date().toISOString(),
    // WHICH FUND IS ON WHICH DATE. Deliberately NOT inside `asOf`: that block is
    // a registry of single dated feeds and the freshness surface walks it key by
    // key, so an object sitting among the dates is a key no feed can carry.
    // Kept beside it so a surface can NAME the stale fund rather than leave a
    // reader to infer it from one date.
    holdingsAsOfByFund: Object.fromEntries(funds.funds.map((fund) => [fund.id, fund.asOf ?? null])),
    asOf: {
      // ⚠ THE OLDEST OF THE THREE, NEVER THE FIRST. This read `funds[0].asOf`
      // while all three workbooks shared a date, and was harmless only for
      // that reason. EEM and SMIN were refreshed for the August 2026 review
      // and EEMS was not, so the first fund is now the NEWEST — and the
      // freshness pill, which exists to name the oldest input, would have
      // claimed a fortnight of currency the record does not have (§2.10).
      isharesHoldings: funds.funds
        .map((fund) => fund.asOf)
        .filter((date) => typeof date === 'string')
        .sort()[0] ?? null,
      // Vanguard's own as-at date for the FTSE book, carried verbatim. It is a
      // month behind the iShares workbooks, which is why it is its own key
      // rather than being folded into any shared freshness claim (§2.10).
      ftseHoldings: ftseMeta?.asOf ?? null,
      nseSession: nseFreeFloat.sessionTimestamp,
      bseCapturedAt: bseFreeFloat.capturedAt,
      bhavcopyTradeDate: prices.tradeDate,
      quoteStatsCapturedAt: quoteStats?.capturedAt ?? null,
      // The benchmark series' own newest close — not capturedAt. A fetch that
      // ran today over a series that ends four days ago is four days stale, and
      // this is the field the freshness registry reads.
      benchmarksAsOf: benchmarks?.asOf ?? null,
      bseScripMasterCapturedAt: master.capturedAt,
      nseUniverseCapturedAt: nseUniverse.capturedAt,
      // NSE's own effective date for the ASM list (asmData.asOf), not when we
      // fetched it — the same as/capturedAt distinction every NSE feed keeps.
      asmAsOf: asmData?.asOf ?? null,
    },
    thresholds: {
      scrapeUniverseMinFullMcapInr: SCRAPE_UNIVERSE_MIN_FULL_MCAP_INR,
      floatFactorDisagreementReviewPct: FLOAT_FACTOR_DISAGREEMENT_REVIEW_PCT,
      floatSourcePreferNseGapPct: FLOAT_SOURCE_PREFER_NSE_GAP_PCT,
      floatSourceRule: FLOAT_SOURCE_RULE,
      attribution:
        "the desk's own heuristics, from public/js/config/thresholds.mjs — MSCI does not publish these cut-offs",
    },
    coverage,
    // How each fund's own basket has moved, and the band adjustment derived from
    // it. Tier 1 for the closes (Yahoo's), tier 2 for every return (ours).
    benchmarks: benchmarks ? {
      source: benchmarks.source,
      note: benchmarks.note,
      returnBasis: benchmarks.returnBasis,
      currencyNote: benchmarks.currencyNote,
      capturedAt: benchmarks.capturedAt,
      asOf: benchmarks.asOf,
      lastReview: lastReview ? { label: lastReview.label, effectiveDate: lastReview.effectiveDate, assumed: true } : null,
      adjustment: {
        enabled: SEGMENT_BAND_ADJUSTMENT.enabled,
        basis: SEGMENT_BAND_ADJUSTMENT.basis,
        attribution: SEGMENT_BAND_ADJUSTMENT.attribution,
        minMovePct: SEGMENT_BAND_ADJUSTMENT.minMovePct,
        benchmarkForSegment: SEGMENT_BAND_ADJUSTMENT.benchmarkForSegment,
        segmentReturnsInrPct: segmentReturns,
      },
      funds: Object.values(benchmarkById),
    } : null,
    relativePerformance: relativeContext,
    sinceRebalance: rebaseContext,
    prices: {
      tradeDate: prices.tradeDate,
      source: prices.source,
      capturedAt: prices.capturedAt,
      pricedCount: prices.pricedCount,
      carriedForwardCount: prices.carriedForwardCount,
      missingCount: prices.missingCount,
      continuityFailures: prices.continuity?.failures?.length ?? null,
    },
    quoteStats: quoteStats
      ? { capturedAt: quoteStats.capturedAt, companyCount: quoteStats.companyCount, source: quoteStats.source }
      : null,
    // ---- NSE Additional Surveillance Measure -----------------------------
    // `available` is the load-bearing field: it tells the browser whether a
    // company's null `asm` means NOT UNDER ASM (feed loaded, company absent from
    // the complete list) or UNKNOWN (feed did not load). Without it, an outage
    // would render as "every company is clear" — the §2.4 lie. `flaggedInUniverse`
    // is derived from the records; the stage legend is derived too, never typed.
    // ---- the FTSE book ----------------------------------------------------
    // A SECOND OPINION, deliberately inert. FTSE runs its own index with its own
    // constituents, size rules and review calendar, so nothing here feeds an
    // MSCI segment, cutoff, verdict or flow — the holdings land in each
    // company's own `ftse` field and in nothing else. `available` tells a null
    // "FTSE does not hold this" apart from "the book did not load" (§2.4).
    ftse: ftseMeta ?? {
      available: false,
      note: 'the FTSE book did not load, so a company without an FTSE row is UNKNOWN, not unheld',
    },
    asm: {
      available: Boolean(asmData),
      source: asmData?.source
        ?? 'NSE Additional Surveillance Measure (ASM) report — nseindia.com/api/reportASM',
      publisher: 'National Stock Exchange of India',
      endpoint: asmData?.endpoint ?? 'https://www.nseindia.com/api/reportASM',
      note:
        'NSE\'s published surveillance stage, carried through unchanged (tier 1) and joined to the '
        + 'universe by ISIN. dhan.co/nse-asm-list mirrors this same NSE feed. A company not on the '
        + 'list is NOT under ASM; a null stage when the feed is unavailable means we could not check.',
      capturedAt: asmData?.capturedAt ?? null,
      asOf: asmData?.asOf ?? null,
      // The whole NSE list vs the part that lands on a tracked company. Most ASM
      // names sit below the desk's floor, so the second is much smaller.
      totalFlagged: asmData?.totalFlagged ?? null,
      flaggedInUniverse: asmData ? out.filter((c) => c.asm !== null).length : null,
      // The stages present ON THE SCREEN, with counts — a legend the reader can
      // trust because it is measured from the records, not hand-listed.
      stagesInUniverse: asmData
        ? Object.fromEntries(
            [...out.reduce((m, c) => {
              if (!c.asm) return m;
              const code = c.asm.survCode ?? c.asm.stage ?? '(unknown stage)';
              return m.set(code, (m.get(code) ?? 0) + 1);
            }, new Map()).entries()].sort((a, b) => b[1] - a[1]),
          )
        : null,
      categories: asmData?.categories ?? null,
      failed: asmData?.failed ?? [],
    },
    flowPrimitives: flowPrimitivesByFund,
    model: {
      disclosure: DISCLOSURE,
      basis: 'Verdicts here are computed against the committed end-of-day price. The interface '
        + 're-assesses against a live price when one is in force, exactly as free-float market cap is.',
      segments: disjoint.counts,
      segmentsDisjoint: disjoint.ok,
      emSmallCapIsSubsetOfIndiaSmallCap: disjoint.emSmallCapIsSubset,
      emSmallCapSampled: disjoint.emSmallCapSampled,
      indiaSmallCapTotal: disjoint.indiaSmallCapTotal,
      observedBoundary: boundary,
      // The bars every verdict is decided against, and the calibration that put
      // them there. Both on the record so a reader of companies.json alone can
      // reconstruct a verdict without re-deriving anything.
      sizeCutoffs,
      sizeBars: barsFrom(sizeCutoffs),
      /**
       * ⚠ OUR IMI CUTOFF SITS ABOVE MSCI'S OWN PUBLISHED MINIMUM-SIZE RANGE,
       * AND THAT IS A LIMITATION, NOT A CORROBORATION.
       *
       * MSCI publishes a Global Minimum Size Reference for EM IMI and a range
       * of 0.5x to 1.15x around it (pp. 24, 26). Ours is derived by ranking OUR
       * universe to the number of India names the FUNDS hold — and iShares'
       * funds sample rather than replicate, so that count under-states MSCI's
       * real India IMI membership and biases the cutoff upward.
       *
       * The comparison is computed here rather than asserted in prose so it
       * cannot go stale, and it is stated wherever the cutoff is (CLAUDE.md
       * §2.5, §2.26). A cutoff 1.4x above MSCI's own reference range, presented
       * with MSCI page citations and no caveat, would be a tier-3 figure
       * wearing a tier-1 face.
       */
      sizeCutoffReference: (() => {
        const rate = benchmarks?.fx?.series?.length
          ? benchmarks.fx.series[benchmarks.fx.series.length - 1]
          : null;
        const ref = MSCI.GLOBAL_MIN_SIZE_REFERENCE;
        const usd = (inr) => (rate?.close > 0 && Number.isFinite(inr) ? inr / rate.close / 1e6 : null);
        const ourUsdM = usd(sizeCutoffs.imi.inr);
        const lowUsdM = ref.emerging.imi * ref.rangeLowMultiple;
        const highUsdM = ref.emerging.imi * ref.rangeHighMultiple;
        return {
          basis: "our IMI cutoff against MSCI's published EM IMI Global Minimum Size Range",
          fxRate: rate?.close ?? null,
          fxDate: rate?.date ?? null,
          ourCutoffUsdM: ourUsdM === null ? null : Number(ourUsdM.toFixed(0)),
          msciReferenceUsdM: ref.emerging.imi,
          msciRangeUsdM: { low: lowUsdM, high: highUsdM },
          msciPages: [ref.page, 24],
          asOf: ref.asOf,
          inside: ourUsdM === null ? null : ourUsdM >= lowUsdM && ourUsdM <= highUsdM,
          multipleOfRangeHigh: ourUsdM === null ? null : Number((ourUsdM / highUsdM).toFixed(2)),
          note:
            'MSCI applies a GLOBAL minimum across emerging markets; a large market sits above it, so '
            + 'being outside the range is not by itself an error. But our count of India constituents '
            + 'comes from three tracking funds that SAMPLE rather than replicate, which under-states '
            + "MSCI's real membership and pushes this cutoff up. Treat it as biased high.",
        };
      })(),
      calibration: AUGUST_2026_CALIBRATION,
      deskBandRole: DESK_BAND_ROLE,
      segmentFloatTotals: floatTotals,
      verdictCounts,
      quarantinedCount: quarantined.size,
      nextReview: (() => {
        const r = nextReview(reviewAnchor);
        if (!r) return null;
        // The data cutoffs MSCI actually uses, now that they are read from the
        // methodology rather than assumed. The PRICE window is the one that
        // matters: the market caps deciding a review are struck a month before
        // it, and MSCI does not disclose which day inside the window it used.
        return { ...r, cutoffs: reviewCutoffs(r.year, r.month) };
      })(),
      // MSCI's own published rules, cited to the page. Kept separate from the
      // desk's heuristics so nothing can present one as the other.
      msci: {
        source: MSCI.SOURCE,
        trackedIndexes: MSCI.TRACKED_INDEXES,
        coverageTargets: MSCI.COVERAGE_TARGETS,
        cutoffBasis: MSCI.CUTOFF_BASIS,
        buffers: MSCI.BUFFERS,
        minFreeFloatMcap: MSCI.MIN_FREE_FLOAT_MCAP,
        minFif: MSCI.MIN_FIF,
        emLiquidity: MSCI.EM_LIQUIDITY,
        globalMinSizeReference: MSCI.GLOBAL_MIN_SIZE_REFERENCE,
        reviewTimetable: MSCI.REVIEW_TIMETABLE,
      },
      thresholdSources: {
        desk: "the desk's own band — MSCI does not publish its size cut-offs in advance",
        observed: 'measured from where MSCI has actually placed companies today',
        msci: "MSCI's published methodology, cited to a page in the August 2026 book",
      },
    },
    resolutionMethodCounts: methodCounts,
    floatFactorDisagreement: {
      comparedCompanies: disagreements.length,
      medianAbsGapPct: median === null ? null : round(median, 3),
      worstAbsGapPct: sorted.length ? round(Math.abs(sorted[0].gapPct), 3) : null,
      overReviewThreshold: overThreshold,
      largest: sorted.slice(0, 10),
    },
    handCheckedMappings: CONFIRMED,
    knownNotListed: NOT_LISTED,
    companies: out,
    unresolved: unresolvedOut,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  // ---- the alternate rebalance baselines, in their own file --------------
  if (rebaseContext) {
    const readings = {};
    for (const baseline of rebaseContext.baselines) {
      if (baseline.review === rebaseContext.defaultReview) continue;   // already inline
      const byKey = rebaseByReview.get(baseline.review);
      const forReview = {};
      for (const company of out) {
        const key = keyOfCompany(company);
        const reading = byKey.get(key) ?? null;
        if (!reading) { forReview[key] = null; continue; }
        // `reason`, `label` and `benchmarkName` are the SAME prose on every row
        // — 1,265 copies each, per baseline. They are dropped here and looked up
        // from `stateMeanings` and `benchmarkForSegment` in this file's own
        // header, which is where they already live. Nothing is lost: `state` is
        // the key into them, and it stays. (Measured: 1.97 MB -> 1.15 MB.)
        const { reason, label, benchmarkName, ...lean } = reading;
        forReview[key] = lean;
      }
      readings[baseline.review] = forReview;
    }
    writeFileSync(BASELINES_PATH, `${JSON.stringify({
      source: 'derived — public/data/price-history.json against public/data/fund-benchmarks.json',
      note: 'Relative performance since each PAST rebalance date, for every baseline except the '
        + "default one. The default rides on each company's record in companies.json; these are "
        + 'fetched only when a reader re-bases the screen. Keyed by the same company key '
        + 'companies.json uses (ISIN, or bse:<code> where there is none).',
      builtAt: new Date().toISOString(),
      defaultReview: rebaseContext.defaultReview,
      defaultReviewNote: 'not in this file — it is inline on every company in companies.json',
      baselines: rebaseContext.baselines,
      bandPct: REBALANCE_BASELINE.bandPct,
      benchmarkForSegment: REBALANCE_BASELINE.benchmarkForSegment,
      attribution: REBALANCE_BASELINE.attribution,
      doesNotMoveVerdict: rebaseContext.doesNotMoveVerdict,
      stateMeanings: REBASE_STATES,
      companyCount: out.length,
      readings,
    })}\n`, 'utf8');
  }
  process.stdout.write(
    `\nAll checks passed. Wrote ${rel(OUT_PATH)} — ${num(out.length)} companies, ` +
      `${num(coverage.withFloat)} with a free-float reading, ${num(unresolvedOut.length)} unresolved rows.\n\n`,
  );
}

main();
