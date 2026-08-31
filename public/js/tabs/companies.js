/**
 * THE master table — the whole v1 view.
 *
 * Company, free float, index participation and weights. The probability of
 * inclusion or exclusion is a later prompt; nothing on this screen is modelled,
 * and the provenance section of the drill says so explicitly rather than
 * leaving a reader to assume.
 */

import { $, el, escapeHtml } from '../core/dom.js';
import { cr, inr, inrFlow, pct, factorPct, num, count, shortDate, dayChange, signedPct, plural, EM_DASH } from '../core/format.js';
import * as data from '../data/companies.js';
import * as state from '../core/state.js';
import * as quotes from '../data/quotes.js';
import { setParams, getParam, onRoute } from '../core/router.js';
import { parseRange, withinRange } from '../core/range.js';
import { segmentedToggle } from '../ui/components.js';
import { sectionHead, statStrip, scoreTable, openDrill, closeDrill } from '../ui/screener.js';
import { sourceChip, fundChip, missing } from '../ui/visual.js';
import { exportCsv } from '../ui/export.js';
// `crore` (₹ Cr → rupees) went with the fixed bands: nothing in this module
// converts INTO rupees any more. The typed range is compared in ₹ crore, so
// only `toCrore` — the record's way out — is needed here.
import { REVIEW_THRESHOLDS, toCrore, MARKET_CAP_FILTER_ATTRIBUTION, RELATIVE_PERFORMANCE, REBALANCE_BASELINE } from '../config/thresholds.mjs';
import { observedBoundary, rankByFreeFloat, THRESHOLD_SOURCE } from '../model/thresholds.js';
import { segmentOf, segmentFloatTotals, SEGMENTS } from '../model/segments.js';
import { assess, VERDICTS, DISCLOSURE, TRADE_IMPLYING } from '../model/assess.js';
import { estimateFlows } from '../model/flows.js';
import { nextReview, reviewCutoffs } from '../model/calendar.js';
import { gimiCutoffs, assessGimi, reviewWindow, METHODOLOGIES, GIMI_DISCLOSURE, CUTOFF_DISCLOSURE } from '../model/gimi.js';
import { trendSignal, flowPressure, WINDOW_STATES, REBASE_STATES } from '../model/relative.js';

const FUND_ORDER = ['eem', 'smin', 'eems'];

/* ────────────────────────────────────────────────────────────────────────────
 * Which rebalance date the three relative columns are baselined on
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The baseline in force: the reader's override if it is one the record actually
 * carries, otherwise the config-set default.
 *
 * ⚠ A STORED OVERRIDE IS VALIDATED AGAINST THE RECORD EVERY TIME. localStorage
 * outlives the data: a reader who picked the August 2025 baseline keeps that
 * string for ever, and it will one day fall off the end of what the fetcher
 * captures. Falling back to the default is the only safe answer — reading an
 * unknown baseline would empty three columns and the reader would take that as
 * a fact about the companies rather than about their stale preference.
 */
export function activeBaseline() {
  const context = data.rebalanceBaselines();
  if (!context) return null;
  const chosen = state.getBaseline();
  const known = (context.baselines ?? []).some((b) => b.review === chosen);
  return known ? chosen : context.defaultReview;
}

/** This company's reading under the baseline in force. `undefined` = not loaded. */
export const rebaseFor = (company) => data.readingFor(company, activeBaseline());

/**
 * The price and free float in force for a company RIGHT NOW.
 *
 * The committed record carries the EOD (BSE) figures. A live quote, when one
 * has arrived for this company's NSE symbol, overlays them in memory — and
 * SWAPS THE EXCHANGE while doing so, which is why `exchange` travels with every
 * number here. Nothing is blended; the EOD figures stay on the record beside
 * the live ones so a reader can see both.
 */
export function liveView(company) {
  const quote = quotes.liveQuote(company.nseSymbol);
  const usingLive = Boolean(quote && Number.isFinite(quote.price) && quote.price > 0);

  if (!usingLive) {
    return {
      live: false,
      price: company.priceInr,
      prevClose: company.prevCloseInr,
      exchange: company.priceExchange,
      tier: company.priceTier,
      staleDays: company.priceStaleDays ?? 0,
      priceDate: company.priceDate,
      freeFloatMcapInr: company.freeFloatMcapInr,
      dayChangePct: company.dayChangePct,
      basis: company.freeFloatBasis,
    };
  }

  const price = quote.price;
  const prevClose = quote.prevClose ?? company.prevCloseInr;
  // The recompute. This is why prompt 2 stored a factor and a share count
  // rather than a rupee figure.
  const freeFloat =
    company.floatFactor !== null && company.sharesOutstanding !== null
      ? Math.round(company.floatFactor * company.sharesOutstanding * price)
      : company.freeFloatMcapInr;

  return {
    live: true,
    price,
    prevClose,
    exchange: 'NSE',
    tier: 'live',
    staleDays: 0,
    priceDate: null,
    freeFloatMcapInr: freeFloat,
    dayChangePct:
      prevClose && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : null,
    basis: 'floatFactor × sharesOutstanding × live NSE price',
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The model, re-run against whatever price is in force
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Verdicts are stored in companies.json against the committed end-of-day
 * price. When live quotes are in force the free-float market caps move, so the
 * assessment is re-run here against the live view — exactly as free-float
 * market cap itself is recomputed rather than served stale.
 *
 * The whole context (boundary, ranks, segment totals) is rebuilt, not just the
 * one company's float: a rank crossing is a comparison against every other
 * company, so recomputing one row against a stale ranking would be wrong in
 * precisely the cases the model exists to catch. It is O(n log n) on 1,202
 * rows — a couple of milliseconds — and it runs once per tick, not once per row.
 */
let modelState = null;

/** A company as it currently stands: EOD fields overlaid with any live price. */
function liveCompany(company) {
  const view = liveView(company);
  if (!view.live) return company;
  return { ...company, freeFloatMcapInr: view.freeFloatMcapInr, priceInr: view.price };
}

export function rebuildModel() {
  const source = data.all();
  const live = source.map(liveCompany);
  const boundary = observedBoundary(live, segmentOf);
  const ranks = rankByFreeFloat(live, data.keyOf);
  const floatTotals = segmentFloatTotals(live);
  const quarantined = new Set(
    source.filter((c) => c.shareCountQuarantine).map((c) => data.keyOf(c)),
  );

  // BOTH METHODOLOGIES ARE BUILT ON EVERY REBUILD, not just the active one.
  //
  // The whole point of shipping two is the difference between them, so the
  // comparison has to be free at render time. Computing the inactive one lazily
  // would mean the "N verdicts differ" figure either lagged the toggle or cost
  // a full model pass to display — and a comparison nobody can see the price of
  // is a comparison that quietly stops being shown.
  const assessments = new Map();
  const gimiAssessments = new Map();
  const flows = new Map();
  // ⚠ segmentReturns IS LOAD-BEARING AND WAS MISSING.
  //
  // build-companies.mjs passes it; this did not. So every verdict in
  // companies.json was computed against bands FLOATED by the segment's move,
  // and every verdict the browser recomputed was against the RAW bands — two
  // different models wearing one name, differing silently on any row near a
  // band. It is read from the record rather than recomputed so the browser and
  // the build cannot drift apart again.
  const context = {
    boundary,
    ranks,
    quarantined,
    keyOf: data.keyOf,
    segmentReturns: data.benchmarks()?.adjustment?.segmentReturnsInrPct ?? null,
  };
  const flowContext = { flowPrimitives: data.flowPrimitives(), segmentFloatTotals: floatTotals };

  const cutoffs = gimiCutoffs(live);
  const window = reviewWindow(data.freshness().feeds.find((f) => f.id === 'bhavcopy')?.raw ?? null);
  const gimiContext = { cutoffs, quarantined, keyOf: data.keyOf, window };

  // The trend signal is computed HERE, not in the build, because it compares a
  // stored historical reading against the LIVE rank cutoff — and the cutoff
  // moves when a live price moves. The reading itself does not: it is a window
  // that closed on 31 July and no quote can change it.
  const trendSignals = new Map();
  // Flow pressure is computed here for the same reason: the reading is a closed
  // historical window that no quote can move, but whether it is NOTABLE depends
  // on the verdict and on the distance to the rank cutoff, and both of those
  // move when a live price moves.
  const pressures = new Map();
  const baseline = activeBaseline();

  for (const company of live) {
    const key = data.keyOf(company);
    const assessment = assess(company, context);
    assessments.set(key, assessment);
    gimiAssessments.set(key, assessGimi(company, gimiContext));
    const cutoff = boundary?.rankCutoffInr ?? null;
    const distanceToCutoffPct = cutoff > 0 && company.freeFloatMcapInr != null
      ? ((company.freeFloatMcapInr - cutoff) / cutoff) * 100
      : null;
    trendSignals.set(key, trendSignal(company.relativePerformance, {
      verdict: assessment.verdict,
      segment: assessment.segment,
      distanceToCutoffPct,
    }));
    // ⚠ `data.readingFor` returns UNDEFINED while an alternate baseline is still
    // being fetched, and NULL when this company genuinely has no reading. Only
    // the second may produce a classification; the first must stay absent, or a
    // loading state would render as a statement about the company.
    const reading = data.readingFor(company, baseline);
    pressures.set(key, reading === undefined ? undefined : flowPressure(reading, {
      segment: assessment.segment,
      verdict: assessment.verdict,
      distanceToCutoffPct,
      nearBoundaryPct: RELATIVE_PERFORMANCE.nearBoundaryPct,
      band: data.rebalanceBaselines()?.bandPct ?? REBALANCE_BASELINE.bandPct,
      thresholdSource: data.rebalanceBaselines()?.attribution ?? REBALANCE_BASELINE.attribution,
    }));
    // Flows follow the ACTIVE methodology's verdict, which is why they are
    // rebuilt when the toggle moves rather than cached against one model.
    flows.set(key, estimateFlows(company, assessment, flowContext));
  }

  modelState = {
    boundary, ranks, floatTotals, assessments, gimiAssessments, flows, trendSignals, pressures,
    baseline, cutoffs, window, builtAt: new Date(),
  };
  return modelState;
}

/** The GIMI cutoffs in force, derived by MSCI's procedure from this universe. */
export const modelCutoffs = () => modelState?.cutoffs ?? null;

/** Which review the figures on screen can honestly speak to. */
export const modelWindow = () => modelState?.window ?? null;

/**
 * How the two methodologies differ on the rows given.
 *
 * Derived, never typed. A reader comparing models needs the size of the
 * disagreement, not an assurance that one exists.
 */
export function methodologyDelta(rows) {
  if (!modelState) return null;
  const moves = new Map();
  let changed = 0;
  for (const company of rows) {
    const key = data.keyOf(company);
    const a = modelState.assessments.get(key)?.verdict ?? 'unknown';
    const b = modelState.gimiAssessments.get(key)?.verdict ?? 'unknown';
    if (a === b) continue;
    changed += 1;
    const move = `${a}\u0000${b}`;
    moves.set(move, (moves.get(move) ?? 0) + 1);
  }
  return {
    changed,
    total: rows.length,
    pct: rows.length ? (changed / rows.length) * 100 : null,
    moves: [...moves.entries()]
      .map(([move, count]) => { const [from, to] = move.split('\u0000'); return { from, to, count }; })
      .sort((x, y) => y.count - x.count),
  };
}

export const modelBoundary = () => modelState?.boundary ?? null;

/**
 * The assessment in force, under the methodology the reader has selected.
 *
 * Falls back to the stored EOD one before the first build — but ONLY for the
 * free-float model, because that is the one the build script wrote. There is no
 * stored GIMI assessment and inventing one from the other model's verdict would
 * make the toggle look like it had done nothing.
 */
export function assessmentFor(company, methodology = state.getMethodology()) {
  const key = data.keyOf(company);
  if (methodology === 'gimi') return modelState?.gimiAssessments.get(key) ?? null;
  return modelState?.assessments.get(key) ?? company.assessment ?? null;
}

/** The trend signal for a company, against the boundary as it currently stands. */
export const trendFor = (company) => modelState?.trendSignals.get(data.keyOf(company)) ?? null;

/** Flow pressure under the baseline in force. `undefined` while one is loading. */
export const pressureFor = (company) => modelState?.pressures.get(data.keyOf(company));

/** The same company under the OTHER methodology, for side-by-side comparison. */
export const otherAssessmentFor = (company) =>
  assessmentFor(company, state.getMethodology() === 'gimi' ? 'freefloat' : 'gimi');

/**
 * The rule a stored distance was measured against — never "the last rule fired".
 *
 * The last rule is the wrong one for three of the eight verdicts that carry a
 * distance: possible-inclusion is measured against the UPPER inclusion band
 * while the lower one fired last, exclusion-risk against the LOWER exclusion
 * band while the upper one fired last, and a final stable against the upper
 * exclusion band while a rank crossing may have been pushed after it. The
 * fallback stands only for a record written before distanceRuleKey existed.
 */
function distanceRule(row) {
  const assessment = assessmentFor(row);
  const rules = assessment?.rulesFired ?? [];
  return rules.find((r) => r.key === assessment?.distanceRuleKey) ?? rules[rules.length - 1] ?? null;
}

/** A threshold's unit, spelled out, because an export carries no chrome. */
const THRESHOLD_UNIT_LABEL = {
  inr: '₹ Cr',
  rank: 'position in the free-float ranking',
  factor: 'dimensionless float factor',
};

export function flowsFor(company) {
  return modelState?.flows.get(data.keyOf(company)) ?? company.flowEstimate ?? { flows: [], notSampled: [], shape: null };
}

const VERDICT_TONE = {
  positive: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  caution: 'bg-amber-50 text-amber-800 ring-amber-200',
  negative: 'bg-rose-50 text-rose-700 ring-rose-200',
  // Slate, never brand indigo: a verdict is a semantic state, and the brand
  // ramp is reserved for identity so the two can never be confused.
  neutral: 'bg-slate-100 text-slate-600 ring-slate-200',
};

function verdictPill(verdict, { title } = {}) {
  const meta = VERDICTS[verdict] ?? VERDICTS.unknown;
  return (
    `<span class="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${VERDICT_TONE[meta.tone]}"`
    + ` title="${escapeHtml(title ?? `${meta.detail} ${DISCLOSURE}`)}">${escapeHtml(meta.label)}</span>`
  );
}

/** The chip that says which exchange priced this row, and how fresh it is. */
function priceChip(view) {
  if (view.tier === 'live') {
    // Says LIVE, not NSE. The chip beside it already names the exchange that
    // published the FLOAT, and two chips both reading "NSE" for two different
    // things is worse than one that reads clearly — the price's exchange is in
    // the cell title and in the header pill.
    return '<span class="ml-1 inline-flex items-center rounded-md bg-emerald-50 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-700 ring-1 ring-inset ring-emerald-200" title="Priced from a live NSE quote this session — a different exchange from the committed BSE close.">LIVE</span>';
  }
  if (view.tier === 'stale') {
    return `<span class="ml-1 inline-flex items-center rounded-md bg-amber-50 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-800 ring-1 ring-inset ring-amber-200" title="This stock did not trade. Its last close of ${escapeHtml(shortDate(view.priceDate))} is carried forward — that is not the same as unchanged.">${view.staleDays}D</span>`;
  }
  if (view.tier === 'eod') {
    return '<span class="ml-1 inline-flex items-center rounded-md bg-slate-100 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-500 ring-1 ring-inset ring-slate-200" title="BSE closing price from the committed end-of-day bhavcopy.">BSE</span>';
  }
  return '';
}

/**
 * The market-cap filter: a min–max range the reader types, in ₹ crore.
 *
 * It was five fixed bands in a dropdown until 31 Aug 2026. The bands covered
 * the universe and nothing else: they could answer "roughly how big" and could
 * not answer "show me ₹3,000 to ₹8,000 Cr", which is the actual question when
 * a company is being weighed against a cut-off. Ranges a reader types have no
 * boundaries for us to have chosen, which is the point — and it is also why
 * the entry itself now has to be honest about what it did with the typing.
 *
 * Four things this owes the reader, and each is load-bearing:
 *
 *   THE UNIT. The comparison happens in ₹ CRORE — the unit on the boxes, the
 *   unit on the column, the unit the reader typed. Converting the entry to
 *   rupees to meet the record would put a factor of ten million between what
 *   was asked and what was answered, which is this project's signature failure
 *   (CLAUDE.md §3.8). `toCrore` is the single conversion point and it converts
 *   the RECORD, once per row, not the reader.
 *
 *   THE GROUPING. "3,000" is three thousand. `parseFloat` would read it as 3
 *   without erroring, so `parseRange` validates the whole string before
 *   converting anything and refuses what it cannot read (core/range.js).
 *
 *   BOTH ENDS INCLUDED. A person who types 3,000–8,000 means both. The old
 *   bands were half-open because they had to tile a universe with no gaps and
 *   no overlaps; a typed range has no such duty, and the status line says
 *   "inclusive" rather than leaving it to be discovered.
 *
 *   NO READING IS NOT SMALL. A company with no market cap matches no range in
 *   either direction (CLAUDE.md §2.3), and the note under the toolbar counts
 *   how many that is so the gap is never mistaken for a boundary effect.
 */
function marketCapRange(rows) {
  const withReading = rows.filter((row) => row.fullMcapInr !== null && row.fullMcapInr !== undefined);
  const note =
    `${MARKET_CAP_FILTER_ATTRIBUTION} `
    + 'Either end may be left blank for an open end — a blank is not a zero. '
    + `${num(withReading.length)} of ${num(rows.length)} companies carry a market-cap reading; `
    + `the other ${num(rows.length - withReading.length)} have no reading and match no range in either direction.`;

  // Local, because `cr` from ../core/format.js is the table cell formatter and
  // shadowing it here would make two different formatters share one name.
  const crLabel = (value) => num(value, Number.isInteger(value) ? 0 : 2);

  return {
    id: 'mcap',
    kind: 'range',
    label: 'Market cap',
    unitPrefix: '₹',
    unitSuffix: 'Cr',
    placeholders: { min: 'min', max: 'max' },
    hint:
      'Type a number in either box, or the whole range in one — 3,000–8,000. '
      + '>3000, <8000 and 3000+ work too. Blank means open-ended. Figures are ₹ crore of full market cap.',
    note,
    parse: parseRange,
    // In ₹ crore, the unit the reader typed in. The record is converted to
    // meet the entry; the entry is never converted to meet the record.
    //
    // ⚠ THE MISSING CHECK COMES FIRST, BEFORE THE CONVERSION. `toCrore` is
    // division, and `null / 1e7` is 0 — not NaN, not an error, a real finite
    // zero. So converting first would hand a company we have never measured to
    // the range as though it were worth nothing, and every range starting at 0
    // would quietly list all 26 of them among companies whose size is known
    // (CLAUDE.md §2.3). Caught by assertion 44 on its first run, which is the
    // whole argument for writing the check before believing the code.
    match: (row, range) => (row.fullMcapInr === null || row.fullMcapInr === undefined
      ? false
      : withinRange(toCrore(row.fullMcapInr), range)),
    describe: (range) => {
      const both = 'inclusive at both ends';
      if (range.min !== null && range.max !== null) {
        return `Market cap ₹${crLabel(range.min)}–${crLabel(range.max)} Cr, ${both}`;
      }
      if (range.min !== null) return `Market cap ₹${crLabel(range.min)} Cr and above, inclusive`;
      return `Market cap up to ₹${crLabel(range.max)} Cr, inclusive`;
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The model banner — which methodology is in force, and what it changes
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The band under the heading that names the active model and prices the choice.
 *
 * It exists because a toggle that silently changes 239 verdicts is a trap. A
 * reader has to be able to see, without clicking anything: which model produced
 * what is on screen, what that model does differently, and HOW MANY ROWS
 * DISAGREE with the other one. The disagreement count is derived from both
 * models on every build — never typed, and never an assurance in prose that a
 * difference exists.
 */
function modelBanner(rows) {
  const id = state.getMethodology();
  const meta = METHODOLOGIES[id];
  const delta = methodologyDelta(rows);
  const cutoffs = modelCutoffs();
  const win = modelWindow();
  const isGimi = id === 'gimi';

  const otherId = isGimi ? 'freefloat' : 'gimi';
  const other = METHODOLOGIES[otherId];

  const chip = (label, value, title) =>
    `<div class="min-w-0 rounded-xl bg-white/70 px-3 py-2 ring-1 ring-inset ${isGimi ? 'ring-indigo-200' : 'ring-slate-200'}"${title ? ` title="${escapeHtml(title)}"` : ''}>`
    + `<div class="break-words text-[10px] font-bold uppercase tracking-wide ${isGimi ? 'text-indigo-700' : 'text-slate-500'}">${escapeHtml(label)}</div>`
    + `<div class="font-display mt-0.5 text-sm font-extrabold tabular-nums text-slate-900">${value}</div></div>`;

  // ---- what this model does differently, in three lines -------------------
  const findings = isGimi
    ? [
      ['Two sizes, both used',
        `Ranked by <strong>full</strong> market cap, counting <strong>free float</strong> to ${escapeHtml(num(cutoffs?.standard.targetPct ?? 85, 0))}% and `
        + `${escapeHtml(num(cutoffs?.imi.targetPct ?? 99, 0))}% coverage; the cutoff is the last counted company's full market cap. `
        + 'Free float is then tested <em>separately</em> against a minimum.'],
      ['Buffers, not a bright line',
        `An existing constituent keeps its segment down to <strong>${escapeHtml(cutoffs?.buffers.lowerLabel ?? '2/3')}</strong>; a non-constituent enters only above `
        + `<strong>${escapeHtml(cutoffs?.buffers.upperLabel ?? '1.5×')}</strong>. Entry is replacement-based, so clearing the bar makes a company eligible, never included.`],
      ['The review is priced a month early',
        win
          ? escapeHtml(win.note)
          : 'The price window could not be derived.'],
    ]
    : [
      ['One size number for two jobs',
        'Free-float market cap decides both whether a company is big enough and which segment it belongs to. '
        + 'MSCI uses full market cap for the second — see the other model.'],
      ['A single line per band',
        'No buffer zone and no hysteresis: a company is above a band or below it.'],
      ['No review timetable',
        'Verdicts are not tied to a price window, so they do not say which review they speak to.'],
    ];

  const body =
    '<div class="flex flex-wrap items-start justify-between gap-4">'
    + '<div class="min-w-0 max-w-3xl">'
    + `<div class="flex items-center gap-2">`
    + `<span class="rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${isGimi ? 'bg-indigo-600 text-white' : 'bg-slate-700 text-white'}">${escapeHtml(meta.short)}</span>`
    + `<span class="text-sm font-bold text-slate-900">${escapeHtml(meta.label)}</span></div>`
    + `<p class="mt-1.5 text-xs leading-relaxed text-slate-600">${escapeHtml(meta.what)}</p>`
    + '<dl class="mt-2.5 space-y-1.5">'
    + findings.map(([title, text]) =>
      '<div class="text-[11px] leading-relaxed">'
      + `<dt class="inline font-semibold ${isGimi ? 'text-indigo-900' : 'text-slate-700'}">${escapeHtml(title)}. </dt>`
      + `<dd class="inline text-slate-600">${text}</dd></div>`).join('')
    + '</dl>'
    + `<p class="mt-2 text-[11px] leading-relaxed text-slate-500"><strong>Attribution.</strong> ${escapeHtml(meta.attribution)}.`
    + (isGimi ? ` ${escapeHtml(CUTOFF_DISCLOSURE)}` : '')
    + '</p>'
    + '</div>'
    + '<div class="grid w-full min-w-0 grid-cols-2 gap-2 sm:w-auto sm:shrink-0 sm:grid-cols-3">'
    + (isGimi && cutoffs
      ? chip('Standard cutoff', cutoffs.standard.cutoffInr === null ? EM_DASH : `${escapeHtml(cr(cutoffs.standard.cutoffInr))}`,
        `Full market cap of ${cutoffs.standard.company?.name ?? 'the last counted company'}, the ${cutoffs.standard.count}th by full market cap, where cumulative free float reaches ${cutoffs.standard.coveragePct?.toFixed(2)}%`)
        + chip('Small-cap floor', cutoffs.imi.cutoffInr === null ? EM_DASH : `${escapeHtml(cr(cutoffs.imi.cutoffInr))}`,
          `Full market cap of ${cutoffs.imi.company?.name ?? 'the last counted company'}, at ${cutoffs.imi.coveragePct?.toFixed(2)}% cumulative free-float coverage`)
        + chip('Min free float', cutoffs.bars.minFreeFloatNew === null ? EM_DASH : `${escapeHtml(cr(cutoffs.bars.minFreeFloatNew))}`,
          'A new constituent must clear half the small-cap cutoff in free float; an incumbent two-thirds of that')
      : '')
    + (delta
      ? chip(`Differ from ${other.short}`, `${escapeHtml(num(delta.changed))} of ${escapeHtml(num(delta.total))}`,
        `${delta.changed} companies carry a different verdict under the other model — derived from both models on this build, not typed`)
      : '')
    + '</div></div>';

  const wrap = el('div', {
    class: 'mb-5 rounded-2xl p-4 ring-1 ' + (isGimi
      ? 'bg-gradient-to-br from-indigo-50 to-white ring-indigo-200'
      : 'bg-slate-50 ring-slate-200'),
  });
  wrap.setAttribute('data-model-banner', id);
  wrap.innerHTML = body;
  return wrap;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Stat strip
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Finding 3 as a card: which review the numbers on screen can speak to.
 *
 * This is the finding with the clearest commercial edge, and it is invisible
 * without it. MSCI prices a review on one of the last ten business days of the
 * PRECEDING month (p. 49), so once that window shuts the outcome is fixed and a
 * price move afterwards is evidence about the review after it. A screen that
 * shows verdicts without saying which review they belong to invites a reader to
 * act on a decision that was already taken.
 */
function reviewWindowCard() {
  const win = modelWindow();
  if (!win) {
    return {
      label: 'Review window',
      value: EM_DASH,
      detail: 'the price window could not be derived',
    };
  }
  const target = win.verdictsAreAbout;
  const line = (label, value, tone = 'slate') =>
    '<div class="flex items-baseline justify-between gap-3 text-[11px]">'
    + `<span class="text-slate-500">${escapeHtml(label)}</span>`
    + `<span class="font-semibold tabular-nums text-${tone}-700">${escapeHtml(value)}</span></div>`;

  return {
    label: 'These verdicts are about',
    value: target.label,
    detail: win.windowClosed
      ? `${win.review.label} is already priced and sealed`
      : `priced on one of ${shortDate(win.windowOpensOn)}–${shortDate(win.windowClosesOn)}`,
    extra:
      line(`${win.review.label} priced`, `${shortDate(win.windowOpensOn)} – ${shortDate(win.windowClosesOn)}`)
      + line('That window', win.windowClosed ? 'shut' : 'still open', win.windowClosed ? 'rose' : 'emerald')
      + (win.followingCutoffs
        ? line(`${target.label} prices`, `${shortDate(win.followingCutoffs.price.from)} – ${shortDate(win.followingCutoffs.price.to)}`)
        : ''),
    help: {
      title: 'The exam was in July; the results come out in August',
      body:
        '<div class="space-y-3 text-sm leading-relaxed text-slate-600">'
        + '<p>We knew when index changes take <em>effect</em>. What MSCI also publishes, plainly, is when they are '
        + '<strong>decided</strong>: the prices behind a review are taken on <strong>one of the last ten business days '
        + 'of the month before the review month</strong> — and MSCI does not say which of the ten.</p>'
        + '<div class="overflow-hidden rounded-xl ring-1 ring-slate-200">'
        + '<table class="w-full text-xs"><thead class="bg-slate-50 text-slate-500">'
        + '<tr><th scope="col" class="px-3 py-1.5 text-left font-bold">Review</th>'
        + '<th scope="col" class="px-3 py-1.5 text-left font-bold">Prices taken</th>'
        + '<th scope="col" class="px-3 py-1.5 text-left font-bold">Takes effect</th></tr></thead><tbody>'
        + [['February', 'last 10 business days of January', 'end of Feb'],
          ['May', 'last 10 business days of April', 'end of May'],
          ['August', 'last 10 business days of July', 'end of Aug'],
          ['November', 'last 10 business days of October', 'end of Nov']]
          .map(([r, p, e]) => `<tr class="border-t border-slate-100"><td class="px-3 py-1.5 font-semibold text-slate-700">${escapeHtml(r)}</td>`
            + `<td class="px-3 py-1.5 text-slate-600">${escapeHtml(p)}</td><td class="px-3 py-1.5 text-slate-600">${escapeHtml(e)}</td></tr>`).join('')
        + '</tbody></table></div>'
        + `<p>${escapeHtml(win.note)}</p>`
        + '<p><strong>An independent check that we read it right.</strong> Elsewhere in the same document MSCI '
        + 'publishes its own August reference table stamped <strong>20 July 2026</strong> — exactly where this '
        + 'calculated window opens. Two unrelated parts of the rulebook agreeing. The verification suite asserts it.</p>'
        + '<p><strong>Why this is commercially useful.</strong> It says when the forecasting is worth the most: the '
        + 'last ten business days of January, April, July and October. Before that you are aiming at a moving '
        + 'target; after it you are reading a sealed envelope.</p>'
        + `<p class="text-xs text-slate-400">${escapeHtml(win.source)}. The prices behind these figures are as of `
        + `${escapeHtml(shortDate(win.priceAsOf))}.</p>`
        + '</div>',
    },
  };
}

function buildStats(scopeRows) {
  const cov = data.coverage();
  const total = cov.companies ?? null;
  const inView = scopeRows.length;

  const withFloatInView = scopeRows.filter((c) => c.freeFloatMcapInr !== null).length;
  const nseInView = scopeRows.filter((c) => c.floatSource === 'nse').length;
  const bseInView = scopeRows.filter((c) => c.floatSource === 'bse').length;
  const noneInView = inView - withFloatInView;
  // How the desk's rule actually landed on the rows in view. Derived from the
  // records, never typed — a hand-written count goes stale on the next refresh.
  const switchedInView = scopeRows.filter((c) => c.floatChoice?.rule === 'nse-preferred-on-material-gap').length;
  const comparableInView = scopeRows.filter((c) => c.floatChoice?.gapPct !== null && c.floatChoice?.gapPct !== undefined).length;
  const switchPct = data.thresholds().floatSourcePreferNseGapPct ?? 2;

  // Verdict counts, derived from the assessments in force — never typed.
  const verdictCounts = {};
  for (const company of scopeRows) {
    const verdict = assessmentFor(company)?.verdict ?? 'unknown';
    verdictCounts[verdict] = (verdictCounts[verdict] ?? 0) + 1;
  }
  const sum = (...keys) => keys.reduce((a, k) => a + (verdictCounts[k] ?? 0), 0);
  const counts = {
    inclusion: sum('likely-inclusion', 'possible-inclusion'),
    exclusion: sum('exclusion-risk', 'likely-exclusion'),
    migration: sum('migration-up', 'migration-down'),
    unknown: sum('unknown'),
  };

  const fundLines = FUND_ORDER.map((id) => {
    const f = data.fundCoverage(id);
    if (!f) return '';
    return (
      '<div class="flex items-baseline justify-between gap-3 text-xs">' +
      `<span class="font-semibold text-slate-700">${escapeHtml(f.shortName)}</span>` +
      `<span class="tabular-nums text-slate-500">${escapeHtml(num(f.withFloat))} of ${escapeHtml(num(f.holdings))} holdings · ` +
      `${escapeHtml(pct(f.weightWithFloat, 2))} of ${escapeHtml(pct(f.indiaWeightPct, 2))} India weight</span></div>`
    );
  }).join('');

  /** A compact label/value line inside a stat card. Both sides derived. */
  const cardRow = (label, value, tone = 'slate') =>
    '<div class="flex items-baseline justify-between gap-3 text-[11px]">' +
    `<span class="${tone === 'white' ? 'text-white/80' : 'text-slate-500'}">${escapeHtml(label)}</span>` +
    `<span class="font-semibold tabular-nums ${tone === 'white' ? 'text-white' : 'text-slate-700'}">${escapeHtml(value)}</span></div>`;

  return statStrip([
    {
      label: 'Companies in view',
      value: total === null ? num(inView) : `${num(inView)} of ${num(total)}`,
      detail: 'Every company in the record, held or not',
      extra:
        cardRow('Held by a fund', num(cov.held)) +
        cardRow('Candidates, not held', num(cov.notHeld)),
      help: {
        title: 'What "in view" counts',
        body:
          '<div class="space-y-3 text-sm leading-relaxed text-slate-600">' +
          `<p>The record holds <strong>${escapeHtml(num(total))}</strong> companies, and the table shows all of them.</p>` +
          `<p><strong>${escapeHtml(num(cov.held))}</strong> are held by at least one fund — what must be traded if index weights move.</p>` +
          `<p>The other <strong>${escapeHtml(num(cov.notHeld))}</strong> sit above the desk's size floor and no fund owns them yet — what could enter at a future review. They are shown by default because they are what an inclusion forecast is about.</p>` +
          '<p class="text-xs text-slate-400">Both counts come from the build that produced the data, not from anything typed here.</p>' +
          '</div>',
      },
    },
    ...(() => {
      // ---- how the tracked segments themselves have moved ----------------
      // The desk's bands are absolute rupee figures and MSCI's cut-offs are not,
      // so the segment's own move is what decides whether a company is really
      // getting closer to a cut-off or just floating up with everything else.
      // It is a card rather than a footnote because it moves verdicts.
      //
      // ONLY UNDER THE FREE-FLOAT MODEL. The GIMI cutoffs are re-derived from
      // the universe on every build, so they already move with the market —
      // floating them again by a segment return would apply the correction
      // twice. Under that model this slot carries the review window instead,
      // which is the thing GIMI knows and the other model does not.
      if (state.getMethodology() === 'gimi') return [reviewWindowCard()];
      const b = data.benchmarks();
      if (!b || !b.funds?.length) return [];
      const since = b.lastReview?.label ?? 'the last review';
      // Each row says what its benchmark is FOR. Four returns listed side by side
      // with nothing distinguishing them would present EEM's mostly-not-India
      // move and INDA's Standard-segment move as two values of one thing — the
      // confusion that put the wrong one in the band adjustment to begin with.
      const SEGMENT_LABEL = { standard: 'Standard segment', smallcap: 'Small Cap segment' };
      const line = (f) => {
        const r = f.sinceLastReview?.inrPct;
        if (r === null || r === undefined) return '';
        const tone = r >= 0 ? 'text-emerald-700' : 'text-rose-700';
        const role = f.standsForSegment
          ? `<span class="text-[10px] font-medium text-indigo-700">${escapeHtml(SEGMENT_LABEL[f.standsForSegment] ?? f.standsForSegment)}</span>`
          : `<span class="text-[10px] text-slate-400" title="${escapeHtml(`${f.symbol} is ${f.indiaWeightPct}% India, so its return is mostly about somewhere else. It sizes this fund's flows; it does not stand for an Indian segment.`)}">holdings only · ${escapeHtml(String(f.indiaWeightPct ?? '—'))}% India</span>`;
        return '<div class="flex items-baseline justify-between gap-3 text-xs">'
          + `<span class="flex items-baseline gap-1.5"><span class="font-semibold text-slate-700">${escapeHtml(f.symbol)}</span>${role}</span>`
          + `<span class="tabular-nums ${tone}">${escapeHtml(signedPct(r, 2))} <span class="text-slate-400">in ₹</span></span></div>`;
      };
      const smin = b.funds.find((f) => f.fundId === 'smin');
      const headline = smin?.sinceLastReview?.inrPct ?? b.funds[0]?.sinceLastReview?.inrPct ?? null;
      return [{
        label: 'Segment move since ' + since,
        value: headline === null ? '—' : signedPct(headline, 2),
        detail: smin ? 'India Small-Cap, in rupees' : 'in rupees',
        extra: b.funds.map(line).join(''),
        help: {
          title: 'Why the index move changes a verdict',
          body:
            '<div class="space-y-3 text-sm leading-relaxed text-slate-600">'
            + '<p>The desk works to fixed rupee bands — <strong>₹3,500–4,000 Cr</strong> for inclusion, '
            + '<strong>₹2,000–2,400 Cr</strong> for exclusion. MSCI\'s real cut-offs are not fixed: they are '
            + 'derived from the investable universe <em>at each review</em>, so the bar rises with a rising '
            + 'market and falls with a falling one.</p>'
            + '<p>So a company whose free float grew 4% in a segment that grew 12% has become '
            + '<strong>relatively smaller</strong> — closer to exclusion, not further from it. A fixed rupee '
            + 'band cannot see that at all. Each band is therefore floated by its segment\'s own price return '
            + `since ${escapeHtml(since)}.</p>`
            + '<div class="space-y-1.5 rounded-xl bg-slate-50 p-3">'
            + b.funds.map((f) => '<div class="flex justify-between text-xs">'
              + `<span class="font-semibold text-slate-700">${escapeHtml(f.symbol)}</span>`
              + `<span class="tabular-nums text-slate-600">${escapeHtml(signedPct(f.sinceLastReview?.inrPct, 2))} in ₹ · `
              + `${escapeHtml(signedPct(f.sinceLastReview?.usdPct, 2))} in $</span></div>`).join('')
            + '</div>'
            + '<p><strong>The rupee figure is the one that matters.</strong> These funds trade in dollars, so '
            + 'their quoted return folds in the INR/USD move — over the year to 20 Aug 2026 that was worth 9 to '
            + '13 percentage points and flipped SMIN\'s sign from −3.62% to +5.44%. A free-float market cap is '
            + 'in rupees, so the comparison has to be too.</p>'
            + `<p class="text-xs text-slate-500">${escapeHtml(b.note)} ${escapeHtml(b.returnBasis)} `
            + `The adjustment is ${escapeHtml(b.adjustment.attribution)}</p>`
            + '</div>',
        },
      }];
    })(),
    {
      label: 'Free-float coverage',
      value: `${num(withFloatInView)} of ${num(inView)}`,
      detail: `have a reading${noneInView > 0 ? ` · ${num(noneInView)} without` : ''}`,
      extra:
        cardRow('From BSE (primary)', num(bseInView)) +
        cardRow('From NSE', num(nseInView)) +
        cardRow('No reading', num(noneInView)),
      help: {
        title: 'Where free float comes from',
        body:
          '<div class="space-y-3 text-sm leading-relaxed text-slate-600">' +
          '<p>Free-float market cap is an <strong>exchange-published figure</strong>. It is never computed from promoter holding — lock-in shares held by VCs and PE firms are not promoter holdings but are not free float either, and the global indices follow the exchanges.</p>' +
          '<div class="space-y-1.5 rounded-xl bg-slate-50 p-3">' +
          `<div class="flex justify-between text-xs"><span class="font-semibold text-slate-700">From BSE</span><span class="tabular-nums text-slate-600">${escapeHtml(num(bseInView))} of ${escapeHtml(num(inView))} in view</span></div>` +
          `<div class="flex justify-between text-xs"><span class="font-semibold text-slate-700">From NSE</span><span class="tabular-nums text-slate-600">${escapeHtml(num(nseInView))} of ${escapeHtml(num(inView))} in view</span></div>` +
          `<div class="flex justify-between text-xs"><span class="font-semibold text-slate-700">No reading</span><span class="tabular-nums text-slate-600">${escapeHtml(num(noneInView))} of ${escapeHtml(num(inView))} in view</span></div>` +
          '</div>' +
          `<p><strong>BSE is the primary source</strong>, because it is the only one that covers the whole listed universe — NSE publishes free float for around 250 names. Where NSE <em>also</em> publishes and the two differ by more than <strong>${escapeHtml(num(switchPct, 0))}%</strong>, NSE's figure is used instead, because MSCI is understood to follow NSE. Where BSE has no reading at all, NSE is the source.</p>` +
          `<div class="space-y-1.5 rounded-xl bg-indigo-50/70 p-3 ring-1 ring-indigo-100">` +
          `<div class="flex justify-between text-xs"><span class="font-semibold text-indigo-900">Both exchanges publish</span><span class="tabular-nums text-indigo-800">${escapeHtml(num(comparableInView))} of ${escapeHtml(num(inView))} in view</span></div>` +
          `<div class="flex justify-between text-xs"><span class="font-semibold text-indigo-900">Switched to NSE on a gap over ${escapeHtml(num(switchPct, 0))}%</span><span class="tabular-nums text-indigo-800">${escapeHtml(num(switchedInView))} of ${escapeHtml(num(comparableInView))}</span></div>` +
          '</div>' +
          `<p>The ${escapeHtml(num(switchPct, 0))}% switch point is <strong>the desk's own rule</strong>. Neither exchange publishes it and neither does MSCI. The two apply slightly different float definitions and genuinely disagree, so they are never averaged — where both exist, both stay on the company record and the drill panel names the rule that chose between them.</p>` +
          '<p>A company with no reading is <strong>not a company with no float</strong>. It renders as an em dash, is excluded from every total, and never sorts as zero.</p>' +
          '</div>',
      },
    },
    {
      label: 'Review outlook',
      value: `${num(counts.inclusion)} · ${num(counts.exclusion)} · ${num(counts.migration)}`,
      detail: `inclusion candidates · exclusion risks · migrations, of ${num(inView)} in view`,
      extra:
        cardRow('Inclusion candidates', num(counts.inclusion)) +
        cardRow('Exclusion risks', num(counts.exclusion)) +
        cardRow('Migrations', num(counts.migration)) +
        cardRow('Unknown (input not trusted)', num(counts.unknown)),
      help: {
        title: 'What these verdicts are, and are not',
        body:
          '<div class="space-y-3 text-sm leading-relaxed text-slate-600">' +
          `<p><strong>${escapeHtml(DISCLOSURE)}</strong></p>` +
          '<p>The requirement asked for a probability of inclusion or exclusion. We cannot honestly print one. ' +
          'A probability needs a base rate, and a base rate needs history — past reviews, what MSCI\'s cut-off ' +
          'actually was each time, and which companies at which distances were added or dropped. This build holds ' +
          'one holdings file per fund, dated ' + escapeHtml(shortDate(data.freshness().feeds.find((f) => f.id === 'ishares')?.date)) + '. ' +
          '"68% likely" would be invented precision, and it would be the one number here a reader could not check.</p>' +
          '<p>So each verdict is a <strong>label on a rule</strong>. Open any row to see every rule that fired, its input, ' +
          'its threshold, and where that threshold came from.</p>' +
          '<div class="space-y-1.5 rounded-xl bg-slate-50 p-3">' +
          Object.keys(VERDICTS)
            .filter((k) => verdictCounts[k])
            .map((k) => `<div class="flex justify-between gap-3 text-xs"><span class="font-semibold text-slate-700">${escapeHtml(VERDICTS[k].label)}</span><span class="tabular-nums text-slate-600">${escapeHtml(num(verdictCounts[k]))} of ${escapeHtml(num(inView))}</span></div>`)
            .join('') +
          '</div>' +
          `<p class="text-xs text-slate-400">Two thresholds produce these, and they are not the same thing. The desk's bands ` +
          `(${escapeHtml(REVIEW_THRESHOLDS.inclusion.label)}, ${escapeHtml(REVIEW_THRESHOLDS.exclusion.label)}) decide index ENTRY and EXIT; ` +
          `the observed constituent boundary decides which SEGMENT a company belongs in. MSCI does not publish its size cut-offs in advance.</p>` +
          '</div>',
      },
    },
  ]);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Drill panel
 * ──────────────────────────────────────────────────────────────────────────── */

const drillSection = (title, body) =>
  '<section class="mb-5">' +
  `<h3 class="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">${escapeHtml(title)}</h3>` +
  body +
  '</section>';

const drillRow = (label, value, { title } = {}) =>
  '<div class="flex items-baseline justify-between gap-4 border-b border-slate-50 py-1.5 last:border-0">' +
  `<dt class="shrink-0 text-xs text-slate-500"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}</dt>` +
  `<dd class="min-w-0 text-right text-[13px] font-semibold tabular-nums text-slate-900">${value}</dd></div>`;

function floatSectionHtml(company) {
  const both = company.floatFactorNse !== null && company.floatFactorBse !== null;
  const gapPp = both ? (company.floatFactorNse - company.floatFactorBse) * 100 : null;
  const gapPct =
    both && company.floatFactorBse
      ? ((company.floatFactorNse - company.floatFactorBse) / company.floatFactorBse) * 100
      : null;
  const wide = gapPct !== null && Math.abs(gapPct) > (data.thresholds().floatFactorDisagreementReviewPct ?? 5);

  const view = liveView(company);

  let html =
    '<dl class="rounded-xl bg-slate-50/70 p-3">' +
    drillRow(
      'Free-float market cap',
      view.freeFloatMcapInr === null
        ? missing('no free-float reading from either exchange')
        : `${escapeHtml(inr(view.freeFloatMcapInr))} ${priceChip(view)}`,
    ) +
    drillRow(
      'Price in force',
      view.price === null
        ? missing('no price from any source')
        : `${escapeHtml(num(view.price, 2))} <span class="text-[10px] font-normal text-slate-500">${escapeHtml(view.exchange ?? '')}${view.priceDate ? ` · ${shortDate(view.priceDate)}` : ' · live'}</span>`,
      { title: view.live ? 'Live NSE quote this session' : 'Committed BSE closing price' },
    ) +
    (view.staleDays > 0
      ? drillRow(
          'Price is carried forward',
          `<span class="text-amber-700">${escapeHtml(String(view.staleDays))} day(s)</span>`,
          { title: 'This stock did not trade. Its last close is carried forward — that is not the same as unchanged.' },
        )
      : '') +
    drillRow(
      'Published at capture',
      company.freeFloatMcapAtCaptureInr === null
        ? missing('no published figure on record')
        : escapeHtml(inr(company.freeFloatMcapAtCaptureInr)),
      { title: 'What the exchange published when the float file was last captured, kept beside the recomputed figure for comparison' },
    ) +
    drillRow(
      'Factor in force',
      company.floatFactor === null
        ? missing('published free-float market cap; no factor derivable')
        : `${escapeHtml(factorPct(company.floatFactor))} ${sourceChip(company.floatSource)}`,
    ) +
    drillRow('Full market cap', company.fullMcapInr === null ? missing('no full market cap from BSE') : escapeHtml(inr(company.fullMcapInr))) +
    '</dl>';

  if (both) {
    html +=
      '<div class="mt-3 grid grid-cols-2 gap-2">' +
      '<div class="rounded-xl bg-indigo-50/70 p-3 ring-1 ring-indigo-100">' +
      '<div class="text-[10px] font-bold uppercase tracking-wide text-indigo-700">NSE factor</div>' +
      `<div class="font-display mt-1 text-lg font-extrabold tabular-nums text-slate-900">${escapeHtml(factorPct(company.floatFactorNse))}</div></div>` +
      '<div class="rounded-xl bg-purple-50/70 p-3 ring-1 ring-purple-100">' +
      '<div class="text-[10px] font-bold uppercase tracking-wide text-purple-700">BSE factor</div>' +
      `<div class="font-display mt-1 text-lg font-extrabold tabular-nums text-slate-900">${escapeHtml(factorPct(company.floatFactorBse))}</div></div>` +
      '</div>' +
      `<p class="mt-2 rounded-xl ${wide ? 'bg-amber-50 text-amber-900 ring-1 ring-amber-200' : 'bg-slate-50 text-slate-600'} p-3 text-xs leading-relaxed">` +
      `<strong>Gap: ${escapeHtml(num(gapPp, 2))} pp</strong> (${escapeHtml(num(gapPct, 2))}% relative to BSE). ` +
      (wide
        ? 'That is beyond the level the desk treats as an ordinary definitional difference, so this row is worth a look before you trust it — it is more likely a share count one exchange has updated and the other has not than a genuine disagreement about float.'
        : 'The two exchanges apply slightly different float definitions, so a gap of around this size is expected and normal.') +
      ' Neither figure is averaged into the other.</p>';
  }

  // ---- WHICH source is in force, and by which rule ------------------------
  // The choice is a judgement made by a rule the desk wrote, not a measurement,
  // so the rule that fired, the threshold it used and whose threshold it is all
  // appear here rather than only in the build script.
  if (company.floatChoice) {
    const chose = company.floatChoice.chose === 'nse' ? 'NSE' : 'BSE';
    const switched = company.floatChoice.rule === 'nse-preferred-on-material-gap';
    html +=
      `<p class="mt-2 rounded-xl ${switched ? 'bg-indigo-50 text-indigo-900 ring-1 ring-indigo-200' : 'bg-slate-50 text-slate-600'} p-3 text-xs leading-relaxed">` +
      `<span class="font-semibold">Source in force: ${escapeHtml(chose)}.</span> ` +
      `${escapeHtml(company.floatChoice.why)}. ` +
      '<span class="text-slate-500">The rule is the desk\'s own — BSE is primary, NSE is used where the two differ by more than ' +
      `${escapeHtml(String(company.floatChoice.thresholdPct))}% and wherever BSE has no reading. ` +
      'Neither exchange nor MSCI publishes this switch point.</span></p>';
  }

  if (!both && company.floatSource && !company.floatChoice) {
    html +=
      '<p class="mt-2 rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">' +
      `Only ${company.floatSource === 'nse' ? 'NSE' : 'BSE'} publishes a reading for this company, so there is nothing to compare it against.</p>`;
  }

  // A company on the desk's screen that neither exchange can price, with the
  // reason stated. An em dash with no explanation reads as a fact about the
  // company rather than a gap in our sources.
  if (company.noBseReason) {
    html +=
      '<p class="mt-2 rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">' +
      `<span class="font-semibold">No BSE record.</span> ${escapeHtml(company.noBseReason)}</p>`;
  }

  if (company.freeFloatBasis) {
    html +=
      '<p class="mt-2 text-[11px] leading-relaxed text-slate-500">' +
      `<span class="font-semibold text-slate-700">How this figure was produced:</span> ${escapeHtml(company.freeFloatBasis)}.</p>`;
  }
  return html;
}

function fundsSectionHtml(company) {
  const blocks = FUND_ORDER.map((id) => {
    const holding = company.funds?.[id];
    if (!holding) return '';
    const cov = data.fundCoverage(id);
    const label = cov?.shortName ?? id;
    return (
      '<div class="mb-2 rounded-xl bg-slate-50/70 p-3 last:mb-0">' +
      `<div class="mb-1.5 flex items-center gap-2">${fundChip(id, label)}` +
      `<span class="text-[11px] text-slate-500">weight is a percentage of this fund only</span></div>` +
      '<dl>' +
      drillRow(`Weight in ${label}`, escapeHtml(pct(holding.weightPct, 5))) +
      drillRow('Quantity', escapeHtml(num(holding.quantity))) +
      drillRow('Market value', escapeHtml(`$${num(holding.marketValueUsd, 0)}`)) +
      '</dl></div>'
    );
  }).join('');

  if (!blocks) {
    return (
      '<p class="rounded-xl bg-slate-50/70 p-3 text-xs leading-relaxed text-slate-600">' +
      'No fund holds this company. It is in the record because it clears the desk\'s size floor, which makes it a candidate for a future review rather than a current position.</p>'
    );
  }

  return (
    blocks +
    '<p class="mt-2 text-[11px] leading-relaxed text-slate-500">' +
    'Each weight above is a percentage of its own fund. The funds have different denominators, so these numbers cannot be summed, averaged or ranked against one another.</p>'
  );
}

/**
 * Weight drift, per fund.
 *
 * The wording matters as much as the number. A weight that rose on price alone
 * requires NO trade: the fund's holding gained value in exactly the proportion
 * the weight did. This block says so in those words, every time, because the
 * obvious reading of a rising weight is the wrong one.
 */
/**
 * The Assessment section — the verdict, then the whole derivation.
 *
 * The rules table is the point. A verdict with no visible working is an opinion
 * dressed as a measurement, and this is the one tier of number on the dashboard
 * a reader cannot check against an exchange. So every rule that fired shows its
 * input, its threshold, and WHOSE threshold it was.
 */
function assessmentSectionHtml(company) {
  const assessment = assessmentFor(company);
  if (!assessment) return '<p class="text-xs text-slate-500">Not yet assessed.</p>';

  const meta = VERDICTS[assessment.verdict] ?? VERDICTS.unknown;
  const review = nextReview();
  const activeId = state.getMethodology();
  const active = METHODOLOGIES[activeId];
  const otherId = activeId === 'gimi' ? 'freefloat' : 'gimi';

  let html =
    '<div class="rounded-xl bg-slate-50/70 p-3">'
    + '<div class="mb-2 flex items-center gap-1.5">'
    + `<span class="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${activeId === 'gimi' ? 'bg-indigo-600 text-white' : 'bg-slate-700 text-white'}">${escapeHtml(active.short)}</span>`
    + `<span class="text-[10px] text-slate-500">${escapeHtml(active.attribution)}</span></div>`
    + `<div class="flex items-center gap-2">${verdictPill(assessment.verdict)}`
    + `<span class="text-xs text-slate-600">${escapeHtml(meta.detail)}</span></div>`;

  // ---- WHAT THE OTHER MODEL SAYS ABOUT THIS SAME COMPANY -----------------
  // On a screen with two methodologies, the single most useful thing a drill
  // panel can show is where they disagree — and on which of the two size
  // numbers the disagreement turns. Agreement is stated too: "both models
  // agree" is information, and leaving it out would make the block look like it
  // only ever appears when something is wrong.
  const other = otherAssessmentFor(company);
  if (other) {
    const differs = other.verdict !== assessment.verdict;
    const otherMeta = METHODOLOGIES[otherId];
    html +=
      `<div class="mt-2.5 rounded-lg p-2.5 ${differs ? 'bg-amber-50 ring-1 ring-amber-200' : 'bg-white ring-1 ring-slate-200'}">`
      + `<div class="text-[10px] font-bold uppercase tracking-wide ${differs ? 'text-amber-800' : 'text-slate-500'}">`
      + `${differs ? 'The other model disagrees' : 'Both models agree'}</div>`
      + '<div class="mt-1 flex items-center gap-2">'
      + verdictPill(other.verdict)
      + `<span class="text-[11px] text-slate-600">under ${escapeHtml(otherMeta.short)}</span></div>`
      + (differs
        ? '<p class="mt-1.5 text-[11px] leading-relaxed text-amber-900">'
          + `${escapeHtml(otherMeta.label)} reaches a different conclusion on this company. Switch the model `
          + 'toggle at the top to see which rules fire there — the two use different size numbers and '
          + 'different bars, so a disagreement is a real difference of method, not a bug.</p>'
        : '')
      + '</div>';
  }

  if (company.shareCountQuarantine) {
    html +=
      '<p class="mt-2 rounded-lg bg-amber-50 p-2.5 text-[11px] leading-relaxed text-amber-900 ring-1 ring-amber-200">'
      + '<strong>Share count quarantined.</strong> '
      + escapeHtml(company.shareCountQuarantine.reason)
      + ' Free-float market cap is floatFactor × sharesOutstanding × price, so every threshold comparison '
      + 'below it would rest on a number we do not trust. No verdict is offered rather than a confident wrong one.</p>';
  }

  // A distance is meaningless without the number it is a distance FROM, and the
  // threshold that decided a verdict is different on almost every row. So the
  // threshold and its value are stated here rather than left to the rules table
  // below — the sentence has to stand on its own.
  if (assessment.distancePct !== null) {
    // THE RULE THE DISTANCE WAS ACTUALLY MEASURED AGAINST, named by the model
    // rather than assumed to be the last one pushed. LIC is the case that
    // proved it matters: its verdict turns on the FIF floor while the last rule
    // recorded is about free float, so "the last rule" paired a real percentage
    // with an unrelated threshold.
    const rule = assessment.rulesFired.find((r) => r.key === assessment.distanceRuleKey)
      ?? assessment.rulesFired[assessment.rulesFired.length - 1];
    const fmtThreshold = (v) => (rule.unit === 'factor' ? factorPct(v) : rule.unit === 'rank' ? num(v) : inr(v));
    const against = rule && rule.threshold !== null && rule.threshold !== undefined
      ? `${escapeHtml(rule.label)} — ${escapeHtml(fmtThreshold(rule.threshold))}`
      : null;

    // The measured quantity differs by rule, not just by model: GIMI compares
    // full market cap for size, free float for the minimum, and a ratio for the
    // FIF floor. Naming the wrong one misattributes the number a reader acts on.
    const measured = rule.unit === 'factor'
      ? 'The float factor'
      : assessment.methodology === 'gimi'
        ? (/free-float|min-free-float/.test(rule.key) ? 'Free float' : 'Full market cap')
        : 'Free float';
    html += '<p class="mt-2 text-xs leading-relaxed text-slate-600">'
      + `${escapeHtml(measured)} is <strong class="tabular-nums">`
      + `${escapeHtml(signedPct(assessment.distancePct))}</strong> `
      + (against
        ? `from the threshold this verdict turned on: ${against}.`
        : 'from the threshold this verdict turned on.')
      + ' <span class="text-slate-500">Each verdict is measured against its own threshold, so this '
      + 'percentage is not comparable with another company\'s unless both turned on the same rule.</span></p>';
  }
  html += '</div>';

  // ---- the rules ----
  if (assessment.rulesFired.length) {
    html +=
      '<div class="mt-3 overflow-hidden rounded-xl ring-1 ring-slate-100">'
      + '<table class="w-full text-left text-[11px]"><thead class="bg-slate-50"><tr>'
      + '<th scope="col" class="px-2 py-1.5 font-bold uppercase tracking-wide text-slate-500">Rule</th>'
      + '<th scope="col" class="px-2 py-1.5 text-right font-bold uppercase tracking-wide text-slate-500">Input</th>'
      + '<th scope="col" class="px-2 py-1.5 text-right font-bold uppercase tracking-wide text-slate-500">Threshold</th>'
      + '<th scope="col" class="px-2 py-1.5 font-bold uppercase tracking-wide text-slate-500">Source</th>'
      + '<th scope="col" class="px-2 py-1.5 font-bold uppercase tracking-wide text-slate-500">Result</th>'
      + '</tr></thead><tbody>';
    for (const rule of assessment.rulesFired) {
      // FORMAT BY THE RULE'S OWN UNIT, never by guessing from its key. This
      // model compares rupees, ranks and a dimensionless ratio; rendering
      // MSCI's FIF floor of 0.15 as "₹0 Cr" is not a rounding artefact, it is a
      // different number.
      const fmt = (v) => {
        if (v === null || v === undefined) return '—';
        if (rule.unit === 'rank') return num(v);
        if (rule.unit === 'factor') return factorPct(v);
        return `₹${cr(v)} Cr`;
      };
      const source = THRESHOLD_SOURCE[rule.thresholdSource];
      html +=
        '<tr class="border-t border-slate-50">'
        + `<td class="px-2 py-1.5 text-slate-700">${escapeHtml(rule.label)}</td>`
        + `<td class="px-2 py-1.5 text-right tabular-nums text-slate-900">${escapeHtml(fmt(rule.input))}</td>`
        + `<td class="px-2 py-1.5 text-right tabular-nums text-slate-900">${escapeHtml(fmt(rule.threshold))}</td>`
        + `<td class="px-2 py-1.5 text-slate-500"${source ? ` title="${escapeHtml(source.detail)}"` : ''}>${escapeHtml(source?.label ?? rule.thresholdSource)}</td>`
        + `<td class="px-2 py-1.5 font-semibold text-slate-700">${escapeHtml(rule.result)}</td>`
        + '</tr>';
      if (rule.note) {
        html += `<tr class="border-t border-slate-50"><td colspan="5" class="px-2 pb-1.5 text-[10px] leading-relaxed text-slate-400">${escapeHtml(rule.note)}</td></tr>`;
      }
      // A floated threshold must never render as a bare number: the reader has
      // to see the desk's raw band, the segment move that shifted it, and where
      // the bar actually landed. Otherwise a tier-3 adjustment reads as a fact.
      if (rule.band?.applied) {
        const raw = rule.key.startsWith('entry-')
          ? (rule.key === 'entry-upper-band' ? rule.band.rawInclusion?.highInr : rule.band.rawInclusion?.lowInr)
          : (rule.key === 'exclusion-lower-band' ? rule.band.rawExclusion?.lowInr : rule.band.rawExclusion?.highInr);
        html +=
          '<tr class="border-t border-slate-50"><td colspan="5" class="px-2 pb-1.5 text-[10px] leading-relaxed text-indigo-700">'
          + `Desk band <span class="tabular-nums">₹${escapeHtml(cr(raw))} Cr</span>, floated to `
          + `<span class="tabular-nums font-semibold">₹${escapeHtml(cr(rule.threshold))} Cr</span> — `
          + escapeHtml(rule.band.reason)
          + '.</td></tr>';
      }
    }
    html += '</tbody></table></div>';

    const floated = assessment.rulesFired.find((r) => r.band);
    if (floated?.band) {
      const b = floated.band;
      html +=
        `<p class="mt-2 rounded-xl ${b.applied ? 'bg-indigo-50 text-indigo-900 ring-1 ring-indigo-200' : 'bg-slate-50 text-slate-600'} p-3 text-[11px] leading-relaxed">`
        + `<strong>${b.applied ? 'Bands floated by the segment' : 'Bands not floated'}.</strong> `
        + 'The desk\'s rupee bands are fixed; MSCI derives its size cut-offs from the investable '
        + 'universe at each review, so the real bar moves with the market. '
        + escapeHtml(b.reason.charAt(0).toUpperCase() + b.reason.slice(1))
        + '. <span class="opacity-70">The move is the tracking fund\'s price return in rupees — the '
        + 'dollar figure would be wrong by several points because these funds quote in USD. This is '
        + 'the desk\'s own adjustment against an ETF proxy, not MSCI\'s arithmetic.</span></p>';
    }
  }

  // ---- the flows ----
  const { flows, notSampled, shape } = flowsFor(company);
  if (flows.length || notSampled.length) {
    html += `<h4 class="mt-4 mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">Estimated flow${shape === 'migration' ? ' — a migration is two flows, never netted' : ''}</h4>`;
    for (const flow of flows) {
      const buying = flow.direction === 'buy';
      html +=
        `<div class="mb-2 rounded-xl p-3 ring-1 ${buying ? 'bg-emerald-50/60 ring-emerald-100' : 'bg-rose-50/60 ring-rose-100'}">`
        + `<div class="mb-1.5 flex items-center gap-2">${fundChip(flow.fundId, flow.fundShortName)}`
        + `<span class="text-[11px] font-bold uppercase tracking-wide ${buying ? 'text-emerald-700' : 'text-rose-700'}">${buying ? 'buys' : 'sells'}</span>`
        + `<span class="ml-auto text-[10px] text-slate-500">${escapeHtml(flow.certainty === 'measured-position' ? 'position size measured' : 'target weight estimated')}</span></div>`
        + '<dl>'
        + drillRow('Flow', `<span class="${buying ? 'text-emerald-700' : 'text-rose-700'}">${escapeHtml(inrFlow(flow.flowInr))}</span>`)
        + drillRow('Shares', flow.flowShares === null ? missing('no price, so no share count') : escapeHtml(count(Math.abs(flow.flowShares))))
        + drillRow(
            'Days of volume',
            flow.daysOfAdv === null
              ? missing('no average daily volume on record — this is not zero days')
              : `${escapeHtml(num(flow.daysOfAdv, 2))} days`,
            { title: flow.advSource ? `Average daily volume from ${flow.advSource}` : '' },
          )
        + drillRow('Target weight', `${escapeHtml(num(flow.targetWeightPp, 5))} pp`)
        + '</dl>'
        + `<p class="mt-1.5 text-[10px] leading-relaxed text-slate-500">${escapeHtml(flow.basis.formula)}`
        + (flow.basis.numeratorInr
            ? ` — ₹${num(Math.round(toCrore(flow.basis.numeratorInr)))} Cr of ₹${num(Math.round(toCrore(flow.basis.denominatorInr)))} Cr across ${num(flow.basis.denominatorMembers)} ${SEGMENTS[flow.basis.segment]?.label ?? flow.basis.segment} members`
            : '')
        + `. ${escapeHtml(flow.fundShortName)} AUM $${num(flow.aumUsd / 1e9, 2)} bn as of ${escapeHtml(shortDate(flow.aumAsOf))}, at ${escapeHtml(num(flow.fxRate, 5))} ₹/$.`
        + (flow.note ? ` ${escapeHtml(flow.note)}` : '')
        + '</p></div>';
    }
    for (const skipped of notSampled) {
      html +=
        '<div class="mb-2 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-100">'
        + `<div class="mb-1 flex items-center gap-2">${fundChip(skipped.fundId, skipped.fundShortName)}`
        + '<span class="text-[11px] font-bold uppercase tracking-wide text-slate-500">not sampled</span></div>'
        + `<p class="text-[11px] leading-relaxed text-slate-600">${escapeHtml(skipped.reason)}</p></div>`;
    }
  } else if (assessment.verdict === 'stable') {
    html +=
      '<p class="mt-3 rounded-xl bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">'
      + 'No rule fired, so nothing here implies a trade and no rupee figure is produced. '
      + 'A weight that has drifted on price alone is shown below and requires no trade either.</p>';
  }

  html +=
    '<p class="mt-3 rounded-xl bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-900 ring-1 ring-amber-200">'
    + `<strong>${escapeHtml(DISCLOSURE)}</strong>`
    + (review ? ` Aimed at the next review, <strong>${escapeHtml(review.label)}</strong> — effective ${escapeHtml(review.effectiveDate)}, ${escapeHtml(num(review.daysRemaining))} days away.` : '')
    + '</p>';

  // ---- the price window MSCI actually decides on ------------------------
  // The single most misleading thing this screen could do is imply that today's
  // price decides the next review. It does not: MSCI strikes the deciding market
  // caps in the month BEFORE the review month, on one of ten business days it
  // does not name. Every verdict above is computed on today's price, which is
  // the right basis for "where does this company stand now" and the wrong basis
  // for "what will MSCI conclude" once that window has closed.
  if (review) {
    const cut = reviewCutoffs(review.year, review.month);
    const windowClosed = new Date().toISOString().slice(0, 10) > cut.price.to;
    html +=
      `<p class="mt-2 rounded-xl ${windowClosed ? 'bg-rose-50 text-rose-900 ring-1 ring-rose-200' : 'bg-slate-50 text-slate-600'} p-3 text-[11px] leading-relaxed">`
      + `<strong>MSCI's price window for ${escapeHtml(review.label)}: `
      + `${escapeHtml(shortDate(cut.price.from))} – ${escapeHtml(shortDate(cut.price.to))}.</strong> `
      + 'MSCI strikes the market caps that decide a review on one of the last ten business days of '
      + 'the preceding month, and does not publish which day it picked. '
      + (windowClosed
        ? '<strong>That window has closed.</strong> The verdicts above are computed on today\'s price, '
          + 'so they describe where each company stands now — not the snapshot MSCI has already taken.'
        : 'Verdicts above are computed on today\'s price, which will keep moving until that window opens.')
      + ` <span class="opacity-70">Universe cutoff ${escapeHtml(shortDate(cut.equityUniverse))}, liquidity cutoff `
      + `${escapeHtml(shortDate(cut.liquidity))}. ${escapeHtml(cut.source)}.</span></p>`;
  }

  return html;
}

/**
 * The since-rebalance section: the three legs the columns show, the sensitivity
 * test behind the direction, and the flow pressure that follows from it.
 *
 * This is the desk's baseline. The section below it measures MSCI's own price
 * windows and is a different number — the two are kept apart on purpose, with
 * each naming its own window, because on this record they disagree about the
 * sign for 27.8% of companies.
 */
function rebaseSectionHtml(company) {
  const context = data.rebalanceBaselines();
  if (!context) {
    return '<p class="rounded-xl bg-slate-50/70 p-3 text-xs leading-relaxed text-slate-600">'
      + 'No rebalance baseline is on the record, so no since-rebalance return can be measured for any '
      + 'company. Run <code>fetch-price-history.mjs</code> and <code>fetch-corporate-actions.mjs</code>.</p>';
  }
  const active = activeBaseline();
  const meta = data.baselineMeta(active);
  const reading = rebaseFor(company);
  const band = context.bandPct;

  const windowLine =
    '<p class="mb-2 text-[11px] leading-relaxed text-slate-600">Measured from '
    + `<strong>${escapeHtml(shortDate(meta?.resolvedDate ?? meta?.effectiveDate ?? ''))}</strong> — the day the `
    + `${escapeHtml(meta?.label ?? active)} review took effect and every tracking fund traded — to the latest `
    + `committed close on <strong>${escapeHtml(shortDate(context.latestDate))}</strong>. `
    + (meta && !meta.tradedOnEffectiveDate
      ? `India was shut on ${escapeHtml(shortDate(meta.effectiveDate))}, so the baseline is the previous session. `
      : '')
    + 'One close at each end, from BSE. There is no ten-day mean here: the rebalance date is published, so no '
    + 'day-choice has to be averaged away.</p>';

  if (reading === undefined) {
    return windowLine
      + '<p class="rounded-xl bg-slate-50/70 p-3 text-xs leading-relaxed text-slate-600">This baseline is still '
      + 'loading. That is a fact about the fetch, not about this company.</p>';
  }
  if (!reading || reading.relativePct === null) {
    const state_ = reading ? REBASE_STATES[reading.state] : null;
    return windowLine
      + '<div class="rounded-xl bg-amber-50/70 p-3">'
      + `<p class="text-xs font-semibold text-amber-900">${escapeHtml(state_?.label ?? 'no reading')}</p>`
      + `<p class="mt-1 text-xs leading-relaxed text-amber-800">${escapeHtml(state_?.detail ?? 'No since-rebalance reading is on the record for this company.')}</p>`
      + '</div>';
  }

  const tone = !reading.robust ? 'text-slate-700' : reading.relativePct > 0 ? 'text-emerald-700' : 'text-rose-700';
  const pressure = pressureFor(company);

  return (
    windowLine
    + '<dl class="rounded-xl bg-slate-50/70 p-3">'
    + drillRow(`${escapeHtml(reading.benchmarkSymbol)} in rupees`, escapeHtml(signedPct(reading.indexPct, 2)),
      { title: `${reading.benchmarkName ?? reading.benchmarkSymbol} — the ETF, not the index. Struck on the SAME two dates, each converted at that date's own FX rate. The benchmark is chosen by segment: INDA for Standard, SMIN for Small Cap and for a company outside the index.` })
    + drillRow('This company', escapeHtml(signedPct(reading.stockPct, 2)),
      { title: "BSE's own published closes at both ends" + (reading.adjustmentFactor ? ', with the baseline divided by the corporate-action factor below' : ', with no corporate action between them') })
    + drillRow('Δ vs index', `<span class="${tone} font-semibold">${escapeHtml(signedPct(reading.relativePct, 2))}</span>`,
      { title: '(1 + stock) / (1 + index) - 1 — a compounded ratio, not the arithmetic difference of the two returns above. That is why the three numbers do not add up.' })
    + (reading.sensitivity
      ? drillRow('If the baseline moved a day or two',
        escapeHtml(`${signedPct(reading.sensitivity[0], 1)} to ${signedPct(reading.sensitivity[1], 1)}`),
        { title: `Across ${reading.candidateCount} candidate sessions either side of the rebalance date, the reading spans ${reading.sensitivityWidthPp.toFixed(1)} pp. This is a fragility test, NOT a widening of the baseline — the figure above is struck on the rebalance date itself. It varies the baseline end only: the latest close is the newest fact, not a choice.` })
      : drillRow('If the baseline moved a day or two', '<span class="text-slate-500">not testable</span>',
        { title: 'Fewer than two candidate sessions carried both a close and an index leg, so the reading could not be tested for fragility.' }))
    + drillRow('Direction holds?',
      reading.robust
        ? '<span class="font-semibold text-emerald-700">yes</span>'
        : '<span class="font-semibold text-slate-500">no — not robust</span>',
      { title: `The whole span must clear the desk's ${band} pp band, which is set at the measured median sensitivity width of this reading across the universe (3.64 pp). A band below its own measurement's uncertainty produces state changes that are noise.` })
    + (reading.adjustmentFactor
      ? drillRow('Adjusted for',
        escapeHtml(`${reading.actionsApplied.map((a) => `${a.purpose} on ${a.exDate}`).join('; ')} — baseline ÷ ${reading.adjustmentFactor}`),
        { title: "BSE's own published corporate action. The raw closes are unadjusted; this is our arithmetic on them, and both ends now sit on the same number of shares." })
      : '')
    + '</dl>'
    + (pressure
      // The SAME direction colouring as the chip and the Δ column — emerald
      // gaining, rose losing, slate where no direction is claimed. A signal that
      // is green in the table and amber in the drill is two signals to a reader.
      ? (() => {
        const skin = pressure.key === 'neutral'
          ? { box: 'bg-slate-50/70', head: 'text-slate-700', body: 'text-slate-600' }
          : pressure.key === 'positive'
            ? { box: 'bg-emerald-50/70', head: 'text-emerald-900', body: 'text-emerald-800' }
            : { box: 'bg-rose-50/70', head: 'text-rose-900', body: 'text-rose-800' };
        return `<div class="mt-2 rounded-xl ${skin.box} p-3">`
        + `<p class="text-xs font-semibold ${skin.head}">${escapeHtml(pressure.label)}</p>`
        + `<p class="mt-1 text-xs leading-relaxed ${skin.body}">${escapeHtml(pressure.detail)}</p>`
        + `<p class="mt-1 text-xs leading-relaxed ${skin.body}">${escapeHtml(pressure.implication)}</p>`
        + (pressure.notableReason
          // ⚠ AMBER STAYS HERE, and only here. The colour above now says which
          // way the company is moving, so the older meaning — that this reading
          // CONTRADICTS the verdict — has nowhere else to live. Losing it would
          // make a disagreement look like agreement.
          ? `<p class="mt-1 text-[11px] font-semibold leading-relaxed ${pressure.notableKind === 'contradicts' ? 'text-amber-900' : 'text-sky-900'}">Marked beside the verdict: ${escapeHtml(pressure.notableReason)}</p>`
          : '')
        + `<p class="mt-1.5 text-[11px] leading-relaxed text-slate-500">Rule: ${escapeHtml(pressure.inputLabel)}, against a band of ${escapeHtml(String(pressure.threshold))} ${escapeHtml(pressure.thresholdUnit)}. `
        + `Whose threshold: ${escapeHtml(pressure.thresholdSource)}</p></div>`;
      })()
      : '')
    + '<p class="mt-2 rounded-xl bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">'
    + `<strong>This does not decide the verdict above.</strong> ${escapeHtml(context.doesNotMoveVerdict)}</p>`
    + '<p class="mt-1 rounded-xl bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">'
    + `<strong>And it implies no trade.</strong> ${escapeHtml(context.noTradeImplied)}</p>`
    + '<p class="mt-1 rounded-xl bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">'
    + `<strong>Whose reading this is:</strong> ${escapeHtml(context.attribution)}</p>`
  );
}

/**
 * The relative-performance section: the window, both legs, the envelope and the
 * one thing this reading is NOT allowed to do.
 */
function relativeSectionHtml(company) {
  const rel = company.relativePerformance;
  const window = data.relativeWindow();
  if (!window) {
    return '<p class="rounded-xl bg-slate-50/70 p-3 text-xs leading-relaxed text-slate-600">'
      + 'No price history or corporate-action history is on the record, so no window return can be '
      + 'measured for any company. Run <code>fetch-price-history.mjs</code> and '
      + '<code>fetch-corporate-actions.mjs</code>.</p>';
  }
  const windowLine =
    `<p class="mb-2 text-[11px] leading-relaxed text-slate-600">Measured from the <strong>${escapeHtml(window.from.review)}</strong> `
    + `price window (${escapeHtml(window.from.from)} to ${escapeHtml(window.from.to)}, ${window.from.sessions} sessions) `
    + `to the <strong>${escapeHtml(window.to.review)}</strong> window (${escapeHtml(window.to.from)} to ${escapeHtml(window.to.to)}, `
    + `${window.to.sessions} sessions). ${escapeHtml(window.windowNote)} — so the figure below is the mean of all ten days `
    + 'at each end, and no single day is privileged.</p>';

  if (!rel || rel.relativePct === null) {
    // A NAMED absence in its own words, never a blank or a zero — 2.3 and 2.4.
    return windowLine
      + '<div class="rounded-xl bg-amber-50/70 p-3">'
      + `<p class="text-xs font-semibold text-amber-900">${escapeHtml(rel?.label ?? 'no reading')}</p>`
      + `<p class="mt-1 text-xs leading-relaxed text-amber-800">${escapeHtml(rel?.reason ?? 'No relative-performance reading is on the record for this company.')}</p>`
      + '</div>';
  }

  const tone = !rel.robust ? 'text-slate-700' : rel.relativePct > 0 ? 'text-emerald-700' : 'text-rose-700';
  const signal = trendFor(company);

  return (
    windowLine
    + '<dl class="rounded-xl bg-slate-50/70 p-3">'
    + drillRow('This company', escapeHtml(signedPct(rel.stockPct, 2)),
      { title: 'Ten-day mean close at each end, from the BSE bhavcopy archive' + (rel.adjustmentFactor ? ', with the earlier window divided by the corporate-action factor below' : '') })
    + drillRow(`${escapeHtml(rel.benchmarkSymbol)} in rupees`, escapeHtml(signedPct(rel.indexPct, 2)),
      { title: `${rel.benchmarkName} — the ETF, not the index. Struck on the SAME ten dates, converted at each date's own FX rate.` })
    + drillRow('Relative', `<span class="${tone} font-semibold">${escapeHtml(signedPct(rel.relativePct, 2))}</span>`,
      { title: '(1 + stock) / (1 + index) - 1 — a compounded ratio, not the arithmetic difference of the two returns above' })
    + drillRow('Across all ten possible days',
      escapeHtml(`${signedPct(rel.envelope[0], 1)} to ${signedPct(rel.envelope[1], 1)}`),
      { title: `MSCI prices on one of the ten business days and does not publish which, so there are 100 (from-day, to-day) pairs it could have meant. This reading spans ${rel.widthPp.toFixed(1)} pp across them.` })
    + drillRow('Direction holds whichever day?',
      rel.robust
        ? '<span class="font-semibold text-emerald-700">yes</span>'
        : '<span class="font-semibold text-slate-500">no — not robust</span>',
      { title: `The whole span must clear the desk's ${RELATIVE_PERFORMANCE.bandPct} pp band. Measured across the universe, the median span is 14.7 pp wide and 31.4% of companies have a span that crosses zero.` })
    + (rel.adjustmentFactor
      ? drillRow('Adjusted for',
        escapeHtml(`${rel.actionsApplied.map((a) => `${a.purpose} on ${a.exDate}`).join('; ')} — earlier window ÷ ${rel.adjustmentFactor}`),
        { title: "BSE's own published corporate action. The raw closes are unadjusted; this is our arithmetic on them, and both ends now sit on the same number of shares." })
      : '')
    + '</dl>'
    + (signal
      ? `<div class="mt-2 rounded-xl ${signal.kind === 'disagrees' ? 'bg-amber-50/70' : 'bg-sky-50/70'} p-3">`
        + `<p class="text-xs font-semibold ${signal.kind === 'disagrees' ? 'text-amber-900' : 'text-sky-900'}">${escapeHtml(signal.label)}</p>`
        + `<p class="mt-1 text-xs leading-relaxed ${signal.kind === 'disagrees' ? 'text-amber-800' : 'text-sky-800'}">${escapeHtml(signal.detail)}</p></div>`
      : '')
    + '<p class="mt-2 rounded-xl bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">'
    + '<strong>This does not decide the verdict above, and it is not independent of it.</strong> '
    + 'A migration verdict turns on a rank by free-float market cap, and free float is the float factor '
    + 'times the share count times the price — so today\'s rank already contains every past price move. '
    + 'That is how the company reached it. What this reading adds is about the FUTURE: today\'s rank is a '
    + 'forecast of the rank in MSCI\'s next price window, and a trend that holds whichever day MSCI prices '
    + 'on is evidence about which way that forecast moves.</p>'
    + '<p class="mt-1 rounded-xl bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">'
    + `<strong>Whose reading this is:</strong> ${escapeHtml(window.attribution)}</p>`
  );
}

function driftSectionHtml(company) {
  const drift = company.passiveDrift;
  if (!drift || Object.keys(drift).length === 0) {
    return '<p class="rounded-xl bg-slate-50/70 p-3 text-xs leading-relaxed text-slate-600">No fund holds this company, so there is no weight to drift.</p>';
  }
  const capture = data.freshness().feeds.find((f) => f.id === 'ishares');
  const since = capture?.date ? shortDate(capture.date) : 'the holdings date';

  const blocks = FUND_ORDER.map((id) => {
    const record = drift[id];
    if (!record) return '';
    const label = data.fundCoverage(id)?.shortName ?? id;
    const up = record.driftPp > 0;
    const tone = record.driftPp === 0 ? 'text-slate-500' : up ? 'text-emerald-700' : 'text-rose-700';
    return (
      '<div class="mb-2 rounded-xl bg-slate-50/70 p-3 last:mb-0">'
      + `<div class="mb-1.5 flex items-center gap-2">${fundChip(id, label)}</div>`
      + `<p class="text-xs leading-relaxed text-slate-700">Drifted from <strong class="tabular-nums">${escapeHtml(pct(record.weightAtCapturePct, 5))}</strong> `
      + `to <strong class="tabular-nums">${escapeHtml(pct(record.impliedWeightNowPct, 5))}</strong> on price alone since ${escapeHtml(since)} `
      + `(<span class="${tone} font-semibold tabular-nums">${escapeHtml(record.driftPp > 0 ? '+' : '')}${escapeHtml(num(record.driftPp, 6))} pp</span>) — `
      + '<strong>no trade required</strong>.</p></div>'
    );
  }).join('');

  return (
    blocks
    + '<p class="mt-2 rounded-xl bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">'
    + 'An index fund holds each member in proportion to its weight, so when a price rises the holding '
    + 'gains value by exactly the proportion the weight does. Drift is worth watching because it is how '
    + 'a company closing on a size cut-off becomes visible — not because it implies a purchase. '
    + 'Forced trading comes from the index\'s own inputs changing at a review: a segment migration, an '
    + 'entry or exit, a float-factor revision or a share-count revision.</p>'
  );
}

/**
 * Flow primitives — INPUTS to a calculation, not results.
 *
 * No rupee flow figure appears anywhere on this screen, because no index event
 * has been identified yet. What is shown is what one percentage point of weight
 * is worth in each fund, so a later forecast can be read against it.
 */
function flowPrimitivesSectionHtml(company) {
  const primitives = data.flowPrimitives();
  const held = FUND_ORDER.filter((id) => company.funds?.[id]);
  if (held.length === 0) return '';

  const rows = held.map((id) => {
    const p = primitives[id];
    if (!p) return '';
    return (
      '<div class="mb-2 rounded-xl bg-slate-50/70 p-3 last:mb-0">'
      + `<div class="mb-1.5 flex items-center gap-2">${fundChip(id, p.shortName)}`
      + `<span class="text-[11px] text-slate-500">AUM as of ${escapeHtml(shortDate(p.aumAsOf))}, not today</span></div>`
      + '<dl>'
      + drillRow('Fund AUM', escapeHtml(`$${num(p.fundAumUsd / 1e9, 2)} bn`), { title: 'Total fund market value across every country, from the holdings workbook' })
      + drillRow('FX rate used', escapeHtml(`${num(p.fxRate, 5)} ₹/$`), { title: "The workbook's own rate as of the holdings date — deliberately not a live rate" })
      + drillRow('1.00 pp of weight', escapeHtml(`₹${num(p.inrPerWeightPointCrore, 0)} Cr`))
      + drillRow('0.01 pp of weight', escapeHtml(`₹${num(p.inrPerBasisPointOfWeight / 1e7, 2)} Cr`))
      + '</dl></div>'
    );
  }).join('');

  const adv = company.advQty;
  const advLine = adv
    ? `<p class="mt-2 text-[11px] leading-relaxed text-slate-500">Average daily volume <strong class="tabular-nums">${escapeHtml(num(adv))}</strong> shares `
      + `(${escapeHtml(company.advSource ?? 'source unrecorded')}). A flow is only actionable measured against this — ₹400 Cr is nothing in a large cap and a fortnight of volume in a small one.</p>`
    : '<p class="mt-2 text-[11px] leading-relaxed text-slate-400">No average daily volume on record, so a flow could not be expressed in days of volume.</p>';

  return (
    rows + advLine
    + '<p class="mt-2 rounded-xl bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-900 ring-1 ring-amber-200">'
    + 'These are <strong>inputs to a later calculation, not results</strong>. No index event has been '
    + 'identified for this company, so no rupee flow figure exists anywhere in this build.</p>'
  );
}

function provenanceSectionHtml(company) {
  const fresh = data.freshness();
  const dates = fresh.feeds
    .map(
      (feed) =>
        `<div class="flex justify-between gap-3 text-[11px]"><span class="text-slate-500">${escapeHtml(feed.label)}</span>` +
        `<span class="font-semibold tabular-nums text-slate-700">${escapeHtml(feed.raw ? shortDate(feed.date ?? feed.raw) : 'no reading')}</span></div>`,
    )
    .join('');

  return (
    '<dl class="rounded-xl bg-slate-50/70 p-3">' +
    drillRow('Resolved by', escapeHtml(company.resolution?.method ?? EM_DASH)) +
    drillRow('Confidence', escapeHtml(company.resolution?.confidence ?? EM_DASH)) +
    '</dl>' +
    `<div class="mt-2 space-y-1 rounded-xl bg-slate-50/70 p-3">${dates}</div>` +
    '<div class="mt-3 space-y-2 text-[11px] leading-relaxed">' +
    '<p class="rounded-lg bg-white p-2.5 ring-1 ring-slate-100"><span class="font-bold text-slate-700">Measured, reproduced unchanged:</span> ' +
    'index weight, quantity and market value (BlackRock); free-float and full market cap (NSE or BSE, as marked); price (BSE).</p>' +
    '<p class="rounded-lg bg-white p-2.5 ring-1 ring-slate-100"><span class="font-bold text-slate-700">Derived by us:</span> ' +
    'the float factor, shares outstanding (full market cap ÷ price, both BSE) and free-float market cap — each with its formula shown beside it above.</p>' +
    '<p class="rounded-lg bg-white p-2.5 ring-1 ring-slate-100"><span class="font-bold text-slate-700">Modelled by us:</span> ' +
    'the segment placement, the verdict and any flow estimate. These are rules we wrote, run against the desk\'s ' +
    'thresholds and the observed constituent boundary — every one shows its working in the Assessment section above. ' +
    'They are not probabilities and not MSCI\'s decision.</p>' +
    '</div>'
  );
}

function openCompanyDrill(key, { onClose } = {}) {
  const company = data.byIsin(key);
  if (!company) return;

  const identity =
    '<dl class="rounded-xl bg-slate-50/70 p-3">' +
    drillRow('NSE symbol', company.nseSymbol ? escapeHtml(company.nseSymbol) : missing('not in the niftyindices NSE universe, so no symbol is asserted')) +
    drillRow('BSE scrip code', company.bseScripCode ? escapeHtml(company.bseScripCode) : missing('no BSE equity listing')) +
    drillRow('ISIN', company.isin ? escapeHtml(company.isin) : missing('no ISIN on record')) +
    drillRow('Sector', company.sector ? escapeHtml(company.sector) : missing('no sector published for this scrip')) +
    drillRow('Shares outstanding', company.sharesOutstanding === null ? missing('no price, so no share count derivable') : escapeHtml(count(company.sharesOutstanding))) +
    '</dl>';

  openDrill({
    title: company.name,
    subtitle: [company.nseSymbol, company.sector].filter(Boolean).join(' · '),
    label: `${company.name} details`,
    body:
      drillSection('Identity', identity) +
      drillSection('Assessment', assessmentSectionHtml(company)) +
      drillSection('Free float', floatSectionHtml(company)) +
      drillSection('Index participation', fundsSectionHtml(company)) +
      drillSection('Against its segment — since the last rebalance', rebaseSectionHtml(company)) +
      drillSection("Against its segment — across MSCI's two price windows", relativeSectionHtml(company)) +
      drillSection('Weight drift — no trade required', driftSectionHtml(company)) +
      drillSection('Flow primitives — inputs, not results', flowPrimitivesSectionHtml(company)) +
      drillSection('Provenance', provenanceSectionHtml(company)),
    onClose: () => {
      setParams({ company: null });
      onClose?.();
    },
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * The view
 * ──────────────────────────────────────────────────────────────────────────── */

const watchStar = (isin) => {
  const on = state.isWatched(isin);
  return (
    `<button type="button" data-row-action="watch" aria-pressed="${on}" ` +
    `title="${on ? 'Remove from watchlist' : 'Add to watchlist'}" aria-label="${on ? 'Remove from watchlist' : 'Add to watchlist'}" ` +
    `class="shrink-0 rounded p-0.5 ${on ? 'text-amber-500' : 'text-slate-300 hover:text-amber-400'} focus:outline-none focus:ring-2 focus:ring-indigo-500">` +
    `<svg width="14" height="14" viewBox="0 0 20 20" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" aria-hidden="true">` +
    '<path d="m10 2.5 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4-3.9-3.8 5.4-.8z" stroke-linejoin="round"/></svg></button>'
  );
};

/**
 * The three since-rebalance columns: index return, stock return, delta.
 *
 * Built by a factory rather than written out three times because all three share
 * one absence path. A reading can be missing for nine named reasons and every
 * one of them must reach the screen IN ITS OWN WORDS on all three columns —
 * 2.4. Three hand-written copies of that lookup is three chances to let one of
 * them fall back to a blank cell.
 */
function relativeColumns() {
  const context = data.rebalanceBaselines();
  const band = context?.bandPct ?? REBALANCE_BASELINE.bandPct;

  /** The named absence, or null when there is a reading to render. */
  const absence = (row) => {
    const reading = rebaseFor(row);
    if (reading === undefined) {
      return missing('this baseline is still loading — not a fact about this company');
    }
    if (!reading) return missing('no since-rebalance reading is on the record for this company');
    if (reading.relativePct === null) {
      const state_ = REBASE_STATES[reading.state];
      return missing(`${state_?.label ?? reading.state}: ${state_?.detail ?? ''}`.trim());
    }
    return null;
  };

  const windowLabel = (reading) =>
    `${reading.baselineDate} to ${reading.latestDate}. Both legs are struck on those two dates and `
    + 'neither is walked back: a leg moved to a different day would difference two different windows.';

  return [
    {
      label: 'Index return %',
      align: 'right',
      html: true,
      sortValue: (row) => rebaseFor(row)?.indexPct ?? null,
      get: (row) => {
        const gone = absence(row);
        if (gone) return gone;
        const reading = rebaseFor(row);
        const title =
          `${reading.benchmarkName ?? reading.benchmarkSymbol} in RUPEES over ${windowLabel(reading)}`
          + ` It is the ETF, not the index — an ETF carries tracking error and trades at a premium or`
          + ` discount to NAV. The benchmark is chosen by segment: INDA for Standard, SMIN for Small Cap`
          + ` and for a company outside the index, because the fund that HOLDS a stock is not the index`
          + ` that decides its segment.`;
        // ⚠ INLINE FLOW, NOT `inline-flex`. A cell whose whole content is one
        // atomic inline box has nothing for `text-overflow` to replace, so a
        // squeezed column cuts it clean rather than ellipsising — a wrong
        // number that looks like a right one. Measured; see the column-layout
        // header in ui/screener.js and CLAUDE.md 2.29.
        return `<span class="whitespace-nowrap" title="${escapeHtml(title)}">`
          + `<span class="font-semibold text-slate-700">${escapeHtml(signedPct(reading.indexPct, 1))}</span>`
          + `<span class="ml-1 rounded bg-slate-100 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-slate-500">${escapeHtml(reading.benchmarkSymbol)}</span>`
          + '</span>';
      },
    },
    {
      label: 'Stock return %',
      align: 'right',
      html: true,
      sortValue: (row) => rebaseFor(row)?.stockPct ?? null,
      get: (row) => {
        const gone = absence(row);
        if (gone) return gone;
        const reading = rebaseFor(row);
        const title =
          `This company's BSE close over ${windowLabel(reading)}`
          + (reading.adjustmentFactor
            ? ` Adjusted for ${reading.actionsApplied.map((a) => `${a.purpose} on ${a.exDate}`).join('; ')}`
              + ` — the baseline close is divided by ${reading.adjustmentFactor} so both ends sit on the same`
              + ' number of shares. BSE publishes closes unadjusted, so without this a bonus reads as a collapse.'
            : ' No corporate action fell between the two dates.');
        // Inline flow, not `inline-flex` — see the Index return column above.
        return `<span class="whitespace-nowrap" title="${escapeHtml(title)}">`
          + `<span class="font-semibold text-slate-900">${escapeHtml(signedPct(reading.stockPct, 1))}</span>`
          + (reading.adjustmentFactor
            ? '<span class="ml-1 text-[10px] text-amber-600" title="adjusted for a corporate action">adj</span>'
            : '')
          + '</span>';
      },
    },
    {
      label: 'Δ vs index %',
      align: 'right',
      html: true,
      sortValue: (row) => rebaseFor(row)?.relativePct ?? null,
      get: (row) => {
        const gone = absence(row);
        if (gone) return gone;
        const reading = rebaseFor(row);
        const pressure = pressureFor(row);
        // ⚠ NOT `stock - index`. The two returns above compound, so their
        // arithmetic difference is not the outperformance a reader would
        // reconstruct from them — WELCORP's +119.7% against SMIN's +4.5% is
        // 115.2 pp apart and 110.0% relative. The formula is on the cell so the
        // reader can see WHY the three numbers do not add up.
        const title =
          `(1 + stock) / (1 + index) - 1 — a compounded ratio, NOT the arithmetic difference of the`
          + ` two columns to the left. Measured ${windowLabel(reading)}`
          + (reading.sensitivity
            ? ` Shifting the baseline a session either side moves this to between`
              + ` ${signedPct(reading.sensitivity[0], 1)} and ${signedPct(reading.sensitivity[1], 1)}`
              + ` (${reading.sensitivityWidthPp.toFixed(1)} pp), across ${reading.candidateCount} candidate sessions.`
            : ' The baseline could not be varied, so this reading has not been tested for fragility.')
          + (reading.robust
            ? ` That whole span clears the desk's ${band} pp band, so the direction holds.`
            : ` That span does NOT clear the desk's ${band} pp band, so no direction is claimed.`)
          + (pressure ? ` ${pressure.label}: ${pressure.implication}` : '')
          + ' This is evidence beside the verdict and never an input to it.';
        const tone = !reading.robust
          ? 'text-slate-500'
          : reading.relativePct > 0 ? 'text-emerald-700' : 'text-rose-700';
        // Inline flow, not `inline-flex` — see the Index return column above.
        return `<span class="whitespace-nowrap" title="${escapeHtml(title)}">`
          + `<span class="${tone} font-semibold">${escapeHtml(signedPct(reading.relativePct, 1))}</span>`
          + (reading.robust
            ? ''
            : '<span class="ml-1 text-[10px] text-slate-400" title="the sign does not survive shifting the baseline a session either side">±</span>')
          + '</span>';
      },
    },
  ];
}

/**
 * The rebalance-baseline control: which rebalance date the three columns above
 * are measured from, and everything that has to be said about it.
 *
 * ---------------------------------------------------------------------------
 * THE DEFAULT IS CONFIG-SET; THIS IS AN OVERRIDE OF IT
 * ---------------------------------------------------------------------------
 * REBALANCE_BASELINE.defaultReview decides the baseline at build time, resolved
 * against the newest session the exchange served rather than against the clock.
 * The picker lets a reader ask the same question of an earlier rebalance. It
 * changes what the three columns MEASURE; it changes no verdict and no row.
 *
 * Every count here is derived from the rows on screen, never typed — 2.5.
 */
function baselineStrip(rows) {
  const context = data.rebalanceBaselines();
  if (!context) {
    return el('div', {
      class: 'mb-5 rounded-2xl bg-amber-50/70 p-4 ring-1 ring-amber-200',
      html: '<p class="text-xs leading-relaxed text-amber-900"><strong>No rebalance baseline is on the record.</strong> '
        + 'Price history or corporate-action history is missing, so the three relative columns carry a stated '
        + 'absence on every row rather than a number. Run <code>fetch-price-history.mjs</code> and '
        + '<code>fetch-corporate-actions.mjs</code>, then rebuild.</p>',
    });
  }

  const active = activeBaseline();
  const meta = data.baselineMeta(active);
  const isDefault = active === context.defaultReview;

  // Derived from the rows in view. A reading can be absent for nine named
  // reasons and the denominator is the story — 2.5.
  let withReading = 0;
  let robust = 0;
  let loading = 0;
  for (const row of rows) {
    const reading = rebaseFor(row);
    if (reading === undefined) { loading += 1; continue; }
    if (!reading || reading.relativePct === null) continue;
    withReading += 1;
    if (reading.robust) robust += 1;
  }
  const notable = rows.filter((row) => pressureFor(row)?.notable).length;

  const options = (context.baselines ?? []).map((b) =>
    `<option value="${escapeHtml(b.review)}"${b.review === active ? ' selected' : ''}>`
    + `${escapeHtml(b.label)} — ${escapeHtml(shortDate(b.effectiveDate))}`
    + `${b.review === context.defaultReview ? ' (default)' : ''}</option>`).join('');

  const walked = meta && !meta.tradedOnEffectiveDate
    ? ` India was shut on ${escapeHtml(shortDate(meta.effectiveDate))}, so the baseline is the previous session, `
      + `${escapeHtml(shortDate(meta.resolvedDate))} — ${meta.walkedBackDays} day(s) earlier.`
    : '';

  const html =
    '<div class="flex flex-wrap items-start justify-between gap-4">'
    + '<div class="min-w-0 max-w-3xl">'
    + '<div class="flex flex-wrap items-center gap-2">'
    + '<span class="rounded-md bg-slate-700 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">Baseline</span>'
    + '<label class="flex min-w-0 items-center gap-2 text-[11px] font-semibold text-slate-500">'
    + '<span class="whitespace-nowrap">Measured since</span>'
    + '<select data-baseline aria-label="Rebalance date the relative columns are measured from" '
    // ⚠ A <select> IS AS WIDE AS ITS WIDEST OPTION, and nothing shrinks it.
    // "February 2026 — 27 Feb 2026 (default)" measures 271px, which on a 390px
    // phone pushes this row 26px past the viewport. `min-w-0 max-w-full` lets
    // it shrink and truncate instead; the full label is still in the dropdown.
    + 'class="min-w-0 max-w-full rounded-xl border-0 bg-white py-1.5 pl-2.5 pr-7 text-xs font-medium text-slate-800 shadow-sm ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500">'
    + `${options}</select></label>`
    + (isDefault
      ? '<span class="text-[10px] font-semibold uppercase tracking-wide text-slate-400" '
        + 'title="Set in public/js/config/thresholds.mjs as REBALANCE_BASELINE.defaultReview, resolved against the newest session the exchange served — not against the clock">config default</span>'
      : '<button type="button" data-baseline-reset class="rounded-lg bg-white px-2 py-1 text-[10px] font-semibold text-indigo-700 shadow-sm ring-1 ring-slate-200 transition hover:ring-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-500">'
        + 'back to the default</button>')
    + '</div>'
    + '<p class="mt-2 text-xs leading-relaxed text-slate-600">'
    + `<strong>Index return</strong>, <strong>stock return</strong> and <strong>Δ vs index</strong> are measured from `
    + `<strong>${escapeHtml(shortDate(meta?.resolvedDate ?? meta?.effectiveDate ?? ''))}</strong>, the day the `
    + `${escapeHtml(meta?.label ?? active)} review took effect and every tracking fund traded, to the latest committed `
    + `close on <strong>${escapeHtml(shortDate(context.latestDate))}</strong>.${walked} `
    + '<span class="opacity-80">This is <em>not</em> the ten-day window MSCI struck its market caps in — that window is '
    + 'six weeks earlier and has its own drill-panel section, “Against its segment — across MSCI\u2019s two price '
    + 'windows”. On this record the two disagree about '
    + 'the sign for 27.8% of companies, so neither substitutes for the other.</span></p>'
    + '<p class="mt-1.5 text-[11px] leading-relaxed text-slate-500">'
    + `<strong>It does not decide a verdict.</strong> ${escapeHtml(context.doesNotMoveVerdict)}</p>`
    + '<p class="mt-1 text-[11px] leading-relaxed text-slate-500">'
    + `<strong>And it implies no trade.</strong> ${escapeHtml(context.noTradeImplied)}</p>`
    + `<p class="mt-1 text-[11px] leading-relaxed text-slate-400"><strong>Attribution.</strong> ${escapeHtml(context.attribution)}</p>`
    + '</div>'
    + '<div class="grid w-full min-w-0 grid-cols-2 gap-2 sm:w-auto sm:shrink-0 sm:grid-cols-3">'
    + [
      ['With a reading', `${num(withReading)} of ${num(rows.length)}`,
        'Companies in view carrying a return from this baseline. The rest each state their own reason in the column — a blocked read, an unquantifiable corporate action, or a company not yet listed on that date.'],
      ['Direction holds', `${num(robust)} of ${num(withReading)}`,
        `The whole sensitivity span clears the desk's ${context.bandPct} pp band, so the sign survives shifting the baseline a session either side. The rest render neutral however large they look.`],
      ['Marked beside a verdict', `${num(notable)} of ${num(rows.length)}`,
        'Rows where the reading says something the size rule does not — it contradicts the verdict, or the company is stable but close enough to the rank cutoff for the trend to matter by the next review.'],
    ].map(([label, value, title]) =>
      `<div class="min-w-0 rounded-xl bg-white/70 px-3 py-2 ring-1 ring-inset ring-slate-200" title="${escapeHtml(title)}">`
      + `<div class="break-words text-[10px] font-bold uppercase tracking-wide text-slate-500">${escapeHtml(label)}</div>`
      + `<div class="font-display mt-0.5 text-sm font-extrabold tabular-nums text-slate-900">${escapeHtml(value)}</div></div>`).join('')
    + (loading > 0
      ? `<div class="col-span-2 rounded-xl bg-slate-50 px-3 py-2 text-[10px] text-slate-500 sm:col-span-3">Loading ${num(loading)} readings…</div>`
      : '')
    + '</div></div>';

  const wrap = el('div', {
    class: 'mb-5 rounded-2xl bg-gradient-to-br from-slate-50 to-white p-4 ring-1 ring-slate-200',
    html,
  });

  const select = $('[data-baseline]', wrap);
  const reset = $('[data-baseline-reset]', wrap);

  /**
   * Load the baseline BEFORE switching to it.
   *
   * The alternates live in their own 1.2 MB file, fetched on demand. Switching
   * first and fetching after would paint three columns of em dashes under a
   * heading naming the new baseline — a loading state that reads as a finding
   * about every company at once. On a failure the select goes back to where it
   * was and says so, rather than leaving a heading the numbers do not match.
   */
  const choose = async (review) => {
    if (review === activeBaseline()) return;
    select.disabled = true;
    try {
      const ready = await data.ensureBaseline(review);
      if (!ready) throw new Error('that baseline is not in the record');
      state.setBaseline(review === data.rebalanceBaselines().defaultReview ? null : review);
    } catch (error) {
      select.value = activeBaseline();
      select.disabled = false;
      console.error('[baseline] could not switch', error);
      wrap.querySelector('[data-baseline]')?.insertAdjacentHTML('afterend',
        '<span data-baseline-error class="ml-2 text-[10px] font-semibold text-rose-700">could not load that baseline — still showing '
        + `${escapeHtml(activeBaseline())}</span>`);
    }
  };

  select?.addEventListener('change', () => { choose(select.value); });
  reset?.addEventListener('click', () => { choose(data.rebalanceBaselines().defaultReview); });

  return wrap;
}

export function renderCompanies(host, { onStatusChange } = {}) {
  let table = null;
  let lastView = null;
  let statsHost = null;
  const refreshHeaderStatus = () => onStatusChange?.();
  /** The strip counts verdicts, so a verdict flip makes it stale. */
  const repaintStats = () => {
    if (statsHost) statsHost.replaceChildren(buildStats(data.forScope(state.SCOPE)));
  };

  function build() {
    // The model must exist before anything renders a verdict.
    rebuildModel();
    // ALWAYS THE WHOLE UNIVERSE. The Held/All toggle went on 26 Aug 2026: a
    // candidate no fund holds yet is precisely what an inclusion forecast is
    // about, so hiding it behind a default made the product's own subject
    // opt-in.
    const rows = data.forScope(state.SCOPE);
    const cov = data.coverage();

    host.replaceChildren();

    const countChip = el(
      'span',
      {
        class: 'inline-flex items-center gap-1.5 rounded-lg bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700 ring-1 ring-inset ring-indigo-200',
        title: `Every company in the record — ${num(cov.held)} held by a fund, ${num(cov.notHeld)} candidates no fund owns yet`,
      },
      `${num(rows.length)} of ${num(cov.companies)} companies`,
    );

    host.append(
      sectionHead({
        title: 'Company screener',
        meta: countChip,
      }),
    );

    host.append(modelBanner(rows));
    host.append(baselineStrip(rows));

    statsHost = el('div', { class: 'mb-6' }, [buildStats(rows)]);
    host.append(statsHost);

    const columns = [
      {
        label: 'Verdict',
        align: 'left',
        html: true,
        sortValue: (row) => {
          // Ordered by how much a desk should care, not alphabetically.
          const order = ['likely-inclusion', 'migration-up', 'possible-inclusion', 'migration-down', 'exclusion-risk', 'likely-exclusion', 'stable', 'unknown'];
          return order.indexOf(assessmentFor(row)?.verdict ?? 'unknown');
        },
        defaultDir: 'asc',
        get: (row) => {
          const assessment = assessmentFor(row);
          if (!assessment) return missing('not yet assessed');
          const quarantine = row.shareCountQuarantine;
          const pill = verdictPill(assessment.verdict, {
            title: quarantine
              ? `Unknown: ${quarantine.reason}`
              : `${VERDICTS[assessment.verdict]?.detail ?? ''} ${DISCLOSURE}`,
          });
          // ── Flow pressure, BESIDE the verdict and never inside it ───────
          //
          // This is how the since-rebalance reading is "reflected in the
          // verdict": as a marked direction next to it, on a chip that says what
          // rule fired and against what threshold. The verdict key itself is
          // untouched — see the header of model/relative.js on why letting this
          // move it would count price twice.
          //
          // ⚠ IT FIRES ON `notable` ROWS, NOT ON ROBUST ONES. 849 of 1,193
          // readings are robust — two rows in three — and a marker on two rows in
          // three is a marker readers stop seeing. A chip is earned only where
          // the reading says something the verdict does not: it contradicts the
          // size rule, or the row is stable but close enough to the rank cutoff
          // for the trend to matter by the next review. Every other row still
          // shows the number, one column away.
          //
          // The chip replaced the MSCI-window trend signal that stood here. Two
          // chips, on two different windows, beside one verdict was a reader's
          // trap: the trend signal is measured across MSCI's price windows and
          // these columns are measured from the rebalance date, and the two
          // disagree about the SIGN for 27.8% of companies. The trend signal
          // keeps its own section in the drill, beside the window it belongs to.
          const pressure = pressureFor(row);
          if (!pressure || !pressure.notable) return pill;
          // ⚠ THE COLOUR IS THE DIRECTION, and it matches the Δ column exactly:
          // emerald where the company is gaining on its segment, rose where it
          // is losing. Any other mapping would put two different meanings on the
          // same two colours in one row.
          //
          // It used to key on `notableKind` — amber for a reading that
          // contradicts the verdict, sky for one approaching a boundary. That
          // distinction is NOT lost, but it is no longer in the colour: it is
          // the first sentence of the chip's own title, and the drill keeps it
          // in amber on its "Marked beside the verdict" line.
          const tone = pressure.key === 'positive'
            ? 'bg-emerald-50 text-emerald-800 ring-emerald-200'
            : 'bg-rose-50 text-rose-800 ring-rose-200';
          return `${pill}<span class="ml-1 inline-flex items-center rounded px-1 py-px text-[10px] font-medium ring-1 ${tone}" `
            + `title="${escapeHtml(`${pressure.label} — ${pressure.notableReason} ${pressure.detail} ${pressure.implication} This does not change the verdict.`)}">`
            + `${escapeHtml(pressure.key === 'positive' ? 'flow ↑' : 'flow ↓')}</span>`;
        },
      },
      // There is deliberately no "Distance" column here. It was removed on
      // 20 Aug 2026 because the number it showed was not comparable down its own
      // length, and the column was sortable, which invited exactly that.
      //
      // `distancePct` is the company's free float measured against THE THRESHOLD
      // THAT DECIDED ITS VERDICT — and that threshold is a different number on
      // almost every row. Measured on the committed record:
      //
      //     likely/possible-inclusion   vs ₹4,000 Cr      88 companies
      //     exclusion-risk / likely     vs ₹2,000 Cr      28 companies
      //     migration up / down         vs ₹26,951 Cr     32 companies
      //     stable                      vs ₹2,400 Cr     554 companies
      //     stable                      vs ₹3,500 Cr     500 companies
      //
      // So one column divided by five different denominators, ranged from -99.8%
      // to +46,136.9%, and sorted them together. Sorted descending it put the
      // largest inclusion candidates on top — which reads as "most likely" and
      // actually means "furthest above the band": Lenskart at +2,092.7% is a
      // company whose free float is 21x the ₹4,000 Cr cut-off, not a company
      // that is 21x as likely to be included.
      //
      // And within any one verdict the denominator IS constant, which makes the
      // ordering a monotone transform of free float. Measured: ordering by
      // distance is IDENTICAL to ordering by free float for all seven verdicts
      // that carry one. The only group where it differs is `stable`, and it
      // differs there only because that group interleaves the two denominators
      // above. Redundant where it was coherent; incoherent where it was not.
      //
      // The per-row sensitivity it existed to show (DATA-CONTRACTS weakness #4)
      // lives in the drill panel, where the rules table states each threshold
      // and its value beside the comparison, and in the CSV export, which now
      // carries the threshold value next to the percentage.
      {
        label: 'Free float (₹ Cr)',
        align: 'right',
        html: true,
        sortValue: (row) => liveView(row).freeFloatMcapInr,
        get: (row) => {
          const view = liveView(row);
          if (view.freeFloatMcapInr === null) return missing('no free-float reading from either exchange');
          // The title carries what the exchange published at capture, the price
          // in force and its date, so a reader can always tell whether the
          // figure moved because the stock moved or because the source did.
          const title =
            `${view.live ? 'Live' : 'End-of-day'} ${view.exchange} price ${num(view.price, 2)}`
            + `${view.priceDate ? ` on ${shortDate(view.priceDate)}` : ''}`
            + `${view.staleDays > 0 ? ` — carried forward ${view.staleDays} day(s); this stock did not trade` : ''}`
            + `. ${view.basis ?? ''}`
            + `. Published at capture: ${row.freeFloatMcapAtCaptureInr === null ? 'no reading' : `₹${cr(row.freeFloatMcapAtCaptureInr)} Cr`}.`;
          // ⚠ INLINE FLOW, NOT `inline-flex`. A cell whose whole content is one
          // atomic inline box has nothing for `text-overflow` to replace, so a
          // squeezed column cuts it clean: `10,99,757` renders as `10,99,75`,
          // which is a wrong number that looks like a right one. Measured; see
          // the column-layout header in ui/screener.js.
          return (
            `<span class="whitespace-nowrap" title="${escapeHtml(title)}">`
            + `<span class="font-semibold ${view.live ? 'text-emerald-700' : 'text-slate-900'}">${escapeHtml(cr(view.freeFloatMcapInr))}</span>`
            + sourceChip(row.floatSource) + priceChip(view) + '</span>'
          );
        },
      },
      {
        label: 'Day %',
        align: 'right',
        html: true,
        sortValue: (row) => liveView(row).dayChangePct,
        get: (row) => {
          const view = liveView(row);
          // A stock that did not trade has NO day change. Not 0.0%.
          if (view.dayChangePct === null) {
            return missing(
              view.tier === 'stale'
                ? 'did not trade — no day change, which is not the same as unchanged'
                : 'no previous close to compare against',
            );
          }
          const tone = view.dayChangePct > 0 ? 'text-emerald-700' : view.dayChangePct < 0 ? 'text-rose-700' : 'text-slate-500';
          return `<span class="${tone} font-semibold">${escapeHtml(dayChange(view.dayChangePct))}</span>`;
        },
      },
      // ── The desk's baseline: since the last rebalance ──────────────────
      //
      // ⚠ EVIDENCE, NOT A VERDICT INPUT. A migration verdict turns on a rank by
      // free-float market cap, and free float is factor x shares x price — so
      // today's rank ALREADY contains every price move these columns measure.
      // Letting them move the verdict would count the same evidence twice, and
      // `verify-data` sweeps the reading across its whole plausible range to
      // prove the verdict multiset cannot move. CLAUDE.md 2.12.1.
      //
      // THREE COLUMNS, NOT ONE. The single "vs segment %" column that stood here
      // put both legs in a tooltip, so a reader could see the answer and not the
      // arithmetic — and could not tell a stock that fell 2% against a flat index
      // from one that rose 8% against an index up 10%. Those are the same delta
      // and they are not the same event. 2.1: a reader must be able to
      // reconstruct a derived number from what is on screen.
      //
      // The tone is applied to the DELTA only, and only where the reading is
      // robust — where the whole sensitivity span clears the desk's band.
      // Colouring a fragile reading would state a direction the measurement does
      // not support.
      ...relativeColumns(),
      {
        label: 'Float %',
        align: 'right',
        html: true,
        sortValue: (row) => row.floatFactor,
        get: (row) =>
          row.floatFactor === null
            ? missing('published free-float market cap; no factor derivable')
            : escapeHtml(factorPct(row.floatFactor)),
      },
      {
        label: 'Full mcap (₹ Cr)',
        align: 'right',
        html: true,
        sortValue: (row) => row.fullMcapInr,
        get: (row) =>
          row.fullMcapInr === null ? missing('no full market cap from BSE') : escapeHtml(cr(row.fullMcapInr)),
      },
      ...FUND_ORDER.map((id) => {
        const label = data.fundCoverage(id)?.shortName ?? id;
        return {
          label: `${label} wt %`,
          align: 'right',
          html: true,
          // null is NOT HELD. It must never become 0: a 0.000% weight and
          // "not in this fund" are nearly opposite facts on a screen about
          // index inclusion.
          sortValue: (row) => row.funds?.[id]?.weightPct ?? null,
          get: (row) => {
            const holding = row.funds?.[id];
            return holding
              ? escapeHtml(pct(holding.weightPct, 3))
              : missing(`not held by the ${label} fund`);
          },
        };
      }),
      {
        label: 'Funds',
        align: 'left',
        html: true,
        sortable: true,
        sortValue: (row) => FUND_ORDER.filter((id) => row.funds?.[id]).length,
        get: (row) => {
          const chips = FUND_ORDER.filter((id) => row.funds?.[id]).map((id) =>
            fundChip(id, data.fundCoverage(id)?.shortName ?? id, {
              title: `Held by the ${data.fundCoverage(id)?.shortName ?? id} fund`,
            }),
          );
          // Inline flow, not `flex` — a squeezed flex box wraps to a second line
          // and drops a fund chip with nothing to say it did. Losing a chip is
          // losing the fact that a fund holds the company.
          return chips.length
            ? `<span class="whitespace-nowrap">${chips.join(' ')}</span>`
            : '<span class="text-[11px] text-slate-400" title="Not held by any of the three funds — a candidate, not a position">candidate</span>';
        },
      },
    ];

    // Both notes are DERIVED from the rows on screen, never typed. A filter
    // that can only ever return nothing has to say so where the reader sets it,
    // or an empty table reads as a finding instead of a structure.
    const heldByAll = rows.filter((row) => FUND_ORDER.every((id) => Boolean(row.funds?.[id]))).length;
    const fundNote =
      'The EM ETF tracks the standard segment and the two small-cap funds track small caps, so the segments are ' +
      'mutually exclusive: a company can be in the EM ETF or in the small-cap funds, never both. ' +
      `On the record as it stands, “held by all three” matches ${num(heldByAll)} of ${num(rows.length)} companies — ` +
      'that is the structure of the funds, not a gap in the data.';

    table = scoreTable({
      rows,
      key: data.keyOf,
      name: (row) => row.name,
      sub: (row) =>
        [
          row.nseSymbol ? `<span class="font-semibold text-slate-600">${escapeHtml(row.nseSymbol)}</span>` : '',
          row.sector ? escapeHtml(row.sector) : '',
        ]
          .filter(Boolean)
          .join(' · '),
      searchText: (row) => `${row.name ?? ''} ${row.nseSymbol ?? ''} ${row.isin ?? ''} ${row.bseScripCode ?? ''}`,
      searchable: true,
      searchPlaceholder: 'Search name, NSE symbol or ISIN',
      columns,
      showRank: false,
      showAvatar: true,
      dense: true,
      wrapHeads: true,
      nameMaxPx: 300,
      nameHeading: 'Company',
      nameAfter: (row) => watchStar(data.keyOf(row)),
      stickyHead: 'max(320px, calc(100vh - 320px))',
      // Column widths and hidden columns persist under this key. Eleven
      // columns is more than most desks read at once, and a reader who never
      // touches the controls gets exactly the layout that shipped.
      columnsKey: 'companies',
      initialSort: { key: 'Free float (₹ Cr)', dir: 'desc' },
      initialView: lastView,
      exportName: 'sattva-companies',
      rowCountLabel: (shown, total) => `${num(shown)} of ${num(total)} rows`,
      filters: [
        {
          id: 'fund',
          label: 'Fund',
          allLabel: 'Any fund status',
          note: fundNote,
          options: [
            ...FUND_ORDER.map((id) => ({
              value: id,
              label: `in ${data.fundCoverage(id)?.shortName ?? id}`,
              match: (row) => Boolean(row.funds?.[id]),
            })),
            { value: 'any', label: 'held by any', match: (row) => row.held === true },
            {
              value: 'all',
              label: 'held by all',
              // Every fund, not "more than one". The note above states what that
              // currently matches so the reader is never left reading an empty
              // table as evidence about the companies.
              match: (row) => FUND_ORDER.every((id) => Boolean(row.funds?.[id])),
            },
          ],
        },
        marketCapRange(rows),
        {
          id: 'verdict',
          label: 'Verdict',
          allLabel: 'Any verdict',
          options: Object.keys(VERDICTS).map((key) => ({
            value: key,
            label: VERDICTS[key].label,
            match: (row) => assessmentFor(row)?.verdict === key,
          })),
        },
        {
          id: 'watch',
          label: 'Watchlist',
          allLabel: 'All companies',
          options: [{ value: 'on', label: 'watchlist only', match: (row) => state.isWatched(data.keyOf(row)) }],
        },
      ],
      onViewChange: (view) => {
        lastView = { q: view.q, sort: view.sort, filters: { ...view.filters } };
        setParams({ q: view.q || null });
      },
      onRowClick: (key) => {
        setParams({ company: key });
        openCompanyDrill(key);
      },
      onRowAction: (action, key) => {
        if (action !== 'watch') return;
        state.toggleWatch(key);
        // The row's cached markup AND its live node must both be refreshed.
        // Dropping the cache entry alone does nothing here, because a repaint
        // that keeps the row set moves existing nodes instead of re-parsing —
        // so the star would stay hollow for ever while the filter, the export
        // and a reload all agreed it was starred.
        table.updateRows(key);
        if (table.view.filters.watch) table.refresh();
      },
      onExport: (visibleRows, view) => {
        const fresh = data.freshness();
        exportCsv({
          filename: `sattva-companies-${state.getMethodology()}-${new Date().toISOString().slice(0, 10)}.csv`,
          freshness: fresh,
          // Row 1 of the workbook has to say WHICH MODEL produced the verdicts
          // in it. Two exports of the same universe can now disagree on every
          // verdict column, and a sheet that does not name its methodology is a
          // sheet nobody can reconcile against another (CLAUDE.md §2.7).
          scopeLabel:
            `${visibleRows.length} of ${cov.companies} companies in the record · model: `
            + `${METHODOLOGIES[state.getMethodology()].label} (${METHODOLOGIES[state.getMethodology()].short}) — `
            + `${METHODOLOGIES[state.getMethodology()].attribution}`,
          // WHAT THE FILTERS ACTUALLY DID, in words. This used to serialise the
          // view as `band=mcap-30k-70k`, which names an internal id, carries no
          // unit and cannot be read by anyone who did not see the screen — and
          // a typed range would have been worse, since `mcap=[object Object]`
          // is what a raw entry serialises to. The table describes its own
          // filters, including a range it could NOT read, because a file that
          // stayed silent about that would contradict the screen it came from
          // (CLAUDE.md §2.7).
          filterLabel: [view.q ? `search “${view.q}”` : '', table.filterSummary()]
            .filter(Boolean)
            .join('; '),
          rows: visibleRows,
          columns: [
            { label: 'Name', value: (r) => r.name },
            { label: 'NSE symbol', value: (r) => r.nseSymbol ?? '' },
            { label: 'BSE scrip code', value: (r) => r.bseScripCode ?? '' },
            { label: 'ISIN', value: (r) => r.isin ?? '' },
            { label: 'Sector', value: (r) => r.sector ?? '' },
            { label: 'Free float (INR Cr)', value: (r) => (r.freeFloatMcapInr === null ? '' : toCrore(r.freeFloatMcapInr).toFixed(2)) },
            { label: 'Free float source', value: (r) => r.floatSource ?? '' },
            { label: 'Free float basis', value: (r) => r.freeFloatBasis ?? '' },
            { label: 'Float factor', value: (r) => (r.floatFactor === null ? '' : r.floatFactor) },
            { label: 'Float factor NSE', value: (r) => (r.floatFactorNse === null ? '' : r.floatFactorNse) },
            { label: 'Float factor BSE', value: (r) => (r.floatFactorBse === null ? '' : r.floatFactorBse) },
            { label: 'Full mcap (INR Cr)', value: (r) => (r.fullMcapInr === null ? '' : toCrore(r.fullMcapInr).toFixed(2)) },
            { label: 'Shares outstanding', value: (r) => r.sharesOutstanding ?? '' },
            { label: 'Price', value: (r) => liveView(r).price ?? '' },
            { label: 'Price exchange', value: (r) => liveView(r).exchange ?? '' },
            { label: 'Price tier', value: (r) => liveView(r).tier ?? '' },
            { label: 'Price date', value: (r) => liveView(r).priceDate ?? (liveView(r).live ? 'live, this session' : '') },
            { label: 'Price carried forward (days)', value: (r) => liveView(r).staleDays ?? '' },
            { label: 'Day change %', value: (r) => liveView(r).dayChangePct ?? '' },
            { label: 'Free float published at capture (INR Cr)', value: (r) => (r.freeFloatMcapAtCaptureInr === null ? '' : toCrore(r.freeFloatMcapAtCaptureInr).toFixed(2)) },
            { label: 'Avg daily volume (shares)', value: (r) => r.advQty ?? '' },
            { label: 'Avg daily volume source', value: (r) => r.advSource ?? '' },
            ...FUND_ORDER.map((id) => ({
              label: `${data.fundCoverage(id)?.shortName ?? id} weight drift pp (price only, no trade required)`,
              value: (r) => r.passiveDrift?.[id]?.driftPp ?? '',
            })),
            { label: 'Verdict (modelled, not MSCI)', value: (r) => VERDICTS[assessmentFor(r)?.verdict ?? 'unknown']?.label ?? '' },
            { label: 'Segment', value: (r) => SEGMENTS[assessmentFor(r)?.segment ?? 'outside']?.label ?? '' },
            // 2.7: provenance must survive an export. A bare "distance %" in a
            // spreadsheet is a column somebody WILL sort, and every row measured
            // it against a different threshold — so the threshold travels beside
            // it, by name and by value.
            { label: 'Distance to threshold % (measured against its OWN threshold — not comparable across rows)',
              value: (r) => assessmentFor(r)?.distancePct ?? '' },
            // ⚠ THE RULE THE DISTANCE NAMES, NOT THE LAST ONE PUSHED, AND ITS
            // OWN UNIT. These columns read rulesFired[length - 1] under a
            // hard-coded "₹ Cr" header. Both were wrong: a rank rule's
            // threshold is a COUNT of companies, and 165 of them went through
            // toCrore and exported as "0" beside a header asserting rupees. The
            // export is where a mislabelled unit is least recoverable, because
            // the sheet leaves the page with none of its chrome.
            { label: 'Threshold it was measured against', value: (r) => distanceRule(r)?.label ?? '' },
            { label: 'Threshold value', value: (r) => {
              const rule = distanceRule(r);
              if (!rule || rule.threshold === null || rule.threshold === undefined) return '';
              return rule.unit === 'inr' ? Math.round(toCrore(rule.threshold)) : rule.threshold;
            } },
            { label: 'Threshold unit', value: (r) => THRESHOLD_UNIT_LABEL[distanceRule(r)?.unit] ?? '' },
            { label: 'Threshold source', value: (r) => {
              const rule = distanceRule(r);
              return rule ? (THRESHOLD_SOURCE[rule.thresholdSource]?.label ?? rule.thresholdSource) : '';
            } },
            { label: 'Rules fired', value: (r) => (assessmentFor(r)?.rulesFired ?? []).map((x) => `${x.label}: ${x.result}`).join(' | ') },
            // 2.7: the reading is useless in a sheet without its window, its
            // benchmark, its span and its reason for being absent. Every one of
            // those is a column, because a workbook leaves with no chrome.
            { label: 'vs segment % (geometric, this company against its benchmark)',
              value: (r) => r.relativePerformance?.relativePct ?? '' },
            { label: 'vs segment: this company %', value: (r) => r.relativePerformance?.stockPct ?? '' },
            { label: 'vs segment: benchmark', value: (r) => r.relativePerformance?.benchmarkSymbol ?? '' },
            { label: 'vs segment: benchmark % in rupees', value: (r) => r.relativePerformance?.indexPct ?? '' },
            { label: 'vs segment: across all ten possible days, low %',
              value: (r) => r.relativePerformance?.envelope?.[0] ?? '' },
            { label: 'vs segment: across all ten possible days, high %',
              value: (r) => r.relativePerformance?.envelope?.[1] ?? '' },
            { label: 'vs segment: direction holds whichever day MSCI priced on',
              value: (r) => (r.relativePerformance?.relativePct == null ? '' : (r.relativePerformance.robust ? 'yes' : 'no')) },
            { label: 'vs segment: adjusted for a corporate action',
              value: (r) => (r.relativePerformance?.actionsApplied ?? [])
                .map((a) => `${a.purpose} on ${a.exDate} (price ÷ ${a.priceFactor})`).join('; ') },
            { label: 'vs segment: no reading because',
              value: (r) => (r.relativePerformance && r.relativePerformance.relativePct === null
                ? `${r.relativePerformance.label}: ${r.relativePerformance.reason}` : '') },
            { label: 'Trend signal (modelled, does not change the verdict)',
              value: (r) => { const t = trendFor(r); return t ? `${t.label} — ${t.detail}` : ''; } },
            // ── The desk's baseline: since the last rebalance ─────────────
            // Every column names the baseline in its own heading. A sheet
            // carrying two "vs segment" families measured over two different
            // windows, with only one of them saying which, is how a reader
            // sorts one and reads the other.
            ...(() => {
              const context = data.rebalanceBaselines();
              const meta = context ? data.baselineMeta(activeBaseline()) : null;
              const since = meta ? (meta.resolvedDate ?? meta.effectiveDate) : 'the rebalance date';
              const to = context?.latestDate ?? 'the latest close';
              const tag = `since ${since}`;
              const read = (r) => { const x = rebaseFor(r); return x === undefined ? null : x; };
              return [
                { label: `Baseline rebalance date (${meta?.label ?? 'none on the record'})`, value: () => since },
                { label: 'Baseline measured to', value: () => to },
                { label: `Index return % in rupees, ${tag}`, value: (r) => read(r)?.indexPct ?? '' },
                { label: `Index return: benchmark, ${tag}`, value: (r) => read(r)?.benchmarkSymbol ?? '' },
                { label: `Stock return %, ${tag}`, value: (r) => read(r)?.stockPct ?? '' },
                { label: `Delta vs index % (geometric), ${tag}`, value: (r) => read(r)?.relativePct ?? '' },
                { label: `Delta: sensitivity low % (baseline shifted a session either side), ${tag}`,
                  value: (r) => read(r)?.sensitivity?.[0] ?? '' },
                { label: `Delta: sensitivity high %, ${tag}`, value: (r) => read(r)?.sensitivity?.[1] ?? '' },
                { label: `Delta: direction survives shifting the baseline, ${tag}`,
                  value: (r) => { const x = read(r); return x?.relativePct == null ? '' : (x.robust ? 'yes' : 'no'); } },
                { label: `Adjusted for a corporate action, ${tag}`,
                  value: (r) => (read(r)?.actionsApplied ?? [])
                    .map((a) => `${a.purpose} on ${a.exDate} (price ÷ ${a.priceFactor})`).join('; ') },
                { label: `No reading because, ${tag}`,
                  value: (r) => {
                    const x = read(r);
                    if (!x) return 'this baseline was not loaded when the file was exported';
                    if (x.relativePct !== null) return '';
                    const named = REBASE_STATES[x.state];
                    return `${named?.label ?? x.state}: ${named?.detail ?? ''}`.trim();
                  } },
                { label: 'Flow pressure (modelled, does not change the verdict)',
                  value: (r) => { const x = pressureFor(r); return x ? `${x.label} — ${x.implication}` : ''; } },
                { label: 'Flow pressure: marked beside the verdict because',
                  value: (r) => pressureFor(r)?.notableReason ?? '' },
              ];
            })(),
            { label: 'Share count quarantined', value: (r) => (r.shareCountQuarantine ? 'yes' : '') },
            ...FUND_ORDER.map((id) => ({
              label: `${data.fundCoverage(id)?.shortName ?? id} estimated flow INR Cr (modelled)`,
              value: (r) => flowsFor(r).flows.find((f) => f.fundId === id)?.flowCrore ?? '',
            })),
            ...FUND_ORDER.map((id) => ({
              label: `${data.fundCoverage(id)?.shortName ?? id} flow days of volume`,
              value: (r) => flowsFor(r).flows.find((f) => f.fundId === id)?.daysOfAdv ?? '',
            })),
            { label: 'Flow basis', value: (r) => flowsFor(r).flows.map((f) => `${f.fundShortName} ${f.direction}: ${f.certainty}`).join(' | ') },
            { label: 'Not sampled by', value: (r) => flowsFor(r).notSampled.map((n) => n.fundShortName).join(' | ') },
            ...FUND_ORDER.map((id) => ({
              label: `${data.fundCoverage(id)?.shortName ?? id} weight % (of that fund only)`,
              value: (r) => r.funds?.[id]?.weightPct ?? '',
            })),
            { label: 'Resolution method', value: (r) => r.resolution?.method ?? '' },
          ],
        });
      },
    });

    const tableHost = el('div', { html: table.html });
    host.append(tableHost);
    table.wire(tableHost);

    // Reopen a drill named in the URL, after the paint that can host it.
    const fromUrl = getParam('company');
    if (fromUrl && data.byIsin(fromUrl)) openCompanyDrill(fromUrl);
  }

  build();

  /**
   * A STORED BASELINE OVERRIDE IS NOT IN MEMORY YET, AND NOTHING ELSE FETCHES IT.
   *
   * The alternates live in their own file and are fetched on demand — by the
   * picker's own change handler, which is the only caller. A reader who re-based
   * yesterday has the review in localStorage and the file in nobody's memory, so
   * `readingFor` returns `undefined` for every row and the three columns render
   * "this baseline is still loading" for ever, under a heading naming the
   * baseline they chose. Measured before this: 0 flow chips and 1,265 em dashes
   * after a reload on the August 2025 baseline.
   *
   * The first paint above is correct either way — it shows the loading state,
   * which is true at that moment. This resolves it.
   */
  const storedBaseline = activeBaseline();
  if (storedBaseline && storedBaseline !== data.rebalanceBaselines()?.defaultReview) {
    data.ensureBaseline(storedBaseline)
      .then((ready) => {
        if (ready) { build(); return; }
        throw new Error('that baseline is not in the record');
      })
      .catch((error) => {
        // A baseline that cannot be loaded must not leave the screen claiming
        // it. Falling back to the default is the only coherent answer — the
        // picker then shows where the numbers actually came from.
        console.error('[baseline] stored override could not be loaded; falling back to the default', error);
        state.setBaseline(null);
      });
  }

  /**
   * A price landing must not disturb the reader.
   *
   * `updateRows(keys)` swaps exactly the affected <tr> nodes in place, so the
   * search box, the filters, the sort order and the watchlist all survive a
   * tick. A full rebuild here would throw away whatever the reader had set up,
   * every thirty seconds, which is how a live table becomes unusable.
   *
   * A price change is NOT a structural change: only a change to the row SET
   * rebuilds. The one exception is a filter that depends on price — none does
   * today, and if one is added it must call refresh() deliberately.
   */
  quotes.onQuotes((event) => {
    if (event.type !== 'tick') {
      refreshHeaderStatus();
      return;
    }
    if (!table) { refreshHeaderStatus(); return; }

    // A price move changes free-float market cap, which can move a company
    // across a threshold. So the model is re-run — the WHOLE context, because a
    // rank crossing is a comparison against every other company and one row
    // re-assessed against a stale ranking would be wrong in exactly the cases
    // this exists to catch. O(n log n) on 1,202 rows, once per tick.
    const before = new Map(data.all().map((c) => [data.keyOf(c), assessmentFor(c)?.verdict ?? null]));
    rebuildModel();

    const verdictChanged = [];
    for (const company of data.all()) {
      const key = data.keyOf(company);
      if (before.get(key) !== (assessmentFor(company)?.verdict ?? null)) verdictChanged.push(key);
    }

    // Repaint price changes AND verdict changes — a row whose verdict flipped
    // has a stale pill even if its price cell happened not to move.
    const changed = [...new Set([...(event.changed ?? []), ...verdictChanged])];
    if (changed.length) table.updateRows(changed);

    // A verdict flip can change the ROW SET when the verdict filter is on, and
    // that IS a structural change — the only one a tick may cause.
    if (verdictChanged.length && table.view.filters.verdict) table.refresh();

    // The stat strip counts verdicts, so it goes stale on a flip.
    if (verdictChanged.length) repaintStats();

    refreshHeaderStatus();
    const open = getParam('company');
    if (open && changed.includes(open)) openCompanyDrill(open);
  });

  /**
   * Keep the drill in step with the URL.
   *
   * The panel is mirrored into `?company=<ISIN>` so a row can be shared, which
   * only means anything if arriving at that URL — by paste, by Back, or by
   * reload — actually opens the panel. Without this the link works on a cold
   * load and silently does nothing on a hash change, which is the case a reader
   * hits first when they press Back.
   */
  onRoute(() => {
    const key = getParam('company');
    if (key && data.byIsin(key)) openCompanyDrill(key);
    else closeDrill();
  });

  /**
   * Which symbols a live tick should spend its budget on.
   *
   * ---------------------------------------------------------------------------
   * THE BUDGET IS ONE WAVE, SO THE ORDER IS THE WHOLE DECISION
   * ---------------------------------------------------------------------------
   * The Worker answers one wave of symbols per request and says what it left
   * out. Asking for the full 1,218-name book took 169 seconds and delivered
   * nothing, because the browser gave up at 25 — see the header of
   * data/quotes.js. So the question is no longer "how many" but "which".
   *
   * In priority order:
   *   1. the watchlist — a reader has said in as many words that these matter;
   *   2. the open drill — the one company being read right now;
   *   3. the top of the table AS CURRENTLY SORTED AND FILTERED, which is what a
   *      reader is actually looking at.
   *
   * Row order comes from the DOM rather than from a re-run of the table's own
   * filter and sort. Re-deriving it here would be a second implementation of
   * that logic, free to drift from the one the reader can see — and the whole
   * point is to quote what is on screen.
   */
  const liveSymbolPriority = () => {
    const bySymbol = [];
    const push = (key) => {
      const company = data.byIsin(key);
      if (company?.nseSymbol) bySymbol.push(company.nseSymbol);
    };
    for (const key of state.watchlist()) push(key);
    const open = getParam('company');
    if (open) push(open);
    for (const node of document.querySelectorAll('tbody tr[data-key]')) push(node.dataset.key);
    return bySymbol;
  };
  quotes.setQuotePriority(liveSymbolPriority);

  // A methodology switch rebuilds the whole view: every verdict, every rule
  // and every flow can change. The reader's search, sort and filters are
  // carried across deliberately — the comparison is only useful if the two
  // models are seen through the same lens.
  state.on('methodology', () => {
    closeDrill();
    lastView = table?.view ? { q: table.view.q, sort: table.view.sort, filters: { ...table.view.filters } } : null;
    setParams({ model: state.getMethodology() });
    build();
  });

  // A baseline switch rebuilds for the same reason: three columns, every flow
  // pressure and every chip beside a verdict are measured from it. No VERDICT
  // moves — that is the point — but every number that depends on the baseline
  // does, and a partial repaint would leave the two disagreeing on screen.
  state.on('rebalanceBaseline', () => {
    closeDrill();
    lastView = table?.view ? { q: table.view.q, sort: table.view.sort, filters: { ...table.view.filters } } : null;
    build();
  });

  return {
    rebuild: build,
    table: () => table,
    openCompany: (key) => openCompanyDrill(key),
    // The assessment in force, so the harness reads the SAME function the table
    // renders from rather than recomputing and possibly agreeing by accident.
    assessmentFor,
    otherAssessmentFor,
    methodologyDelta,
  };
}

export { openCompanyDrill };
