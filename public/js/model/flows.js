/**
 * flows.js — price a verdict that implies a trade. Nothing else.
 *
 *     flowInr    = targetWeightPp × inrPerWeightPoint(fund)
 *     flowShares = flowInr / priceInr
 *     daysOfAdv  = flowShares / advQty
 *
 * ---------------------------------------------------------------------------
 * WHAT NEVER GETS A RUPEE FIGURE
 * ---------------------------------------------------------------------------
 *  - `stable`. No rule fired; nothing implies a trade.
 *  - `passiveDrift`. A price move changes a fund's holding value and its index
 *    weight by the SAME proportion, so it forces no trade. `driftPp` is never a
 *    multiplication factor anywhere in this codebase, and the verification
 *    suite greps to keep it that way.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR SHAPES, AND HOW CERTAIN EACH IS
 * ---------------------------------------------------------------------------
 *  EXIT       the whole current position, which the holdings file states
 *             exactly. This is nearly a MEASUREMENT, not an estimate, and it is
 *             labelled so.
 *  ENTRY      an ESTIMATE. The target weight is the company's free float as a
 *             share of the segment's total free float — both numerator and
 *             denominator are shown, because that is the whole basis.
 *  MIGRATION  TWO flows, never one: a full sell from the small-cap funds and a
 *             new buy from EM. They are different funds trading in different
 *             directions, and netting them would imply a market-clearing that
 *             does not happen.
 *  NOT SAMPLED  EM Small-Cap samples the small-cap segment rather than
 *             replicating it. A company it does not currently hold has no basis
 *             for an EM SC entry estimate — the output is "not sampled", never
 *             zero.
 */

import {
  STANDARD_FUND, SMALLCAP_FUNDS, SMALLCAP_REPLICATING_FUND, SMALLCAP_SAMPLING_FUND,
  isSampledByEmSmallCap,
} from './segments.js';
import { TRADE_IMPLYING } from './assess.js';

const RUPEES_PER_CRORE = 1e7;

/** Days of average daily volume. Null — never zero — where ADV is unknown. */
export function daysOfAdv(flowShares, advQty) {
  if (flowShares === null || advQty === null || advQty === undefined || !(advQty > 0)) return null;
  return Math.abs(flowShares) / advQty;
}

function flowRecord({ fundId, direction, targetWeightPp, primitives, company, basis, certainty, note }) {
  if (!primitives || targetWeightPp === null || !Number.isFinite(targetWeightPp)) return null;

  const magnitudeInr = Math.abs(targetWeightPp) * primitives.inrPerWeightPoint;
  const signedInr = direction === 'sell' ? -magnitudeInr : magnitudeInr;
  const shares = company.priceInr && company.priceInr > 0 ? magnitudeInr / company.priceInr : null;

  return {
    fundId,
    fundShortName: primitives.shortName,
    direction,                       // 'buy' | 'sell'
    targetWeightPp: Number(targetWeightPp.toFixed(6)),
    flowInr: Math.round(signedInr),
    flowCrore: Number((signedInr / RUPEES_PER_CRORE).toFixed(2)),
    flowShares: shares === null ? null : Math.round(direction === 'sell' ? -shares : shares),
    daysOfAdv: shares === null ? null : round4(daysOfAdv(shares, company.advQty)),
    advQty: company.advQty ?? null,
    advSource: company.advSource ?? null,
    // Both halves are as of the HOLDINGS date, never a live rate.
    aumUsd: primitives.fundAumUsd,
    aumAsOf: primitives.aumAsOf,
    fxRate: primitives.fxRate,
    inrPerWeightPoint: primitives.inrPerWeightPoint,
    basis,
    certainty,                       // 'measured-position' | 'estimated'
    note: note ?? null,
  };
}

const round4 = (v) => (v === null || v === undefined ? null : Number(v.toFixed(4)));

/**
 * @param {object} company
 * @param {{verdict: string, segment: string}} assessment
 * @param {{flowPrimitives: object, segmentFloatTotals: object}} context
 * @returns {{flows: Array, notSampled: Array, shape: string|null}}
 */
export function estimateFlows(company, assessment, context) {
  const { flowPrimitives, segmentFloatTotals } = context;
  const { verdict, segment } = assessment;

  // ---- ASM: mark a forced flow as NOT MANDATED, never suppress it -----------
  // The desk's judgement (assessment.asm, from config/thresholds.mjs) is that a
  // passive fund is not obliged to rebalance a name under NSE surveillance on
  // schedule. The mechanical size stays — it is a real derived quantity — but
  // every flow is flagged `constrainedByAsm` and carries the timing caveat, and
  // the shape carries an `asmConstraint` summary. It NEVER changes the verdict or
  // the size; days-of-ADV is left as computed but named as understated.
  const finalize = (result) => {
    const asm = assessment.asm;
    if (!asm?.binding || !result.flows.length) return { ...result, asmConstraint: null };
    return {
      ...result,
      asmConstraint: {
        stage: asm.stage,
        survCode: asm.survCode,
        category: asm.category,
        severity: asm.severity,
        mandated: false,
        implication: asm.implication,
        timingNote: asm.timingNote,
        attribution: asm.attribution,
      },
      flows: result.flows.map((f) => (f
        ? { ...f, constrainedByAsm: true, asmStage: asm.survCode, timingNote: asm.timingNote }
        : f)),
    };
  };

  if (!TRADE_IMPLYING.has(verdict)) {
    return finalize({ flows: [], notSampled: [], shape: null });
  }

  const flows = [];
  const notSampled = [];

  /** An entry's target weight: this company's free float over the segment's. */
  const estimatedWeightPp = (targetSegment) => {
    const total = segmentFloatTotals.totals[targetSegment];
    if (!total || !company.freeFloatMcapInr) return null;
    return (company.freeFloatMcapInr / total) * 100;
  };
  const entryBasis = (targetSegment) => {
    const total = segmentFloatTotals.totals[targetSegment];
    return {
      formula: 'company free float ÷ segment total free float',
      numeratorInr: company.freeFloatMcapInr,
      denominatorInr: total ?? null,
      denominatorMembers: segmentFloatTotals.counts[targetSegment] ?? null,
      segment: targetSegment,
    };
  };

  // ---- EXIT: the whole current position, stated by the holdings file ------
  if (verdict === 'likely-exclusion' || verdict === 'exclusion-risk') {
    for (const fundId of [STANDARD_FUND, ...SMALLCAP_FUNDS]) {
      const holding = company.funds?.[fundId];
      if (!holding) continue;
      flows.push(flowRecord({
        fundId,
        direction: 'sell',
        targetWeightPp: holding.weightPct,
        primitives: flowPrimitives[fundId],
        company,
        basis: { formula: 'the fund\'s own published weight — the entire current position', weightPct: holding.weightPct },
        certainty: 'measured-position',
        note: 'The position size is read from the holdings file, not estimated. Only the fact of the exit is modelled.',
      }));
    }
    return finalize({ flows, notSampled, shape: 'exit' });
  }

  // ---- MIGRATION: two flows, opposite signs, never netted -----------------
  if (verdict === 'migration-up') {
    // Small-cap funds sell the whole position…
    for (const fundId of SMALLCAP_FUNDS) {
      const holding = company.funds?.[fundId];
      if (!holding) {
        if (fundId === SMALLCAP_SAMPLING_FUND) {
          notSampled.push({
            fundId,
            fundShortName: flowPrimitives[fundId]?.shortName ?? fundId,
            reason: 'EM Small-Cap samples the segment rather than replicating it and does not currently hold this company, so there is no position to sell.',
          });
        }
        continue;
      }
      flows.push(flowRecord({
        fundId,
        direction: 'sell',
        targetWeightPp: holding.weightPct,
        primitives: flowPrimitives[fundId],
        company,
        basis: { formula: 'the fund\'s own published weight — the entire current position', weightPct: holding.weightPct },
        certainty: 'measured-position',
      }));
    }
    // …and the Standard fund buys a new one.
    flows.push(flowRecord({
      fundId: STANDARD_FUND,
      direction: 'buy',
      targetWeightPp: estimatedWeightPp('standard'),
      primitives: flowPrimitives[STANDARD_FUND],
      company,
      basis: entryBasis('standard'),
      certainty: 'estimated',
      note: 'A new position. The target weight is estimated from free-float share of the segment.',
    }));
    return finalize({ flows: flows.filter(Boolean), notSampled, shape: 'migration' });
  }

  if (verdict === 'migration-down') {
    const holding = company.funds?.[STANDARD_FUND];
    if (holding) {
      flows.push(flowRecord({
        fundId: STANDARD_FUND,
        direction: 'sell',
        targetWeightPp: holding.weightPct,
        primitives: flowPrimitives[STANDARD_FUND],
        company,
        basis: { formula: 'the fund\'s own published weight — the entire current position', weightPct: holding.weightPct },
        certainty: 'measured-position',
      }));
    }
    // The replicating small-cap fund buys; the sampling one only might.
    flows.push(flowRecord({
      fundId: SMALLCAP_REPLICATING_FUND,
      direction: 'buy',
      targetWeightPp: estimatedWeightPp('smallcap'),
      primitives: flowPrimitives[SMALLCAP_REPLICATING_FUND],
      company,
      basis: entryBasis('smallcap'),
      certainty: 'estimated',
    }));
    notSampled.push({
      fundId: SMALLCAP_SAMPLING_FUND,
      fundShortName: flowPrimitives[SMALLCAP_SAMPLING_FUND]?.shortName ?? SMALLCAP_SAMPLING_FUND,
      reason: 'EM Small-Cap samples rather than replicates, so whether it would take this name is not derivable. Not an estimate of zero.',
    });
    return finalize({ flows: flows.filter(Boolean), notSampled, shape: 'migration' });
  }

  // ---- ENTRY: estimated, into the small-cap segment -----------------------
  if (verdict === 'likely-inclusion' || verdict === 'possible-inclusion') {
    flows.push(flowRecord({
      fundId: SMALLCAP_REPLICATING_FUND,
      direction: 'buy',
      targetWeightPp: estimatedWeightPp('smallcap'),
      primitives: flowPrimitives[SMALLCAP_REPLICATING_FUND],
      company,
      basis: entryBasis('smallcap'),
      certainty: 'estimated',
      note: 'The India Small-Cap ETF replicates the segment, so an entry draws a flow from it for certain.',
    }));
    if (isSampledByEmSmallCap(company)) {
      flows.push(flowRecord({
        fundId: SMALLCAP_SAMPLING_FUND,
        direction: 'buy',
        targetWeightPp: estimatedWeightPp('smallcap'),
        primitives: flowPrimitives[SMALLCAP_SAMPLING_FUND],
        company,
        basis: entryBasis('smallcap'),
        certainty: 'estimated',
      }));
    } else {
      notSampled.push({
        fundId: SMALLCAP_SAMPLING_FUND,
        fundShortName: flowPrimitives[SMALLCAP_SAMPLING_FUND]?.shortName ?? SMALLCAP_SAMPLING_FUND,
        reason: 'EM Small-Cap samples the segment rather than replicating it and does not currently hold this company, so whether it would buy is not derivable. Not zero.',
      });
    }
    return finalize({ flows: flows.filter(Boolean), notSampled, shape: 'entry' });
  }

  return finalize({ flows: [], notSampled: [], shape: null });
}

/** The largest single flow on a record, for sorting and for a summary. */
export function largestFlowCrore(flows) {
  if (!flows?.length) return null;
  return flows.reduce((max, f) => (Math.abs(f.flowCrore) > Math.abs(max) ? f.flowCrore : max), 0);
}
