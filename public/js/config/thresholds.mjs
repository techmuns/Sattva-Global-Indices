/**
 * Every threshold this project uses. One module, no exceptions.
 *
 * ---------------------------------------------------------------------------
 * THESE ARE THE DESK'S HEURISTICS. MSCI DOES NOT PUBLISH THEM.
 * ---------------------------------------------------------------------------
 * MSCI derives its size cut-offs globally at each quarterly review from the
 * investable universe of the day; the rupee figures below are a rule of thumb
 * that has worked for this desk. They are useful. They are not the rule, and
 * nothing in this codebase may print them as though MSCI published them.
 *
 * Any screen that uses one of these must say so in words the reader will see —
 * "the desk's cut-off, not MSCI's published rule". See CLAUDE.md §2.2.
 *
 * Values live here as RUPEES because every monetary field in this project is
 * rupees. The `Cr` helpers exist so the numbers can be *written* the way the
 * desk says them out loud without a hand-typed 1e7 anywhere.
 */

/** ₹1 crore = 10,000,000 rupees. The only place this constant is written. */
export const RUPEES_PER_CRORE = 1e7;

/** Crore -> rupees. */
export const crore = (value) => value * RUPEES_PER_CRORE;

/** Rupees -> crore, for display only. */
export const toCrore = (rupees) => rupees / RUPEES_PER_CRORE;

/**
 * Free-float market cap bands the desk works to for the quarterly MSCI review.
 *
 * Source: the desk's own experience of past reviews, not an MSCI publication.
 * The desk quotes inclusion as "roughly ₹3,500–4,000 Cr" and exclusion as
 * "below ₹2,000–2,400 Cr", so both are ranges, not points. Anything that
 * renders a single number from these must show the band it came from.
 */
export const REVIEW_THRESHOLDS = {
  attribution:
    "the desk's own heuristic from past MSCI reviews — MSCI does not publish these cut-offs",

  inclusion: {
    /** Below this, the desk does not consider a name an inclusion candidate. */
    lowInr: crore(3500),
    /** Above this, the desk treats inclusion as materially likely. */
    highInr: crore(4000),
    label: '₹3,500–4,000 Cr free-float market cap',
  },

  exclusion: {
    /** Below this, the desk treats exclusion as materially likely. */
    lowInr: crore(2000),
    /** Above this, the desk stops worrying about exclusion. */
    highInr: crore(2400),
    label: '₹2,000–2,400 Cr free-float market cap',
  },
};

/**
 * The universe we bother to price at all.
 *
 * Set to the bottom of the desk's exclusion band: a company below this is not
 * an inclusion candidate and is already out of the exclusion conversation, so
 * spending a request on it every month buys nothing. This selects the scrips
 * `scripts/scrape-bse-freefloat.mjs` fetches, on top of everything the funds
 * actually hold (which is always fetched regardless of size — a name the funds
 * hold is in scope no matter how small it has become).
 *
 * NOTE: applied to FULL market cap from the BSE scrip master, because that is
 * what is available before any per-scrip request is made. The desk's band is
 * about FREE-FLOAT market cap, so this filter is deliberately looser than the
 * band it is derived from — it must never exclude a company that could clear
 * the free-float test, and full mcap >= free-float mcap always.
 */
export const SCRAPE_UNIVERSE_MIN_FULL_MCAP_INR = REVIEW_THRESHOLDS.exclusion.lowInr;

/**
 * How far NSE and BSE may disagree on a company's float factor before we treat
 * the gap as something other than a definitional difference.
 *
 * The two exchanges apply slightly different float definitions and a gap of
 * around 1% is expected and normal (RELIANCE: 0.4978 NSE vs 0.4926 BSE).
 * Beyond this, a human should look: it is more likely a stale share count, a
 * corporate action one exchange has processed and the other has not, or a
 * mis-resolved company than a genuine definitional gap.
 *
 * The desk's number, chosen to be loose enough not to cry wolf. Not a
 * published tolerance from anybody.
 */
export const FLOAT_FACTOR_DISAGREEMENT_REVIEW_PCT = 5;
