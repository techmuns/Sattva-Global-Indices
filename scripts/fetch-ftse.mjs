#!/usr/bin/env node
/**
 * fetch-ftse.mjs — Vanguard's OWN "Holdings details" export for VEE, fetched by
 *                  pressing the same button the desk presses
 *                  -> scripts/fixtures/vanguard-ftse-em-allcap.xlsx
 *                     + scripts/fixtures/vanguard-ftse-expected.json, re-measured
 *
 *   node scripts/fetch-ftse.mjs            fetch, check, write only a NEWER book
 *   node scripts/fetch-ftse.mjs --dry-run  fetch and check; write nothing
 *
 * Then `node scripts/import-ftse.mjs` reads the workbook exactly as it always has.
 *
 * ---------------------------------------------------------------------------
 * WHY A BROWSER, WHEN EVERY OTHER FETCHER HERE IS ONE curl
 * ---------------------------------------------------------------------------
 * There is no file to download. Measured 20 Oct 2026 on vanguard.ca: the
 * Download beside "Top 10 Holdings" makes NO request — the page builds the
 * .xlsx in the browser (a ~2 MB Blob handed to URL.createObjectURL) from
 * holdings it has already read from its GraphQL API (/gpx/graphql,
 * `borHoldings.delayeredHoldings`, portfolio 9556). VEE is a fund of funds —
 * 99.2% one US ETF directly — and the workbook is the look-through.
 *
 * That API answers plain HTTP and carries the unrounded figures; 6,343 of the
 * export's 6,486 rows matched it on all seven columns, and the rest differed
 * only in Vanguard's rounding of the fourth decimal. It was NOT used, because
 * reading it would be a second reader of the book (§2.38 forbids one: it would
 * produce rows, the rows would resolve, and they would quietly differ from an
 * upload of the same book on rounding, on which rows the export drops, and on
 * every reason a row carries), and because "Vanguard's own export" would
 * become "our reconstruction of it" — a different provenance on every cell.
 *
 * So this script asks Vanguard's page to build Vanguard's file, and the bytes
 * it receives are the bytes the desk would have uploaded. Playwright is a
 * GLOBAL tool (lib/playwright.mjs), as it already is for verify-ui; nothing is
 * added to this repo.
 *
 * ---------------------------------------------------------------------------
 * WHAT A FRESH BOOK MUST PASS BEFORE IT REPLACES THE COMMITTED ONE
 * ---------------------------------------------------------------------------
 * Exactly what an upload must pass, from the same module: readFtseBook() and
 * assertBookShape() with the COMMITTED book as `previous`, so the shrink guard
 * reads the book being replaced and never the one under test (§3.8). Plus:
 * the fund must be this fund, and its "As at" must not be older than the
 * committed book's. A book no newer than the committed one is a clean no-op.
 * Only then is the workbook written, and its measured table in
 * vanguard-ftse-expected.json re-measured in the same write (§2.34.2).
 *
 * The currency is NOT checked here and does not need to be: import-ftse and
 * the build re-measure it on every run against our own closes (§2.35), and a
 * book struck in another currency fails there, loudly, before it is committed.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { readFtseBook, assertBookShape } from '../public/js/model/ftse-book.js';
import { loadPlaywright } from './lib/playwright.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const FIXTURE = join(HERE, 'fixtures', 'vanguard-ftse-em-allcap.xlsx');
export const FTSE_EXPECTED_PATH = join(HERE, 'fixtures', 'vanguard-ftse-expected.json');
const COMMITTED_BOOK = join(REPO, 'public', 'data', 'ftse-funds.json');

/** VEE's product page. 9556 is Vanguard's own portfolio id, read off its GraphQL API. */
const PRODUCT_URL = 'https://www.vanguard.ca/en/product/etf/equity/9556/vanguard-ftse-emerging-markets-all-cap-index-etf';
const FUND_NAME = 'Vanguard FTSE Emerging Markets All Cap Index ETF';

/** The section whose Download carries every holding, not ten — named by its own heading. */
const SECTION_HEADING = /^\s*Top 10 Holdings/i;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

async function downloadBook(playwright) {
  const browser = await playwright.chromium.launch();
  try {
    const context = await browser.newContext({ acceptDownloads: true, userAgent: USER_AGENT, locale: 'en-CA' });
    // A trace of how the page hands over its file, read only when no download
    // arrives — so a failure names what the page did instead of only timing out.
    await context.addInitScript(() => {
      window.__sattvaTrace = [];
      const push = (entry) => { try { window.__sattvaTrace.push(entry); } catch { /* best effort */ } };
      const createObjectURL = URL.createObjectURL;
      URL.createObjectURL = function trace(blob) {
        push({ kind: 'createObjectURL', type: blob?.type ?? null, size: blob?.size ?? null });
        return createObjectURL.apply(this, arguments);
      };
      const anchorClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function trace() {
        push({ kind: 'anchor.click', href: String(this.href).slice(0, 60), download: this.download ?? null });
        return anchorClick.apply(this, arguments);
      };
      const dispatch = EventTarget.prototype.dispatchEvent;
      EventTarget.prototype.dispatchEvent = function trace(event) {
        if (this instanceof HTMLAnchorElement && event?.type === 'click') {
          push({ kind: 'anchor.dispatch', href: String(this.href).slice(0, 60), download: this.download ?? null });
        }
        return dispatch.apply(this, arguments);
      };
      // ⚠ THE EXPORTER PREFERS A SAVE DIALOG WHERE ONE EXISTS. Chromium has the
      // File System Access API, so Vanguard's exporter calls showSaveFilePicker()
      // — which a headless browser can never answer, so the file is built and
      // handed to nobody. Measured on a GitHub runner: the look-through fetched
      // (six GraphQL pages, ~3.4 MB, all 200) and no download ever fired. With
      // the picker absent the exporter takes its ordinary path, the Blob link a
      // browser without the API gets, and Playwright receives the same file.
      for (const name of ['showSaveFilePicker', 'showOpenFilePicker', 'showDirectoryPicker']) {
        try {
          delete Window.prototype[name];
          delete window[name];
        } catch { /* best effort */ }
        if (name in window) push({ kind: 'still-present', name });
      }
    });
    const page = await context.newPage();
    const requests = [];
    const lookThrough = { pages: 0, finalSeen: false, totalHoldings: null };
    page.on('response', async (r) => {
      if (!/graphql|download|export|xlsx/i.test(r.url())) return;
      let note = '';
      try {
        const text = await r.text();
        if (text.includes('"delayeredHoldings"')) {
          lookThrough.pages += 1;
          const total = /"totalHoldings"\s*:\s*(\d+)/.exec(text)?.[1];
          if (total) lookThrough.totalHoldings = Number(total);
          if (/"lastItemKey"\s*:\s*null/.test(text)) lookThrough.finalSeen = true;
        }
        const errors = /"errors"\s*:\s*\[\s*\{[^}]*"message"\s*:\s*"([^"]{0,120})/.exec(text)?.[1];
        note = errors ? ` error="${errors}"` : ` ${text.length}B`;
      } catch { /* body unavailable */ }
      requests.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 50)}${note}`);
    });
    page.on('popup', (p) => requests.push(`popup ${p.url().slice(0, 80)}`));
    page.on('pageerror', (e) => requests.push(`pageerror ${String(e.message).slice(0, 160)}`));
    page.on('console', (m) => { if (m.type() === 'error') requests.push(`console.error ${m.text().slice(0, 160)}`); });
    const explain = async () => {
      const trace = await page.evaluate(() => window.__sattvaTrace ?? []).catch(() => []);
      return `page trace ${JSON.stringify(trace).slice(0, 400)}; requests after load: ${requests.slice(-12).join(' | ') || 'none'}`;
    };
    await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });

    // The holdings block renders lazily. Wait for the heading rather than for a
    // fixed time (verify-ui's own rule: never sleep to wait for a table).
    await page.waitForFunction(
      (source) => [...document.querySelectorAll('h1,h2,h3,h4,h5,div,span')]
        .some((el) => new RegExp(source, 'i').test(el.textContent ?? '') && /AS AT/i.test(el.closest('section,div')?.textContent ?? '')),
      SECTION_HEADING.source,
      { timeout: 90000 },
    );

    // ⚠ ONE Download, named by the section it sits in, resolved AT CLICK TIME.
    //
    // The page carries six Downloads (performance, allocation, holdings,
    // prices, distributions…); a positional pick would fetch the wrong report
    // and every check below would describe a file that is not a holdings book.
    // And it must be a locator, not a node marked in advance: the app re-renders
    // that section once its holdings finish loading, so a tagged node is
    // detached by the time it is pressed — measured on a runner as a click that
    // produced nothing, then as a scroll that could not find its target.
    const holdingsDownload = page.locator(
      "xpath=//button[normalize-space()='Download']"
      + "[ancestor::*[position() <= 8][starts-with(normalize-space(.), 'Top 10 Holdings')]]",
    );
    await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {});
    // ⚠ THE SECTIONS RENDER ONLY AS THEY SCROLL INTO VIEW. Measured on a runner:
    // the same URL showed the holdings Download on one run and no Download at
    // all on the next, with the page's own chrome intact both times. So open
    // "Portfolio data" the way a reader does, walk the page down, and wait for
    // the button to be visible rather than for a fixed time.
    // A consent banner sits over the bottom of the page on a fresh browser and
    // swallows the press. It is declined — the privacy-preserving answer; nothing
    // here needs a cookie — and the press below is a DOM click besides, so a
    // banner this misses cannot turn into a silent non-download.
    const decline = page.locator('#onetrust-reject-all-handler');
    if (await decline.count()) await decline.click({ timeout: 5000 }).catch(() => {});
    const portfolioTab = page.getByText('Portfolio data', { exact: true }).first();
    if (await portfolioTab.count()) await portfolioTab.click().catch(() => {});
    for (let step = 0; step < 30 && (await holdingsDownload.count()) === 0; step += 1) {
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(400);
    }
    await holdingsDownload.first().waitFor({ state: 'visible', timeout: 60000 }).catch(() => {});
    const count = await holdingsDownload.count();
    if (count !== 1) {
      const seen = await page.evaluate(() => [...document.querySelectorAll('button')]
        .filter((b) => /download/i.test(b.textContent ?? ''))
        .map((b) => {
          const around = [];
          let node = b;
          for (let depth = 1; depth <= 8 && node.parentElement; depth += 1) {
            node = node.parentElement;
            if ([2, 5, 8].includes(depth)) around.push(`${depth}:${(node.innerText ?? '').replace(/\s+/g, ' ').slice(0, 40)}`);
          }
          return `[${JSON.stringify(b.textContent.trim().slice(0, 20))} ${around.join(' / ')}]`;
        }).join(' '));
      const where = await page.evaluate(() => `${location.href} · "${document.title}" · `
        + `${(document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 300)}`).catch((e) => String(e.message));
      throw new Error(`expected exactly one Download inside the holdings section, found ${count} — `
        + `the page has changed shape; look before guessing. Downloads on the page: ${seen.slice(0, 900) || 'none'}. `
        + `Page: ${where}`);
    }
    await holdingsDownload.scrollIntoViewIfNeeded();
    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});

    // ⚠ NOT UNTIL THE LAST PAGE OF THE LOOK-THROUGH HAS ARRIVED. The exporter
    // writes whatever holdings the page holds at the moment of the press, and
    // it loads them 1,500 at a time: pressed early on a runner it handed over
    // exactly three pages, 4,500 rows of 6,486. The final page is the one whose
    // `lastItemKey` is null, and nothing is pressed before it has been seen.
    for (let waited = 0; !lookThrough.finalSeen && waited < 180; waited += 1) {
      await page.waitForTimeout(1000);
    }
    if (!lookThrough.finalSeen) {
      throw new Error(`the page never finished loading its holdings (${lookThrough.pages} page(s) seen, `
        + 'none with a null lastItemKey) — a book built now would be truncated');
    }
    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
    let download;
    try {
      [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 90000 }),
        holdingsDownload.evaluate((button) => button.click()),
      ]);
    } catch (error) {
      throw new Error(`${String(error.message).split('\n')[0]} — ${await explain()}`);
    }
    const path = await download.path();
    return { bytes: readFileSync(path), suggestedName: download.suggestedFilename(), lookThrough };
  } finally {
    await browser.close();
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  process.stdout.write('\nVanguard FTSE EM All Cap (VEE) — the product page\'s own holdings export\n\n');

  const playwright = await loadPlaywright();
  if (!playwright) {
    process.stderr.write('Playwright is not installed globally, so the page cannot be driven. CI installs it\n'
      + 'with `npm install -g playwright && playwright install chromium`; it is never a dependency here.\n\n');
    process.exit(2);
  }

  let fetched;
  try {
    fetched = await downloadBook(playwright);
  } catch (error) {
    process.stderr.write(`Could not obtain the export: ${String(error.message).split('\n')[0]}\n`
      + 'This is a failure to read, NOT a book with no holdings. Nothing written.\n\n');
    process.exit(1);
  }

  const { payload, measured } = await readFtseBook(new Uint8Array(fetched.bytes), (b) => inflateRawSync(b), {
    fixtures: ['scripts/fixtures/vanguard-ftse-em-allcap.xlsx'],
    receivedAs: 'committed fixture',
  });
  const committed = JSON.parse(readFileSync(COMMITTED_BOOK, 'utf8')).funds?.[0] ?? null;
  const expectedFile = JSON.parse(readFileSync(FTSE_EXPECTED_PATH, 'utf8'));

  process.stdout.write(`  received   ${fetched.suggestedName}, ${fetched.bytes.length.toLocaleString('en-US')} bytes\n`
    + `  loaded     ${fetched.lookThrough.pages} look-through page(s) before the press; Vanguard counts `
    + `${fetched.lookThrough.totalHoldings ?? '—'} holdings (cash, FX and swaps included, which the export drops)\n`
    + `  fund       ${measured.name}\n`
    + `  as at      ${measured.holdingsAsOf}   (committed: ${committed?.asOf ?? 'none'})\n`
    + `  stamped    downloaded on ${measured.downloadedOn}\n`
    + `  rows       ${measured.dataRows} in the book, ${measured.indiaRows} India `
    + `(committed: ${committed?.dataRows ?? '—'} / ${committed?.indiaRows ?? '—'})\n`
    + `  India      ${measured.indiaWeightPct3dp}% of the fund\n\n`);

  const problems = [];
  const shape = assertBookShape(measured, { previous: committed });
  for (const check of shape.checks.filter((c) => !c.ok)) problems.push(`${check.label} — ${check.detail}`);
  if (measured.name !== FUND_NAME) problems.push(`names "${measured.name}", not "${FUND_NAME}"`);
  if (committed?.asOf && measured.holdingsAsOf && measured.holdingsAsOf < committed.asOf) {
    problems.push(`as at ${measured.holdingsAsOf}, OLDER than the committed ${committed.asOf}`);
  }
  if (problems.length > 0) {
    process.stderr.write(`REFUSED — this book may not replace the committed one:\n${
      problems.map((p) => `  - ${p}\n`).join('')}\nNothing written.\n\n`);
    process.exit(1);
  }

  if (committed?.asOf === measured.holdingsAsOf) {
    process.stdout.write(`As at ${measured.holdingsAsOf} — already committed. Nothing to write.\n\n`);
    return;
  }
  if (dryRun) {
    process.stdout.write(`--dry-run: a newer book (as at ${measured.holdingsAsOf}) passed every check. Nothing written.\n\n`);
    return;
  }

  writeFileSync(FIXTURE, fetched.bytes);
  expectedFile.measured = measured;
  expectedFile.measuredOn = new Date().toISOString().slice(0, 10);
  writeFileSync(FTSE_EXPECTED_PATH, `${JSON.stringify(expectedFile, null, 2)}\n`, 'utf8');
  process.stdout.write(`Wrote the workbook (as at ${measured.holdingsAsOf}) and re-measured `
    + 'vanguard-ftse-expected.json in the same write. Run scripts/import-ftse.mjs next.\n\n');
  void payload;
}

await main();
