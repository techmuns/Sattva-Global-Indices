/**
 * The single reader of public/data/rebalance-<review>.json.
 *
 * Fetched on demand — the screener is the default view and most readers never
 * open the rebalance page, so its payload is not on the critical path of first
 * paint.
 *
 * Every count on that page comes from here, and here comes from the file the
 * build script wrote. Nothing in the interface may hand-type a figure (§2.5).
 */

/** The reviews with a scored outcome on the record, newest first. */
export const SCORED_REVIEWS = ['2026-08'];

const cache = new Map();
const pending = new Map();

export async function load(review = SCORED_REVIEWS[0]) {
  if (cache.has(review)) return cache.get(review);
  if (pending.has(review)) return pending.get(review);

  const promise = (async () => {
    const response = await fetch(`data/rebalance-${review}.json`, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`rebalance-${review}.json responded ${response.status} ${response.statusText}`);
    }
    const json = await response.json();
    if (!Array.isArray(json?.companies) || !json?.scorecard) {
      throw new Error(`rebalance-${review}.json carried no companies array or no scorecard`);
    }
    cache.set(review, json);
    return json;
  })();

  pending.set(review, promise);
  try {
    return await promise;
  } finally {
    pending.delete(review);
  }
}

export const latest = () => cache.get(SCORED_REVIEWS[0]) ?? null;

/** Rows for one event key, largest position first where there is one. */
export function companiesFor(payload, event) {
  return (payload?.companies ?? [])
    .filter((row) => row.event === event)
    .sort((a, b) => (b.freeFloatMcapInrAfter ?? 0) - (a.freeFloatMcapInrAfter ?? 0));
}

/**
 * Did the forecast name this row's outcome?
 *
 *   'hit'      the verdict claimed exactly the event that happened
 *   'missed'   something happened and the verdict did not claim it
 *   'false'    the verdict claimed a move and nothing happened
 *   'quiet'    no claim either way — the verdict was `unknown`, or the company
 *              was not in the record when the forecast was made
 *
 * `quiet` is deliberately not a score. A refusal to call is not a wrong call,
 * and folding it into either column would turn honesty into a penalty.
 */
export function outcomeOf(row) {
  if (!row.inForecast || row.predictedClaim === null) return 'quiet';
  if (row.predictedClaim === row.event) return 'hit';
  if (row.event !== 'no-change') return 'missed';
  return 'false';
}
