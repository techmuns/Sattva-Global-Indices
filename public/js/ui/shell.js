/** Header + content host. */

import { $, el } from '../core/dom.js';
import { statusControl } from './components.js';
import { headerStatus, openSourcesModal } from './sources.js';

const LOGO =
  '<span class="brand-gradient flex h-9 w-9 items-center justify-center rounded-xl text-sm font-extrabold text-white shadow-sm" aria-hidden="true">SI</span>';

/**
 * The two views. This is NAVIGATION, not a control.
 *
 * Two toggles have been removed from this header — Held/All on 26 Aug and the
 * model switch on 31 Aug — both because a screen that asks a reader to choose
 * before it will answer has made its own subject optional. This one is a
 * different animal and the distinction is worth stating so it is not removed by
 * analogy: it changes WHICH PAGE you are on, not what a number on a page means.
 * Neither view is a filtered version of the other, and no figure changes when
 * you switch.
 */
const VIEWS = [
  { route: 'companies', label: 'Screener', hint: 'Every company in the record, and what the next review may force' },
  { route: 'rebalance', label: 'Latest Rebalance', hint: 'What the last review actually did, and how the forecast fared' },
];

function viewNav(active, onNavigate) {
  const nav = el('nav', {
    class: 'inline-flex items-center rounded-xl bg-slate-100 p-1 ring-1 ring-slate-200/70',
    'aria-label': 'Views',
    'data-view-nav': '',
  });
  for (const view of VIEWS) {
    const current = view.route === active;
    const link = el('a', {
      href: `#/${view.route}`,
      'data-view-link': view.route,
      'aria-current': current ? 'page' : null,
      title: view.hint,
      class: `rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
        current ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:text-slate-800'
      }`,
    }, view.label);
    link.addEventListener('click', (event) => {
      // Let a modified click open a new tab — the hash is the shareable
      // surface and both views are addressable.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      onNavigate?.(view.route);
    });
    nav.append(link);
  }
  return nav;
}

/**
 * Mount the shell and return its slots.
 *
 * The header carries the view nav and the status pill. The methodology toggle
 * that sat beside them went on 31 Aug 2026 — one model renders, so there is
 * nothing to switch. There is no global search box either: search belongs to
 * the table it filters, where the reader can see what it does to the row count.
 */
export function mountShell(container, { route = 'companies', onNavigate } = {}) {
  const status = headerStatus();

  const brand = el('div', { class: 'flex items-center gap-3' }, [
    el('div', { html: LOGO }),
    el('div', { class: 'leading-tight' }, [
      el('div', { class: 'font-display text-[15px] font-extrabold tracking-tight text-slate-900' }, 'Sattva Index Flows'),
      el(
        'div',
        { class: 'text-[11px] text-slate-500' },
        'What index funds must buy and sell in Indian equities',
      ),
    ]),
  ]);

  const navSlot = el('div', { 'data-view-nav-slot': '' }, [viewNav(route, onNavigate)]);

  const statusSlot = el('div', { 'data-status-slot': '' }, [
    statusControl({ ...status, onClick: () => openSourcesModal() }),
  ]);

  const header = el(
    'header',
    { class: 'sticky top-0 z-40 border-b border-slate-200/70 bg-white/85 backdrop-blur-md' },
    [
      el('div', { class: 'mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3' }, [
        brand,
        el('div', { class: 'ml-auto flex flex-wrap items-center gap-3' }, [navSlot, statusSlot]),
      ]),
    ],
  );

  const main = el('main', { id: 'main', class: 'mx-auto max-w-[1400px] px-6 py-8' }, [
    el('div', { 'data-view-host': '' }),
  ]);

  // THE BLANKET FOOTER DISCLOSURE IS GONE (28 Aug 2026), and deliberately not
  // replaced. It said "nothing here is a forecast yet", which stopped being true
  // the moment the screener started printing verdicts, and it restated in
  // general terms what every figure already carries specifically: a source chip
  // on the row, the deriving formula beside the number, the rule table and
  // provenance section in the drill, the oldest input on the header pill, and
  // every feed with its as-of in the sources modal. A standing paragraph that
  // duplicates per-number provenance teaches readers to skip the paragraph, not
  // to trust the numbers.
  container.append(header, main);
  return {
    header,
    host: $('[data-view-host]', main),
    /** Re-render the pill in place. Called on every tick, because the claim it
     *  makes — live or last close — depends on whether a byte arrived. */
    setStatus(next) {
      statusSlot.replaceChildren(statusControl({ ...next, onClick: () => openSourcesModal() }));
    },
    /** Repaint the nav so the active view follows the route, whether the change
     *  came from the nav, the address bar or the back button. */
    setRoute(next) {
      navSlot.replaceChildren(viewNav(next, onNavigate));
    },
  };
}
