/**
 * ftse-store.js — where a workbook the desk uploaded actually lives.
 *
 * ---------------------------------------------------------------------------
 * THREE PLACES A BOOK CAN COME FROM, AND THE SCREEN ALWAYS SAYS WHICH
 * ---------------------------------------------------------------------------
 *
 *   committed   public/data/ftse-funds.json, written by scripts/import-ftse.mjs
 *               and deployed with the site. Everyone sees it. The floor.
 *   published   a book uploaded through the dashboard and stored by the Worker.
 *               Everyone sees it, without a commit or a deploy.
 *   local       a book uploaded through the dashboard with no Worker to store
 *               it. Only this browser sees it.
 *
 * Precedence is published > local > committed, newest first — but NEVER
 * silently. `receivedAs` travels on the book, the panel names it, and the
 * sources modal names it, because "the FTSE weights everyone can see" and "the
 * FTSE weights on your laptop" are different facts and a reader acting on one
 * while believing the other is exactly the failure §2.1 exists to prevent.
 *
 * ⚠ THE STATIC SITE IS STILL THE FLOOR. With `python3 -m http.server` there is
 * no `/api/ftse`, publishing reports `no-worker` in those words, and the upload
 * still works — it lands in this browser only, and says so. Nothing here may
 * make the committed book unreachable.
 *
 * ⚠ AND LOCAL STORAGE CAN THROW, not merely come back empty. A private window,
 * cleared site data or a browser set to block storage makes the accessor itself
 * raise, so every read and write is wrapped and a failure to persist is
 * REPORTED rather than swallowed — an upload that vanishes on reload with no
 * explanation is worse than one that refused up front.
 */

const KEY = 'sattva.ftse.book.v1';
const ENDPOINT = '/api/ftse';

/** How the book on screen got there. Rendered verbatim; never abbreviated. */
export const ORIGIN_LABEL = {
  committed: 'committed with the site',
  published: 'uploaded to the shared store',
  local: 'uploaded in this browser only',
};

/**
 * ⚠ THE JOIN IS STORED WITH THE BOOK, NOT REDONE ON EVERY LOAD.
 *
 * The join is arbitrated by comparing each row's implied share price against our
 * own close ON THE WORKBOOK'S OWN DATE, and only price-history.json holds a
 * close for a date that is not today — 1.5 MB, fetched on demand when somebody
 * uploads. Re-joining at every page load would either pay that on every visit or
 * silently fall back to a weaker basis, so the same book would resolve one way
 * when it was reviewed and another way the next morning.
 *
 * So what is stored is `{ book, join }` — exactly what a person looked at and
 * approved, including which close arbitrated it. The map is keyed on ISIN, which
 * is why it survives the record being rebuilt underneath it: a company that
 * appears tomorrow simply has no row, which is the correct answer (§3.9).
 */
const isEntry = (entry) => Boolean(entry?.book?.funds?.[0]?.holdings?.length && entry?.join?.meta);

/** `{book, join:{meta, byIsin}}` with byIsin rehydrated to a Map, or null. */
export function readLocal() {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    return hydrate(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** The stored form uses entries because a Map does not survive JSON. */
export function hydrate(entry) {
  if (!isEntry(entry)) return null;
  return {
    book: entry.book,
    join: { meta: entry.join.meta, byIsin: new Map(entry.join.byIsin ?? []) },
  };
}

const dehydrate = (entry) => ({
  book: entry.book,
  join: { meta: entry.join.meta, byIsin: [...entry.join.byIsin.entries()] },
});

export function writeLocal(entry) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(dehydrate(entry)));
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason:
        'This browser refused to store the book, so it will be gone on reload. It IS applied to the '
        + `screen right now. (${error?.name ?? 'storage error'})`,
    };
  }
}

export function clearLocal() {
  try {
    window.localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask the Worker for the shared book.
 *
 * ⚠ FOUR OUTCOMES, AND THEY ARE NOT ONE OUTCOME. No Worker at all (the static
 * floor), a Worker with no store configured, a Worker with an empty store, and a
 * Worker holding a book are four different facts, and collapsing them into
 * "nothing here" would report a missing configuration as an empty shelf (§2.4).
 */
export async function fetchPublished() {
  let response;
  try {
    // `no-store`: this is a shared mutable document and a revalidated copy from
    // the HTTP cache is a book somebody may already have replaced.
    response = await fetch(ENDPOINT, { headers: { accept: 'application/json' }, cache: 'no-store' });
  } catch (error) {
    return { state: 'unreachable', book: null, detail: error?.message ?? 'the request failed' };
  }
  // The static floor answers the SPA shell for an unknown path, so a 200 that is
  // not JSON is "no Worker", not "a malformed book" (§3.8's 200-is-not-a-contract
  // trap, arriving from our own asset layer).
  if (response.status === 404) return { state: 'no-worker', book: null, detail: 'no /api/ftse on this host' };
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    return { state: 'no-worker', book: null, detail: `the host answered ${response.status} ${type || 'with no content type'}` };
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    return { state: 'unreachable', book: null, detail: error?.message ?? 'the answer was not JSON' };
  }
  if (response.status === 501) return { state: 'not-configured', book: null, detail: body?.error ?? 'no store bound' };
  if (!response.ok) return { state: 'unreachable', book: null, detail: body?.error ?? `HTTP ${response.status}` };
  const entry = hydrate(body);
  if (!entry) return { state: 'empty', book: null, detail: body?.detail ?? 'nothing has been uploaded' };
  return { state: 'published', book: entry, detail: body.detail ?? null };
}

/** Offer the book to the Worker so every reader gets it. */
export async function publish(entry) {
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(dehydrate(entry)),
    });
  } catch (error) {
    return { state: 'unreachable', detail: error?.message ?? 'the request failed' };
  }
  if (response.status === 404) return { state: 'no-worker', detail: 'no /api/ftse on this host' };
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    return { state: 'no-worker', detail: `the host answered ${response.status} ${type || 'with no content type'}` };
  }
  const body = await response.json().catch(() => null);
  if (response.status === 501) return { state: 'not-configured', detail: body?.error ?? 'no store bound' };
  if (response.status === 400 || response.status === 413) return { state: 'refused', detail: body?.error ?? 'the store refused the book' };
  if (!response.ok) return { state: 'unreachable', detail: body?.error ?? `HTTP ${response.status}` };
  return { state: 'published', detail: body?.detail ?? null };
}

/**
 * Which uploaded book, if any, should displace the committed one.
 *
 * ⚠ NEWEST WINS, AND "NEWEST" IS THE HOLDINGS DATE — never the upload time. A
 * book struck in July that somebody uploads today is still July's book, and
 * letting an upload time win would let a stale file displace a fresh one purely
 * by arriving second.
 *
 * ⚠ AND AN UPLOAD NEVER DISPLACES A NEWER COMMITTED BOOK. Once the artefact is
 * committed and deployed it is the floor again, and a leftover upload of the
 * same quarter sitting in one person's browser must not quietly outrank it.
 * Equal dates go to the committed one for the same reason: the shared fact wins
 * a tie.
 *
 * @param {{committedAsOf: string|null, published: object|null, local: object|null}} sources
 * @returns {{origin: 'published'|'local', entry: object}|null}
 */
export function chooseUpload({ committedAsOf = null, published = null, local = null }) {
  const asOf = (entry) => entry?.book?.funds?.[0]?.asOf ?? '';
  // Published is considered first so it wins a tie against an identical local
  // copy — what everyone can see beats what one laptop can.
  const candidates = [
    published ? { origin: 'published', entry: published } : null,
    local ? { origin: 'local', entry: local } : null,
  ].filter(Boolean);
  if (!candidates.length) return null;

  const best = candidates.reduce((a, b) => (asOf(b.entry) > asOf(a.entry) ? b : a));
  if (committedAsOf && asOf(best.entry) <= committedAsOf) return null;
  return best;
}
