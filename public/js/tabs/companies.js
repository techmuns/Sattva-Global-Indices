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
import { segmentedToggle } from '../ui/components.js';
import { sectionHead, statStrip, scoreTable, openDrill, closeDrill } from '../ui/screener.js';
import { sourceChip, fundChip, missing } from '../ui/visual.js';
import { exportCsv } from '../ui/export.js';
import { REVIEW_THRESHOLDS, crore, toCrore, MARKET_CAP_FILTER_BANDS, MARKET_CAP_FILTER_ATTRIBUTION } from '../config/thresholds.mjs';
import { observedBoundary, rankByFreeFloat, THRESHOLD_SOURCE } from '../model/thresholds.js';
import { segmentOf, segmentFloatTotals, SEGMENTS } from '../model/segments.js';
import { assess, VERDICTS, DISCLOSURE, TRADE_IMPLYING } from '../model/assess.js';
import { estimateFlows } from '../model/flows.js';
import { nextReview, reviewCutoffs } from '../model/calendar.js';
import { gimiCutoffs, assessGimi, reviewWindow, METHODOLOGIES, GIMI_DISCLOSURE, CUTOFF_DISCLOSURE } from '../model/gimi.js';

const FUND_ORDER = ['eem', 'smin', 'eems'];

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
  const context = { boundary, ranks, quarantined, keyOf: data.keyOf };
  const flowContext = { flowPrimitives: data.flowPrimitives(), segmentFloatTotals: floatTotals };

  const cutoffs = gimiCutoffs(live);
  const window = reviewWindow(data.freshness().feeds.find((f) => f.id === 'bhavcopy')?.raw ?? null);
  const gimiContext = { cutoffs, quarantined, keyOf: data.keyOf, window };

  for (const company of live) {
    const key = data.keyOf(company);
    const assessment = assess(company, context);
    assessments.set(key, assessment);
    gimiAssessments.set(key, assessGimi(company, gimiContext));
    // Flows follow the ACTIVE methodology's verdict, which is why they are
    // rebuilt when the toggle moves rather than cached against one model.
    flows.set(key, estimateFlows(company, assessment, flowContext));
  }

  modelState = {
    boundary, ranks, floatTotals, assessments, gimiAssessments, flows,
    cutoffs, window, builtAt: new Date(),
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

/** The same company under the OTHER methodology, for side-by-side comparison. */
export const otherAssessmentFor = (company) =>
  assessmentFor(company, state.getMethodology() === 'gimi' ? 'freefloat' : 'gimi');

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
 * The market-cap buckets the size filter offers, READ FROM THE THRESHOLD
 * MODULE, never from literals here.
 *
 * These are FULL market cap and they are a navigation aid — wide, round ranges
 * that between them cover the whole tracked universe. They are NOT the desk's
 * review cut-offs: those are about free float, they are narrow, and they drive
 * verdicts. Nothing in the model reads these.
 *
 * A company with no market-cap reading matches NO band, in either direction.
 * It is not a small company; it is a company we have not measured, and putting
 * it in the bottom bucket would report an absence as a fact (CLAUDE.md §2.3).
 */
function sizeBands() {
  const band = (min, max) => (row) => {
    const value = row.fullMcapInr;
    if (value === null || value === undefined) return false; // no reading is not a band
    return (min === null || value >= min) && (max === null || value < max);
  };
  // Local, because `cr` from ../core/format.js is the table cell formatter and
  // shadowing it here would make two different formatters share one name.
  const crLabel = (rupees) => num(toCrore(rupees));
  return MARKET_CAP_FILTER_BANDS.map((b) => ({
    value: b.id,
    label:
      b.minInr === null
        ? `< ₹${crLabel(b.maxInr)} Cr`
        : b.maxInr === null
          ? `≥ ₹${crLabel(b.minInr)} Cr`
          : `₹${crLabel(b.minInr)}–${crLabel(b.maxInr)} Cr`,
    match: band(b.minInr, b.maxInr),
  }));
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
    `<div class="rounded-xl bg-white/70 px-3 py-2 ring-1 ring-inset ${isGimi ? 'ring-indigo-200' : 'ring-slate-200'}"${title ? ` title="${escapeHtml(title)}"` : ''}>`
    + `<div class="text-[10px] font-bold uppercase tracking-wide ${isGimi ? 'text-indigo-700' : 'text-slate-500'}">${escapeHtml(label)}</div>`
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
    + '<div class="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-3">'
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
      const line = (f) => {
        const r = f.sinceLastReview?.inrPct;
        if (r === null || r === undefined) return '';
        const tone = r >= 0 ? 'text-emerald-700' : 'text-rose-700';
        return '<div class="flex items-baseline justify-between gap-3 text-xs">'
          + `<span class="font-semibold text-slate-700">${escapeHtml(f.symbol)}</span>`
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
          return verdictPill(assessment.verdict, {
            title: quarantine
              ? `Unknown: ${quarantine.reason}`
              : `${VERDICTS[assessment.verdict]?.detail ?? ''} ${DISCLOSURE}`,
          });
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
          return (
            `<span class="inline-flex items-center justify-end gap-1" title="${escapeHtml(title)}">`
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
          return chips.length
            ? `<span class="flex flex-wrap gap-1">${chips.join('')}</span>`
            : '<span class="text-[11px] text-slate-400" title="Not held by any of the three funds — a candidate, not a position">candidate</span>';
        },
      },
    ];

    // Both notes are DERIVED from the rows on screen, never typed. A filter
    // option that can only ever return nothing has to say so where the reader
    // chooses it, or an empty table reads as a finding instead of a structure.
    const bandedRows = rows.filter((row) => row.fullMcapInr !== null && row.fullMcapInr !== undefined);
    const bandNote =
      `${MARKET_CAP_FILTER_ATTRIBUTION} ` +
      `${num(bandedRows.length)} of ${num(rows.length)} companies carry a market-cap reading and fall in a band; ` +
      `the other ${num(rows.length - bandedRows.length)} have no reading and match no band in either direction.`;

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
        {
          id: 'band',
          label: 'Market cap',
          allLabel: 'Any market cap',
          note: bandNote,
          options: sizeBands(),
        },
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
          filterLabel: [
            view.q ? `search "${view.q}"` : '',
            ...Object.entries(view.filters)
              .filter(([, v]) => v)
              .map(([k, v]) => `${k}=${v}`),
          ]
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
            { label: 'Threshold it was measured against', value: (r) => {
              const rules = assessmentFor(r)?.rulesFired ?? [];
              const last = rules[rules.length - 1];
              return last?.label ?? '';
            } },
            { label: 'Threshold value ₹ Cr', value: (r) => {
              const rules = assessmentFor(r)?.rulesFired ?? [];
              const last = rules[rules.length - 1];
              return last?.threshold === null || last?.threshold === undefined ? '' : Math.round(toCrore(last.threshold));
            } },
            { label: 'Threshold source', value: (r) => {
              const rules = assessmentFor(r)?.rulesFired ?? [];
              const last = rules[rules.length - 1];
              return last ? (THRESHOLD_SOURCE[last.thresholdSource]?.label ?? last.thresholdSource) : '';
            } },
            { label: 'Rules fired', value: (r) => (assessmentFor(r)?.rulesFired ?? []).map((x) => `${x.label}: ${x.result}`).join(' | ') },
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
