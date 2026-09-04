/**
 * Resolve Vanguard's FTSE holdings to the companies this project already knows,
 * and prove the join with a price the workbook never claims.
 *
 * ⚠ VANGUARD PUBLISHES NO ISIN, WHICH IS THE ONLY KEY THIS PROJECT TRUSTS (§3.9).
 *
 * The workbook offers a house ticker and a name, and both lie in their own way:
 *
 *   - the ticker is Vanguard's own code, not an NSE symbol. It writes HDFCB for
 *     HDFCBANK, INFO for INFY, MM for M&M. Worse, its codes COLLIDE with real
 *     listings owned by other companies: Vanguard's `SOTL` is Sterlite
 *     Technologies, while `SOTL` on NSE is Savita Oil Technologies — a different
 *     company, comfortably resolvable, and wrong.
 *   - the name is usually right but sometimes absent, replaced by a Bloomberg
 *     stub ("New Issuer: BB Company ID:183206"), and sometimes truncated
 *     ("Shaily Engineering Plastics Lt").
 *
 * A matcher built on either alone ships wrong rows, which §3.9 says is exactly
 * how a coverage table gets prettier and a portfolio manager gets a false
 * number. So NOTHING HERE RESOLVES ON A PROPOSAL ALONE.
 *
 * ⚠ THE PRICE IS THE ARBITER, AND IT IS INDEPENDENT OF EVERYTHING IT JUDGES.
 *
 * Vanguard gives a market value and a share count. Their quotient is an implied
 * share price in CAD, which the workbook never states and cannot fake. Converted
 * at the holdings-date rate it must equal the close THIS project already holds
 * for that company on that day — a number from a different source (BSE), fetched
 * by a different script, for a date fixed by the workbook rather than by us.
 *
 * Measured on the committed file: 566 of 568 name matches land inside 1%,
 * median ratio 1.0031. The Sterlite/Savita collision resolves 1.0047 against
 * 0.9299 — the gate picks the right company on the evidence rather than on a
 * rule about which field to prefer. So:
 *
 *   - a NAME match may stand when no price is available (a name is
 *     unique-or-nothing and much the stronger proposal),
 *   - a SYMBOL match MAY NOT. Symbols collide; without a passing price check a
 *     symbol-only proposal is refused,
 *   - where name and symbol disagree, whichever passes the gate wins; if both
 *     pass or neither does, the row is UNRESOLVED and says why.
 *
 * Nothing is ever guessed, and an unresolved row keeps its weight and states its
 * reason rather than being dropped (§2.3, §3.9).
 */

/**
 * Spelling equivalences — NOT a fuzzy matcher.
 *
 * Each rule below turns two spellings of the SAME string into one string. None
 * of them makes two different companies collide, which is the property that
 * separates this from the prefix matcher §3.9 forbids (the one that pairs
 * "EMBASSY" with Embassy Developments). The match remains exact and
 * unique-or-nothing after normalising.
 *
 *   /new, /India   Vanguard's venue suffix ("Tata Motors Ltd /new")
 *   &  ->  AND     the gap §3.9 already recorded in the MSCI normaliser
 *   CORP           Vanguard abbreviates what the exchange spells out
 *   INTL
 */
export function normaliseFtseName(value) {
  return String(value ?? '')
    .toUpperCase()
    .split('/')[0]
    .replace(/&/g, ' AND ')
    .replace(/\bCORP\b/g, 'CORPORATION')
    .replace(/\bINTL\b/g, 'INTERNATIONAL')
    .replace(/\b(LIMITED|LTD|THE|COMPANY|CO|AND)\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, '');
}

const AMBIGUOUS = Symbol('ambiguous');

/** Unique-or-nothing indices over the companies already on the record. */
export function buildFtseIndex(companies) {
  const byName = new Map();
  const bySymbol = new Map();
  for (const company of companies) {
    const nameKey = normaliseFtseName(company.name);
    if (nameKey) byName.set(nameKey, byName.has(nameKey) ? AMBIGUOUS : company);
    const symbolKey = (company.nseSymbol ?? '').toUpperCase();
    if (symbolKey) bySymbol.set(symbolKey, bySymbol.has(symbolKey) ? AMBIGUOUS : company);
  }
  return { byName, bySymbol };
}

const pick = (map, key) => {
  const hit = key ? map.get(key) : undefined;
  return hit && hit !== AMBIGUOUS ? hit : null;
};
const isAmbiguous = (map, key) => (key ? map.get(key) === AMBIGUOUS : false);

/**
 * The implied INR price of one holding: (market value / shares) x INR-per-CAD.
 * Both halves of the quotient come from the same Vanguard row, so no foreign
 * price sneaks into it (§2.9's same-source rule).
 */
export function impliedPriceInr(holding, cadInr) {
  const { marketValueCad, quantity } = holding;
  if (!Number.isFinite(marketValueCad) || !Number.isFinite(quantity) || quantity <= 0) return null;
  if (!Number.isFinite(cadInr) || cadInr <= 0) return null;
  return (marketValueCad / quantity) * cadInr;
}

/** Compare a proposal against the close we already hold for that company. */
function priceCheck(holding, company, basis) {
  const implied = impliedPriceInr(holding, basis.cadInr);
  const close = company ? basis.closeByIsin.get(company.isin) : null;
  if (implied == null || close == null || !(close > 0)) {
    return { status: 'unavailable', ratio: null, date: basis.date, tolerancePct: basis.tolerancePct };
  }
  const ratio = implied / close;
  return {
    status: Math.abs(ratio - 1) * 100 <= basis.tolerancePct ? 'passed' : 'failed',
    ratio,
    date: basis.date,
    tolerancePct: basis.tolerancePct,
    exactDate: basis.exact,
  };
}

const unresolved = (reason, extra = {}) => ({
  isin: null, company: null, method: 'none', priceCheck: null, reason, ...extra,
});

/**
 * Resolve one holding.
 * @param {object} holding                 a row from ftse-funds.json
 * @param {{byName:Map,bySymbol:Map}} index
 * @param {{date:string,exact:boolean,closeByIsin:Map,cadInr:number,tolerancePct:number}} basis
 */
export function resolveFtseHolding(holding, index, basis) {
  const nameKey = holding.name ? normaliseFtseName(holding.name) : '';
  const symbolKey = (holding.ticker ?? '').toUpperCase();
  const byName = pick(index.byName, nameKey);
  const bySymbol = pick(index.bySymbol, symbolKey);

  if (!byName && !bySymbol) {
    if (holding.nameKind === 'placeholder') {
      return unresolved(
        "Vanguard published a Bloomberg placeholder instead of a company name, and its house ticker "
        + 'matches no NSE symbol on the record. Resolving it would be a guess.',
      );
    }
    if (isAmbiguous(index.byName, nameKey)) {
      return unresolved('two companies on the record normalise to this same name — a coin flip, so neither is chosen (§3.9)');
    }
    return unresolved('no company on the record matches this name, and the house ticker matches no NSE symbol');
  }

  const nameCheck = byName ? priceCheck(holding, byName, basis) : null;
  const symbolCheck = bySymbol ? priceCheck(holding, bySymbol, basis) : null;

  // Both routes agree on a company — the ordinary case.
  if (byName && bySymbol && byName.isin === bySymbol.isin) {
    if (nameCheck.status === 'failed') {
      return unresolved(
        `name and ticker agree on ${byName.name}, but its implied price is ${(nameCheck.ratio * 100).toFixed(1)}% `
        + `of our ${basis.date} close — too far apart to believe the join`,
        { priceCheck: nameCheck },
      );
    }
    return { isin: byName.isin, company: byName, method: 'name+symbol', priceCheck: nameCheck, reason: null };
  }

  // They point at different companies. The price decides — this is the
  // Sterlite/Savita case, and the reason the gate exists.
  if (byName && bySymbol) {
    const namePassed = nameCheck.status === 'passed';
    const symbolPassed = symbolCheck.status === 'passed';
    if (namePassed && !symbolPassed) {
      return { isin: byName.isin, company: byName, method: 'name-over-colliding-symbol', priceCheck: nameCheck, reason: null };
    }
    if (symbolPassed && !namePassed) {
      return { isin: bySymbol.isin, company: bySymbol, method: 'symbol-over-name', priceCheck: symbolCheck, reason: null };
    }
    return unresolved(
      `the name says ${byName.name} and the ticker says ${bySymbol.name}; the price check `
      + `${namePassed ? 'clears both' : 'settles neither'}, so nothing is asserted`,
      { priceCheck: nameCheck },
    );
  }

  // Name only. A name is unique-or-nothing, so it may stand unchecked.
  if (byName) {
    if (nameCheck.status === 'failed') {
      return unresolved(
        `the only name match is ${byName.name}, whose implied price is `
        + `${(nameCheck.ratio * 100).toFixed(1)}% of our ${basis.date} close — rejected rather than believed`,
        { priceCheck: nameCheck },
      );
    }
    return { isin: byName.isin, company: byName, method: 'name', priceCheck: nameCheck, reason: null };
  }

  // Symbol only. Refused without corroboration: Vanguard's codes collide.
  if (symbolCheck.status !== 'passed') {
    return unresolved(
      `the only proposal is Vanguard's house ticker ${symbolKey}, which is not an NSE symbol and is `
      + `known to collide with other listings; the price ${symbolCheck.status === 'failed' ? 'contradicts it' : 'could not be checked'}`,
      { priceCheck: symbolCheck },
    );
  }
  return { isin: bySymbol.isin, company: bySymbol, method: 'symbol-confirmed-by-price', priceCheck: symbolCheck, reason: null };
}

/** Resolve every holding and report how, with counts rather than a bare total. */
export function resolveFtseHoldings(holdings, index, basis) {
  const results = holdings.map((holding) => ({ holding, ...resolveFtseHolding(holding, index, basis) }));
  const methods = {};
  for (const r of results) methods[r.method] = (methods[r.method] ?? 0) + 1;

  const seen = new Map();
  const collisions = [];
  for (const r of results) {
    if (!r.isin) continue;
    if (seen.has(r.isin)) collisions.push({ isin: r.isin, names: [seen.get(r.isin), r.holding.publishedName] });
    else seen.set(r.isin, r.holding.publishedName);
  }
  return { results, methods, collisions };
}

/**
 * Prove the money column is CAD, every build.
 *
 * Reads the median implied/actual price ratio across resolved rows. In CAD it is
 * ~1.003; read as USD the same rows land at ~1.407, because USD/CAD is ~1.4.
 * The threshold is arithmetic identity (a correct conversion gives 1), not a
 * number taken from the data under test — so unlike a guard that reads its own
 * input, this one can actually fail (§3.8).
 */
export function assertCurrency(results, { tolerancePct }) {
  const ratios = results
    .filter((r) => r.priceCheck?.status === 'passed' || r.priceCheck?.status === 'failed')
    .map((r) => r.priceCheck.ratio)
    .sort((a, b) => a - b);
  if (ratios.length < 50) {
    return { ok: false, median: null, compared: ratios.length,
      reason: `only ${ratios.length} rows could be priced — too few to establish the currency, so it is not asserted` };
  }
  const median = ratios[Math.floor(ratios.length / 2)];
  const offBy = Math.abs(median - 1) * 100;
  return {
    ok: offBy <= tolerancePct,
    median,
    compared: ratios.length,
    offByPct: offBy,
    reason: offBy <= tolerancePct
      ? null
      : `the median implied/actual price ratio is ${median.toFixed(4)}, ${offBy.toFixed(1)}% from 1. `
        + `A ratio near 1.40 means the workbook is struck in USD, not CAD, and every rupee figure would be `
        + `40% too large. Nothing is written.`,
  };
}
