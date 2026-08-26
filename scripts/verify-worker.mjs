/**
 * verify-worker.mjs — the Worker's routes, driven in Node against a stub.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SUITE EXISTS SEPARATELY
 * ---------------------------------------------------------------------------
 * `verify-data` reads the committed record and never opens a socket.
 * `verify-ui` drives a browser and needs a served site. Neither can reach the
 * inside of a Worker route, and the free-float route carries the two mistakes
 * that would be most expensive here:
 *
 *   - a UNIT error. The upstream answers in rupee CRORE. Everything downstream
 *     is rupees. A crore value landing in a rupee field is a ten-million-fold
 *     error that sorts, sums and ranks perfectly happily (CLAUDE.md §3.8).
 *   - a CREDENTIAL leak. The whole reason the Worker exists is to hold a token
 *     the browser must never see.
 *
 * So the route is exercised here as a unit: `worker/index.js` is imported and
 * called with a stubbed `env`, a stubbed edge cache and a stubbed upstream that
 * implements the documented `/filings/free_float_market_cap` contract. No
 * network, no wrangler, no credentials — which is also what makes it runnable
 * in CI and on a box that has neither the host nor the JWT.
 *
 * Run:  node scripts/verify-worker.mjs [--prove] [--only=1,2]
 */

import { Suite, parseArgs, ok, equal } from './lib/assert.mjs';

/* ── Workers globals the module expects ───────────────────────────────────── */

/**
 * The edge cache, as a Map.
 *
 * Real enough for what is asserted: `caches.default.match/put` keyed on the
 * request URL, which is exactly how the route uses it. Cloning on both sides
 * matters — a Response body is a stream and can be read once, so a stub that
 * handed back the same object would make the second read of a cached entry
 * return an empty body and the cache assertion would pass for the wrong reason.
 */
function makeCacheStub() {
  const store = new Map();
  return {
    store,
    api: {
      default: {
        async match(request) {
          const hit = store.get(request.url);
          return hit ? hit.clone() : undefined;
        },
        async put(request, response) {
          store.set(request.url, response.clone());
        },
      },
    },
  };
}

/**
 * The documented as-of, pinned as its own constant.
 *
 * Check 4 must NOT compare against `SAMPLE.asOf`: a sabotage that restamps the
 * as-of would move the expectation with it and the check would pass its own
 * sabotage — CLAUDE.md §3.8, "a guard may never read its threshold from the
 * value under test". This is the fixed point the comparison anchors on.
 */
const DOCUMENTED_AS_OF = '2026-08-24T00:00:00.000Z';

/** The sample response from the API's own documentation, verbatim. */
const SAMPLE = {
  symbol: 'TCS',
  scripCode: '532540',
  freeFloatMarketCap: 233884.75,
  totalMarketCap: 831436.51,
  currency: 'INR',
  unit: 'Cr',
  source: 'BSE',
  asOf: DOCUMENTED_AS_OF,
};

const SECRET = 'jwt-do-not-leak-me';
const HOST = 'https://stub.invalid';

/**
 * A stubbed upstream. `mode` selects which documented outcome it produces.
 *
 * `passthrough` matters: the module under test is a Worker entry point, and
 * anything it fetches that is NOT the filings API should still reach the real
 * implementation rather than being silently swallowed by the stub.
 */
function installUpstream(state) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (!target.includes('/filings/free_float_market_cap')) return realFetch(url, init);
    state.calls += 1;
    state.lastAuth = init?.headers?.authorization ?? null;
    state.lastBody = init?.body ? JSON.parse(init.body) : null;

    const json = (payload, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

    switch (state.mode) {
      case 'unauthorised': return new Response('denied', { status: 401 });
      case 'notfound': return new Response('not found', { status: 404 });
      case 'wrong-unit': return json({ ...SAMPLE, unit: 'Rs' });
      case 'impossible-factor': return json({ ...SAMPLE, freeFloatMarketCap: SAMPLE.totalMarketCap * 1.2 });
      case 'no-numbers': return json({ ...SAMPLE, freeFloatMarketCap: null, totalMarketCap: null });
      default: return json({ ...SAMPLE, scripCode: String(state.lastBody?.ticker ?? SAMPLE.scripCode) });
    }
  };
  return () => { globalThis.fetch = realFetch; };
}

/* ── harness ──────────────────────────────────────────────────────────────── */

const ASSETS = { fetch: async () => new Response('static-asset', { status: 200 }) };
const CTX = { waitUntil: (promise) => promise };

/**
 * A fresh call into the Worker.
 *
 * Every call gets a FRESH CACHE by default. Sharing one across checks would
 * make each check's result depend on which checks ran before it, and `--only`
 * would then report something different from a full run.
 */
async function callRoute(ctx, { path = '/api/freefloat', method = 'POST', tickers = null, env = {}, cache = null } = {}) {
  const cacheStub = cache ?? makeCacheStub();
  const previousCaches = globalThis.caches;
  globalThis.caches = cacheStub.api;
  try {
    const request = tickers === null
      ? new Request(`https://worker.invalid${path}`, { method: method === 'POST' ? 'POST' : method })
      : new Request(`https://worker.invalid${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tickers }),
      });
    const response = await ctx.worker.fetch(request, { ASSETS, ...env }, CTX);
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON — the caller asserts on `text` */ }
    return { response, body, text, cacheStub };
  } finally {
    globalThis.caches = previousCaches;
  }
}

/**
 * Install a sabotage BETWEEN the check and the Worker.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT JUST FLIP THE UPSTREAM STUB
 * ---------------------------------------------------------------------------
 * Because most of these checks SET the upstream mode themselves — it is their
 * premise ("given a 404, …"). A sabotage that only changes that mode is undone
 * by the first line of the run it is meant to break, the check passes, and
 * `--prove` reports CANNOT FAIL. That happened to seven of the ten here on the
 * first attempt, and it is the same shape as the self-defeating guard in
 * CLAUDE.md §3.8: the thing under test resets the thing testing it.
 *
 * So a sabotage wraps `ctx.worker.fetch` and rewrites what comes BACK. That is
 * the layer a bad edit to the route would actually change, and nothing inside
 * `run` can reach it.
 */
function sabotageResponse(ctx, transform) {
  if (!ctx.__realWorker) ctx.__realWorker = ctx.worker;
  const real = ctx.__realWorker;
  ctx.worker = {
    fetch: async (request, env, context) => {
      const response = await real.fetch(request, env, context);
      const text = await response.text();
      let body = null;
      try { body = JSON.parse(text); } catch { return new Response(text, { status: response.status, headers: response.headers }); }
      const patched = transform(body, { request, env });
      if (patched === undefined) return new Response(text, { status: response.status, headers: response.headers });
      return new Response(JSON.stringify(patched), { status: response.status, headers: response.headers });
    },
  };
}

/** Put the real Worker back, and the upstream stub with it. */
function restoreWorker(ctx) {
  if (ctx.__realWorker) ctx.worker = ctx.__realWorker;
  ctx.__realWorker = null;
  ctx.setMode('ok');
}

const CONFIGURED = { MUNS_API_BASE: HOST, MUNS_JWT: SECRET };

async function main() {
  // parseArgs slices argv itself — passing an already-sliced array silently
  // drops every flag, and the suite then reports a clean run that proved nothing.
  const { prove, only } = parseArgs(process.argv);
  const suite = new Suite('verify-worker', { prove, only, timeoutMs: 30000 });

  const state = { mode: 'ok', calls: 0, lastAuth: null, lastBody: null };
  const restoreFetch = installUpstream(state);

  const ctx = {
    worker: (await import('../worker/index.js')).default,
    state,
    // Sabotages patch this and `restore` puts it back, so a broken upstream
    // cannot leak from one check into the next.
    setMode: (mode) => { state.mode = mode; },
  };

  suite.section('The free-float route — units and arithmetic');

  await suite.check({
    id: 1,
    what: 'the crore unit is carried across the wire in the FIELD NAME, never silently converted',
    run: async (c) => {
      c.setMode('ok');
      const { body } = await callRoute(c, { tickers: ['532540'], env: CONFIGURED });
      ok(body?.ok === true, 'the route must resolve the documented sample', JSON.stringify(body).slice(0, 200));
      const value = body.values['532540'];
      equal(body.unit, 'Cr', 'the envelope must name its unit');
      equal(body.currency, 'INR', 'the envelope must name its currency');
      equal(value.freeFloatCr, SAMPLE.freeFloatMarketCap, 'the free float must cross the wire in crore, under a name that says so');
      equal(value.fullCr, SAMPLE.totalMarketCap, 'the full market cap must cross the wire in crore');
      ok(!('freeFloatMcapInr' in value), 'the Worker must NOT invent a rupee field — the browser converts, once');
      return `freeFloatCr ${value.freeFloatCr} · fullCr ${value.fullCr} · unit ${body.unit}`;
    },
    // The exact bad edit this guards against: the Worker "helpfully" converts
    // to rupees and renames the field, so downstream cannot tell which unit it
    // holds — CLAUDE.md §3.8's ten-million-fold error.
    sabotage: (c) => sabotageResponse(c, (body) => {
      if (!body?.values) return undefined;
      for (const value of Object.values(body.values)) {
        value.freeFloatMcapInr = Math.round(value.freeFloatCr * 1e7);
        delete value.freeFloatCr;
      }
      return body;
    }),
    restore: restoreWorker,
  }, ctx);

  await suite.check({
    id: 2,
    what: 'a unit the Worker does not recognise is REFUSED, never guessed at',
    run: async (c) => {
      c.setMode('wrong-unit');
      const { body } = await callRoute(c, { tickers: ['532540'], env: CONFIGURED });
      equal(body?.ok, false, 'an unknown unit must not produce a value');
      ok(/INR \/ Rs/.test(body.failed?.[0]?.reason ?? ''), 'the failure must name the units it actually saw', JSON.stringify(body.failed));
      equal(Object.keys(body.values ?? {}).length, 0, 'a refused reading is absent, never a zero');
      return `refused: ${body.failed[0].reason}`;
    },
    // The guard stops guarding: an unrecognised unit is waved through as a
    // value instead of being refused.
    sabotage: (c) => sabotageResponse(c, (body) => {
      if (body?.ok !== false) return undefined;
      return { ...body, ok: true, values: { 532540: { freeFloatCr: SAMPLE.freeFloatMarketCap, fullCr: SAMPLE.totalMarketCap, factor: 0.28 } }, failed: [] };
    }),
    restore: restoreWorker,
  }, ctx);

  await suite.check({
    id: 3,
    what: 'the float factor comes from ONE response, and an impossible one is a failure not a number',
    run: async (c) => {
      c.setMode('ok');
      const { body } = await callRoute(c, { tickers: ['532540'], env: CONFIGURED });
      const value = body.values['532540'];
      const expected = SAMPLE.freeFloatMarketCap / SAMPLE.totalMarketCap;
      ok(Math.abs(value.factor - expected) < 1e-12, 'the factor must be MktCapFF / MktCapFull from the same payload',
        `${value.factor} vs ${expected}`);
      ok(value.factor > 0 && value.factor <= 1, 'a factor must lie in (0, 1]', String(value.factor));

      c.setMode('impossible-factor');
      const impossible = await callRoute(c, { tickers: ['532540'], env: CONFIGURED });
      equal(impossible.body?.ok, false, 'free float above full market cap is impossible and must not render');
      ok(/outside \(0, 1\]/.test(impossible.body.failed?.[0]?.reason ?? ''),
        'the failure must say the factor was out of range', JSON.stringify(impossible.body.failed));
      return `factor ${value.factor.toFixed(6)} accepted · 1.20 refused`;
    },
    // The range check goes away, so a free float larger than the whole company
    // becomes a number the screen would print without complaint.
    sabotage: (c) => sabotageResponse(c, (body) => {
      if (body?.ok !== false) return undefined;
      return { ...body, ok: true, values: { 532540: { freeFloatCr: SAMPLE.totalMarketCap * 1.2, fullCr: SAMPLE.totalMarketCap, factor: 1.2 } }, failed: [] };
    }),
    restore: restoreWorker,
  }, ctx);

  suite.section('The free-float route — provenance and failure states');

  await suite.check({
    id: 4,
    what: "BSE's own as-of is carried verbatim and never merged with our fetch time",
    run: async (c) => {
      c.setMode('ok');
      const { body } = await callRoute(c, { tickers: ['532540'], env: CONFIGURED });
      const value = body.values['532540'];
      // Anchored on the CONSTANT, never on SAMPLE.asOf — see DOCUMENTED_AS_OF.
      equal(value.asOf, DOCUMENTED_AS_OF, "the upstream's as-of must survive unchanged");
      ok(typeof body.fetchedAt === 'string', 'our own fetch time must be present and named separately');
      ok(body.fetchedAt !== value.asOf,
        'when BSE measured it is a different fact from when we asked', `${body.fetchedAt} vs ${value.asOf}`);
      return `BSE asOf ${value.asOf} · fetchedAt ${body.fetchedAt}`;
    },
    // Restamp BSE's measurement with our clock — exactly what CLAUDE.md §3.7
    // forbids for the NSE session timestamp, and the same error here.
    sabotage: (c) => sabotageResponse(c, (body) => {
      if (!body?.values) return undefined;
      for (const value of Object.values(body.values)) value.asOf = body.fetchedAt;
      return body;
    }),
    restore: restoreWorker,
  }, ctx);

  await suite.check({
    id: 5,
    what: 'an upstream 404 is a named failure for that ticker, never a fact about the company',
    run: async (c) => {
      c.setMode('notfound');
      const { body } = await callRoute(c, { tickers: ['532540'], env: CONFIGURED });
      equal(body?.ok, false, 'a 404 must not resolve');
      equal(Object.keys(body.values ?? {}).length, 0, 'nothing may be invented for a ticker the upstream could not map');
      ok(/no BSE scrip code/.test(body.failed?.[0]?.reason ?? ''),
        'the reason must say what the upstream actually reported', JSON.stringify(body.failed));
      return `404 -> "${body.failed[0].reason}"`;
    },
    // Report the outage as an ordinary empty result with no reason attached —
    // a failure rendered as an absence, CLAUDE.md §2.4.
    sabotage: (c) => sabotageResponse(c, (body) => {
      if (body?.ok !== false) return undefined;
      return { ...body, failed: [] };
    }),
    restore: restoreWorker,
  }, ctx);

  await suite.check({
    id: 6,
    what: 'a missing host and a missing token are DIFFERENT failures, each naming its own command',
    run: async (c) => {
      c.setMode('ok');
      const noHost = await callRoute(c, { tickers: ['532540'], env: { MUNS_JWT: SECRET } });
      equal(noHost.body?.reason, 'no-endpoint', 'a missing host must be its own state');
      ok(/MUNS_API_BASE/.test(noHost.body.remedy ?? ''),
        'the remedy must name the variable an operator has to set', String(noHost.body.remedy));

      const noToken = await callRoute(c, { tickers: ['532540'], env: { MUNS_API_BASE: HOST } });
      equal(noToken.body?.reason, 'no-token', 'a missing token must be its own state');
      ok(/MUNS_/.test(noToken.body.remedy ?? ''), 'the remedy must name a command', String(noToken.body.remedy));

      ok(noHost.body.remedy !== noToken.body.remedy,
        'two different misconfigurations must not print the same instruction');
      return `no-endpoint and no-token are distinct, with distinct remedies`;
    },
    sabotage: async () => {
      // Collapse the two states into one, which is what a single combined
      // "not configured" check would do.
      const http = await import('../worker/http.mjs');
      http.REMEDY['no-endpoint'] = http.REMEDY['no-token'];
    },
    restore: async () => {
      const http = await import('../worker/http.mjs');
      http.REMEDY['no-endpoint'] = 'Set the filings API host: npx wrangler secret put MUNS_API_BASE '
        + '(or add MUNS_API_BASE to .dev.vars for local dev). Example: https://api.example.com';
      restoreWorker(ctx);
    },
  }, ctx);

  suite.section('The free-float route — the credential');

  await suite.check({
    id: 7,
    what: 'the bearer token reaches the upstream and appears in NOTHING the browser can read',
    run: async (c) => {
      c.setMode('ok');
      const { body, text } = await callRoute(c, { tickers: ['532540'], env: CONFIGURED });
      equal(c.state.lastAuth, `Bearer ${SECRET}`, 'the upstream must receive the bearer token');
      ok(!text.includes(SECRET), 'the token must not appear in the response body', text.slice(0, 200));
      ok(!text.includes(HOST), 'the upstream host must not be echoed to the browser either');

      const health = await callRoute(c, { path: '/api/health', method: 'GET', env: CONFIGURED });
      ok(!health.text.includes(SECRET), 'the health route must not leak the token', health.text.slice(0, 200));
      ok(health.body.freeFloat.endpointConfigured === true && health.body.freeFloat.tokenConfigured === true,
        'health must report configuration as booleans');
      return `token delivered upstream, absent from ${text.length}-byte body and from /api/health`;
    },
    // A debug field becomes a leak. This is not hypothetical — echoing the
    // upstream request back "for troubleshooting" is the ordinary way a token
    // reaches a browser.
    sabotage: (c) => sabotageResponse(c, (body, { env }) => {
      if (!body) return undefined;
      return { ...body, debug: { upstream: env.MUNS_API_BASE, sentAuthorization: `Bearer ${env.MUNS_JWT ?? env.MUNS_TOKEN}` } };
    }),
    restore: restoreWorker,
  }, ctx);

  await suite.check({
    id: 8,
    what: 'MUNS_TOKEN serves as a fallback credential, so one secret can cover both services',
    run: async (c) => {
      c.setMode('ok');
      const { body } = await callRoute(c, { tickers: ['532540'], env: { MUNS_API_BASE: HOST, MUNS_TOKEN: 'shared-secret' } });
      equal(body?.ok, true, 'MUNS_TOKEN alone must be enough to authorise the route');
      equal(c.state.lastAuth, 'Bearer shared-secret', 'the fallback credential must be the one actually sent');
      return 'MUNS_JWT absent, MUNS_TOKEN used';
    },
    // The fallback is removed, so a deployment carrying only MUNS_TOKEN stops
    // working the day this route ships.
    sabotage: (c) => sabotageResponse(c, (body) => {
      if (body?.ok !== true) return undefined;
      return { ok: false, reason: 'no-token', detail: 'MUNS_JWT is not configured on this Worker', values: {}, failed: [] };
    }),
    restore: restoreWorker,
  }, ctx);

  suite.section('The free-float route — limits and the static floor');

  await suite.check({
    id: 9,
    what: 'the batch cap is enforced, and a rejected batch says what the cap is',
    run: async (c) => {
      c.setMode('ok');
      const tooMany = Array.from({ length: 26 }, (_, i) => `90000${i}`);
      const { body } = await callRoute(c, { tickers: tooMany, env: CONFIGURED });
      equal(body?.reason, 'bad-request', 'a batch over the cap must be refused');
      ok(/exceeds the 25 limit/.test(body.detail ?? ''), 'the refusal must name the limit', String(body.detail));

      const empty = await callRoute(c, { tickers: [], env: CONFIGURED });
      equal(empty.body?.reason, 'bad-request', 'an empty batch must be refused rather than answered with nothing');
      return `26 refused, 0 refused, cap named in the message`;
    },
    // Let an unbounded batch through: 1,254 authenticated round trips per page
    // view, against somebody else's free service.
    sabotage: (c) => sabotageResponse(c, (body) => {
      if (body?.reason !== 'bad-request') return undefined;
      return { ...body, ok: true, reason: null, detail: null, values: {}, failed: [] };
    }),
    restore: restoreWorker,
  }, ctx);

  await suite.check({
    id: 10,
    what: 'every non-API path still falls through to the static assets',
    run: async (c) => {
      c.setMode('ok');
      const asset = await callRoute(c, { path: '/index.html', method: 'GET', env: CONFIGURED });
      equal(asset.text, 'static-asset', 'the site must keep working around the Worker, not through it');
      const missingRoute = await callRoute(c, { path: '/api/nope', method: 'GET', env: CONFIGURED });
      equal(missingRoute.text, 'static-asset', 'an unknown /api path is not a route this Worker owns');
      return 'static assets served for /index.html and unknown /api paths';
    },
    sabotage: (c) => {
      c.__origAssets = ASSETS.fetch;
      ASSETS.fetch = async () => new Response('hijacked', { status: 200 });
    },
    restore: (c) => { if (c.__origAssets) ASSETS.fetch = c.__origAssets; restoreWorker(c); },
  }, ctx);

  restoreFetch();

  process.exit(suite.report([
    'Upstream: a stub implementing the documented /filings/free_float_market_cap contract.',
    'No network, no wrangler, no credentials — the route is exercised as a unit.',
  ]));
}

main().catch((error) => {
  process.stderr.write(`\n  verify-worker crashed: ${error.stack}\n\n`);
  process.exit(2);
});
