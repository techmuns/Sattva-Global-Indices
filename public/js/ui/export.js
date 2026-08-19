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
      'Weights belong to one fund only.',
      'A weight is a percentage of the fund named in its column heading. The three funds have different denominators, ' +
        'so weights must never be summed, averaged or ranked across columns. An empty weight cell means NOT HELD by that fund — it is not a zero weight.',
    ],
    [
      'Free float is an exchange-published figure.',
      'Each row states whether its free float came from NSE or BSE; the two exchanges apply different float definitions and do not agree. ' +
        'It is never computed from promoter holding. Free-float market cap is derived as float factor x full market cap unless the row says otherwise.',
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
