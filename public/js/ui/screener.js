/**
 * THE KIT: sectionHead, statStrip, scoreTable, openDrill, openModal, trapFocus.
 *
 * Built as reusable modules rather than one page, because later work adds
 * columns to this same table and drives it in tests.
 */

import { $, $$, el, empty, escapeHtml, onIdle } from '../core/dom.js';
import { getColumnPrefs, setColumnPrefs } from '../core/state.js';
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

/* ────────────────────────────────────────────────────────────────────────────
 * Column layout — widths the reader sets, and columns the reader puts away
 *
 * ⚠ A COLUMN WIDTH CAN MANUFACTURE A WRONG NUMBER, AND IT LOOKS EXACTLY LIKE A
 * RIGHT ONE. This is CLAUDE.md §2.20 at the layout layer rather than the
 * formatter layer, and it is the reason most of the code below exists.
 *
 * Measured in Chrome on the committed record: with `table-layout: fixed` and
 * the Free float column squeezed to 70px, `10,99,757` renders as `10,99,75`.
 * Not blank, not an em dash, not an error — a clean, plausible, ten-times-wrong
 * number, on the largest bank in the country. A reader has no way to tell that
 * from a real figure.
 *
 * So a narrowed column must make its own clipping VISIBLE, and getting that
 * right needed measuring rather than assuming. `text-overflow: ellipsis` was
 * the obvious answer and it is only two-thirds of one:
 *
 *   cell content                                    squeezed → renders
 *   ─────────────────────────────────────────────   ──────────────────────
 *   plain text            `10,99,757`                `12,34…`      ellipsis
 *   inline flow + chips   `<span>n</span><chip>`     `10,9…`       ellipsis
 *   two or more chips     `<chip><chip>`             `SMIN …`      ellipsis
 *   ONE atomic inline     `<span class=inline-flex>` `10,99,75`    NO ELLIPSIS
 *
 * Chrome draws the ellipsis by replacing trailing items on the line, so a line
 * box holding exactly one atomic inline — an `inline-flex`/`inline-block` box —
 * has nothing to replace and is simply cut. Wrapping it in a plain `<span>`
 * does not help; a trailing zero-width space does not help; a leading one puts
 * the ellipsis first and eats the whole cell. Both were tried and measured.
 *
 * Hence TWO mechanisms, not one:
 *
 *   1. `text-overflow: ellipsis` on every body cell, which covers every cell
 *      whose content is inline flow. Cell renderers are written to stay inside
 *      that shape (see the Free float, vs segment and Funds columns in
 *      tabs/companies.js, which lost their single flex wrapper for this).
 *   2. A FADE MASK on the clipped edge of every cell in a narrowed column,
 *      which needs no cooperation from the cell's markup at all. It is a
 *      no-op where nothing reaches the edge — non-truncated content stops at
 *      the cell's padding — and where content IS cut it dissolves rather than
 *      ending in a hard, readable edge. That is the backstop for the lone-atomic
 *      case above and for any cell renderer written later.
 *
 * THE FADE IS EXACTLY THE CELL'S OWN PADDING WIDE, and that is what makes it
 * safe to apply to every cell rather than only to the ones measured to be
 * clipping. Content that fits stops at the padding edge, so the faded strip is
 * empty and nothing changes; content that is cut runs to the border edge, so
 * the faded strip is exactly the part that was cut. No per-cell measurement, no
 * bookkeeping of which column is narrower than its content, and no case where
 * ink is dimmed for no reason.
 * ──────────────────────────────────────────────────────────────────────────── */

/** A column may be squeezed to here and no further. Below this a column is
 *  effectively invisible while still sorting the table, which is a control the
 *  reader cannot see the effect of. Hiding one is a separate, explicit act. */
export const MIN_COL_PX = 48;
/** And no wider than this, so a runaway drag cannot strand the other columns
 *  off-screen with no obvious way back. */
export const MAX_COL_PX = 900;
/** Keyboard resize step, and the shift-key step. */
const NUDGE_PX = 16;
const NUDGE_FAST_PX = 48;

const columnsIcon =
  '<svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">' +
  '<rect x="2.5" y="3.5" width="15" height="13" rx="1.5"/><path d="M7.5 3.5v13M12.5 3.5v13"/></svg>';

const clamp = (px) => Math.max(MIN_COL_PX, Math.min(MAX_COL_PX, Math.round(px)));

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
    /** Turns width-dragging and column hiding on, and names the localStorage
     *  slot they persist in. Omit it and the table behaves exactly as before. */
    columnsKey,
    emptyMessage = 'No rows match these filters.',
    rowCountLabel = (shown, total) => `${shown} of ${total}`,
  } = config;

  const tableId = `st-${Math.random().toString(36).slice(2, 9)}`;
  const pad = dense ? 'px-2' : 'px-4';
  const headTracking = dense ? 'tracking-normal' : 'tracking-wider';

  /* ---- the column layout model ----------------------------------------
   * One entry per rendered column, INCLUDING the two the caller does not
   * declare (the rank counter and the name column), because a width map that
   * covered only the declared columns could not add up to a table width.
   *
   * `id` is positional and lives only in the DOM, where it goes into a CSS
   * selector; `label` is the identity that persists. Selecting on the label
   * instead would mean escaping `₹`, `%`, `(` and a space into an attribute
   * selector for every rule, and getting that wrong silently matches nothing.
   * -------------------------------------------------------------------- */
  const layout = [
    ...(showRank ? [{ id: 'rk', label: '#', hideable: false, resizable: false }] : []),
    { id: 'nm', label: nameHeading, hideable: false, resizable: true },
    ...columns.map((column, index) => ({
      id: `c${index}`,
      label: column.label,
      // Every declared column may be put away. The name column may not: a row
      // with no name is a row the reader cannot identify, and the rest of the
      // line is meaningless without it.
      hideable: true,
      resizable: true,
      column,
    })),
  ];
  const layoutById = new Map(layout.map((entry) => [entry.id, entry]));
  // Column LABELS are already required to be unique by the kit — `view.sort.key`
  // is a label and the sort resolves it with `columns.find` — so keying stored
  // widths on the label adds no new constraint.
  const resizable = Boolean(columnsKey);
  const stored = resizable ? getColumnPrefs(columnsKey) : { widths: {}, hidden: [] };
  const knownLabels = new Set(layout.map((c) => c.label));
  /** label -> px. Empty means automatic layout, exactly as before this feature. */
  const widths = new Map(
    Object.entries(stored.widths).filter(([label]) => knownLabels.has(label)).map(([l, px]) => [l, clamp(px)]),
  );
  const hidden = new Set(
    stored.hidden.filter((label) => layout.some((c) => c.label === label && c.hideable)),
  );
  /** What each column measured under automatic layout — the width at which it
   *  fits its own content, and therefore the width below which it can clip. */
  const naturalWidths = new Map();
  const colFor = (label) => layout.find((c) => c.label === label) ?? null;
  const visibleColumns = () => layout.filter((c) => !hidden.has(c.label));

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
        `<td data-col="rk" class="${pad} py-2.5 text-right text-xs font-semibold text-slate-400 tabular-nums" data-rank></td>`,
      );
    }

    const nameStyle = nameMaxPx ? ` style="max-width:${nameMaxPx}px"` : '';
    cells.push(
      `<td data-col="nm" class="${pad} py-2.5"${nameStyle}>` +
        '<div class="flex items-center gap-2.5">' +
        (nameAfter ? nameAfter(row) : '') +
        (showAvatar ? avatarFor(nameOf(row)) : '') +
        `<div class="min-w-0"${nameMaxPx ? ` style="max-width:${nameMaxPx - (showAvatar ? 44 : 0) - (nameAfter ? 26 : 0)}px"` : ''}>` +
        `<div class="truncate text-[13px] font-semibold leading-tight text-slate-900" title="${escapeHtml(nameOf(row))}">${escapeHtml(nameOf(row))}</div>` +
        (subOf ? `<div class="truncate text-[11px] leading-tight text-slate-500">${subOf(row)}</div>` : '') +
        '</div></div></td>',
    );

    for (const [index, column] of columns.entries()) {
      const align =
        column.align === 'right' ? 'text-right' : column.align === 'center' ? 'text-center' : 'text-left';
      const value = column.get(row);
      const content = column.html ? (value ?? '') : escapeHtml(value ?? '');
      cells.push(
        `<td data-col="c${index}" class="${pad} py-2.5 text-[13px] ${align} ${column.cellClass ?? 'text-slate-700'}">${content}</td>`,
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

  /**
   * The drag target at a column's trailing edge.
   *
   * `role="separator"` with a tabindex is the ARIA pattern for a splitter, so
   * the arrow keys are not an extra affordance bolted on for the audit — they
   * are the only way a keyboard user can resize at all, and a mouse-only
   * resize would be a control a keyboard reader can see and not operate.
   */
  function resizeHandleHtml(entry) {
    if (!resizable || !entry.resizable) return '';
    return (
      `<span data-resize="${entry.id}" role="separator" aria-orientation="vertical" tabindex="0"` +
      ` aria-label="Resize the ${escapeHtml(entry.label)} column"` +
      ' title="Drag to resize. Double-click to fit the content. Arrow keys nudge; hold Shift for larger steps."' +
      ' class="group/resize absolute inset-y-0 right-0 z-20 flex w-2.5 cursor-col-resize touch-none select-none items-center justify-center' +
      ' focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500">' +
      '<span aria-hidden="true" class="h-1/2 w-px bg-slate-300 transition group-hover/resize:w-0.5 group-hover/resize:bg-indigo-500"></span></span>'
    );
  }

  function headHtml() {
    const heads = [];
    if (showRank) {
      heads.push(
        `<th scope="col" data-col="rk" class="relative ${pad} py-2.5 text-right text-[10px] font-bold uppercase ${headTracking} text-slate-400">#</th>`,
      );
    }
    heads.push(
      `<th scope="col" data-col="nm" class="relative ${pad} py-2.5 text-left text-[10px] font-bold uppercase ${headTracking} text-slate-500">` +
        `${escapeHtml(nameHeading)}${resizeHandleHtml(layoutById.get('nm'))}</th>`,
    );
    for (const [index, column] of columns.entries()) {
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
        `<th scope="col" data-col="c${index}" aria-sort="${state === 'asc' ? 'ascending' : state === 'desc' ? 'descending' : 'none'}" ` +
          `class="relative ${pad} py-2.5 ${align} ${wrap} align-bottom">${inner}${resizeHandleHtml(layoutById.get(`c${index}`))}</th>`,
      );
    }
    return `<tr>${heads.join('')}</tr>`;
  }

  /**
   * A typed min–max range: two boxes, the unit stated between them, and an
   * en dash so the pair reads as the range it is.
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
   */
  function rangeControlHtml(filter) {
    const value = view.filters[filter.id] ?? {};
    const box = (side, placeholder) =>
      `<input data-range-${side} type="text" inputmode="decimal" autocomplete="off" spellcheck="false" ` +
      `value="${escapeHtml(value[side] ?? '')}" placeholder="${escapeHtml(placeholder)}" ` +
      `aria-label="${escapeHtml(`${filter.label} ${side === 'min' ? 'minimum' : 'maximum'}${filter.unitSuffix ? `, in ${filter.unitPrefix ?? ''}${filter.unitSuffix}` : ''}`)}" ` +
      // The min box is right-aligned and the max box left-aligned, so the two
      // figures sit against the dash and the control reads as one range rather
      // than as two unrelated boxes.
      `class="w-[4.25rem] ${side === 'min' ? 'text-right' : 'text-left'} border-0 bg-transparent p-0 text-xs ` +
      'font-semibold tabular-nums text-slate-800 placeholder:font-normal placeholder:text-slate-400 ' +
      'focus:outline-none focus:ring-0">';

    return (
      '<div class="flex items-center gap-2 text-[11px] font-semibold text-slate-500">' +
        `<span class="whitespace-nowrap">${escapeHtml(filter.label)}</span>` +
        `<span data-range="${escapeHtml(filter.id)}" ` +
        `${filter.hint ? `title="${escapeHtml(filter.hint)}" ` : ''}` +
        'class="inline-flex items-center gap-1.5 rounded-xl bg-white py-1.5 px-2.5 shadow-sm ring-1 ring-slate-200 ' +
        'focus-within:ring-2 focus-within:ring-indigo-500">' +
          (filter.unitPrefix ? `<span aria-hidden="true" class="text-slate-400">${escapeHtml(filter.unitPrefix)}</span>` : '') +
          box('min', filter.placeholders?.min ?? 'min') +
          '<span aria-hidden="true" class="text-slate-400">–</span>' +
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
        (resizable
          ? '<div class="relative" data-columns-wrap>' +
              '<button type="button" data-columns aria-haspopup="dialog" aria-expanded="false" ' +
              'class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200 transition hover:ring-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-500">' +
              `${columnsIcon}Columns<span data-columns-count class="tabular-nums font-normal text-slate-400"></span></button></div>`
          : '') +
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
      // WHAT THE READER PUT AWAY IS STATED WHERE THEY PUT IT AWAY. A screen
      // that quietly drops a column reads as the whole record; a sort running
      // on a column that is no longer on screen reads as no sort at all.
      (resizable ? '<p data-columns-note class="mt-2 text-[11px] leading-relaxed text-amber-700" hidden></p>' : '') +
      (notes.length
        ? `<p class="mt-2 text-[11px] leading-relaxed text-slate-400">${notes.map(escapeHtml).join(' ')}</p>`
        : '')
    );
  }

  currentRows = computeRows();

  const scrollStyle = stickyHead ? ` style="max-height:${stickyHead}"` : '';
  const html =
    `<section data-score-table="${tableId}" class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100">` +
    // One stylesheet per table, rewritten on every layout change. Hiding a
    // column by toggling a rule here is O(1); walking 1,265 rows to set an
    // attribute on each cell is not, and it would miss every row still
    // streaming in behind the fill.
    '<style data-col-style></style>' +
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

      for (const input of inputs) input.setAttribute('aria-invalid', failed ? 'true' : 'false');
      if (wrap) {
        wrap.classList.toggle('ring-rose-400', failed);
        wrap.classList.toggle('ring-2', failed);
        wrap.classList.toggle('ring-slate-200', !failed);
        wrap.classList.toggle('ring-1', !failed);
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
    // The sort may have landed on a column that is put away, and the note that
    // says so is only true until the next sort.
    updateColumnChrome();
  }

  /* ---- column layout: apply, measure, persist -------------------------- */

  /** The cell padding, in px — and therefore exactly how wide the fade may be
   *  without ever touching content that fits. See the section header. */
  const fadePx = dense ? 8 : 16;

  const headCell = (id) => (root ? $(`thead th[data-col="${id}"]`, root) : null);

  function persistColumns() {
    if (!resizable) return;
    setColumnPrefs(columnsKey, { widths: Object.fromEntries(widths), hidden: [...hidden] });
  }

  /**
   * Write the whole layout: the stylesheet, the header widths, the chrome.
   *
   * `widths` empty means AUTOMATIC layout — byte for byte what this table did
   * before column sizing existed. That is the default state and the one the
   * reader gets back from Reset, so the feature can always be undone rather
   * than merely adjusted.
   */
  function applyColumnLayout() {
    if (!root || !resizable) return;
    const styleEl = $('[data-col-style]', root);
    const table = $('table', root);
    if (!styleEl || !table) return;
    const sel = `[data-score-table="${tableId}"]`;
    const rules = [];

    for (const entry of layout) {
      if (hidden.has(entry.label)) rules.push(`${sel} [data-col="${entry.id}"]{display:none}`);
    }

    const fixed = widths.size > 0;
    let total = 0;
    for (const entry of layout) {
      const th = headCell(entry.id);
      if (!th) continue;
      if (!fixed || hidden.has(entry.label)) {
        th.style.width = '';
        continue;
      }
      const px = widths.get(entry.label);
      if (px === undefined) {
        th.style.width = '';
        continue;
      }
      th.style.width = `${px}px`;
      total += px;
    }

    if (fixed) {
      // WIDTH IS THE SUM, NEVER 100%. Under `table-layout: fixed` a table told
      // to be 100% wide redistributes the slack across the columns, so every
      // width the reader set comes out as something else — dragging one column
      // silently moves its neighbours. Sizing the table to the sum makes each
      // width mean what it says and lets the scroll container do its job.
      rules.push(`${sel} table{table-layout:fixed;width:${total}px}`);
      rules.push(`${sel} tbody td{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`);
      rules.push(`${sel} thead th{overflow:hidden}`);
      // The backstop for cells `text-overflow` cannot reach — see the section
      // header. The fade is exactly the cell's own padding wide, so content
      // that FITS (which stops at the padding edge) is never touched, and
      // content that is CUT (which runs to the border edge) always is.
      rules.push(
        `${sel} tbody td{-webkit-mask-image:linear-gradient(to right,#000 calc(100% - ${fadePx}px),transparent 100%);` +
          `mask-image:linear-gradient(to right,#000 calc(100% - ${fadePx}px),transparent 100%)}`,
      );
    }

    styleEl.textContent = rules.join('\n');
    root.dataset.colLayout = fixed ? 'fixed' : 'auto';
    root.dataset.colsHidden = String(hidden.size);
    updateColumnChrome();
  }

  /**
   * Natural widths — what each visible column occupies when the browser sizes
   * it to its own content. Read by dropping the table back to automatic layout
   * for one synchronous measurement, because that is the only thing that knows.
   */
  function measureNaturalWidths() {
    if (!root) return new Map();
    const styleEl = $('[data-col-style]', root);
    const table = $('table', root);
    const saved = styleEl.textContent;
    const savedWidths = layout.map((entry) => headCell(entry.id)?.style.width ?? '');
    const sel = `[data-score-table="${tableId}"]`;
    styleEl.textContent = layout
      .filter((entry) => hidden.has(entry.label))
      .map((entry) => `${sel} [data-col="${entry.id}"]{display:none}`)
      .join('\n');
    for (const entry of layout) {
      const th = headCell(entry.id);
      if (th) th.style.width = '';
    }
    table.style.tableLayout = '';
    const measured = new Map();
    for (const entry of visibleColumns()) {
      const th = headCell(entry.id);
      if (th) measured.set(entry.label, clamp(th.getBoundingClientRect().width));
    }
    // Put everything back before returning, so a caller that changes nothing
    // leaves no trace.
    styleEl.textContent = saved;
    layout.forEach((entry, index) => {
      const th = headCell(entry.id);
      if (th) th.style.width = savedWidths[index];
    });
    naturalWidths.clear();
    for (const [label, px] of measured) naturalWidths.set(label, px);
    return measured;
  }

  /**
   * Switch from automatic to explicit widths, keeping the layout on screen
   * exactly as it is. Every visible column gets a width in the same pass: under
   * fixed layout a column without one is sized by the browser out of whatever
   * is left, so half a width map is a layout nobody chose.
   */
  function ensureExplicitWidths() {
    if (widths.size > 0) return;
    // Measure against ALL the rows, not the screenful painted so far, or the
    // widths adopt whatever the first 80 companies happened to need.
    flushRemaining();
    for (const [label, px] of measureNaturalWidths()) widths.set(label, px);
  }

  function setColumnWidth(label, px) {
    ensureExplicitWidths();
    widths.set(label, clamp(px));
    applyColumnLayout();
  }

  /** Double-click on a handle: give this column exactly the width its content
   *  needs, which is the one width a reader cannot find by dragging. */
  function autoFitColumn(label) {
    ensureExplicitWidths();
    const measured = measureNaturalWidths();
    if (measured.has(label)) widths.set(label, measured.get(label));
    applyColumnLayout();
    persistColumns();
  }

  function setColumnHidden(label, isHidden) {
    const entry = colFor(label);
    if (!entry?.hideable) return;
    if (isHidden) hidden.add(label);
    else hidden.delete(label);
    // A column coming back needs a width or fixed layout has nothing to size it
    // with; it gets the one its content asks for rather than a guess. The
    // fallback is only reachable before the table is wired, where there is no
    // DOM to measure and nothing on screen to be wrong about.
    if (!isHidden && widths.size > 0 && !widths.has(label)) {
      applyColumnLayout();
      const measured = measureNaturalWidths();
      widths.set(label, measured.get(label) ?? MIN_COL_PX * 3);
    }
    applyColumnLayout();
    persistColumns();
  }

  /** Back to the layout the table ships with — every column shown, every width
   *  automatic. The feature has to be undoable, not merely adjustable. */
  function resetColumns() {
    widths.clear();
    hidden.clear();
    naturalWidths.clear();
    for (const entry of layout) {
      const th = headCell(entry.id);
      if (th) th.style.width = '';
    }
    const table = $('table', root);
    if (table) table.style.tableLayout = '';
    applyColumnLayout();
    persistColumns();
  }

  /**
   * Everything the reader has to be told about the layout they built.
   *
   * Two things a column control can hide, and both of them change what the
   * screen means rather than only how it looks:
   *
   *   - A PUT-AWAY COLUMN. A table showing nine of eleven columns looks exactly
   *     like a table that has nine. The count says which it is, and names them.
   *   - A SORT ON A COLUMN THAT IS NOT THERE. The rows are in an order whose
   *     basis is off-screen, which reads as no order at all — so the sort says
   *     itself in words while its column is away.
   */
  function updateColumnChrome() {
    if (!root || !resizable) return;
    const shown = visibleColumns().length;
    const count = $('[data-columns-count]', root);
    if (count) count.textContent = ` ${shown} of ${layout.length}`;
    const button = $('[data-columns]', root);
    if (button) {
      button.setAttribute(
        'title',
        hidden.size
          ? `${shown} of ${layout.length} columns shown. Hidden: ${[...hidden].join(', ')}. Every field is still in the CSV export.`
          : `All ${layout.length} columns shown. Drag a column's right edge to resize it.`,
      );
    }

    const sortedHidden = view.sort && hidden.has(view.sort.key) ? view.sort : null;
    const lines = [];
    if (hidden.size) {
      lines.push(
        `${hidden.size} column${hidden.size === 1 ? '' : 's'} hidden on this screen — ${[...hidden].join(', ')}. ` +
          'Hiding changes this screen only: the CSV export still carries every field.',
      );
    }
    if (sortedHidden) {
      lines.push(
        `These rows are sorted by “${sortedHidden.key}”, ${sortedHidden.dir === 'asc' ? 'smallest first' : 'largest first'} — ` +
          'and that column is hidden, so the order has no visible basis.',
      );
    }
    const note = $('[data-columns-note]', root);
    if (note) {
      note.textContent = lines.join(' ');
      note.hidden = lines.length === 0;
    }

    for (const handle of $$('[data-resize]', root)) {
      const entry = layoutById.get(handle.dataset.resize);
      const px = entry ? widths.get(entry.label) : undefined;
      handle.setAttribute('aria-valuemin', String(MIN_COL_PX));
      handle.setAttribute('aria-valuemax', String(MAX_COL_PX));
      if (px === undefined) handle.removeAttribute('aria-valuenow');
      else handle.setAttribute('aria-valuenow', String(px));
    }
  }

  /* ---- the drag itself -------------------------------------------------- */

  function beginResize(handle, event) {
    const entry = layoutById.get(handle.dataset.resize);
    if (!entry) return;
    ensureExplicitWidths();
    const startX = event.clientX;
    const startWidth = widths.get(entry.label) ?? headCell(entry.id)?.getBoundingClientRect().width ?? MIN_COL_PX;
    // Capture, so a drag that leaves the 10px handle keeps arriving. It can
    // throw on a pointer the browser has already released; the drag then works
    // only while the pointer stays over the handle, which is a degradation
    // rather than a broken control.
    try { handle.setPointerCapture(event.pointerId); } catch { /* no capture */ }
    document.body.style.cursor = 'col-resize';
    // While dragging, suppress text selection across the whole document —
    // otherwise a drag that leaves the header selects half the table.
    document.body.style.userSelect = 'none';

    const move = (moveEvent) => {
      widths.set(entry.label, clamp(startWidth + (moveEvent.clientX - startX)));
      applyColumnLayout();
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      persistColumns();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    event.preventDefault();
  }

  /* ---- the columns menu -------------------------------------------------- */

  let closeColumnsMenu = null;

  function openColumnsMenu(button) {
    const wrap = button.closest('[data-columns-wrap]');
    if (!wrap) return;
    // ⚠ THE GEOMETRY IS INLINE, NOT TAILWIND, AND THAT IS THE POINT.
    //
    // Tailwind arrives from a CDN and its play build generates classes
    // ASYNCHRONOUSLY, so a `w-72` panel measured in the same tick it was
    // appended is still `width: auto`. The nudge below read that phantom box,
    // decided the panel was on screen, and did nothing — and at 390px the real
    // panel then landed 37px off the left edge, where `overflow-x: hidden` on
    // <body> makes it unreachable rather than merely ugly. Measured.
    //
    // Anything this code has to MEASURE is therefore set inline, where it
    // applies synchronously; only the paint is left to Tailwind.
    const panel = el('div', {
      class: 'z-40 rounded-xl bg-white p-3 text-left shadow-xl ring-1 ring-slate-200',
      style: 'position:absolute;top:100%;right:0;margin-top:8px;width:288px;max-width:calc(100vw - 1rem)',
      role: 'dialog',
      'aria-label': 'Choose columns',
      'data-columns-menu': '',
    });

    const boxes = layout
      .filter((entry) => entry.hideable)
      .map((entry) => {
        const input = el('input', {
          type: 'checkbox',
          class: 'h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500',
          checked: !hidden.has(entry.label),
        });
        input.checked = !hidden.has(entry.label);
        input.addEventListener('change', () => setColumnHidden(entry.label, !input.checked));
        return el(
          'label',
          { class: 'flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-slate-700 hover:bg-slate-50' },
          [input, el('span', { class: 'truncate' }, entry.label)],
        );
      });

    const reset = el(
      'button',
      {
        type: 'button',
        class:
          'w-full rounded-lg px-2 py-1.5 text-left text-xs font-semibold text-indigo-700 hover:bg-indigo-50 focus:outline-none focus:ring-2 focus:ring-indigo-500',
      },
      'Show every column, at its automatic width',
    );
    reset.addEventListener('click', () => {
      resetColumns();
      for (const box of $$('input[type="checkbox"]', panel)) box.checked = true;
    });

    panel.append(
      el('p', { class: 'px-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400' }, 'Columns on this screen'),
      el('div', { class: 'max-h-72 overflow-y-auto' }, boxes),
      el('div', { class: 'mt-2 border-t border-slate-100 pt-2' }, [reset]),
      el(
        'p',
        { class: 'px-2 pt-2 text-[10px] leading-relaxed text-slate-400' },
        'Hiding a column changes this screen only — the CSV export always carries every field. ' +
          'Drag a column’s right edge to resize it, or double-click that edge to fit its content.',
      ),
    );

    wrap.append(panel);
    button.setAttribute('aria-expanded', 'true');

    // The panel hangs off the button's right edge, and on a phone the button
    // does not sit far enough right for it to fit. Nudged only when it actually
    // lands outside — a measurement, not a breakpoint guess about where the
    // toolbar puts the button.
    const box = panel.getBoundingClientRect();
    if (box.left < 8) panel.style.right = `${Math.round(box.left - 8)}px`;

    const onDocPointer = (event) => {
      if (!panel.contains(event.target) && !button.contains(event.target)) closeColumnsMenu?.();
    };
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      closeColumnsMenu?.();
      button.focus();
    };
    // A pointer dismisses it; so must a keyboard. Tabbing past the last
    // checkbox leaves the panel open and unreachable otherwise — a menu a
    // screen-reader user can open and not close.
    const onFocusOut = (event) => {
      const next = event.relatedTarget;
      if (next && (panel.contains(next) || button.contains(next))) return;
      // relatedTarget is null when focus leaves the window entirely; that is
      // not a dismissal.
      if (next) closeColumnsMenu?.();
    };
    // Deferred, or the very click that opened the menu closes it again.
    setTimeout(() => document.addEventListener('pointerdown', onDocPointer), 0);
    document.addEventListener('keydown', onKey);
    panel.addEventListener('focusout', onFocusOut);

    closeColumnsMenu = () => {
      document.removeEventListener('pointerdown', onDocPointer);
      document.removeEventListener('keydown', onKey);
      panel.removeEventListener('focusout', onFocusOut);
      panel.remove();
      button.setAttribute('aria-expanded', 'false');
      closeColumnsMenu = null;
    };
    ($('input', panel) ?? panel).focus?.();
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
    const thead = $('thead', root);

    if (resizable) {
      thead.addEventListener('pointerdown', (event) => {
        const handle = event.target.closest('[data-resize]');
        if (!handle || event.button !== 0) return;
        // The handle sits inside the same <th> as the sort button. Stopping
        // propagation here keeps a drag that ends on the header from also
        // re-sorting the table under the reader's hands.
        event.stopPropagation();
        beginResize(handle, event);
      });

      thead.addEventListener('dblclick', (event) => {
        const handle = event.target.closest('[data-resize]');
        if (!handle) return;
        event.stopPropagation();
        const entry = layoutById.get(handle.dataset.resize);
        if (entry) autoFitColumn(entry.label);
      });

      thead.addEventListener('keydown', (event) => {
        const handle = event.target.closest('[data-resize]');
        if (!handle) return;
        const entry = layoutById.get(handle.dataset.resize);
        if (!entry) return;
        const step = event.shiftKey ? NUDGE_FAST_PX : NUDGE_PX;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          ensureExplicitWidths();
          setColumnWidth(entry.label, (widths.get(entry.label) ?? MIN_COL_PX) + (event.key === 'ArrowRight' ? step : -step));
          persistColumns();
          return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          autoFitColumn(entry.label);
        }
      });

      // A click ON the handle must never reach the sort button behind it.
      thead.addEventListener('click', (event) => {
        if (event.target.closest('[data-resize]')) event.stopPropagation();
      }, true);

      const columnsButton = $('[data-columns]', root);
      columnsButton?.addEventListener('click', () => {
        if (closeColumnsMenu) closeColumnsMenu();
        else openColumnsMenu(columnsButton);
      });
    }

    thead.addEventListener('click', (event) => {
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
    // Stored widths are applied straight away, before the fill: the reader's
    // layout should be the one they see arrive, not one that snaps into place
    // a second later. A width for a column that no longer exists was already
    // dropped on read.
    if (resizable) applyColumnLayout();
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
    /**
     * The column layout, for the verification suite and for any caller that
     * needs to drive it without a pointer. Read-only views of the state plus
     * the same three actions the controls call — never a second implementation
     * that could agree with itself while the screen does something else.
     */
    columns: {
      layout: () => layout.map((c) => ({ id: c.id, label: c.label, hideable: c.hideable, resizable: c.resizable })),
      widths: () => Object.fromEntries(widths),
      hidden: () => [...hidden],
      naturalWidths: () => Object.fromEntries(naturalWidths),
      setWidth: (label, px) => {
        setColumnWidth(label, px);
        persistColumns();
      },
      setHidden: setColumnHidden,
      autoFit: autoFitColumn,
      reset: resetColumns,
    },
  };

  return api;
}
