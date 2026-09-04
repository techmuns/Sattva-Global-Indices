#!/usr/bin/env node
/**
 * verify-ui.mjs — the served site, in both modes.
 *
 *   node scripts/verify-ui.mjs                                  static server, live checks SKIP
 *   node scripts/verify-ui.mjs http://127.0.0.1:8787 --require-live   wrangler dev, a SKIP is a failure
 *   node scripts/verify-ui.mjs --prove                          each check must fail on purpose
 *
 * THE STATIC FLOOR IS A MODE, NOT A DEGRADATION. Against
 * `python3 -m http.server 8080 -d public` there is no /api/quotes, every row
 * stays on its committed close and the header says "Last close". That run is
 * worth doing precisely because it exercises the floor — so the live checks
 * report SKIP rather than being silently dropped, and the summary always says
 * how many were skipped and why. Against a real Worker, --require-live turns
 * any SKIP in the live block into a failure, because there a skip means the
 * live path was not exercised at all.
 *
 * NEVER SLEEP TO WAIT FOR THE TABLE. `settle()` waits for `data-rows-pending`
 * to clear. A sleep that passes today fails on a slower machine, and — worse —
 * passes for the wrong reason on a fast one.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

import { Suite, parseArgs, ok, equal, empty, skip } from './lib/assert.mjs';
import { closedReviews } from '../public/js/model/calendar.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DEFAULT_BASE = 'http://127.0.0.1:8080';

/* ── Playwright, from wherever it is installed ─────────────────────────────
 * There is no package.json in this repo and there is not going to be one, so
 * the browser driver is resolved from the global install rather than a
 * dependency. If it is absent the suite cannot run at all — that is an
 * environment failure and exits 2, distinct from a check failing.
 */
async function loadPlaywright() {
  // ESM does not honour NODE_PATH, so the global root is turned into an
  // explicit path rather than left to bare-specifier resolution. CI sets
  // NODE_PATH="$(npm root -g)" and the runner's own location differs by image.
  const globalRoots = (process.env.NODE_PATH ?? '').split(':').filter(Boolean);
  const candidates = [
    'playwright',
    ...globalRoots.map((root) => join(root, 'playwright', 'index.js')),
    '/opt/node22/lib/node_modules/playwright/index.js',
    '/usr/lib/node_modules/playwright/index.js',
    '/usr/local/lib/node_modules/playwright/index.js',
    '/usr/local/share/npm-global/lib/node_modules/playwright/index.js',
  ];
  for (const specifier of candidates) {
    try {
      const mod = await import(specifier);
      return mod.default ?? mod;
    } catch { /* try the next one */ }
  }
  const require = createRequire(import.meta.url);
  try { return require('playwright'); } catch { /* fall through */ }
  return null;
}

/* ── the naive range parser, for --prove ───────────────────────────────────
 * Assertion 44 has to be able to fail, and the way it would fail in real life
 * is that somebody reads a typed figure the easy way. This is that version,
 * served over the top of the real module when the suite is proving itself: it
 * reads a grouped figure as its first digits and treats anything it cannot
 * read as no filter at all, silently. Both are what the check exists to catch.
 */
const RANGE_MODULE_GLOB = '**/js/core/range.js';
const NAIVE_RANGE_MODULE = `
export function parseRange(value) {
  const min = parseFloat(value?.min ?? 0);
  const max = parseFloat(value?.max ?? 0);
  const lo = Number.isFinite(min) ? min : null;
  const hi = Number.isFinite(max) ? max : null;
  return { min: lo, max: hi, active: lo !== null || hi !== null, empty: lo === null && hi === null, error: null };
}
export function withinRange(value, range) {
  if (value === null || value === undefined) return false;
  if (range.min !== null && value < range.min) return false;
  if (range.max !== null && value > range.max) return false;
  return true;
}
`;

/* ── console-error classification ──────────────────────────────────────────
 * BY URL, NEVER BY MESSAGE TEXT. Matching on words would swallow a real error
 * that happened to mention a font, and would keep swallowing it silently. The
 * two CDN families are Tailwind and Google Fonts; both are loaded from the
 * document and both are expected to fail in a sandboxed or offline run.
 *
 * The filtered count is always printed. A run that hides a real error behind
 * the filter must still show that the filter was doing work.
 */
const CDN_HOSTS = [/(^|\.)cdn\.tailwindcss\.com$/, /(^|\.)fonts\.googleapis\.com$/, /(^|\.)fonts\.gstatic\.com$/];

function isCdnNoise(url) {
  if (!url) return false;
  try { return CDN_HOSTS.some((re) => re.test(new URL(url).hostname)); } catch { return false; }
}

/**
 * The third family: the no-Worker probe on the static floor.
 *
 * `python3 -m http.server` answers a POST with **501 Unsupported method**, and
 * the browser logs that to the console. It is not a defect — it is the floor
 * working as designed. `quotes.js` treats 404 / 405 / 501 on this route as
 * `no-worker` by name ("this deployment serves static files only"), assertion
 * 41 asserts every row then falls back to its committed close, and assertion 39
 * skips for the same reason.
 *
 * This was a FLAKY failure, not a new one. The poller fires on a timer, so
 * whether its first POST landed before assertion 22 read the bucket was a race:
 * the same commit passed on a fast runner and failed on a slow one. Classifying
 * it is the fix; widening "acceptable console errors" is not.
 *
 * Deliberately narrow, so it cannot hide a real fault:
 *   - only when there is NO Worker. Against `wrangler dev` a failing
 *     /api/quotes is a genuine error and still fails assertion 22.
 *   - only this origin and only this exact path.
 *   - only the three statuses the application itself recognises.
 *   - counted and reported in its own bucket, never merged into the CDN count.
 */
const NO_WORKER_STATUSES = /\b(404|405|501)\b/;

function isDesignedNoWorkerProbe(url, text, { base, hasWorker }) {
  if (hasWorker || !url) return false;
  try {
    const parsed = new URL(url);
    if (`${parsed.protocol}//${parsed.host}` !== new URL(base).origin) return false;
    if (parsed.pathname !== '/api/quotes') return false;
  } catch { return false; }
  return NO_WORKER_STATUSES.test(text ?? '');
}

/**
 * Is this /api/quotes on the origin under test, whatever the failure text?
 * Used only inside a declared induced-noise window.
 */
function isQuotesRoute(url, base) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}` === new URL(base).origin && parsed.pathname === '/api/quotes';
  } catch { return false; }
}

function attachConsole(page, bucket, options) {
  const bucketFor = (url, text) => {
    if (isCdnNoise(url)) return 'filtered';
    // THE HARNESS OWNS THE NOISE IT MAKES. Assertions 39 and 41 deliberately
    // cut /api/quotes to prove the fallback; the browser logs the aborted
    // request as net::ERR_FAILED, which carries no status and so is rightly
    // declined by the designed-probe classifier above. Attributing it to "our
    // own code" in the summary would be a false report of a fault the test
    // caused on purpose. The window is opened and closed by those checks and
    // covers only that one route.
    if (bucket.inducing && isQuotesRoute(url, options.base)) return 'induced';
    if (isDesignedNoWorkerProbe(url, text, options)) return 'designed';
    return 'real';
  };
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const url = msg.location()?.url ?? null;
    const text = msg.text();
    bucket[bucketFor(url, text)].push(`${url ?? '(no url)'} :: ${text.slice(0, 160)}`);
  });
  page.on('pageerror', (error) => { bucket.real.push(`pageerror :: ${error.message.slice(0, 160)}`); });
  page.on('requestfailed', (request) => {
    const url = request.url();
    if (isCdnNoise(url)) bucket.filtered.push(`${url} :: ${request.failure()?.errorText ?? 'request failed'}`);
  });
}

/* ══════════════════════════════════════════════════════════════════════════*/
async function main() {
  const { requireLive, prove, only, baseUrl } = parseArgs(process.argv);
  const base = (baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');

  const pw = await loadPlaywright();
  if (!pw) {
    process.stderr.write(
      '\n  verify-ui needs Playwright, and it is not installed.\n' +
      '  It is a global tool, never a dependency of this repo — there is no package.json here.\n' +
      '    npm i -g playwright && npx playwright install chromium\n\n',
    );
    process.exit(2);
  }

  // Is a Worker answering, or is this the static floor?
  let hasWorker = false;
  let workerNote = '';
  try {
    const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(4000) });
    const json = response.ok ? await response.json() : null;
    hasWorker = Boolean(json?.ok);
    workerNote = hasWorker ? `Worker present (token configured: ${json.tokenConfigured})` : `no Worker (/api/health → ${response.status})`;
  } catch (error) {
    workerNote = `no Worker (${String(error.message).slice(0, 60)})`;
  }

  // 150 s is far above any healthy check here (the slowest is ~12 s) and far
  // below the point at which a stalled run looks like a working one.
  const suite = new Suite('verify-ui', { requireLive, prove, only, timeoutMs: 150000 });
  suite.write(
    `\n  Sattva Index Flows — interface verification\n` +
    `  base ${base} — ${workerNote}${requireLive ? '  [--require-live: a skip is a failure]' : ''}` +
    `${prove ? '\n  --prove: every check must fail on purpose' : ''}\n`,
  );

  if (requireLive && !hasWorker) {
    suite.write(`\n  --require-live was passed but no Worker answered at ${base}. Every live check will fail.\n`);
  }

  const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const errors = { real: [], filtered: [], designed: [], induced: [], inducing: false };
  attachConsole(page, errors, { base, hasWorker });

  /** Wait for the streaming fill to finish. Never a sleep. */
  const settle = async () => {
    await page.waitForFunction(() => {
      const table = document.querySelector('[data-score-table]');
      return Boolean(table) && !table.hasAttribute('data-rows-pending');
    }, null, { timeout: 30000 });
  };

  /**
   * The in-page settle, for the many assertions that interact and then read.
   *
   * NEVER SLEEP TO WAIT FOR THE TABLE. A filter or a sort repaints
   * synchronously and sets `data-rows-pending` while the streaming fill
   * catches up, so the condition to wait on is that attribute clearing AND the
   * DOM row count matching the view — not a duration that happens to be long
   * enough on this machine today.
   *
   * The search box is the one case with a genuine delay in front of it: the
   * app debounces input by 120 ms before it repaints at all, so waiting only
   * on `data-rows-pending` would return instantly, before anything had
   * happened. `__settleSearch(q)` therefore waits for the QUERY to have been
   * consumed — the table's own `view.q` matching what was typed — and only
   * then for the fill. That is still a condition, not a duration.
   */
  const installHelpers = async () => {
    await page.evaluate(() => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
      const filled = async () => {
        for (let i = 0; i < 600; i += 1) {
          const table = document.querySelector('[data-score-table]');
          const pending = !table || table.hasAttribute('data-rows-pending');
          const dom = document.querySelectorAll('[data-score-table] tbody tr').length;
          const view = window.__sattva.rows().length;
          if (!pending && dom === view) return true;
          await frame();
        }
        throw new Error('the table never settled');
      };
      window.__settle = filled;
      window.__settleSearch = async (q) => {
        for (let i = 0; i < 600; i += 1) {
          if (window.__sattva.view.table()?.view.q === q) break;
          await frame();
        }
        return filled();
      };
      window.__set = async (select, value) => {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return filled();
      };
      /**
       * Type into a min–max range control, the way a person does.
       *
       * Typing is debounced in the interface, so this waits for the VIEW to
       * have taken the entry before it waits for the fill — the same shape as
       * `__settleSearch`, and for the same reason: a wait on the rows alone
       * would sail through the window before the keystroke was consumed and
       * measure the previous filter.
       */
      /**
       * Switch the rebalance baseline and wait for the switch to have LANDED.
       *
       * ⚠ NEITHER `__set` NOR THE SELECT'S OWN VALUE IS A USABLE WAIT HERE.
       * `__set` assigns the value synchronously and then waits for the CURRENT
       * table to settle, but a switch fetches a 1.2 MB file before it repaints,
       * so both return long before anything has changed. Waiting on the select's
       * value is worse: the harness set it itself, so the condition is true the
       * instant it is asked.
       *
       * The condition only the switch can satisfy is the BASELINE STRIP being
       * re-rendered — `baselineHost.replaceChildren(...)` detaches the old
       * control, and that happens after `ensureBaseline` has resolved and the
       * state has moved. It is not circular with what these checks assert: the
       * control and the table cells are produced by different code.
       *
       * This wait used to be "the table node was replaced", which was true only
       * while a baseline switch rebuilt the whole table. It stopped rebuilding
       * it on 1 Sep 2026 — that was the freeze fix — and the wait had to move to
       * a signal the new behaviour actually produces.
       */
      window.__setBaseline = async (review) => {
        const previous = document.querySelector('[data-baseline]');
        previous.value = review;
        previous.dispatchEvent(new Event('change', { bubbles: true }));
        for (let i = 0; i < 1800; i += 1) {
          const now = document.querySelector('[data-baseline]');
          if (now && now !== previous && now.value === review) break;
          await frame();
        }
        return filled();
      };
      window.__setRange = async (id, min, max) => {
        const wrap = document.querySelector(`[data-range="${id}"]`);
        if (!wrap) throw new Error(`no range control "${id}"`);
        const boxes = { min: wrap.querySelector('[data-range-min]'), max: wrap.querySelector('[data-range-max]') };
        boxes.min.value = min;
        boxes.max.value = max;
        boxes.min.dispatchEvent(new Event('input', { bubbles: true }));
        for (let i = 0; i < 600; i += 1) {
          const held = window.__sattva.view.table()?.view.filters[id];
          if (held && held.min === min && held.max === max) break;
          await frame();
        }
        return filled();
      };
      /** Wait for a condition, by frame. Still never a duration. */
      window.__until = async (predicate, label = 'condition') => {
        for (let i = 0; i < 600; i += 1) {
          if (predicate()) return true;
          await frame();
        }
        throw new Error(`${label} never became true`);
      };
    });
  };

  /**
   * A sabotage has to SURVIVE what the check does next. Several checks reload
   * the page or trigger a re-render as their first act, which wipes a one-shot
   * DOM mutation before a single assertion reads it — and the check then passes
   * its own sabotage and is reported as CANNOT FAIL. So a sabotage registers a
   * hook here, and every load re-applies it until `restore` clears it.
   */
  const applyHook = async () => {
    // `ctx` is declared below; applyHook only ever runs after that.
    if (ctx.sabotageHook) await page.evaluate(ctx.sabotageHook).catch(() => {});
  };

  const load = async (hash = '#/companies') => {
    // about:blank first. `goto` to a URL differing only in its hash is a
    // SAME-DOCUMENT navigation — the module graph is never re-evaluated, so
    // the live overlay, the poller and every other module-level variable
    // survive into a check that believes it started from nothing.
    await page.goto('about:blank');
    await page.goto(`${base}/${hash}`, { waitUntil: 'domcontentloaded' });
    await settle();
    await installHelpers();
    await applyHook();
  };

  const reload = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle();
    await installHelpers();
    await applyHook();
  };

  const ctx = { page, base, hasWorker, settle, load, reload, errors, csvOverride: null, sabotageHook: null };
  const restoreByReload = async (c) => { c.sabotageHook = null; await c.load(); };

  /** Register a sabotage that re-applies itself on every load. */
  const persistent = (body) => async (c) => { c.sabotageHook = body; await c.page.evaluate(body).catch(() => {}); };

  await load();

  /* ── the shell ──────────────────────────────────────────────────────────*/
  suite.section('Shell and rows');

  await suite.check({
    id: 22,
    what: 'the shell renders with zero console errors beyond the two CDN families',
    run: async (c) => {
      const shell = await c.page.evaluate(() => ({
        header: Boolean(document.querySelector('[data-status-slot]')),
        table: Boolean(document.querySelector('[data-score-table]')),
        toolbar: Boolean(document.querySelector('[data-toolbar]')),
      }));
      for (const [part, present] of Object.entries(shell)) ok(present, `the ${part} must render`);
      empty(c.errors.real, 'a console error from our own code is a failure', (e) => e);
      return `${c.errors.filtered.length} CDN failures filtered (Tailwind / Google Fonts) and `
        + `${c.errors.designed.length} designed no-Worker probe(s) on /api/quotes, classified by response URL; `
        + `${c.errors.real.length} from our own code`;
    },
    sabotage: async (c) => {
      await c.page.evaluate(() => {
        const s = document.createElement('script');
        s.textContent = 'throw new Error("deliberate sabotage");';
        document.body.append(s);
      });
      // Not a table wait: a moment for the injected script's throw to reach
      // the pageerror listener. Nothing about the page's own work is timed.
      await new Promise((r) => setTimeout(r, 50));
    },
    restore: restoreByReload,
  }, ctx);

  await suite.check({
    id: 23,
    what: 'every row reaches the DOM, data-rows-pending clears, and the count comes from the array',
    run: async (c) => {
      const m = await c.page.evaluate(() => ({
        pending: document.querySelector('[data-score-table]').hasAttribute('data-rows-pending'),
        dom: document.querySelectorAll('[data-score-table] tbody tr').length,
        array: window.__sattva.rows().length,
        all: window.__sattva.data.all().length,
        chip: document.querySelector('[data-row-count]')?.textContent?.trim() ?? '',
      }));
      equal(m.pending, false, 'data-rows-pending must clear');
      equal(m.dom, m.array, 'every row in the view must reach the DOM');
      ok(m.chip.includes(String(m.array.toLocaleString('en-IN'))) || m.chip.includes(String(m.array)),
        'the row count must read the array', `chip "${m.chip}" vs array ${m.array}`);
      ok(m.chip.includes('of'), 'the count must print its denominator', `chip reads "${m.chip}"`);
      return `${m.dom} rows in the DOM = ${m.array} in the view, of ${m.all} in the record — chip "${m.chip}"`;
    },
    sabotage: async (c) => { await c.page.evaluate(() => document.querySelector('[data-score-table] tbody tr').remove()); },
    restore: restoreByReload,
  }, ctx);

  await suite.check({
    id: 24,
    what: 'row integrity by comparison: rendered (ISIN, name) pairs against the source array',
    run: async (c) => {
      const m = await c.page.evaluate(() => {
        const d = window.__sattva;
        // Find the column by its heading. A fixed nth-child silently starts
        // reading a different column the moment one is inserted — which is
        // exactly what happened when Verdict and Distance landed.
        const headings = [...document.querySelectorAll('[data-score-table] thead th')].map((th) => th.textContent.trim());
        const nameIndex = headings.findIndex((h) => /^Company/i.test(h));
        const rendered = [...document.querySelectorAll('[data-score-table] tbody tr')].map((tr) => ({
          key: tr.getAttribute('data-key'),
          name: tr.children[nameIndex]?.innerText.replace(/\s+/g, ' ').trim() ?? null,
        }));
        const source = d.rows().map((r) => ({ key: d.data.keyOf(r), name: r.name }));
        return { rendered, source, nameIndex, headings };
      });
      // Counting cannot catch a key collision; comparing the sets can.
      const renderedKeys = m.rendered.map((r) => r.key);
      const sourceKeys = m.source.map((r) => r.key);
      const dupes = renderedKeys.filter((k, i) => renderedKeys.indexOf(k) !== i);
      const missing = sourceKeys.filter((k) => !renderedKeys.includes(k));
      const extra = renderedKeys.filter((k) => !sourceKeys.includes(k));
      empty(dupes, 'no ISIN may be rendered twice', (k) => k);
      empty(missing, 'no company in the view may be missing from the DOM', (k) => k);
      empty(extra, 'no row may be rendered that is not in the view', (k) => k);
      ok(m.nameIndex >= 0, 'the Company column must be locatable by its heading', m.headings.join(' | '));
      // The cell leads with an avatar and carries the ticker beneath, so the
      // company name must be CONTAINED, not the whole of it.
      const wrongName = m.rendered.filter((r, i) => r.name && !r.name.includes(m.source[i].name.slice(0, 14)));
      empty(wrongName, 'each rendered row must carry its own company\'s name', (r) => `${r.key} shows "${r.name}"`);
      return `${m.rendered.length} rendered pairs matched against ${m.source.length} source rows — 0 duplicate, 0 missing, 0 extra`;
    },
    sabotage: async (c) => {
      await c.page.evaluate(() => {
        const rows = document.querySelectorAll('[data-score-table] tbody tr');
        rows[1].setAttribute('data-key', rows[0].getAttribute('data-key'));
      });
    },
    restore: restoreByReload,
  }, ctx);

  await suite.check({
    id: 25,
    what: 'the whole universe is shown, the shipped model is named on every row, and NO model switch is offered',
    run: async (c) => {
      // THE MODEL TOGGLE IS GONE (31 Aug 2026) and this check changed with it,
      // the way it had already changed when the Held/All scope toggle went.
      // What it asserted — that switching the model moved verdicts without
      // moving rows — cannot be asserted through an interface that offers no
      // switch. Two things replace it, and both are properties of the shipped
      // screen rather than of a control:
      //
      //   the row set is still the WHOLE universe (the scope half, unchanged);
      //   and the second model has not gone with the toggle — the drill panel
      //   still names its verdict per company, which is where the comparison
      //   moved. A drill that stopped saying so would leave the screen quietly
      //   presenting one methodology as the only one there is.
      const shell = await c.page.evaluate(() => ({
        n: window.__sattva.rows().length,
        all: window.__sattva.data.all().length,
        model: window.__sattva.state.METHODOLOGY,
        methodologies: window.__sattva.state.METHODOLOGIES,
        toggles: document.querySelectorAll('[data-model-slot], [data-model-banner]').length,
        heading: document.body.innerText,
      }));

      equal(shell.n, shell.all, 'every company in the record must be shown — there is no scope and no model subset');
      equal(shell.model, 'freefloat', 'the free-float model is the one that renders');
      equal(shell.toggles, 0, 'no model toggle and no model banner may be on the page');
      ok(shell.methodologies.length > 1,
        'the second methodology must still exist — the drill compares against it',
        JSON.stringify(shell.methodologies));
      const denominator = new RegExp(`of\\s+${shell.all.toLocaleString('en-IN')}`);
      ok(denominator.test(shell.heading), 'the count must print its denominator', `no "of ${shell.all}" found`);

      // The comparison itself, on a row: the drill must name the other model's
      // verdict and say whether the two agree.
      const drill = await c.page.evaluate(async () => {
        const disagreeing = window.__sattva.data.all().find((company) => {
          const a = window.__sattva.view.assessmentFor(company)?.verdict;
          const b = window.__sattva.view.otherAssessmentFor(company)?.verdict;
          return a && b && a !== b;
        });
        if (!disagreeing) return { found: false };
        window.__sattva.view.openCompany(window.__sattva.data.keyOf(disagreeing));
        await window.__until(() => document.querySelector('[data-drill-body]')?.innerText, 'the drill opening');
        const text = document.querySelector('[data-drill-body]').innerText;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return {
          found: true,
          name: disagreeing.name,
          saysDisagrees: /other model disagrees/i.test(text),
          namesToggle: /toggle/i.test(text),
        };
      });
      ok(drill.found, 'the two models must disagree about at least one company, or there is nothing to compare');
      ok(drill.saysDisagrees, 'the drill must name the other model\'s verdict where the two differ', drill.name);
      // A pointer to a control that no longer exists is worse than no pointer.
      ok(!drill.namesToggle, 'nothing may tell the reader to switch a toggle that is gone', drill.name);

      return `${shell.n} of ${shell.all} rows · model "${shell.model}" of ${shell.methodologies.length} that exist `
        + `· 0 toggles on the page · drill names the other model on ${drill.name}`;
    },
    sabotage: persistent(`(() => {
      // Put the toggle back — as far as this check is concerned, a stray model
      // control on the page is exactly the regression it exists to catch.
      const add = () => {
        if (document.querySelector('[data-model-slot]')) return;
        const slot = document.createElement('div');
        slot.setAttribute('data-model-slot', '');
        document.body.append(slot);
      };
      add();
      new MutationObserver(add).observe(document.body, { childList: true, subtree: true });
    })()`),
    restore: restoreByReload,
  }, ctx);

  suite.section('Search, filters and sort');

  await suite.check({
    id: 26,
    what: 'search matches name, symbol and ISIN; every filter narrows — the typed range included; two filters AND rather than replace',
    run: async (c) => {
      const searchResults = await c.page.evaluate(async () => {
        const input = document.querySelector('[data-search]');
        const fire = async (value) => {
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await window.__settleSearch(value);
          return window.__sattva.rows().length;
        };
        const out = {
          name: await fire('Reliance Industries'),
          symbol: await fire('LAURUSLABS'),
          isin: await fire('INE002A01018'),
          nonsense: await fire('zzzznotacompanyzzzz'),
        };
        await fire('');
        return out;
      });
      ok(searchResults.name >= 1, 'search by name must match', `${searchResults.name} rows`);
      ok(searchResults.symbol >= 1, 'search by NSE symbol must match', `${searchResults.symbol} rows`);
      equal(searchResults.isin, 1, 'search by ISIN must match exactly one company');
      equal(searchResults.nonsense, 0, 'a nonsense search must match nothing');

      const filters = await c.page.evaluate(async () => {
        // EVERY CONTROL IN THE TOOLBAR, not every <select>. The market-cap
        // filter became a typed range on 31 Aug 2026, and an enumeration that
        // only ever looked for a <select> would have gone on reporting a tick
        // while quietly covering one filter fewer.
        const controls = [
          ...[...document.querySelectorAll('select[data-filter]')].map((select) => ({
            id: select.dataset.filter,
            value: [...select.options].find((o) => o.value !== '')?.value,
            apply: (v) => window.__set(select, v ?? ''),
            clear: () => window.__set(select, ''),
          })),
          ...[...document.querySelectorAll('[data-range]')].map((wrap) => ({
            id: wrap.dataset.range,
            // A minimum well inside the universe, so a range that narrows
            // nothing is a failure rather than a coincidence.
            value: { min: '10,000', max: '' },
            apply: (v) => window.__setRange(wrap.dataset.range, v.min, v.max),
            clear: () => window.__setRange(wrap.dataset.range, '', ''),
          })),
        ].filter((control) => control.value !== undefined);

        const total = window.__sattva.rows().length;
        const results = [];
        // each filter alone
        for (const control of controls) {
          await control.apply(control.value);
          results.push({
            id: control.id,
            value: typeof control.value === 'string' ? control.value : `${control.value.min}–${control.value.max}`,
            n: window.__sattva.rows().length,
            keys: window.__sattva.rows().map((r) => window.__sattva.data.keyOf(r)),
          });
          await control.clear();
        }

        // Two together, and one of them is the range — the AND has to hold
        // across the two KINDS of filter, which is where a rewrite of the
        // resolution step would break it.
        const a = controls.find((control) => typeof control.value !== 'string') ?? controls[0];
        const b = controls.find((control) => control.id !== a.id
          && results.find((r) => r.id === control.id)?.n > 0);
        await a.apply(a.value);
        await b.apply(b.value);
        const combined = window.__sattva.rows().map((r) => window.__sattva.data.keyOf(r));
        await a.clear();
        await b.clear();
        return {
          total,
          results,
          combined,
          a: a.id,
          b: b.id,
          keysA: results.find((r) => r.id === a.id).keys,
          keysB: results.find((r) => r.id === b.id).keys,
        };
      });

      ok(filters.results.length >= 4, 'every filter must be exercised', `${filters.results.length} filters found`);
      for (const r of filters.results) {
        ok(r.n < filters.total, `filter "${r.id}=${r.value}" must narrow the view`, `${r.n} of ${filters.total}`);
      }
      // AND, not replace: the combined set is exactly the intersection.
      const expected = filters.keysA.filter((k) => filters.keysB.includes(k)).sort();
      const actual = [...filters.combined].sort();
      equal(JSON.stringify(actual), JSON.stringify(expected),
        `${filters.a} AND ${filters.b} must intersect (${expected.length} rows), not replace one another`);
      return `search name/symbol/ISIN ok · ${filters.results.length} filters each narrow · ${filters.a}+${filters.b} → ${actual.length} = intersection`;
    },
    sabotage: async (c) => {
      // Make one filter stop narrowing, which is what "replace" would look like.
      await c.page.evaluate(() => {
        const table = document.querySelector('[data-score-table]');
        const tbody = table.querySelector('tbody');
        const clone = tbody.rows[0].cloneNode(true);
        clone.setAttribute('data-key', 'SABOTAGE');
        const original = window.__sattva.rows;
        window.__sattva.rows = () => original().concat([{ name: 'Sabotage Ltd', isin: 'SABOTAGE' }]);
      });
    },
    restore: restoreByReload,
  }, ctx);

  await suite.check({
    id: 44,
    what: 'a typed market-cap range reads grouped digits, includes both ends, and NAMES an entry it cannot read instead of emptying the table',
    run: async (c) => {
      const m = await c.page.evaluate(async () => {
        const toCr = (rupees) => rupees / 1e7;
        const all = window.__sattva.data.all();
        const keyOf = window.__sattva.data.keyOf;
        const shownKeys = () => new Set(window.__sattva.rows().map(keyOf));
        const status = () => {
          const node = document.querySelector('[data-filter-status]');
          return { text: node?.textContent ?? '', hidden: node?.hidden ?? true, rose: /text-rose/.test(node?.className ?? '') };
        };
        const invalid = () => [...document.querySelectorAll('[data-range="mcap"] input')]
          .map((input) => input.getAttribute('aria-invalid'));

        const total = window.__sattva.rows().length;

        // 1. GROUPED DIGITS. "3,000" is three thousand. Read the way parseFloat
        //    reads it, it is 3 — and the screen fills with a confident,
        //    well-formatted table of entirely the wrong companies.
        await window.__setRange('mcap', '3,000', '8,000');
        const grouped = {
          rows: window.__sattva.rows().length,
          expected: all.filter((x) => x.fullMcapInr != null
            && toCr(x.fullMcapInr) >= 3000 && toCr(x.fullMcapInr) <= 8000).length,
          status: status(),
        };

        // 2. BOTH ENDS INCLUDED, measured on the two companies that ARE the
        //    ends. A half-open range would drop the top one silently.
        const sized = all.filter((x) => x.fullMcapInr != null).sort((a, b) => a.fullMcapInr - b.fullMcapInr);
        const low = sized[Math.floor(sized.length * 0.25)];
        const high = sized[Math.floor(sized.length * 0.75)];
        const lowText = String(toCr(low.fullMcapInr));
        const highText = String(toCr(high.fullMcapInr));
        await window.__setRange('mcap', lowText, highText);
        const seen = shownKeys();
        const ends = {
          lowText,
          highText,
          low: seen.has(keyOf(low)),
          high: seen.has(keyOf(high)),
          rows: seen.size,
          expected: sized.filter((x) => toCr(x.fullMcapInr) >= Number(lowText)
            && toCr(x.fullMcapInr) <= Number(highText)).length,
        };

        // 3. AN UNREADABLE ENTRY IS A NAMED STATE. Nothing hidden, the reason
        //    on screen, the boxes marked invalid.
        await window.__setRange('mcap', 'abc', '');
        const unreadable = { rows: window.__sattva.rows().length, status: status(), invalid: invalid() };

        // 4. AND SO IS A REVERSED ONE. It is the case that would otherwise
        //    empty the table with no explanation at all.
        await window.__setRange('mcap', '8000', '3000');
        const reversed = { rows: window.__sattva.rows().length, status: status() };

        // 5. NO READING IS NOT A SIZE. A company we have not measured belongs
        //    to no range in either direction — it is not small and not large.
        const noReading = all.filter((x) => x.fullMcapInr == null);
        await window.__setRange('mcap', '0', '');
        const everything = shownKeys();
        const missing = {
          rows: everything.size,
          noReading: noReading.length,
          shown: noReading.filter((x) => everything.has(keyOf(x))).length,
        };

        await window.__setRange('mcap', '', '');
        const cleared = { rows: window.__sattva.rows().length, status: status() };
        return { total, grouped, ends, unreadable, reversed, missing, cleared };
      });

      ok(/^\d/.test(m.ends.lowText) && /^\d/.test(m.ends.highText),
        'the endpoint figures must be plain decimals for this to test what it claims',
        `${m.ends.lowText} / ${m.ends.highText}`);

      equal(m.grouped.rows, m.grouped.expected,
        `"3,000"–"8,000" must be read as three thousand to eight thousand — ${m.grouped.expected} companies, not ${m.grouped.rows}`);
      ok(m.grouped.rows > 0 && m.grouped.rows < m.total, 'and it must narrow the view', `${m.grouped.rows} of ${m.total}`);
      ok(/3,000/.test(m.grouped.status.text) && /8,000/.test(m.grouped.status.text),
        'the status line must say what the entry was read as', `reads "${m.grouped.status.text}"`);
      ok(/inclusive/i.test(m.grouped.status.text),
        'and it must say the ends are included, rather than leaving it to be discovered',
        `reads "${m.grouped.status.text}"`);

      equal(m.ends.rows, m.ends.expected, 'a range must match exactly the companies inside it');
      ok(m.ends.low, 'the company sitting exactly on the minimum must be included');
      ok(m.ends.high, 'the company sitting exactly on the maximum must be included');

      equal(m.unreadable.rows, m.total, 'an entry that cannot be read must hide NOTHING');
      equal(m.unreadable.status.hidden, false, 'and it must say so on screen');
      ok(/not a number/i.test(m.unreadable.status.text) && /NOT applied/i.test(m.unreadable.status.text),
        'the message must name the failure and say the filter is not in force',
        `reads "${m.unreadable.status.text}"`);
      ok(m.unreadable.status.rose, 'a broken entry must not read like a working one');
      equal(JSON.stringify(m.unreadable.invalid), JSON.stringify(['true', 'true']),
        'both boxes must be marked aria-invalid');

      equal(m.reversed.rows, m.total, 'a reversed range must hide nothing either');
      ok(/minimum is above the maximum/i.test(m.reversed.status.text),
        'a reversed range must be named rather than shown as an empty table',
        `reads "${m.reversed.status.text}"`);

      equal(m.missing.shown, 0, 'a company with no market-cap reading must match no range');
      equal(m.missing.rows, m.total - m.missing.noReading,
        'an open-ended range must show every company that HAS a reading, and only those');

      equal(m.cleared.rows, m.total, 'clearing the range must restore every row');
      equal(m.cleared.status.hidden, true, 'and the status line must go away with it');

      return `3,000–8,000 → ${m.grouped.rows} of ${m.total} · ends ${m.ends.lowText}/${m.ends.highText} both included `
        + `· "abc" hides nothing and says why · reversed named · ${m.missing.noReading} unmeasured companies in no range`;
    },
    sabotage: async (c) => {
      // SERVE THE NAIVE PARSER IN PLACE OF THE REAL ONE. It is the version this
      // check exists to keep out: parseFloat reads "3,000" as 3 without
      // erroring, and it turns an unreadable entry into no filter at all with
      // nothing said. Sabotaging the module rather than the DOM proves the
      // check covers the parse, not just the markup around it.
      await c.page.route(RANGE_MODULE_GLOB, (route) => route.fulfill({
        contentType: 'application/javascript',
        body: NAIVE_RANGE_MODULE,
      }));
      await c.load();
    },
    restore: async (c) => {
      await c.page.unroute(RANGE_MODULE_GLOB);
      c.sabotageHook = null;
      await c.load();
    },
  }, ctx);

  await suite.check({
    id: 27,
    what: 'a header sorts ascending and descending, and missing values sort last in both directions',
    run: async (c) => {
      const result = await c.page.evaluate(async () => {
        const table = document.querySelector('[data-score-table]');
        const headings = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
        // A column that genuinely has missing values.
        const label = 'EM wt %';
        const index = headings.findIndex((h) => h.startsWith(label));
        const button = [...table.querySelectorAll('[data-sort]')].find((b) => b.dataset.sort.startsWith(label));
        const read = () => [...table.querySelectorAll('tbody tr')].map((tr) => tr.children[index]?.innerText.trim() ?? '');
        const snap = [];
        for (let i = 0; i < 2; i += 1) {
          button.click();
          await window.__settle();
          const values = read();
          const missingAt = values.map((v, n) => (v === '—' ? n : -1)).filter((n) => n >= 0);
          const presentAt = values.map((v, n) => (v === '—' ? -1 : n)).filter((n) => n >= 0);
          snap.push({
            direction: table.querySelector(`thead th:nth-child(${index + 1})`)?.getAttribute('aria-sort'),
            missing: missingAt.length,
            present: presentAt.length,
            firstMissing: missingAt.length ? Math.min(...missingAt) : null,
            lastPresent: presentAt.length ? Math.max(...presentAt) : null,
            head: values.slice(0, 3),
          });
        }
        return { headings, index, snap };
      });
      ok(result.index > 0, 'the sorted column must be found', JSON.stringify(result.headings));
      const [first, second] = result.snap;
      ok(first.direction !== second.direction, 'two clicks must produce two directions', `${first.direction} then ${second.direction}`);
      for (const s of result.snap) {
        ok(s.missing > 0, 'the column must actually contain missing values to prove anything', `${s.missing} em dashes`);
        ok(s.firstMissing > s.lastPresent,
          `missing values must sort last when ${s.direction}`,
          `first missing at ${s.firstMissing}, last present at ${s.lastPresent}`);
      }
      return `${first.direction} then ${second.direction}; ${first.missing} missing values last in both`;
    },
    sabotage: persistent(`(() => {
      // Missing values floating to the top, and staying there through the
      // re-render each sort click performs.
      //
      // O(1) ON PURPOSE. The first version re-scanned all 1,202 rows reading
      // innerText on every mutation; innerText forces layout, so the sabotage
      // cost more than the render and blew the check's deadline — which is a
      // fact about the sabotage, not about the sort. With nulls sorting last,
      // the final row IS a missing one, so moving it to the front is both
      // cheap and exactly the failure under test.
      // And DISCONNECTED WHILE IT WRITES: prepend() is itself a childList
      // mutation, so an observer that stays connected re-triggers its own
      // hoist for ever. disconnect() also clears the pending record queue,
      // which is what makes the reconnect safe.
      const tbody = document.querySelector('[data-score-table] tbody');
      const hoist = () => {
        const last = tbody.rows[tbody.rows.length - 1];
        if (last && last !== tbody.rows[0]) tbody.prepend(last);
      };
      const observer = new MutationObserver(() => {
        observer.disconnect();
        hoist();
        observer.observe(tbody, { childList: true });
      });
      hoist();
      observer.observe(tbody, { childList: true });
    })()`),
    restore: restoreByReload,
  }, ctx);

  await suite.check({
    id: 28,
    what: 'sorting does not destroy the header button — focus survives and the node stays attached',
    run: async (c) => {
      const result = await c.page.evaluate(async () => {
        const button = document.querySelector('[data-score-table] [data-sort]');
        const label = button.dataset.sort;
        button.focus();
        const focusedBefore = document.activeElement === button;
        button.click();
        await window.__settle();
        const active = document.activeElement;
        return {
          label,
          focusedBefore,
          stillAttached: button.isConnected,
          sameNodeFocused: active === button,
          activeIsSortButton: Boolean(active?.dataset?.sort),
          activeLabel: active?.dataset?.sort ?? active?.tagName ?? null,
        };
      });
      ok(result.focusedBefore, 'the header button must be focusable');
      ok(result.stillAttached, 'replacing thead.innerHTML detaches the button the reader is standing on',
        `the ${result.label} button was detached by its own click`);
      ok(result.sameNodeFocused, 'keyboard focus must survive a sort',
        `focus moved to ${result.activeLabel}`);
      return `${result.label}: node stayed attached and kept focus through its own click`;
    },
    sabotage: async (c) => {
      await c.page.evaluate(() => {
        const thead = document.querySelector('[data-score-table] thead');
        // Exactly the regression: rebuild the header wholesale on every sort.
        const button = thead.querySelector('[data-sort]');
        button.addEventListener('click', () => { thead.innerHTML = thead.innerHTML; }, { once: true });
      });
    },
    restore: restoreByReload,
  }, ctx);

  /* ── watchlist and drill ────────────────────────────────────────────────*/
  suite.section('Watchlist, drill and focus');

  await suite.check({
    id: 29,
    what: 'the watchlist star fills on the click itself, filters, and survives a reload',
    run: async (c) => {
      const key = await c.page.evaluate(async () => {
        const row = document.querySelector('[data-score-table] tbody tr');
        const isin = row.getAttribute('data-key');
        const star = row.querySelector('[data-row-action="watch"]');
        if (star.getAttribute('aria-pressed') === 'true') {
          star.click();
          await window.__until(() => star.getAttribute('aria-pressed') === 'false', 'the star clearing');
        }
        star.click();
        await window.__until(() => window.__sattva.state.isWatched(isin), 'the click reaching the store');
        return isin;
      });
      const immediate = await c.page.evaluate((isin) => {
        const row = document.querySelector(`[data-score-table] tbody tr[data-key="${isin}"]`);
        const star = row.querySelector('[data-row-action="watch"]');
        return {
          pressed: star.getAttribute('aria-pressed'),
          filled: star.querySelector('svg').getAttribute('fill') !== 'none',
          stored: window.__sattva.state.isWatched(isin),
        };
      }, key);
      equal(immediate.pressed, 'true', 'the star must report pressed on the click itself, without a refresh');
      equal(immediate.filled, true, 'the glyph must be filled, not merely labelled');
      equal(immediate.stored, true, 'the click must reach the store');

      const filtered = await c.page.evaluate(async () => {
        const select = document.querySelector('select[data-filter="watch"]');
        await window.__set(select, 'on');
        return { n: window.__sattva.rows().length, keys: window.__sattva.rows().map((r) => r.isin) };
      });
      equal(filtered.n, 1, 'the watchlist-only filter must show exactly the starred company');
      equal(filtered.keys[0], key, 'and it must be the one that was starred');

      await c.reload();
      const afterReload = await c.page.evaluate((isin) => {
        const row = document.querySelector(`[data-score-table] tbody tr[data-key="${isin}"]`);
        const star = row?.querySelector('[data-row-action="watch"]');
        return {
          stored: window.__sattva.state.isWatched(isin),
          pressed: star?.getAttribute('aria-pressed') ?? null,
          filled: star ? star.querySelector('svg').getAttribute('fill') !== 'none' : null,
        };
      }, key);
      equal(afterReload.stored, true, 'the watchlist must survive a reload');
      equal(afterReload.pressed, 'true', 'and the glyph must agree with what is stored');
      equal(afterReload.filled, true, 'a filled glyph, not just an aria attribute');

      // leave no state behind
      await c.page.evaluate((isin) => window.__sattva.state.toggleWatch?.(isin) ?? null, key);
      return `${key}: filled on click, filtered to 1 row, survived a reload with the glyph agreeing`;
    },
    sabotage: persistent(`(() => {
      // A star that reports its state only after a refresh — the regression.
      // Delegated and not once-only, because the check toggles twice and then
      // reloads, and a one-shot listener is spent before a single assertion.
      const unpress = () => {
        for (const s of document.querySelectorAll('[data-row-action="watch"]')) s.setAttribute('aria-pressed', 'false');
      };
      document.addEventListener('click', () => setTimeout(unpress, 20), true);
      new MutationObserver(unpress).observe(document.body, { childList: true, subtree: true });
    })()`),
    restore: restoreByReload,
  }, ctx);

  await suite.check({
    id: 30,
    what: 'a drill opens from a row and ?company=<ISIN> survives a real page.reload()',
    run: async (c) => {
      await c.page.click('[data-score-table] tbody tr td:nth-child(2)');
      await c.page.waitForSelector('[data-drill-body]', { timeout: 5000 });
      const opened = await c.page.evaluate(() => ({
        hash: location.hash,
        title: document.querySelector('[data-panel] h2')?.textContent?.trim() ?? null,
      }));
      const match = opened.hash.match(/company=([A-Z0-9]+)/);
      ok(match, 'opening a drill must mirror the company into the URL', `hash reads ${opened.hash}`);

      // A REAL document reload. Navigating to a hash-only difference is a
      // same-document navigation and proves nothing about a cold arrival.
      await c.reload();
      const after = await c.page.evaluate(() => ({
        hash: location.hash,
        open: Boolean(document.querySelector('[data-drill-body]')),
        title: document.querySelector('[data-panel] h2')?.textContent?.trim() ?? null,
      }));
      ok(after.open, 'the drill must reopen after a real reload', `hash ${after.hash}`);
      equal(after.title, opened.title, 'and it must be the same company');
      ok(after.hash.includes(`company=${match[1]}`),
        'the URL must still name the open company — a panel above an address bar that no longer names it cannot be shared',
        `hash reads ${after.hash}`);
      await c.page.keyboard.press('Escape');
      return `${opened.title} — ${match[1]} survived a document reload with the URL intact`;
    },
    sabotage: async (c) => {
      await c.page.evaluate(() => {
        // The regression this check exists for: the superseded panel's onClose
        // clearing the URL for the panel that replaced it.
        const original = history.replaceState.bind(history);
        history.replaceState = (a, b, url) => original(a, b, String(url).replace(/&?company=[A-Z0-9]+/, ''));
      });
    },
    restore: restoreByReload,
  }, ctx);

  await suite.check({
    id: 31,
    what: 'the drill traps focus, ESC closes it, and focus returns to the row that opened it',
    run: async (c) => {
      const result = await c.page.evaluate(async () => {
        const row = document.querySelectorAll('[data-score-table] tbody tr')[2];
        const key = row.getAttribute('data-key');
        row.focus();
        row.click();
        await window.__until(() => document.querySelector('[data-panel]'), 'the drill opening');
        const panel = document.querySelector('[data-panel]');
        return {
          key,
          open: Boolean(panel),
          focusInside: Boolean(panel && panel.contains(document.activeElement)),
          focusables: panel ? panel.querySelectorAll('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])').length : 0,
        };
      });
      ok(result.open, 'the drill must open');
      ok(result.focusInside, 'focus must move into the panel on open');
      ok(result.focusables > 0, 'the panel must contain something focusable');

      // Tab around the trap and confirm focus never escapes.
      for (let i = 0; i < 8; i += 1) await c.page.keyboard.press('Tab');
      const stillInside = await c.page.evaluate(() =>
        Boolean(document.querySelector('[data-panel]')?.contains(document.activeElement)));
      ok(stillInside, 'Tab must not walk out of the panel');

      await c.page.keyboard.press('Escape');
      const closed = await c.page.evaluate((key) => ({
        open: Boolean(document.querySelector('[data-drill-body]')),
        restored: document.activeElement?.getAttribute?.('data-key') === key
          || Boolean(document.activeElement?.closest?.(`tr[data-key="${key}"]`)),
        active: document.activeElement?.tagName ?? null,
      }), result.key);
      ok(!closed.open, 'ESC must close the drill');
      ok(closed.restored, 'focus must return to the row that opened it', `focus landed on ${closed.active}`);
      return `focus trapped across 8 tabs, ESC closed, focus restored to ${result.key}`;
    },
    sabotage: persistent(`(() => {
      // Remove the trigger row while the panel is open: focus has nowhere to
      // go back to, which is the failure the restore assertion exists for.
      //
      // OBSERVER-DRIVEN, NOT TIMED. A setTimeout here raced the check's own
      // wait — once that wait became condition-based rather than a fixed 400 ms
      // it resolved first, the assertions read an unsabotaged page, and the
      // check reported CANNOT FAIL. A sabotage must land before the thing it
      // sabotages is observed, and the only way to guarantee that is to hang
      // it off the same event.
      const root = document.querySelector('#drill-root') ?? document.body;
      const observer = new MutationObserver(() => {
        if (!document.querySelector('[data-panel]')) return;
        const row = document.querySelectorAll('[data-score-table] tbody tr')[2];
        if (row) row.remove();
      });
      observer.observe(root, { childList: true, subtree: true });
    })()`),
    restore: restoreByReload,
  }, ctx);

  /* ── accessibility and layout ───────────────────────────────────────────*/
  suite.section('Accessibility and layout');

  await suite.check({
    id: 32,
    what: 'every table header carries scope="col"',
    run: async (c) => {
      const m = await c.page.evaluate(() => {
        const ths = [...document.querySelectorAll('[data-score-table] thead th')];
        return { total: ths.length, missing: ths.filter((th) => th.getAttribute('scope') !== 'col').map((th) => th.textContent.trim() || '(blank)') };
      });
      ok(m.total > 5, 'the table must have headers to check', `${m.total} th elements`);
      empty(m.missing, 'a header without scope="col" is unannounced to a screen reader', (h) => h);
      return `${m.total} headers, all scope="col"`;
    },
    sabotage: async (c) => {
      await c.page.evaluate(() => document.querySelector('[data-score-table] thead th').removeAttribute('scope'));
    },
    restore: restoreByReload,
  }, ctx);

  await suite.check({
    id: 33,
    what: 'no sideways page scroll at 1440 / 1024 / 390 — wide content scrolls inside its own container',
    run: async (c) => {
      // LAYOUT IS A PROPERTY OF THE STYLESHEET, and the stylesheet comes from a
      // CDN by contract. Where it did not arrive, `overflow-auto` is inert, the
      // table spills out of its container and the body measures 1014 against a
      // 390 viewport — a reading about the network, not about the layout. With
      // Tailwind in force the same page measures 390/390. So this SKIPS rather
      // than reporting a failure it cannot attribute, or a pass it did not earn.
      const styled = await c.page.evaluate(() => {
        const probe = document.createElement('div');
        probe.className = 'overflow-auto';
        document.body.append(probe);
        const value = getComputedStyle(probe).overflowX;
        probe.remove();
        return value === 'auto';
      });
      if (!styled) skip('the Tailwind CDN did not load here, so no layout assertion can be attributed to the layout');

      const readings = [];
      for (const width of [1440, 1024, 390]) {
        await c.page.setViewportSize({ width, height: 900 });
        await c.page.waitForFunction(() => true);
        const m = await c.page.evaluate(() => {
          const scroller = document.querySelector('[data-table-scroll]');
          return {
            // MEASURE THE BODY, NOT THE DOCUMENT ELEMENT. index.html sets
            // `overflow-x: hidden` on html and body as a backstop, which pins
            // documentElement.scrollWidth to the viewport for ever — an
            // assertion on it can never fail, and --prove is how that was
            // found. body.scrollWidth still grows, so it sees content pushed
            // out of view. Clipped overflow is worse than a scrollbar, not
            // better: the content is simply unreachable.
            pageScroll: document.body.scrollWidth,
            pageClient: document.documentElement.clientWidth,
            clipped: getComputedStyle(document.body).overflowX === 'hidden',
            docScroll: document.documentElement.scrollWidth,
            tableScroll: scroller?.scrollWidth ?? null,
            tableClient: scroller?.clientWidth ?? null,
          };
        });
        readings.push({ width, ...m });
      }
      await c.page.setViewportSize({ width: 1440, height: 900 });
      const overflowing = readings.filter((r) => r.pageScroll > r.pageClient + 1);
      empty(overflowing, 'the page body must never scroll sideways', (r) => `${r.width}px: page ${r.pageScroll}/${r.pageClient}`);
      for (const r of readings) ok(r.tableScroll !== null, `the table scroller must exist at ${r.width}px`);
      return readings.map((r) => `${r.width}: body ${r.pageScroll}/${r.pageClient}, table ${r.tableScroll}/${r.tableClient}${r.tableScroll > r.tableClient ? ' (scrolls)' : ' (fits)'}`).join(' · ')
        + ` · overflow-x:hidden backstop ${readings[0].clipped ? 'in force' : 'absent'}`;
    },
    sabotage: persistent(`(() => {
      const wide = document.createElement('div');
      wide.id = 'sabotage-wide';
      wide.style.cssText = 'width:3000px;height:4px';
      document.body.append(wide);
    })()`),
    restore: restoreByReload,
  }, ctx);

  await suite.check({
    id: 42,
    what: 'the stat strip is ONE row on a wide screen, however many cards it carries',
    run: async (c) => {
      // Tailwind arrives from a CDN and its classes are scanned as whole
      // strings, so a column count built by interpolation compiles to nothing
      // and the strip silently wraps. This measures the RENDERED GEOMETRY —
      // the number of distinct top offsets among the cards — rather than
      // reading back the class name, which would only prove we wrote it.
      const styled = await c.page.evaluate(() => {
        const probe = document.createElement('div');
        probe.className = 'xl:grid-cols-4';
        document.body.append(probe);
        const value = getComputedStyle(probe).gridTemplateColumns;
        probe.remove();
        return value && value !== 'none';
      });
      if (!styled) skip('the Tailwind CDN did not load here, so no layout assertion can be attributed to the layout');

      // The suite's own viewport, restated rather than assumed: check 33 walks
      // down to 390px and a failure to put it back would make this a reading
      // about that check's last step.
      await c.page.setViewportSize({ width: 1440, height: 900 });
      await c.page.waitForFunction(() => Boolean(document.querySelector('[data-stat-strip]')));
      const m = await c.page.evaluate(() => {
        const strip = document.querySelector('[data-stat-strip]');
        const cards = [...strip.children];
        return {
          declared: Number(strip.dataset.statStrip),
          cards: cards.length,
          tops: [...new Set(cards.map((card) => Math.round(card.getBoundingClientRect().top)))],
          columns: getComputedStyle(strip).gridTemplateColumns.split(/\s+/).filter(Boolean).length,
        };
      });

      ok(m.cards >= 3, 'the strip must carry cards to measure', `${m.cards} cards`);
      equal(m.cards, m.declared, 'the strip must declare the card count it actually rendered');
      equal(m.columns, m.cards, `the grid must give every one of ${m.cards} cards its own column`);
      equal(m.tops.length, 1, `all ${m.cards} cards must share one row (found ${m.tops.length} rows at 1440px)`);
      return `${m.cards} cards, ${m.columns} columns, 1 row at 1440px`;
    },
    // BREAK IT THE WAY IT ACTUALLY BREAKS. The real failure is a column class
    // Tailwind never saw, which compiles to no CSS at all — so the grid falls
    // back to the `sm:grid-cols-2` rule and wraps. Swapping in another REAL
    // Tailwind class would instead be a bet on the CDN's JIT having generated
    // it in time, and a sabotage that races is a sabotage that can be survived.
    sabotage: persistent(`(() => {
      const fix = () => {
        for (const strip of document.querySelectorAll('[data-stat-strip]')) {
          const broken = strip.className.replace(/xl:grid-cols-[^\\s]+/, 'xl:grid-cols-sabotaged');
          if (strip.className !== broken) strip.className = broken;
        }
      };
      fix();
      new MutationObserver(fix).observe(document.body, { childList: true, subtree: true });
    })()`),
    restore: restoreByReload,
  }, ctx);

  await suite.check({
    id: 43,
    what: 'the relative column claims a direction only where the reading is robust, and every absence states its reason',
    run: async (c) => {
      // ⚠ THIS IS THE HONESTY TEST FOR THE DELTA COLUMN, AND IT IS ABOUT COLOUR.
      //
      // A green or red cell asserts a direction. The reading is struck on a
      // single published rebalance date, so the assertion under test is that
      // tone follows ROBUSTNESS — whether the sign survives shifting that
      // baseline a session either side — and never bare sign. A fragile reading
      // must render neutral however positive or negative it looks.
      const m = await c.page.evaluate(() => {
        const heads = [...document.querySelectorAll('thead th')].map((h) => h.textContent.trim());
        const index = heads.findIndex((h) => /vs index/.test(h));
        if (index < 0) return { index };
        const rows = [...document.querySelectorAll('tbody tr')];
        let toned = 0;
        let neutralUnstable = 0;
        let tonedUnstable = 0;
        let missingWithReason = 0;
        let missingWithout = 0;
        let readings = 0;
        for (const row of rows) {
          const cell = row.querySelectorAll('td')[index];
          if (!cell) continue;
          const text = cell.innerText.trim();
          // An em dash is an absence; it must carry a title saying WHICH kind.
          if (text.startsWith('\u2014')) {
            const titled = cell.querySelector('[title]') ?? (cell.getAttribute('title') ? cell : null);
            const title = titled?.getAttribute('title') ?? '';
            if (title.trim().length > 12) missingWithReason += 1; else missingWithout += 1;
            continue;
          }
          readings += 1;
          // The unstable marker the column renders next to a non-robust figure.
          const unstable = text.includes('\u00b1');
          const coloured = [...cell.querySelectorAll('span')]
            .some((sp) => /text-(emerald|rose)-700/.test(sp.className));
          if (coloured) toned += 1;
          if (unstable && coloured) tonedUnstable += 1;
          if (unstable && !coloured) neutralUnstable += 1;
        }
        return { index, rows: rows.length, readings, toned, tonedUnstable, neutralUnstable, missingWithReason, missingWithout };
      });

      ok(m.index >= 0, 'the "Δ vs index %" column is on the table', `column index ${m.index}`);
      ok(m.readings > 0, 'the column carries readings to judge', `${m.readings} readings rendered`);
      // The load-bearing one.
      equal(m.tonedUnstable, 0,
        'no reading whose sign fails the baseline-sensitivity test is rendered in a directional colour');
      ok(m.neutralUnstable > 0,
        'fragile readings actually exist here, or the check above passed vacuously',
        `${m.neutralUnstable} fragile readings rendered neutral`);
      ok(m.toned > 0, 'robust readings ARE coloured, so the tone means something', `${m.toned} coloured`);
      equal(m.missingWithout, 0, 'every em dash in this column carries a title saying which kind of absence it is');
      return `${m.readings} readings · ${m.toned} coloured (robust only) · ${m.neutralUnstable} neutral because the baseline day decides the sign`
        + ` · ${m.missingWithReason} absences, all with a stated reason`;
    },
    // Colour every reading by sign regardless of robustness — the change a
    // future author makes when the grey cells look "unfinished".
    sabotage: persistent(`(() => {
      const fix = () => {
        for (const cell of document.querySelectorAll('tbody td')) {
          if (!cell.innerText.includes('\u00b1')) continue;
          for (const sp of cell.querySelectorAll('span')) {
            if (/^[+-]/.test(sp.textContent.trim())) {
              sp.className = sp.className.replace(/text-slate-500/, sp.textContent.trim().startsWith('+') ? 'text-emerald-700' : 'text-rose-700');
            }
          }
        }
      };
      fix();
      new MutationObserver(fix).observe(document.body, { childList: true, subtree: true });
    })()`),
    restore: restoreByReload,
  }, ctx);

  await suite.check({
    id: 46,
    what: 'the three since-rebalance columns show both legs and a delta a reader cannot reconstruct by subtraction',
    run: async (c) => {
      // ⚠ THE POINT OF THREE COLUMNS IS THAT THE ARITHMETIC IS VISIBLE.
      //
      // The single column that stood here put both legs in a tooltip, so a
      // reader saw an answer and not the working — and could not tell a stock
      // that fell 2% against a flat index from one that rose 8% against an
      // index up 10%. Same delta, different events (2.1: a derived number must
      // be reconstructable from what is on screen).
      //
      // And the delta is GEOMETRIC. A reader who subtracts the two columns gets
      // a different number, which is why the cell states the formula. This check
      // asserts the rendered delta really is the geometric one — if it were the
      // subtraction, the three columns would be internally consistent and
      // silently wrong.
      const m = await c.page.evaluate(() => {
        const heads = [...document.querySelectorAll('thead th')].map((h) => h.textContent.trim());
        const ix = {
          index: heads.findIndex((h) => /Index return/.test(h)),
          stock: heads.findIndex((h) => /Stock return/.test(h)),
          delta: heads.findIndex((h) => /vs index/.test(h)),
        };
        if (ix.index < 0 || ix.stock < 0 || ix.delta < 0) return { ix, heads };
        const numberIn = (cell) => {
          const text = cell?.innerText?.trim() ?? '';
          if (!text || text.startsWith('\u2014')) return null;
          const match = text.match(/[+-]?\d+(?:\.\d+)?/);
          return match ? Number(match[0]) : null;
        };
        let compared = 0;
        let separable = 0;
        let geometric = 0;
        let wouldMatchSubtraction = 0;
        let benchmarkNamed = 0;
        const absencesWithoutReason = { index: 0, stock: 0, delta: 0 };
        let absences = 0;
        for (const row of document.querySelectorAll('tbody tr')) {
          const cells = row.querySelectorAll('td');
          for (const [name, at] of Object.entries(ix)) {
            const cell = cells[at];
            if (!cell) continue;
            if (cell.innerText.trim().startsWith('\u2014')) {
              if (name === 'delta') absences += 1;
              const titled = cell.querySelector('[title]') ?? (cell.getAttribute('title') ? cell : null);
              if ((titled?.getAttribute('title') ?? '').trim().length < 12) absencesWithoutReason[name] += 1;
            }
          }
          const i = numberIn(cells[ix.index]);
          const st = numberIn(cells[ix.stock]);
          const d = numberIn(cells[ix.delta]);
          if (i === null || st === null || d === null) continue;
          compared += 1;
          // The index cell carries its own benchmark, because it differs by row.
          if (/INDA|SMIN|EEM/.test(cells[ix.index].innerText)) benchmarkNamed += 1;
          const geo = (((1 + st / 100) / (1 + i / 100)) - 1) * 100;
          // ⚠ THE TOLERANCE IS DERIVED, NOT PICKED. All three cells render at
          // one decimal, so each carries up to 0.05 of rounding — and the
          // geometric formula AMPLIFIES the two inputs' errors by
          // 1/(1+i) and (1+s)/(1+i)^2. On a stock up 300% against an index up
          // 5% that second factor is ~3.6x, so a flat 0.06 pp allowance fails
          // 422 of 1,194 rows on correct arithmetic. A fixed tolerance here
          // would have been a threshold below its own measurement's precision —
          // the same error §2.12.2 names, wearing a test's face.
          const dStock = Math.abs(1 / (1 + i / 100));
          const dIndex = Math.abs((1 + st / 100) / ((1 + i / 100) ** 2));
          const tol = 0.05 * dStock + 0.05 * dIndex + 0.05 + 1e-9;
          if (Math.abs(geo - d) <= tol) geometric += 1;
          if (Math.abs((st - i) - d) <= tol) wouldMatchSubtraction += 1;
          // Could this row tell the two formulas apart AT THE RENDERED
          // PRECISION? The gap between them is about stock x index, so it
          // shrinks with the window; three sessions after a rebalance it is
          // smaller than the rounding these cells already carry.
          if (Math.abs(geo - (st - i)) > tol) separable += 1;
        }
        return { ix, compared, geometric, wouldMatchSubtraction, separable, benchmarkNamed, absences, absencesWithoutReason };
      });

      ok(m.ix.index >= 0 && m.ix.stock >= 0 && m.ix.delta >= 0,
        'all three columns are on the table', JSON.stringify(m.ix));
      ok(m.ix.index < m.ix.stock && m.ix.stock < m.ix.delta,
        'and in the order the arithmetic reads: index, stock, then the delta between them',
        JSON.stringify(m.ix));
      ok(m.compared > 20, 'enough rows carry all three to judge', `${m.compared} rows`);
      equal(m.geometric, m.compared, 'every rendered delta is (1 + stock) / (1 + index) - 1');
      /*
       * ⚠ WHETHER THE SUBTRACTION IS DISTINGUISHABLE HERE IS A FACT ABOUT THE
       * WINDOW, NOT ABOUT THE SCREEN.
       *
       * The two formulas differ by roughly stock x index, so the gap scales with
       * the PRODUCT of the two legs: across a quarter it is points wide
       * (WELCORP's +119.7% against SMIN's +4.5% reads 115.2 pp by subtraction
       * and 110.0% geometrically), and across the three sessions since a
       * rebalance it is hundredths of a point — smaller than the 0.05 rounding
       * each of these one-decimal cells already carries. Measured on the first
       * record baselined on the August 2026 review: 0 of 1,229 rows separable,
       * widest gap 0.078 pp against a tolerance around 0.15.
       *
       * Requiring the distinction to be visible was therefore a market condition
       * gating a build, and it would have gone red for weeks after every review.
       * The invariant above — every rendered delta IS the geometric relative of
       * the two legs beside it — holds at any window length and is asserted
       * unconditionally. The subtraction instance is asserted here only when the
       * window makes it observable, and is always asserted on the unrounded
       * stored values by verify-data 39, where 474 rows separate the two.
       */
      if (m.separable > 0) {
        ok(m.wouldMatchSubtraction < m.compared,
          'where the two formulas are separable at this precision, the rendered delta must not be the subtraction',
          `${m.wouldMatchSubtraction} of ${m.compared} rows would also match a plain subtraction, `
          + `though ${m.separable} are separable`);
      }
      equal(m.benchmarkNamed, m.compared,
        'every index cell names its own benchmark — it is INDA for one row and SMIN for the next, and a bare percentage would not say which');
      equal(JSON.stringify(m.absencesWithoutReason), JSON.stringify({ index: 0, stock: 0, delta: 0 }),
        'every em dash in all three columns carries a title saying which kind of absence it is');
      return `${m.compared} rows with all three legs · every delta geometric · `
        + (m.separable > 0
          ? `${m.compared - m.wouldMatchSubtraction} would read differently under subtraction`
          : 'subtraction indistinguishable at one decimal on this window — verify-data 39 carries it, '
            + 'on the unrounded values')
        + ` · ${m.absences} stated absences`;
    },
    // Render the delta as the difference of the two columns — the change a
    // future author makes when the three numbers "do not add up".
    // ⚠ IDEMPOTENT, AND IT HAS TO BE. The first writing of this sabotage
    // rewrote every delta cell on every MutationObserver callback — including
    // the callbacks its own writes produced — so it never settled, the page
    // spun, and the check reported SURVIVED after four minutes. A sabotage that
    // cannot come to rest proves nothing. The marker attribute is what makes the
    // second pass a no-op.
    sabotage: persistent(`(() => {
      const fix = () => {
        const heads = [...document.querySelectorAll('thead th')].map((h) => h.textContent.trim());
        const ii = heads.findIndex((h) => /Index return/.test(h));
        const si = heads.findIndex((h) => /Stock return/.test(h));
        const di = heads.findIndex((h) => /vs index/.test(h));
        if (ii < 0 || si < 0 || di < 0) return;
        const numberIn = (cell) => {
          const t = cell?.textContent?.trim() ?? '';
          if (!t || t.startsWith('\u2014')) return null;
          // Doubled backslashes, and they have to be. This body is a TEMPLATE
          // LITERAL: an untagged template literal EATS an unrecognised escape, so a
          // lone \\d arrives in the browser as a bare letter d. The regex then stops
          // matching digits, numberIn returns null for every cell, and the sabotage
          // mutates nothing while throwing nothing — --prove reported SURVIVED and
          // both the check and the sabotage read correctly on the page.
          const m = t.match(/[+-]?\\d+(?:\\.\\d+)?/);
          return m ? Number(m[0]) : null;
        };
        for (const row of document.querySelectorAll('tbody tr')) {
          const cells = row.querySelectorAll('td');
          const cell = cells[di];
          if (!cell || cell.dataset.sabotaged === '1') continue;
          const i = numberIn(cells[ii]); const s = numberIn(cells[si]);
          if (i === null || s === null) continue;
          const target = [...cell.querySelectorAll('span')]
            .find((sp) => /^[+-]/.test(sp.textContent.trim()));
          if (!target) continue;
          // ⚠ THE SUBTRACTION ALONE IS NOT ENOUGH TO PROVE THIS CHECK, and that
          // is a property of the window rather than of the sabotage. Three
          // sessions after a rebalance the geometric and arithmetic deltas agree
          // to within the rounding these one-decimal cells already carry, so a
          // rendered subtraction is INVISIBLE here and --prove would correctly
          // report that the check cannot fail. The offset is what keeps the
          // invariant this check now asserts — every rendered delta is the
          // geometric relative of the two legs beside it — falsifiable at any
          // window length. verify-data 39 catches the subtraction itself, on the
          // unrounded stored values, where the two are separable on 474 rows.
          const v = (s - i) + 1;
          const next = (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
          cell.dataset.sabotaged = '1';
          if (target.textContent !== next) target.textContent = next;
        }
      };
      fix();
      new MutationObserver(fix).observe(document.body, { childList: true, subtree: true });
    })()`),
    restore: restoreByReload,
  }, ctx);

  await suite.check({
    id: 45,
    what: 'switching the rebalance baseline moves all three columns and moves NO verdict',
    run: async (c) => {
      // ⚠ THE LOAD-BEARING ASSERTION OF THE WHOLE FEATURE, ON SCREEN.
      //
      // The reading is evidence beside a verdict and never an input to one
      // (2.12.1). verify-data proves that by sweeping the stored reading; this
      // proves it through the interface, which is where a future author would
      // actually wire the two together. A baseline switch is the sharpest
      // available test: it changes every number the reading produces at once.
      const read = () => {
        const heads = [...document.querySelectorAll('thead th')].map((h) => h.textContent.trim());
        const ix = {
          index: heads.findIndex((h) => /Index return/.test(h)),
          stock: heads.findIndex((h) => /Stock return/.test(h)),
          delta: heads.findIndex((h) => /vs index/.test(h)),
          verdict: heads.findIndex((h) => /^Verdict/.test(h)),
        };
        const rows = [...document.querySelectorAll('tbody tr')].slice(0, 60);
        return {
          baseline: document.querySelector('[data-baseline]')?.value ?? null,
          options: [...(document.querySelector('[data-baseline]')?.options ?? [])].map((o) => o.value),
          legs: rows.map((r) => ['index', 'stock', 'delta']
            .map((k) => r.querySelectorAll('td')[ix[k]]?.innerText.trim()).join('|')),
          // The verdict PILL text only — the flow chip beside it is expected to
          // move, and folding it in would make this assertion vacuous.
          verdicts: rows.map((r) => r.querySelectorAll('td')[ix.verdict]
            ?.querySelector('[data-verdict], span')?.textContent.trim() ?? ''),
          keys: rows.map((r) => r.dataset.key),
        };
      };

      const before = await c.page.evaluate(read);
      ok(before.options.length >= 2,
        'the baseline picker offers more than one rebalance date, or there is nothing to switch to',
        JSON.stringify(before.options));

      // The wait lives in `__setBaseline`, and why it is the strip rather than
      // the table is written out there. This check passed on a race once
      // already, and went red at "0 of 60 rows moved" the moment the timing
      // shifted — so the signal has to be one only the switch can produce.
      const other = before.options.find((o) => o !== before.baseline);
      await c.page.evaluate((value) => window.__setBaseline(value), other);
      const after = await c.page.evaluate(read);

      equal(after.baseline, other, 'the picker switched to the baseline asked for');
      equal(JSON.stringify(after.keys), JSON.stringify(before.keys),
        'the SAME rows are on screen — a baseline changes what is measured, never which companies are in view');

      let legsMoved = 0;
      let verdictsMoved = 0;
      for (let i = 0; i < before.keys.length; i += 1) {
        if (before.legs[i] !== after.legs[i]) legsMoved += 1;
        if (before.verdicts[i] !== after.verdicts[i]) verdictsMoved += 1;
      }
      ok(legsMoved > before.keys.length * 0.8,
        'nearly every row\'s three columns move — otherwise the picker is decoration',
        `${legsMoved} of ${before.keys.length} rows moved`);
      equal(verdictsMoved, 0,
        'and NOT ONE verdict moved — the reading is evidence beside a verdict, never an input to one');

      // Absences must stay stated under the new baseline too: a company not yet
      // listed on an older rebalance date is a different absence, not a blank.
      const blank = await c.page.evaluate(() => {
        const heads = [...document.querySelectorAll('thead th')].map((h) => h.textContent.trim());
        const di = heads.findIndex((h) => /vs index/.test(h));
        let bad = 0;
        let dashes = 0;
        for (const row of document.querySelectorAll('tbody tr')) {
          const cell = row.querySelectorAll('td')[di];
          const text = cell?.innerText.trim() ?? '';
          if (text === '') { bad += 1; continue; }
          if (!text.startsWith('\u2014')) continue;
          dashes += 1;
          const titled = cell.querySelector('[title]') ?? (cell.getAttribute('title') ? cell : null);
          if ((titled?.getAttribute('title') ?? '').trim().length < 12) bad += 1;
        }
        return { bad, dashes };
      });
      equal(blank.bad, 0, 'under the new baseline every absence is still an em dash with a stated reason');

      // Back to the default, so the rest of the suite sees the shipped state.
      await c.page.evaluate((value) => window.__setBaseline(value), before.baseline);

      return `${before.baseline} -> ${other}: ${legsMoved} of ${before.keys.length} rows re-measured, `
        + `0 verdicts moved, ${blank.dashes} absences still stated`;
    },
    // Wire the verdict to the reading — the change 2.12.1 forbids and the one a
    // future author is most likely to make when asked to "reflect it in the
    // verdict". The pill text follows the delta's sign under the new baseline.
    sabotage: persistent(`(() => {
      const fix = () => {
        const heads = [...document.querySelectorAll('thead th')].map((h) => h.textContent.trim());
        const di = heads.findIndex((h) => /vs index/.test(h));
        const vi = heads.findIndex((h) => /^Verdict/.test(h));
        if (di < 0 || vi < 0) return;
        for (const row of document.querySelectorAll('tbody tr')) {
          const cells = row.querySelectorAll('td');
          // Idempotent, like the one above. Without a marker every write queues
          // another MutationObserver callback that writes again, and the page never
          // settles: the same runaway that made check 46 take four minutes.
          if (!cells[vi] || cells[vi].dataset.sabotaged === '1') continue;
          const t = cells[di]?.innerText.trim() ?? '';
          const pill = cells[vi]?.querySelector('[data-verdict], span');
          if (!pill || !t || t.startsWith('\u2014')) continue;
          cells[vi].dataset.sabotaged = '1';
          pill.textContent = t.startsWith('-') ? 'Migration down' : 'Migration up';
        }
      };
      fix();
      new MutationObserver(fix).observe(document.body, { childList: true, subtree: true });
    })()`),
    // ⚠ `restoreByReload` IS NOT ENOUGH HERE, AND `--prove` IS HOW THAT SHOWED.
    //
    // The switch back to the default sits at the END of `run`, so a sabotaged
    // run — which is supposed to throw partway — never reaches it. The chosen
    // baseline is in localStorage, so it survives the reload too, and every
    // check after this one then measures a screen this one re-based. Check 51
    // found it: "0 up, 0 down" in the prove pass, with clean runs either side.
    //
    // A restore hook runs in the harness's `finally`, which is the only place
    // that sees the check however it ended.
    restore: async (c) => {
      c.sabotageHook = null;
      await c.page.evaluate(() => {
        try { localStorage.removeItem('sattva.v1.rebalanceBaseline'); } catch { /* storage unavailable */ }
      }).catch(() => {});
      await c.load();
    },
  }, ctx);

  await suite.check({
    id: 51,
    what: 'the flow chip is green up and red down, and its arrow agrees with the delta on its own row',
    run: async (c) => {
      // The chip's colour IS its direction, and it shares the emerald/rose ramp
      // with the delta column two cells away. Two different meanings on one pair
      // of colours in a single row is how a reader learns to distrust both — so
      // this asserts the mapping AND that the arrow agrees with the number it
      // claims to summarise.
      const m = await c.page.evaluate(() => {
        const heads = [...document.querySelectorAll('thead th')].map((h) => h.textContent.trim());
        const vi = heads.findIndex((h) => /^Verdict/.test(h));
        const di = heads.findIndex((h) => /vs index/.test(h));
        if (vi < 0 || di < 0) return { vi, di };
        const wrongColour = [];
        const wrongArrow = [];
        let up = 0;
        let down = 0;
        let rows = 0;
        for (const row of document.querySelectorAll('tbody tr')) {
          rows += 1;
          const cells = row.querySelectorAll('td');
          const chip = [...(cells[vi]?.querySelectorAll('span') ?? [])]
            .find((sp) => /^flow/.test(sp.textContent.trim()));
          if (!chip) continue;
          const isUp = chip.textContent.includes('\u2191');
          if (isUp) up += 1; else down += 1;
          const cls = chip.className;
          const green = /emerald/.test(cls);
          const red = /rose/.test(cls);
          if (isUp ? !green : !red) wrongColour.push(`${chip.textContent.trim()} :: ${cls}`);
          // And the arrow must agree with the delta on the same row.
          const delta = cells[di]?.innerText.trim() ?? '';
          if (delta && !delta.startsWith('\u2014')) {
            const negative = delta.startsWith('-');
            if (isUp === negative) wrongArrow.push(`${chip.textContent.trim()} beside ${delta}`);
          }
        }
        return { vi, di, rows, up, down, wrongColour, wrongArrow };
      });

      ok(m.vi >= 0 && m.di >= 0, 'the Verdict and delta columns are both locatable', JSON.stringify(m));

      /*
       * ⚠ HOW MANY CHIPS EXIST IS A FACT ABOUT THE MARKET, NOT ABOUT THE RAMP.
       *
       * This used to require more than five chips and at least one of each
       * direction. Both are properties of the data: a chip fires only on a
       * NOTABLE reading (§2.12.4), and how many readings are notable — and which
       * way they point — depends entirely on how far the window since the last
       * rebalance has run. Measured on the first record baselined on the August
       * 2026 review, three sessions in: 1 chip on the whole screen, pointing up.
       * The old assertion could not pass, and would have held the daily refresh
       * red for weeks after every quarterly review — the same failure mode as
       * verify-data 27 and 39.
       *
       * What is actually being tested is the MAPPING: an up chip is emerald, a
       * down chip is rose, and each agrees with its own row's delta. That is
       * asserted over every chip that exists, at any count, and a swapped ramp is
       * caught by a single chip. Both directions are asserted only when both are
       * on screen; when they are not, the untested half is reported rather than
       * assumed — and with no chips at all there is nothing to judge and the
       * check says so instead of passing on an empty set.
       */
      if (m.up + m.down === 0) {
        skip('no flow chip is on screen: no reading is notable against this baseline yet, so the '
          + 'colour ramp has nothing to be asserted over. It comes back as the window lengthens.');
      }
      empty(m.wrongColour, 'every up chip is emerald and every down chip is rose', (x) => x);
      empty(m.wrongArrow, 'every chip points the way its own row\'s delta does', (x) => x);
      const halves = m.up > 0 && m.down > 0
        ? 'both directions on screen'
        : `only ${m.up > 0 ? 'up' : 'down'} chips on screen — the ${m.up > 0 ? 'rose/down' : 'emerald/up'} half of the ramp is UNTESTED on this record`;
      return `${m.up + m.down} chips on ${m.rows} rows — ${m.up} emerald up, ${m.down} rose down, `
        + `each agreeing with its own delta · ${halves}`;
    },
    // Swap the ramp, which is the change that would make green mean losing.
    // Idempotent for the same reason as the sabotages above: a MutationObserver
    // that rewrites what it observes never settles.
    sabotage: persistent(`(() => {
      const fix = () => {
        for (const sp of document.querySelectorAll('tbody td span')) {
          if (!/^flow/.test(sp.textContent.trim())) continue;
          if (sp.dataset.sabotaged === '1') continue;
          sp.dataset.sabotaged = '1';
          sp.className = sp.className
            .replace(/emerald/g, '__TMP__').replace(/rose/g, 'emerald').replace(/__TMP__/g, 'rose');
        }
      };
      fix();
      new MutationObserver(fix).observe(document.body, { childList: true, subtree: true });
    })()`),
    restore: restoreByReload,
  }, ctx);

  await suite.check({
    id: 53,
    what: 'a rebalance the record cannot measure yet is named on screen — and is NOT named when there is none',
    run: async (c) => {
      // ⚠ ASSERTED AS A RULE, NOT AS A STATE. Whether a review is pending
      // depends on today's date against the newest committed close, so a check
      // that simply expected the chip would pass this week and fail after the
      // next refresh — and a check that expected its absence would do the
      // reverse. Both sides are asserted against the condition itself.
      const ctx = await c.page.evaluate(() => {
        const context = window.__sattva.data.rebalanceBaselines();
        const strip = document.querySelector('[data-baseline]')?.closest('div')?.parentElement;
        return {
          defaultReview: context?.defaultReview ?? null,
          latestDate: context?.latestDate ?? null,
          awaiting: (context?.awaitingSession ?? []).map((b) => b.review),
          active: document.querySelector('[data-baseline]')?.value ?? null,
          text: strip?.innerText ?? '',
          // The CHIP's own title, found by its own text — not the first title
          // in the strip, which belongs to the line as a whole and also says
          // "took effect".
          chipTitle: [...(strip?.querySelectorAll('span[title]') ?? [])]
            .find((n) => /not measurable yet/i.test(n.textContent))?.getAttribute('title') ?? '',
        };
      });
      ok(ctx.defaultReview, 'the record must name a default baseline');
      equal(ctx.active, ctx.defaultReview, 'this check reads the default view, not an override');

      // The calendar's own answer, computed here rather than read off the page.
      const newest = closedReviews(new Date().toISOString().slice(0, 10), 1)[0] ?? null;
      const shouldName = Boolean(newest && newest.review > ctx.defaultReview);
      const names = /not measurable yet/i.test(ctx.text);

      equal(names, shouldName, shouldName
        ? `the ${newest.label} review took effect on ${newest.effectiveDate} and the screen must say these columns cannot measure it yet`
        : 'no review has taken effect since the default baseline, so nothing may claim one has');

      if (shouldName) {
        ok(ctx.text.includes(newest.label), 'the chip must name the review', ctx.text.slice(0, 160));
        ok(/still measure from/i.test(ctx.chipTitle) && /assumed/i.test(ctx.chipTitle),
          'and must say what IS being measured from, and that the effective date is assumed',
          ctx.chipTitle.slice(0, 200));
        // The one thing it must never do is pretend to have the reading.
        ok(!ctx.awaiting.includes(ctx.defaultReview), 'the default may not itself be a baseline awaiting a session');
      }

      return shouldName
        ? `${newest.label} in effect ${newest.effectiveDate}, record measures from ${ctx.defaultReview} to ${ctx.latestDate} — said on screen`
        : `default ${ctx.defaultReview}, latest close ${ctx.latestDate}, no newer review in effect — and nothing claims one`;
    },
    sabotage: persistent(`(() => {
      // Flip whichever side is true: hide the chip where there is one, invent
      // one where there is not. Either way the screen stops agreeing with the
      // calendar, which is the only thing this check is about.
      const flip = () => {
        const select = document.querySelector('[data-baseline]');
        const strip = select?.closest('div')?.parentElement;
        if (!strip) return;
        const chip = [...strip.querySelectorAll('span')].find((n) => /not measurable yet/i.test(n.textContent));
        if (chip) { chip.remove(); return; }
        if (strip.dataset.sabotaged) return;
        strip.dataset.sabotaged = '1';
        const fake = document.createElement('span');
        fake.textContent = 'November 2099 rebalanced 30 Nov 2099 · not measurable yet';
        strip.append(fake);
      };
      flip();
      new MutationObserver(flip).observe(document.body, { childList: true, subtree: true });
    })()`),
    restore: restoreByReload,
  }, ctx);

  await suite.check({
    id: 52,
    what: 'a chosen baseline survives a reload WITH ITS NUMBERS — not a heading over a column of em dashes',
    run: async (c) => {
      // ⚠ THIS CHECK EXISTS BECAUSE THE BUG IT CATCHES SHIPPED IN THE SAME HOUR.
      //
      // The alternates live in their own file and are fetched on demand, and the
      // only caller was the picker's own change handler. The CHOICE is in
      // localStorage and survives a reload; the FILE is in nobody's memory and
      // does not. So a reader who re-based yesterday came back to the baseline
      // they picked named in the heading and 1,265 em dashes underneath, for
      // ever — the loading state, permanently true.
      //
      // Measured before the fix: 0 flow chips after a reload on the August 2025
      // baseline, against 15 up and 36 down before it.
      const context = await c.page.evaluate(() => {
        const select = document.querySelector('[data-baseline]');
        return { value: select?.value ?? null, options: [...(select?.options ?? [])].map((o) => o.value) };
      });
      ok(context.options.length >= 2, 'there is an alternate baseline to choose',
        JSON.stringify(context.options));
      const other = context.options.find((o) => o !== context.value);

      await c.page.evaluate((value) => window.__setBaseline(value), other);

      const readings = () => c.page.evaluate(() => {
        const heads = [...document.querySelectorAll('thead th')].map((h) => h.textContent.trim());
        const di = heads.findIndex((h) => /vs index/.test(h));
        let numbers = 0;
        let dashes = 0;
        let loading = 0;
        for (const row of document.querySelectorAll('tbody tr')) {
          const cell = row.querySelectorAll('td')[di];
          const text = cell?.innerText.trim() ?? '';
          if (!text) continue;
          if (text.startsWith('\u2014')) {
            dashes += 1;
            const titled = cell.querySelector('[title]') ?? (cell.getAttribute('title') ? cell : null);
            if (/still loading/i.test(titled?.getAttribute('title') ?? '')) loading += 1;
          } else numbers += 1;
        }
        return { baseline: document.querySelector('[data-baseline]')?.value ?? null, numbers, dashes, loading };
      });

      const before = await readings();
      equal(before.baseline, other, 'the picker switched to the alternate baseline');
      ok(before.numbers > 500, 'the alternate baseline carries readings before the reload',
        JSON.stringify(before));

      // A REAL document reload, which is what a reader does. The choice comes
      // back from localStorage; the file has to be fetched again.
      await c.reload();
      const after = await readings();

      equal(after.baseline, other, 'the chosen baseline survives a reload');
      equal(after.loading, 0,
        'and NOT ONE row is left saying "still loading" — that state must resolve, not persist');
      ok(after.numbers > 500,
        'the columns carry their numbers after the reload, not a heading over em dashes',
        JSON.stringify(after));
      // The absences that remain are the honest ones and must still say why.
      ok(Math.abs(after.numbers - before.numbers) <= 2,
        'the same rows carry readings before and after — a reload is not a re-measurement',
        `${before.numbers} before, ${after.numbers} after`);

      return `${other} survived a reload: ${after.numbers} readings, ${after.dashes} stated absences, `
        + '0 rows left loading';
    },
    // Leave the columns in the loading state the fix exists to resolve.
    sabotage: persistent(`(() => {
      const fix = () => {
        const heads = [...document.querySelectorAll('thead th')].map((h) => h.textContent.trim());
        const di = heads.findIndex((h) => /vs index/.test(h));
        if (di < 0) return;
        for (const row of document.querySelectorAll('tbody tr')) {
          const cell = row.querySelectorAll('td')[di];
          if (!cell || cell.dataset.sabotaged === '1') continue;
          cell.dataset.sabotaged = '1';
          cell.innerHTML = '<span class="text-slate-300" title="this baseline is still loading — not a fact about this company">\u2014</span>';
        }
      };
      fix();
      new MutationObserver(fix).observe(document.body, { childList: true, subtree: true });
    })()`),
    restore: async (c) => {
      c.sabotageHook = null;
      await c.page.evaluate(() => {
        try { localStorage.removeItem('sattva.v1.rebalanceBaseline'); } catch { /* storage unavailable */ }
      }).catch(() => {});
      await c.load();
    },
  }, ctx);

  await suite.check({
    id: 34,
    what: 'a full rebuild does not block the main thread past 400 ms',
    run: async (c) => {
      // A SCOPE switch until 26 Aug 2026 and a MODEL switch until 31 Aug. Both
      // controls are gone, so the check drives `build()` directly — the same
      // function both of them called, rebuilding every verdict, rule, flow and
      // relative reading for all 1,265 rows and re-rendering the table. The
      // budget is the one that was set for exactly this work.
      //
      // ⚠ IT IS NOT POINTED AT A BASELINE SWITCH, and the reason is a finding
      // rather than a convenience. That switch runs this same rebuild PLUS the
      // relative recompute against a freshly fetched file, and measured warm on
      // this record it blocks for 242, 424, 242 and 252 ms across four
      // switches — straddling the budget — and 884 ms once with the rest of the
      // suite running beside it. The 1.2 MB fetch is not the cost: parsing it
      // measures 8 ms. So a baseline switch does NOT fit in 400 ms, and the
      // honest thing is to say so here rather than raise the number until it
      // passes. Pointing the check at it would make the suite red on a loaded
      // machine for a reason it cannot attribute — a guard waived weekly is a
      // guard nobody reads (3.8.2).
      const worst = await c.page.evaluate(async () => {
        // Measure the longest gap between animation frames while the switch
        // runs. Wall-clock duration would count time the browser spent idle;
        // the frame gap is what a reader actually feels.
        let last = performance.now();
        let longest = 0;
        let running = true;
        const tick = () => {
          const now = performance.now();
          longest = Math.max(longest, now - last);
          last = now;
          if (running) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        // Not a table wait: this IS the measurement window. The check is about
        // how long a frame is blocked, so it deliberately observes for a fixed
        // span rather than stopping the moment the table settles.
        window.__sattva.view.rebuild();
        await new Promise((r) => setTimeout(r, 900));
        window.__sattva.view.rebuild();
        await new Promise((r) => setTimeout(r, 900));
        running = false;
        return longest;
      });
      await c.settle();
      ok(worst < 400, 'a rebuild must not freeze the interface', `longest frame gap ${worst.toFixed(0)} ms`);
      return `longest frame gap across two full rebuilds: ${worst.toFixed(0)} ms`;
    },
    sabotage: async (c) => {
      await c.page.evaluate(() => {
        const real = window.__sattva.view.rebuild;
        window.__sattva.view.rebuild = () => {
          const t = Date.now();
          while (Date.now() - t < 600) { /* block the main thread, which is the whole point */ }
          return real();
        };
      });
    },
    restore: restoreByReload,
  }, ctx);

  /* ── honesty on screen ──────────────────────────────────────────────────*/
  suite.section('Honesty on screen');

  await suite.check({
    id: 35,
    what: 'all three provenance tiers appear in the drill, and "modelled" is no longer empty',
    run: async (c) => {
      const m = await c.page.evaluate(async () => {
        const row = document.querySelector('[data-score-table] tbody tr');
        row.click();
        await window.__until(() => document.querySelector('[data-drill-body]')?.innerText, 'the drill opening');
        const body = document.querySelector('[data-drill-body]');
        const text = body?.innerText ?? '';
        const sections = [...(body?.querySelectorAll('h3') ?? [])].map((h) => h.textContent.trim());
        const modelled = /Modelled by us:\s*(.+)/.exec(text);
        return { text, sections, modelledTail: modelled ? modelled[1].trim() : null };
      });
      for (const tier of ['Measured, reproduced unchanged', 'Derived by us', 'Modelled by us']) {
        ok(m.text.includes(tier), `the "${tier}" tier must appear in the drill`);
      }
      ok(m.modelledTail && m.modelledTail.length > 20 && !/^nothing/i.test(m.modelledTail),
        'the modelled tier must name what is modelled, not say "nothing"',
        `modelled tier reads "${m.modelledTail}"`);
      ok(m.sections.indexOf('Assessment') < m.sections.indexOf('Free float'),
        'Assessment must sit above Free float', m.sections.join(' | '));
      await c.page.keyboard.press('Escape');
      return `${m.sections.length} sections, Assessment first; modelled tier: "${m.modelledTail.slice(0, 60)}…"`;
    },
    sabotage: persistent(`(() => {
      // A modelled tier that still says nothing — applied the moment the drill
      // body exists, for the same reason as 31: a timed sabotage loses the race
      // against a condition-based wait and proves nothing.
      const root = document.querySelector('#drill-root') ?? document.body;
      const observer = new MutationObserver(() => {
        const body = document.querySelector('[data-drill-body]');
        if (!body || !/Modelled by us:(?! nothing)/.test(body.innerHTML)) return;
        observer.disconnect();
        body.innerHTML = body.innerHTML.replace(/Modelled by us:/, 'Modelled by us: nothing');
        observer.observe(root, { childList: true, subtree: true });
      });
      observer.observe(root, { childList: true, subtree: true });
    })()`),
    restore: restoreByReload,
  }, ctx);

  await suite.check({
    id: 36,
    what: 'verdict pills use semantic colour only — the brand indigo never means "good"',
    run: async (c) => {
      // WHAT THIS CAN MEASURE DEPENDS ON WHETHER TAILWIND LOADED.
      // The stylesheet comes from a CDN by contract, and in an offline or
      // sandboxed run it does not arrive — every pill then computes to the same
      // inherited slate, and a pixel comparison would report "1 distinct
      // colour" for eight verdicts and prove nothing. So the CLASS CONTRACT is
      // always checked, and computed pixels are checked as well only when a
      // stylesheet is actually in force. The note says which ran.
      const m = await c.page.evaluate(async () => {
        const probe = document.createElement('div');
        probe.className = 'bg-emerald-50';
        document.body.append(probe);
        const tailwindLoaded = getComputedStyle(probe).backgroundColor !== 'rgba(0, 0, 0, 0)';
        probe.remove();

        const headings = [...document.querySelectorAll('[data-score-table] thead th')].map((th) => th.textContent.trim());
        const verdictIndex = headings.findIndex((h) => /^Verdict/i.test(h));
        const select = document.querySelector('select[data-filter="verdict"]');
        const verdicts = [...select.options]
          .filter((o) => o.value)
          .map((o) => ({ value: o.value, label: o.textContent.trim() }));
        const seen = [];
        for (const { value } of verdicts) {
          await window.__set(select, value);
          const pill = document.querySelector('[data-score-table] tbody tr')?.children[verdictIndex]?.querySelector('span');
          if (!pill) continue;
          const cs = getComputedStyle(pill);
          seen.push({
            verdict: value,
            label: pill.textContent.trim(),
            classes: pill.className,
            color: cs.color,
            background: cs.backgroundColor,
            ring: cs.borderColor,
          });
        }
        await window.__set(select, '');
        return { tailwindLoaded, verdictIndex, headings, verdicts, seen };
      });

      ok(m.verdictIndex >= 0, 'the Verdict column must be locatable by its heading', m.headings.join(' | '));
      // ⚠ A VERDICT WITH NO COMPANIES IS NOT A MISSING PILL.
      //
      // This used to require a pill for every option in the dropdown, which was
      // really an assertion about the record's composition: the day migration-up
      // fell to zero the colour check failed for a reason that had nothing to do
      // with colour. The option now says "none on this record" and the check
      // pairs each option with its own row count, so an empty verdict is proved
      // to be empty rather than assumed to be broken.
      const emptyByLabel = m.verdicts.filter((v) => /none on this record/.test(v.label)).map((v) => v.value);
      empty(m.seen.filter((p) => emptyByLabel.includes(p.verdict)),
        'a verdict the record does not carry produces no row, and the option says so', (p) => p.verdict);
      equal(m.seen.length, m.verdicts.length - emptyByLabel.length,
        'every verdict the record actually carries produces a pill');
      ok(m.seen.length >= 5, 'and enough distinct verdicts are on the record for a colour check to mean anything',
        `${m.seen.length} verdicts with rows, ${emptyByLabel.length} empty`);

      // (1) The class contract, always. Indigo is the brand ramp and carries no
      //     meaning — a verdict borrowing it would read as "good" for free.
      const indigoClassed = m.seen.filter((p) => /\b(bg|text|ring|border)-indigo-/.test(p.classes));
      empty(indigoClassed, 'a verdict is semantic; the brand colour must never stand in for one',
        (p) => `${p.verdict}: ${p.classes}`);

      const SEMANTIC = /\b(?:bg|text|ring|border)-(emerald|amber|rose|red|green|slate|sky|orange)-/;
      const unstyled = m.seen.filter((p) => !SEMANTIC.test(p.classes));
      empty(unstyled, 'every verdict pill must carry a semantic colour family', (p) => `${p.verdict}: ${p.classes}`);

      const families = new Set(m.seen.map((p) => (p.classes.match(/\btext-([a-z]+)-\d/) ?? [])[1]).filter(Boolean));
      ok(families.size >= 3,
        'verdicts must be visually distinguishable from one another',
        `only ${families.size} colour families across ${m.seen.length} verdicts: ${[...families].join(', ')}`);

      // (2) Computed pixels, only where a stylesheet is in force.
      if (m.tailwindLoaded) {
        const INDIGO = [
          /rgb\(238,\s*242,\s*255\)/, /rgb\(224,\s*231,\s*255\)/, /rgb\(199,\s*210,\s*254\)/,
          /rgb\(165,\s*180,\s*252\)/, /rgb\(129,\s*140,\s*248\)/, /rgb\(99,\s*102,\s*241\)/,
          /rgb\(79,\s*70,\s*229\)/, /rgb\(67,\s*56,\s*202\)/, /rgb\(55,\s*48,\s*163\)/,
        ];
        const rendered = m.seen.filter((p) => INDIGO.some((re) => re.test(p.color) || re.test(p.background) || re.test(p.ring)));
        empty(rendered, 'no verdict may RENDER in the brand indigo either', (p) => `${p.verdict} (${p.color} on ${p.background})`);
        const distinct = new Set(m.seen.map((p) => `${p.color}|${p.background}`));
        ok(distinct.size >= 3, 'verdicts must render in distinguishable tones', `${distinct.size} distinct computed tones`);
      }

      return `${m.seen.length} verdicts, ${families.size} colour families (${[...families].join(', ')}), 0 indigo — `
        + (m.tailwindLoaded
          ? 'computed pixels verified too'
          : 'CLASS CONTRACT ONLY: the Tailwind CDN did not load here, so every pill computes to the same inherited colour and pixels cannot be compared');
    },
    sabotage: async (c) => {
      await c.page.evaluate(() => {
        const headings = [...document.querySelectorAll('[data-score-table] thead th')].map((th) => th.textContent.trim());
        const i = headings.findIndex((h) => /^Verdict/i.test(h));
        // Repaint every verdict pill in the brand ramp, as a designer reaching
        // for "the nice blue" would.
        const paint = () => {
          for (const tr of document.querySelectorAll('[data-score-table] tbody tr')) {
            const pill = tr.children[i]?.querySelector('span');
            if (pill) pill.className = pill.className.replace(/(bg|text|ring)-\w+-(\d+)/g, '$1-indigo-$2');
          }
        };
        paint();
        new MutationObserver(paint).observe(document.querySelector('[data-score-table] tbody'), { childList: true, subtree: true });
      });
    },
    restore: restoreByReload,
  }, ctx);

  await suite.check({
    id: 37,
    what: 'the CSV round-trips, carries every banner line including the modelled-verdict line, and says when it is filtered',
    run: async (c) => {
      let csv = c.csvOverride;
      let filteredCsv = null;
      if (!csv) {
        const [download] = await Promise.all([
          c.page.waitForEvent('download', { timeout: 15000 }),
          c.page.click('[data-export]'),
        ]);
        csv = readFileSync(await download.path(), 'utf8');

        // And again with a filter applied, to prove the file says so.
        await c.page.evaluate(async () => {
          await window.__set(document.querySelector('select[data-filter="verdict"]'), 'likely-inclusion');
        });
        const [download2] = await Promise.all([
          c.page.waitForEvent('download', { timeout: 15000 }),
          c.page.click('[data-export]'),
        ]);
        filteredCsv = readFileSync(await download2.path(), 'utf8');
        await c.page.evaluate(async () => {
          await window.__set(document.querySelector('select[data-filter="verdict"]'), '');
        });
      }

      const BANNERS = [
        'Sattva Index Flows — company screener export',
        'VERDICTS ARE MODELLED BY US',
        'Weights belong to one fund only',
        'Free float is an exchange-published figure',
        'Prices name their exchange and their tier',
        'Weight drift requires no trade',
        'Relative performance is a MEASUREMENT beside the verdict',
        // The two windows must be told apart in the file itself. A sheet
        // carrying both families with only one of them naming its window is how
        // a reader sorts one column and reasons about the other.
        'There are TWO relative-performance families in this file',
        'Flow pressure is a direction, not a flow, and it forces no trade',
        'Rows in this file',
      ];
      const missing = BANNERS.filter((b) => !csv.includes(b));
      empty(missing, 'a workbook leaves the page without any of its chrome — row 1 carries the disclosure', (b) => b);

      // Round trip: every data row must parse back to the same field count.
      const rows = parseCsv(csv);
      // Locate the header by content. There is a blank spacer row after the
      // banner, so counting banner lines lands on the wrong row — the same
      // reason the workbook reader finds its header by looking for `Ticker`
      // rather than trusting row 7.
      const headerIndex = rows.findIndex((r) => r[0]?.replace(/^\ufeff/, '') === 'Name' && r.includes('ISIN'));
      ok(headerIndex > 0, 'the CSV must carry a locatable header row', `no row starting "Name" with an ISIN column in ${rows.length} rows`);
      const header = rows[headerIndex];
      const dataRows = rows.slice(headerIndex + 1).filter((r) => r.length > 1);
      ok(header.length > 30, 'the header row must carry every column', `${header.length} columns`);
      const ragged = dataRows.filter((r) => r.length !== header.length);
      empty(ragged, 'every exported row must parse back to the header width', (r) => `${r[0]}: ${r.length} fields`);

      const onScreen = await c.page.evaluate(() => window.__sattva.rows().length);
      equal(dataRows.length, onScreen, 'the export must contain exactly the rows on screen');

      if (filteredCsv) {
        const fRows = parseCsv(filteredCsv);
        const fHeader = fRows.findIndex((r) => r[0]?.replace(/^\ufeff/, '') === 'Name' && r.includes('ISIN'));
        const filteredRows = fRows.slice(fHeader + 1).filter((r) => r.length > 1);
        ok(filteredRows.length < dataRows.length, 'the filtered export must be smaller', `${filteredRows.length} vs ${dataRows.length}`);
        ok(/verdict/i.test(filteredCsv.slice(0, 4000)), 'a filtered export must say which filter produced it',
          'no filter named in the banner');
      }
      return `${dataRows.length} rows × ${header.length} columns round-tripped · ${BANNERS.length} banner lines${filteredCsv ? ' · filtered export names its filter' : ''}`;
    },
    sabotage: async (c) => {
      c.csvOverride = 'Sattva Index Flows — company screener export.,x\nISIN,Name\nINE1,Foo\n';
    },
    restore: async (c) => { c.csvOverride = null; await c.load(); },
  }, ctx);

  await suite.check({
    id: 38,
    what: 'with no freshness tile, the header pill still names the oldest input and the sources modal carries every feed\'s as-of date',
    run: async (c) => {
      // THE GUARANTEE IS THE DISCLOSURE, NOT THE TILE. The freshness hero card
      // was removed from the stat strip, so this reads the two surfaces that
      // actually carry the dates now: the header pill, which is always on
      // screen, and the sources modal a reader opens by clicking it. Reading
      // `document.body.innerText` would pass on either one alone and would not
      // notice if the modal stopped listing a feed.
      const m = await c.page.evaluate(async () => {
        const { shortDate } = await import('/js/core/format.js');
        const feeds = window.__sattva.data.freshness();
        const pill = document.querySelector('[data-status-slot]')?.innerText ?? '';

        // Open it the way a reader does — by clicking the pill, not by calling
        // the module. A modal that no longer opens from the pill is a broken
        // disclosure however well the module still renders.
        document.querySelector('[data-status-slot] button')?.click();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const body = document.querySelector('[data-modal-body]');
        const out = {
          labels: feeds.feeds.map((f) => f.label),
          dates: feeds.feeds.filter((f) => f.date).map((f) => ({ label: f.label, shown: shortDate(f.date) })),
          oldest: feeds.oldest?.label ?? null,
          pill,
          opened: Boolean(body),
          modal: body?.innerText ?? '',
        };

        // Put the page back the way it was found. `restore` only runs under
        // --prove, so a modal left open here would sit over every later check.
        const { closeModal } = await import('/js/ui/screener.js');
        closeModal();
        return out;
      });

      ok(m.labels.length >= 4, 'the record must carry several feeds', `${m.labels.length} feeds`);
      ok(m.oldest, 'an oldest feed must be identified');
      ok(/oldest/i.test(m.pill), 'the header pill must name the oldest input, not merely a status', m.pill.replace(/\n/g, ' · '));
      ok(m.pill.includes(m.oldest), 'the header pill must say WHICH feed is the oldest', `${m.oldest} not in "${m.pill.replace(/\n/g, ' · ')}"`);

      ok(m.opened, 'clicking the header pill must open the data-sources modal');
      const undated = m.dates.filter((d) => !m.modal.includes(d.shown));
      empty(undated, 'every dated feed must show its as-of date in the sources modal', (d) => `${d.label} (${d.shown})`);
      ok(m.modal.includes(m.oldest), 'the sources modal must name the oldest feed', m.oldest);
      ok(/oldest/i.test(m.modal), 'the modal must say which feed is the oldest, not merely list dates');

      return `pill names oldest "${m.oldest}" · modal shows ${m.dates.length} as-of dates and identifies the oldest`;
    },
    // A ONE-SHOT DOM WIPE CANNOT WORK HERE: the modal does not exist until
    // `run` clicks the pill, so anything blanked before that is re-rendered
    // into a clean modal and the check passes its own sabotage. The observer
    // keeps stripping the word as nodes arrive.
    sabotage: persistent(`(() => {
      const strip = (root) => {
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walk.nextNode())) if (/oldest/i.test(node.nodeValue)) node.nodeValue = '';
      };
      strip(document.body);
      new MutationObserver((records) => {
        for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) strip(n);
      }).observe(document.body, { childList: true, subtree: true });
    })()`),
    restore: restoreByReload,
  }, ctx);

  /* ── columns the reader controls ────────────────────────────────────────*/
  suite.section('Columns the reader controls');

  /**
   * Every check in this block leaves a stored layout behind, and a stored
   * layout is applied on every subsequent load. Clearing it is part of
   * restoring, not politeness — a width left set here would silently become the
   * starting condition of every check after it.
   */
  const clearColumnPrefs = async (c) => {
    await c.page.evaluate(() => {
      try { localStorage.removeItem('sattva.v1.columns.companies'); } catch { /* storage unavailable */ }
      window.__sattva?.view?.table()?.columns?.reset();
    });
  };
  const restoreColumns = async (c) => {
    c.sabotageHook = null;
    await c.load();
    await clearColumnPrefs(c);
    await c.load();
  };

  /** Column ids for a set of heading patterns — located by what the header
   *  says, never by position, so adding a column ahead of them cannot silently
   *  point a check at a different column. */
  const COLUMN_HEADINGS = ['Free float', 'Index return', 'Stock return', 'vs index', 'Funds'];

  await suite.check({
    id: 47,
    what: 'a squeezed column dissolves what it cuts — no cell ends in a clean, readable edge',
    run: async (c) => {
      // ⚠ THIS IS §2.20 AT THE LAYOUT LAYER, AND IT IS THE REASON THE FEATURE
      // NEEDED A CHECK AT ALL.
      //
      // Measured before the guard existed: with the Free float column dragged
      // to 70px, HDFC Bank's ₹10,99,757 Cr rendered as `10,99,75`. Not blank,
      // not an em dash — a clean, plausible, ten-times-wrong number on the
      // largest bank in the country, with nothing on screen to say it had been
      // cut. A formatter that rounds a real value to nothing is forbidden; a
      // column width that truncates one into a different value is the same
      // failure wearing a different hat.
      //
      // So the assertion is not "the reader can read it" — at 48px they cannot,
      // and that is their choice. It is that a cut value never LOOKS whole.
      await clearColumnPrefs(c);
      const m = await c.page.evaluate(() => {
        const table = window.__sattva.view.table();
        // Squeeze every resizable column to the floor, so the measurement is
        // over the whole table rather than the one column that happened to be
        // chosen.
        for (const column of table.columns.layout()) {
          if (column.resizable) table.columns.setWidth(column.label, 1); // clamped to MIN_COL_PX
        }
        const cells = [...document.querySelectorAll('[data-score-table] tbody td')];
        const clipped = [];
        const naked = [];
        for (const td of cells) {
          if (td.scrollWidth <= td.clientWidth) continue;
          clipped.push(td);
          const style = getComputedStyle(td);
          const mask = style.maskImage && style.maskImage !== 'none' ? style.maskImage : style.webkitMaskImage;
          const fades = Boolean(mask) && mask !== 'none' && /gradient/.test(mask);
          if (!fades || style.overflow !== 'hidden') {
            naked.push(`${td.dataset.col}:${td.innerText.trim().slice(0, 18)} overflow=${style.overflow} mask=${String(mask).slice(0, 24)}`);
          }
        }
        return {
          cells: cells.length,
          clipped: clipped.length,
          naked: naked.slice(0, 8),
          nakedCount: naked.length,
          declaredWidth: Number(
            /table\{table-layout:fixed;width:(\d+)px\}/.exec(document.querySelector('[data-col-style]')?.textContent ?? '')?.[1] ?? NaN,
          ),
          visible: [...document.querySelectorAll('[data-score-table] thead th')]
            .filter((th) => getComputedStyle(th).display !== 'none').length,
          layout: getComputedStyle(document.querySelector('[data-score-table] table')).tableLayout,
        };
      });

      // Non-vacuity first: a squeeze that clipped nothing would let every
      // assertion below pass without ever meeting the case they exist for.
      ok(m.clipped > 0, 'the squeeze must actually clip cells, or nothing below is being tested',
        `${m.clipped} of ${m.cells} cells overflow at the minimum width`);
      equal(m.layout, 'fixed', 'explicit widths only mean anything under a fixed table layout');
      // A fixed-layout table told to be 100% wide redistributes the slack, so
      // every width the reader set comes out as something else. The table has
      // to be the SUM of its columns for a width to mean what it says.
      //
      // Read off the RULE the table generates, not off the rendered box. Without
      // Tailwind the table falls back to `border-collapse: separate`, whose
      // border spacing is part of the rendered width and none of the code's
      // business — measured here as 574px for eleven 48px columns.
      equal(m.declaredWidth, m.visible * 48,
        `the table must declare the width its ${m.visible} columns add up to, not the container's`);
      equal(m.nakedCount, 0,
        `every clipped cell must fade at the edge it cuts — ${m.naked.join(' | ')}`);
      // Leave the table as it was found. `restore` only runs under --prove, so
      // a check that stored a squeezed layout would quietly become the starting
      // condition of every check after it in a normal run.
      await clearColumnPrefs(c);
      return `${m.clipped} of ${m.cells} cells clip at the 48px floor, and every one of them dissolves rather than ending in a readable edge`;
    },
    // THE CHANGE A FUTURE AUTHOR ACTUALLY MAKES: the fade looks like a
    // rendering artefact, so they delete it.
    //
    // Overridden with `!important` rather than edited out of the table's own
    // stylesheet, and that is not a stylistic choice. The check rewrites that
    // stylesheet several times, and a MutationObserver watching for the rewrite
    // fires on a microtask — AFTER the synchronous evaluate() that squeezes and
    // then reads has already finished. That sabotage was written first, was
    // survived, and reported CANNOT FAIL. A sabotage must land before the thing
    // it sabotages is observed, and a static override always has.
    sabotage: persistent(`(() => {
      let node = document.getElementById('sabotage-no-fade');
      if (!node) {
        node = document.createElement('style');
        node.id = 'sabotage-no-fade';
        node.textContent = '[data-score-table] tbody td{-webkit-mask-image:none!important;mask-image:none!important}';
        document.head.append(node);
      }
    })()`),
    restore: restoreColumns,
  }, ctx);

  await suite.check({
    id: 48,
    what: 'the figure columns stay in inline flow, which is what makes a squeezed cell ellipsise instead of cut',
    run: async (c) => {
      // The fade in check 47 is the backstop. The PRIMARY signal is the
      // ellipsis, and whether Chrome draws one depends on the shape of the
      // cell's content, which had to be measured rather than assumed:
      //
      //   plain text                    `12,34…`     ellipsis
      //   inline flow + chips           `10,9…`      ellipsis
      //   two or more chips             `SMIN …`     ellipsis
      //   ONE atomic inline box         `10,99,75`   NO ELLIPSIS
      //
      // An `inline-flex` wrapper around the whole cell is the last row, and it
      // is what these columns used to carry. Wrapping it in a plain <span> does
      // not rescue it; a trailing zero-width space does not either. Both were
      // tried. The only fix is not to have a lone atomic box.
      await clearColumnPrefs(c);
      const m = await c.page.evaluate((headings) => {
        const heads = [...document.querySelectorAll('[data-score-table] thead th')];
        const colOf = (needle) => heads.find((th) => th.textContent.includes(needle))?.dataset.col ?? null;
        const table = window.__sattva.view.table();
        const targets = headings.map(colOf).filter(Boolean);
        for (const column of table.columns.layout()) {
          if (column.resizable) table.columns.setWidth(column.label, 1);
        }
        // BOTH the computed display AND the class that would produce it.
        // Tailwind arrives from a CDN and does not always load in a sandboxed
        // run; where it has not, an `inline-flex` wrapper computes to plain
        // `inline` and a display-only test sees nothing wrong. That is exactly
        // how the first version of this check survived its own sabotage.
        const ATOMIC = /^(inline-flex|inline-block|inline-grid|inline-table|flex|grid|block|table)$/;
        const ATOMIC_CLASS = /(^|\s)(inline-flex|inline-block|inline-grid|inline-table|flex|grid|block|table)(\s|$)/;
        const offenders = [];
        let inspected = 0;
        let clipped = 0;
        let ellipsised = 0;
        for (const col of targets) {
          for (const td of document.querySelectorAll(`[data-score-table] tbody td[data-col="${col}"]`)) {
            inspected += 1;
            const style = getComputedStyle(td);
            if (td.scrollWidth > td.clientWidth) clipped += 1;
            if (style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap') ellipsised += 1;
            // The failing shape: the cell's whole content is one atomic box.
            const elements = [...td.children];
            const ownText = [...td.childNodes]
              .filter((n) => n.nodeType === 3 && n.textContent.trim())
              .length;
            if (
              elements.length === 1 && ownText === 0
              && (ATOMIC.test(getComputedStyle(elements[0]).display) || ATOMIC_CLASS.test(elements[0].className))
            ) {
              offenders.push(`${col}: <${elements[0].tagName.toLowerCase()} class="${elements[0].className}"> is the cell's only content`);
            }
          }
        }
        return { targets, inspected, clipped, ellipsised, offenders: offenders.slice(0, 6), offenderCount: offenders.length };
      }, COLUMN_HEADINGS);

      equal(m.targets.length, COLUMN_HEADINGS.length, 'every figure column must be locatable by its heading');
      ok(m.clipped > 0, 'the squeeze must clip these columns, or the shape below is untested', `${m.clipped} clipped`);
      equal(m.ellipsised, m.inspected, 'every cell in these columns must be able to show an ellipsis');
      equal(m.offenderCount, 0,
        `a cell whose entire content is one atomic inline box is cut with no ellipsis — ${m.offenders.join(' | ')}`);
      await clearColumnPrefs(c);
      return `${m.inspected} cells across ${COLUMN_HEADINGS.length} figure columns · ${m.clipped} clipped at the floor · 0 wrapped in a lone atomic box`;
    },
    // Put the `inline-flex` wrapper back — precisely the markup these three
    // columns carried before, and the tidiest-looking way to align a number
    // with its chips.
    sabotage: persistent(`(() => {
      const heads = () => [...document.querySelectorAll('[data-score-table] thead th')];
      const wrap = () => {
        const target = heads().find((h) => h.textContent.includes('Free float'))?.dataset.col;
        if (!target) return;
        for (const td of document.querySelectorAll('[data-score-table] tbody td[data-col="' + target + '"]')) {
          if (td.dataset.sabotaged) continue;
          td.dataset.sabotaged = '1';
          const box = document.createElement('span');
          box.className = 'inline-flex items-center justify-end gap-1';
          while (td.firstChild) box.append(td.firstChild);
          td.append(box);
        }
      };
      wrap();
      new MutationObserver(wrap).observe(document.body, { childList: true, subtree: true });
    })()`),
    restore: restoreColumns,
  }, ctx);

  await suite.check({
    id: 49,
    what: 'a hidden column is disclosed by count and by name, a sort on one says so, and the export keeps every field',
    run: async (c) => {
      // A screen showing nine of eleven columns looks exactly like a screen
      // that has nine. And a sort running on a column that is no longer there
      // puts the rows in an order whose basis is off-screen — which reads as no
      // order at all, on the one table where the order IS the finding.
      await clearColumnPrefs(c);
      const before = await c.page.evaluate(() => window.__sattva.rows().length);

      const m = await c.page.evaluate(() => {
        const table = window.__sattva.view.table();
        const sortKey = table.view.sort?.key;
        table.columns.setHidden('Day %', true);
        table.columns.setHidden('EM SC wt %', true);
        // …and put away the column the table is sorted BY.
        if (sortKey) table.columns.setHidden(sortKey, true);
        const section = document.querySelector('[data-score-table]');
        const heads = [...section.querySelectorAll('thead th')];
        return {
          sortKey,
          hidden: table.columns.hidden(),
          count: section.querySelector('[data-columns-count]')?.textContent.trim() ?? '',
          note: section.querySelector('[data-columns-note]')?.textContent ?? '',
          noteVisible: section.querySelector('[data-columns-note]')?.hidden === false,
          // Cell/heading counts must NOT change: a hidden column is collapsed
          // by CSS and stays in the tree, so every index-addressed assertion in
          // this suite keeps addressing the column it means.
          heads: heads.length,
          total: table.columns.layout().length,
          collapsed: heads.filter((th) => getComputedStyle(th).display === 'none').length,
          firstRowCells: section.querySelectorAll('tbody tr:first-child td').length,
          rows: window.__sattva.rows().length,
        };
      });

      equal(m.hidden.length, 3, 'three columns must actually be hidden for this to test anything');
      equal(m.collapsed, 3, 'a hidden column must be collapsed on screen');
      equal(m.firstRowCells, m.heads, 'a hidden column stays in the tree, so headings and cells stay aligned');
      equal(m.rows, before, 'hiding a column must not change which rows are on screen');
      // DERIVED, NEVER TYPED. A literal "8 of 11" here would go stale the day a
      // column is added — which is exactly what happened to this check between
      // one rebase and the next.
      equal(m.count, `${m.total - 3} of ${m.total}`,
        'the control must say how many of how many columns are shown');
      for (const label of m.hidden) {
        ok(m.note.includes(label), 'the note must NAME every hidden column, not just count them', `"${m.note.slice(0, 120)}"`);
      }
      ok(m.noteVisible, 'the note must be on screen, not merely present in the markup');
      ok(/sorted by/i.test(m.note) && m.note.includes(m.sortKey),
        'a sort whose column is hidden must say so in words', `"${m.note.slice(0, 200)}"`);

      // "Hiding changes this screen only" is a claim about the export, so it is
      // tested against the export rather than repeated.
      const [download] = await Promise.all([
        c.page.waitForEvent('download', { timeout: 15000 }),
        c.page.click('[data-export]'),
      ]);
      const csv = c.csvOverride ?? readFileSync(await download.path(), 'utf8');
      const parsed = parseCsv(csv);
      const headerIndex = parsed.findIndex((r) => r[0]?.replace(/^﻿/, '') === 'Name' && r.includes('ISIN'));
      ok(headerIndex > 0, 'the export must still carry a locatable header row');
      const header = parsed[headerIndex];
      ok(header.length > 30, 'a column hidden on screen must still be in the workbook', `${header.length} columns exported`);
      for (const label of ['Day change %', 'Free float (INR Cr)']) {
        ok(header.some((h) => h === label), `"${label}" must survive being hidden on screen`, header.join('|').slice(0, 200));
      }
      await clearColumnPrefs(c);
      return `3 of ${m.total} columns hidden and all three named on screen · the sort says its column is away · ${header.length} columns still exported`;
    },
    // Silence the note — the change made when the amber line "looks noisy".
    //
    // The writes are swallowed at the element rather than undone after the
    // fact, for the same reason as check 47: the check hides its columns and
    // reads the note inside one synchronous evaluate(), and an observer-driven
    // sabotage does not run until that evaluate() is over. It was written that
    // way first and reported CANNOT FAIL.
    sabotage: persistent(`(() => {
      for (const note of document.querySelectorAll('[data-columns-note]')) {
        if (note.dataset.sabotaged) continue;
        note.dataset.sabotaged = '1';
        Object.defineProperty(note, 'textContent', { get: () => '', set: () => {}, configurable: true });
        Object.defineProperty(note, 'hidden', { get: () => true, set: () => {}, configurable: true });
      }
    })()`),
    restore: restoreColumns,
  }, ctx);

  await suite.check({
    id: 50,
    what: 'widths and hidden columns survive a real reload, and Reset gives back the layout the table ships with',
    run: async (c) => {
      // A layout the reader has to rebuild every morning is not a layout. And a
      // layout with no way back is a trap: Reset has to return the automatic
      // widths the table shipped with, not merely a different set of numbers.
      await clearColumnPrefs(c);
      const shipped = await c.page.evaluate(() => ({
        mode: document.querySelector('[data-score-table]').dataset.colLayout,
        hidden: window.__sattva.view.table().columns.hidden().length,
      }));
      equal(shipped.mode, 'auto', 'a reader who never touches the controls must get automatic layout');
      equal(shipped.hidden, 0, 'and every column');

      await c.page.evaluate(() => {
        const table = window.__sattva.view.table();
        // HIDE FIRST, THEN SET THE WIDTH. Putting a column away re-shares the
        // freed width across the rest (check 53), so a width set before the
        // hide is legitimately a different number afterwards — and this check
        // is about persistence, not about that. Doing it in this order leaves
        // exactly one thing under test.
        table.columns.setHidden('Float %', true);
        table.columns.setWidth('Full mcap (₹ Cr)', 210);
      });
      await c.reload();
      const after = await c.page.evaluate(() => {
        const table = window.__sattva.view.table();
        // FIND THE COLUMN BY ITS HEADING, NEVER BY POSITION. A hard-coded
        // `data-col="c5"` was right until a release added three columns ahead
        // of it, and then this check read a different column's width and
        // reported a persistence failure that was its own. The code under test
        // keys widths by label for exactly this reason; the check must too.
        const heads = [...document.querySelectorAll('[data-score-table] thead th')];
        const th = heads.find((h) => h.textContent.includes('Full mcap'));
        // Is Tailwind actually here? Without it the table falls back to
        // `border-collapse: separate` with 2px of border spacing, so a cell's
        // rendered box is its column width plus the spacing — a reading about
        // the CDN, not about persistence. Same reasoning as checks 33 and 42.
        const probe = document.createElement('table');
        probe.className = 'border-collapse';
        document.body.append(probe);
        const styled = getComputedStyle(probe).borderCollapse === 'collapse';
        probe.remove();
        return {
          styled,
          width: table.columns.widths()['Full mcap (₹ Cr)'] ?? null,
          hidden: table.columns.hidden(),
          mode: document.querySelector('[data-score-table]').dataset.colLayout,
          // Read what reached the DOM too, not just the stored number — a width
          // that persists into a variable but not onto the screen is not
          // persistence.
          declared: th?.style.width ?? '',
          rendered: Math.round(th?.getBoundingClientRect().width ?? 0),
          collapsedOnScreen: [...document.querySelectorAll('[data-score-table] thead th')]
            .filter((el) => getComputedStyle(el).display === 'none').length,
        };
      });
      equal(after.width, 210, 'the width a reader set must come back after a reload');
      equal(after.mode, 'fixed', 'and the table must still be under explicit widths');
      equal(after.hidden.join(','), 'Float %', 'the hidden column must come back hidden');
      equal(after.collapsedOnScreen, 1, 'and it must be collapsed on screen, not merely recorded');
      equal(after.declared, '210px', 'the stored width must reach the header cell that sizes the column');
      if (after.styled) equal(after.rendered, 210, 'and must be the width actually rendered');

      await c.page.evaluate(() => window.__sattva.view.table().columns.reset());
      await c.reload();
      const reset = await c.page.evaluate(() => ({
        mode: document.querySelector('[data-score-table]').dataset.colLayout,
        widths: Object.keys(window.__sattva.view.table().columns.widths()).length,
        hidden: window.__sattva.view.table().columns.hidden().length,
      }));
      equal(reset.mode, 'auto', 'Reset must give back automatic layout, not a different set of fixed widths');
      equal(reset.widths, 0, 'and no stored widths at all');
      equal(reset.hidden, 0, 'and every column back');
      return `a 210px width and one hidden column survived a document reload; Reset restored automatic layout`
        + (after.styled
          ? ` · the column measured ${after.rendered}px on screen`
          : ' · rendered width NOT compared: the Tailwind CDN did not load here, so the table falls back to '
            + `border-spacing and measures ${after.rendered}px for a 210px column`);
    },
    // Drop the writes. The failure this catches is the one nobody notices
    // locally, because the layout is right until the tab is closed.
    sabotage: persistent(`(() => {
      const real = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (String(key).includes('columns.')) return undefined;
        return real.call(this, key, value);
      };
    })()`),
    restore: restoreColumns,
  }, ctx);

  await suite.check({
    id: 53,
    what: 'putting a column away gives its width to the others, and never leaves a band of empty screen',
    run: async (c) => {
      // The reader removes a column to give the others more room. Under fixed
      // layout the table is the SUM of its columns, so removing one simply
      // subtracted its width and left white space where it had been — measured
      // at 1,320px, hiding Funds left the table 1,206px and 114px of nothing.
      //
      // ⚠ THE FIX THAT LOOKS OBVIOUS IS THE ONE THIS MUST NOT BE. Telling a
      // fixed-layout table to be `width: 100%` closes the gap by handing the
      // slack to the browser — and then every width the reader set renders as
      // something else and dragging one column shifts its neighbours. So the
      // assertion is BOTH: no gap, AND the table still equal to the sum of its
      // own column widths.
      await clearColumnPrefs(c);
      const m = await c.page.evaluate(() => {
        const table = window.__sattva.view.table();
        const sec = document.querySelector('[data-score-table]');
        const scroller = sec.querySelector('[data-table-scroll]');
        // Is Tailwind here? Without it the table falls back to
        // `border-collapse: separate`, and its rendered box is the sum of its
        // columns PLUS the browser's border spacing — a reading about the CDN,
        // not about the layout. The SUM is the code's own contract and is
        // asserted either way. Same reasoning as checks 33, 42 and 50.
        const probe = document.createElement('table');
        probe.className = 'border-collapse';
        document.body.append(probe);
        const styled = getComputedStyle(probe).borderCollapse === 'collapse';
        probe.remove();
        const measure = () => {
          const widths = table.columns.widths();
          const shown = table.columns.layout().filter((col) => !table.columns.hidden().includes(col.label));
          return {
            rendered: Math.round(sec.querySelector('table').getBoundingClientRect().width),
            available: scroller.clientWidth,
            sum: shown.reduce((total, col) => total + (widths[col.label] ?? 0), 0),
            shown: shown.length,
          };
        };
        // Any width at all puts the table under explicit widths, which is the
        // only state where the gap can appear.
        table.columns.setWidth('Company', 250);
        const before = measure();
        const hiddenWidth = table.columns.widths()['Funds'] ?? 0;
        table.columns.setHidden('Funds', true);
        const afterHide = measure();
        table.columns.setHidden('Funds', false);
        const afterShow = measure();

        // And a table the reader has deliberately dragged WIDER than the screen
        // keeps its widths and keeps scrolling: closing a gap is one thing,
        // overruling a reader's stretch is another.
        table.columns.reset();
        table.columns.setWidth('Company', 900);
        table.columns.setWidth('Verdict', 400);
        const wide = measure();
        table.columns.setHidden('Funds', true);
        const wideAfterHide = measure();
        return { styled, before, afterHide, afterShow, hiddenWidth, wide, wideAfterHide };
      });

      ok(m.hiddenWidth > 0, 'the column being put away must have had a width, or there is no gap to close',
        `Funds was ${m.hiddenWidth}px`);
      ok(m.before.shown - m.afterHide.shown === 1, 'exactly one column must come off', `${m.before.shown} → ${m.afterHide.shown}`);

      // THE LOAD-BEARING PAIR, and it is a pair on purpose. The first says the
      // gap is closed; the second says it was closed by re-sharing the WIDTHS.
      // A table that filled the box without its columns adding up to the box is
      // `width: 100%` doing it, which unsettles every width the reader set.
      equal(m.afterHide.sum, m.afterHide.available,
        'with a column put away, the remaining widths must add up to the screen — no band of white, and no slack left to the browser');
      if (m.styled) {
        equal(m.afterHide.rendered, m.afterHide.available,
          'and the table must actually render that wide');
      }

      // Bringing it back is the same promise in the other direction.
      equal(m.afterShow.sum, m.afterShow.available, 'and a column coming back must not push the table off the screen');
      if (m.styled) equal(m.afterShow.rendered, m.afterShow.available, 'still, as rendered');

      // The reader's own stretch survives untouched.
      ok(m.wide.sum > m.wide.available, 'a deliberately stretched table must actually be wider than the screen',
        `${m.wide.sum} vs ${m.wide.available}`);
      ok(m.wideAfterHide.sum > m.wideAfterHide.available,
        'putting a column away must not shrink a table the reader stretched on purpose',
        `${m.wideAfterHide.sum} vs ${m.wideAfterHide.available}`);

      await clearColumnPrefs(c);
      return `${m.hiddenWidth}px of Funds re-shared: the columns went ${m.before.sum} → ${m.afterHide.sum} in a ${m.afterHide.available}px box`
        + ` and back to ${m.afterShow.sum} · a stretched ${m.wide.sum}px table stayed ${m.wideAfterHide.sum}px and kept scrolling`
        + (m.styled ? ' · rendered widths agree' : ' · rendered width NOT compared: no Tailwind here, so the table adds border spacing to the sum');
    },
    // Undo the re-share: put every width back exactly as it was before the
    // hide. That is the code with the refit deleted, which is the change a
    // future author makes when the arithmetic looks like a complication.
    // Static, not observed — the check hides and reads inside one evaluate.
    sabotage: persistent(`(() => {
      const columns = window.__sattva?.view?.table?.()?.columns;
      if (!columns || columns.__unshared) return;
      columns.__unshared = true;
      const real = columns.setHidden;
      columns.setHidden = (label, isHidden) => {
        const before = columns.widths();
        real(label, isHidden);
        for (const [key, px] of Object.entries(before)) columns.setWidth(key, px);
      };
    })()`),
    restore: restoreColumns,
  }, ctx);

  /* ── the rebalance scorecard ────────────────────────────────────────────*/
  suite.section('Scoring the last review');

  await suite.check({
    id: 54,
    what: 'the Latest Rebalance view shows what the forecast MISSED, and never a single blended accuracy',
    run: async (c) => {
      // ⚠ THIS IS THE HONESTY TEST FOR THE ONE SCREEN THAT MARKS ITS OWN
      // HOMEWORK, and it is about what the page is willing to show against
      // itself.
      //
      // 1,232 of 1,265 companies did not move, so a single "accuracy" figure
      // counting those true negatives reads above 97% for a model that never
      // fired at all. The page must therefore quote TWO figures, each with its
      // own denominator — of what we flagged, how many moved; of what moved,
      // how many we flagged — and it must list the movements it did not call.
      // A scorecard showing only its hits is an advertisement.
      await c.page.evaluate(() => { window.location.hash = '#/rebalance'; });
      await c.page.waitForFunction(() => Boolean(document.querySelector('[data-view="rebalance"] h1')), null, { timeout: 20000 });

      const m = await c.page.evaluate(async () => {
        const payload = await (await fetch('data/rebalance-2026-08.json', { cache: 'no-cache' })).json();
        const host = document.querySelector('[data-view="rebalance"]');
        const text = host.innerText;
        const CLAIMS = {
          'likely-inclusion': 'entered', 'possible-inclusion': 'entered',
          'likely-exclusion': 'exited', 'exclusion-risk': 'exited',
          'migration-up': 'migration-up', 'migration-down': 'migration-down', stable: 'no-change',
        };
        // Derived from the file, so the check cannot agree with the page by
        // both being wrong in the same way.
        const missed = payload.companies.filter((r) => r.inForecast && r.predictedVerdict !== 'unknown'
          && r.event !== 'no-change' && CLAIMS[r.predictedVerdict] !== r.event);
        return {
          hash: location.hash,
          screenerHidden: document.querySelector('[data-view="companies"]').hidden,
          navCurrent: document.querySelector('[data-view-link][aria-current="page"]')?.dataset.viewLink ?? null,
          text,
          // THE MISSES SECTION SPECIFICALLY, not the page as a whole. Every
          // missed company also appears in the entered/exited table it belongs
          // to, so asserting the names are "somewhere on the page" passes even
          // with the misses collected away — which is exactly what the first
          // version of this check did, and --prove caught it.
          missesSection: [...document.querySelectorAll('[data-view="rebalance"] section')]
            .find((el) => /did not call/i.test(el.querySelector('h2')?.textContent ?? ''))?.innerText ?? null,
          // Digit grouping is the formatter's business, not this check's. The
          // figures are matched against the text with separators removed, so a
          // change of locale cannot fail an assertion about honesty.
          plain: text.replace(/,/g, ''),
          missed: missed.map((r) => r.name),
          // Both denominators, exactly as the file states them.
          precision: `${payload.scorecard.precision.moved} of ${payload.scorecard.precision.flagged}`,
          recall: `${payload.scorecard.recall.flagged} of ${payload.scorecard.recall.moved}`,
          stable: `${payload.scorecard.stable.right} of ${payload.scorecard.stable.calls}`,
          effective: payload.effectiveDate,
          forecastHoldings: payload.forecast.holdingsAsOf,
          notReRead: payload.funds.notReRead.map((id) => payload.funds.names[id] ?? id),
        };
      });

      equal(m.hash, '#/rebalance', 'the view must be addressable, so it can be shared and reloaded');
      equal(m.navCurrent, 'rebalance', 'the nav must mark the view the reader is on');
      ok(m.screenerHidden, 'the screener must be put away rather than left stacked under the rebalance view');

      // The two figures, with their denominators, both on screen.
      ok(m.plain.includes(m.precision), 'the page must state how many of the companies it FLAGGED actually moved',
        `looked for "${m.precision}"`);
      ok(m.plain.includes(m.recall), 'and how many of the companies that MOVED it had flagged',
        `looked for "${m.recall}"`);

      // The no-change rate may be shown, but never without saying what it is.
      ok(m.plain.includes(m.stable), 'the no-change rate must be on screen', `looked for "${m.stable}"`);
      ok(/true-negative/i.test(m.text),
        'the no-change rate must be captioned as a true-negative rate — unqualified it reads as accuracy');

      // One review is one data point, and the page has to say so.
      ok(/one data point/i.test(m.text),
        'the page must say a single scored review is not a base rate, or it reads as a backtest');

      // Provenance of the scoring itself.
      ok(m.text.includes('17 Aug 2026') && m.text.includes('31 Aug 2026'),
        'the page must name the date the forecast was struck and the date the review took effect',
        `forecast ${m.forecastHoldings}, effective ${m.effective}`);
      for (const fund of m.notReRead) {
        ok(m.text.includes(fund),
          'a fund that was not re-read must be NAMED — "we did not look" and "nothing changed" are different facts',
          `looked for "${fund}"`);
      }

      // THE LOAD-BEARING ONE: every movement the forecast did not call is on
      // the page, by name.
      ok(m.missed.length > 0, 'there must be misses to show, or this check passes vacuously',
        `${m.missed.length} missed movements in the record`);
      ok(m.missesSection !== null,
        'the page must COLLECT what the forecast did not call into a section of its own — scattered '
        + 'among the hits, a miss is something a reader has to go looking for');
      const hidden = m.missed.filter((name) => !m.missesSection.includes(name));
      empty(hidden, 'every movement the forecast did not call must be named in that section', (n) => n);

      await c.page.evaluate(() => { window.location.hash = '#/companies'; });
      return `${m.missed.length} missed movements all named · flagged ${m.precision} moved · movers ${m.recall} flagged`
        + ` · no-change ${m.stable}, captioned as a true-negative rate`;
    },
    // Show only the hits. The change made when the misses look bad in a demo —
    // and the one that turns this page into marketing.
    sabotage: persistent(`(() => {
      const strip = () => {
        for (const section of document.querySelectorAll('[data-view="rebalance"] section')) {
          if (/did not call/i.test(section.textContent ?? '')) section.remove();
        }
      };
      strip();
      new MutationObserver(strip).observe(document.body, { childList: true, subtree: true });
    })()`),
    restore: restoreByReload,
  }, ctx);

  await suite.check({
    id: 55,
    what: 'the recalibrated model\'s own score is on the page and is labelled in-sample, beside the forecast it replaced',
    run: async (c) => {
      // ⚠ THIS IS THE ONE FIGURE ON THIS PAGE THAT IS NOT A RECORD.
      //
      // The scorecard above it is what was actually forecast. The retrospective
      // is what the CURRENT rules would have said about the review that
      // motivated them — a model answering a question it has already seen. It is
      // worth showing, because a change made for a reason has to show it
      // addresses the reason, and it is exactly the number a reader would take
      // for a track record if nothing said otherwise.
      //
      // So: both scores side by side, both denominators, and the in-sample
      // caveat in words on the page rather than only in the JSON.
      await c.page.evaluate(() => { window.location.hash = '#/rebalance'; });
      await c.page.waitForFunction(() => Boolean(document.querySelector('[data-view="rebalance"] h1')), null, { timeout: 20000 });

      const m = await c.page.evaluate(async () => {
        const payload = await (await fetch('data/rebalance-2026-08.json', { cache: 'no-cache' })).json();
        const host = document.querySelector('[data-view="rebalance"]');
        const section = [...host.querySelectorAll('section')]
          .find((el) => /would say now/i.test(el.querySelector('h2')?.textContent ?? '')) ?? null;
        const r = payload.retrospective;
        return {
          section: section?.innerText ?? null,
          plain: (section?.innerText ?? '').replace(/,/g, ''),
          pageplain: host.innerText.replace(/,/g, ''),
          flaggedNow: String(r.precision.flagged),
          rightNow: String(r.precision.rightEvent),
          flaggedWas: String(r.asForecast.flagged),
          rightWas: String(r.asForecast.rightEvent),
          moved: String(r.recall.moved),
          changes: r.changes,
          stillMissed: r.stillMissed.map((x) => x.name),
          inSample: r.inSample,
        };
      });

      ok(m.section !== null,
        'the retrospective must be a section of its own — folded into the scorecard it would read as the forecast\'s score');
      equal(m.inSample, true, 'the file must declare it in-sample, or the page is captioning a claim the data does not make');
      ok(/in-sample/i.test(m.section),
        'and the page must say IN-SAMPLE in words a reader sees, not only in the JSON');
      ok(/not a track record/i.test(m.section),
        'and say plainly that it is not a track record');

      // BOTH scores, both denominators, side by side (§2.5). A retrospective
      // shown alone is a claim; shown beside what was actually forecast it is a
      // comparison a reader can weigh.
      for (const [figure, what] of [
        [m.flaggedWas, 'how many the frozen forecast flagged'],
        [m.rightWas, 'how many of those it got right'],
        [m.flaggedNow, 'how many the current rules would flag'],
        [m.rightNow, 'how many of those they would get right'],
        [m.moved, 'the number that actually moved — the denominator for both recalls'],
      ]) {
        ok(m.plain.includes(figure), `the section must state ${what}`, `looked for "${figure}"`);
      }

      // What changed, and what it STILL would not have called.
      for (const change of m.changes) {
        const head = change.split(/[,(]/)[0].trim().slice(0, 24);
        ok(m.section.includes(head), 'every change the recalibration made is named on the page', head);
      }
      for (const name of m.stillMissed) {
        ok(m.section.includes(name),
          'a mover the NEW rules would still miss must be named too — a retrospective showing only its '
          + 'improvements is the same advertisement as a scorecard showing only its hits',
          name);
      }

      await c.page.evaluate(() => { window.location.hash = '#/companies'; });
      return `as forecast ${m.rightWas}/${m.flaggedWas} · retrospectively ${m.rightNow}/${m.flaggedNow} of ${m.moved} movers`
        + ` · ${m.stillMissed.length} still missed, all named · in-sample stated`;
    },
    /**
     * Strip the in-sample label — the change that turns a model marked on its
     * own answer sheet into a published accuracy figure.
     *
     * ⚠ IT SWALLOWS createTextNode, NOT textContent. The page builds this block
     * with `el()`, which appends TEXT NODES rather than assigning textContent,
     * so a textContent setter is never called and the sabotage was survived on
     * the first --prove run. And it is static rather than a MutationObserver
     * for the reason checks 47 and 49 record: the assertions read the DOM
     * synchronously inside one evaluate, which wins the race against a
     * microtask every time.
     */
    sabotage: persistent(`(() => {
      const scrub = (value) => String(value)
        .replace(/In-sample[^,.\u2014]*/gi, 'Verified')
        .replace(/not a track record/gi, 'a track record');
      // For anything rendered from here on.
      const make = document.createTextNode.bind(document);
      document.createTextNode = (value) => make(scrub(value));
      // ...AND for what is already on the page. The rebalance view is mounted
      // once and only toggled, so navigating back to it re-renders nothing —
      // patching the factory alone was survived on the first --prove run.
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const found = [];
      while (walker.nextNode()) found.push(walker.currentNode);
      for (const node of found) {
        const next = scrub(node.nodeValue);
        if (next !== node.nodeValue) node.nodeValue = next;
      }
    })()`),
    restore: restoreByReload,
  }, ctx);

  /* ── the live path ──────────────────────────────────────────────────────*/
  suite.section('The live path');

  await suite.check({
    id: 39,
    live: true,
    what: '/api/quotes resolves, x-siflows-cache reads live then hit, and a bad ticker lands in failed[]',
    run: async (c) => {
      if (!c.hasWorker) skip(`no Worker at ${c.base} — the static floor has no /api/quotes (run against \`npx wrangler dev\`)`);
      const result = await c.page.evaluate(async () => {
        const quotes = await import('/js/data/quotes.js');
        const eligible = quotes.eligibleSymbols();
        // A COLD CACHE KEY. The key is a hash of the symbol set, and the TTL is
        // 30 s, so a fixed slice would read "hit" on the first call of a re-run
        // and the cache assertion would test the previous run instead of this
        // one. Offsetting the slice guarantees a key nothing has seen.
        const offset = Math.floor(Math.random() * Math.max(1, eligible.length - 8));
        const symbols = eligible.slice(offset, offset + 6);
        const bogus = 'ZZQXNOTREAL';
        const first = await quotes.fetchQuotes([...symbols, bogus]);
        const second = await quotes.fetchQuotes([...symbols, bogus]);
        // THE CONTROL: the same real symbols with NO bogus one, on its own cold
        // key. Without it "one bad ticker must not take the others down" cannot
        // be told apart from "the upstream resolved little today" — and on
        // 28 Aug 2026 it was not, so a degraded upstream failed a check about
        // our own batching.
        const control = await quotes.fetchQuotes(symbols);
        return {
          symbols,
          control: { ok: control.ok, resolved: Object.keys(control.quotes ?? {}).length },
          first: {
            ok: first.ok,
            cache: first.cacheState,
            resolved: Object.keys(first.quotes ?? {}).length,
            quotes: first.quotes ?? {},
            failed: first.failed ?? [],
            reason: first.reason ?? null,
            detail: first.detail ?? null,
          },
          second: { ok: second.ok, cache: second.cacheState },
        };
      });

      const failedSymbols = result.first.failed.map((f) => (typeof f === 'string' ? f : f.symbol));

      // The cache behaves the same whether the upstream answered or not, so
      // these hold in both branches below.
      equal(result.first.cache, 'live', 'the first call on a cold key must miss the cache');
      equal(result.second.cache, 'hit', 'the second identical call must hit it');

      // NOTHING MAY EVER BE FABRICATED, in either branch.
      const fabricated = Object.entries(result.first.quotes).filter(([, q]) => !(q?.price > 0));
      empty(fabricated, 'a quote without a positive price must not appear at all', ([sym]) => sym);

      if (result.first.resolved > 0) {
        // ── The upstream answered. Every assertion runs.
        ok(result.first.ok, '/api/quotes must resolve', result.first.reason ?? 'not ok');
        ok(failedSymbols.includes('ZZQXNOTREAL'),
          'a ticker that cannot resolve must land in failed[], never be dropped or zeroed',
          `failed[] = ${JSON.stringify(result.first.failed)}`);
        // ⚠ MEASURED AGAINST THE CONTROL, NOT AGAINST A TARGET COUNT.
        //
        // This asserted `resolved >= symbols.length - 1`, which is a claim about
        // the UPSTREAM'S HEALTH wearing the label of a claim about our batching.
        // It failed on 28 Aug 2026 at 1 of 6 while the Worker was behaving
        // perfectly — the upstream was resolving roughly one symbol in eight
        // that afternoon. A check that cannot tell its own subject from the
        // weather is not a check.
        //
        // The poisoning failure mode is TOTAL: a chunk rejected because of one
        // bad symbol returns nothing at all. So the sharp, noise-tolerant test
        // is that the bogus symbol cannot take the batch from "some" to "none".
        if (result.control.resolved > 0) {
          ok(result.first.resolved > 0,
            'one bad ticker must not take the others down with it',
            `with the bogus symbol ${result.first.resolved} resolved, without it ${result.control.resolved} — `
            + 'a collapse to zero alongside a non-zero control is the poisoning this guards against');
        }
        return `live → hit · ${result.first.resolved} resolved with the bogus symbol, `
          + `${result.control.resolved} without it · ZZQXNOTREAL in failed[] alongside them`;
      }

      // ── The upstream is refusing everything. THIS IS THE DOCUMENTED TRAP:
      // under load fastapi.muns.io answers `not_found` for tickers it served
      // minutes earlier — RELIANCE included — and does not say "rate limited".
      // A degraded upstream is not a passing Worker and it is not a broken one
      // either, so the assertions become: does the Worker report the outage
      // HONESTLY? Anything less specific here would let a genuinely broken
      // Worker through on the excuse that the upstream might be down.
      ok(result.first.ok === false, 'a run that resolved nothing must not report ok', JSON.stringify(result.first).slice(0, 200));
      ok(result.first.reason, 'a failure must carry a named reason, not an empty one', JSON.stringify(result.first.reason));
      equal(Object.keys(result.first.quotes).length, 0, 'a failed batch must carry no quotes at all');
      const requested = [...result.symbols, 'ZZQXNOTREAL'];
      const unaccounted = requested.filter((sym) => !failedSymbols.includes(sym));
      empty(unaccounted, 'every requested symbol must be accounted for in failed[] — a dropped symbol is an absence reported as nothing',
        (sym) => sym);
      const reasonless = result.first.failed.filter((f) => !(typeof f === 'object' && f.reason));
      empty(reasonless, 'every failure must name its reason', (f) => JSON.stringify(f));
      return `UPSTREAM DEGRADED (${result.first.reason}: ${result.first.detail}) — the documented not_found-under-load trap. `
        + `live → hit still correct; all ${requested.length} symbols accounted for in failed[] with reasons; 0 quotes fabricated. `
        + 'Resolution assertions could not run against an upstream that is refusing everything.';
    },
    sabotage: async (c) => {
      c.errors.inducing = true;
      await c.page.route('**/api/quotes', (route) => route.abort());
    },
    restore: async (c) => {
      await c.page.unroute('**/api/quotes');
      c.errors.inducing = false;
      await c.load();
    },
  }, ctx);

  await suite.check({
    id: '39b',
    what: 'a tick repaints only the changed rows and preserves search, filter, sort and watchlist',
    run: async (c) => {
      const result = await c.page.evaluate(async () => {
        const quotes = await import('/js/data/quotes.js');
        const d = window.__sattva;

        // Set up a reader's working state: a search, a filter, a sort, a star.
        const search = document.querySelector('[data-search]');
        search.value = 'a';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await window.__settleSearch('a');
        const fundFilter = document.querySelector('select[data-filter="fund"]');
        await window.__set(fundFilter, [...fundFilter.options].find((o) => o.value !== '').value);
        document.querySelector('[data-score-table] [data-sort]').click();
        await window.__settle();
        const firstRow = document.querySelector('[data-score-table] tbody tr');
        const watchedKey = firstRow.getAttribute('data-key');
        const star = firstRow.querySelector('[data-row-action="watch"]');
        if (star.getAttribute('aria-pressed') !== 'true') star.click();
        await window.__until(() => window.__sattva.state.isWatched(watchedKey), 'the star reaching the store');

        const before = {
          q: search.value,
          filter: fundFilter.value,
          sort: document.querySelector('[data-score-table] thead th[aria-sort]:not([aria-sort="none"])')?.textContent.trim() ?? null,
          rows: window.__sattva.rows().length,
          keys: [...document.querySelectorAll('[data-score-table] tbody tr')].map((tr) => tr.getAttribute('data-key')),
        };
        // Stamp every row so a repaint is detectable node-by-node.
        for (const tr of document.querySelectorAll('[data-score-table] tbody tr')) tr.dataset.stamp = '1';

        // Move exactly two rows' prices.
        // A NUDGE, NOT A JUMP. A 5% move flips verdicts near a threshold, and a
        // flipped verdict legitimately repaints its row too — which would make
        // "only the changed rows" untestable by muddling two causes. 0.2% moves
        // the price and nothing else.
        const visible = window.__sattva.rows().filter((r) => r.nseSymbol && r.assessment?.verdict === 'stable').slice(0, 2);
        const payload = { ok: true, quotes: {}, failed: [] };
        for (const row of visible) {
          payload.quotes[row.nseSymbol] = { price: row.priceInr * 1.002, prevClose: row.prevCloseInr, asOf: new Date().toISOString() };
        }
        quotes.__injectQuotes(payload);
        // Wait for the repaint to land, not for half a second to pass. If no
        // row is ever swapped the loop runs out and the assertions below say
        // so — which is the failure, correctly attributed.
        await window.__until(
          () => document.querySelectorAll('[data-score-table] tbody tr:not([data-stamp])').length > 0,
          'a row repainting after the tick',
        ).catch(() => {});

        const trs = [...document.querySelectorAll('[data-score-table] tbody tr')];
        return {
          before,
          moved: visible.map((r) => r.isin),
          repainted: trs.filter((tr) => !tr.dataset.stamp).map((tr) => tr.getAttribute('data-key')),
          untouched: trs.filter((tr) => tr.dataset.stamp).length,
          after: {
            q: search.value,
            filter: document.querySelector('select[data-filter="fund"]').value,
            sort: document.querySelector('[data-score-table] thead th[aria-sort]:not([aria-sort="none"])')?.textContent.trim() ?? null,
            rows: window.__sattva.rows().length,
            watched: d.state.isWatched(watchedKey),
          },
          watchedKey,
        };
      });

      ok(result.moved.length === 2, 'two rows must have been nudged', `${result.moved.length} eligible rows`);
      ok(result.repainted.length > 0, 'the rows whose price moved must repaint', 'nothing repainted');
      equal(JSON.stringify([...result.repainted].sort()), JSON.stringify([...result.moved].sort()),
        'a tick must repaint exactly the rows whose price moved, and nothing else');
      ok(result.untouched > 5, 'the rest of the table must be left alone', `${result.untouched} untouched`);
      equal(result.after.q, result.before.q, 'the search box must survive a tick');
      equal(result.after.filter, result.before.filter, 'the filter must survive a tick');
      equal(result.after.sort, result.before.sort, 'the sort must survive a tick');
      equal(result.after.rows, result.before.rows, 'the row set must not be rebuilt');
      equal(result.after.watched, true, 'the watchlist must survive a tick');
      return `${result.repainted.length} of ${result.before.rows} rows repainted, ${result.untouched} untouched; search, filter, sort and watchlist all intact`;
    },
    sabotage: async (c) => {
      await c.page.evaluate(() => {
        // A tick that touches every row — the rebuild this check guards
        // against. Stripping the stamps makes every row look repainted, which
        // is exactly what a full rebuild would produce.
        //
        // This one converges without a disconnect: deleting an absent
        // data-attribute is not a mutation, so the second pass is silent.
        const table = document.querySelector('[data-score-table]');
        const observer = new MutationObserver(() => {
          for (const tr of table.querySelectorAll('tbody tr')) delete tr.dataset.stamp;
        });
        observer.observe(table, { subtree: true, childList: true, attributes: true });
      });
    },
    restore: restoreByReload,
  }, ctx);

  await suite.check({
    id: 40,
    what: 'the upstream token appears in zero served files — the served site is fetched and grepped, not the repo',
    run: async (c) => {
      // Crawl what the ORIGIN SERVES, from index.html through the whole module
      // graph. Watching page responses is not enough: the browser serves most
      // modules from its memory cache on a re-navigation, so the observed set
      // silently shrinks to a handful and the check passes for the wrong
      // reason. Following the imports reaches every file regardless.
      const seen = new Set([`${c.base}/index.html`, `${c.base}/`]);
      const bodies = new Map();
      const fetchText = async (url) => {
        if (bodies.has(url)) return bodies.get(url);
        const response = await fetch(url).catch(() => null);
        const text = response && response.ok ? await response.text() : null;
        bodies.set(url, text);
        return text;
      };

      const index = await fetchText(`${c.base}/index.html`);
      ok(index, 'index.html must be served');
      const queue = [];
      for (const m of index.matchAll(/<script[^>]+src="([^"]+)"/g)) {
        if (!/^https?:/.test(m[1])) queue.push(new URL(m[1], `${c.base}/`).href);
      }
      // Follow every static import, transitively.
      while (queue.length) {
        const url = queue.shift();
        if (seen.has(url)) continue;
        seen.add(url);
        const text = await fetchText(url);
        if (!text) continue;
        const specifiers = [
          ...text.matchAll(/(?:^|[\s;])import\s+(?:[^'"]*?from\s*)?['"]([^'"]+)['"]/g),
          ...text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g),
        ].map((m) => m[1]);
        for (const spec of specifiers) {
          if (/^https?:/.test(spec)) continue;
          queue.push(new URL(spec, url).href);
        }
      }
      // Plus every committed data file the site reads.
      for (const file of ['companies.json', 'msci-funds.json', 'prices.json', 'quote-stats.json',
        'nse-freefloat.json', 'bse-freefloat.json', 'share-reconciliation.json']) {
        seen.add(`${c.base}/data/${file}`);
      }

      // The secret value itself, if this machine has one. It is read at run
      // time and never written anywhere — .dev.vars is gitignored and the
      // deployed value is a Worker secret.
      const secrets = [];
      const devVars = join(ROOT, '.dev.vars');
      if (existsSync(devVars)) {
        for (const line of readFileSync(devVars, 'utf8').split('\n')) {
          const [, value] = /^\s*[A-Z_]+\s*=\s*(.+?)\s*$/.exec(line) ?? [];
          if (value && value.replace(/^["']|["']$/g, '').length >= 8) secrets.push(value.replace(/^["']|["']$/g, ''));
        }
      }
      if (process.env.MUNS_TOKEN) secrets.push(process.env.MUNS_TOKEN);

      const offenders = [];
      let scanned = 0;
      for (const url of seen) {
        const text = await fetchText(url);
        if (text === null) continue;
        scanned += 1;
        if (/\bMUNS_TOKEN\b/.test(text)) offenders.push(`${url} names MUNS_TOKEN`);
        if (/\bauthorization\s*[:=]\s*["'`]?\s*bearer\s+\S/i.test(text)) offenders.push(`${url} carries an Authorization: Bearer header`);
        for (const secret of secrets) if (text.includes(secret)) offenders.push(`${url} CONTAINS THE TOKEN VALUE`);
      }
      ok(scanned >= 20, 'the crawl must reach the whole served module graph', `only ${scanned} served files fetched`);
      empty(offenders, 'a token shipped to the client is a token published', (o) => o);
      return `${scanned} served files fetched and grepped${secrets.length ? ` (including the ${secrets.length} local secret value(s))` : ' (no local secret on this machine; structural patterns only)'}`;
    },
    sabotage: async (c) => {
      // Serve one module with the secret's NAME in it. The crawler reads the
      // origin directly, so the interception has to be at the fetch layer.
      const realFetch = globalThis.fetch;
      c.restoreFetch = () => { globalThis.fetch = realFetch; };
      globalThis.fetch = async (url, init) => {
        const response = await realFetch(url, init);
        if (!String(url).endsWith('/js/app.js')) return response;
        const body = `${await response.text()}\nconst t = env.MUNS_TOKEN;\n`;
        return new Response(body, { status: 200, headers: { 'content-type': 'text/javascript' } });
      };
    },
    restore: async (c) => { c.restoreFetch?.(); c.restoreFetch = null; await c.load(); },
  }, ctx);

  await suite.check({
    id: 41,
    what: 'with the Worker unreachable every row falls back to EOD and the header says last close',
    run: async (c) => {
      // Works in both modes: against the static server there is nothing to
      // block, and against wrangler this is what a Worker outage looks like.
      c.errors.inducing = true;
      await c.page.route('**/api/quotes', (route) => route.abort());
      await c.load();
      const m = await c.page.evaluate(async () => {
        const quotes = await import('/js/data/quotes.js');
        // Not a table wait: this waits for an ABSENCE — a live price that must
        // never arrive. There is no condition to poll for something that does
        // not happen, so the poller is given a window to fail in.
        await new Promise((r) => setTimeout(r, 400));
        const rows = window.__sattva.data.all();
        return {
          tiers: rows.reduce((acc, r) => { acc[r.priceTier ?? 'none'] = (acc[r.priceTier ?? 'none'] ?? 0) + 1; return acc; }, {}),
          sources: [...new Set(rows.map((r) => r.priceSource).filter(Boolean))],
          live: quotes.isLive(),
          liveCount: quotes.liveCount(),
          header: document.querySelector('[data-status-slot]')?.innerText.replace(/\s+/g, ' ').trim() ?? '',
        };
      });
      await c.page.unroute('**/api/quotes');
      c.errors.inducing = false;
      equal(m.live, false, 'nothing may claim to be live when no byte arrived');
      equal(m.liveCount, 0, 'the live overlay must be empty');
      equal(m.tiers.live ?? 0, 0, 'no row may sit on the live tier');
      ok((m.tiers.eod ?? 0) > 1000, 'every row must fall back to its committed close', JSON.stringify(m.tiers));
      ok(m.sources.length > 0 && m.sources.every((s) => s.startsWith('bhavcopy-bse')),
        'priceSource must read bhavcopy-bse (a carried-forward close is still BSE\'s, and says so)',
        m.sources.join(', '));
      ok(/last close/i.test(m.header), 'the header must say last close, not live', `header reads "${m.header}"`);
      ok(!/live ·/i.test(m.header), 'the header must not claim live', m.header);
      return `${m.tiers.eod} rows on eod${m.tiers.stale ? `, ${m.tiers.stale} stale` : ''} · header: "${m.header.split('\n')[0].slice(0, 60)}"`;
    },
    sabotage: persistent(`(() => {
      // A header that claims live whether or not a byte arrived — and keeps
      // claiming it through the reload this check performs.
      const lie = () => {
        const slot = document.querySelector('[data-status-slot]');
        if (slot && !/Live \u00b7 NSE/.test(slot.textContent)) slot.textContent = 'Live \u00b7 NSE \u00b7 updated just now';
      };
      lie();
      new MutationObserver(lie).observe(document.body, { childList: true, subtree: true });
    })()`),
    restore: async (c) => {
      c.sabotageHook = null;
      await c.page.unroute('**/api/quotes').catch(() => {});
      await c.load();
    },
  }, ctx);

  suite.section('NSE surveillance (ASM)');

  await suite.check({
    id: 56,
    what: "the ASM column shows NSE's stage where flagged and an honest, distinct dash where clear",
    run: async (c) => {
      await c.settle();
      const m = await c.page.evaluate(() => {
        const S = window.__sattva;
        const headings = [...document.querySelectorAll('[data-score-table] thead th')].map((th) => th.textContent.trim());
        const asmIndex = headings.findIndex((h) => /ASM stage/i.test(h));
        const meta = S.data.asm();
        const all = S.data.all();
        const renderedFlagged = all.filter((x) => x.asm).length;
        // A stage that is not one of NSE's own code shapes would be a fabrication.
        const badCodes = all
          .filter((x) => x.asm && !/^(LTASM|STASM)\b/.test(x.asm.survCode || ''))
          .map((x) => `${x.name}: ${x.asm.survCode}`);

        // Zip the painted rows with the view's own row objects — same order, so
        // each cell is checked against the exact company it renders.
        const rows = S.rows();
        const trs = [...document.querySelectorAll('[data-score-table] tbody tr')];
        const n = Math.min(rows.length, trs.length);
        let flaggedCellShown = 0;
        let clearCellDash = 0;
        let clearTitleOk = 0;
        const mism = [];
        for (let i = 0; i < n; i += 1) {
          const co = rows[i];
          const cell = trs[i].children[asmIndex];
          if (!cell) continue;
          const txt = cell.textContent.trim();
          const title = cell.querySelector('[title]')?.getAttribute('title') || '';
          if (co.asm) {
            const head = (co.asm.survCode || '').split(' ')[0]; // LTASM / STASM
            if (txt.includes(head)) flaggedCellShown += 1;
            else mism.push(`${co.name}: flagged but cell="${txt}"`);
          } else {
            if (/^[—-]$/.test(txt)) clearCellDash += 1;
            else mism.push(`${co.name}: clear but cell="${txt}"`);
            if (/not under ASM/i.test(title)) clearTitleOk += 1;
          }
        }
        return {
          headings, asmIndex, available: meta?.available ?? null,
          declaredFlagged: meta?.flaggedInUniverse ?? null, asOf: meta?.asOf ?? null,
          renderedFlagged, badCodes, painted: n, flaggedCellShown, clearCellDash, clearTitleOk, mism,
        };
      });

      ok(m.asmIndex >= 0, 'the "ASM stage" column must be present in the header', m.headings.join(' | '));
      ok(m.available === true, 'the record must declare the ASM feed available so a dash means "not flagged"', String(m.available));
      // THE ANCHOR: the rows carrying a stage must equal the count the record
      // publishes. A screen that shows more or fewer stages than it declares is
      // the §2.5 stale-denominator lie wearing an ASM hat.
      equal(m.renderedFlagged, m.declaredFlagged, 'the companies carrying a stage match the count the record declares');
      ok(m.renderedFlagged > 0, 'at least one company is under ASM in the record', String(m.renderedFlagged));
      empty(m.badCodes, "no company carries a stage that is not one of NSE's own codes", (x) => x);
      empty(m.mism, 'every painted ASM cell agrees with its company — a stage where flagged, a dash where clear', (x) => x);
      ok(m.flaggedCellShown > 0, 'the column renders NSE stage badges for flagged companies in view', `${m.flaggedCellShown} of ${m.painted} painted`);
      ok(m.clearCellDash > 0, 'a company not under ASM renders a dash, never a stage', `${m.clearCellDash} of ${m.painted} painted`);
      ok(m.clearTitleOk > 0, 'the dash for a clear company says "not under ASM" in its title, not a bare gap (§2.4)', `${m.clearTitleOk} titles checked`);
      return `${m.renderedFlagged} of ${m.declaredFlagged} flagged · painted ${m.painted}: ${m.flaggedCellShown} badges, ${m.clearCellDash} dashes · effective ${m.asOf}`;
    },
    // Strip every stage from the live data while the meta still declares 93
    // flagged: the rendered stages then disagree with the published count, and a
    // once-flagged row's cell no longer matches its company. Persistent so it
    // survives the settle the check runs first (§2.22).
    sabotage: persistent('(() => { for (const co of window.__sattva.data.all()) co.asm = null; })()'),
    restore: restoreByReload,
  }, ctx);

  await suite.check({
    id: 57,
    what: "an ASM name's forced flow is shown but marked 'not mandated', with days-of-volume flagged understated",
    run: async (c) => {
      await c.settle();
      const m = await c.page.evaluate(async () => {
        const S = window.__sattva;
        const TRADE = new Set(['likely-inclusion', 'possible-inclusion', 'migration-up', 'migration-down', 'exclusion-risk', 'likely-exclusion']);
        // Paint every row so the target is in the DOM, then open its drill by
        // CLICKING its own row — the mechanism checks 30 and 35 prove in CI. A
        // cold-load ?company= URL was tried and is unreliable here (the drill
        // opened for no flow); a search-then-click races the filtered rows. The
        // painted <tr>s and rows() are index-aligned, so click the target's row.
        if (S.flush) S.flush();
        await new Promise((r) => requestAnimationFrame(() => r()));
        const rows = S.rows();
        const idx = rows.findIndex((x) => x.assessment?.asm?.binding && x.flowEstimate?.asmConstraint && TRADE.has(x.assessment.verdict));
        if (idx < 0) return { error: 'no trade-implying ASM row is present' };
        const target = rows[idx];
        const trs = [...document.querySelectorAll('[data-score-table] tbody tr')];
        const tr = trs[idx];
        if (!tr) return { error: `the target row at index ${idx} is not painted (${trs.length} painted)` };
        (tr.querySelector('td:nth-child(2)') ?? tr).click();
        // Wait for the drill to OPEN (any body text), then read it. Separating
        // "opened" from "has the flow section" keeps a failure diagnosable — the
        // return carries the drill title and a snippet.
        await window.__until(
          () => (document.querySelector('[data-drill-body]')?.textContent?.length ?? 0) > 0,
          'the drill opening',
        );
        // ⚠ textContent, NOT innerText. innerText applies CSS text-transform, and
        // the "Estimated flow" heading and the "Flow not mandated" banner both
        // carry Tailwind's `uppercase` — so with the CDN loaded (CI) innerText
        // returns them UPPERCASED and a case-sensitive match misses, while the
        // sandbox (CDN blocked) leaves them as authored. textContent is the raw
        // authored text, unaffected by styling. This was three red CI runs.
        const text = document.querySelector('[data-drill-body]').textContent;
        const drillTitle = document.querySelector('[data-panel] h2')?.textContent?.trim() ?? null;
        const i = text.indexOf('Estimated flow');
        // Wide enough to clear the (long) ASM banner and reach the flow card. The
        // banner carries no ₹ (it says "rupee sizes" in words), so any ₹ here is
        // the flow figure itself.
        const region = i >= 0 ? text.slice(i, i + 1800) : '';
        return {
          name: target.name, survCode: target.asm.survCode, verdict: target.assessment.verdict,
          drillTitle,
          hasFlowSection: i >= 0,
          banner: /Flow not mandated — under NSE ASM/.test(text),
          // The desk chose to SHOW the mechanical size, marked — not suppress it.
          // So the flow region must still carry a rupee figure.
          figureShown: /₹/.test(region),
          timingMarked: /understated \(ASM\)/.test(text),
          notMandatedText: /not mandated to rebalance/i.test(text),
          snippet: text.slice(0, 200).replace(/\s+/g, ' '),
        };
      });

      ok(!m.error, 'a trade-implying ASM row must be present and painted to inspect', JSON.stringify(m));
      equal(m.drillTitle, m.name, 'the target company\'s own drill must open');
      ok(m.hasFlowSection, 'the drill shows the Estimated flow section for a trade-implying ASM name', JSON.stringify(m));
      ok(m.banner, "the drill flags an ASM name's forced flow as not mandated", JSON.stringify(m));
      ok(m.figureShown, 'the mechanical flow size is still shown (shown-with-caveat, not suppressed)', JSON.stringify(m));
      ok(m.timingMarked, 'days-of-volume is marked understated under ASM', JSON.stringify(m));
      ok(m.notMandatedText, 'the drill states the desk\'s "not mandated to rebalance" judgement', JSON.stringify(m));
      await c.page.keyboard.press('Escape');
      return `${m.name} (${m.verdict}, ${m.survCode}): banner + figure shown + timing marked`;
    },
    // Blank the banner on the drill as it renders. A one-shot DOM edit would lose
    // the race against the condition-based wait, so this re-applies on every
    // mutation until the phrase is gone (§2.22, mirroring check 35).
    sabotage: persistent(`(() => {
      const root = document.querySelector('#drill-root') ?? document.body;
      const strip = () => {
        const body = document.querySelector('[data-drill-body]');
        if (!body || !/Flow not mandated/.test(body.innerHTML)) return;
        body.innerHTML = body.innerHTML.replace(/Flow not mandated — under NSE ASM/g, 'Flow (ordinary)');
      };
      strip();
      new MutationObserver(strip).observe(root, { childList: true, subtree: true });
    })()`),
    restore: restoreByReload,
  }, ctx);

  await suite.check({
    id: 58,
    what: "the FTSE column shows Vanguard's own weight where held, and a dash that says FTSE — never a zero",
    run: async (c) => {
      await c.settle();
      const m = await c.page.evaluate(async () => {
        const S = window.__sattva;
        const headings = [...document.querySelectorAll('[data-score-table] thead th')].map((th) => th.textContent.trim());
        const idx = headings.findIndex((h) => /FTSE/i.test(h));
        const meta = S.data.ftse();
        const all = S.data.all();
        const renderedHeld = all.filter((x) => x.ftse).length;

        const rows = S.rows();
        const trs = [...document.querySelectorAll('[data-score-table] tbody tr')];
        const n = Math.min(rows.length, trs.length);
        let heldShown = 0; let notHeldDash = 0; let notHeldTitleOk = 0; let zeroLie = 0;
        const mism = [];
        for (let i = 0; i < n; i += 1) {
          const co = rows[i];
          const cell = trs[i].children[idx];
          if (!cell) continue;
          const txt = cell.textContent.trim();
          const title = cell.querySelector('[title]')?.getAttribute('title') || cell.getAttribute('title') || '';
          if (co.ftse) {
            if (/\d/.test(txt)) heldShown += 1;
            else mism.push(`${co.name}: in the FTSE book but cell="${txt}"`);
          } else {
            if (/^[—-]$/.test(txt)) notHeldDash += 1;
            else mism.push(`${co.name}: not in the FTSE book but cell="${txt}"`);
            // §2.3 — the failure this column must never have: a company FTSE
            // does not hold rendering as a real 0%, which sorts and ranks.
            if (/^0(\.0+)?\s*%$/.test(txt)) zeroLie += 1;
            if (/FTSE/i.test(title)) notHeldTitleOk += 1;
          }
        }
        // The drill must name the fund and say it bears on no verdict here.
        // Paint every row, then open the drill by CLICKING its own row — the
        // mechanism checks 30, 35 and 57 already prove. A ?company= cold load is
        // unreliable here and a search-then-click races the filtered rows.
        let drillErr = null;
        if (S.flush) S.flush();
        await new Promise((r) => requestAnimationFrame(() => r()));
        const painted = [...document.querySelectorAll('[data-score-table] tbody tr')];
        const all2 = S.rows();
        const target = all2.findIndex((x) => x.ftse);
        let drillText = '';
        if (target >= 0 && painted[target]) {
          try {
          (painted[target].querySelector('td:nth-child(2)') ?? painted[target]).click();
          await window.__until(
            () => (document.querySelector('[data-drill-body]')?.textContent?.length ?? 0) > 0,
            'the drill opening',
          );
          // ⚠ textContent, NOT innerText: innerText applies CSS text-transform,
          // and headings here are uppercased by Tailwind in CI but not in a
          // sandbox without the CDN — which is exactly how a case-sensitive
          // match passes locally and fails in CI.
          drillText = document.querySelector('[data-drill-body]').textContent || '';
          } catch (e) { drillErr = String(e && e.message || e); }
        }
        return {
          drillErr, targetIndex: target, paintedCount: painted.length,
          headings, idx, available: meta?.available ?? null, declaredResolved: meta?.resolved ?? null,
          indiaRows: meta?.indiaRows ?? null, currency: meta?.currency ?? null, asOf: meta?.asOf ?? null,
          renderedHeld, painted: n, heldShown, notHeldDash, notHeldTitleOk, zeroLie, mism,
          drillText, drillOpened: target >= 0 && Boolean(painted[target]),
        };
      });

      ok(m.idx >= 0, 'a column naming FTSE must be present in the header', m.headings.join(' | '));
      ok(m.available === true, 'the record must declare the FTSE book available so a dash means "not held"', String(m.available));
      equal(m.renderedHeld, m.declaredResolved, 'the companies carrying an FTSE holding match the count the record declares');
      ok(m.renderedHeld > 0, 'at least one company is in the FTSE book', String(m.renderedHeld));
      empty(m.mism, 'every painted FTSE cell agrees with its company — a weight where held, a dash where not', (x) => x);
      ok(m.heldShown > 0, 'the column renders a weight for companies FTSE holds', `${m.heldShown} of ${m.painted} painted`);
      ok(m.notHeldDash > 0, 'a company FTSE does not hold renders a dash', `${m.notHeldDash} of ${m.painted} painted`);
      equal(m.zeroLie, 0, 'no company FTSE does not hold renders as 0% — missing is never zero (§2.3)');
      ok(m.notHeldTitleOk > 0, 'the dash names FTSE in its title, so the absence says WHICH book it is absent from', `${m.notHeldTitleOk} titles`);

      // The drill has to make the second-opinion status explicit, because the
      // column alone cannot say that this weight moves nothing on the screen.
      ok(m.drillOpened, 'a company in the FTSE book has a row to open', String(m.drillOpened));
      // Surfaced rather than swallowed: a drill that failed to open would
      // otherwise read as a drill with no FTSE text in it, which is a different
      // fault with the same symptom.
      equal(m.drillErr, null, 'the drill opened without error');
      const drill = m.drillText;
      ok(/FTSE/i.test(drill), 'the drill names FTSE', drill.slice(0, 160));
      ok(/second opinion/i.test(drill), 'the drill says FTSE is a second opinion, not an input to the verdict', 'phrase missing');
      ok(/no verdict|verdict, no segment|bears on no verdict/i.test(drill),
        'the drill states that the FTSE holding moves no verdict on this screen', 'disclaimer missing');

      return `${m.renderedHeld} of ${m.indiaRows} India rows joined · painted ${m.painted}: ${m.heldShown} weights, ${m.notHeldDash} dashes · ${m.currency} book as at ${m.asOf}`;
    },
    // Strip the FTSE holdings from the live data while the meta still declares
    // 638 joined: the rendered count then disagrees with the published one, and
    // rows that should show a weight show a dash. Persistent so it survives the
    // settle the check runs first (§2.22).
    sabotage: persistent('(() => { for (const co of window.__sattva.data.all()) co.ftse = null; })()'),
    restore: restoreByReload,
  }, ctx);

  await browser.close();

  process.exit(suite.report([
    `Mode: ${hasWorker ? 'Worker present — the live block runs' : 'static floor — the live block skips, which is the point of running it here'}`,
    `Console: ${errors.filtered.length} CDN failures filtered by response URL · `
      + `${errors.designed.length} designed no-Worker probe(s) on /api/quotes · `
      + `${errors.induced.length} induced by the harness cutting that route on purpose · `
      + `${errors.real.length} from our own code`,
  ]));
}

/* A minimal RFC-4180 reader, so the round-trip is a real parse. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

main().catch((error) => {
  process.stderr.write(`\n  verify-ui crashed: ${error.stack}\n\n`);
  process.exit(2);
});
