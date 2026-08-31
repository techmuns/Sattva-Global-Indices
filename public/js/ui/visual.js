/**
 * Small visual atoms: identity avatars, source chips, fund chips.
 *
 * Every function returns an HTML STRING, because the table builds rows as
 * strings and caches them. Anything data-derived is escaped here.
 */

import { escapeHtml } from '../core/dom.js';

/**
 * A deterministic avatar for a company: initials on a tint drawn from the name.
 *
 * Deterministic on purpose — the same company gets the same colour on every
 * render and every reload, so the eye can use it as a landmark while scrolling.
 * It carries NO meaning: it is derived from the name, not from any figure, and
 * it must never be mistaken for a status. Brand-ramp hues only.
 */
const AVATAR_TINTS = [
  ['#eef2ff', '#4338ca'], // indigo
  ['#faf5ff', '#7e22ce'], // purple
  ['#fdf2f8', '#be185d'], // pink
  ['#eff6ff', '#1d4ed8'], // blue
  ['#f5f3ff', '#6d28d9'], // violet
];

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function initialsFor(name) {
  // Drop corporate-form words AND bare conjunctions, so "Larsen & Toubro"
  // initials as LT rather than L&.
  const words = String(name ?? '')
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !/^(ltd|limited|the|and|of|india|co|corp|corporation)$/i.test(w));
  if (words.length === 0) return '—';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function avatarFor(name, { size = 34 } = {}) {
  const [bg, fg] = AVATAR_TINTS[hashString(String(name ?? '')) % AVATAR_TINTS.length];
  return (
    `<span aria-hidden="true" class="inline-flex shrink-0 items-center justify-center rounded-lg text-[11px] font-bold" ` +
    `style="width:${size}px;height:${size}px;background:${bg};color:${fg}">${escapeHtml(initialsFor(name))}</span>`
  );
}

/**
 * Which exchange published the float reading on this row.
 *
 * The source travels with the number — a reader comparing two rows must be able
 * to see that one is NSE-sourced and one is not, because the two exchanges
 * apply different float definitions and their factors genuinely disagree.
 *
 * Spaced by its own `ml-1` rather than by a flex gap on whatever holds it: the
 * table's cells cannot be flex containers, because a cell whose entire content
 * is one flex box is cut without an ellipsis when its column is squeezed. See
 * the column-layout header in ui/screener.js.
 */
export function sourceChip(source) {
  if (source === 'nse') {
    return (
      '<span class="ml-1 inline-flex items-center rounded-md bg-indigo-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-indigo-700 ring-1 ring-inset ring-indigo-200" ' +
      'title="Free float as published by NSE. NSE is used wherever it publishes a reading, because MSCI follows NSE.">NSE</span>'
    );
  }
  if (source === 'bse') {
    return (
      '<span class="ml-1 inline-flex items-center rounded-md bg-purple-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-purple-700 ring-1 ring-inset ring-purple-200" ' +
      'title="Free float as published by BSE. Used where NSE publishes no reading for this company.">BSE</span>'
    );
  }
  return '';
}

const FUND_CHIP_STYLE = {
  eem: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  smin: 'bg-purple-50 text-purple-700 ring-purple-200',
  eems: 'bg-pink-50 text-pink-700 ring-pink-200',
};

/** A chip naming one fund. A weight is only ever shown beside one of these. */
export function fundChip(fundId, label, { title = '' } = {}) {
  const style = FUND_CHIP_STYLE[fundId] ?? 'bg-slate-100 text-slate-700 ring-slate-200';
  return (
    `<span class="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${style}"` +
    `${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}</span>`
  );
}

/**
 * A value that is not there, with WHICH KIND of absence stated.
 *
 * "not held by this fund" and "no free-float reading" are different facts and a
 * reader must be able to tell them apart. Both are excluded from every total
 * and neither sorts as zero.
 */
export function missing(reason) {
  return `<span class="text-slate-300" title="${escapeHtml(reason)}">—</span>`;
}
