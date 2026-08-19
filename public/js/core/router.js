/**
 * Hash routing: #/companies?scope=&q=&fund=&company=
 *
 * The hash is the shareable surface. A drilled-into company lives in
 * `?company=<ISIN>`, so a row can be sent to somebody and reopened.
 *
 * Writes are shallow-merged and skip a notification when nothing actually
 * changed, so a component that mirrors its own state into the URL does not
 * re-enter itself.
 */

const DEFAULT_ROUTE = 'companies';
const listeners = new Set();
let suppress = false;

function parse(hash) {
  const raw = (hash || '').replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  return {
    route: path || DEFAULT_ROUTE,
    params: Object.fromEntries([...params.entries()].filter(([, v]) => v !== '')),
  };
}

export const current = () => parse(location.hash);

function serialise({ route, params }) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return `#/${route}${query ? `?${query}` : ''}`;
}

/**
 * Merge params into the URL. `null` removes a key.
 * @param {object} patch
 * @param {{replace?: boolean, silent?: boolean}} options
 */
export function setParams(patch, { replace = true, silent = true } = {}) {
  const { route, params } = current();
  const next = { ...params };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === '') delete next[key];
    else next[key] = String(value);
  }
  const hash = serialise({ route, params: next });
  if (hash === location.hash) return;
  suppress = silent;
  if (replace) history.replaceState(null, '', hash);
  else location.hash = hash;
  if (replace && !silent) notify();
  if (replace) suppress = false;
}

export const getParam = (key) => current().params[key] ?? null;

function notify() {
  const state = current();
  for (const handler of listeners) {
    try {
      handler(state);
    } catch (error) {
      console.error('[router] listener threw', error);
    }
  }
}

export function onRoute(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

export function start() {
  window.addEventListener('hashchange', () => {
    if (suppress) {
      suppress = false;
      return;
    }
    notify();
  });
  if (!location.hash) history.replaceState(null, '', `#/${DEFAULT_ROUTE}`);
  notify();
}
