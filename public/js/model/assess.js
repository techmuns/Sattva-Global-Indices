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
 * WHAT DECIDES A VERDICT, AFTER THE AUGUST 2026 REVIEW
 * ---------------------------------------------------------------------------
 * Until September 2026 every verdict here was one comparison: free-float market
 * cap against the desk's rupee band. The August review scored that model at
 * 13.9% precision, and the diagnosis was not a mis-set number — it was four
 * category errors, each with a published correction. See
 * AUGUST_2026_CALIBRATION in config/thresholds.mjs for the measurement and
 * CLAUDE.md §2.33 for the doctrine.
 *
 * The verdict now follows MSCI's published geometry:
 *
 *   size          FULL market cap against a size-segment cutoff      (GIMI p. 28)
 *   free float    a SEPARATE minimum, 50% of that cutoff, with
 *                 2/3 relief for an existing constituent             (pp. 30, 45)
 *   FIF           a floor of 0.15                                    (pp. 21, 45)
 *   migration     2/3 out, 1.5x in — asymmetric, hysteretic          (pp. 44-45)
 *
 * ⚠ THE RATIOS ARE MSCI'S. THE CUTOFFS ARE OURS. Both cutoffs are the Nth
 * company by full market cap across the WHOLE record, where N is the number of
 * India names the funds show MSCI actually holding in that segment. MSCI derives
 * its own across all of emerging markets from a universe we cannot see. Nothing
 * here may be printed as MSCI's arithmetic — see `observedSizeCutoffs` in
 * model/thresholds.js for why the coverage walk in gimi.js is not used for this.
 *
 * ⚠ THE DESK'S BANDS ARE STILL MEASURED AND NO LONGER DECIDE. They fire as
 * their own rules on every company, carrying their own floated thresholds and
 * their own results, so a reader can see exactly where the desk's frame and
 * MSCI's part company (CLAUDE.md §2.14). `DESK_BAND_ROLE` says so in words.
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
import { SEGMENT_BAND_ADJUSTMENT, DESK_BAND_ROLE } from '../config/thresholds.mjs';
import { BUFFERS, MIN_FREE_FLOAT_MCAP, MIN_FIF, CUTOFF_BASIS, SOURCE } from '../config/msci-methodology.mjs';
import { segmentOf, isSampledByEmSmallCap } from './segments.js';

export { DESK_BAND_ROLE };

/**
 * The bars that decide a verdict, derived from the two observed cutoffs by
 * MSCI's published ratios. One place, so no rule can invent its own.
 *
 * Every field carries the page it came from because a reader must be able to
 * separate the ratio (MSCI's) from the rupee figure (ours) without leaving the
 * row — CLAUDE.md §2.25.
 */
export function barsFrom(cutoffs) {
  const imi = cutoffs?.imi?.inr ?? null;
  const standard = cutoffs?.standard?.inr ?? null;
  const scale = (base, factor) => (Number.isFinite(base) ? base * factor : null);
  return {
    imiCutoffInr: imi,
    standardCutoffInr: standard,
    // Index membership, on full market cap.
    entryFullInr: scale(imi, BUFFERS.upperMultiple),
    exitFullInr: scale(imi, BUFFERS.lowerMultiple),
    // The separate free-float minimum, expressed as a share of the SAME cutoff.
    // Not a share of a free-float cutoff: MSCI states it against the size-segment
    // cutoff, which is a full market cap (p. 30).
    entryFreeFloatInr: scale(imi, MIN_FREE_FLOAT_MCAP.newConstituentMultipleOfCutoff),
    exitFreeFloatInr: scale(imi, MIN_FREE_FLOAT_MCAP.newConstituentMultipleOfCutoff * MIN_FREE_FLOAT_MCAP.existingConstituentRelief),
    // Segment membership, against the Standard cutoff.
    migrationUpFullInr: scale(standard, BUFFERS.upperMultiple),
    migrationDownFullInr: scale(standard, BUFFERS.lowerMultiple),
    fifFloor: MIN_FIF.floor,
    pages: {
      cutoffBasis: CUTOFF_BASIS.page,
      buffers: BUFFERS.page,
      minFreeFloat: MIN_FREE_FLOAT_MCAP.pages,
      fif: MIN_FIF.pages,
    },
    source: `${SOURCE.document}, ${SOURCE.edition}`,
  };
}

/** The verdicts, in the order a summary should read them. */
export const VERDICTS = {
  'likely-inclusion': {
    key: 'likely-inclusion',
    label: 'Likely inclusion',
    tone: 'positive',
    implication: 'entry',
    detail: "Outside the index, clearing MSCI's separate free-float minimum and above its 1.5x "
      + 'entry buffer. Entry is replacement-based, so this is a candidacy, never an inclusion.',
  },
  'possible-inclusion': {
    key: 'possible-inclusion',
    label: 'Possible inclusion',
    tone: 'caution',
    implication: 'entry',
    detail: "Outside the index and above the IMI cutoff, but held back by MSCI's 1.5x entry buffer.",
  },
  'migration-up': {
    key: 'migration-up',
    label: 'Migration up',
    tone: 'positive',
    implication: 'migration-up',
    detail: "A Small Cap constituent whose full market cap has cleared 1.5x the Standard cutoff — "
      + "MSCI's Small Cap Upper Buffer.",
  },
  'migration-down': {
    key: 'migration-down',
    label: 'Migration down',
    tone: 'caution',
    implication: 'migration-down',
    detail: "A Standard constituent whose full market cap has fallen below 2/3 of the Standard "
      + "cutoff — MSCI's Standard Lower Buffer.",
  },
  'exclusion-risk': {
    key: 'exclusion-risk',
    label: 'Exclusion risk',
    tone: 'caution',
    implication: 'exit',
    detail: 'A constituent failing ONE of the two deletion tests: the size buffer, or the '
      + 'free-float minimum.',
  },
  'likely-exclusion': {
    key: 'likely-exclusion',
    label: 'Likely exclusion',
    tone: 'negative',
    implication: 'exit',
    detail: 'A constituent failing BOTH deletion tests: below 2/3 of the IMI cutoff on full market '
      + 'cap AND below the free-float minimum an incumbent is allowed.',
  },
  stable: {
    key: 'stable',
    label: 'Stable',
    tone: 'neutral',
    implication: 'none',
    // NOT "no rule fired". Under the MSCI model a company can be stable
    // BECAUSE a rule fired against it — LIC clears every size bar and is held
    // out by the 0.15 FIF floor. Saying no rule fired would contradict the
    // rules table printed directly beneath it.
    detail: 'No rule fired that implies a trade at the coming review.',
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

const rule = (key, label, input, threshold, thresholdSource, result, note, band, unit) => ({
  key, label, input, threshold, thresholdSource, result, note: note ?? null,
  // Rupees unless the rule says otherwise. `fif-floor` is the only rule that
  // compares a dimensionless factor, and it names its own unit — rendering
  // MSCI's 0.15 floor as "₹0 Cr" is not a rounding artefact, it is a different
  // number (CLAUDE.md §2.26).
  unit: unit ?? 'inr',
  // When the threshold was floated by the segment's own move, BOTH numbers are
  // on the rule: the desk's raw band and the bar actually applied. A reader has
  // to be able to see how far the adjustment moved the bar, and what the verdict
  // would have been without it.
  band: band ?? null,
});

/**
 * The bands in force for a segment, floated by how far that segment has moved
 * since the last review — see SEGMENT_BAND_ADJUSTMENT in config/thresholds.mjs.
 *
 * Returns the raw bands unchanged when the adjustment is off, when no benchmark
 * is available for the segment, or when the move is inside the noise floor.
 * Never guesses: a missing benchmark means the RAW band, never a fabricated one.
 */
export function bandsFor(segment, segmentReturnPct) {
  const cfg = SEGMENT_BAND_ADJUSTMENT;
  const raw = { inclusion: REVIEW_THRESHOLDS.inclusion, exclusion: REVIEW_THRESHOLDS.exclusion };
  const applied = cfg.enabled
    && typeof segmentReturnPct === 'number'
    && Number.isFinite(segmentReturnPct)
    && Math.abs(segmentReturnPct) >= cfg.minMovePct;

  if (!applied) {
    return {
      applied: false,
      segmentReturnPct: typeof segmentReturnPct === 'number' ? segmentReturnPct : null,
      reason: !cfg.enabled ? 'the segment adjustment is switched off'
        : typeof segmentReturnPct !== 'number' || !Number.isFinite(segmentReturnPct)
          ? 'no benchmark return for this segment, so the desk\'s raw band stands'
          : `the segment moved ${segmentReturnPct.toFixed(2)}%, inside the ${cfg.minMovePct}% floor `
            + 'below which the adjustment is recorded but not applied',
      factor: 1,
      inclusion: raw.inclusion,
      exclusion: raw.exclusion,
    };
  }

  const factor = 1 + (segmentReturnPct / 100);
  const scale = (band) => ({
    lowInr: Math.round(band.lowInr * factor),
    highInr: Math.round(band.highInr * factor),
    label: band.label,
  });
  return {
    applied: true,
    segmentReturnPct,
    reason: `the segment moved ${segmentReturnPct >= 0 ? '+' : ''}${segmentReturnPct.toFixed(2)}% `
      + "in rupees since the last review's effective date, so the desk's band is floated by the same "
      + 'proportion',
    factor: Number(factor.toFixed(6)),
    inclusion: scale(raw.inclusion),
    exclusion: scale(raw.exclusion),
  };
}

/**
 * Assess one company.
 *
 * @param {object} company
 * @param {{boundary: object, ranks: Map, quarantined: Set, keyOf: Function,
 *          sizeCutoffs: object, segmentReturns: object}} context
 * @returns {{verdict, rulesFired, distance, distanceLabel, segment, notes}}
 */
export function assess(company, context) {
  const { quarantined, keyOf, segmentReturns, sizeCutoffs } = context;
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

  // The bands, floated by how far this company's own segment has moved since the
  // last review. A fixed rupee bar cannot see that MSCI's cut-off moved too.
  const bands = bandsFor(segment, segmentReturns?.[segment] ?? null);
  const inclusion = bands.inclusion;
  const exclusion = bands.exclusion;
  const bandInfo = {
    applied: bands.applied,
    segmentReturnPct: bands.segmentReturnPct,
    factor: bands.factor,
    reason: bands.reason,
    rawInclusion: REVIEW_THRESHOLDS.inclusion,
    rawExclusion: REVIEW_THRESHOLDS.exclusion,
  };
  // ⚠ `boundary` and `ranks` are no longer read here, and that is deliberate
  // rather than an oversight. The rank crossing they served — "is this company
  // inside the top N by FREE FLOAT?" — was the segment test until September 2026;
  // it is now a crossing on FULL market cap, expressed as a rupee cutoff by
  // `observedSizeCutoffs`, because that is the quantity MSCI cuts on (p. 28).
  // Both stay in the context because the observed boundary is still reported on
  // the record and on screen; a rule that read one of them here would be
  // measuring a different boundary from the one deciding the verdict.
  const fullMcap = company.fullMcapInr;
  const floatFactor = company.floatFactor;
  const bars = barsFrom(sizeCutoffs);

  // ---- the desk's bands, MEASURED AND NOT DECIDING ----------------------
  // They fired first and decided the verdict until September 2026. They still
  // fire, so a reader can see where the desk's frame and MSCI's part company,
  // and `result` still says which side of the desk's band the company is on —
  // but nothing below branches on them. DESK_BAND_ROLE says so in words.
  const deskBand = segment === 'outside'
    ? rule('desk-inclusion-band', "Free float vs the desk's inclusion band", freeFloat,
      inclusion.highInr, 'desk',
      freeFloat >= inclusion.highInr ? 'above' : freeFloat >= inclusion.lowInr ? 'inside' : 'below',
      DESK_BAND_ROLE.rule, bandInfo)
    : rule('desk-exclusion-band', "Free float vs the desk's exclusion band", freeFloat,
      exclusion.lowInr, 'desk',
      freeFloat < exclusion.lowInr ? 'below' : freeFloat < exclusion.highInr ? 'inside' : 'above',
      DESK_BAND_ROLE.rule, bandInfo);

  // A size cutoff we could not derive is not a cutoff of zero. Without it there
  // is no bar to test against and the honest answer is `unknown` (§2.3).
  if (!Number.isFinite(bars.imiCutoffInr)) {
    rulesFired.push(deskBand);
    rulesFired.push(rule(
      'no-size-cutoff', 'No size-segment cutoff could be derived', null, null, 'observed', 'unknown',
      'The cutoff is the Nth company by full market cap where N is the constituent count, and the '
      + 'record carried neither.',
    ));
    return finish('unknown', rulesFired, null, segment, company);
  }

  // MSCI's size cutoff is a FULL market cap (p. 28). A company with no full
  // market cap cannot be placed against it, and a missing size is not a size of
  // zero — which would sort it to the bottom of every bar at once.
  if (!Number.isFinite(fullMcap)) {
    rulesFired.push(deskBand);
    rulesFired.push(rule(
      'no-full-mcap', 'No full market cap reading', 'fullMcapInr', null, 'measurement', 'unknown',
      "MSCI expresses a size-segment cutoff in full market cap (GIMI p. " + bars.pages.cutoffBasis
      + '), so a company without one cannot be placed against any bar.',
    ));
    return finish('unknown', rulesFired, null, segment, company);
  }

  rulesFired.push(deskBand);

  // ---- the FIF floor, which applies in every segment ---------------------
  // ⚠ THE RATIO IS MSCI'S AND THE QUANTITY IS OURS. MSCI's Foreign Inclusion
  // Factor nets foreign ownership limits as well as free float; the exchange
  // float factor does not. For most Indian companies the two are close, and for
  // one near a sectoral FDI cap they are not. The rule says so on its face.
  const fifRule = rule(
    'fif-floor', `Float factor vs MSCI's ${bars.fifFloor} Foreign Inclusion Factor floor`,
    floatFactor ?? null, bars.fifFloor, 'msci',
    !Number.isFinite(floatFactor) ? 'unknown' : floatFactor < bars.fifFloor ? 'below' : 'above',
    `MSCI requires FIF >= ${bars.fifFloor} for the investable universe and for an existing Small Cap `
    + `constituent to remain (${bars.source}, pp. ${bars.pages.fif.join(', ')}). Measured here on the `
    + "exchange's free-float factor, which is a PROXY for FIF: it does not carry foreign ownership limits.",
    null, 'factor',
  );
  const failsFif = Number.isFinite(floatFactor) && floatFactor < bars.fifFloor;

  if (segment === 'outside') {
    rulesFired.push(fifRule);
    if (failsFif) {
      return finish('stable', rulesFired, null, segment, company, 'fif-floor');
    }
    // The separate free-float minimum: 50% of the size-segment cutoff (p. 30).
    rulesFired.push(rule(
      'entry-free-float-minimum',
      `Free float vs ${MIN_FREE_FLOAT_MCAP.newConstituentMultipleOfCutoff * 100}% of the IMI cutoff`,
      freeFloat, bars.entryFreeFloatInr, 'msci',
      freeFloat >= bars.entryFreeFloatInr ? 'above' : 'below',
      `A new constituent needs free-float market cap of at least `
      + `${MIN_FREE_FLOAT_MCAP.newConstituentMultipleOfCutoff * 100}% of the size-segment cutoff `
      + `(${bars.source}, pp. ${bars.pages.minFreeFloat.join(', ')}). The cutoff is ours.`,
    ));
    if (freeFloat < bars.entryFreeFloatInr) {
      return finish('stable', rulesFired, distanceTo(freeFloat, bars.entryFreeFloatInr), segment, company, 'entry-free-float-minimum');
    }
    // The entry buffer: 1.5x the cutoff (p. 44).
    rulesFired.push(rule(
      'entry-buffer', `Full market cap vs ${BUFFERS.upperMultiple}x the IMI cutoff`,
      fullMcap, bars.entryFullInr, 'msci',
      fullMcap >= bars.entryFullInr ? 'above' : 'below',
      `MSCI's Small Cap Entry Buffer, ${BUFFERS.upperLabel} (${bars.source}, p. ${bars.pages.buffers}). `
      + 'Entry is REPLACEMENT-BASED: clearing this bar makes a company eligible, never included.',
    ));
    if (fullMcap >= bars.entryFullInr) {
      return finish('likely-inclusion', rulesFired, distanceTo(fullMcap, bars.entryFullInr), segment, company, 'entry-buffer');
    }
    rulesFired.push(rule(
      'entry-cutoff', 'Full market cap vs the IMI cutoff', fullMcap, bars.imiCutoffInr, 'observed',
      fullMcap >= bars.imiCutoffInr ? 'above' : 'below',
      `The ${sizeCutoffs.imiCount}th company by full market cap across all `
      + `${sizeCutoffs.rankedCount} with both sizes on the record.`,
    ));
    if (fullMcap >= bars.imiCutoffInr) {
      return finish('possible-inclusion', rulesFired, distanceTo(fullMcap, bars.entryFullInr), segment, company, 'entry-buffer');
    }
    return finish('stable', rulesFired, distanceTo(fullMcap, bars.imiCutoffInr), segment, company, 'entry-cutoff');
  }

  if (segment === 'standard') {
    // Segment migration down: below 2/3 of the STANDARD cutoff (pp. 44-45).
    rulesFired.push(rule(
      'migration-down-buffer', `Full market cap vs ${BUFFERS.lowerLabel} of the Standard cutoff`,
      fullMcap, bars.migrationDownFullInr, 'msci',
      fullMcap < bars.migrationDownFullInr ? 'below' : 'above',
      `MSCI's Standard Lower Buffer (${bars.source}, p. ${bars.pages.buffers}), applied to a Standard `
      + `cutoff of the ${sizeCutoffs.standardCount}th company by full market cap across the whole record.`,
    ));
    if (fullMcap < bars.migrationDownFullInr) {
      return finish('migration-down', rulesFired, distanceTo(fullMcap, bars.migrationDownFullInr), segment, company, 'migration-down-buffer');
    }
    return finish('stable', rulesFired, distanceTo(fullMcap, bars.migrationDownFullInr), segment, company, 'migration-down-buffer');
  }

  // ---- Small Cap constituents -------------------------------------------
  // Migration first: a company that has grown out of Small Cap is not an
  // exclusion candidate, however its free float reads.
  rulesFired.push(rule(
    'migration-up-buffer', `Full market cap vs ${BUFFERS.upperLabel} of the Standard cutoff`,
    fullMcap, bars.migrationUpFullInr, 'msci',
    fullMcap >= bars.migrationUpFullInr ? 'above' : 'below',
    `MSCI's Small Cap Upper Buffer (${bars.source}, p. ${bars.pages.buffers}), applied to a Standard `
    + `cutoff of the ${sizeCutoffs.standardCount}th company by full market cap across the whole record.`,
  ));
  if (fullMcap >= bars.migrationUpFullInr) {
    return finish('migration-up', rulesFired, distanceTo(fullMcap, bars.migrationUpFullInr), segment, company, 'migration-up-buffer');
  }

  rulesFired.push(fifRule);
  rulesFired.push(rule(
    'exit-size-buffer', `Full market cap vs ${BUFFERS.lowerLabel} of the IMI cutoff`,
    fullMcap, bars.exitFullInr, 'msci',
    fullMcap < bars.exitFullInr ? 'below' : 'above',
    `MSCI's Small Cap Lower Buffer (${bars.source}, p. ${bars.pages.buffers}). An existing constituent `
    + 'keeps its place until it falls below this, which is why a bright line over-predicts deletion.',
  ));
  rulesFired.push(rule(
    'exit-free-float-minimum', "Free float vs an existing constituent's free-float minimum",
    freeFloat, bars.exitFreeFloatInr, 'msci',
    freeFloat < bars.exitFreeFloatInr ? 'below' : 'above',
    `${MIN_FREE_FLOAT_MCAP.newConstituentMultipleOfCutoff * 100}% of the size-segment cutoff with `
    + `${MIN_FREE_FLOAT_MCAP.existingConstituentRelief.toFixed(3)} relief for an incumbent `
    + `(${bars.source}, pp. ${bars.pages.minFreeFloat.join(', ')}).`,
  ));

  const failsSize = fullMcap < bars.exitFullInr;
  const failsFloat = freeFloat < bars.exitFreeFloatInr || failsFif;
  if (failsSize && failsFloat) {
    return finish('likely-exclusion', rulesFired, distanceTo(fullMcap, bars.exitFullInr), segment, company, 'exit-size-buffer');
  }
  if (failsSize || failsFloat) {
    return finish('exclusion-risk', rulesFired, distanceTo(fullMcap, bars.exitFullInr), segment, company, 'exit-size-buffer');
  }
  return finish('stable', rulesFired, distanceTo(fullMcap, bars.exitFullInr), segment, company, 'exit-size-buffer');
}

/** Signed distance to a threshold, as a percentage of that threshold. */
function distanceTo(value, threshold) {
  if (value === null || threshold === null || !(threshold > 0)) return null;
  return ((value - threshold) / threshold) * 100;
}

function finish(verdict, rulesFired, distancePct, segment, company, distanceRuleKey) {
  const notes = [];
  if (TRADE_IMPLYING.has(verdict) && segment !== 'standard' && !isSampledByEmSmallCap(company)) {
    notes.push('EM Small-Cap does not currently sample this company, so it has no basis for an EM SC flow estimate.');
  }
  return {
    verdict,
    segment,
    rulesFired,
    distancePct: distancePct === null ? null : Number(distancePct.toFixed(3)),
    // Which rule the distance was measured against.
    //
    // ⚠ THE FALLBACK IS A LAST RESORT, NOT THE NORMAL PATH. Every call site
    // above names its rule explicitly, because "the last rule fired" pairs a
    // real percentage with an unrelated threshold wherever a rule is pushed and
    // does not decide — which is most of them now that the desk's band, the FIF
    // floor and both deletion tests are always recorded. LIC is the case that
    // proved it: the verdict turns on the FIF floor while the last rule fired is
    // about free float.
    distanceRuleKey: distanceRuleKey ?? (rulesFired.length ? rulesFired[rulesFired.length - 1].key : null),
    notes,
    // Named explicitly rather than left undefined: the interface now carries
    // two models, and a consumer asking "which produced this?" must never have
    // to infer it from a field's absence.
    methodology: 'freefloat',
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

  if (byKey.has('share-count-quarantined') || byKey.has('no-free-float')
    || byKey.has('no-size-cutoff') || byKey.has('no-full-mcap')) return 'unknown';

  // ⚠ THE DESK'S BAND RULE IS PRESENT ON EVERY COMPANY AND DECIDES NOTHING.
  // It is deliberately not read here: if this replay branched on it, the audit
  // trail would recover a verdict `assess` does not produce, and the build's
  // replay assertion would be proving the wrong thing.

  const fif = byKey.get('fif-floor');
  const failsFif = Boolean(fif) && fif.result === 'below';

  // Outside the index: FIF floor, then the free-float minimum, then the buffers.
  const entryMin = byKey.get('entry-free-float-minimum');
  if (entryMin) {
    if (failsFif) return 'stable';
    if (entryMin.input < entryMin.threshold) return 'stable';
    const buffer = byKey.get('entry-buffer');
    if (buffer && buffer.input >= buffer.threshold) return 'likely-inclusion';
    const cutoff = byKey.get('entry-cutoff');
    if (cutoff && cutoff.input >= cutoff.threshold) return 'possible-inclusion';
    return 'stable';
  }

  // Standard constituents: one buffer test.
  const down = byKey.get('migration-down-buffer');
  if (down) return down.input < down.threshold ? 'migration-down' : 'stable';

  // Small Cap constituents: migration up first, then the two deletion tests.
  const up = byKey.get('migration-up-buffer');
  if (up && up.input >= up.threshold) return 'migration-up';
  const size = byKey.get('exit-size-buffer');
  const float = byKey.get('exit-free-float-minimum');
  if (size && float) {
    const failsSize = size.input < size.threshold;
    const failsFloat = float.input < float.threshold || failsFif;
    if (failsSize && failsFloat) return 'likely-exclusion';
    if (failsSize || failsFloat) return 'exclusion-risk';
    return 'stable';
  }

  return 'stable';
}

/** The sentence that must accompany any verdict on screen or in an export. */
export const DISCLOSURE =
  "A rule-based assessment: MSCI's published buffers, free-float minimum and FIF floor applied to "
  + 'size cutoffs derived from the constituents the funds hold. The ratios are MSCI\'s; the rupee '
  + "cutoffs are ours. Not a probability, and not MSCI's decision.";

export { THRESHOLD_SOURCE, toCrore };
