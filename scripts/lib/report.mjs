/**
 * Console table + number formatting for the data scripts. Zero dependencies.
 *
 * These scripts are run by hand and read by a human deciding whether to trust
 * the output, so the run log is part of the deliverable, not decoration.
 */

/** Round to `places` decimals, returning a number (not a string). */
export function round(value, places) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Thousands separators; `null`/`undefined` render as an em dash, never as 0. */
export function num(value, places = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
}

/**
 * Render a fixed-width table.
 * @param {Array<{key: string, label: string, align?: 'left'|'right'}>} columns
 * @param {Array<Object>} rows
 */
export function renderTable(columns, rows) {
  const cells = rows.map((row) =>
    columns.map((col) => {
      const value = row[col.key];
      return value === null || value === undefined ? '—' : String(value);
    }),
  );
  const widths = columns.map((col, i) =>
    Math.max(col.label.length, ...cells.map((row) => row[i].length), 1),
  );
  const pad = (text, width, align) =>
    align === 'right' ? text.padStart(width) : text.padEnd(width);

  const lines = [];
  lines.push(columns.map((col, i) => pad(col.label, widths[i], col.align)).join('  '));
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of cells) {
    lines.push(columns.map((col, i) => pad(row[i], widths[i], col.align)).join('  '));
  }
  return lines.join('\n');
}

/**
 * Collects pass/fail assertions so a run can report EVERY drift at once rather
 * than dying on the first one. A half-reported failure sends you round the loop
 * three times for three problems that were all visible on the first run.
 */
export class CheckList {
  constructor(label) {
    this.label = label;
    this.entries = [];
  }

  /** @param {boolean} ok @param {string} what @param {string} detail */
  assert(ok, what, detail) {
    this.entries.push({ ok: Boolean(ok), what, detail });
    return Boolean(ok);
  }

  equal(actual, expected, what) {
    return this.assert(
      actual === expected,
      what,
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }

  get failures() {
    return this.entries.filter((e) => !e.ok);
  }

  get passed() {
    return this.failures.length === 0;
  }

  print(stream = process.stderr) {
    for (const entry of this.failures) {
      stream.write(`  FAIL  [${this.label}] ${entry.what} — ${entry.detail}\n`);
    }
  }
}
