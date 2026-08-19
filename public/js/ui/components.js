/** Reusable controls: segmented toggle, search input, pill, badge, status control. */

import { el, escapeHtml } from '../core/dom.js';

/**
 * A segmented toggle. Radio semantics, arrow-key navigable.
 * @param {{options: Array<{value,label,hint?}>, value, onChange, ariaLabel}} config
 */
export function segmentedToggle({ options, value, onChange, ariaLabel = 'View' }) {
  const root = el('div', {
    class: 'inline-flex items-center rounded-xl bg-slate-100 p-1 ring-1 ring-slate-200/70',
    role: 'radiogroup',
    'aria-label': ariaLabel,
  });

  const buttons = options.map((option) => {
    const active = option.value === value;
    const button = el(
      'button',
      {
        type: 'button',
        role: 'radio',
        'aria-checked': String(active),
        tabindex: active ? '0' : '-1',
        'data-value': option.value,
        title: option.hint ?? '',
        class: `rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
          active ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:text-slate-800'
        }`,
      },
      option.label,
    );
    button.addEventListener('click', () => onChange(option.value));
    return button;
  });

  root.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const index = options.findIndex((o) => o.value === value);
    const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length;
    onChange(options[next].value);
  });

  root.append(...buttons);
  return root;
}

/** Debounced search box with a clear button. */
export function searchInput({ value = '', placeholder = 'Search', onInput, ariaLabel, delay = 120 }) {
  const input = el('input', {
    type: 'search',
    value,
    placeholder,
    'aria-label': ariaLabel ?? placeholder,
    class:
      'w-full rounded-xl border-0 bg-white py-2 pl-9 pr-8 text-sm text-slate-900 shadow-sm ring-1 ring-slate-200 ' +
      'placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500',
  });

  const icon = el('span', {
    class: 'pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400',
    'aria-hidden': 'true',
    html:
      '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2">' +
      '<circle cx="9" cy="9" r="6"/><path d="m14 14 4 4" stroke-linecap="round"/></svg>',
  });

  const clear = el('button', {
    type: 'button',
    'aria-label': 'Clear search',
    class: 'absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-700',
    html: '<svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 5l10 10M15 5 5 15" stroke-linecap="round"/></svg>',
    hidden: value === '',
  });

  let timer = null;
  const fire = () => {
    clear.hidden = input.value === '';
    clearTimeout(timer);
    timer = setTimeout(() => onInput(input.value), delay);
  };
  input.addEventListener('input', fire);
  clear.addEventListener('click', () => {
    input.value = '';
    clear.hidden = true;
    onInput('');
    input.focus();
  });

  return el('div', { class: 'relative' }, [icon, input, clear]);
}

const PILL_TONES = {
  brand: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  neutral: 'bg-slate-100 text-slate-600 ring-slate-200',
  positive: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  caution: 'bg-amber-50 text-amber-800 ring-amber-200',
  negative: 'bg-rose-50 text-rose-700 ring-rose-200',
};

/** A small labelled pill. Returns an element. */
export function pill(text, { tone = 'neutral', title = '' } = {}) {
  return el(
    'span',
    {
      class: `inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${
        PILL_TONES[tone] ?? PILL_TONES.neutral
      }`,
      title,
    },
    text,
  );
}

/** Pill as a markup string, for use inside cached row HTML. */
export function badge(text, { tone = 'neutral', title = '' } = {}) {
  return (
    `<span class="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${
      PILL_TONES[tone] ?? PILL_TONES.neutral
    }"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(text)}</span>`
  );
}

/**
 * The header status control: one pill reading the OLDEST of the as-of dates.
 *
 * There is exactly one of these and no separate "Sources" button, because
 * provenance has to be reachable from every screen by the same gesture. It
 * reads the oldest date because that is what actually governs how current the
 * page is — showing the newest would flatter the data.
 */
export function statusControl({ label, detail, tone = 'positive', onClick }) {
  const dotTone = { positive: 'bg-emerald-500', caution: 'bg-amber-500', negative: 'bg-rose-500', neutral: 'bg-slate-400' };
  const button = el(
    'button',
    {
      type: 'button',
      class:
        'group inline-flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-left shadow-sm ring-1 ring-slate-200 ' +
        'transition hover:ring-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-500',
      title: detail,
      'aria-label': `${label}. ${detail} Open data sources.`,
    },
    [
      el('span', { class: `h-2 w-2 shrink-0 rounded-full ${dotTone[tone] ?? dotTone.neutral}`, 'aria-hidden': 'true' }),
      el('span', { class: 'flex flex-col leading-tight' }, [
        el('span', { class: 'text-[11px] font-semibold text-slate-900' }, label),
        el('span', { class: 'text-[10px] text-slate-500' }, detail),
      ]),
    ],
  );
  button.addEventListener('click', onClick);
  return button;
}
