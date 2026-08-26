/**
 * The data-source registry behind the header status pill.
 *
 * Provenance has to be reachable from every screen by one gesture, so there is
 * exactly one control for it and no separate Sources button. Every figure in
 * here is read from the data; none is typed.
 */

import { escapeHtml } from '../core/dom.js';
import { shortDate, relativeTime, tickAge, num } from '../core/format.js';
import { sourceRegistry, freshness, coverage } from '../data/companies.js';
import * as quotes from '../data/quotes.js';
import { openModal } from './screener.js';

const STATUS_STYLE = {
  ok: ['bg-emerald-50 text-emerald-700 ring-emerald-200', 'Reading'],
  stale: ['bg-amber-50 text-amber-800 ring-amber-200', 'Stale'],
  missing: ['bg-rose-50 text-rose-700 ring-rose-200', 'No reading'],
  live: ['bg-indigo-50 text-indigo-700 ring-indigo-200', 'Live'],
  off: ['bg-slate-100 text-slate-600 ring-slate-200', 'Market closed'],
  failed: ['bg-rose-50 text-rose-700 ring-rose-200', 'Unavailable'],
};

/**
 * How old is too old?
 *
 * There is no single answer, because the feeds do not share a cadence. BSE's
 * float scrape and the bhavcopy run every trading day; NSE is attempted daily
 * and allowed to fail because its edge throttles a datacentre IP, with a weekly
 * job as the guarantee; the iShares workbooks are replaced by hand.
 *
 * A single 14-day threshold — which is what this file used while the pipeline
 * was monthly — would let the daily sources sit broken for a fortnight without
 * saying anything. Each feed now carries its own `staleAfterDays`, and this is
 * the fallback for anything that does not.
 *
 * Every one of these is the desk's own number, stated as ours on screen rather
 * than implied to be anybody's standard.
 */
const DEFAULT_STALE_AFTER_DAYS = 14;

/** The threshold for one feed: its own, or the fallback. */
const staleAfterFor = (source) => source.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;

function statusFor(source, now) {
  if (source.status === 'live') {
    // The live feed's state is whether a byte actually arrived, never the clock
    // alone. A chip that says "live" whether or not anything was confirmed
    // teaches readers to ignore it.
    if (quotes.lastLiveError()) return 'failed';
    if (quotes.isLive()) return 'live';
    return 'off';
  }
  if (source.status === 'missing' || !source.asOfDate) return 'missing';
  const days = (now.getTime() - source.asOfDate.getTime()) / 86400000;
  return days > staleAfterFor(source) ? 'stale' : 'ok';
}

/**
 * The header pill.
 *
 * Two facts, and they are different: WHICH PRICE IS IN FORCE, and HOW OLD the
 * oldest input is. The pill leads with the price tier because that is what
 * changes minute to minute, and names the oldest feed underneath because a live
 * price does not make a month-old float factor live.
 *
 * "Live" is claimed only when a byte actually arrived AND the market is open.
 * Their other dashboard learned this the expensive way: a chip that says "just
 * now" regardless teaches readers to ignore it.
 */
export function headerStatus(now = new Date()) {
  const { oldest } = freshness();
  const cov = coverage();
  const marketOpen = quotes.isMarketOpen(now);
  const live = quotes.isLive();
  const failure = quotes.lastLiveError();
  const liveN = quotes.liveCount();
  const eligible = cov.liveEligible ?? null;
  const tradeDate = freshness().feeds.find((f) => f.id === 'bhavcopy');

  /**
   * EVERY branch names the oldest input, and this is why it is a function
   * rather than a clause repeated four times.
   *
   * The screener used to carry a Data-freshness card that named all four feeds
   * and their dates. It was removed on 25 Aug 2026 so the stat strip fits one
   * row, which makes this pill the ONLY always-visible carrier of how old the
   * page really is — the sources modal has the detail, but a reader has to
   * click for it. One branch (live quotes unavailable) had already dropped the
   * clause, and nothing noticed while the card was there to cover for it.
   * Building it here means a new branch cannot forget.
   */
  const withOldest = (text) => `${text} · oldest input: ${oldest?.label ?? 'unknown'}`;

  if (live) {
    const age = quotes.liveAsOf() ? tickAge(quotes.liveAsOf(), now) : 'just now';
    return {
      label: `Live · NSE · updated ${age}`,
      detail: withOldest(eligible === null ? `${liveN} rows live` : `${liveN} of ${eligible} rows live`),
      tone: 'positive',
    };
  }

  if (marketOpen && failure) {
    return {
      label: 'Last close · BSE',
      // "every row is on its closing price" used to sit here and has gone: the
      // label already says Last close · BSE, and the pill is one line of 10px
      // text that has to survive a 390px viewport. The oldest input is the
      // fact that has nowhere else to live.
      detail: withOldest(`Live quotes unavailable (${failure.reason})`),
      tone: 'caution',
    };
  }

  const closeLabel = tradeDate?.date ? shortDate(tradeDate.date) : '—';
  return {
    label: `Last close · BSE · ${closeLabel}`,
    detail: withOldest(marketOpen ? 'Market open, no live quote yet' : 'Market closed'),
    tone: oldest && (now.getTime() - oldest.date.getTime()) / 86400000 > staleAfterFor(oldest) ? 'caution' : 'positive',
  };
}

export function openSourcesModal(now = new Date()) {
  const sources = sourceRegistry();
  const cov = coverage();
  const { oldest } = freshness();

  const rows = sources
    .map((source) => {
      const status = statusFor(source, now);
      const [style, statusLabel] = STATUS_STYLE[status];
      // A count that is unknown is null, and the clause carrying it is dropped
      // rather than rendered as "0 companies".
      const countLine =
        source.count === null || source.count === undefined
          ? ''
          : `<div class="mt-1 text-[11px] font-semibold tabular-nums text-slate-600">${escapeHtml(num(source.count))} ${escapeHtml(source.countLabel ?? '')}</div>`;
      const liveLine =
        source.id !== 'munshot'
          ? ''
          : `<div class="mt-1 text-[11px] text-slate-500">${
              quotes.lastLiveError()
                ? `Unavailable — ${escapeHtml(quotes.lastLiveError().reason)}${quotes.lastLiveError().remedy ? `. ${escapeHtml(quotes.lastLiveError().remedy)}` : ''}`
                : quotes.isLive()
                  ? `${escapeHtml(num(quotes.liveCount()))} rows currently on a live price`
                  : quotes.isMarketOpen()
                    ? 'Market is open; no live quote has arrived yet'
                    : 'Market is closed — every row is on its last close'
            }</div>`;
      return (
        '<li class="rounded-xl bg-slate-50/70 p-3 ring-1 ring-slate-100">' +
        '<div class="flex items-start justify-between gap-3">' +
        '<div class="min-w-0">' +
        `<div class="text-sm font-bold text-slate-900">${escapeHtml(source.name)}</div>` +
        `<div class="text-[11px] text-slate-500">${escapeHtml(source.publisher)}</div>` +
        '</div>' +
        `<span class="shrink-0 rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ring-inset ${style}">${escapeHtml(statusLabel)}</span>` +
        '</div>' +
        `<p class="mt-2 text-xs leading-relaxed text-slate-600">${escapeHtml(source.what)}</p>` +
        countLine +
        liveLine +
        (source.asOfDate
          ? `<div class="mt-1.5 text-[11px] text-slate-500">As of <span class="font-semibold text-slate-700">${escapeHtml(shortDate(source.asOfDate))}</span> · ${escapeHtml(relativeTime(source.asOfDate, now))}</div>`
          // A LIVE feed has no snapshot date, and inventing one would be worse
          // than showing none: "As of —" reads as a failed date rather than as
          // a feed that is fetched on demand. Keyed on the status rather than on
          // an id list, so a new live feed cannot be forgotten here.
          : source.status === 'live' ? ''
          : `<div class="mt-1.5 text-[11px] text-slate-500">As of <span class="font-semibold text-slate-700">${escapeHtml(shortDate(source.asOf))}</span></div>`) +
        '</li>'
      );
    })
    .join('');

  const withFloat = cov.withFloat ?? null;
  const total = cov.companies ?? null;

  const body =
    '<div class="space-y-4">' +
    '<p class="text-sm leading-relaxed text-slate-600">' +
    'Every figure on this screen comes from one of the feeds below. ' +
    (oldest
      ? `The three measurement dates are <strong>not the same moment</strong> and are never collapsed into one — the oldest, <strong>${escapeHtml(oldest.label)}</strong>, is what governs how current the page really is.`
      : '') +
    '</p>' +
    `<ul class="space-y-2">${rows}</ul>` +
    (withFloat !== null && total !== null
      ? `<p class="rounded-xl bg-indigo-50/60 p-3 text-xs leading-relaxed text-indigo-900 ring-1 ring-indigo-100">` +
        `<strong>${escapeHtml(num(withFloat))} of ${escapeHtml(num(total))}</strong> companies carry a free-float reading. ` +
        'NSE is used wherever it publishes one, because MSCI follows NSE; BSE fills the gaps. ' +
        'The two exchanges apply different float definitions and their factors genuinely disagree, so neither is ever averaged into the other and both stay on the record.' +
        '</p>'
      : '') +
    '<p class="text-[11px] leading-relaxed text-slate-400">Each feed is flagged stale on its own schedule, because they are not refreshed on the same one: '
    + `${sources.filter((s) => s.staleAfterDays).map((s) => `${escapeHtml(s.name)} after ${s.staleAfterDays}d`).join(', ')}`
    + `${sources.some((s) => !s.staleAfterDays) ? `, everything else after ${DEFAULT_STALE_AFTER_DAYS}d` : ''}. `
    + 'Those are our thresholds, not standards published by any exchange.</p>' +
    '</div>';

  openModal(body, { size: 'lg', title: 'Data sources' });
}
