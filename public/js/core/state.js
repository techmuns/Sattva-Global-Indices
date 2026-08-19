/**
 * Global state: scope, watchlist. localStorage-backed, with a pub/sub.
 *
 * localStorage can throw (private mode, disabled storage, quota). It is a
 * convenience here, not a source of truth, so every access is guarded and a
 * failure degrades to in-memory state rather than taking the page down.
 */

const STORAGE_PREFIX = 'sattva.v1.';

/** Both scopes are meaningful: what must be traded, and what could enter. */
export const SCOPES = ['held', 'all'];
export const DEFAULT_SCOPE = 'held';

function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable — state stays in memory for this session */
  }
}

const listeners = new Map();

const state = {
  scope: SCOPES.includes(readStore('scope', DEFAULT_SCOPE)) ? readStore('scope', DEFAULT_SCOPE) : DEFAULT_SCOPE,
  watchlist: new Set(Array.isArray(readStore('watchlist', [])) ? readStore('watchlist', []) : []),
};

/** Subscribe to a channel. Returns an unsubscribe function. */
export function on(channel, handler) {
  if (!listeners.has(channel)) listeners.set(channel, new Set());
  listeners.get(channel).add(handler);
  return () => listeners.get(channel)?.delete(handler);
}

export function emit(channel, payload) {
  for (const handler of listeners.get(channel) ?? []) {
    try {
      handler(payload);
    } catch (error) {
      console.error(`[state] listener for "${channel}" threw`, error);
    }
  }
}

export const getScope = () => state.scope;

export function setScope(scope) {
  const next = SCOPES.includes(scope) ? scope : DEFAULT_SCOPE;
  if (next === state.scope) return next;
  state.scope = next;
  writeStore('scope', next);
  emit('scope', next);
  return next;
}

export const isWatched = (isin) => state.watchlist.has(isin);
export const watchlist = () => [...state.watchlist];
export const watchCount = () => state.watchlist.size;

/** Toggle and return the NEW state, so a caller can paint without re-reading. */
export function toggleWatch(isin) {
  if (!isin) return false;
  if (state.watchlist.has(isin)) state.watchlist.delete(isin);
  else state.watchlist.add(isin);
  writeStore('watchlist', [...state.watchlist]);
  emit('watchlist', isin);
  return state.watchlist.has(isin);
}
