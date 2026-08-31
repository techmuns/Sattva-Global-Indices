/**
 * Reading a min–max range that a human typed.
 *
 * The market-cap filter used to be five fixed bands in a dropdown. It is now
 * two boxes a reader types into, and that moves a parsing problem out of the
 * data pipeline and into the interface — where it is HARDER, not easier.
 *
 * `parseFloat` is banned outright in this repo because `parseFloat("3,000")`
 * returns 3: not an error, not NaN, just a plausible small number that sorts
 * and filters perfectly happily (CLAUDE.md §3.8). Everything that rule says
 * about a BSE figure applies with more force to something a person typed,
 * because there is no upstream file to check the answer against. The only
 * witness is the reader, who asked for companies above ₹3,000 Cr and was shown
 * every company above ₹3 Cr — a screen full of confident, well-formatted rows
 * that answer a question nobody asked.
 *
 * So the rules here are:
 *
 *   1. A number is VALIDATED IN FULL before it is converted. Grouping commas
 *      are allowed anywhere between digits, because a person typing ₹ crore
 *      writes 1,00,000 or 100,000 depending on habit and both mean the same
 *      thing. Anything else fails.
 *   2. A failure is NAMED, never swallowed (CLAUDE.md §2.4). Every rejection
 *      comes back as a sentence a reader can act on, and the caller's job is
 *      to show it and leave the rows alone — an unreadable entry that silently
 *      filtered nothing, or silently filtered everything, would report a typo
 *      as a finding about the companies.
 *   3. Nothing is guessed. A reversed range is not quietly swapped and a
 *      contradictory pair of bounds is not resolved by precedence: both are
 *      reported back. Correcting what somebody typed changes the question they
 *      asked without telling them.
 *
 * This module is UNIT-FREE on purpose. It reads numbers, not rupees and not
 * crore. The caller owns the unit, states it beside the boxes, and does the
 * comparing — so there is exactly one place that knows what the digits mean.
 */

/**
 * Noise a person types around a figure and does not mean as part of it.
 * `crores?` must precede `cr` in the alternation or "crore" leaves an "ore".
 */
const NOISE = /₹|rs\.?|inr|crores?|cr|\s/gi;

/**
 * The separators that read as "from … to …", all normalised to one hyphen
 * before anything is split. A LONE `.` IS NEVER ONE OF THEM — it is a decimal
 * point, and a splitter that took it would read 3500.5 as two ends.
 */
const SEPARATOR = /\.\.|…|–|—|−|-|to/gi;

/** After the noise is gone and the separators are one character, only these. */
const ALLOWED = /^[0-9.,+<>=\u2264\u2265-]*$/;

/** Curly quotes, so the reader sees exactly what they typed, delimited. */
const quoted = (text) => `“${text}”`;

/**
 * One typed number → a value, or a reason it is not one.
 *
 * Accepts `3000`, `3,000`, `1,00,000`, `100,000`, `3500.5`. Rejects an empty
 * string, a bare separator, a double comma, a trailing comma, two decimal
 * points, and anything carrying a character that is not part of a number.
 *
 * @param {string} text
 * @returns {{value: number|null, error: string|null}}
 */
export function parseTypedNumber(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { value: null, error: null };

  // Grouping commas may sit anywhere between digits — Indian grouping puts
  // them in different places from Western grouping and both are legitimate —
  // but never at either end and never doubled.
  if (!/^\d[\d,]*(\.\d+)?$/.test(raw) || /,,|,$/.test(raw)) {
    return { value: null, error: `${quoted(raw)} is not a number` };
  }

  const value = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(value)) return { value: null, error: `${quoted(raw)} is not a number` };
  return { value, error: null };
}

/**
 * One box → the bounds it asserts.
 *
 * A box normally carries its own end of the range, but a reader who types the
 * whole thing into one box — "3,000–8,000", the way it would be written down —
 * means both ends, and Excel's own filter idioms (`>3000`, `<8000`, `3000+`)
 * mean one. All of them are read here so that what a person naturally types
 * does what it looks like it should.
 *
 * @param {string} text
 * @param {'min'|'max'} side which end a bare number belongs to
 * @returns {{lo: number|null, hi: number|null, error: string|null}}
 */
export function parseRangeEntry(text, side) {
  const original = String(text ?? '').trim();
  const none = { lo: null, hi: null, error: null };
  if (!original) return none;

  const cleaned = original.replace(NOISE, '').replace(SEPARATOR, '-');
  if (!cleaned) return { ...none, error: `${quoted(original)} carries no number` };
  if (!ALLOWED.test(cleaned)) return { ...none, error: `${quoted(original)} is not a number` };

  // Excel's comparison operators, which route to one end whichever box they
  // were typed into.
  const operator = cleaned.match(/^(>=|≥|<=|≤|>|<)/);
  if (operator) {
    const rest = parseTypedNumber(cleaned.slice(operator[0].length));
    if (rest.error) return { ...none, error: rest.error };
    if (rest.value === null) return { ...none, error: `${quoted(original)} has an operator and no number` };
    return operator[0] === '>' || operator[0] === '>=' || operator[0] === '≥'
      ? { lo: rest.value, hi: null, error: null }
      : { lo: null, hi: rest.value, error: null };
  }

  // "3000+" — from there upwards.
  if (/\+$/.test(cleaned)) {
    const lower = parseTypedNumber(cleaned.slice(0, -1));
    if (lower.error) return { ...none, error: lower.error };
    if (lower.value === null) return { ...none, error: `${quoted(original)} has no number before the +` };
    return { lo: lower.value, hi: null, error: null };
  }

  const parts = cleaned.split('-');
  if (parts.length > 2) {
    return { ...none, error: `${quoted(original)} has more than two ends — a range has two` };
  }

  if (parts.length === 2) {
    const [loText, hiText] = parts;
    const lo = parseTypedNumber(loText);
    const hi = parseTypedNumber(hiText);
    if (lo.error) return { ...none, error: lo.error };
    if (hi.error) return { ...none, error: hi.error };
    if (lo.value === null && hi.value === null) {
      return { ...none, error: `${quoted(original)} has a range separator and no numbers` };
    }
    return { lo: lo.value, hi: hi.value, error: null };
  }

  const only = parseTypedNumber(parts[0]);
  if (only.error) return { ...none, error: only.error };
  if (only.value === null) return { ...none, error: `${quoted(original)} is not a number` };
  return side === 'max'
    ? { lo: null, hi: only.value, error: null }
    : { lo: only.value, hi: null, error: null };
}

/**
 * Both boxes → the range in force, or the reason there is none.
 *
 * `active` is the only thing a caller may filter on. It is false when nothing
 * was typed AND when something unreadable was: in both cases the rows are left
 * alone, and in the second the caller must show `error` — the difference
 * between "no filter" and "a filter that could not be read" belongs on the
 * screen, not in a swallowed exception.
 *
 * @param {{min?: string, max?: string}} value
 * @returns {{min: number|null, max: number|null, active: boolean, empty: boolean, error: string|null}}
 */
export function parseRange(value) {
  const minText = String(value?.min ?? '').trim();
  const maxText = String(value?.max ?? '').trim();
  const idle = { min: null, max: null, active: false, empty: true, error: null };
  if (!minText && !maxText) return idle;

  const fromMin = parseRangeEntry(minText, 'min');
  const fromMax = parseRangeEntry(maxText, 'max');
  const failed = { ...idle, empty: false };

  if (fromMin.error) return { ...failed, error: fromMin.error };
  if (fromMax.error) return { ...failed, error: fromMax.error };

  // Two bounds for the same end. It happens when a whole range is typed into
  // one box and a number is left in the other, and there is no defensible way
  // to pick a winner — so neither is picked.
  const lows = [fromMin.lo, fromMax.lo].filter((x) => x !== null);
  const highs = [fromMin.hi, fromMax.hi].filter((x) => x !== null);
  if (new Set(lows).size > 1) {
    return { ...failed, error: `two different minimums were typed — ${lows.join(' and ')}` };
  }
  if (new Set(highs).size > 1) {
    return { ...failed, error: `two different maximums were typed — ${highs.join(' and ')}` };
  }

  const min = lows.length ? lows[0] : null;
  const max = highs.length ? highs[0] : null;
  if (min === null && max === null) return idle;

  if (min !== null && max !== null && min > max) {
    // Not swapped. A reader who typed them this way meant something, and an
    // empty table would read as a fact about the companies rather than about
    // the entry (CLAUDE.md §2.4).
    return { ...failed, error: 'the minimum is above the maximum, so nothing could ever match' };
  }

  return { min, max, active: true, empty: false, error: null };
}

/**
 * Is a value inside the range? INCLUSIVE AT BOTH ENDS.
 *
 * A person who types 3,000–8,000 means both of them, and the old dropdown's
 * half-open bands were a consequence of tiling a universe with no gaps, which
 * a typed range does not have to do. A missing value is NOT small (CLAUDE.md
 * §2.3): it matches no range in either direction, so it can never be dragged
 * to the bottom of a list it does not belong in.
 *
 * @param {number|null|undefined} value in the same unit as the range
 * @param {{min: number|null, max: number|null}} range
 */
export function withinRange(value, range) {
  if (value === null || value === undefined || !Number.isFinite(value)) return false;
  if (range.min !== null && value < range.min) return false;
  if (range.max !== null && value > range.max) return false;
  return true;
}
