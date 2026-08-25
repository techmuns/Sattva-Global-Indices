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

  const load = async (hash = '#/companies?scope=all') => {
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
        scope: Boolean(document.querySelector('[data-scope-slot]')),
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
    what: 'the scope toggle changes the count and the chip prints its denominator',
    run: async (c) => {
      const before = await c.page.evaluate(() => ({
        n: window.__sattva.rows().length,
        chip: document.querySelector('[data-scope-slot]')?.innerText.replace(/\s+/g, ' ').trim() ?? '',
      }));
      await c.page.evaluate(() => {
        const held = [...document.querySelectorAll('[data-scope-slot] button')].find((b) => /held/i.test(b.textContent));
        held.click();
      });
      await c.settle();
      const after = await c.page.evaluate(() => ({
        n: window.__sattva.rows().length,
        all: window.__sattva.data.all().length,
        chipText: [...document.querySelectorAll('[data-score-table] ~ *, [data-row-count]')].map((n) => n.textContent).join(' '),
        heading: document.body.innerText,
      }));
      ok(after.n !== before.n, 'switching scope must change the row count', `${before.n} → ${after.n}`);
      ok(after.n < after.all, 'the held scope must be a subset of the record', `${after.n} of ${after.all}`);
      const denominator = new RegExp(`of\\s+${after.all.toLocaleString('en-IN')}`);
      ok(denominator.test(after.heading), 'the denominator must appear on screen', `no "of ${after.all}" found`);
      // back to where we were
      await c.page.evaluate(() => {
        const all = [...document.querySelectorAll('[data-scope-slot] button')].find((b) => /^all$/i.test(b.textContent.trim()));
        all.click();
      });
      await c.settle();
      return `all ${before.n} → held ${after.n}, denominator ${after.all} printed`;
    },
    sabotage: persistent(`(() => {
      // A count that stops printing its denominator — and keeps not printing it
      // through the rebuild the scope switch triggers.
      //
      // WRITE ONLY WHAT CHANGES. Assigning textContent fires a characterData
      // mutation even when the value is identical, so an unconditional write
      // inside a characterData observer re-triggers itself for ever. The first
      // version of this sabotage pinned a core and hung the run.
      const strip = () => {
        for (const node of document.querySelectorAll('*')) {
          if (node.children.length !== 0) continue;
          const next = node.textContent.replace(/ of .*/, '');
          if (next !== node.textContent) node.textContent = next;
        }
      };
      const observer = new MutationObserver(() => {
        observer.disconnect();
        strip();
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      });
      strip();
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    })()`),
    restore: restoreByReload,
  }, ctx);

  /* ── search, filters, sort ──────────────────────────────────────────────*/
  suite.section('Search, filters and sort');

  await suite.check({
    id: 26,
    what: 'search matches name, symbol and ISIN; every filter narrows; two filters AND rather than replace',
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
        const selects = [...document.querySelectorAll('select[data-filter]')];
        const total = window.__sattva.rows().length;
        const results = [];
        const set = window.__set;
        // each filter alone
        for (const select of selects) {
          const option = [...select.options].find((o) => o.value !== '');
          if (!option) continue;
          await set(select, option.value);
          results.push({
            id: select.dataset.filter,
            value: option.value,
            n: window.__sattva.rows().length,
            keys: window.__sattva.rows().map((r) => window.__sattva.data.keyOf(r)),
          });
          await set(select, '');
        }
        // two together
        const [a, b] = results;
        const selA = selects.find((s) => s.dataset.filter === a.id);
        const selB = selects.find((s) => s.dataset.filter === b.id);
        await set(selA, a.value);
        await set(selB, b.value);
        const combined = window.__sattva.rows().map((r) => window.__sattva.data.keyOf(r));
        await set(selA, '');
        await set(selB, '');
        return { total, results, combined, a: a.id, b: b.id };
      });

      ok(filters.results.length >= 4, 'every filter must be exercised', `${filters.results.length} filters found`);
      for (const r of filters.results) {
        ok(r.n < filters.total, `filter "${r.id}=${r.value}" must narrow the view`, `${r.n} of ${filters.total}`);
      }
      // AND, not replace: the combined set is exactly the intersection.
      const [a, b] = filters.results;
      const expected = a.keys.filter((k) => b.keys.includes(k)).sort();
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
    id: 34,
    what: 'a scope switch does not block the main thread past 400 ms',
    run: async (c) => {
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
        // Not a table wait: this IS the measurement window. The check is
        // about how long a frame is blocked, so it deliberately observes for a
        // fixed span rather than stopping the moment the table settles.
        const buttons = [...document.querySelectorAll('[data-scope-slot] button')];
        buttons.find((b) => /held/i.test(b.textContent)).click();
        await new Promise((r) => setTimeout(r, 900));
        buttons.find((b) => /^all$/i.test(b.textContent.trim())).click();
        await new Promise((r) => setTimeout(r, 900));
        running = false;
        return longest;
      });
      await c.settle();
      ok(worst < 400, 'a scope switch must not freeze the interface', `longest frame gap ${worst.toFixed(0)} ms`);
      return `longest frame gap across two scope switches: ${worst.toFixed(0)} ms`;
    },
    sabotage: async (c) => {
      await c.page.evaluate(() => {
        const button = [...document.querySelectorAll('[data-scope-slot] button')].find((b) => /held/i.test(b.textContent));
        button.addEventListener('click', () => { const t = Date.now(); while (Date.now() - t < 600) { /* block */ } }, { once: true });
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
        const verdicts = [...select.options].map((o) => o.value).filter(Boolean);
        const seen = [];
        for (const value of verdicts) {
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
      equal(m.seen.length, m.verdicts.length, 'every verdict must produce a pill');

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
        return {
          symbols,
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
        ok(result.first.resolved >= result.symbols.length - 1,
          'one bad ticker must not take the others down with it',
          `${result.first.resolved} of ${result.symbols.length} real symbols resolved`);
        return `live → hit · ${result.first.resolved} resolved, ZZQXNOTREAL in failed[] alongside them`;
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
