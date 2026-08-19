/**
 * Bootstrap: load companies.json, mount the shell, render the view.
 *
 * If the data cannot be loaded the page says exactly that, in those words, and
 * renders nothing else. A feed that failed is its own named state — rendering
 * an empty table instead would report an outage as "no companies", which is a
 * different and much worse claim.
 */

import { $, el } from './core/dom.js';
import * as data from './data/companies.js';
import * as state from './core/state.js';
import { start as startRouter, getParam, setParams } from './core/router.js';
import { segmentedToggle } from './ui/components.js';
import { mountShell } from './ui/shell.js';
import { renderCompanies } from './tabs/companies.js';

function renderLoadFailure(container, error) {
  container.replaceChildren(
    el('div', { class: 'mx-auto max-w-[1400px] px-6 py-16' }, [
      el('div', { class: 'rounded-2xl bg-white p-6 shadow-sm ring-1 ring-rose-200' }, [
        el('h1', { class: 'font-display text-lg font-extrabold text-rose-700' }, 'The company data could not be loaded'),
        el(
          'p',
          { class: 'mt-2 max-w-2xl text-sm leading-relaxed text-slate-600' },
          'This is a failure to read the data, not a finding that there are no companies. ' +
            'Nothing on this page can be trusted until it is fixed.',
        ),
        el('pre', { class: 'mt-3 overflow-x-auto rounded-xl bg-slate-50 p-3 text-xs text-slate-700' }, String(error?.message ?? error)),
        el(
          'p',
          { class: 'mt-3 text-xs text-slate-500' },
          'Regenerate it with: node scripts/build-companies.mjs — then serve public/ again.',
        ),
      ]),
    ]),
  );
}

async function main() {
  const app = $('#app');
  app.replaceChildren(
    el('div', { class: 'mx-auto max-w-[1400px] px-6 py-16 text-sm text-slate-400' }, 'Loading company data…'),
  );

  try {
    await data.load();
  } catch (error) {
    console.error('[app] could not load companies.json', error);
    renderLoadFailure(app, error);
    return;
  }

  // The URL wins over stored state on first load, so a shared link opens the
  // scope it was shared in.
  const urlScope = getParam('scope');
  if (urlScope && state.SCOPES.includes(urlScope)) state.setScope(urlScope);

  const cov = data.coverage();
  const buildScopeControl = () =>
    segmentedToggle({
      ariaLabel: 'Company scope',
      value: state.getScope(),
      onChange: (value) => state.setScope(value),
      options: [
        {
          value: 'held',
          label: 'Held',
          hint: `The ${cov.held} companies at least one fund owns — what must be traded if weights move`,
        },
        {
          value: 'all',
          label: 'All',
          hint: `All ${cov.companies} companies, including the ${cov.notHeld} candidates no fund owns yet`,
        },
      ],
    });

  app.replaceChildren();
  const shell = mountShell(app, { scopeControl: buildScopeControl() });

  // Repaint the toggle itself so the active segment follows the state, whether
  // the change came from the toggle, the URL or another tab.
  state.on('scope', () => {
    shell.scopeSlot.replaceChildren(buildScopeControl());
    setParams({ scope: state.getScope() });
  });

  const view = renderCompanies(shell.host, {});

  startRouter();
  setParams({ scope: state.getScope() });

  // Expose a small surface for the verification harness. Read-only; it drives
  // nothing the interface does not already do for a human.
  window.__sattva = {
    data,
    state,
    view,
    rows: () => view.table()?.rows() ?? [],
    flush: () => view.table()?.flush(),
  };
}

main();
