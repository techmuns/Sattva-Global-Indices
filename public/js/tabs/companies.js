/**
 * THE master table — the whole v1 view.
 *
 * Company, free float, index participation and weights. The probability of
 * inclusion or exclusion is a later prompt; nothing on this screen is modelled,
 * and the provenance section of the drill says so explicitly rather than
 * leaving a reader to assume.
 */

import { $, el, escapeHtml } from '../core/dom.js';
import { cr, inr, pct, factorPct, num, shortDate, plural, EM_DASH } from '../core/format.js';
import * as data from '../data/companies.js';
import * as state from '../core/state.js';
import { setParams, getParam, onRoute } from '../core/router.js';
import { segmentedToggle } from '../ui/components.js';
import { sectionHead, statStrip, scoreTable, openDrill, closeDrill } from '../ui/screener.js';
import { sourceChip, fundChip, missing } from '../ui/visual.js';
import { exportCsv } from '../ui/export.js';
import { REVIEW_THRESHOLDS, crore, toCrore } from '../config/thresholds.mjs';

const FUND_ORDER = ['eem', 'smin', 'eems'];

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

  let html =
    '<dl class="rounded-xl bg-slate-50/70 p-3">' +
    drillRow(
      'Free-float market cap',
      company.freeFloatMcapInr === null
        ? missing('no free-float reading from either exchange')
        : escapeHtml(inr(company.freeFloatMcapInr)),
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

export function renderCompanies(host, { scopeControl }) {
  let table = null;
  let lastView = null;

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
        sortValue: (row) => row.freeFloatMcapInr,
        get: (row) =>
          row.freeFloatMcapInr === null
            ? missing('no free-float reading from either exchange')
            : `<span class="inline-flex items-center justify-end gap-1.5"><span class="font-semibold text-slate-900">${escapeHtml(cr(row.freeFloatMcapInr))}</span>${sourceChip(row.floatSource)}</span>`,
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
