/**
 * live.js — a minimal poller: register / subscribe / start / stop.
 *
 * Deliberately small and deliberately defensive, because the failure modes of a
 * poller are all silent:
 *
 *   - EVERY PATH THROUGH THE FETCHER MUST RESOLVE. A fetcher that never settles
 *     kills the loop with no error, no tick and no clue — the feed simply stops
 *     and the page keeps showing whatever it had. Every call is therefore
 *     wrapped so that a throw becomes a resolved failure.
 *   - IT RUNS ONLY WHILE THE DOCUMENT IS VISIBLE. A backgrounded tab polling a
 *     paid upstream every 30 seconds for a day is somebody's bill.
 *   - ERRORS BACK OFF EXPONENTIALLY, capped, and never reach the UI as
 *     exceptions. A subscriber that throws must not stop the loop either.
 */

const DEFAULT_INTERVAL_MS = 30000;
const MAX_BACKOFF_MS = 60000;

export function createPoller({
  fetcher,
  intervalMs = DEFAULT_INTERVAL_MS,
  shouldPoll = () => true,
  name = 'poller',
} = {}) {
  const subscribers = new Set();
  let timer = null;
  let running = false;
  let inFlight = false;
  let failures = 0;
  let lastTickAt = null;
  let lastResult = null;

  const emit = (event) => {
    for (const handler of subscribers) {
      try {
        handler(event);
      } catch (error) {
        // A subscriber that throws must not take the loop down with it.
        console.error(`[${name}] subscriber threw`, error);
      }
    }
  };

  const delay = () =>
    failures === 0
      ? intervalMs
      : Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** Math.min(failures, 6));

  function schedule() {
    clearTimeout(timer);
    if (!running) return;
    timer = setTimeout(tick, delay());
  }

  async function tick() {
    if (!running || inFlight) return;

    if (!shouldPoll()) {
      // Not an error — there is simply nothing to ask for right now (outside
      // market hours, no eligible symbols). Keep the cadence, reset the backoff.
      failures = 0;
      emit({ type: 'idle', at: new Date() });
      schedule();
      return;
    }

    inFlight = true;
    let result;
    try {
      // Even a fetcher that throws synchronously resolves here.
      result = await Promise.resolve().then(fetcher);
      if (!result || typeof result !== 'object') result = { ok: false, reason: 'fetcher returned nothing' };
    } catch (error) {
      result = { ok: false, reason: 'unreachable', detail: String(error?.message ?? error) };
    } finally {
      inFlight = false;
    }

    lastTickAt = new Date();
    lastResult = result;

    if (result.ok) {
      failures = 0;
      emit({ type: 'tick', at: lastTickAt, result });
    } else {
      failures += 1;
      emit({ type: 'error', at: lastTickAt, result, failures, nextDelayMs: delay() });
    }
    schedule();
  }

  function onVisibility() {
    if (document.visibilityState === 'visible') {
      if (!running) return;
      // Returning to a tab should show fresh numbers, not wait out the interval.
      clearTimeout(timer);
      tick();
    } else {
      clearTimeout(timer);
    }
  }

  return {
    subscribe(handler) {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
    start({ immediate = true } = {}) {
      if (running) return;
      running = true;
      failures = 0;
      document.addEventListener('visibilitychange', onVisibility);
      if (immediate && document.visibilityState === 'visible') tick();
      else schedule();
    },
    stop() {
      running = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    },
    /** Force a tick now, e.g. from a manual refresh control. */
    refresh() {
      clearTimeout(timer);
      return tick();
    },
    get state() {
      return { running, inFlight, failures, lastTickAt, lastResult, intervalMs, nextDelayMs: delay() };
    },
  };
}
