/**
 * calendar.js — the MSCI review calendar.
 *
 * ---------------------------------------------------------------------------
 * EVERYTHING HERE IS AN ASSUMPTION AND IS LABELLED AS ONE
 * ---------------------------------------------------------------------------
 * MSCI reviews quarterly in February, May, August and November — that much is
 * public and stable. But the exact effective date within the month, and the
 * price-snapshot convention the cut-offs are struck against, are NOT things
 * this project can cite. MSCI announces results ahead of an effective date and
 * uses a snapshot period the desk should confirm.
 *
 * So the dates below are a placeholder convention, every surface that shows
 * them says "assumed", and correcting them is a one-line edit here. Do not
 * hard-code a convention you cannot cite, and do not let a plausible date
 * harden into an apparent fact by being rendered without its caveat.
 */

/** Quarterly review months, 1-based. This much is public. */
export const REVIEW_MONTHS = [2, 5, 8, 11];

/**
 * ASSUMED convention, pending confirmation from the desk:
 *   - results are effective at the close of the LAST BUSINESS DAY of the month;
 *   - the size cut-offs are struck against a price snapshot in the weeks before.
 */
export const CONVENTION = {
  effective: 'last business day of the review month',
  snapshot: 'a price snapshot in the weeks before the announcement — exact window unconfirmed',
  confirmed: false,
  attribution:
    'An assumed convention, not a cited MSCI rule. MSCI publishes review results ahead of an '
    + 'effective date; the desk should confirm both the date and the snapshot window.',
};

/** Last business day (Mon–Fri) of a month, in UTC. No holiday calendar. */
function lastBusinessDay(year, month) {
  const date = new Date(Date.UTC(year, month, 0)); // day 0 of next month = last of this
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return date;
}

/** The review a date falls before, and how long until it. */
export function nextReview(now = new Date()) {
  const year = now.getUTCFullYear();
  const candidates = [];
  for (const y of [year, year + 1]) {
    for (const month of REVIEW_MONTHS) candidates.push({ month, year: y, date: lastBusinessDay(y, month) });
  }
  const upcoming = candidates
    .filter((c) => c.date.getTime() > now.getTime())
    .sort((a, b) => a.date - b.date)[0] ?? null;

  if (!upcoming) return null;

  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const daysRemaining = Math.ceil((upcoming.date.getTime() - now.getTime()) / 86400000);

  return {
    month: upcoming.month,
    year: upcoming.year,
    monthName: MONTH_NAMES[upcoming.month - 1],
    // ISO date of the ASSUMED effective day.
    effectiveDate: upcoming.date.toISOString().slice(0, 10),
    daysRemaining,
    label: `${MONTH_NAMES[upcoming.month - 1]} ${upcoming.year}`,
    assumed: true,
    convention: CONVENTION,
  };
}

/** Every review in a window, for a timeline. */
/**
 * The most recent review whose effective date has passed.
 *
 * The window that matters for a size cut-off. MSCI set its cut-offs at the last
 * review from the universe as it stood then; a company must clear the NEXT
 * review's cut-off, which will be set from the universe as it stands then. How
 * far the segment has moved between those two moments is the correction the
 * desk's fixed rupee bands cannot see on their own.
 *
 * Same assumed convention as nextReview(), and just as unconfirmed.
 */
export function previousReview(now = new Date()) {
  const year = now.getUTCFullYear();
  const candidates = [];
  for (const y of [year - 1, year]) {
    for (const month of REVIEW_MONTHS) {
      const effective = lastBusinessDay(y, month);
      if (effective.getTime() <= now.getTime()) candidates.push({ year: y, month, effective });
    }
  }
  if (candidates.length === 0) return null;
  const latest = candidates.reduce((a, b) => (a.effective.getTime() >= b.effective.getTime() ? a : b));
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return {
    month: latest.month,
    year: latest.year,
    monthName: MONTH_NAMES[latest.month - 1],
    effectiveDate: latest.effective.toISOString().slice(0, 10),
    daysSince: Math.round((now.getTime() - latest.effective.getTime()) / 86400000),
    label: `${MONTH_NAMES[latest.month - 1]} ${latest.year}`,
    assumed: true,
    convention: CONVENTION,
  };
}

export function upcomingReviews(now = new Date(), count = 4) {
  const out = [];
  let cursor = now;
  for (let i = 0; i < count; i += 1) {
    const next = nextReview(cursor);
    if (!next) break;
    out.push(next);
    cursor = new Date(Date.parse(`${next.effectiveDate}T23:59:59Z`));
  }
  return out;
}
