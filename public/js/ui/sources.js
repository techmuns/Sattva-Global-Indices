/**
 * The data-source registry behind the header status pill.
 *
 * Provenance has to be reachable from every screen by one gesture, so there is
 * exactly one control for it and no separate Sources button. Every figure in
 * here is read from the data; none is typed.
 */

import { escapeHtml } from '../core/dom.js';
import { shortDate, relativeTime, num } from '../core/format.js';
import { sourceRegistry, freshness, coverage } from '../data/companies.js';
import { openModal } from './screener.js';

const STATUS_STYLE = {
  ok: ['bg-emerald-50 text-emerald-700 ring-emerald-200', 'Reading'],
  stale: ['bg-amber-50 text-amber-800 ring-amber-200', 'Stale'],
  missing: ['bg-rose-50 text-rose-700 ring-rose-200', 'No reading'],
};

/**
 * How old is too old? A quarterly-review product refreshed monthly is fine at a
 * few days and suspicious at a few weeks. This is our threshold, and it is
 * stated as ours on screen rather than implied to be anybody's standard.
 */
const STALE_AFTER_DAYS = 14;

function statusFor(source, now) {
  if (source.status === 'missing' || !source.asOfDate) return 'missing';
  const days = (now.getTime() - source.asOfDate.getTime()) / 86400000;
  return days > STALE_AFTER_DAYS ? 'stale' : 'ok';
}

/** The header pill's own label — reads the OLDEST feed, not the newest. */
export function headerStatus(now = new Date()) {
  const { oldest } = freshness();
  if (!oldest) {
    return { label: 'Provenance', detail: 'No as-of date could be read', tone: 'negative' };
  }
  const days = (now.getTime() - oldest.date.getTime()) / 86400000;
  return {
    label: `Data ${relativeTime(oldest.date, now)}`,
    detail: `Oldest feed: ${oldest.label}`,
    tone: days > STALE_AFTER_DAYS ? 'caution' : 'positive',
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
        `<div class="mt-1.5 text-[11px] text-slate-500">As of <span class="font-semibold text-slate-700">${escapeHtml(shortDate(source.asOfDate ?? source.asOf))}</span>` +
        (source.asOfDate ? ` · ${escapeHtml(relativeTime(source.asOfDate, now))}` : '') +
        '</div></li>'
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
    `<p class="text-[11px] leading-relaxed text-slate-400">A feed is flagged stale after ${STALE_AFTER_DAYS} days. That is our threshold, not a standard published by any exchange.</p>` +
    '</div>';

  openModal(body, { size: 'lg', title: 'Data sources' });
}
