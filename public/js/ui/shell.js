/** Header + content host. */

import { $, el } from '../core/dom.js';
import { statusControl } from './components.js';
import { headerStatus, openSourcesModal } from './sources.js';

const LOGO =
  '<span class="brand-gradient flex h-9 w-9 items-center justify-center rounded-xl text-sm font-extrabold text-white shadow-sm" aria-hidden="true">SI</span>';

/**
 * Mount the shell and return its slots.
 *
 * The header carries the scope toggle and exactly one status pill. There is no
 * global search box: search belongs to the table it filters, where the reader
 * can see what it is doing to the row count.
 */
export function mountShell(container, { scopeControl }) {
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

  const scopeSlot = el('div', { 'data-scope-slot': '', class: 'flex items-center gap-3' }, [scopeControl]);

  const header = el(
    'header',
    { class: 'sticky top-0 z-40 border-b border-slate-200/70 bg-white/85 backdrop-blur-md' },
    [
      el('div', { class: 'mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3' }, [
        brand,
        el('div', { class: 'ml-auto flex flex-wrap items-center gap-3' }, [
          scopeSlot,
          statusControl({ ...status, onClick: () => openSourcesModal() }),
        ]),
      ]),
    ],
  );

  const main = el('main', { id: 'main', class: 'mx-auto max-w-[1400px] px-6 py-8' }, [
    el('div', { 'data-view-host': '' }),
  ]);

  const footer = el('footer', { class: 'mx-auto max-w-[1400px] px-6 pb-10' }, [
    el(
      'p',
      { class: 'text-[11px] leading-relaxed text-slate-400' },
      'Figures on this screen are either published by BlackRock, NSE or BSE, or derived by us from those ' +
        'published figures with the formula stated beside the number. Nothing here is a forecast yet.',
    ),
  ]);

  container.append(header, main, footer);
  return { header, host: $('[data-view-host]', main), scopeSlot };
}
