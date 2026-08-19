/**
 * Display formatting. THE conversion edge.
 *
 * Every monetary value in this project is stored in RUPEES and displayed in
 * ₹ CRORE. That conversion happens here and nowhere else — a crore value in a
 * rupee field is a ten-million-fold error that reads as a plausible small
 * number, so exactly one place is allowed to know the factor.
 *
 * MISSING IS NEVER ZERO. Every formatter returns the em dash for null or
 * undefined and never coerces to 0. A missing value that renders as "0.00"
 * sorts, sums and ranks, and will quietly place a company at the bottom of a
 * table it does not belong in at all.
 */

export const EM_DASH = '—';

/** ₹1 crore in rupees. Mirrors public/js/config/thresholds.mjs. */
const RUPEES_PER_CRORE = 1e7;

const isMissing = (value) => value === null || value === undefined || !Number.isFinite(value);

/** A plain number with thousands separators. */
export function num(value, places = 0) {
  if (isMissing(value)) return EM_DASH;
  return value.toLocaleString('en-IN', {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
}

/** Rupees -> a ₹ crore figure, grouped Indian-style. The only conversion point. */
export function cr(rupees, places = 0) {
  if (isMissing(rupees)) return EM_DASH;
  return num(rupees / RUPEES_PER_CRORE, places);
}

/** Rupees -> "₹1,76,938 Cr", for prose and drill panels. */
export function inr(rupees, places = 0) {
  if (isMissing(rupees)) return EM_DASH;
  return `₹${cr(rupees, places)} Cr`;
}

/**
 * Rupees -> a ₹ crore figure whose precision adapts so that a REAL VALUE IS
 * NEVER PRINTED AS ZERO.
 *
 * A flow of ₹1,023,939 is ₹0.1024 Cr. At the fixed no-decimal precision the
 * rest of this screen uses, it renders "₹0 Cr" — and "₹0 Cr" reads as *no
 * flow*, which is the same lie as rendering a missing value as zero. It is
 * only ever a small holding in a tiny company, which is exactly the row a
 * reader is least likely to check.
 *
 * So: keep at least two significant figures, and where even that would round
 * away, say "<₹0.01 Cr" rather than claim a zero. A genuine zero cannot occur
 * here — a flow of nothing is not a flow and never reaches this formatter.
 */
export function inrFlow(rupees) {
  if (isMissing(rupees)) return EM_DASH;
  const crore = Math.abs(rupees) / RUPEES_PER_CRORE;
  if (crore === 0) return '₹0 Cr';
  if (crore < 0.01) return '<₹0.01 Cr';
  const places = crore >= 100 ? 0 : crore >= 10 ? 1 : 2;
  return `₹${num(crore, places)} Cr`;
}

/** A percentage that is already expressed in percent (a weight of 0.68215). */
export function pct(value, places = 3) {
  if (isMissing(value)) return EM_DASH;
  return `${num(value, places)}%`;
}

/** A dimensionless fraction (a float factor of 0.4978) -> "49.78%". */
export function factorPct(value, places = 2) {
  if (isMissing(value)) return EM_DASH;
  return `${num(value * 100, places)}%`;
}

/** A difference in percentage points, signed. */
export function pp(value, places = 2) {
  if (isMissing(value)) return EM_DASH;
  const sign = value > 0 ? '+' : '';
  return `${sign}${num(value, places)} pp`;
}

/** A signed percentage change. */
export function signedPct(value, places = 2) {
  if (isMissing(value)) return EM_DASH;
  return `${value > 0 ? '+' : ''}${num(value, places)}%`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Parse the several date shapes the feeds publish, WITHOUT restamping any of
 * them. Returns a Date or null; a value we cannot read is null, never "now".
 *
 *   "2026-08-17"                ISO date, iShares holdings as-of
 *   "2026-08-19T11:25:03.718Z"  ISO instant, our capture time
 *   "19-Aug-2026 09:07:24"      NSE's own session stamp, carried verbatim
 *   "19 Aug 26 | 16:01"         BSE's own price stamp, carried verbatim
 */
export function parseFeedDate(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const text = value.trim();

  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));

  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/.exec(text);
  if (m) {
    const month = MONTHS.indexOf(m[2][0].toUpperCase() + m[2].slice(1, 3).toLowerCase());
    if (month >= 0) return new Date(Date.UTC(+m[3], month, +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)));
  }

  m = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2})\s*\|\s*(\d{2}):(\d{2})$/.exec(text);
  if (m) {
    const month = MONTHS.indexOf(m[2][0].toUpperCase() + m[2].slice(1, 3).toLowerCase());
    if (month >= 0) return new Date(Date.UTC(2000 + +m[3], month, +m[1], +m[4], +m[5]));
  }

  return null;
}

/** "17 Aug 2026". Null in, em dash out. */
export function shortDate(value) {
  const date = value instanceof Date ? value : parseFeedDate(value);
  if (!date) return EM_DASH;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * "2 days ago". Relative to `now`, which is injectable so this is testable and
 * so a screenshot run can be deterministic.
 */
export function relativeTime(value, now = new Date()) {
  const date = value instanceof Date ? value : parseFeedDate(value);
  if (!date) return EM_DASH;
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
  if (seconds < 0) return 'just now';
  const table = [
    [60, 'second', 1],
    [3600, 'minute', 60],
    [86400, 'hour', 3600],
    [2592000, 'day', 86400],
    [31536000, 'month', 2592000],
    [Infinity, 'year', 31536000],
  ];
  for (const [limit, unit, divisor] of table) {
    if (seconds < limit) {
      const n = Math.floor(seconds / divisor);
      if (unit === 'second' && n < 45) return 'just now';
      return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
    }
  }
  return EM_DASH;
}

/** A signed day change, coloured by the caller. Null in, em dash out. */
export function dayChange(value, places = 2) {
  if (isMissing(value)) return EM_DASH;
  return `${value > 0 ? '+' : ''}${num(value, places)}%`;
}

/** "12s ago" for a live tick — seconds matter here, unlike relativeTime. */
export function tickAge(value, now = new Date()) {
  const date = value instanceof Date ? value : parseFeedDate(value);
  if (!date) return EM_DASH;
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return relativeTime(date, now);
}

/** Pluralise without a hand-typed count anywhere. */
export function plural(count, singular, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}
