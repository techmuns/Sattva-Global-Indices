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
 * The review convention — now MSCI's published rule, not our assumption.
 *
 * This block used to read "exact window unconfirmed". It is confirmed. MSCI GIMI
 * Methodology, August 2026, p. 49 sets three cutoff dates per review:
 *
 *   Equity Universe cutoff   last business day of the month THREE months before
 *   Liquidity cutoff         last business day of the month TWO months before
 *   PRICE cutoff             ANY ONE of the last 10 business days of the month
 *                            BEFORE the review month
 *
 * ⚠ The price cutoff is the one that matters here and it is EARLIER THAN MOST
 * PEOPLE ASSUME. The market caps that decide the August review are struck
 * somewhere in the last 10 business days of JULY — and MSCI does not disclose
 * which of those ten days it picked. So for a review already announced, a
 * verdict computed on today's price is answering a question MSCI stopped asking
 * weeks ago.
 *
 * Effective date: MSCI's own worked examples describe the new composition as
 * effective on the first business day of the following month ("the effective
 * date of the May 2017 Index Review" is 1 June 2017, p. 17). That is the same
 * moment as the close of the last business day of the review month, seen from
 * the other side — and the close is when a tracking fund actually trades. We
 * keep the trade-side date because this product is about forced trades.
 *
 * All four reviews have been comprehensive since the February 2023 review
 * (p. 152). Before that, May and November were Semi-Annual Index Reviews and
 * February and August were lighter Quarterly Index Reviews. Treating all four
 * alike is right for the current book and wrong for anything historical.
 */
export const CONVENTION = {
  effective: 'last business day of the review month (MSCI states the following business day; '
    + 'the close of the last business day is when a tracking fund trades)',
  snapshot: 'any one of the last 10 business days of the month before the review month — '
    + 'MSCI does not disclose which day it used',
  confirmed: true,
  source: 'MSCI GIMI Methodology, August 2026, p. 49',
  attribution:
    "MSCI's published rule, read from the methodology book on 24 Aug 2026. The price cutoff "
    + 'window is exact; which of the ten days MSCI picked is deliberately not published, so the '
    + 'snapshot price itself remains unknown to us.',
};

/**
 * The three data cutoffs for a review month, as dates. (GIMI p. 49)
 *
 * `price.from`/`price.to` bound the ten-business-day window MSCI drew its prices
 * from. We cannot know which day inside it was used — so anything rendering this
 * shows the WINDOW, never a single date dressed up as the snapshot.
 */
export function reviewCutoffs(year, month) {
  const monthsBefore = (n) => {
    let m = month - n;
    let y = year;
    while (m <= 0) { m += 12; y -= 1; }
    return { y, m };
  };
  const eu = monthsBefore(3);
  const liq = monthsBefore(2);
  const px = monthsBefore(1);
  const lastPx = lastBusinessDay(px.y, px.m);

  // Walk back nine further business days to open the ten-day window.
  const from = new Date(lastPx.getTime());
  let counted = 1;
  while (counted < 10) {
    from.setUTCDate(from.getUTCDate() - 1);
    const day = from.getUTCDay();
    if (day !== 0 && day !== 6) counted += 1;
  }

  return {
    equityUniverse: lastBusinessDay(eu.y, eu.m).toISOString().slice(0, 10),
    liquidity: lastBusinessDay(liq.y, liq.m).toISOString().slice(0, 10),
    price: {
      from: from.toISOString().slice(0, 10),
      to: lastPx.toISOString().slice(0, 10),
      note: 'MSCI used one of the business days in this window and does not say which',
    },
    source: 'MSCI GIMI Methodology, August 2026, p. 49',
  };
}

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

/**
 * The last `count` reviews whose effective date has passed, newest first.
 *
 * ---------------------------------------------------------------------------
 * ⚠ THIS IS THE REBALANCE DATE, NOT THE PRICE WINDOW
 * ---------------------------------------------------------------------------
 * `reviewCutoffs().price` is the ten-day window MSCI struck its market caps in —
 * the last ten business days of the month BEFORE the review month. This is a
 * different date and answers a different question: the day the new composition
 * took effect and every tracking fund actually traded.
 *
 * For the May 2026 review those are 17–30 April (prices) and 29 May (effective).
 * Six weeks apart. A reading baselined on one and labelled with the other would
 * be measuring a window nobody asked about.
 *
 * `asOfDate` is an ISO date, and it is the newest session the exchange has
 * actually served — never the clock. A review whose effective date is in the
 * future has no close and cannot be a baseline.
 */
export function closedReviews(asOfDate, count = 4) {
  if (!asOfDate) return [];
  const [y0] = asOfDate.split('-').map(Number);
  if (!Number.isFinite(y0)) return [];
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const out = [];
  for (let year = y0 - 4; year <= y0; year += 1) {
    for (const month of REVIEW_MONTHS) {
      const effective = lastBusinessDay(year, month).toISOString().slice(0, 10);
      if (effective > asOfDate) continue;
      out.push({
        review: `${year}-${String(month).padStart(2, '0')}`,
        year,
        month,
        monthName: MONTH_NAMES[month - 1],
        label: `${MONTH_NAMES[month - 1]} ${year}`,
        effectiveDate: effective,
        assumed: true,
        convention: CONVENTION,
      });
    }
  }
  out.sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));
  return out.slice(0, count);
}
