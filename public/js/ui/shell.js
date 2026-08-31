/** Header + content host. */

import { $, el } from '../core/dom.js';
import { statusControl } from './components.js';
import { headerStatus, openSourcesModal } from './sources.js';

const LOGO =
  '<span class="brand-gradient flex h-9 w-9 items-center justify-center rounded-xl text-sm font-extrabold text-white shadow-sm" aria-hidden="true">SI</span>';

/**
 * Mount the shell and return its slots.
 *
 * The header carries exactly one control: the status pill. The methodology
 * toggle that sat beside it went on 31 Aug 2026 — one model renders, so there
 * is nothing to switch. There is no global search box either: search belongs to
 * the table it filters, where the reader can see what it does to the row count.
 */
export function mountShell(container) {
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

  const statusSlot = el('div', { 'data-status-slot': '' }, [
    statusControl({ ...status, onClick: () => openSourcesModal() }),
  ]);

  const header = el(
    'header',
    { class: 'sticky top-0 z-40 border-b border-slate-200/70 bg-white/85 backdrop-blur-md' },
    [
      el('div', { class: 'mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3' }, [
        brand,
        el('div', { class: 'ml-auto flex flex-wrap items-center gap-3' }, [statusSlot]),
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
  };
}
