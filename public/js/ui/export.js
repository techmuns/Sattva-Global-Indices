/**
 * CSV export with a provenance banner.
 *
 * A workbook leaves the page without any of its chrome. It is the one artefact
 * nobody can see a caption on, and the one most likely to be forwarded to
 * somebody who never saw the screen. So the disclosure that lives in the
 * interface has to travel inside the file itself: rows 1–3 carry the as-of
 * dates, the warning that weights belong to named funds and are not comparable
 * across them, and the fact that free float is NSE's or BSE's published figure
 * per row.
 *
 * THE EXPORT READS THE ARRAY, NEVER THE DOM. Rows stream into the table after
 * first paint, so a DOM-derived export would silently truncate to whatever had
 * been painted when the button was pressed — and would look complete.
 */

import { shortDate } from '../core/format.js';

/**
 * RFC 4180 field escaping, plus a leading apostrophe for anything a spreadsheet
 * would evaluate as a formula. `=cmd|...` in a CSV is a real attack on whoever
 * opens it; our data is our own, but a company name beginning with `+` or `-`
 * is not exotic and would silently become a formula error in Excel.
 */
function csvField(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

const csvRow = (cells) => cells.map(csvField).join(',');

/**
 * Build the banner rows.
 * @param {{feeds: Array<{label,raw,date}>, oldest: object|null}} freshness
 */
export function provenanceBanner(freshness, { scopeLabel, filterLabel } = {}) {
  const dates = freshness.feeds
    .map((feed) => `${feed.label}: ${feed.raw ? shortDate(feed.date ?? feed.raw) : 'no reading'}`)
    .join('; ');

  const governing = freshness.oldest
    ? ` The oldest of these, ${freshness.oldest.label}, governs how current this file is.`
    : '';

  return [
    [
      'Sattva Index Flows — company screener export.',
      `As-of dates — ${dates}.${governing}`,
    ],
    [
      'VERDICTS ARE MODELLED BY US. They are not MSCI\'s decision and not probabilities.',
      'Each verdict is a label produced by rules we wrote, run against the desk\'s own inclusion and exclusion bands and '
        + 'against the segment boundary observed in the current constituents. MSCI derives its size cut-offs globally at each '
        + 'quarterly review and does not publish them in advance. The "Rules fired" and "Threshold source" columns carry the '
        + 'whole derivation for every row; a verdict with a quarantined share count is reported as Unknown rather than guessed. '
        + 'Flow figures are estimates except where the column says the position size was measured from the holdings file.',
    ],
    [
      'Weights belong to one fund only.',
      'A weight is a percentage of the fund named in its column heading. The three funds have different denominators, ' +
        'so weights must never be summed, averaged or ranked across columns. An empty weight cell means NOT HELD by that fund — it is not a zero weight.',
    ],
    [
      'Free float is an exchange-published figure.',
      'Each row states whether its free float came from NSE or BSE; the two exchanges apply different float definitions and do not agree. ' +
        'It is never computed from promoter holding. Free-float market cap is recomputed as float factor x shares outstanding x the price in force.',
    ],
    [
      'Prices name their exchange and their tier.',
      'A "live" price is an intraday NSE quote; an "eod" price is the committed BSE close; a "stale" price is a close carried forward because ' +
        'the stock did not trade, with the day count in its own column — that is NOT the same as unchanged. NSE and BSE are different exchanges ' +
        'and do not agree to the paisa, so a figure that moved may reflect the source changing rather than the stock.',
    ],
    [
      'Weight drift requires no trade.',
      'The drift columns show how far a weight has moved on price alone since the holdings date. An index fund holds each member in proportion ' +
        'to its weight, so a price move changes both by the same proportion and forces no trade. Drift is never multiplied by AUM, and this file ' +
        'contains no rupee flow figure.',
    ],
    [
      'Relative performance is a MEASUREMENT beside the verdict, not an input to it.',
      'The "vs segment" columns compare a company\'s ten-day mean close across MSCI\'s price window against the same ten days of its '
        + 'segment benchmark in rupees, compared geometrically as (1 + stock) / (1 + index) - 1 — NOT the arithmetic difference of the two. '
        + 'The benchmark is INDA for Standard and SMIN for Small Cap, because the fund that HOLDS a stock is not the index that decides its '
        + 'segment: EEM is about 11% India and its return is mostly a statement about somewhere else. It is the ETF, not the index. '
        + 'MSCI prices on one of the ten business days and does not publish which, so the "across all ten days" columns give the full span '
        + 'of what the answer could have been — measured across the universe that span is 14.7 pp wide at the median and crosses zero for '
        + '31.4% of companies. A direction is claimed ONLY where the whole span clears the desk\'s band, and the "direction robust" column '
        + 'says so per row. Closes are unadjusted BSE figures; where a corporate action fell between the windows the earlier window is '
        + 'divided by the factor BSE published, and the action and factor travel in their own columns. An empty cell is a STATED reason, '
        + 'carried in the "no reading because" column — never a zero, and never comparable with a real reading.',
    ],
    [
      'There are TWO relative-performance families in this file, over two different windows.',
      'The "vs segment" columns are measured across MSCI\'s two ten-day PRICE windows — the days MSCI struck the '
        + 'market caps that decided each review. The "since <date>" columns are measured from the day a review took '
        + 'EFFECT and every tracking fund traded, which is roughly six weeks later, to the latest committed close. '
        + 'Measured on the record they disagree about the SIGN for 27.8% of companies, so neither is a substitute for '
        + 'the other and they must never be summed, averaged or compared with each other. Both are geometric — '
        + '(1 + stock) / (1 + index) - 1, NOT the arithmetic difference of the two legs beside them, so the three '
        + 'columns in each family will not add up and are not meant to. Both carry a direction ONLY where their own '
        + 'robustness column says the direction survives their own uncertainty test, and both are EVIDENCE BESIDE A '
        + 'VERDICT, never an input to one: a verdict turns on a rank by free-float market cap, which already contains '
        + 'every price move these columns measure.',
    ],
    [
      'Flow pressure is a direction, not a flow, and it forces no trade.',
      'A rising weight forces no trade at all — an index fund holds each member in proportion to its weight, so a '
        + 'price move changes both by the same proportion. The flow-pressure column says which way the NEXT review\'s '
        + 'forced trade would point if the trend held; it is not money moving today and it carries no rupee figure. '
        + 'It changes no verdict in this file.',
    ],
    [`Rows in this file: ${scopeLabel ?? 'as filtered on screen'}.`, filterLabel ?? ''],
  ];
}

/**
 * Serialise and download.
 * @param {{filename, columns: Array<{label, value(row)}>, rows: Array, freshness, scopeLabel, filterLabel}} config
 */
export function exportCsv({ filename, columns, rows, freshness, scopeLabel, filterLabel }) {
  const lines = [];

  for (const banner of provenanceBanner(freshness, { scopeLabel, filterLabel })) {
    lines.push(csvRow(banner));
  }
  lines.push('');
  lines.push(csvRow(columns.map((c) => c.label)));

  for (const row of rows) {
    lines.push(csvRow(columns.map((c) => c.value(row))));
  }

  // BOM so Excel reads the ₹ sign and the em dash as UTF-8.
  const blob = new Blob([`﻿${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);

  return { lineCount: lines.length, rowCount: rows.length };
}
