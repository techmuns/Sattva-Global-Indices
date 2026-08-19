/**
 * assess.js — the rules engine. A verdict is a LABEL ON A RULE, not an opinion.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO PERCENTAGE HERE
 * ---------------------------------------------------------------------------
 * The requirement asks for "probability of inclusion, exclusion, or weight
 * adjustments". We cannot honestly print one.
 *
 * A probability needs a base rate, and a base rate needs history: past reviews,
 * what MSCI's actual cut-off was each time, and which companies at which
 * distances were added or dropped. This project holds ONE holdings file per
 * fund, dated 17 Aug 2026. "68% likely" would be invented precision, and it
 * would be the one number on this dashboard a reader could not check — exactly
 * the failure everything else here is built to avoid.
 *
 * So: a banded, rule-derived assessment with the working shown. Every verdict
 * carries `rulesFired`, and every rule records its input, its threshold, and
 * where that threshold came from. The verdict is REPRODUCIBLE FROM THAT RECORD
 * ALONE — `verdictFromRules` replays it, and the build asserts the replay
 * matches for every company.
 *
 * The upgrade path to a genuine probability is in docs/DATA-CONTRACTS.md.
 *
 * ---------------------------------------------------------------------------
 * A SUSPECT INPUT PRODUCES `unknown`, NOT A CONFIDENT ANSWER
 * ---------------------------------------------------------------------------
 * Free-float market cap decides every verdict below, and it is
 * `floatFactor × sharesOutstanding × price`. Where the share count could not be
 * corroborated (see scripts/reconcile-shares.mjs), the verdict is `unknown`
 * with the reason attached. A verdict computed from a share count we do not
 * trust is worse than no verdict.
 */

import { REVIEW_THRESHOLDS, THRESHOLD_SOURCE, toCrore } from './thresholds.js';
import { segmentOf, isSampledByEmSmallCap } from './segments.js';

/** The verdicts, in the order a summary should read them. */
export const VERDICTS = {
  'likely-inclusion': {
    key: 'likely-inclusion',
    label: 'Likely inclusion',
    tone: 'positive',
    implication: 'entry',
    detail: 'Outside the index and above the desk\'s upper inclusion band.',
  },
  'possible-inclusion': {
    key: 'possible-inclusion',
    label: 'Possible inclusion',
    tone: 'caution',
    implication: 'entry',
    detail: 'Outside the index and inside the desk\'s inclusion band.',
  },
  'migration-up': {
    key: 'migration-up',
    label: 'Migration up',
    tone: 'positive',
    implication: 'migration-up',
    detail: 'A Small Cap constituent now large enough to rank inside the Standard segment.',
  },
  'migration-down': {
    key: 'migration-down',
    label: 'Migration down',
    tone: 'caution',
    implication: 'migration-down',
    detail: 'A Standard constituent overtaken by enough companies to fall outside the segment.',
  },
  'exclusion-risk': {
    key: 'exclusion-risk',
    label: 'Exclusion risk',
    tone: 'caution',
    implication: 'exit',
    detail: 'A constituent inside the desk\'s exclusion band.',
  },
  'likely-exclusion': {
    key: 'likely-exclusion',
    label: 'Likely exclusion',
    tone: 'negative',
    implication: 'exit',
    detail: 'A constituent below the desk\'s lower exclusion band.',
  },
  stable: {
    key: 'stable',
    label: 'Stable',
    tone: 'neutral',
    implication: 'none',
    detail: 'No rule fired. Nothing here implies a trade.',
  },
  unknown: {
    key: 'unknown',
    label: 'Unknown',
    tone: 'neutral',
    implication: 'none',
    detail: 'An input this verdict depends on could not be trusted or was missing.',
  },
};

/** Verdicts that imply a fund must trade. Only these get a rupee figure. */
export const TRADE_IMPLYING = new Set(['likely-inclusion', 'possible-inclusion', 'migration-up', 'migration-down', 'exclusion-risk', 'likely-exclusion']);

const rule = (key, label, input, threshold, thresholdSource, result, note) => ({
  key, label, input, threshold, thresholdSource, result, note: note ?? null,
});

/**
 * Assess one company.
 *
 * @param {object} company
 * @param {{boundary: object, ranks: Map, quarantined: Set, keyOf: Function}} context
 * @returns {{verdict, rulesFired, distance, distanceLabel, segment, notes}}
 */
export function assess(company, context) {
  const { boundary, ranks, quarantined, keyOf } = context;
  const segment = segmentOf(company);
  const rulesFired = [];
  const key = keyOf(company);

  // ---- gates, in priority order. Each short-circuits. -------------------
  if (quarantined?.has(key)) {
    rulesFired.push(rule(
      'share-count-quarantined', 'Share count could not be corroborated',
      'sharesOutstanding', null, 'reconciliation', 'unknown',
      'Free-float market cap is floatFactor x sharesOutstanding x price, so a suspect share count '
      + 'makes every threshold comparison below it meaningless.',
    ));
    return finish('unknown', rulesFired, null, segment, company);
  }

  const freeFloat = company.freeFloatMcapInr;
  if (freeFloat === null || freeFloat === undefined) {
    rulesFired.push(rule(
      'no-free-float', 'No free-float reading', 'freeFloatMcapInr', null, 'measurement', 'unknown',
      'Neither exchange publishes a free float for this company, so it cannot be placed against any threshold.',
    ));
    return finish('unknown', rulesFired, null, segment, company);
  }

  const inclusion = REVIEW_THRESHOLDS.inclusion;
  const exclusion = REVIEW_THRESHOLDS.exclusion;
  const rank = ranks.get(key) ?? null;
  const standardCount = boundary.standardCount;

  // ---- segment-specific rules -------------------------------------------
  if (segment === 'outside') {
    // The index-ENTRY question. The desk's band is the right threshold here:
    // measured on the committed data it sits exactly at the boundary between
    // unheld companies and Small Cap constituents.
    rulesFired.push(rule(
      'entry-upper-band', 'Free float vs the desk\'s upper inclusion band',
      freeFloat, inclusion.highInr, 'desk',
      freeFloat >= inclusion.highInr ? 'above' : 'below',
    ));
    if (freeFloat >= inclusion.highInr) {
      return finish('likely-inclusion', rulesFired, distanceTo(freeFloat, inclusion.highInr), segment, company);
    }
    rulesFired.push(rule(
      'entry-lower-band', 'Free float vs the desk\'s lower inclusion band',
      freeFloat, inclusion.lowInr, 'desk',
      freeFloat >= inclusion.lowInr ? 'above' : 'below',
    ));
    if (freeFloat >= inclusion.lowInr) {
      return finish('possible-inclusion', rulesFired, distanceTo(freeFloat, inclusion.highInr), segment, company);
    }
    return finish('stable', rulesFired, distanceTo(freeFloat, inclusion.lowInr), segment, company);
  }

  // Constituents: exclusion first, because falling out of the index entirely
  // outranks moving between segments.
  rulesFired.push(rule(
    'exclusion-lower-band', 'Free float vs the desk\'s lower exclusion band',
    freeFloat, exclusion.lowInr, 'desk',
    freeFloat < exclusion.lowInr ? 'below' : 'above',
  ));
  if (freeFloat < exclusion.lowInr) {
    return finish('likely-exclusion', rulesFired, distanceTo(freeFloat, exclusion.lowInr), segment, company);
  }

  rulesFired.push(rule(
    'exclusion-upper-band', 'Free float vs the desk\'s upper exclusion band',
    freeFloat, exclusion.highInr, 'desk',
    freeFloat < exclusion.highInr ? 'below' : 'above',
  ));
  if (freeFloat < exclusion.highInr) {
    return finish('exclusion-risk', rulesFired, distanceTo(freeFloat, exclusion.lowInr), segment, company);
  }

  // ---- the segment question, by RANK CROSSING ---------------------------
  // Not "below the Standard floor": the floor IS the smallest Standard
  // constituent, so that test can never fire for a Standard constituent. The
  // rank crossing compares against the whole universe instead.
  if (rank !== null && standardCount > 0) {
    if (segment === 'smallcap') {
      rulesFired.push(rule(
        'rank-crossing-up', `Rank by free float vs the ${standardCount}-name Standard segment`,
        rank, standardCount, 'observed',
        rank <= standardCount ? 'inside' : 'outside',
        `Ranked ${rank} of ${ranks.size} companies with a free-float reading.`,
      ));
      if (rank <= standardCount) {
        return finish('migration-up', rulesFired, distanceTo(freeFloat, boundary.rankCutoffInr), segment, company);
      }
    } else if (segment === 'standard') {
      rulesFired.push(rule(
        'rank-crossing-down', `Rank by free float vs the ${standardCount}-name Standard segment`,
        rank, standardCount, 'observed',
        rank > standardCount ? 'outside' : 'inside',
        `Ranked ${rank} of ${ranks.size} companies with a free-float reading.`,
      ));
      if (rank > standardCount) {
        return finish('migration-down', rulesFired, distanceTo(freeFloat, boundary.rankCutoffInr), segment, company);
      }
    }
  }

  return finish('stable', rulesFired, distanceTo(freeFloat, exclusion.highInr), segment, company);
}

/** Signed distance to a threshold, as a percentage of that threshold. */
function distanceTo(value, threshold) {
  if (value === null || threshold === null || !(threshold > 0)) return null;
  return ((value - threshold) / threshold) * 100;
}

function finish(verdict, rulesFired, distancePct, segment, company) {
  const notes = [];
  if (TRADE_IMPLYING.has(verdict) && segment !== 'standard' && !isSampledByEmSmallCap(company)) {
    notes.push('EM Small-Cap does not currently sample this company, so it has no basis for an EM SC flow estimate.');
  }
  return {
    verdict,
    segment,
    rulesFired,
    distancePct: distancePct === null ? null : Number(distancePct.toFixed(3)),
    notes,
  };
}

/**
 * Replay a recorded `rulesFired` and recover the verdict.
 *
 * This exists so the build can assert that every verdict is reproducible from
 * its own audit trail. If this and `assess` ever disagree, the drill panel is
 * showing a derivation that did not produce the verdict beside it — which is a
 * worse failure than a wrong verdict, because it looks checkable and is not.
 */
export function verdictFromRules(rulesFired) {
  if (!Array.isArray(rulesFired) || rulesFired.length === 0) return null;
  const byKey = new Map(rulesFired.map((r) => [r.key, r]));

  if (byKey.has('share-count-quarantined') || byKey.has('no-free-float')) return 'unknown';

  const entryUpper = byKey.get('entry-upper-band');
  if (entryUpper) {
    if (entryUpper.input >= entryUpper.threshold) return 'likely-inclusion';
    const entryLower = byKey.get('entry-lower-band');
    if (entryLower && entryLower.input >= entryLower.threshold) return 'possible-inclusion';
    return 'stable';
  }

  const excLower = byKey.get('exclusion-lower-band');
  if (excLower && excLower.input < excLower.threshold) return 'likely-exclusion';
  const excUpper = byKey.get('exclusion-upper-band');
  if (excUpper && excUpper.input < excUpper.threshold) return 'exclusion-risk';

  const up = byKey.get('rank-crossing-up');
  if (up && up.input <= up.threshold) return 'migration-up';
  const down = byKey.get('rank-crossing-down');
  if (down && down.input > down.threshold) return 'migration-down';

  return 'stable';
}

/** The sentence that must accompany any verdict on screen or in an export. */
export const DISCLOSURE =
  'A rule-based assessment against the desk\'s thresholds and the observed constituent boundary — '
  + 'not a probability, and not MSCI\'s decision.';

export { THRESHOLD_SOURCE, toCrore };
