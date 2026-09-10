/**
 * ftse-book.js — Vanguard's workbook, read once, by two callers.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The FTSE book is published quarterly and arrives as a file somebody
 * downloads. Until now the only way in was `node scripts/import-ftse.mjs`
 * against a fixture committed to the repo — fine for the person holding the
 * repo, useless for the desk, who asked to be able to drop the workbook onto
 * the dashboard themselves.
 *
 * So there are two callers now: the importer that writes the committed artefact,
 * and the upload panel in the page. This module is everything they must agree
 * about — the parse, the payload shape, the structural checks, and the join onto
 * the companies already on the record.
 *
 * ⚠ A SECOND IMPLEMENTATION WOULD NOT LOOK BROKEN. It would produce rows. The
 * rows would resolve, the weights would render, and a book uploaded through the
 * page would quietly differ from the same book imported through the script — on
 * the currency, on which company a house ticker resolves to, on which of the 13
 * unresolvable rows kept their reason. That is the failure this module prevents,
 * and it is why the importer was rewritten around it rather than the browser
 * being given its own reader.
 *
 * ---------------------------------------------------------------------------
 * ⚠ THE STRUCTURAL CHECKS ARE NOT THE IMPORTER'S `EXPECTED` TABLE
 * ---------------------------------------------------------------------------
 * `import-ftse.mjs` refuses to write when the workbook drifts from a table of
 * measured figures describing THE COMMITTED FIXTURE (§5). That check cannot
 * travel here: an upload is by definition a different workbook, and every figure
 * in that table will legitimately have moved. Applying it to an upload would
 * reject every real quarterly book.
 *
 * What travels instead is what must hold for ANY Vanguard book — the header row
 * is findable, the columns are present, the weights land in a plausible band,
 * India is in it, the dates parse — plus the shrink guard every writer in this
 * repo already follows: a new book may not silently replace a good one with a
 * much smaller one.
 */

import { readXlsx, tableFrom, rowReader } from '../core/xlsx.js';
import { parseGroupedNumber } from '../core/grouped-number.js';
import { buildFtseIndex, resolveFtseHoldings, assertCurrency } from './ftse-resolve.js';

/** "$1,234.56" -> 1234.56. Strips exactly one leading $, then validates. */
export function parseMoney(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return parseGroupedNumber(text.startsWith('$') ? text.slice(1) : text);
}

/** "0.7647%" -> 0.7647. Strips exactly one trailing %, then validates. */
export function parsePercent(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return parseGroupedNumber(text.endsWith('%') ? text.slice(0, -1) : text);
}

/** "As at Jul 31 2026" -> "2026-07-31". Returns null rather than guessing. */
const MONTHS = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};
export function parseStatedDate(text) {
  const m = /([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{4})/.exec(String(text ?? ''));
  if (!m || !MONTHS[m[1]]) return null;
  return `${m[3]}-${MONTHS[m[1]]}-${String(m[2]).padStart(2, '0')}`;
}

/**
 * Vanguard writes a Bloomberg stub instead of a name for a recently added
 * security: "New Issuer: BB Company ID:183206". That is not a company name and
 * must never be matched on as one.
 */
const PLACEHOLDER_NAME = /^New Issuer:\s*BB Company ID:/i;

/** The columns the reader addresses by name. Absent one, nothing is guessed. */
export const REQUIRED_COLUMNS = ['Ticker', 'Holding name', 'Sector', 'Region', 'Market value', 'Shares', '% of market value'];

/**
 * Read one Vanguard workbook into the exact shape `ftse-funds.json` carries.
 *
 * @param {Uint8Array} bytes
 * @param {(body: Uint8Array) => Uint8Array | Promise<Uint8Array>} inflateRaw
 * @param {{ importedAt?: string, fixtures?: string[], receivedAs?: string }} provenance
 * @returns {Promise<{payload: object, measured: object}>}
 */
export async function readFtseBook(bytes, inflateRaw, provenance = {}) {
  const { rows } = await readXlsx(bytes, inflateRaw);

  // The preamble carries the download stamp, the fund name and the as-at date,
  // above a header row whose height is not a guaranteed constant (§3.2).
  const preamble = rows.filter((r) => r.cells[0]).map((r) => String(r.cells[0]).trim());
  const downloadedOn = parseStatedDate(preamble.find((t) => /^This file was downloaded on/i.test(t)));
  const holdingsAsOf = parseStatedDate(preamble.find((t) => /^As at /i.test(t)));
  const fundName = preamble.find((t) => /^Vanguard /i.test(t)) ?? null;

  const { header, headerRowNumber, dataRows } = tableFrom(rows, 'Ticker');
  const missingColumns = REQUIRED_COLUMNS.filter((name) => !header.includes(name));
  if (missingColumns.length) {
    throw new Error(
      `the workbook is missing ${missingColumns.length} column(s) this reader addresses by name: `
      + `${missingColumns.join(', ')}. Columns are never read by index (§3.2), so a renamed or `
      + 'reordered export must be looked at rather than guessed at.',
    );
  }
  const get = rowReader(header);

  // A data row is one that carries a weight and a region. Everything else in the
  // sheet is chrome — the footnote about rounding lives below the table.
  const data = dataRows.filter((r) => get(r, '% of market value') != null && get(r, 'Region') != null);
  const india = data.filter((r) => get(r, 'Region') === 'IN');

  const sum = (list, fn) => list.reduce((acc, r) => acc + (fn(r) ?? 0), 0);
  const totalWeightPct = sum(data, (r) => parsePercent(get(r, '% of market value')));
  const totalMarketValueCad = sum(data, (r) => parseMoney(get(r, 'Market value')));
  const indiaWeightPct = sum(india, (r) => parsePercent(get(r, '% of market value')));
  const indiaMarketValueCad = sum(india, (r) => parseMoney(get(r, 'Market value')));

  const holdings = india.map((r) => {
    const rawWeight = get(r, '% of market value');
    const weightPct = parsePercent(rawWeight);
    const name = get(r, 'Holding name');
    const isPlaceholder = PLACEHOLDER_NAME.test(name ?? '');
    const ticker = get(r, 'Ticker');
    return {
      // Stored verbatim. Vanguard's ticker is a HOUSE CODE, not an NSE symbol:
      // it writes HDFCB for HDFCBANK, INFO for INFY — and its SOTL is Sterlite
      // Technologies, while SOTL on NSE is a different listed company
      // altogether. Nothing may resolve on it without corroboration (§3.9).
      ticker: ticker || null,
      tickerKind: ticker ? 'vanguard-house-code' : 'none',
      name: isPlaceholder ? null : name,
      // The stub is kept so the row can say WHY it has no name (§2.3, §2.4).
      publishedName: name,
      nameKind: isPlaceholder ? 'placeholder' : 'published',
      sector: get(r, 'Sector') || null,
      weightPct,
      // Vanguard's own string, kept because the parsed number cannot show that
      // "0.00%" was already rounded to nothing before it reached us.
      weightPctPublished: rawWeight,
      weightRoundedToZero: weightPct === 0 && (parseMoney(get(r, 'Market value')) ?? 0) > 0,
      marketValueCad: parseMoney(get(r, 'Market value')),
      quantity: parseGroupedNumber(get(r, 'Shares')),
    };
  });

  const measured = {
    name: fundName,
    holdingsAsOf,
    downloadedOn,
    headerRowNumber,
    dataRows: data.length,
    indiaRows: india.length,
    indiaWeightPct3dp: indiaWeightPct.toFixed(3),
    totalWeightPct3dp: totalWeightPct.toFixed(3),
    placeholderNameRows: holdings.filter((h) => h.nameKind === 'placeholder').length,
    noTickerRows: holdings.filter((h) => !h.ticker).length,
    weightRoundsToZeroRows: holdings.filter((h) => h.weightRoundedToZero).length,
  };

  const payload = {
    source: "Vanguard — 'Holdings details' workbook export (.xlsx)",
    note:
      'FTSE Emerging Markets holdings, India slice. A SECOND OPINION alongside the MSCI funds: FTSE '
      + 'runs its own index with its own constituents, size rules and review calendar, so nothing here '
      + 'feeds the MSCI segment derivation, cutoffs, verdicts or flows.',
    importedAt: provenance.importedAt ?? new Date().toISOString(),
    fixtures: provenance.fixtures ?? [],
    // How the bytes reached us. A book uploaded through the dashboard and one
    // imported from a committed fixture are the same book read the same way, and
    // they are NOT the same provenance — a reader has to be able to tell which
    // one is on screen (§2.1).
    receivedAs: provenance.receivedAs ?? 'committed fixture',
    units: {
      weightPct: "Vanguard's published percent OF THE WHOLE FUND — not of its equity book, and not comparable across funds (§3.5)",
      marketValueCad: 'CANADIAN dollars, as reported by Vanguard. The workbook prints a bare "$" and never names the currency; see the header comment',
      quantity: 'shares, as reported by Vanguard',
    },
    currency: {
      code: 'CAD',
      establishedBy:
        'measured, not assumed: implied share price (market value / shares) converted at the holdings-date '
        + "rate and compared with this project's own close for the same company on the same day. As CAD the "
        + 'ratio is 1.0031 with 566 of 568 inside 1%; as USD it is a flat 1.4065 with none inside 1%.',
      reCheckedEveryBuild: 'assertCurrency() in public/js/model/ftse-resolve.js',
    },
    funds: [{
      id: 'ftse-em',
      name: fundName,
      shortName: 'FTSE EM',
      indexFamily: 'FTSE',
      currency: 'CAD',
      asOf: holdingsAsOf,
      downloadedOn,
      dataRows: data.length,
      // Every row in the book, so a weight is never divided by the India slice.
      totalMarketValueCad,
      totalWeightPct,
      weightsExcludeCashAndFutures: true,
      indiaRows: india.length,
      indiaMarketValueCad,
      indiaWeightPct,
      // Two different denominators, both stated (§2.5): India's share of the
      // whole fund by published weight, and its share of the equity book by
      // market value. They differ because the weights stop at 95.0153%.
      indiaShareOfMarketValuePct: (indiaMarketValueCad / totalMarketValueCad) * 100,
      holdings,
    }],
  };

  return { payload, measured };
}

/**
 * What must hold for ANY legitimate Vanguard book, whatever quarter it is from.
 *
 * ⚠ EVERY BOUND HERE IS DELIBERATELY LOOSE, and that is not laziness. A tight
 * bound fitted to the committed fixture is the `EXPECTED` table again, and it
 * would reject the next real book for having moved. These exist to catch a file
 * that is not this report at all — a different Vanguard product, a truncated
 * download, a sheet somebody edited — not to police a quarter's drift.
 *
 * ⚠ AND THE SHRINK GUARD READS THE BOOK IT IS REPLACING, not the one under
 * test. Every writer in this repo refuses to replace a good snapshot with a
 * smaller one (§5), and a guard that took its threshold from the incoming file
 * would be §3.8's guard-reads-its-own-threshold trap.
 *
 * @param {object} measured        from readFtseBook
 * @param {{ previous?: object|null, shrinkTolerancePct?: number }} options
 *        `previous` is the fund block of the book being replaced, or null.
 * @returns {{ok: boolean, checks: Array<{ok, label, detail}>}}
 */
export function assertBookShape(measured, { previous = null, shrinkTolerancePct = 20 } = {}) {
  const checks = [];
  const check = (ok, label, detail) => checks.push({ ok: Boolean(ok), label, detail });

  check(
    typeof measured.name === 'string' && /^Vanguard /i.test(measured.name),
    'the workbook names a Vanguard fund in its preamble',
    measured.name ?? 'no line beginning "Vanguard" above the table',
  );
  check(
    /^\d{4}-\d{2}-\d{2}$/.test(measured.holdingsAsOf ?? ''),
    'the holdings date parses from the "As at" line',
    measured.holdingsAsOf ?? 'no readable "As at <Mon> <D> <YYYY>" line — the date is never guessed',
  );
  check(
    /^\d{4}-\d{2}-\d{2}$/.test(measured.downloadedOn ?? ''),
    'the download date parses',
    measured.downloadedOn ?? 'no readable "This file was downloaded on …" line',
  );
  check(measured.dataRows > 0, 'the table has data rows', `${measured.dataRows} rows carrying a weight and a region`);
  check(
    measured.indiaRows > 0,
    'the book holds Indian companies',
    `${measured.indiaRows} of ${measured.dataRows} rows are Region = IN`,
  );
  // ⚠ THE WEIGHTS DO NOT SUM TO 100 AND MUST NOT BE MADE TO. Vanguard excludes
  // cash and futures from the weighted exposures and says so in its own
  // footnote; the committed book sums to 95.0153%. What would be wrong is a sum
  // near zero (nothing parsed) or above 100 (double-counted rows).
  const total = Number(measured.totalWeightPct3dp);
  check(
    Number.isFinite(total) && total > 50 && total <= 100,
    'the published weights sum to a plausible share of the fund',
    `${measured.totalWeightPct3dp}% — Vanguard excludes cash and futures, so this is below 100 by design`,
  );
  const indiaWeight = Number(measured.indiaWeightPct3dp);
  check(
    Number.isFinite(indiaWeight) && indiaWeight > 0 && indiaWeight < total,
    "India's weight is a real share of the whole fund",
    `${measured.indiaWeightPct3dp}% of the fund, against ${measured.totalWeightPct3dp}% for every row`,
  );

  if (previous) {
    const floor = previous.indiaRows * (1 - shrinkTolerancePct / 100);
    check(
      measured.indiaRows >= floor,
      'the new book is not materially smaller than the one it replaces',
      `${measured.indiaRows} India rows against ${previous.indiaRows} before `
      + `(a drop past ${shrinkTolerancePct}% is refused — pass an override and mean it)`,
    );
    check(
      measured.holdingsAsOf >= previous.asOf,
      'the new book is not older than the one it replaces',
      `as at ${measured.holdingsAsOf}, replacing ${previous.asOf}`,
    );
  } else {
    checks.push({
      ok: true,
      label: 'no book to compare against',
      detail: 'nothing is on the record yet, so the shrink and staleness guards have nothing to read',
    });
  }

  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * Choose the price basis the join is arbitrated against.
 *
 * ⚠ BOTH HALVES OF A CONVERTED FIGURE COME FROM ONE DATE (§3.8.2). The implied
 * price is CAD and our close is INR, so the rate must be the one that was in
 * force on the day the workbook was struck — not today's. Any walk-back is
 * recorded rather than absorbed.
 *
 * ⚠ AND AN INEXACT BASIS IS A WEAKER TEST THAT SAYS SO. A wrong company is out
 * by multiples; a few sessions of real price movement is out by percent. So a
 * basis struck away from the holdings date keeps working, at a wider tolerance,
 * and `exact: false` travels onto every row it judged.
 *
 * @param {{ asOf: string }} fund
 * @param {{ dates: string[], closeByIsinOn: (date: string) => Map<string, number>,
 *           cadSeries: Array<{date: string, close: number}>, config: object,
 *           fallback?: { date: string, closeByIsin: Map<string, number> } | null }} sources
 */
export function chooseFtseBasis(fund, sources) {
  const { dates = [], closeByIsinOn, cadSeries = [], config, fallback = null } = sources;

  const exactFx = cadSeries.find((p) => p.date === fund.asOf) ?? null;
  const walkedFx = exactFx ?? [...cadSeries].reverse().find((p) => p.date <= fund.asOf) ?? null;
  const cadInr = walkedFx?.close ?? null;

  let basisDate = dates.includes(fund.asOf) ? fund.asOf : null;
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
    if (gapSessions <= config.maxBasisGapSessions) basisDate = best.d;
  }

  let closeByIsin = basisDate ? closeByIsinOn(basisDate) : new Map();
  // ⚠ THE FALLBACK IS NAMED, NEVER SILENT. When no session close is within
  // reach — which is the ordinary case in a browser that has not downloaded the
  // price history — the latest committed close still discriminates a wrong
  // company by multiples, and the panel says which date it used and how far off
  // it is. Reporting no basis at all would turn "we checked with a weaker
  // instrument" into "we did not check" (§2.4).
  let fellBackToLatest = false;
  if ((!basisDate || closeByIsin.size === 0) && fallback) {
    basisDate = fallback.date;
    closeByIsin = fallback.closeByIsin;
    fellBackToLatest = true;
    const at = dates.indexOf(fallback.date);
    const from = dates.indexOf(fund.asOf);
    // ⚠ `null`, NOT 0, WHEN THE SESSIONS CANNOT BE COUNTED. This path is taken
    // precisely when the price history is absent, which is also the only thing
    // that could count the sessions between two dates. Leaving it at 0 makes the
    // panel read "0 session(s) from the workbook's date" beside `exact: false` —
    // a contradiction, and a fabricated zero of exactly §2.3's shape.
    gapSessions = at >= 0 && from >= 0 ? Math.abs(at - from) : null;
  }

  const exact = basisDate === fund.asOf;
  return {
    date: basisDate,
    exact,
    gapSessions,
    fellBackToLatest,
    closeByIsin,
    cadInr,
    fxDate: walkedFx?.date ?? null,
    fxWalkedBack: Boolean(walkedFx && !exactFx),
    tolerancePct: exact ? config.joinTolerancePct : config.approximateTolerancePct,
  };
}

/**
 * Join a book onto the companies on the record.
 *
 * The same function the build calls and the same one the upload panel calls, so
 * a book that reaches the screen through the page is joined by exactly the rules
 * that produced the committed one.
 *
 * @returns {{meta: object, byIsin: Map, currency: object, collisions: Array}}
 */
export function joinFtseBook(book, companies, basis, config) {
  const fund = book.funds[0];
  const { results, methods, collisions } = resolveFtseHoldings(fund.holdings, buildFtseIndex(companies), basis);
  const currency = assertCurrency(results, { tolerancePct: config.currencyTolerancePct });

  const byIsin = new Map();
  for (const r of results) {
    if (!r.isin || byIsin.has(r.isin)) continue;
    byIsin.set(r.isin, {
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
  const meta = {
    available: true,
    fundId: fund.id,
    fundName: fund.name,
    shortName: fund.shortName,
    indexFamily: fund.indexFamily,
    currency: fund.currency,
    asOf: fund.asOf,
    downloadedOn: fund.downloadedOn,
    note: book.note,
    receivedAs: book.receivedAs ?? 'committed fixture',
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
      tolerancePct: config.currencyTolerancePct,
      establishedBy: book.currency.establishedBy,
    },
    priceBasis: {
      date: basis.date,
      exact: basis.exact,
      gapSessions: basis.gapSessions,
      fellBackToLatest: Boolean(basis.fellBackToLatest),
      cadInr: basis.cadInr,
      fxDate: basis.fxDate,
      fxWalkedBack: basis.fxWalkedBack,
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

  return { meta, byIsin, currency, collisions };
}
