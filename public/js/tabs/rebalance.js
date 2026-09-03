/**
 * The Latest Rebalance view: what the review actually did, and how the forecast
 * fared against it.
 *
 * ---------------------------------------------------------------------------
 * ⚠ THIS IS THE ONE SCREEN IN THE PRODUCT THAT MARKS ITS OWN HOMEWORK
 * ---------------------------------------------------------------------------
 * Everything else here forecasts. This scores, and a scorecard is the easiest
 * thing in the repository to make flattering by accident. Three rules hold it
 * honest and each is visible on the screen rather than only in this comment:
 *
 *  1. THE FORECAST IS READ, NEVER RECOMPUTED. Every verdict scored was frozen
 *     from a record whose holdings predate the effective date. The page says
 *     which dates, because a reader has no other way to check that the model
 *     was not simply shown the answer.
 *
 *  2. TWO NUMBERS, NEVER ONE, AND EACH WITH ITS DENOMINATOR. "Of the companies
 *     we flagged, how many moved" and "of the companies that moved, how many we
 *     flagged" are different questions with very different answers, and quoting
 *     one alone is how a model gets sold. A single blended "accuracy" is not
 *     offered anywhere.
 *
 *  3. THE NO-CHANGE RATE IS SHOWN AND IMMEDIATELY DISCOUNTED. 1,232 of 1,265
 *     companies did not move, so calling "no change" is nearly free and any
 *     accuracy figure counting those true negatives would read above 97% for a
 *     model that never fired at all. It is captioned as what it is.
 *
 * And the largest caveat of all, which sits at the top of the page: ONE REVIEW
 * IS ONE DATA POINT. §2.13 refuses to print a probability because a probability
 * needs a base rate and a base rate needs history. A single scored review does
 * not become that history, and this page must never be read as though it had.
 */

import { el, escapeHtml } from '../core/dom.js';
import { num, cr, pct, pp, shortDate, EM_DASH } from '../core/format.js';
import * as rebalanceData from '../data/rebalance.js';
import { VERDICTS } from '../model/assess.js';
import { SEGMENTS } from '../model/segments.js';

const TONE = {
  hit: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  missed: 'bg-rose-50 text-rose-800 ring-rose-200',
  false: 'bg-amber-50 text-amber-800 ring-amber-200',
  quiet: 'bg-slate-100 text-slate-600 ring-slate-200',
};
const OUTCOME_LABEL = {
  hit: 'called',
  missed: 'not called',
  false: 'did not happen',
  quiet: 'no call made',
};

const chip = (text, tone, title) =>
  `<span class="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${tone}"`
  + `${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(text)}</span>`;

const verdictChip = (verdict) => {
  if (!verdict) return `<span class="text-slate-300" title="this company was not in the record when the forecast was made">${EM_DASH}</span>`;
  const meta = VERDICTS[verdict];
  return chip(meta?.label ?? verdict, TONE.quiet, meta?.detail ?? '');
};

/** A stat card. Every figure passed in is already derived — never typed here. */
function card({ title, value, caption, rows = [], tone = '' }) {
  return el('div', { class: `rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100 ${tone}` }, [
    el('div', { class: 'text-[10px] font-bold uppercase tracking-wider text-slate-400' }, title),
    el('div', { class: 'font-display mt-1 text-3xl font-extrabold tracking-tight text-slate-900' }, value),
    caption ? el('div', { class: 'mt-1 text-xs leading-relaxed text-slate-500' }, caption) : null,
    rows.length
      ? el('dl', { class: 'mt-3 space-y-1' }, rows.map(([label, figure, hint]) => el(
        'div',
        { class: 'flex items-baseline justify-between gap-3 text-[11px]', title: hint ?? '' },
        [
          el('dt', { class: 'text-slate-500' }, label),
          el('dd', { class: 'font-semibold tabular-nums text-slate-800' }, figure),
        ],
      )))
      : null,
  ]);
}

function eventTable(payload, event, { emptyNote }) {
  const rows = rebalanceData.companiesFor(payload, event);
  if (rows.length === 0) {
    return el('p', { class: 'px-4 py-6 text-sm text-slate-400' }, emptyNote);
  }
  const body = rows.map((row) => {
    const outcome = rebalanceData.outcomeOf(row);
    const sizeInr = row.freeFloatMcapInrAfter ?? row.freeFloatMcapInrBefore;
    return '<tr class="border-b border-slate-50">'
      + `<td class="px-3 py-2"><div class="text-[13px] font-semibold text-slate-900">${escapeHtml(row.name)}</div>`
      + `<div class="text-[11px] text-slate-500">${escapeHtml(row.nseSymbol ?? '')}</div></td>`
      + `<td class="px-3 py-2 text-right text-[13px] tabular-nums text-slate-700">`
      + (sizeInr === null || sizeInr === undefined
        ? `<span class="text-slate-300" title="no free-float reading on the record">${EM_DASH}</span>`
        : escapeHtml(cr(sizeInr)))
      + '</td>'
      + `<td class="px-3 py-2">${verdictChip(row.predictedVerdict)}</td>`
      + `<td class="px-3 py-2">${chip(OUTCOME_LABEL[outcome], TONE[outcome],
        outcome === 'hit' ? 'the frozen verdict claimed exactly this event'
          : outcome === 'missed' ? 'this happened and the frozen verdict did not claim it'
            : outcome === 'quiet' ? 'no claim was made either way — the verdict was "unknown", or the company was not in the record yet'
              : 'the frozen verdict claimed a move and the company did not move')}</td>`
      + '</tr>';
  }).join('');

  const table = el('div', { class: 'overflow-x-auto rounded-xl ring-1 ring-slate-100' });
  table.innerHTML =
    '<table class="w-full border-collapse text-left">'
    + '<thead class="bg-slate-50/95"><tr>'
    + '<th class="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">Company</th>'
    + '<th class="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wider text-slate-500">Free float (₹ Cr)</th>'
    + '<th class="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">We forecast</th>'
    + '<th class="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">Outcome</th>'
    + `</tr></thead><tbody>${body}</tbody></table>`;
  return table;
}

function section(title, detail, node) {
  return el('section', { class: 'mb-8' }, [
    el('h2', { class: 'font-display text-base font-extrabold tracking-tight text-slate-900' }, title),
    detail ? el('p', { class: 'mb-3 mt-1 max-w-3xl text-xs leading-relaxed text-slate-500' }, detail) : null,
    node,
  ]);
}

function renderPayload(host, payload) {
  const s = payload.scorecard;
  const tally = payload.eventTally;
  const moved = (tally.entered ?? 0) + (tally.exited ?? 0) + (tally['migration-up'] ?? 0) + (tally['migration-down'] ?? 0);
  const total = payload.companies.length;
  const notReRead = payload.funds.notReRead.map((id) => payload.funds.names[id] ?? id);

  host.replaceChildren();

  // ---- what this page is, and what one review is not --------------------
  host.append(el('div', { class: 'mb-6' }, [
    el('h1', { class: 'font-display text-2xl font-extrabold tracking-tight text-slate-900' },
      `${payload.reviewLabel} review`),
    el('p', { class: 'mt-1 text-sm text-slate-600' }, [
      `Effective ${shortDate(payload.effectiveDate)}`,
      payload.effectiveDateAssumed ? ' (assumed — MSCI does not publish the exact day)' : '',
      `. MSCI struck the market caps that decided it somewhere in `,
      `${shortDate(payload.priceWindow.from)}–${shortDate(payload.priceWindow.to)} and does not say which day.`,
    ].join('')),
  ]));

  host.append(el('div', {
    class: 'mb-6 rounded-2xl bg-amber-50/70 p-4 ring-1 ring-amber-200',
  }, [
    el('p', { class: 'text-xs leading-relaxed text-amber-900' }, [
      el('strong', {}, 'One review is one data point. '),
      'This is a scorecard, not a backtest. The screener still prints no probability, for exactly the '
      + 'reason this page cannot supply one: a probability needs a base rate, a base rate needs history, '
      + 'and a single scored review is not history. Read the two figures below as what happened once.',
    ]),
  ]));

  // ---- how the forecast was frozen --------------------------------------
  host.append(el('div', { class: 'mb-6 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100' }, [
    el('div', { class: 'text-[10px] font-bold uppercase tracking-wider text-slate-400' }, 'How this was scored'),
    el('p', { class: 'mt-2 max-w-4xl text-xs leading-relaxed text-slate-600' },
      `The forecast was frozen from holdings as of ${shortDate(payload.forecast.holdingsAsOf)} — before `
      + `the review took effect on ${shortDate(payload.effectiveDate)} — and is read from that file rather than `
      + 'recomputed. Recomputing it against the post-rebalance holdings would score the model on the '
      + 'answer sheet, and would look excellent.'),
    el('p', { class: 'mt-2 max-w-4xl text-xs leading-relaxed text-slate-600' },
      `The outcome is read from ${payload.funds.reRead.map((id) => `${payload.funds.names[id] ?? id} (${shortDate(payload.outcome.holdingsAsOfByFund[id])})`).join(' and ')}.`
      + (notReRead.length
        ? ` ${notReRead.join(', ')} was not re-downloaded for this review, so its membership after the `
          + 'rebalance is unknown and it is excluded from every comparison here — not assumed unchanged.'
        : '')),
  ]));

  // ---- what changed ------------------------------------------------------
  const strip = el('div', { class: 'mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4', 'data-stat-strip': '4' }, [
    card({
      title: 'Companies that moved',
      value: `${num(moved)} of ${num(total)}`,
      caption: 'changed segment at this review',
      rows: [
        ['Entered the index', num(tally.entered ?? 0)],
        ['Left the index', num(tally.exited ?? 0)],
        ['Migrated up', num(tally['migration-up'] ?? 0)],
        ['Migrated down', num(tally['migration-down'] ?? 0)],
      ],
    }),
    card({
      title: 'Of what we flagged',
      value: `${num(s.precision.moved)} of ${num(s.precision.flagged)}`,
      caption: 'companies we said would move, that moved',
      rows: [
        ['Right event named', num(s.precision.rightEvent), 'the verdict claimed exactly the event that happened'],
        ['Did not move', num(s.precision.flagged - s.precision.moved)],
      ],
    }),
    card({
      title: 'Of what moved',
      value: `${num(s.recall.flagged)} of ${num(s.recall.moved)}`,
      caption: 'companies that moved, that we had flagged',
      rows: [
        ['Right event named', num(s.recall.rightEvent)],
        ['Not flagged at all', num(s.recall.moved - s.recall.flagged)],
      ],
    }),
    card({
      title: 'No-change calls',
      value: `${num(s.stable.right)} of ${num(s.stable.calls)}`,
      caption: s.stable.caveat,
    }),
  ]);
  host.append(strip);

  // ---- the movements -----------------------------------------------------
  host.append(section(
    `Entered the index — ${num(tally.entered ?? 0)}`,
    'Outside MSCI India IMI before the review, a constituent after it. Every fund tracking the segment '
    + 'had to buy.',
    eventTable(payload, 'entered', { emptyNote: 'No company entered at this review.' }),
  ));
  host.append(section(
    `Left the index — ${num(tally.exited ?? 0)}`,
    'A constituent before the review and outside afterwards. Every fund tracking the segment had to sell '
    + 'its whole position.',
    eventTable(payload, 'exited', { emptyNote: 'No company left at this review.' }),
  ));
  host.append(section(
    `Migrated between segments — ${num((tally['migration-up'] ?? 0) + (tally['migration-down'] ?? 0))}`,
    'Moved between Standard and Small Cap. Two flows in opposite directions, in different funds, and they '
    + 'are never netted: one set of funds sells while another buys.',
    el('div', {}, [
      eventTable(payload, 'migration-up', { emptyNote: 'No company migrated up at this review.' }),
      el('div', { class: 'h-3' }),
      eventTable(payload, 'migration-down', { emptyNote: 'No company migrated down at this review.' }),
    ]),
  ));

  // ---- the misses, named -------------------------------------------------
  const misses = payload.companies.filter((r) => rebalanceData.outcomeOf(r) === 'missed');
  host.append(section(
    `What we did not call — ${num(misses.length)}`,
    'These moved and the frozen forecast did not claim it. They are the list worth arguing with: a '
    + 'scorecard that only showed its hits would be an advertisement.',
    misses.length
      ? el('div', { class: 'overflow-x-auto rounded-xl ring-1 ring-rose-100' }, [(() => {
        const wrap = el('div');
        wrap.innerHTML =
          '<table class="w-full border-collapse text-left"><thead class="bg-rose-50/60"><tr>'
          + '<th class="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">Company</th>'
          + '<th class="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">What happened</th>'
          + '<th class="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">We forecast</th>'
          + '<th class="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wider text-slate-500">Free float (₹ Cr)</th>'
          + '</tr></thead><tbody>'
          + misses.map((row) => '<tr class="border-b border-slate-50">'
            + `<td class="px-3 py-2 text-[13px] font-semibold text-slate-900">${escapeHtml(row.name)}</td>`
            + `<td class="px-3 py-2 text-[13px] text-slate-700">${escapeHtml(payload.eventTypes[row.event]?.label ?? row.event)}</td>`
            + `<td class="px-3 py-2">${verdictChip(row.predictedVerdict)}</td>`
            + `<td class="px-3 py-2 text-right text-[13px] tabular-nums text-slate-700">`
            + (row.freeFloatMcapInrBefore === null || row.freeFloatMcapInrBefore === undefined
              ? `<span class="text-slate-300">${EM_DASH}</span>`
              : escapeHtml(cr(row.freeFloatMcapInrBefore)))
            + '</td></tr>').join('')
          + '</tbody></table>';
        return wrap.firstElementChild;
      })()])
      : el('p', { class: 'px-4 py-6 text-sm text-slate-400' }, 'Every movement at this review was called.'),
  ));

  // ---- what is not scored ------------------------------------------------
  host.append(el('div', { class: 'rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200' }, [
    el('div', { class: 'text-[10px] font-bold uppercase tracking-wider text-slate-400' }, 'Not scored, and why'),
    el('ul', { class: 'mt-2 space-y-1.5 text-xs leading-relaxed text-slate-600' }, [
      el('li', {}, `${num(s.unknownAtForecast)} companies carried an “unknown” verdict when the forecast was `
        + 'frozen — an explicit refusal to call, because an input the verdict depends on could not be '
        + 'trusted. A refusal is not a wrong answer and is not counted as one.'),
      el('li', {}, `${num(s.notInForecast)} companies in the record today were not in it when the forecast `
        + 'was made, so no verdict existed to score.'),
      notReRead.length
        ? el('li', {}, `${notReRead.join(', ')} was not re-downloaded, so nothing here says whether its `
          + 'membership changed. Its holdings on screen are still the pre-rebalance file.')
        : null,
      el('li', {}, 'Weight changes within a segment are not scored at all. The model forecasts segment '
        + 'membership; it makes no claim about how a surviving constituent’s weight moves.'),
    ]),
  ]));
}

/**
 * Render the view. Returns a handle so the shell can dispose it, matching the
 * screener's contract.
 */
export function renderRebalance(host) {
  host.replaceChildren(
    el('div', { class: 'py-16 text-sm text-slate-400' }, 'Loading the rebalance record…'),
  );

  rebalanceData.load()
    .then((payload) => renderPayload(host, payload))
    .catch((error) => {
      // A feed that failed is its own named state. Rendering an empty page
      // would report an outage as "nothing changed at this review" (§2.4).
      host.replaceChildren(el('div', { class: 'rounded-2xl bg-white p-6 shadow-sm ring-1 ring-rose-200' }, [
        el('h1', { class: 'font-display text-lg font-extrabold text-rose-700' }, 'The rebalance record could not be loaded'),
        el('p', { class: 'mt-2 max-w-2xl text-sm leading-relaxed text-slate-600' },
          'This is a failure to read the file, not a finding that the review changed nothing.'),
        el('pre', { class: 'mt-3 overflow-x-auto rounded-xl bg-slate-50 p-3 text-xs text-slate-700' },
          String(error?.message ?? error)),
        el('p', { class: 'mt-3 text-xs text-slate-500' },
          'Regenerate it with: node scripts/build-rebalance.mjs --review=2026-08'),
      ]));
    });

  return { rebuild: () => renderRebalance(host) };
}
