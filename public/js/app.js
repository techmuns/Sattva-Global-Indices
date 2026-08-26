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
import { METHODOLOGIES, METHODOLOGY_IDS } from './model/gimi.js';
import { mountShell } from './ui/shell.js';
import { renderCompanies } from './tabs/companies.js';
import * as quotes from './data/quotes.js';
import { headerStatus } from './ui/sources.js';

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
  // methodology it was shared in.
  const urlMethodology = getParam('model');
  if (urlMethodology && state.METHODOLOGIES.includes(urlMethodology)) state.setMethodology(urlMethodology);

  /**
   * The methodology toggle — the one control in the header.
   *
   * It replaced the Held/All scope toggle on 26 Aug 2026. The screener now
   * always shows the whole universe, and the choice worth putting in front of
   * a reader is WHICH MODEL produced the verdicts, not which subset of rows.
   *
   * Labels are the short forms the desk uses out loud, so the toggle reads the
   * way the request was phrased; the full names and their attributions live on
   * the hint and in the model banner.
   */
  const buildMethodologyControl = () =>
    segmentedToggle({
      ariaLabel: 'Model',
      value: state.getMethodology(),
      onChange: (value) => state.setMethodology(value),
      options: METHODOLOGY_IDS.map((id) => ({
        value: id,
        label: METHODOLOGIES[id].short,
        hint: `${METHODOLOGIES[id].label} — ${METHODOLOGIES[id].what}`,
      })),
    });

  app.replaceChildren();
  const shell = mountShell(app, { modelControl: buildMethodologyControl() });

  // Repaint the toggle itself so the active segment follows the state, whether
  // the change came from the toggle, the URL or another tab.
  state.on('methodology', () => {
    shell.modelSlot.replaceChildren(buildMethodologyControl());
    setParams({ model: state.getMethodology() });
  });

  // The header pill re-renders on every tick, because what it claims — live or
  // last close — is derived from whether a byte actually arrived.
  const refreshStatus = () => shell.setStatus(headerStatus());

  const view = renderCompanies(shell.host, { onStatusChange: refreshStatus });

  // The live overlay is entirely optional. With no Worker (a plain static
  // server) the fetch 404s, the poller records `no-worker`, and every row stays
  // on its committed EOD price — which is the designed floor, not a failure.
  quotes.startLive({ intervalMs: 30000 });
  quotes.onQuotes(refreshStatus);
  refreshStatus();

  startRouter();
  setParams({ model: state.getMethodology() });

  // Expose a small surface for the verification harness. Read-only; it drives
  // nothing the interface does not already do for a human.
  window.__sattva = {
    data,
    state,
    view,
    quotes,
    rows: () => view.table()?.rows() ?? [],
    /**
     * The verdict histogram under the model currently in force.
     *
     * Exposed for the verification suite, which has to be able to prove the
     * model toggle changes something. Read-only and derived from the same
     * assessments the table renders — not a second calculation that could agree
     * with the screen while the screen is wrong.
     */
    verdictTally: () => {
      const tally = {};
      for (const company of data.all()) {
        const verdict = view.assessmentFor(company)?.verdict ?? 'unknown';
        tally[verdict] = (tally[verdict] ?? 0) + 1;
      }
      return tally;
    },
    flush: () => view.table()?.flush(),
    refreshStatus,
  };
}

main();
