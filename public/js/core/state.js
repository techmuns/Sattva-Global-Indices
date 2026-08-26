/**
 * Global state: methodology, watchlist. localStorage-backed, with a pub/sub.
 *
 * localStorage can throw (private mode, disabled storage, quota). It is a
 * convenience here, not a source of truth, so every access is guarded and a
 * failure degrades to in-memory state rather than taking the page down.
 */

const STORAGE_PREFIX = 'sattva.v1.';

/**
 * WHICH MODEL IS IN FORCE.
 *
 * Two methodologies ship side by side so the desk can see what changes when
 * MSCI's published structure is applied instead of the desk's rupee bands. See
 * public/js/model/gimi.js. The ids are duplicated from METHODOLOGY_IDS there
 * rather than imported, because this module is the storage layer and must not
 * pull the model graph in behind it — the pair is asserted equal by the
 * verification suite instead.
 */
export const METHODOLOGIES = ['freefloat', 'gimi'];
export const DEFAULT_METHODOLOGY = 'freefloat';

/**
 * THE SCOPE TOGGLE IS GONE. Held-versus-all was removed on 26 Aug 2026: the
 * screener always shows the whole universe, because a candidate no fund holds
 * yet is exactly what an inclusion forecast is about, and hiding it by default
 * made the product's own subject the thing you had to opt into. Kept as a
 * constant so `data.forScope` keeps one caller and one meaning.
 */
export const SCOPE = 'all';

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

const storedMethodology = readStore('methodology', DEFAULT_METHODOLOGY);

const state = {
  methodology: METHODOLOGIES.includes(storedMethodology) ? storedMethodology : DEFAULT_METHODOLOGY,
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

export const getMethodology = () => state.methodology;

export function setMethodology(methodology) {
  const next = METHODOLOGIES.includes(methodology) ? methodology : DEFAULT_METHODOLOGY;
  if (next === state.methodology) return next;
  state.methodology = next;
  writeStore('methodology', next);
  emit('methodology', next);
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
