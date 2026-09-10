/**
 * grouped-number.js — the only place a digit-grouped string becomes a number.
 *
 * ⚠ `parseFloat` IS BANNED ANYWHERE NEAR ONE OF THESE (§3.8).
 *
 *     parseFloat("8,71,532.61")   // => 8   — not an error, not NaN. Just 8.
 *
 * It stops at the first comma and returns a plausible small number that sorts,
 * sums and ranks perfectly happily. BSE prints money that way and so does
 * Vanguard, so this validates the WHOLE string before converting anything and
 * returns `null` for anything it does not fully understand.
 *
 * ⚠ AND IT LIVES UNDER public/js BECAUSE THE BROWSER READS A WORKBOOK NOW.
 *
 * It began in `scripts/lib/bse.mjs`, which imports `node:child_process` for the
 * curl transport and therefore cannot be loaded in a browser at all. The FTSE
 * upload panel parses Vanguard's `$1,234.56` and `0.7647%` in the page, so it
 * needs this exact parser — and a second copy of a function whose whole purpose
 * is to reject strings the naive reader accepts is the last thing this repo
 * should carry two of. `bse.mjs` re-exports it, so every existing caller is
 * unchanged and there is still one implementation.
 */

/**
 * A number written with Indian (or Western) digit grouping, as a plain number.
 *
 * Accepts:  "1,769,379.44"  "17,69,379.44"  "156812.20"  "0.4926"  "7.72"
 * Rejects:  "-"  ""  "N.A."  "1,2,3,4"  "12.3.4"  null  undefined  NaN inputs
 *
 * Returns `null` for anything it does not fully understand. Never guesses,
 * never partially parses. A `null` here means "no reading", which is a
 * different fact from zero and must stay different all the way to the screen.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseGroupedNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') return null;

  const text = value.trim();
  if (text === '' || text === '-' || text === '--') return null;

  // The whole string must be a number: optional sign, digit groups separated by
  // single commas, optional single decimal part. Anything else is not a number
  // we are willing to guess at.
  if (!/^-?\d{1,3}(,\d{2,3})*(\.\d+)?$/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) {
    return null;
  }

  const stripped = text.replace(/,/g, '');
  // Number(), not parseFloat(): Number("8,71,532.61") is NaN, which we can
  // detect. parseFloat("8,71,532.61") is 8, which we cannot.
  const parsed = Number(stripped);
  return Number.isFinite(parsed) ? parsed : null;
}
