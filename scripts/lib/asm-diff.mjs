/**
 * Compare two NSE ASM snapshots and say what actually changed.
 *
 * The refresh jobs re-read NSE's surveillance list and commit it. That keeps the
 * file fresh but says nothing about WHAT MOVED, and "what moved" is the thing a
 * desk watching surveillance stages actually wants: a company entering ASM, one
 * coming off it, or one escalating from Stage I to Stage II.
 *
 * ⚠ THE COMPARISON KEYS ON ISIN AND NOTHING ELSE (§3.9).
 *
 * This is not a style preference, it is the difference between a report and a
 * fabrication. NSE respells symbols, and a vendor did exactly that inside this
 * project's own history: BlackRock rewrote Bajaj Auto's ticker from `BAJAJ-AUTO`
 * to `BAJAJ.AUTO` between two files, and a ticker-keyed diff reported it as one
 * exit and one entry — two invented events on a company that had not moved, in a
 * table whose entire purpose is to count events (§2.32).
 *
 * So a symbol change on a stable ISIN is reported as a RESPELLING, in its own
 * bucket, and never as an entry or an exit.
 *
 * ⚠ AND A MISSING "BEFORE" IS NOT "NOTHING CHANGED" (§2.4).
 *
 * With no previous snapshot there is no comparison to make. Reporting that as
 * zero entries and zero exits would render a failure to compare as a finding
 * that nothing happened. `comparable` is false and `reason` says which it is.
 *
 * Pure and deterministic: it takes two parsed snapshots and touches nothing.
 */

/** The fields that constitute NSE's classification of a security. */
const CLASSIFICATION = ['survCode', 'stage', 'category'];

function indexByIsin(snapshot) {
  const byIsin = new Map();
  const withoutIsin = [];
  for (const row of snapshot?.companies ?? []) {
    // A row with no ISIN cannot be compared to anything. It is counted and
    // named, never dropped and never matched on a symbol guess (§3.9).
    if (!row?.isin) {
      withoutIsin.push(row);
      continue;
    }
    byIsin.set(row.isin, row);
  }
  return { byIsin, withoutIsin };
}

function classificationOf(row) {
  const out = {};
  for (const field of CLASSIFICATION) out[field] = row?.[field] ?? null;
  return out;
}

function sameClassification(a, b) {
  return CLASSIFICATION.every((field) => (a?.[field] ?? null) === (b?.[field] ?? null));
}

function label(row) {
  return {
    isin: row?.isin ?? null,
    symbol: row?.symbol ?? null,
    companyName: row?.companyName ?? null,
  };
}

/**
 * @param {object|null} before  the previously committed snapshot, or null
 * @param {object} after        the snapshot just captured
 */
export function diffAsmSnapshots(before, after) {
  if (!after || !Array.isArray(after.companies)) {
    return {
      comparable: false,
      reason: 'the new snapshot has no companies[] — there is nothing to compare',
      entered: [], left: [], reclassified: [], respelled: [],
      unchanged: 0, beforeCount: null, afterCount: null,
    };
  }
  if (!before || !Array.isArray(before.companies)) {
    return {
      comparable: false,
      // Not "no changes". We did not have a previous list to compare against,
      // which is a different fact and reads differently to anyone acting on it.
      reason: 'no previous ASM snapshot to compare against — this is a first capture, not a quiet fortnight',
      entered: [], left: [], reclassified: [], respelled: [],
      unchanged: 0,
      beforeCount: null,
      afterCount: after.companies.length,
    };
  }

  const prev = indexByIsin(before);
  const next = indexByIsin(after);

  const entered = [];
  const left = [];
  const reclassified = [];
  const respelled = [];
  let unchanged = 0;

  for (const [isin, row] of next.byIsin) {
    const was = prev.byIsin.get(isin);
    if (!was) {
      entered.push({ ...label(row), to: classificationOf(row), survDesc: row.survDesc ?? null });
      continue;
    }
    const moved = !sameClassification(was, row);
    if (moved) {
      reclassified.push({
        ...label(row),
        from: classificationOf(was),
        to: classificationOf(row),
        survDesc: row.survDesc ?? null,
      });
    } else {
      unchanged += 1;
    }
    // A respelling is reported whether or not the classification moved, because
    // it explains a symbol changing on screen without implying an ASM event.
    if ((was.symbol ?? null) !== (row.symbol ?? null)) {
      respelled.push({ isin, from: was.symbol ?? null, to: row.symbol ?? null, companyName: row.companyName ?? null });
    }
  }

  for (const [isin, row] of prev.byIsin) {
    if (!next.byIsin.has(isin)) {
      left.push({ ...label(row), from: classificationOf(row), survDesc: row.survDesc ?? null });
    }
  }

  const byIsinAsc = (a, b) => (a.symbol ?? a.isin ?? '').localeCompare(b.symbol ?? b.isin ?? '');
  entered.sort(byIsinAsc);
  left.sort(byIsinAsc);
  reclassified.sort(byIsinAsc);

  return {
    comparable: true,
    reason: null,
    entered,
    left,
    reclassified,
    respelled,
    unchanged,
    beforeCount: prev.byIsin.size,
    afterCount: next.byIsin.size,
    // Rows either side that carry no ISIN: not comparable, and said so rather
    // than being quietly absorbed into "unchanged".
    withoutIsin: { before: prev.withoutIsin.length, after: next.withoutIsin.length },
  };
}

/** How many genuine classification events the diff found. */
export function changeCount(diff) {
  if (!diff?.comparable) return null;
  return diff.entered.length + diff.left.length + diff.reclassified.length;
}
