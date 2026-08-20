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
import { observedBoundary, rankByFreeFloat } from '../public/js/model/thresholds.js';
import { segmentOf, assertDisjoint, segmentFloatTotals } from '../public/js/model/segments.js';
import { assess, verdictFromRules, VERDICTS, DISCLOSURE } from '../public/js/model/assess.js';
import { estimateFlows } from '../public/js/model/flows.js';
import { nextReview } from '../public/js/model/calendar.js';
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

  const checks = new CheckList('build');

  const nseFloatBySymbol = new Map(nseFreeFloat.companies.map((c) => [c.symbol, c]));
  const bseByCode = new Map(bseFreeFloat.scrips.map((s) => [s.scripCode, s]));
  const bseByIsin = new Map();
  for (const scrip of bseFreeFloat.scrips) {
    if (scrip.isin && !bseByIsin.has(scrip.isin)) bseByIsin.set(scrip.isin, scrip);
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
        sector: bse?.sector ?? null,
        sectorSource: bse?.sector ? 'bse' : null,
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
    // Measured on this export, the overwhelming majority of these are REITs and
    // InvITs: Embassy Office Parks, Mindspace, Nexus Select, Brookfield India,
    // IndiGrid, IRB InvIT, PowerGrid InvIT, Cube Highways, Knowledge Realty and
    // the rest. BSE's `segment=Equity` filter excludes them CORRECTLY — they are
    // a different instrument class, not a missing name — and NSE's free-float set
    // does not carry them either.
    const seedCode = row.bseScripCode;
    const noBseReason = seedCode
      ? `the seed list gives BSE code ${seedCode}, but that code is not in BSE's active `
        + 'EQUITY master. Almost always a REIT or an InvIT, which BSE files outside the '
        + 'equity segment; sometimes a suspended line. Not fetched, because a code the '
        + 'active master does not carry may belong to a delisted company.'
      : 'no BSE code in the seed list — an NSE-only listing.';
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
  const disjoint = assertDisjoint(out);
  checks.assert(
    disjoint.ok,
    'no company is held by the EM ETF and by a small-cap fund (the segments are disjoint)',
    disjoint.violations.slice(0, 5).map((v) => `${v.name}: ${v.funds.join('+')}`).join(' | '),
  );
  checks.assert(
    disjoint.emSmallCapIsSubset,
    'EM Small-Cap holds no India company that India Small-Cap lacks (it samples the segment)',
    disjoint.emSmallCapOnly.slice(0, 5).map((c) => c.name).join(' | '),
  );

  const keyOfCompany = (c) => c.isin ?? `bse:${c.bseScripCode}`;
  const boundary = observedBoundary(out, segmentOf);
  const ranks = rankByFreeFloat(out, keyOfCompany);
  const floatTotals = segmentFloatTotals(out);
  const quarantined = new Set(reconciliation?.quarantinedIsins ?? []);

  const assessContext = { boundary, ranks, quarantined, keyOf: keyOfCompany };
  const flowContext = { flowPrimitives: flowPrimitivesByFund, segmentFloatTotals: floatTotals };

  const verdictCounts = {};
  const replayFailures = [];
  for (const company of out) {
    const assessment = assess(company, assessContext);
    const replayed = verdictFromRules(assessment.rulesFired);
    if (replayed !== assessment.verdict) {
      replayFailures.push(`${company.name}: assess() said ${assessment.verdict}, replay said ${replayed}`);
    }

    const { flows, notSampled, shape } = estimateFlows(company, assessment, flowContext);

    company.segment = assessment.segment;
    company.assessment = {
      verdict: assessment.verdict,
      distancePct: assessment.distancePct,
      rulesFired: assessment.rulesFired,
      notes: assessment.notes,
      // Stated on the record, not only on the screen — this travels into the
      // export and into anything that reads the file directly.
      disclosure: DISCLOSURE,
      basis: 'end-of-day price; the interface re-assesses against a live price when one is in force',
    };
    company.flowEstimate = flows.length || notSampled.length
      ? { shape, flows, notSampled }
      : null;
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
    asOf: {
      isharesHoldings: funds.funds[0]?.asOf ?? null,
      nseSession: nseFreeFloat.sessionTimestamp,
      bseCapturedAt: bseFreeFloat.capturedAt,
      bhavcopyTradeDate: prices.tradeDate,
      quoteStatsCapturedAt: quoteStats?.capturedAt ?? null,
      bseScripMasterCapturedAt: master.capturedAt,
      nseUniverseCapturedAt: nseUniverse.capturedAt,
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
      segmentFloatTotals: floatTotals,
      verdictCounts,
      quarantinedCount: quarantined.size,
      nextReview: nextReview(reviewAnchor),
      thresholdSources: {
        desk: "the desk's own band — MSCI does not publish its size cut-offs in advance",
        observed: 'measured from where MSCI has actually placed companies today',
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
  process.stdout.write(
    `\nAll checks passed. Wrote ${rel(OUT_PATH)} — ${num(out.length)} companies, ` +
      `${num(coverage.withFloat)} with a free-float reading, ${num(unresolvedOut.length)} unresolved rows.\n\n`,
  );
}

main();
