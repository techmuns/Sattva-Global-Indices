/**
 * THE master table — the whole v1 view.
 *
 * Company, free float, index participation and weights. The probability of
 * inclusion or exclusion is a later prompt; nothing on this screen is modelled,
 * and the provenance section of the drill says so explicitly rather than
 * leaving a reader to assume.
 */

import { $, el, escapeHtml } from '../core/dom.js';
import { cr, inr, pct, factorPct, num, shortDate, dayChange, plural, EM_DASH } from '../core/format.js';
import * as data from '../data/companies.js';
import * as state from '../core/state.js';
import * as quotes from '../data/quotes.js';
import { setParams, getParam, onRoute } from '../core/router.js';
import { segmentedToggle } from '../ui/components.js';
import { sectionHead, statStrip, scoreTable, openDrill, closeDrill } from '../ui/screener.js';
import { sourceChip, fundChip, missing } from '../ui/visual.js';
import { exportCsv } from '../ui/export.js';
import { REVIEW_THRESHOLDS, crore, toCrore } from '../config/thresholds.mjs';

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
 * The desk's size bands, READ FROM THE THRESHOLD MODULE, never from literals.
 *
 * These are the desk's own inclusion/exclusion heuristics. MSCI derives its
 * size cut-offs globally at each review and does not publish these rupee
 * figures, so the filter group says so where the reader will see it.
 */
function sizeBands() {
  const inc = REVIEW_THRESHOLDS.inclusion;
  const exc = REVIEW_THRESHOLDS.exclusion;
  const band = (min, max) => (row) => {
    const value = row.freeFloatMcapInr;
    if (value === null || value === undefined) return false; // no reading is not a band
    return (min === null || value >= min) && (max === null || value < max);
  };
  return [
    { value: 'above-inclusion', label: `≥ ₹${num(toCrore(inc.highInr))} Cr`, match: band(inc.highInr, null) },
    { value: 'inclusion-band', label: `₹${num(toCrore(inc.lowInr))}–${num(toCrore(inc.highInr))} Cr`, match: band(inc.lowInr, inc.highInr) },
    { value: 'middle', label: `₹${num(toCrore(exc.highInr))}–${num(toCrore(inc.lowInr))} Cr`, match: band(exc.highInr, inc.lowInr) },
    { value: 'exclusion-band', label: `₹${num(toCrore(exc.lowInr))}–${num(toCrore(exc.highInr))} Cr`, match: band(exc.lowInr, exc.highInr) },
    { value: 'below-exclusion', label: `< ₹${num(toCrore(exc.lowInr))} Cr`, match: band(null, exc.lowInr) },
  ];
}

/* ────────────────────────────────────────────────────────────────────────────
 * Stat strip
 * ──────────────────────────────────────────────────────────────────────────── */

function buildStats(scopeRows, scope) {
  const cov = data.coverage();
  const total = cov.companies ?? null;
  const inView = scopeRows.length;

  const withFloatInView = scopeRows.filter((c) => c.freeFloatMcapInr !== null).length;
  const nseInView = scopeRows.filter((c) => c.floatSource === 'nse').length;
  const bseInView = scopeRows.filter((c) => c.floatSource === 'bse').length;
  const noneInView = inView - withFloatInView;

  const held = cov.held ?? null;
  const fresh = data.freshness();

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

  const freshnessRows = fresh.feeds
    .map(
      (feed) =>
        '<div class="flex items-baseline justify-between gap-3 text-[11px]">' +
        `<span class="text-white/80">${escapeHtml(feed.label)}</span>` +
        `<span class="font-semibold tabular-nums text-white">${escapeHtml(feed.raw ? shortDate(feed.date ?? feed.raw) : 'no reading')}</span></div>`,
    )
    .join('');

  return statStrip([
    {
      label: 'Companies in view',
      value: total === null ? num(inView) : `${num(inView)} of ${num(total)}`,
      detail:
        scope === 'held'
          ? 'Held by at least one of the three funds'
          : 'Every company in the record, held or not',
      extra:
        cardRow('Held by a fund', num(cov.held)) +
        cardRow('Candidates, not held', num(cov.notHeld)),
      help: {
        title: 'What "in view" counts',
        body:
          '<div class="space-y-3 text-sm leading-relaxed text-slate-600">' +
          `<p>The record holds <strong>${escapeHtml(num(total))}</strong> companies. The scope toggle chooses which of them this table shows.</p>` +
          `<p><strong>Held</strong> is the ${escapeHtml(num(cov.held))} companies at least one fund owns — what must be traded if index weights move.</p>` +
          `<p><strong>All</strong> adds the ${escapeHtml(num(cov.notHeld))} companies above the desk's size floor that no fund owns yet — what could enter at a future review.</p>` +
          '<p class="text-xs text-slate-400">Both counts come from the build that produced the data, not from anything typed here.</p>' +
          '</div>',
      },
    },
    {
      label: 'Free-float coverage',
      value: `${num(withFloatInView)} of ${num(inView)}`,
      detail: `have a reading${noneInView > 0 ? ` · ${num(noneInView)} without` : ''}`,
      extra:
        cardRow('From NSE', num(nseInView)) +
        cardRow('From BSE', num(bseInView)) +
        cardRow('No reading', num(noneInView)),
      help: {
        title: 'Where free float comes from',
        body:
          '<div class="space-y-3 text-sm leading-relaxed text-slate-600">' +
          '<p>Free-float market cap is an <strong>exchange-published figure</strong>. It is never computed from promoter holding — lock-in shares held by VCs and PE firms are not promoter holdings but are not free float either, and the global indices follow the exchanges.</p>' +
          '<div class="space-y-1.5 rounded-xl bg-slate-50 p-3">' +
          `<div class="flex justify-between text-xs"><span class="font-semibold text-slate-700">From NSE</span><span class="tabular-nums text-slate-600">${escapeHtml(num(nseInView))} of ${escapeHtml(num(inView))} in view</span></div>` +
          `<div class="flex justify-between text-xs"><span class="font-semibold text-slate-700">From BSE</span><span class="tabular-nums text-slate-600">${escapeHtml(num(bseInView))} of ${escapeHtml(num(inView))} in view</span></div>` +
          `<div class="flex justify-between text-xs"><span class="font-semibold text-slate-700">No reading</span><span class="tabular-nums text-slate-600">${escapeHtml(num(noneInView))} of ${escapeHtml(num(inView))} in view</span></div>` +
          '</div>' +
          '<p><strong>NSE wins wherever it publishes a reading</strong>, because MSCI follows NSE. BSE fills the gaps. The two apply slightly different float definitions and genuinely disagree, so they are never averaged — where both exist, both stay on the company record and the drill panel shows the gap.</p>' +
          '<p>A company with no reading is <strong>not a company with no float</strong>. It renders as an em dash, is excluded from every total, and never sorts as zero.</p>' +
          '</div>',
      },
    },
    {
      label: 'Index members',
      // Deliberately NOT a summed weight. Three funds' weights have three
      // different denominators; adding them produces a number that means
      // nothing and looks authoritative.
      value: held === null ? EM_DASH : num(held),
      detail: `held by at least one fund · ${plural(FUND_ORDER.length, 'fund')} tracked separately`,
      // Holdings COUNTS per fund. Deliberately not weights: three funds'
      // weights have three denominators and stacking them here would invite
      // exactly the addition this project forbids.
      extra: FUND_ORDER.map((id) => {
        const f = data.fundCoverage(id);
        return f ? cardRow(f.shortName, `${num(f.holdings)} holdings`) : '';
      }).join(''),
      help: {
        title: 'Why there is no total weight here',
        body:
          '<div class="space-y-3 text-sm leading-relaxed text-slate-600">' +
          '<p>A weight is a percentage <em>of the fund it sits inside</em>. The three funds have three different denominators, so summing or averaging their weights produces a figure with no meaning — while looking exactly like a real one.</p>' +
          '<p>So the funds are reported separately, always:</p>' +
          `<div class="space-y-1.5 rounded-xl bg-slate-50 p-3">${fundLines}</div>` +
          '<p class="text-xs text-slate-400">Each line is that fund\'s own India weight and its own coverage. Nothing on this screen adds a number from one row to a number from another.</p>' +
          '</div>',
      },
    },
    {
      hero: true,
      label: 'Data freshness',
      value: fresh.oldest ? shortDate(fresh.oldest.date) : EM_DASH,
      detail: fresh.oldest
        ? `oldest of three feeds — ${fresh.oldest.label}`
        : 'no as-of date could be read',
      extra: freshnessRows,
      help: {
        title: 'Three dates, not one',
        body:
          '<div class="space-y-3 text-sm leading-relaxed text-slate-600">' +
          '<p>This screen joins three independent measurements taken at three different moments. They are shown separately because collapsing them into a single "updated" time would claim the page is as fresh as its newest input, when what actually governs it is the oldest.</p>' +
          '<div class="space-y-2">' +
          fresh.feeds
            .map(
              (feed) =>
                '<div class="rounded-xl bg-slate-50 p-3">' +
                `<div class="flex justify-between gap-3 text-xs"><span class="font-semibold text-slate-800">${escapeHtml(feed.label)}</span>` +
                `<span class="tabular-nums text-slate-600">${escapeHtml(feed.raw ? shortDate(feed.date ?? feed.raw) : 'no reading')}</span></div>` +
                `<p class="mt-1 text-[11px] leading-relaxed text-slate-500">${escapeHtml(feed.detail)}</p></div>`,
            )
            .join('') +
          '</div>' +
          (fresh.oldest
            ? `<p><strong>${escapeHtml(fresh.oldest.label)}</strong> is the oldest, so that is the date this page is honestly current to.</p>`
            : '') +
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
      { title: 'What the exchange published when the monthly float file was captured, kept for comparison' },
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
  } else if (company.floatSource) {
    html +=
      '<p class="mt-2 rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">' +
      `Only ${company.floatSource === 'nse' ? 'NSE' : 'BSE'} publishes a reading for this company, so there is nothing to compare it against.</p>`;
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
    '<p class="rounded-lg bg-white p-2.5 ring-1 ring-slate-100"><span class="font-bold text-slate-700">Modelled:</span> ' +
    'nothing. There is no forecast on this screen — no probability of inclusion or exclusion has been produced yet.</p>' +
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
    drillRow('Shares outstanding', company.sharesOutstanding === null ? missing('no price, so no share count derivable') : escapeHtml(num(company.sharesOutstanding))) +
    '</dl>';

  openDrill({
    title: company.name,
    subtitle: [company.nseSymbol, company.sector].filter(Boolean).join(' · '),
    label: `${company.name} details`,
    body:
      drillSection('Identity', identity) +
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
  const refreshHeaderStatus = () => onStatusChange?.();

  function build() {
    const scope = state.getScope();
    const rows = data.forScope(scope);
    const cov = data.coverage();

    host.replaceChildren();

    const scopeChip = el(
      'span',
      {
        class: 'inline-flex items-center gap-1.5 rounded-lg bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700 ring-1 ring-inset ring-indigo-200',
        title:
          scope === 'held'
            ? 'Companies at least one of the three funds owns'
            : 'Every company in the record, including candidates no fund owns',
      },
      `${num(rows.length)} of ${num(cov.companies)} companies`,
    );

    host.append(
      sectionHead({
        title: 'Company screener',
        description:
          'Every company the three MSCI-tracking iShares funds hold, plus the candidates above the desk’s size floor that none of them holds yet. ' +
          'Free float is whichever exchange published it; weights belong to one named fund each.',
        meta: scopeChip,
      }),
    );

    host.append(el('div', { class: 'mb-6' }, [buildStats(rows, scope)]));

    const columns = [
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

    const bandNote =
      `Size bands are the desk’s own inclusion and exclusion cut-offs (${REVIEW_THRESHOLDS.inclusion.label} and ${REVIEW_THRESHOLDS.exclusion.label}), ` +
      'applied to free-float market cap. MSCI does not publish these figures — it derives its size cut-offs globally at each review.';

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
          options: [
            ...FUND_ORDER.map((id) => ({
              value: id,
              label: `in ${data.fundCoverage(id)?.shortName ?? id}`,
              match: (row) => Boolean(row.funds?.[id]),
            })),
            { value: 'any', label: 'held by any', match: (row) => row.held === true },
            { value: 'none', label: 'held by none', match: (row) => row.held !== true },
          ],
        },
        {
          id: 'source',
          label: 'Float source',
          allLabel: 'Any float source',
          options: [
            { value: 'nse', label: 'NSE', match: (row) => row.floatSource === 'nse' },
            { value: 'bse', label: 'BSE', match: (row) => row.floatSource === 'bse' },
            { value: 'none', label: 'no reading', match: (row) => row.freeFloatMcapInr === null },
          ],
        },
        {
          id: 'band',
          label: 'Size band',
          allLabel: 'Any size',
          note: bandNote,
          options: sizeBands(),
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
          filename: `sattva-companies-${scope}-${new Date().toISOString().slice(0, 10)}.csv`,
          freshness: fresh,
          scopeLabel:
            scope === 'held'
              ? `${visibleRows.length} of ${cov.held} companies held by at least one fund`
              : `${visibleRows.length} of ${cov.companies} companies in the record`,
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
    if (Array.isArray(event.changed) && event.changed.length && table) {
      table.updateRows(event.changed);
    }
    refreshHeaderStatus();
    // If the drill is showing one of the changed companies, refresh it too.
    const open = getParam('company');
    if (open && event.changed?.includes(open)) openCompanyDrill(open);
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

  state.on('scope', () => {
    closeDrill();
    lastView = table?.view ? { q: table.view.q, sort: table.view.sort, filters: { ...table.view.filters } } : null;
    setParams({ scope: state.getScope() });
    build();
  });

  return {
    rebuild: build,
    table: () => table,
    openCompany: (key) => openCompanyDrill(key),
  };
}

export { openCompanyDrill };
