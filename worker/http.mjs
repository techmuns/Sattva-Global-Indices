/**
 * http.mjs — ETag / 304 / CORS / cache helpers.
 *
 * Kept separate from the Worker entry point so a local stand-in can share the
 * exact same header logic. A caching claim that only holds in production is a
 * caching claim nobody can check.
 */

/** Weak ETag over a body string. FNV-1a: short, stable, no crypto import. */
export function etagFor(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `W/"${hash.toString(16)}-${text.length.toString(16)}"`;
}

export const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

/**
 * A JSON response with ETag, cache-control and the cache-state header.
 *
 * `cacheState` is `live` (we fetched upstream) or `hit` (served from the edge
 * cache). It exists so the caching behaviour can be VERIFIED from outside
 * rather than asserted in a comment.
 */
export function jsonResponse(payload, { status = 200, maxAge = 30, cacheState = 'live', request } = {}) {
  const body = JSON.stringify(payload);
  const etag = etagFor(body);

  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': `public, max-age=${maxAge}`,
    etag,
    'x-siflows-cache': cacheState,
    ...CORS_HEADERS,
  };

  if (request?.headers?.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { status, headers });
}

/** Preflight. */
export const preflight = () => new Response(null, { status: 204, headers: CORS_HEADERS });

/**
 * A failure, as a 200 with `ok:false`.
 *
 * The request to OUR Worker succeeded; what failed was upstream. Returning a
 * 5xx would make the browser's own error handling swallow the reason, and the
 * reason is the whole point: `no-token` and `unauthorised` are things an
 * operator fixes with a named command, while `upstream` and `unreachable` are
 * things to wait out. A UI that cannot tell those apart tells the reader to
 * "try again" when the real answer is "run wrangler secret put".
 */
export function failure(reason, detail, { maxAge = 15, request, extra = {} } = {}) {
  return jsonResponse(
    {
      ok: false,
      reason,
      detail: detail ?? null,
      // What a human should DO about it, named per state.
      remedy: REMEDY[reason] ?? null,
      asOf: new Date().toISOString(),
      quotes: {},
      failed: [],
      ...extra,
    },
    { maxAge, cacheState: 'live', request },
  );
}

export const REMEDY = {
  'no-token': 'Set the upstream token: npx wrangler secret put MUNS_TOKEN (or add MUNS_TOKEN to .dev.vars for local dev).',
  unauthorised: 'The token was rejected. Re-issue it and run: npx wrangler secret put MUNS_TOKEN',
  upstream: null,
  unreachable: null,
  'bad-request': null,
};
