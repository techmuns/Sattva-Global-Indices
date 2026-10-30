/**
 * Did this run keep what the last one held? One answer, for every writer whose
 * universe is BSE's active master.
 *
 * ⚠ THIS GUARD HAS NOW BEEN WRITTEN WRONG IN FOUR FILES.
 *
 * Every one of them compared two totals and refused when the new one was
 * smaller. The universe here churns daily as BSE suspends, delists and lists
 * scrips, so a total one smaller than yesterday is the ordinary state of a live
 * exchange (CLAUDE.md §2.34.1). The lesson was applied file by file and each new
 * writer copied the old shape: `fetch-corporate-actions.mjs` refused at 1,284 on
 * file against 1,282 read — every one of the 1,282 answering — on every run from
 * 22 to 29 Oct 2026, and because the prices move as a group with it, the
 * dashboard's closes sat on 19 Oct while BSE was serving each new session.
 *
 * It was blind as well as over-sensitive: `was > now` passes a run that loses a
 * scrip it asked for while the universe grows by two.
 *
 * So the question is anchored on the previous file, which the run cannot move:
 * of what we already held AND asked for again, how much came back?
 *
 * @param {object} args
 * @param {Iterable<string>} args.held   keys on the previous file
 * @param {Iterable<string>} args.asked  keys this run went after
 * @param {Iterable<string>} args.got    keys this run actually has
 * @returns {{askedAgain: number, cameBack: number, cameBackPct: number|null,
 *            lost: string[], departed: string[], departedPct: number|null}}
 *   `lost` were asked for and did not come back. `departed` were not asked for:
 *   the universe let them go, which is not a gap in this read. Each percentage is
 *   null when it has no denominator, never 100 or 0 (§2.3).
 */
export function heldCoverage({ held, asked, got }) {
  const heldKeys = [...new Set(held)];
  const askedKeys = new Set(asked);
  const gotKeys = new Set(got);
  const askedAgain = heldKeys.filter((key) => askedKeys.has(key));
  const lost = askedAgain.filter((key) => !gotKeys.has(key));
  const departed = heldKeys.filter((key) => !askedKeys.has(key));
  const cameBack = askedAgain.length - lost.length;
  return {
    askedAgain: askedAgain.length,
    cameBack,
    cameBackPct: askedAgain.length > 0 ? (cameBack / askedAgain.length) * 100 : null,
    lost,
    departed,
    departedPct: heldKeys.length > 0 ? (departed.length / heldKeys.length) * 100 : null,
  };
}

/**
 * The most of a held universe that may leave in one run before it reads as a
 * broken universe rather than churn. Measured across Oct 2026: 0.5% at the widest
 * (1,284 -> 1,277). `fetch-bse-master.mjs` refuses a 5% drop in the master itself
 * for the same reason, so a universe that collapses here has got past that one.
 */
export const MAX_DEPARTED_PCT = 5;
