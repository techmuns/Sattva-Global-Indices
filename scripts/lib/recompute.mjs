/**
 * recompute.mjs — free-float recompute, passive drift, flow primitives. Pure.
 *
 * ---------------------------------------------------------------------------
 * THE RECOMPUTE
 * ---------------------------------------------------------------------------
 *     freeFloatMcapInr(now) = floatFactor × sharesOutstanding × price(now)
 *
 * This is why the float FACTOR and a SHARE COUNT are stored rather than a rupee
 * figure. The factor moves only when shareholding moves — the quarterly event
 * this product forecasts — so a price arriving today re-values free float
 * without touching, or restamping, the monthly float file.
 *
 * NOTHING HERE RECOVERS A FACTOR FROM A PRICE. If you find yourself dividing a
 * rupee figure by a price to get back a factor you already hold, you have added
 * a rounding path for nothing.
 *
 * ---------------------------------------------------------------------------
 * PASSIVE DRIFT — READ THIS BEFORE CHANGING ANYTHING BELOW
 * ---------------------------------------------------------------------------
 * An index weight is `freeFloatMcap_i / Σ freeFloatMcap` across members, and an
 * index fund holds each member in proportion to that weight. When a stock's
 * price rises, the value of the fund's holding rises by EXACTLY the proportion
 * its weight does. The weight drifts upward and THE FUND TRADES NOTHING.
 *
 * So `requiresTrade` is hard-coded `false` on every drift record. That is not a
 * placeholder: no input to a passive-drift calculation could make it true.
 * Forced trading comes from the index's own inputs changing at a review —
 * segment migration, entry, exit, a float-factor revision, a share-count
 * revision — and those are a different record shape entirely.
 *
 * Drift is worth showing because it is how you spot a stock closing on a size
 * cut-off. It must never be multiplied by AUM and printed in rupees.
 */

/** ₹1 crore in rupees. */
const RUPEES_PER_CRORE = 1e7;

/**
 * Recompute free-float market cap at a given price.
 *
 * @returns {{value: number|null, basis: string|null}}
 */
export function recomputeFreeFloat(floatFactor, sharesOutstanding, price) {
  if (floatFactor === null || floatFactor === undefined) return { value: null, basis: null };
  if (sharesOutstanding === null || sharesOutstanding === undefined) return { value: null, basis: null };
  if (price === null || price === undefined || !(price > 0)) return { value: null, basis: null };
  return {
    value: Math.round(floatFactor * sharesOutstanding * price),
    basis: 'floatFactor × sharesOutstanding × price',
  };
}

/**
 * Choose the price in force for a company, and say which tier it is on.
 *
 * Tiers, and a row always knows which it is on:
 *   `live`  — this session's NSE quote (Munshot). Different exchange from the
 *             baseline, so the source travels with the number.
 *   `eod`   — the committed BSE bhavcopy close.
 *   `stale` — a close carried forward because the stock did not trade, with a
 *             day count. NOT zero, and NOT "unchanged".
 *
 * @param {{eod: object|null, live: object|null}} inputs
 */
export function choosePrice({ eod, live }) {
  if (live && Number.isFinite(live.price) && live.price > 0) {
    return {
      price: live.price,
      prevClose: live.prevClose ?? eod?.prevClose ?? null,
      tier: 'live',
      source: live.source ?? 'munshot-nse',
      exchange: 'NSE',
      date: null,
      staleDays: 0,
    };
  }
  if (eod && Number.isFinite(eod.close) && eod.close > 0) {
    const staleDays = eod.staleDays ?? 0;
    return {
      price: eod.close,
      prevClose: eod.prevClose ?? null,
      tier: staleDays > 0 ? 'stale' : 'eod',
      source: eod.source ?? 'bhavcopy-bse',
      exchange: 'BSE',
      date: eod.tradeDate ?? null,
      staleDays,
    };
  }
  return { price: null, prevClose: null, tier: null, source: null, exchange: null, date: null, staleDays: null };
}

/** Day change in percent, or null. A stock that did not trade has no day change. */
export function dayChangePct(price, prevClose) {
  if (price === null || prevClose === null || !(prevClose > 0)) return null;
  return ((price - prevClose) / prevClose) * 100;
}

/**
 * Passive weight drift for one holding in one fund.
 *
 * The fund's other holdings have moved too, so a stock's weight only drifts
 * relative to the BASKET. Comparing a stock's price move against the
 * capitalisation-weighted move of the fund's whole India book is what isolates
 * the relative part; comparing against nothing at all would report the market's
 * move as every stock's drift.
 *
 * @param {number} weightAtCapturePct  the fund's published weight
 * @param {number} stockReturn         freeFloatNow / freeFloatAtCapture
 * @param {number} basketReturn        Σ freeFloatNow / Σ freeFloatAtCapture over the fund's holdings
 */
export function passiveDrift(weightAtCapturePct, stockReturn, basketReturn) {
  if (
    weightAtCapturePct === null || weightAtCapturePct === undefined
    || !Number.isFinite(stockReturn) || !Number.isFinite(basketReturn) || !(basketReturn > 0)
  ) {
    return null;
  }
  const impliedWeightNowPct = weightAtCapturePct * (stockReturn / basketReturn);
  return {
    weightAtCapturePct,
    impliedWeightNowPct,
    driftPp: impliedWeightNowPct - weightAtCapturePct,
    // Hard-coded. Price movement never forces an index fund to trade — see the
    // header. Nothing computed here could make this true.
    requiresTrade: false,
  };
}

/**
 * Flow primitives — the INPUTS a later prompt will use to price a real index
 * event. None of them is a flow; no rupee flow figure is produced here, because
 * no flow event has been identified yet.
 *
 * @param {{totalMarketValueUsd: number, asOf: string}} fund
 * @param {number} fxRate  the WORKBOOK's rate, as of the holdings date
 */
export function flowPrimitives(fund, fxRate) {
  const aumUsd = fund?.totalMarketValueUsd ?? null;
  if (aumUsd === null || fxRate === null || fxRate === undefined) return null;

  // One percentage point of index weight, in rupees.
  const inrPerWeightPoint = (aumUsd * fxRate) / 100;

  return {
    fundAumUsd: aumUsd,
    // Both halves are as of the HOLDINGS date. Pairing a live FX rate with a
    // month-old AUM would be precision on one input pretending to be precision
    // on the answer.
    aumAsOf: fund.asOf ?? null,
    fxRate,
    fxRateAsOf: fund.asOf ?? null,
    fxRateNote: "the holdings workbook's own rate, not a live quote",
    inrPerWeightPoint,
    inrPerBasisPointOfWeight: inrPerWeightPoint / 100,
    inrPerWeightPointCrore: inrPerWeightPoint / RUPEES_PER_CRORE,
  };
}

/**
 * Days of average daily volume a share flow represents.
 *
 * The number a trader actually acts on: ₹400 Cr is nothing in Reliance and a
 * fortnight of volume in a small cap.
 */
export function daysOfAdv(flowShares, advQty) {
  if (flowShares === null || advQty === null || !(advQty > 0)) return null;
  return Math.abs(flowShares) / advQty;
}
