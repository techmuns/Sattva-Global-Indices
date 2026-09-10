/**
 * ftse-upload.js — the desk drops in Vanguard's quarterly workbook itself.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 * The FTSE book is published quarterly and arrives as a file somebody
 * downloads. Until now the only way in was `node scripts/import-ftse.mjs`
 * against a fixture committed to the repo, which means the desk waited on
 * whoever holds the repo. They asked to be able to do it themselves.
 *
 * ---------------------------------------------------------------------------
 * ⚠ AN UPLOAD IS NOT A SHORTCUT PAST THE CHECKS. IT IS THE SAME CHECKS.
 * ---------------------------------------------------------------------------
 * The parse, the currency assertion, the price-arbitrated join and the
 * unresolved-with-a-reason rule are the SAME functions the importer runs — see
 * the header of model/ftse-book.js on why a second implementation would be
 * invisible rather than obvious. What the panel adds is that a human is standing
 * there, so every check reports in words before anything is applied:
 *
 *   - the currency test, with its median ratio and its denominator. This is the
 *     one that matters: read as USD every rupee figure from this book would be
 *     40.65% too large, and the workbook prints a bare "$" (§2.35).
 *   - how many rows resolved, of how many, with the method histogram.
 *   - every row that did NOT resolve, with its own reason. Never dropped.
 *   - which close the join was arbitrated against, and whether that is the
 *     workbook's own date or a weaker basis some sessions away.
 *
 * ⚠ AND NOTHING IS APPLIED UNTIL A PERSON SAYS SO. A book that fails the
 * currency test or the structural checks cannot be applied at all; a book that
 * passes is still shown first and applied second. The alternative — apply on
 * drop, report afterwards — puts a bad book on screen for as long as it takes
 * somebody to read.
 */

import { el, escapeHtml } from '../core/dom.js';
import { openModal, closeModal } from './screener.js';
import { num, shortDate, pct } from '../core/format.js';
import { inflateRaw, hasInflate, INFLATE_UNAVAILABLE } from '../core/inflate.js';
import { readFtseBook, assertBookShape, chooseFtseBasis, joinFtseBook } from '../model/ftse-book.js';
import { FTSE_JOIN } from '../config/thresholds.mjs';
import * as data from '../data/companies.js';
import * as store from '../data/ftse-store.js';

const okMark = '<span class="text-emerald-600">✓</span>';
const noMark = '<span class="text-rose-600">✗</span>';

const panelId = 'ftse-upload-panel';

/** The state machine, in words. Every one of these renders; none is silent. */
function statusHtml(kind, title, body) {
  const tone = kind === 'ok'
    ? 'bg-emerald-50 text-emerald-900 ring-emerald-200'
    : kind === 'bad'
      ? 'bg-rose-50 text-rose-900 ring-rose-200'
      : kind === 'warn'
        ? 'bg-amber-50 text-amber-900 ring-amber-200'
        : 'bg-slate-50 text-slate-700 ring-slate-200';
  return `<div class="rounded-xl p-3 text-xs leading-relaxed ring-1 ${tone}">`
    + `<strong>${escapeHtml(title)}</strong>${body ? ` ${body}` : ''}</div>`;
}

function checklistHtml(checks) {
  return '<ul class="space-y-1 text-[11px] leading-relaxed">'
    + checks.map((c) => `<li class="flex gap-2"><span class="shrink-0">${c.ok ? okMark : noMark}</span>`
      + `<span><span class="${c.ok ? 'text-slate-700' : 'font-semibold text-rose-800'}">${escapeHtml(c.label)}</span>`
      + `<span class="text-slate-500"> — ${escapeHtml(c.detail)}</span></span></li>`).join('')
    + '</ul>';
}

/**
 * The price basis the browser can offer.
 *
 * ⚠ THE EXACT BASIS COSTS 1.5 MB AND IS WORTH IT. The join is arbitrated by
 * comparing the workbook's implied share price against OUR close for the same
 * company ON THE SAME DAY, and only price-history.json holds a close for a date
 * that is not today. It is fetched on demand — the same pattern the alternate
 * rebalance baselines already use — and only when somebody actually uploads.
 *
 * ⚠ AND THE FALLBACK IS A WEAKER TEST THAT SAYS SO, never a skipped one. A
 * wrong company is out by multiples; a month of real price movement is out by
 * percent, so the latest committed close still separates the two populations at
 * the median even when it cannot arbitrate a single borderline row. What it must
 * not do is pretend to be the exact basis (§2.4).
 */
async function priceSources() {
  const fetchJson = async (path) => {
    try {
      const response = await fetch(path, { headers: { accept: 'application/json' } });
      if (!response.ok) return null;
      if (!(response.headers.get('content-type') ?? '').includes('application/json')) return null;
      return await response.json();
    } catch {
      return null;
    }
  };
  const [history, fx] = await Promise.all([
    fetchJson('data/price-history.json'),
    fetchJson('data/ftse-fx.json'),
  ]);

  const latestByIsin = new Map();
  for (const company of data.all()) {
    if (company.isin && Number.isFinite(company.priceInr)) latestByIsin.set(company.isin, company.priceInr);
  }

  return {
    dates: history?.dates ?? [],
    cadSeries: fx?.series ?? [],
    // Where the FX file could not be fetched we still hold the rate the record
    // was built with — one date, and it is named. Better than no conversion,
    // which would make the currency test unrunnable.
    fallbackCadInr: data.ftse()?.priceBasis?.cadInr ?? null,
    fallbackCadDate: data.ftse()?.priceBasis?.fxDate ?? null,
    closeByIsinOn: (date) => {
      const at = history?.dates?.indexOf(date) ?? -1;
      const map = new Map();
      if (at < 0 || !history) return map;
      for (const scrip of Object.values(history.scrips ?? {})) {
        if (scrip.isin && scrip.closes?.[at] != null) map.set(scrip.isin, scrip.closes[at]);
      }
      return map;
    },
    fallback: latestByIsin.size
      ? { date: data.priceMeta()?.tradeDate ?? null, closeByIsin: latestByIsin }
      : null,
    historyAvailable: Boolean(history),
    fxAvailable: Boolean(fx),
  };
}

/** Read one file and report everything about it, applying nothing. */
async function inspect(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { payload, measured } = await readFtseBook(bytes, inflateRaw, {
    receivedAs: 'uploaded through the dashboard',
    fixtures: [],
  });

  const previous = data.ftse()?.available
    ? { indiaRows: data.ftse().indiaRows, asOf: data.ftse().asOf }
    : null;
  const shape = assertBookShape(measured, { previous });

  const sources = await priceSources();
  const basis = chooseFtseBasis(payload.funds[0], {
    dates: sources.dates,
    cadSeries: sources.cadSeries.length
      ? sources.cadSeries
      // One dated point rather than none. `chooseFtseBasis` walks back to the
      // newest rate on or before the holdings date, so a single older point is
      // used correctly and `fxWalkedBack` records that it was.
      : (sources.fallbackCadInr ? [{ date: sources.fallbackCadDate, close: sources.fallbackCadInr }] : []),
    config: FTSE_JOIN,
    closeByIsinOn: sources.closeByIsinOn,
    fallback: sources.fallback,
  });
  const joined = joinFtseBook(payload, data.all(), basis, FTSE_JOIN);

  return {
    file, payload, measured, shape, basis, joined, sources,
  };
}

function reportHtml(result) {
  const { payload, measured, shape, joined } = result;
  const fund = payload.funds[0];
  const currency = joined.currency;
  const meta = joined.meta;
  const basis = result.basis;

  let html = '';

  // ---- the currency test, first, because it is the load-bearing one -------
  html += currency.ok
    ? statusHtml('ok', 'The book is struck in Canadian dollars, and that was measured rather than assumed.',
      `Implied share price (market value ÷ shares), converted at the ${escapeHtml(basis.fxDate ?? 'holdings-date')} rate, `
      + `sits at a median <strong>${escapeHtml(currency.median.toFixed(4))}</strong> of our own close across `
      + `<strong>${escapeHtml(num(currency.compared))}</strong> companies. Read as US dollars every rupee figure `
      + 'from this book would be 40.65% too large, and the workbook prints a bare "$".')
    : statusHtml('bad', 'The currency check failed, and nothing will be applied.', escapeHtml(currency.reason ?? ''));

  // ---- structure ----
  html += `<div class="mt-3"><div class="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">Does this look like a Vanguard holdings book?</div>${checklistHtml(shape.checks)}</div>`;

  // ---- what is in it, every count with its denominator (§2.5) ----
  html +=
    '<div class="mt-3 overflow-hidden rounded-xl ring-1 ring-slate-100">'
    + '<table class="w-full text-left text-[11px]"><tbody>'
    + [
      ['Fund', escapeHtml(fund.name ?? '—')],
      ['Holdings as at', escapeHtml(shortDate(fund.asOf))],
      ['Downloaded on', escapeHtml(shortDate(fund.downloadedOn))],
      ['Rows in the whole book', escapeHtml(num(fund.dataRows))],
      ['India rows', `${escapeHtml(num(fund.indiaRows))} of ${escapeHtml(num(fund.dataRows))}`],
      ['India weight of the whole fund', escapeHtml(pct(fund.indiaWeightPct, 3))],
      ['All published weights sum to', `${escapeHtml(measured.totalWeightPct3dp)}% <span class="text-slate-400">— Vanguard excludes cash and futures, so this is below 100 by design</span>`],
      ['Resolved to a company on this record', `${escapeHtml(num(meta.resolved))} of ${escapeHtml(num(meta.indiaRows))} <span class="text-slate-400">(${escapeHtml(pct(meta.resolvedWeightPct, 3))} of ${escapeHtml(pct(meta.indiaWeightPct, 3))} India weight)</span>`],
      ['Join arbitrated against', basis.date
        ? `${escapeHtml(shortDate(basis.date))}${basis.exact
          ? ' <span class="text-emerald-700">— the workbook\'s own date</span>'
          : `<span class="text-amber-800"> — ${basis.gapSessions === null
            ? "not the workbook's own date"
            : `${escapeHtml(num(basis.gapSessions))} session(s) from the workbook's date`
          }, so the per-row test runs at the wider ${escapeHtml(num(basis.tolerancePct))}% tolerance${basis.fellBackToLatest ? '. It is the latest committed close rather than a close on that day, which still separates a wrong company (out by multiples) from a real price move (out by percent)' : ''}</span>`}`
        : '<span class="text-rose-700">no close available — the join could not be arbitrated</span>'],
    ].map(([k, v]) => `<tr class="border-t border-slate-50 first:border-0"><td class="px-2 py-1.5 text-slate-500">${k}</td><td class="px-2 py-1.5 text-right text-slate-900">${v}</td></tr>`).join('')
    + '</tbody></table></div>';

  // ---- the join methods ----
  const methods = Object.entries(meta.methods ?? {});
  if (methods.length) {
    html += '<p class="mt-2 text-[11px] leading-relaxed text-slate-500">Vanguard publishes no ISIN, so each row is '
      + 'proposed from a name or a house ticker and then arbitrated by a price the workbook never states: '
      + `${methods.map(([k, v]) => `<span class="tabular-nums font-semibold text-slate-700">${escapeHtml(num(v))}</span> ${escapeHtml(k)}`).join(', ')}.</p>`;
  }

  // ---- every row that did not resolve, and why (§2.3, §2.4) ----
  if (meta.unresolved.length) {
    html +=
      '<details class="mt-2 rounded-xl bg-slate-50 p-3 text-[11px] ring-1 ring-slate-100">'
      + `<summary class="cursor-pointer font-semibold text-slate-700">${escapeHtml(num(meta.unresolved.length))} row(s) could not be placed — each keeps its weight and its reason</summary>`
      + '<ul class="mt-2 space-y-1">'
      + meta.unresolved.map((u) => `<li class="text-slate-600"><span class="font-semibold text-slate-800">${escapeHtml(u.publishedName ?? u.ticker ?? '—')}</span>`
        + `${u.weightPct != null ? ` <span class="tabular-nums text-slate-500">${escapeHtml(pct(u.weightPct, 4))}</span>` : ''}`
        + ` — ${escapeHtml(u.reason ?? 'no reason recorded')}</li>`).join('')
      + '</ul>'
      + '<p class="mt-2 text-slate-500">These are a gap in our join, not an absence from the fund. Dropping them '
      + 'would quietly redefine the book as "the rows we could match".</p>'
      + '</details>';
  }

  if (joined.collisions.length) {
    html += statusHtml('bad', 'Two rows resolve to the same company, so one of them is the wrong company.',
      escapeHtml(joined.collisions.map((c) => `${c.isin}: ${c.names.join(' / ')}`).join('; ')));
  }

  return html;
}

const canApply = (result) => result.currencyOk && result.shapeOk && result.noCollisions;

/**
 * @param {{onApplied?: Function}} options  called once, after a book is applied,
 *        so the screen behind the panel is rebuilt against the new book. The
 *        caller owns the repaint because this module must not know what a view
 *        is — the same panel is opened from the header and from the sources
 *        modal, and both hand in the same callback.
 */
export function openFtseUpload({ onApplied } = {}) {
  const inForce = data.ftse();
  const origin = inForce?.receivedAs ?? 'committed with the site';

  const body =
    `<div id="${panelId}" class="space-y-3">`
    + '<p class="text-sm leading-relaxed text-slate-600">'
    + 'Vanguard publishes its FTSE Emerging Markets holdings quarterly. Drop the workbook here and it is '
    + 'read, checked and joined onto this record by exactly the code that produced the book already on '
    + 'screen — no script, no commit. Nothing is applied until you say so.</p>'
    + (inForce?.available
      ? `<p class="text-[11px] text-slate-500">In force now: <strong class="text-slate-700">${escapeHtml(inForce.fundName ?? 'the FTSE book')}</strong>, `
        + `as at ${escapeHtml(shortDate(inForce.asOf))}, ${escapeHtml(num(inForce.resolved))} of ${escapeHtml(num(inForce.indiaRows))} rows placed — `
        + `${escapeHtml(origin)}.</p>`
      : '<p class="text-[11px] text-slate-500">No FTSE book is loaded on this record.</p>')
    + (hasInflate
      ? '<label data-drop class="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50/60 px-4 py-8 text-center transition hover:border-indigo-300 hover:bg-indigo-50/40">'
        + '<span class="text-sm font-semibold text-slate-700">Choose the .xlsx, or drop it here</span>'
        + '<span class="text-[11px] text-slate-500">Vanguard → FTSE Emerging Markets All Cap Index ETF → Holdings details</span>'
        + '<input data-file type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" class="sr-only" />'
        + '</label>'
      : statusHtml('bad', 'This browser cannot unpack an .xlsx.', escapeHtml(INFLATE_UNAVAILABLE)))
    + '<div data-report></div>'
    + '<div data-actions class="flex flex-wrap items-center gap-2"></div>'
    + '<p class="text-[11px] leading-relaxed text-slate-400">The workbook never says which currency it is in. '
    + 'It is Vanguard Canada\'s product and the book is struck in CAD, and that is re-measured on every '
    + 'read rather than taken from the fund\'s name — read as USD, every rupee figure derived from it '
    + 'would be 40.65% too large. FTSE is a second opinion: nothing in this book feeds an MSCI verdict, '
    + 'cutoff or flow.</p>'
    + '</div>';

  const handle = openModal(body, { size: 'lg', title: 'Upload the FTSE holdings workbook' });
  if (!handle) return;

  const root = handle.wrap.querySelector(`#${panelId}`);
  const report = root.querySelector('[data-report]');
  const actions = root.querySelector('[data-actions]');
  const input = root.querySelector('[data-file]');
  const drop = root.querySelector('[data-drop]');

  const setBusy = (message) => {
    report.innerHTML = statusHtml('info', message, '');
    actions.replaceChildren();
  };

  async function handleFile(file) {
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name)) {
      // ⚠ PICK BY FORMAT, NEVER BY EXTENSION — §3.1's rule, and the check that
      // matters is the one below, where the reader either finds a ZIP or does
      // not. This is only here to catch the iShares `.xls` files, which are
      // SpreadsheetML and cannot be read by this reader at all.
      report.innerHTML = statusHtml('bad', 'That is not an .xlsx.',
        `${escapeHtml(file.name)} — Vanguard's holdings export is a real OOXML workbook. The iShares `
        + 'files are named .xls and are a different format entirely; neither reader can read the other\'s.');
      return;
    }
    setBusy(`Reading ${file.name}…`);
    let result;
    try {
      result = await inspect(file);
    } catch (error) {
      report.innerHTML = statusHtml('bad', 'The workbook could not be read, so nothing was applied.',
        escapeHtml(error?.message ?? String(error)));
      return;
    }

    const state = {
      ...result,
      currencyOk: result.joined.currency.ok,
      shapeOk: result.shape.ok,
      noCollisions: result.joined.collisions.length === 0,
    };
    report.innerHTML = reportHtml(result);
    renderActions(state);
  }

  function renderActions(state) {
    actions.replaceChildren();
    const fund = state.payload.funds[0];

    // The download is offered whatever the checks said, because the artefact is
    // how a book becomes everyone's permanently — and because a book that FAILED
    // is exactly the one somebody needs to look at in a text editor.
    const blob = new Blob([`${JSON.stringify(state.payload, null, 2)}\n`], { type: 'application/json' });
    const download = el('a', {
      href: URL.createObjectURL(blob),
      download: 'ftse-funds.json',
      class: 'rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50',
      title: 'The same file scripts/import-ftse.mjs writes. Commit it to public/data/ and every reader gets '
        + 'this book permanently, through the normal deploy.',
    }, ['Download ftse-funds.json']);

    if (!canApply(state)) {
      actions.append(
        el('span', { class: 'text-[11px] font-semibold text-rose-800' },
          ['This book failed a check, so it cannot be applied. The file is still downloadable so it can be looked at.']),
        download,
      );
      return;
    }

    const apply = el('button', {
      type: 'button',
      class: 'rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800',
    }, ['Apply to the dashboard']);

    apply.addEventListener('click', async () => {
      apply.disabled = true;
      apply.textContent = 'Applying…';
      // The book AND the join a person just reviewed, together — see the header
      // of data/ftse-store.js on why the join is stored rather than redone.
      const entry = { book: state.payload, join: { meta: state.joined.meta, byIsin: state.joined.byIsin } };
      const applied = data.applyFtseBook(entry.book, entry.join);
      // `local` first, because that is true the instant it is applied and it is
      // what the sources modal must say if publishing then fails. It is upgraded
      // below only if the Worker actually stored it.
      data.setFtseOrigin('local', 'unknown', null);
      // Rebuilt BEFORE the report is written, so the sentence claiming the
      // screen has changed is only ever printed after it has.
      onApplied?.();
      const stored = store.writeLocal(entry);
      const published = await store.publish(entry);
      data.setFtseOrigin(published.state === 'published' ? 'published' : 'local', published.state, published.detail ?? null);

      const lines = [
        statusHtml('ok', 'Applied.',
          `${escapeHtml(num(applied.rowsChanged))} companies now carry a weight from the book as at `
          + `${escapeHtml(shortDate(fund.asOf))}. The screen behind this has been rebuilt.`),
      ];
      if (!stored.ok) lines.push(statusHtml('warn', 'Not kept for next time.', escapeHtml(stored.reason)));
      lines.push(publishHtml(published));
      lines.push(
        '<p class="text-[11px] leading-relaxed text-slate-500">To make this book permanent for everyone, '
        + 'download the file below and commit it to <code class="rounded bg-slate-100 px-1">public/data/ftse-funds.json</code> — '
        + 'the deploy carries it to every reader and it becomes the floor again.</p>',
      );
      report.innerHTML = lines.join('');
      actions.replaceChildren(download, el('button', {
        type: 'button',
        class: 'rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50',
      }, ['Close']));
      actions.lastChild.addEventListener('click', () => closeModal());
    });

    actions.append(apply, download);
  }

  /** Publishing has four outcomes and they are four different sentences. */
  function publishHtml(published) {
    if (published.state === 'published') {
      return statusHtml('ok', 'Shared with every reader.',
        `The Worker stored the book${published.detail ? ` — ${escapeHtml(published.detail)}` : ''}. `
        + 'Anyone opening the dashboard now sees these weights.');
    }
    if (published.state === 'not-configured') {
      return statusHtml('warn', 'This book is on YOUR screen only.',
        'The Worker has no shared store bound, so nothing was sent to other readers. It is a one-time '
        + 'setup: <code class="rounded bg-white/60 px-1">npx wrangler kv namespace create FTSE_BOOK</code>, '
        + 'then uncomment the <code class="rounded bg-white/60 px-1">kv_namespaces</code> block in '
        + 'wrangler.jsonc with the id it prints and deploy. After that every upload reaches everyone '
        + 'automatically.');
    }
    if (published.state === 'no-worker') {
      return statusHtml('warn', 'This book is on YOUR screen only.',
        'There is no Worker on this host — this is the static site, which is the designed floor. Commit '
        + 'the downloaded file to share the book, or run the dashboard behind the Worker.');
    }
    return statusHtml('warn', 'This book is on YOUR screen only.',
      `The shared store could not be reached${published.detail ? ` — ${escapeHtml(published.detail)}` : ''}. `
      + 'The download below is the way to share it.');
  }

  input?.addEventListener('change', (event) => handleFile(event.target.files?.[0]));
  if (drop) {
    for (const type of ['dragenter', 'dragover']) {
      drop.addEventListener(type, (event) => {
        event.preventDefault();
        drop.classList.add('border-indigo-400', 'bg-indigo-50/60');
      });
    }
    for (const type of ['dragleave', 'drop']) {
      drop.addEventListener(type, () => drop.classList.remove('border-indigo-400', 'bg-indigo-50/60'));
    }
    drop.addEventListener('drop', (event) => {
      event.preventDefault();
      handleFile(event.dataTransfer?.files?.[0]);
    });
  }
}
