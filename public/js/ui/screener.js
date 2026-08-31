/**
 * THE KIT: sectionHead, statStrip, scoreTable, openDrill, openModal, trapFocus.
 *
 * Built as reusable modules rather than one page, because later work adds
 * columns to this same table and drives it in tests.
 */

import { $, $$, el, empty, escapeHtml, onIdle } from '../core/dom.js';
import { avatarFor } from './visual.js';

/* ────────────────────────────────────────────────────────────────────────────
 * Focus management
 * ──────────────────────────────────────────────────────────────────────────── */

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Make a container behave as a modal dialog for the keyboard.
 *
 * Without this a keyboard user tabs straight out of an open panel and into the
 * page behind it — which they cannot see, cannot tell they are in, and cannot
 * get back out of. Sets the dialog roles, moves focus in, keeps Tab inside, and
 * restores focus to whatever opened it.
 *
 * @returns {() => void} release
 */
export function trapFocus(container, { label } = {}) {
  const previous = document.activeElement;
  container.setAttribute('role', 'dialog');
  container.setAttribute('aria-modal', 'true');
  if (label) container.setAttribute('aria-label', label);
  if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');

  const focusables = () => $$(FOCUSABLE, container).filter((node) => node.offsetParent !== null);

  const onKeydown = (event) => {
    if (event.key !== 'Tab') return;
    const items = focusables();
    if (items.length === 0) {
      event.preventDefault();
      container.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === container)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  container.addEventListener('keydown', onKeydown);
  (focusables()[0] ?? container).focus({ preventScroll: true });

  return () => {
    container.removeEventListener('keydown', onKeydown);
    if (previous instanceof HTMLElement && document.contains(previous)) {
      previous.focus({ preventScroll: true });
    }
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Overlays — both singletons, modal stacks above drill
 * ──────────────────────────────────────────────────────────────────────────── */

let openDrillHandle = null;
let openModalHandle = null;

function closeIcon(label) {
  return (
    `<button type="button" data-close class="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 ` +
    `focus:outline-none focus:ring-2 focus:ring-indigo-500" aria-label="${escapeHtml(label)}">` +
    '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2">' +
    '<path d="M5 5l10 10M15 5 5 15" stroke-linecap="round"/></svg></button>'
  );
}

/** Right-slide panel, 480px, singleton. ESC and backdrop click close it. */
export function openDrill({ title, subtitle, body, onClose, label }) {
  // SUPERSEDED, NOT CLOSED. Opening a drill over an existing one must not run
  // the old panel's onClose: that handler's job is to record "no drill is
  // showing", and it would clear `?company=` for the panel that just replaced
  // it. The symptom is a drill sitting open above an address bar that no longer
  // names it, so copying the link shares a page with no drill on it.
  closeDrill({ superseded: true });
  const root = $('#drill-root');
  if (!root) return null;

  const wrap = el('div', { class: 'fixed inset-0' });
  wrap.innerHTML =
    '<div data-backdrop class="absolute inset-0 bg-slate-900/25 backdrop-blur-[1px]"></div>' +
    '<aside data-panel class="absolute right-0 top-0 flex h-full w-full max-w-[480px] flex-col bg-white shadow-2xl ring-1 ring-slate-200">' +
    '<header class="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">' +
    '<div class="min-w-0">' +
    `<h2 class="font-display truncate text-base font-bold text-slate-900">${title ?? ''}</h2>` +
    (subtitle ? `<p class="mt-0.5 truncate text-xs text-slate-500">${subtitle}</p>` : '') +
    '</div>' +
    closeIcon('Close details') +
    '</header>' +
    '<div data-drill-body class="min-h-0 flex-1 overflow-y-auto px-5 py-4"></div>' +
    '</aside>';

  const panel = $('[data-panel]', wrap);
  $('[data-drill-body]', wrap).innerHTML = body ?? '';
  root.append(wrap);

  const release = trapFocus(panel, { label: label ?? title ?? 'Details' });

  // The event listeners below pass a click Event here; reading `.superseded`
  // off one is simply undefined, so a user-driven close always runs onClose.
  const close = ({ superseded = false } = {}) => {
    if (openDrillHandle?.wrap !== wrap) return;
    release();
    wrap.remove();
    document.removeEventListener('keydown', onKey);
    openDrillHandle = null;
    if (!superseded) onClose?.();
  };

  function onKey(event) {
    // Only the topmost overlay reacts, so ESC inside a help modal opened from
    // the drill closes the modal and leaves the drill standing.
    if (event.key === 'Escape' && !openModalHandle) {
      event.stopPropagation();
      close();
    }
  }

  $('[data-backdrop]', wrap).addEventListener('click', close);
  $('[data-close]', wrap).addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  openDrillHandle = { wrap, close };
  return openDrillHandle;
}

export function closeDrill(options) {
  openDrillHandle?.close(options);
}

export const isDrillOpen = () => openDrillHandle !== null;

const MODAL_SIZES = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl' };

/** Centred dialog, singleton, above the drill. */
export function openModal(html, { size = 'md', title, label } = {}) {
  closeModal();
  const root = $('#modal-root');
  if (!root) return null;

  const wrap = el('div', { class: 'fixed inset-0 flex items-start justify-center overflow-y-auto p-4 sm:p-8' });
  wrap.innerHTML =
    '<div data-backdrop class="fixed inset-0 bg-slate-900/35"></div>' +
    `<div data-panel class="relative z-10 my-auto w-full ${MODAL_SIZES[size] ?? MODAL_SIZES.md} rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200">` +
    (title
      ? '<header class="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">' +
        `<h2 class="font-display text-base font-bold text-slate-900">${title}</h2>${closeIcon('Close')}</header>`
      : `<div class="absolute right-3 top-3">${closeIcon('Close')}</div>`) +
    '<div data-modal-body class="px-5 py-4"></div>' +
    '</div>';

  $('[data-modal-body]', wrap).innerHTML = html ?? '';
  root.append(wrap);

  const panel = $('[data-panel]', wrap);
  const release = trapFocus(panel, { label: label ?? title ?? 'Dialog' });

  const close = () => {
    if (openModalHandle?.wrap !== wrap) return;
    release();
    wrap.remove();
    document.removeEventListener('keydown', onKey);
    openModalHandle = null;
  };

  function onKey(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  }

  $('[data-backdrop]', wrap).addEventListener('click', close);
  for (const button of $$('[data-close]', wrap)) button.addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  openModalHandle = { wrap, close };
  return openModalHandle;
}

export function closeModal() {
  openModalHandle?.close();
}

/* ────────────────────────────────────────────────────────────────────────────
 * Section header
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * @param {{title, description?, meta?: Node|string, controls?: Node|Array<Node>}} config
 *
 * `meta` sits in the justify-between row beside the title; `controls` is a row
 * of its own BENEATH the heading.
 *
 * The split is not cosmetic. `meta` shares a flex row with a description whose
 * length varies between views, so whether it lands beside the title or wraps
 * under it depends on how long that description happens to be. A control that
 * jumps to a different place when you use it reads as a different page — so
 * anything whose content changes as the reader interacts goes in `controls`,
 * which has a stable row to itself.
 */
export function sectionHead({ title, description, meta, controls }) {
  const heading = el('div', { class: 'flex flex-wrap items-start justify-between gap-x-6 gap-y-3' }, [
    el('div', { class: 'min-w-0 max-w-2xl' }, [
      el('h1', { class: 'font-display text-xl font-extrabold tracking-tight text-slate-900 sm:text-2xl' }, title),
      description ? el('p', { class: 'mt-1.5 text-sm leading-relaxed text-slate-600' }, description) : null,
    ]),
    meta ? el('div', { class: 'shrink-0' }, [meta]) : null,
  ]);

  const children = [heading];
  if (controls) {
    children.push(
      el('div', { class: 'mt-4 flex flex-wrap items-center gap-3' }, [controls].flat().filter(Boolean)),
    );
  }
  return el('section', { class: 'mb-6' }, children);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Stat strip
 * ──────────────────────────────────────────────────────────────────────────── */

function helpButton(index) {
  return el('button', {
    type: 'button',
    'data-help': String(index),
    class:
      'ml-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-slate-200/80 text-[9px] font-bold ' +
      'text-slate-600 transition hover:bg-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500',
    'aria-label': 'What this means',
    html: '?',
  });
}

/**
 * One row of stat cards. Any card may carry `help: { title, body }`, and any
 * card may set `hero: true` for the gradient treatment.
 *
 * The wide-screen column count is DERIVED from how many cards were passed, so
 * the strip stays a single row when a card is added or removed rather than
 * silently wrapping a card onto a second line. Tailwind arrives from the CDN
 * and scans for whole class names, so the classes are written out in full —
 * a computed `xl:grid-cols-${n}` would produce no CSS at all.
 */
const STRIP_COLUMNS = {
  1: 'xl:grid-cols-1',
  2: 'xl:grid-cols-2',
  3: 'xl:grid-cols-3',
  4: 'xl:grid-cols-4',
  5: 'xl:grid-cols-5',
  6: 'xl:grid-cols-6',
};

export function statStrip(cards) {
  const columns = STRIP_COLUMNS[cards.length] ?? 'xl:grid-cols-4';
  const root = el('div', { 'data-stat-strip': String(cards.length), class: `grid grid-cols-1 gap-4 sm:grid-cols-2 ${columns}` });

  cards.forEach((card, index) => {
    const hero = card.hero === true;

    const labelRow = el(
      'div',
      {
        class: `flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider ${
          hero ? 'text-white/80' : 'text-slate-500'
        }`,
      },
      [card.label],
    );
    if (card.help) labelRow.append(helpButton(index));

    const children = [
      labelRow,
      el(
        'div',
        {
          class: `font-display mt-2 text-2xl font-extrabold tracking-tight ${hero ? 'text-white' : 'text-slate-900'}`,
        },
        card.value,
      ),
    ];

    if (card.detail) {
      children.push(
        el('div', { class: `mt-1 text-xs leading-relaxed ${hero ? 'text-white/85' : 'text-slate-500'}` }, card.detail),
      );
    }
    if (card.extra) {
      const extra = el('div', { class: 'mt-3 space-y-1' });
      extra.innerHTML = card.extra;
      children.push(extra);
    }

    root.append(
      el(
        'div',
        {
          class: hero
            ? 'brand-gradient relative overflow-hidden rounded-2xl p-4 shadow-sm ring-1 ring-indigo-300/40'
            : 'rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100',
        },
        children,
      ),
    );
  });

  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-help]');
    if (!button) return;
    const card = cards[Number(button.dataset.help)];
    if (!card?.help) return;
    openModal(card.help.body, { size: 'md', title: card.help.title });
  });

  return root;
}

/* ────────────────────────────────────────────────────────────────────────────
 * scoreTable — the workhorse
 * ──────────────────────────────────────────────────────────────────────────── */

/** How many rows the initial markup carries. The rest streams in. */
export const FIRST_PAINT_ROWS = 80;

/**
 * How long typing settles before a range is applied. Long enough that "3,000"
 * is not filtered as "3" on the way through, short enough that a reader who
 * stops typing sees the answer without wondering whether it took.
 */
const RANGE_DEBOUNCE_MS = 160;

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/** Missing sorts to its own group at the END, in either direction. */
function compareValues(a, b, direction) {
  const aMissing = a === null || a === undefined || (typeof a === 'number' && !Number.isFinite(a));
  const bMissing = b === null || b === undefined || (typeof b === 'number' && !Number.isFinite(b));
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  if (typeof a === 'number' && typeof b === 'number') {
    return direction === 'asc' ? a - b : b - a;
  }
  const result = collator.compare(String(a), String(b));
  return direction === 'asc' ? result : -result;
}

const sortIcon = (state) => {
  if (state === 'asc') return '<span aria-hidden="true" class="ml-1 text-indigo-600">▲</span>';
  if (state === 'desc') return '<span aria-hidden="true" class="ml-1 text-indigo-600">▼</span>';
  return '<span aria-hidden="true" class="ml-1 text-slate-300 group-hover:text-slate-400">↕</span>';
};

/**
 * @param {object} config — see the kit spec.
 * @returns {{html: string, wire(root): object, updateRows(keys): void, view: object}}
 */
export function scoreTable(config) {
  const {
    rows: sourceRows,
    key: keyOf,
    name: nameOf,
    sub: subOf,
    columns,
    filters = [],
    searchable = false,
    searchText,
    searchPlaceholder = 'Search',
    initialSort,
    initialView,
    onRowClick,
    exportName,
    onExport,
    showRank = true,
    nameAfter,
    nameHeading = 'Company',
    nameMaxPx,
    dense = false,
    wrapHeads = false,
    showAvatar = true,
    stickyHead,
    emptyMessage = 'No rows match these filters.',
    rowCountLabel = (shown, total) => `${shown} of ${total}`,
  } = config;

  const tableId = `st-${Math.random().toString(36).slice(2, 9)}`;
  const pad = dense ? 'px-2' : 'px-4';
  const headTracking = dense ? 'tracking-normal' : 'tracking-wider';

  const view = {
    q: initialView?.q ?? '',
    sort: initialView?.sort ?? initialSort ?? null,
    filters: { ...(initialView?.filters ?? {}) },
  };

  /* ---- caches ----------------------------------------------------------
   * htmlCache: key -> markup string, built once per row.
   * nodeCache: key -> the live <tr>, so a re-sort MOVES nodes instead of
   *            re-parsing HTML. That is what keeps a sort fast on 1,202 rows.
   * staleKeys: rows whose per-row state changed and whose live node must be
   *            swapped. Dropping the html cache alone does nothing on the
   *            move path, because no HTML is re-parsed there — which is how a
   *            watchlist star ends up permanently hollow while the filter,
   *            the export and a reload all agree it is starred.
   * -------------------------------------------------------------------- */
  const htmlCache = new Map();
  const nodeCache = new Map();
  const staleKeys = new Set();

  let currentRows = [];
  let root = null;
  let bodyEl = null;
  let sectionEl = null;
  let scrollEl = null;
  let fillFrom = 0;
  let fillHandle = null;
  let scrollFlushAttached = false;

  const searchOf = (row) =>
    (searchText ? searchText(row) : `${nameOf(row) ?? ''} ${subOf?.(row) ?? ''}`).toLowerCase();

  /**
   * The filters in force, resolved ONCE per repaint.
   *
   * Two kinds live here. A `select` filter names one of its own options, so
   * resolving it is a lookup. A `range` filter carries whatever a reader typed,
   * so resolving it is a PARSE — and a parse can fail, which is the whole
   * reason this is a separate step rather than a predicate.
   *
   *   - Parsing inside the row predicate would re-read the same string once per
   *     row, 1,265 times per keystroke.
   *   - And it would leave the failure nowhere a reader can see it. An entry
   *     that cannot be read must hide NOTHING and say so (CLAUDE.md §2.4): a
   *     typo silently filtered to an empty table reads as a finding about the
   *     companies. So a broken range yields no matcher at all, and its reason
   *     travels out of here to the status line and into the export.
   */
  function activeFilters() {
    const resolved = [];
    for (const filter of filters) {
      const value = view.filters[filter.id];
      if (value === undefined || value === null || value === '') continue;
      if (filter.kind === 'range') {
        const parsed = filter.parse(value);
        resolved.push({
          filter,
          parsed,
          match: parsed.active ? (row) => filter.match(row, parsed) : null,
        });
        continue;
      }
      const option = filter.options.find((o) => o.value === value);
      if (!option) continue;
      resolved.push({ filter, option, match: option.match ?? null });
    }
    return resolved;
  }

  /**
   * What the filters currently in force are doing, in words — for the status
   * line under the toolbar and for row 1 of any export.
   *
   * A range that could not be read is NAMED here rather than omitted. The file
   * it lands in is genuinely unfiltered by it, and a sheet that simply said
   * nothing would contradict the screen the reader was looking at.
   */
  function filterSummary() {
    return activeFilters()
      .map((entry) => {
        if (entry.filter.kind !== 'range') {
          return entry.filter.describe
            ? entry.filter.describe(entry.option)
            : `${entry.filter.label}: ${entry.option.label}`;
        }
        if (entry.parsed.error) {
          return `${entry.filter.label}: ${entry.parsed.error} — NOT applied, so it hid nothing`;
        }
        return entry.parsed.active ? entry.filter.describe(entry.parsed) : null;
      })
      .filter(Boolean)
      .join('; ');
  }

  function computeRows() {
    const query = view.q.trim().toLowerCase();
    const matchers = activeFilters().map((entry) => entry.match).filter(Boolean);
    let list = sourceRows.filter((row) => matchers.every((match) => match(row)));
    if (query) {
      const terms = query.split(/\s+/).filter(Boolean);
      list = list.filter((row) => {
        const haystack = searchOf(row);
        return terms.every((term) => haystack.includes(term));
      });
    }
    if (view.sort) {
      const column = columns.find((c) => c.label === view.sort.key);
      if (column) {
        const valueOf = column.sortValue ?? column.get;
        list = [...list].sort((a, b) => compareValues(valueOf(a), valueOf(b), view.sort.dir));
      }
    }
    return list;
  }

  /* ---- row markup: position-independent, cached by key ----------------- */
  function buildRowHtml(row) {
    const key = keyOf(row);
    const cells = [];

    if (showRank) {
      cells.push(
        `<td class="${pad} py-2.5 text-right text-xs font-semibold text-slate-400 tabular-nums" data-rank></td>`,
      );
    }

    const nameStyle = nameMaxPx ? ` style="max-width:${nameMaxPx}px"` : '';
    cells.push(
      `<td class="${pad} py-2.5"${nameStyle}>` +
        '<div class="flex items-center gap-2.5">' +
        (nameAfter ? nameAfter(row) : '') +
        (showAvatar ? avatarFor(nameOf(row)) : '') +
        `<div class="min-w-0"${nameMaxPx ? ` style="max-width:${nameMaxPx - (showAvatar ? 44 : 0) - (nameAfter ? 26 : 0)}px"` : ''}>` +
        `<div class="truncate text-[13px] font-semibold leading-tight text-slate-900" title="${escapeHtml(nameOf(row))}">${escapeHtml(nameOf(row))}</div>` +
        (subOf ? `<div class="truncate text-[11px] leading-tight text-slate-500">${subOf(row)}</div>` : '') +
        '</div></div></td>',
    );

    for (const column of columns) {
      const align =
        column.align === 'right' ? 'text-right' : column.align === 'center' ? 'text-center' : 'text-left';
      const value = column.get(row);
      const content = column.html ? (value ?? '') : escapeHtml(value ?? '');
      cells.push(
        `<td class="${pad} py-2.5 text-[13px] ${align} ${column.cellClass ?? 'text-slate-700'}">${content}</td>`,
      );
    }

    return (
      `<tr data-key="${escapeHtml(key)}" tabindex="-1" class="cursor-pointer border-b border-slate-50 outline-none transition hover:bg-indigo-50/40 focus-visible:bg-indigo-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500">` +
      cells.join('') +
      '</tr>'
    );
  }

  function rowHtml(row) {
    const key = keyOf(row);
    let html = htmlCache.get(key);
    if (html === undefined) {
      html = buildRowHtml(row);
      htmlCache.set(key, html);
    }
    return html;
  }

  /** Markup for a RANGE, so first paint can carry a screenful and no more. */
  function bodyHtml(list, from, to) {
    const parts = [];
    for (let i = from; i < Math.min(to, list.length); i += 1) parts.push(rowHtml(list[i]));
    return parts.join('');
  }

  function headHtml() {
    const heads = [];
    if (showRank) {
      heads.push(
        `<th scope="col" class="${pad} py-2.5 text-right text-[10px] font-bold uppercase ${headTracking} text-slate-400">#</th>`,
      );
    }
    heads.push(
      `<th scope="col" class="${pad} py-2.5 text-left text-[10px] font-bold uppercase ${headTracking} text-slate-500">${escapeHtml(nameHeading)}</th>`,
    );
    for (const column of columns) {
      const align =
        column.align === 'right' ? 'text-right' : column.align === 'center' ? 'text-center' : 'text-left';
      const sortable = column.sortable !== false;
      const state = view.sort?.key === column.label ? view.sort.dir : null;
      const wrap = wrapHeads ? 'whitespace-normal' : 'whitespace-nowrap';
      const inner = sortable
        ? `<button type="button" data-sort="${escapeHtml(column.label)}" class="group inline-flex items-center ${
            column.align === 'right' ? 'flex-row-reverse' : ''
          } font-bold uppercase ${headTracking} text-[10px] text-slate-500 hover:text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 rounded">` +
          `<span>${escapeHtml(column.label)}</span>${sortIcon(state)}</button>`
        : `<span class="text-[10px] font-bold uppercase ${headTracking} text-slate-500">${escapeHtml(column.label)}</span>`;
      heads.push(
        `<th scope="col" aria-sort="${state === 'asc' ? 'ascending' : state === 'desc' ? 'descending' : 'none'}" ` +
          `class="${pad} py-2.5 ${align} ${wrap} align-bottom">${inner}</th>`,
      );
    }
    return `<tr>${heads.join('')}</tr>`;
  }

  /**
   * A typed min–max range: TWO SEPARATE BOXES with the dash between them, and
   * the unit stated on the outside so the whole reads as ₹3,000–8,000 Cr — the
   * way this desk writes a range down, and the way `describe()` says it back.
   *
   * It replaced a five-option dropdown on 31 Aug 2026. A dropdown can only
   * offer boundaries somebody chose in advance, and the ones on offer were an
   * order of magnitude apart at the top — useful for a first cut through a
   * universe that spans four orders of magnitude, useless for "show me the
   * companies between ₹3,000 and ₹8,000 Cr", which is the question the desk
   * actually asks around a review.
   *
   * Both ends are OPTIONAL. An empty box is an open end, never a zero: leaving
   * the maximum blank asks for everything upwards, and it must not be confused
   * with typing a 0 there, which asks for a maximum of nothing.
   *
   * The unit is rendered as part of the control rather than left to a caption,
   * because a bare pair of numbers beside a market-cap column is exactly the
   * kind of thing a reader supplies their own unit for — and being out by a
   * factor of ten million is this project's signature failure (CLAUDE.md §3.8).
   *
   * Each end gets its OWN box, carrying the same chrome as the selects beside
   * it, so the two are visibly two fields and the dash between them is a
   * separator rather than something inside a single field. The invalid ring
   * therefore lands on the inputs rather than on a wrapper: both are marked,
   * because the parser rejects the RANGE and either end may be what broke it —
   * reddening one box would name a culprit we have not identified.
   */
  function rangeControlHtml(filter) {
    const value = view.filters[filter.id] ?? {};
    // The same chrome the selects in this toolbar carry — radius, ring, shadow
    // and height — so the range does not read as a different KIND of control
    // from the filters either side of it.
    const box = (side, placeholder) =>
      `<input data-range-${side} type="text" inputmode="decimal" autocomplete="off" spellcheck="false" ` +
      `value="${escapeHtml(value[side] ?? '')}" placeholder="${escapeHtml(placeholder)}" ` +
      `aria-label="${escapeHtml(`${filter.label} ${side === 'min' ? 'minimum' : 'maximum'}${filter.unitSuffix ? `, in ${filter.unitPrefix ?? ''}${filter.unitSuffix}` : ''}`)}" ` +
      // Right-aligned, like every numeric column in the table below it.
      'class="w-[4.75rem] rounded-xl border-0 bg-white py-2 px-2.5 text-right text-xs font-semibold tabular-nums ' +
      'text-slate-800 shadow-sm ring-1 ring-slate-200 placeholder:font-normal placeholder:text-slate-400 ' +
      'focus:outline-none focus:ring-2 focus:ring-indigo-500">';

    return (
      '<div class="flex items-center gap-2 text-[11px] font-semibold text-slate-500">' +
        `<span class="whitespace-nowrap">${escapeHtml(filter.label)}</span>` +
        `<span data-range="${escapeHtml(filter.id)}" ` +
        `${filter.hint ? `title="${escapeHtml(filter.hint)}" ` : ''}` +
        'class="inline-flex items-center gap-1.5">' +
          (filter.unitPrefix ? `<span aria-hidden="true" class="text-slate-400">${escapeHtml(filter.unitPrefix)}</span>` : '') +
          box('min', filter.placeholders?.min ?? 'min') +
          '<span aria-hidden="true" class="px-0.5 text-slate-400">–</span>' +
          box('max', filter.placeholders?.max ?? 'max') +
          (filter.unitSuffix ? `<span aria-hidden="true" class="text-slate-400">${escapeHtml(filter.unitSuffix)}</span>` : '') +
          '<button type="button" data-range-clear hidden aria-label="Clear the range" title="Clear the range" ' +
          'class="rounded text-slate-400 transition hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500">' +
          '<svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">' +
          '<path d="m5 5 10 10M15 5 5 15" stroke-linecap="round"/></svg></button>' +
        '</span></div>'
    );
  }

  function toolbarHtml() {
    const parts = [];
    if (searchable) {
      parts.push(
        '<div class="relative min-w-[200px] flex-1 sm:max-w-xs">' +
          '<span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true">' +
          '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="9" r="6"/><path d="m14 14 4 4" stroke-linecap="round"/></svg></span>' +
          `<input data-search type="search" value="${escapeHtml(view.q)}" placeholder="${escapeHtml(searchPlaceholder)}" aria-label="${escapeHtml(searchPlaceholder)}" ` +
          'class="w-full rounded-xl border-0 bg-white py-2 pl-9 pr-3 text-sm shadow-sm ring-1 ring-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"></div>',
      );
    }

    for (const filter of filters) {
      if (filter.kind === 'range') {
        parts.push(rangeControlHtml(filter));
        continue;
      }
      const options = [
        `<option value="">${escapeHtml(filter.allLabel ?? `All ${filter.label.toLowerCase()}`)}</option>`,
        ...filter.options.map(
          (option) =>
            `<option value="${escapeHtml(option.value)}"${view.filters[filter.id] === option.value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`,
        ),
      ].join('');
      parts.push(
        '<label class="flex items-center gap-2 text-[11px] font-semibold text-slate-500">' +
          `<span class="whitespace-nowrap">${escapeHtml(filter.label)}</span>` +
          `<select data-filter="${escapeHtml(filter.id)}" class="rounded-xl border-0 bg-white py-2 pl-2.5 pr-7 text-xs font-medium text-slate-800 shadow-sm ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"` +
          `${filter.note ? ` title="${escapeHtml(filter.note)}"` : ''}>${options}</select></label>`,
      );
    }

    parts.push(
      '<div class="ml-auto flex items-center gap-3">' +
        '<span data-row-count class="text-[11px] font-semibold tabular-nums text-slate-500"></span>' +
        (exportName
          ? '<button type="button" data-export class="inline-flex items-center gap-1.5 rounded-xl bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200 transition hover:ring-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-500">' +
            '<svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10 3v10m0 0 4-4m-4 4-4-4M4 16h12" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            'Export CSV</button>'
          : '') +
        '</div>',
    );

    const notes = filters.filter((f) => f.note).map((f) => f.note);
    return (
      '<div class="flex flex-wrap items-center gap-3">' + parts.join('') + '</div>' +
      // WHAT THE TYPED ENTRY WAS READ AS, in the reader's own sight line. A
      // range is the one filter whose meaning is not visible in the control
      // itself: "3,000" could have been read as 3, and an unreadable entry
      // could have been read as nothing at all. Both are stated here, and the
      // text is written with textContent — never innerHTML — because it quotes
      // back exactly what somebody typed.
      '<p data-filter-status hidden class="mt-2 text-[11px] font-medium leading-relaxed"></p>' +
      (notes.length
        ? `<p class="mt-2 text-[11px] leading-relaxed text-slate-400">${notes.map(escapeHtml).join(' ')}</p>`
        : '')
    );
  }

  currentRows = computeRows();

  const scrollStyle = stickyHead ? ` style="max-height:${stickyHead}"` : '';
  const html =
    `<section data-score-table="${tableId}" class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100">` +
    `<div data-toolbar class="mb-3">${toolbarHtml()}</div>` +
    `<div data-table-scroll class="overflow-auto rounded-xl ring-1 ring-slate-100"${scrollStyle}>` +
    '<table class="w-full border-collapse text-left">' +
    `<thead class="${stickyHead ? 'sticky top-0 z-10' : ''} bg-slate-50/95 backdrop-blur">${headHtml()}</thead>` +
    `<tbody data-score-body>${bodyHtml(currentRows, 0, FIRST_PAINT_ROWS)}</tbody>` +
    '</table>' +
    `<p data-empty class="px-4 py-10 text-center text-sm text-slate-400"${currentRows.length ? ' hidden' : ''}>${escapeHtml(emptyMessage)}</p>` +
    '</div></section>';

  /* ---- streaming fill --------------------------------------------------
   * Every row ends up in the DOM. This is NOT virtualisation and must not
   * become it: Ctrl-F, screenshots and the accessibility tree all have to
   * behave normally. First paint carries a screenful so the page is
   * interactive immediately; the rest arrives in idle slices.
   * -------------------------------------------------------------------- */
  function setPending() {
    if (!sectionEl) return;
    const outstanding = Math.max(0, currentRows.length - fillFrom);
    if (outstanding > 0) sectionEl.setAttribute('data-rows-pending', String(outstanding));
    else sectionEl.removeAttribute('data-rows-pending');
  }

  /**
   * Live <tr> nodes for a range, reusing anything already built.
   *
   * The reuse is the point: a re-sort keeps the same row set, so every node
   * comes out of the cache and the browser MOVES it rather than re-parsing
   * 1,202 rows of HTML. Only genuinely new keys cost a parse, and they are
   * parsed in one batch rather than one at a time.
   */
  function nodesFor(list, from, to) {
    const end = Math.min(to, list.length);
    const missing = [];
    for (let i = from; i < end; i += 1) {
      const key = keyOf(list[i]);
      if (!nodeCache.has(key)) missing.push(list[i]);
    }
    if (missing.length) {
      const holder = document.createElement('tbody');
      holder.innerHTML = missing.map(rowHtml).join('');
      for (const node of [...holder.children]) nodeCache.set(node.dataset.key, node);
    }
    const nodes = [];
    for (let i = from; i < end; i += 1) {
      const node = nodeCache.get(keyOf(list[i]));
      if (node) nodes.push(node);
    }
    return nodes;
  }

  function appendSlice(count) {
    if (fillFrom >= currentRows.length) return 0;
    const to = Math.min(fillFrom + count, currentRows.length);
    const nodes = nodesFor(currentRows, fillFrom, to);
    const fragment = document.createDocumentFragment();
    fragment.append(...nodes);
    bodyEl.append(fragment);
    const appended = to - fillFrom;
    fillFrom = to;
    return appended;
  }

  function flushRemaining() {
    while (fillFrom < currentRows.length) appendSlice(2000);
    setPending();
    detachScrollFlush();
    if (fillHandle !== null) {
      if (typeof cancelIdleCallback === 'function') cancelIdleCallback(fillHandle);
      else clearTimeout(fillHandle);
      fillHandle = null;
    }
  }

  /** The reader has scrolled to the painted edge — stop being clever. */
  function onScrollFlush() {
    if (!scrollEl) return;
    const nearEnd = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 400;
    if (nearEnd) flushRemaining();
  }

  function attachScrollFlush() {
    if (scrollFlushAttached || !scrollEl) return;
    scrollEl.addEventListener('scroll', onScrollFlush, { passive: true });
    window.addEventListener('scroll', onScrollFlush, { passive: true });
    scrollFlushAttached = true;
  }

  function detachScrollFlush() {
    if (!scrollFlushAttached) return;
    scrollEl?.removeEventListener('scroll', onScrollFlush);
    window.removeEventListener('scroll', onScrollFlush);
    scrollFlushAttached = false;
  }

  function scheduleFill() {
    setPending();
    if (fillFrom >= currentRows.length) {
      detachScrollFlush();
      return;
    }
    attachScrollFlush();
    // Timeout, so a backgrounded tab (where idle callbacks never fire) still
    // completes rather than leaving a half-painted table behind.
    fillHandle = onIdle((deadline) => {
      fillHandle = null;
      let slice = 150;
      do {
        const started = performance.now();
        const appended = appendSlice(slice);
        if (appended === 0) break;
        const elapsed = performance.now() - started;
        // Adaptive: aim at roughly 6ms of work per chunk.
        slice = Math.max(50, Math.min(1200, Math.round((slice * 6) / Math.max(elapsed, 0.6))));
      } while (fillFrom < currentRows.length && (deadline?.timeRemaining?.() ?? 0) > 4);
      scheduleFill();
    }, 200);
  }

  /** Swap the live nodes of rows whose per-row state changed. */
  function replaceStaleRows() {
    if (staleKeys.size === 0) return;
    for (const key of staleKeys) {
      htmlCache.delete(key);
      const existing = nodeCache.get(key);
      if (!existing) continue;
      const row = currentRows.find((r) => keyOf(r) === key) ?? sourceRows.find((r) => keyOf(r) === key);
      if (!row) continue;
      const holder = document.createElement('tbody');
      holder.innerHTML = rowHtml(row);
      const fresh = holder.firstElementChild;
      const hadFocus = document.activeElement === existing;
      fresh.tabIndex = existing.tabIndex;
      nodeCache.set(key, fresh);
      if (existing.parentNode) existing.replaceWith(fresh);
      if (hadFocus) fresh.focus({ preventScroll: true });
    }
    staleKeys.clear();
  }

  /* ---- the typed range ------------------------------------------------- */
  let rangeTimer = null;

  /**
   * Read both boxes of one range control into the view and repaint.
   *
   * The RAW TEXT is what is stored, not the parsed numbers. A reader who typed
   * something unreadable must still see it sitting there — normalising it away,
   * or storing only what parsed, would silently rewrite the question they
   * asked. Parsing happens on the way out, in `activeFilters`, every time.
   */
  function applyRange(input) {
    const wrap = input?.closest('[data-range]');
    if (!wrap) return;
    const id = wrap.dataset.range;
    const min = wrap.querySelector('[data-range-min]')?.value ?? '';
    const max = wrap.querySelector('[data-range-max]')?.value ?? '';
    const current = view.filters[id];
    if (current && current.min === min && current.max === max) return;
    // A NEW object every time. `lastView` keeps a shallow copy of this map, so
    // mutating one in place would silently edit a snapshot taken earlier.
    view.filters[id] = { min, max };
    config.onViewChange?.(view);
    repaint({ resetScroll: true });
  }

  function clearRange(wrap, focusTarget) {
    if (!wrap) return;
    clearTimeout(rangeTimer);
    for (const input of wrap.querySelectorAll('input')) input.value = '';
    view.filters[wrap.dataset.range] = { min: '', max: '' };
    config.onViewChange?.(view);
    repaint({ resetScroll: true });
    focusTarget?.focus();
  }

  /**
   * Repaint. When the row set is unchanged this MOVES existing <tr> nodes,
   * which is what makes a sort on 1,202 rows feel instant.
   */
  function repaint({ resetScroll = false } = {}) {
    currentRows = computeRows();
    fillFrom = 0;
    empty(bodyEl);

    const upTo = Math.min(FIRST_PAINT_ROWS, currentRows.length);
    const fragment = document.createDocumentFragment();
    fragment.append(...nodesFor(currentRows, 0, upTo));
    bodyEl.append(fragment);
    fillFrom = upTo;

    $('[data-empty]', root).hidden = currentRows.length > 0;
    seedRovingTabStop();
    updateCount();
    updateFilterStatus();
    updateHead();
    if (resetScroll && scrollEl) scrollEl.scrollTop = 0;
    scheduleFill();
  }

  /**
   * Exactly ONE tab stop for the whole grid, moved with the arrow keys.
   *
   * Making every row focusable would put 1,202 tab stops between the toolbar
   * and anything below the table, which is hostile rather than accessible. The
   * roving pattern gives a keyboard user one stop in, arrow keys to move, and
   * Enter to open the drill.
   */
  function seedRovingTabStop() {
    const first = bodyEl?.firstElementChild;
    if (first) first.tabIndex = 0;
  }

  function moveFocus(fromRow, delta) {
    const target =
      delta > 0 ? fromRow.nextElementSibling : fromRow.previousElementSibling;
    if (!target) return;
    fromRow.tabIndex = -1;
    target.tabIndex = 0;
    target.focus();
    target.scrollIntoView({ block: 'nearest' });
  }

  function updateCount() {
    const node = $('[data-row-count]', root);
    // Reads the ARRAY, never the DOM: rows are still streaming in.
    if (node) node.textContent = rowCountLabel(currentRows.length, sourceRows.length);
  }

  /**
   * Repaint the status line and the state of every range control.
   *
   * Three states, and they must be told apart at a glance:
   *
   *   idle     nothing typed — no line at all, and no clear button
   *   in force the parsed range, spelled out with its unit and its inclusivity
   *   broken   the reason it could not be read, in rose, on inputs marked
   *            aria-invalid — AND the rows left exactly as they were
   *
   * The third is the one that matters. An unreadable entry that quietly
   * filtered to nothing would put an empty table in front of a reader who would
   * reasonably conclude no company is that size (CLAUDE.md §2.4: a failure is
   * not an absence).
   */
  function updateFilterStatus() {
    const node = $('[data-filter-status]', root);
    const lines = [];
    let broken = false;

    for (const entry of activeFilters()) {
      if (entry.filter.kind !== 'range') continue;
      const wrap = root?.querySelector(`[data-range="${entry.filter.id}"]`);
      const inputs = wrap ? [...wrap.querySelectorAll('input')] : [];
      const clear = wrap?.querySelector('[data-range-clear]');
      const failed = Boolean(entry.parsed.error);

      // BOTH boxes, not one. The parser rejects the range as a whole and either
      // end may be what broke it, so reddening a single box would point at a
      // culprit nobody identified.
      for (const input of inputs) {
        input.setAttribute('aria-invalid', failed ? 'true' : 'false');
        input.classList.toggle('ring-rose-400', failed);
        input.classList.toggle('ring-2', failed);
        input.classList.toggle('ring-slate-200', !failed);
        input.classList.toggle('ring-1', !failed);
      }
      if (clear) clear.hidden = entry.parsed.empty;

      if (failed) {
        broken = true;
        lines.push(`${entry.filter.label}: ${entry.parsed.error}. The range is NOT applied — every row is still listed.`);
      } else if (entry.parsed.active) {
        lines.push(`${entry.filter.describe(entry.parsed)}.`);
      }
    }

    if (!node) return;
    node.textContent = lines.join(' ');
    node.hidden = lines.length === 0;
    node.classList.toggle('text-rose-600', broken);
    node.classList.toggle('text-slate-500', !broken);
  }

  /**
   * Update the sort indicators IN PLACE.
   *
   * Replacing `thead.innerHTML` was the obvious version and it is wrong: it
   * destroys the very button the reader just activated, so a keyboard user who
   * sorts with Enter is thrown back to the top of the document, and any handle
   * held on that element goes stale. Only the two things that actually changed
   * are touched.
   */
  function updateHead() {
    const thead = $('thead', root);
    if (!thead) return;
    for (const button of $$('[data-sort]', thead)) {
      const label = button.dataset.sort;
      const state = view.sort?.key === label ? view.sort.dir : null;
      const icon = button.lastElementChild;
      if (icon) icon.outerHTML = sortIcon(state);
      const th = button.closest('th');
      if (th) {
        th.setAttribute('aria-sort', state === 'asc' ? 'ascending' : state === 'desc' ? 'descending' : 'none');
      }
    }
  }

  function wire(container) {
    root = container.matches?.('[data-score-table]')
      ? container
      : $(`[data-score-table="${tableId}"]`, container);
    if (!root) return api;
    sectionEl = root;
    bodyEl = $('[data-score-body]', root);
    scrollEl = $('[data-table-scroll]', root);

    for (const node of [...bodyEl.children]) nodeCache.set(node.dataset.key, node);
    fillFrom = Math.min(FIRST_PAINT_ROWS, currentRows.length);
    seedRovingTabStop();

    // ---- delegated listeners. Never per row. ----
    $('thead', root).addEventListener('click', (event) => {
      const button = event.target.closest('[data-sort]');
      if (!button) return;
      const key = button.dataset.sort;
      const column = columns.find((c) => c.label === key);
      const preferred = column?.defaultDir ?? 'desc';
      view.sort =
        view.sort?.key === key
          ? { key, dir: view.sort.dir === 'asc' ? 'desc' : 'asc' }
          : { key, dir: preferred };
      repaint({ resetScroll: true });
    });

    bodyEl.addEventListener('click', (event) => {
      const control = event.target.closest('[data-row-action]');
      const tr = event.target.closest('tr[data-key]');
      if (!tr) return;
      if (control) {
        event.stopPropagation();
        config.onRowAction?.(control.dataset.rowAction, tr.dataset.key, control);
        return;
      }
      onRowClick?.(tr.dataset.key);
    });

    bodyEl.addEventListener('keydown', (event) => {
      const tr = event.target.closest('tr[data-key]');
      if (!tr) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        // The reader is walking the grid — finish the fill so the rows below
        // actually exist to move onto.
        if (event.key === 'ArrowDown' && !tr.nextElementSibling) flushRemaining();
        moveFocus(tr, event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        if (event.key === 'End') flushRemaining();
        const target = event.key === 'Home' ? bodyEl.firstElementChild : bodyEl.lastElementChild;
        if (target) {
          tr.tabIndex = -1;
          target.tabIndex = 0;
          target.focus();
        }
        return;
      }
      if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('button')) {
        event.preventDefault();
        onRowClick?.(tr.dataset.key);
      }
    });

    const search = $('[data-search]', root);
    if (search) {
      let timer = null;
      search.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          view.q = search.value;
          config.onViewChange?.(view);
          repaint({ resetScroll: true });
        }, 120);
      });
    }

    const toolbar = $('[data-toolbar]', root);

    toolbar.addEventListener('change', (event) => {
      const select = event.target.closest('select[data-filter]');
      if (select) {
        view.filters[select.dataset.filter] = select.value;
        config.onViewChange?.(view);
        repaint({ resetScroll: true });
        return;
      }
      // A range box committed by blur or by the browser's own change event.
      const typed = event.target.closest('[data-range-min], [data-range-max]');
      if (typed) {
        clearTimeout(rangeTimer);
        applyRange(typed);
      }
    });

    /**
     * Typing is debounced, Enter is not.
     *
     * The delay exists because "3,000" passes through "3" on its way to being
     * typed, and repainting 1,265 rows for a prefix nobody meant is both slow
     * and, for a moment, a wrong answer on screen. Enter and blur bypass it, so
     * a reader who has finished never waits on a timer.
     */
    toolbar.addEventListener('input', (event) => {
      const typed = event.target.closest('[data-range-min], [data-range-max]');
      if (!typed) return;
      clearTimeout(rangeTimer);
      rangeTimer = setTimeout(() => applyRange(typed), RANGE_DEBOUNCE_MS);
    });

    toolbar.addEventListener('keydown', (event) => {
      const typed = event.target.closest('[data-range-min], [data-range-max]');
      if (!typed) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        clearTimeout(rangeTimer);
        applyRange(typed);
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        clearRange(typed.closest('[data-range]'), typed);
      }
    });

    toolbar.addEventListener('click', (event) => {
      const button = event.target.closest('[data-range-clear]');
      if (!button) return;
      const wrap = button.closest('[data-range]');
      clearRange(wrap, wrap?.querySelector('[data-range-min]'));
    });

    const exportButton = $('[data-export]', root);
    if (exportButton) {
      exportButton.addEventListener('click', () => onExport?.(currentRows, view));
    }

    updateCount();
    updateFilterStatus();
    scheduleFill();
    return api;
  }

  const api = {
    html,
    wire,
    view,
    /** Public form of the stale-key path. */
    updateRows(keys) {
      for (const key of [keys].flat()) staleKeys.add(key);
      replaceStaleRows();
    },
    /** Re-run filters and sort — used when external state (watchlist) filters rows. */
    refresh(options) {
      if (root) repaint(options ?? {});
    },
    rows: () => currentRows,
    /** The filters in force, in words — for row 1 of an export. */
    filterSummary,
    flush: flushRemaining,
  };

  return api;
}
