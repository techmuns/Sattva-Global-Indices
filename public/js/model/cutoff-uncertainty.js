/**
 * cutoff-uncertainty.js — the size cutoff is an estimate, and this says how good.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM, IN THE DESK'S OWN WORDS
 * ---------------------------------------------------------------------------
 * *"Whether the cut off will be 3,000 or 3,500 or 4,000 Cr, that nobody knows…
 * we cannot be 100% right in this forecast."*
 *
 * Every verdict in `assess.js` turns on two rupee numbers — the IMI cutoff and
 * the Standard cutoff — and both render as a single figure. They are derived,
 * they are labelled derived, and they are still POINTS. A point implies a
 * precision the derivation does not have. A company at ₹9,300 Cr measured
 * against a cutoff at ₹9,485 Cr reads "just below the bar"; the honest reading
 * is "inside the width of the bar".
 *
 * ---------------------------------------------------------------------------
 * ⚠ WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 * It is NOT a probability. §2.13 refuses one because a probability needs a base
 * rate and a base rate needs history — dated holdings across many reviews, which
 * this repo does not have. One scored review (§2.32) is not that history, and
 * nothing here changes it.
 *
 * It is NOT a confidence interval either. There is no distribution behind the
 * band, no σ, and no coverage claim. It is an ENVELOPE: the lowest and highest
 * cutoff among a handful of named alternatives, each one individually
 * defensible from something we hold or something MSCI published.
 *
 * What reaches a reader is therefore a SCENARIO COUNT WITH ITS DENOMINATOR —
 * "this verdict holds at 6 of 6 cutoffs we can defend" — which is a measurement
 * of our own model's stability, not a claim about MSCI's decision. §2.5's rule
 * about always printing the denominator is why it is never rendered as a bare
 * fraction or a percentage.
 *
 * ---------------------------------------------------------------------------
 * ⚠ SCENARIOS MOVE ONE COMPONENT AT A TIME, AND THAT IS DELIBERATE
 * ---------------------------------------------------------------------------
 * Three components go into the band. Crossing them would give 3^3 scenarios and
 * a wider envelope, and every scenario in the interior would be a combination
 * nobody could argue for on its own. One component at a time keeps each scenario
 * explicable — "the cutoff if MSCI priced on the cheapest of its ten candidate
 * days" is a sentence; "the cutoff if MSCI priced on the cheapest day AND our
 * constituent count is short AND the bar drifts down as far as it did last
 * quarter" is a stack of assumptions wearing one number.
 *
 * The consequence is that the band is the widest SINGLE-component move, not a
 * compounding of all three, and it is therefore a floor on the real uncertainty
 * rather than a ceiling. Every surface that shows it says so.
 */

import { CUTOFF_UNCERTAINTY } from '../config/thresholds.mjs';

export { CUTOFF_UNCERTAINTY };

/** The cutoff a verdict was decided against, per rule key. */
const RULE_CUTOFF = {
  'entry-cutoff': 'imi',
  'entry-buffer': 'imi',
  'entry-free-float': 'imi',
  'exit-size-buffer': 'imi',
  'exit-free-float': 'imi',
  'migration-up-buffer': 'standard',
  'migration-down-buffer': 'standard',
};

/**
 * Which cutoff a verdict turns on. `null` where it turns on neither — a
 * quarantined share count or a missing size cannot be rescued by moving a bar,
 * and saying it depends on the cutoff would be a claim about the wrong thing.
 */
export function cutoffFor(assessment) {
  const key = assessment?.distanceRuleKey ?? null;
  if (key && RULE_CUTOFF[key]) return RULE_CUTOFF[key];
  for (const r of assessment?.rulesFired ?? []) {
    if (RULE_CUTOFF[r.key]) return RULE_CUTOFF[r.key];
  }
  return null;
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Apply a component's multipliers to the shipped cutoffs, producing the cutoff
 * object `assess()` expects.
 *
 * ⚠ THE COUNTS TRAVEL WITH THE NUMBERS. Several rules print "the Nth company by
 * full market cap across all M" in their own note, so a scenario that moved the
 * rupee figure and left N behind would render a derivation that does not produce
 * the number beside it — §2.13's replay failure in a different costume.
 */
function applyScenario(base, { standardInr, imiInr, standardCount, imiCount }) {
  return {
    ...base,
    standardCount: standardCount ?? base.standardCount,
    imiCount: imiCount ?? base.imiCount,
    standard: { ...base.standard, inr: standardInr },
    imi: { ...base.imi, inr: imiInr },
  };
}

/**
 * Build the scenario list from the shipped cutoffs and the measured components.
 *
 * PURE, and shared by the build and the browser on purpose. The browser
 * re-derives `sizeCutoffs` from live prices on every tick (see tabs/companies.js
 * on why a cutoff carried over from the build would rank today's prices against
 * yesterday's bar), so it must re-derive the scenarios too — and it must do it
 * with THIS function, not a second copy that drifts.
 *
 * @param {object} sizeCutoffs  the shipped cutoffs, from observedSizeCutoffs()
 * @param {object} uncertainty  the measured components, from the record
 * @returns {Array} scenarios, the shipped one first
 */
export function cutoffScenarios(sizeCutoffs, uncertainty) {
  const shippedStandard = sizeCutoffs?.standard?.inr ?? null;
  const shippedImi = sizeCutoffs?.imi?.inr ?? null;
  const scenarios = [{
    key: 'shipped',
    label: 'the point estimate',
    component: null,
    direction: null,
    standardInr: shippedStandard,
    imiInr: shippedImi,
    cutoffs: sizeCutoffs,
    basis: 'The Nth company by full market cap, N being the constituents the funds show MSCI holding.',
    source: 'derived — the committed holdings and today\'s closes',
  }];
  if (!uncertainty?.components?.length || !finite(shippedImi)) return scenarios;

  for (const component of uncertainty.components) {
    if (!component.applies) continue;
    const directions = component.sided === 'both' ? ['low', 'high'] : [component.sided === 'up' ? 'high' : 'low'];
    for (const direction of directions) {
      const sMul = component.standard?.[direction];
      const iMul = component.imi?.[direction];
      // A component that moves neither cutoff is not a scenario. It stays on the
      // record with `applies: true` and a multiplier of 1 so a reader can see it
      // was measured and came out flat — but generating a duplicate of the point
      // estimate would inflate the denominator with a scenario that says nothing.
      if (!(finite(sMul) && finite(iMul)) || (sMul === 1 && iMul === 1)) continue;
      scenarios.push({
        key: `${component.key}-${direction}`,
        label: `${component.label} — ${direction === 'low' ? 'lower' : 'higher'} end`,
        component: component.key,
        direction,
        standardInr: shippedStandard === null ? null : shippedStandard * sMul,
        imiInr: shippedImi * iMul,
        cutoffs: applyScenario(sizeCutoffs, {
          standardInr: shippedStandard === null ? null : shippedStandard * sMul,
          imiInr: shippedImi * iMul,
          standardCount: component.counts?.[direction]?.standard ?? null,
          imiCount: component.counts?.[direction]?.imi ?? null,
        }),
        basis: component.basis,
        source: component.source,
      });
    }
  }
  return scenarios;
}

/** The envelope: the lowest and highest cutoff across the scenarios. */
export function cutoffBand(scenarios) {
  const pick = (field) => {
    const values = scenarios.map((s) => s[field]).filter(finite);
    if (!values.length) return { lowInr: null, highInr: null, pointInr: null, widthPct: null };
    const pointInr = scenarios[0][field];
    const lowInr = Math.min(...values);
    const highInr = Math.max(...values);
    return {
      lowInr,
      highInr,
      pointInr: finite(pointInr) ? pointInr : null,
      widthPct: finite(pointInr) && pointInr > 0 ? ((highInr - lowInr) / pointInr) * 100 : null,
    };
  };
  return { standard: pick('standardInr'), imi: pick('imiInr'), scenarioCount: scenarios.length };
}

/**
 * Replay one company's verdict at every scenario.
 *
 * ⚠ IT REPLAYS THE REAL RULES ENGINE. `assess` is passed in rather than
 * imported so this module stays free of a circular import, but it is the same
 * function that produced the shipped verdict — a parallel reimplementation
 * "just for the sensitivity" would drift from the model it claims to measure,
 * and the drift would be invisible because both would look reasonable.
 *
 * @returns {{state, verdict, cutoff, scenarios, agreeing, alternatives, insideBand, bar, reason}}
 *   `state` is `firm` | `marginal` | `unmeasured`, `agreeing` of `scenarios` is a
 *   COUNT and never a rate, and `bar` is the band of the bar this row was judged
 *   against — not the raw cutoff band.
 */
export function assessAcrossScenarios(company, context, scenarios, assess, shippedAssessment = null) {
  // The caller usually has the shipped verdict already — the build's loop and
  // the browser's both compute it a line earlier — and recomputing it here would
  // be a sixth of the whole cost for an answer we were handed.
  const shipped = shippedAssessment ?? assess(company, { ...context, sizeCutoffs: scenarios[0].cutoffs });
  const turnsOn = cutoffFor(shipped);

  // A verdict that does not turn on a cutoff cannot be moved by one, and
  // counting scenarios for it would report agreement that was never at risk.
  // `unmeasured` is a different fact from `firm` and is never folded into it.
  if (!turnsOn || scenarios.length < 2) {
    return {
      // ONE state, TWO reasons, and the reason below says which. Both are
      // "no cutoff can move this", and neither is `firm` — a verdict that was
      // never at risk has not survived anything.
      state: 'unmeasured',
      verdict: shipped.verdict,
      cutoff: turnsOn,
      scenarios: scenarios.length,
      agreeing: null,
      alternatives: [],
      insideBand: null,
      bar: null,
      reason: turnsOn
        ? 'Only one cutoff could be defended, so there is nothing to vary.'
        : CUTOFF_UNCERTAINTY.vocabulary.unmeasured.detail,
    };
  }

  const byVerdict = new Map();
  for (const scenario of scenarios) {
    const verdict = scenario.key === 'shipped'
      ? shipped.verdict
      : assess(company, { ...context, sizeCutoffs: scenario.cutoffs }).verdict;
    if (!byVerdict.has(verdict)) byVerdict.set(verdict, []);
    byVerdict.get(verdict).push(scenario.key);
  }

  const agreeing = byVerdict.get(shipped.verdict)?.length ?? 0;
  const alternatives = [...byVerdict.entries()]
    .filter(([verdict]) => verdict !== shipped.verdict)
    .map(([verdict, keys]) => ({ verdict, scenarios: keys, count: keys.length }))
    .sort((a, b) => b.count - a.count);

  const band = cutoffBand(scenarios)[turnsOn];

  // ---- is the company inside the width of the bar that judged it? --------
  //
  // ⚠ IT IS THE BAR, NOT THE CUTOFF. Most rules compare against a MULTIPLE of a
  // cutoff — 2/3 of it for a deletion, 1.5x for an entry — so testing a company
  // against the raw cutoff band would answer a question no rule asked. A
  // migration-down candidate sits far below the Standard cutoff BY DEFINITION
  // and would read "outside the band" on every row, which is true and useless.
  //
  // The bar moves with the cutoff by a fixed ratio, so the bar's own band is the
  // cutoff's band scaled by the same ratio. That is the number a reader wants:
  // this company's size against the width of the line it was judged against.
  const deciding = shipped.rulesFired?.find((r) => r.key === shipped.distanceRuleKey && RULE_CUTOFF[r.key])
    ?? [...(shipped.rulesFired ?? [])].reverse().find((r) => RULE_CUTOFF[r.key]);
  let bar = null;
  let insideBand = null;
  if (deciding && deciding.unit === 'inr' && finite(deciding.input) && finite(deciding.threshold)
      && finite(band.lowInr) && finite(band.highInr) && band.pointInr > 0) {
    const lowInr = deciding.threshold * (band.lowInr / band.pointInr);
    const highInr = deciding.threshold * (band.highInr / band.pointInr);
    insideBand = deciding.input >= lowInr && deciding.input <= highInr;
    bar = {
      ruleKey: deciding.key,
      label: deciding.label,
      inputInr: deciding.input,
      thresholdInr: deciding.threshold,
      lowInr,
      highInr,
    };
  }

  return {
    state: alternatives.length ? 'marginal' : 'firm',
    verdict: shipped.verdict,
    cutoff: turnsOn,
    scenarios: scenarios.length,
    agreeing,
    alternatives,
    insideBand,
    bar,
    reason: alternatives.length
      ? CUTOFF_UNCERTAINTY.vocabulary.marginal.detail
      : CUTOFF_UNCERTAINTY.vocabulary.firm.detail,
  };
}
