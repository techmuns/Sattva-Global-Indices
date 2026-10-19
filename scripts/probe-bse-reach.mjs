#!/usr/bin/env node
/**
 * probe-bse-reach.mjs — does every BSE endpoint the pipeline reads answer THIS
 * machine, with the headers the pipeline actually sends?
 *
 *   node scripts/probe-bse-reach.mjs
 *
 * Writes nothing. Exits 1 if any endpoint does not answer with real data.
 *
 * It exists because for four weeks in Sep–Oct 2026 the only evidence that BSE's
 * edge had started refusing our requests was a daily-refresh log whose first
 * step said `HTTP 403 after 4 retries`, and the obvious reading — "BSE blocks
 * datacentre IPs" — was wrong: a residential line got the same 403, and a
 * browser got 200. Every request here goes through the same transport and the
 * same BROWSER_HEADERS as the fetchers, so a red line here is a red line there.
 */

import {
  bseGet, SCRIP_MASTER_URL, stockTradingUrl, scripHeaderUrl, comHeaderUrl,
  USER_AGENT,
} from './lib/bse.mjs';
import { bhavcopyUrl } from './lib/bhavcopy.mjs';

const API = 'https://api.bseindia.com/BseIndiaAPI/api';
const RELIANCE = '500325';

/** The newest weekday on or before today, as YYYY-MM-DD — enough to probe a bhavcopy. */
function recentWeekday(back = 1) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - back);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const probes = [
  { name: 'scrip master (ListofScripData)', run: () => bseGet(SCRIP_MASTER_URL),
    real: (j) => Array.isArray(j) && j.length > 1000, show: (j) => `${j.length} scrips` },
  { name: 'free float (StockTrading)', run: () => bseGet(stockTradingUrl(RELIANCE)),
    real: (j) => typeof j?.MktCapFF === 'string' && j.MktCapFF !== '', show: (j) => `MktCapFF ${j.MktCapFF} Cr` },
  { name: 'scrip header (getScripHeaderData)', run: () => bseGet(scripHeaderUrl(RELIANCE)),
    real: (j) => j && typeof j === 'object' && Object.keys(j).length > 0, show: () => 'object' },
  { name: 'company header (ComHeadernew)', run: () => bseGet(comHeaderUrl(RELIANCE)),
    real: (j) => j && typeof j === 'object' && Object.keys(j).length > 0, show: () => 'object' },
  { name: 'corporate actions (DefaultData)', run: () => bseGet(`${API}/DefaultData/w?scripcode=${RELIANCE}`),
    real: (j) => Array.isArray(j) && j.length > 0, show: (j) => `${j.length} actions` },
];

async function probeBhavcopy() {
  // A non-session answers with BSE's SPA shell, so walk back a few weekdays
  // until one is a CSV; four misses in a row is an outage, not a holiday.
  for (let back = 1; back <= 4; back += 1) {
    const date = recentWeekday(back);
    try {
      const response = await fetch(bhavcopyUrl(date), {
        // The download host is not the API edge: the fetchers send a UA and a
        // referer here and nothing more, so the probe does too.
        headers: { 'user-agent': USER_AGENT, referer: 'https://www.bseindia.com/' },
        signal: AbortSignal.timeout(30000),
      });
      const text = await response.text();
      if (response.ok && /^\s*TradDt,/i.test(text)) return { ok: true, detail: `${date}, ${text.length} bytes` };
    } catch { /* try the previous weekday */ }
  }
  return { ok: false, detail: 'no CSV for any of the last four weekdays' };
}

const failed = [];
process.stdout.write('\nBSE reachability — the headers the pipeline sends, from this machine\n\n');
for (const probe of probes) {
  const result = await probe.run();
  const good = result.ok && probe.real(result.json);
  if (!good) failed.push(probe.name);
  const detail = !result.ok ? result.reason : good ? probe.show(result.json) : 'answered, but not with data';
  process.stdout.write(`  ${good ? 'ok  ' : 'FAIL'}  ${probe.name.padEnd(36)} ${detail}\n`);
}
const bhav = await probeBhavcopy();
if (!bhav.ok) failed.push('bhavcopy');
process.stdout.write(`  ${bhav.ok ? 'ok  ' : 'FAIL'}  ${'bhavcopy (www.bseindia.com/download)'.padEnd(36)} ${bhav.detail}\n\n`);

if (failed.length > 0) {
  process.stdout.write(
    `${failed.length} endpoint(s) did not answer with data. Compare BROWSER_HEADERS in scripts/lib/bse.mjs\n`
    + 'with the request a browser sends from bseindia.com before assuming an IP block.\n\n',
  );
  process.exit(1);
}
process.stdout.write('Every BSE endpoint the pipeline reads answered with data.\n\n');
