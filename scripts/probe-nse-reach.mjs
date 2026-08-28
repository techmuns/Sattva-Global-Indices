/**
 * probe-nse-reach.mjs — what can THIS machine read from NSE? Reports, writes nothing.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 * ---------------------------------------------------------------------------
 * CLAUDE.md §3.7 records that `/api/quote-equity?section=trade_info` — the only
 * NSE surface carrying free-float AND full market cap for the whole listed
 * universe — answers 403 from a server, and that no amount of header or cookie
 * work changes it. That was measured from one machine on one network.
 *
 * The obvious next question is whether the NETWORK is the variable: a GitHub
 * Actions runner has a different egress IP, and NSE's edge is IP-reputation
 * driven. This script exists to answer that with a measurement rather than an
 * opinion, by running the SAME matrix from anywhere and printing the egress IP
 * beside the results so a reading can be attributed to a network.
 *
 * Run it locally and in `.github/workflows/probe-nse.yml`, then compare.
 *
 * ---------------------------------------------------------------------------
 * TWO THINGS THAT ARE NOT OPTIONAL, BOTH LEARNED THE EXPENSIVE WAY (§3.7)
 * ---------------------------------------------------------------------------
 * 1. `curl`, never node's `fetch`. Undici is TLS/HTTP2-fingerprinted and NSE's
 *    edge rejects it whatever headers you send. This is not a header problem
 *    and no amount of header tuning fixes it.
 * 2. `--fail-with-body` alongside `--retry-all-errors`. Without `--fail`, curl
 *    treats an HTTP 403 as a SUCCESSFUL transfer carrying an error page, so
 *    there is nothing for `--retry-all-errors` to retry and the first throttle
 *    reads as a permanent outage. Measured here again while writing this: the
 *    archives host served a 203 KB zip and then 480 bytes of "Access Denied"
 *    to the same command seconds later.
 */

import { execFile } from 'node:child_process';
import { renderTable } from './lib/report.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const SENTINEL = '\n__PROBE_STATUS__';
/** Declared here, not beside its function: TARGETS calls lastWeekdayCompact()
 *  at module evaluation, so a later `const` is in the temporal dead zone. */
const PUBLICATION_HOUR_IST = 18;
const JAR = '/tmp/nse-probe-cookies.txt';

/** One GET, with the retry invocation §3.7 proves is required. Never throws. */
function get(url, { referer = 'https://www.nseindia.com/', jar = null, retries = 3 } = {}) {
  return new Promise((resolve) => {
    const args = [
      '-s', '-S', '--fail-with-body', '--compressed', '-L',
      '--retry', String(retries), '--retry-delay', '6', '--retry-all-errors', '--max-time', '45',
      '-A', UA,
      '-H', `referer: ${referer}`,
      '-H', 'accept: */*',
      '-H', 'accept-language: en-US,en;q=0.9',
      ...(jar ? ['-b', jar, '-c', jar] : []),
      '-w', `${SENTINEL}%{http_code}|%{content_type}|%{size_download}`,
      url,
    ];
    execFile('curl', args, { maxBuffer: 128 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (!stdout) {
        resolve({ status: 0, bytes: 0, body: '', reason: String(stderr || error?.message || 'no output').split('\n')[0] });
        return;
      }
      const at = stdout.lastIndexOf(SENTINEL);
      if (at === -1) { resolve({ status: 0, bytes: 0, body: stdout, reason: 'no status line' }); return; }
      const [status, contentType, size] = stdout.slice(at + SENTINEL.length).split('|');
      resolve({
        status: Number.parseInt(status, 10),
        contentType: (contentType ?? '').split(';')[0],
        bytes: Number(size),
        body: stdout.slice(0, at),
      });
    });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * THE PRIZE, described so nobody has to re-derive why it matters.
 *
 * `verdict` is what a 200 on that row would actually buy us — not merely
 * "reachable". A probe that reports reachability without saying what the
 * reachable thing contains invites someone to build on a 200 that carries
 * prices when they needed market caps.
 */
const TARGETS = [
  {
    group: 'The prize',
    what: 'quote-equity trade_info (ffmc + full mcap, ALL companies)',
    url: 'https://www.nseindia.com/api/quote-equity?symbol=RELIANCE&section=trade_info',
    referer: 'https://www.nseindia.com/get-quotes/equity?symbol=RELIANCE',
    warm: true,
    verdict: 'BOTH numbers for the whole universe — this is the only NSE surface that has them',
  },
  {
    group: 'The prize',
    what: 'quote-equity, no section, warmed cookies',
    url: 'https://www.nseindia.com/api/quote-equity?symbol=RELIANCE',
    referer: 'https://www.nseindia.com/get-quotes/equity?symbol=RELIANCE',
    warm: true,
    verdict: 'same family; sometimes answers when the sectioned form does not',
  },
  {
    group: 'Known good',
    what: 'pre-open FO (free float, 261 names)',
    url: 'https://www.nseindia.com/api/market-data-pre-open?key=FO',
    verdict: 'free float only, and only ~261 symbols — what the repo already uses',
  },
  {
    group: 'Archives host',
    what: 'EQUITY_L.csv (every listed security)',
    url: 'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv',
    referer: 'https://www.nseindia.com/all-reports',
    verdict: 'symbols, ISINs, listing dates — NO market cap',
  },
  {
    group: 'Archives host',
    what: 'UDiFF bhavcopy (whole market, one day)',
    url: `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${lastWeekdayCompact()}_F_0000.csv.zip`,
    referer: 'https://www.nseindia.com/all-reports',
    verdict: 'NSE closing PRICES for ~3,650 instruments — no market cap columns',
  },
  {
    group: 'Archives host',
    what: 'sec_bhavdata_full (delivery data)',
    url: `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${lastWeekdayDMY()}.csv`,
    referer: 'https://www.nseindia.com/all-reports',
    verdict: 'traded value and delivery — no market cap',
  },
  {
    group: 'niftyindices',
    what: 'nifty500 constituents',
    url: 'https://www.niftyindices.com/IndexConstituent/ind_nifty500list.csv',
    referer: 'https://www.niftyindices.com/',
    verdict: 'the ISIN bridge the repo already depends on — no market cap',
  },
];

/**
 * YYYYMMDD for the most recent session an exchange could have PUBLISHED for.
 *
 * THE FIRST VERSION OF THIS FUNCTION WAS WRONG, IN THE SAME WAY AND ON THE SAME
 * DAY AS THE ONE IN fetch-bhavcopy.mjs. It read the UTC weekday and never the
 * IST clock, so the 02:26 UTC run — 07:58 IST — asked for that Friday's files
 * before that Friday had traded. NSE answered 404 and the probe reported it as
 * "archives host: 404", which reads as a finding about NSE and was a finding
 * about this function.
 *
 * A probe that misattributes its own bug to the thing it is probing is worse
 * than no probe, because the wrong conclusion arrives wearing evidence.
 *
 * Same fix and same reasoning as fetch-bhavcopy.mjs: before the publication hour
 * in IST, the newest available session is the previous one.
 */
function lastWeekdayCompact() {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  if (ist.getUTCHours() < PUBLICATION_HOUR_IST) ist.setUTCDate(ist.getUTCDate() - 1);
  while (ist.getUTCDay() === 0 || ist.getUTCDay() === 6) ist.setUTCDate(ist.getUTCDate() - 1);
  return ist.toISOString().slice(0, 10).replace(/-/g, '');
}
/** DDMMYYYY for the same day. */
function lastWeekdayDMY() {
  const iso = lastWeekdayCompact();
  return `${iso.slice(6, 8)}${iso.slice(4, 6)}${iso.slice(0, 4)}`;
}

const heading = (text) => process.stdout.write(`\n${text}\n${'='.repeat(text.length)}\n\n`);

async function main() {
  heading('NSE reachability probe');

  // WHERE this ran from. Without it the results cannot be attributed to a
  // network, and attributing them to a network is the entire point.
  const ip = await get('https://api.ipify.org?format=json', { referer: '', retries: 1 });
  let egress = 'unknown';
  try { egress = JSON.parse(ip.body).ip; } catch { /* leave unknown */ }
  process.stdout.write(`Egress IP : ${egress}\n`);
  process.stdout.write(`Runner    : ${process.env.GITHUB_ACTIONS ? `GitHub Actions (${process.env.RUNNER_OS})` : 'local / container'}\n`);
  process.stdout.write(`Started   : ${new Date().toISOString()}\n`);
  process.stdout.write('Transport : curl (node fetch is TLS-fingerprinted and 403s — CLAUDE.md §3.7)\n\n');

  // Warm a cookie jar once, from the homepage. If the homepage itself is
  // blocked that IS the finding, and it is reported rather than swallowed.
  const home = await get('https://www.nseindia.com/', { jar: JAR, referer: 'https://www.google.com/' });
  process.stdout.write(`Cookie warm-up: homepage HTTP ${home.status}`
    + `${home.status === 200 ? '' : ' — no cookie jar, which is itself a result'}\n\n`);
  await wait(1500);

  const rows = [];
  for (const target of TARGETS) {
    const result = await get(target.url, {
      referer: target.referer ?? 'https://www.nseindia.com/',
      jar: target.warm ? JAR : null,
    });
    rows.push({
      Group: target.group,
      Surface: target.what,
      HTTP: result.status === 0 ? `ERR ${result.reason ?? ''}`.slice(0, 18) : String(result.status),
      Bytes: result.bytes,
      Type: result.contentType ?? '',
    });
    process.stdout.write(`  ${result.status === 200 ? '✓' : '✗'} ${String(result.status).padEnd(4)} ${target.what}\n`);
    await wait(2000);
  }

  process.stdout.write('\n');
  process.stdout.write(renderTable([
    { key: 'Group', label: 'Group' },
    { key: 'Surface', label: 'Surface' },
    { key: 'HTTP', label: 'HTTP', align: 'right' },
    { key: 'Bytes', label: 'Bytes', align: 'right' },
    { key: 'Type', label: 'Content type' },
  ], rows));
  process.stdout.write('\n');

  process.stdout.write('\nWhat a 200 on each row would actually buy:\n');
  for (const target of TARGETS) {
    process.stdout.write(`  · ${target.what}\n      ${target.verdict}\n`);
  }

  const prize = rows.filter((r) => r.Group === 'The prize');
  const gotPrize = prize.some((r) => r.HTTP === '200');
  process.stdout.write('\n');
  heading('Verdict');
  if (gotPrize) {
    process.stdout.write(
      'quote-equity ANSWERED from this network. That is a change from the recorded\n'
      + 'finding and it is the surface carrying free-float AND full market cap for every\n'
      + 'company. Re-measure coverage and throughput before building on it: one 200 is\n'
      + 'not a rate limit, and CLAUDE.md §3.7 records NSE throttling the same machine\n'
      + 'seconds apart.\n',
    );
  } else {
    process.stdout.write(
      'quote-equity is BLOCKED from this network too, so the recorded finding holds and\n'
      + 'the block is not specific to one machine. No other NSE surface carries market\n'
      + 'cap for the whole universe: the archives host serves prices and identifiers, the\n'
      + 'pre-open API serves free float for ~261 names, and neither carries full market\n'
      + 'cap. BSE remains the only source that covers the listed universe.\n',
    );
  }
  process.stdout.write('\nThis script writes nothing.\n\n');
}

main().catch((error) => {
  process.stderr.write(`\nprobe-nse-reach crashed: ${error.stack}\n\n`);
  process.exit(2);
});
