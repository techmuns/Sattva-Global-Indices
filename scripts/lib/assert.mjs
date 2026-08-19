/**
 * The verification harness. One summary format for both suites.
 *
 * THREE RULES THIS MODULE EXISTS TO ENFORCE
 *
 * 1. A check that cannot fail is not a check. Every spec may carry a
 *    `sabotage()` that deliberately breaks the thing it tests. `--prove` runs
 *    each check against its own sabotaged input and demands that it goes red.
 *    A check that survives its own sabotage is reported as CANNOT-FAIL, which
 *    is a louder result than a pass — it means the check is decoration.
 *
 * 2. SKIP is a first-class result and is never rounded up to a pass. Every run
 *    prints how many checks were skipped and why. A suite that quietly skips
 *    half of itself and reports "all passed" is worse than no suite, because it
 *    manufactures confidence rather than merely failing to provide it. Where a
 *    skip is not acceptable — a live block run against a real Worker —
 *    `--require-live` converts it into a failure.
 *
 * 3. A failure names what broke, not that something did. `detail` is printed
 *    verbatim and should carry the measured values, so a red run in CI can be
 *    diagnosed without re-running it locally.
 */

export const TICK = '✓';
export const CROSS = '✗';
export const SKIP_MARK = '⊘';

/** Thrown by a check that cannot run here. Not a failure, not a pass. */
export class Skipped extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'Skipped';
  }
}

/** Skip the current check with a stated reason. */
export function skip(reason) {
  throw new Skipped(reason);
}

/** Fail the current check with a stated reason. */
export function fail(what, detail) {
  const error = new Error(detail ? `${what} — ${detail}` : what);
  error.name = 'CheckFailure';
  throw error;
}

/** Assert, or fail with the detail attached. */
export function ok(condition, what, detail) {
  if (!condition) fail(what, detail);
  return true;
}

/** Assert equality, printing both sides. */
export function equal(actual, expected, what) {
  if (!Object.is(actual, expected)) {
    fail(what, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  return true;
}

/** Assert a list is empty, printing the first few offenders. */
export function empty(list, what, render = (x) => String(x), show = 5) {
  if (list.length !== 0) {
    fail(
      what,
      `${list.length} offender(s): ${list.slice(0, show).map(render).join(' | ')}` +
        (list.length > show ? ` … and ${list.length - show} more` : ''),
    );
  }
  return true;
}

const pad = (n, width = 2) => String(n).padStart(width, '0');

export class Suite {
  /**
   * @param {string} label
   * @param {{requireLive?: boolean, prove?: boolean, stream?: NodeJS.WriteStream}} options
   */
  constructor(label, { requireLive = false, prove = false, only = '', timeoutMs = 0, stream = process.stdout } = {}) {
    this.label = label;
    this.requireLive = requireLive;
    this.prove = prove;
    // `--only=14,21` while iterating on a check. A filtered run is never
    // allowed to read as a clean one: the summary leads with FILTERED and
    // names how many checks were not considered at all.
    this.only = only ? new Set(String(only).split(',').map((x) => x.trim()).filter(Boolean)) : null;
    this.skippedByFilter = 0;
    // A HANG IS AN OUTAGE REPORTED AS NOTHING. A runaway check — a sabotage
    // that re-triggers itself, a selector that never appears — would otherwise
    // stall the run until CI's own timeout kills it with no output at all. A
    // per-check deadline turns that into a named failure on the right line.
    this.timeoutMs = timeoutMs;
    this.stream = stream;
    this.entries = [];
    this.startedAt = Date.now();
    this.currentSection = null;
  }

  section(name) {
    this.currentSection = name;
    this.stream.write(`\n  ${name}\n`);
  }

  write(line) {
    this.stream.write(line);
  }

  /**
   * Run one check.
   *
   * @param {{
   *   id: number|string,
   *   what: string,
   *   run: (ctx: any) => any,
   *   sabotage?: (ctx: any) => any,
   *   clone?: (ctx: any) => any,
   *   restore?: (ctx: any) => any,
   *   live?: boolean,
   * }} spec
   * @param {any} ctx passed to run() and sabotage()
   */
  async check(spec, ctx = undefined) {
    const { id, what, run, sabotage, clone, restore, live = false } = spec;
    if (this.only && !this.only.has(String(id))) { this.skippedByFilter += 1; return null; }
    const started = Date.now();
    let outcome;

    const withDeadline = async (fn, what) => {
      if (!this.timeoutMs) return fn();
      let timer;
      try {
        return await Promise.race([
          fn(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(Object.assign(new Error(`${what} exceeded ${this.timeoutMs} ms and was abandoned`), { name: 'CheckFailure' })),
              this.timeoutMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      const note = await withDeadline(() => run(ctx), 'the check');
      outcome = { state: 'pass', note: typeof note === 'string' ? note : null };
    } catch (error) {
      if (error instanceof Skipped) {
        // A skip inside a live block is a failure when the caller demanded live.
        outcome = this.requireLive && live
          ? { state: 'fail', detail: `SKIPPED under --require-live: ${error.message}` }
          : { state: 'skip', detail: error.message };
      } else {
        outcome = { state: 'fail', detail: error.message };
      }
    }

    // --prove: the check must go red against its own sabotage.
    let proof = null;
    if (this.prove && outcome.state !== 'skip') {
      if (!sabotage) {
        proof = 'is missing — this check declares no way to break what it tests';
      } else {
        const scratch = clone ? await clone(ctx) : ctx;
        try {
          await withDeadline(() => sabotage(scratch), 'the sabotage');
          try {
            await withDeadline(() => run(scratch), 'the sabotaged check');
            proof = 'SURVIVED';
          } catch (error) {
            proof = error instanceof Skipped ? 'SURVIVED (skipped)' : 'fails as required';
          }
        } catch (error) {
          proof = `sabotage itself threw: ${error.message}`;
        } finally {
          if (restore) {
            try { await restore(ctx); } catch { /* restoration failure surfaces in the next check */ }
          }
        }
        if (proof !== 'fails as required') {
          outcome = {
            state: 'fail',
            detail: `CANNOT FAIL — the sabotage ${proof === 'SURVIVED' ? 'was survived' : proof}. `
              + 'A check that cannot fail is not a check.',
          };
        }
      }
    }

    const entry = {
      id,
      what,
      section: this.currentSection,
      live,
      ms: Date.now() - started,
      proof,
      ...outcome,
    };
    this.entries.push(entry);
    this.print(entry);
    return entry;
  }

  print(entry) {
    const mark = entry.state === 'pass' ? TICK : entry.state === 'fail' ? CROSS : SKIP_MARK;
    const id = typeof entry.id === 'number' ? pad(entry.id) : String(entry.id);
    const proof = entry.proof === 'fails as required' ? '  [proved]' : '';
    this.stream.write(`    ${mark}  ${id}  ${entry.what}${proof}\n`);
    if (entry.detail) this.stream.write(`           ${entry.detail}\n`);
    else if (entry.note) this.stream.write(`           ${entry.note}\n`);
  }

  get counts() {
    const passed = this.entries.filter((e) => e.state === 'pass').length;
    const failed = this.entries.filter((e) => e.state === 'fail').length;
    const skipped = this.entries.filter((e) => e.state === 'skip').length;
    return { passed, failed, skipped, total: this.entries.length };
  }

  /**
   * Print the summary and return the process exit code.
   * SKIPS ARE ALWAYS ENUMERATED, with their reasons. Silence about a skip is
   * how a suite comes to report success for work it did not do.
   */
  report(extraLines = []) {
    const { passed, failed, skipped, total } = this.counts;
    const seconds = ((Date.now() - this.startedAt) / 1000).toFixed(1);

    this.stream.write('\n');
    if (this.only) {
      this.stream.write(
        `  FILTERED RUN — --only=${[...this.only].join(',')} considered ${total} check(s) ` +
        `and did not run ${this.skippedByFilter}. This result says nothing about them.\n`,
      );
    }
    for (const line of extraLines) this.stream.write(`  ${line}\n`);

    const skips = this.entries.filter((e) => e.state === 'skip');
    if (skips.length) {
      this.stream.write(`\n  SKIPPED — ${skips.length} check(s) did not run:\n`);
      for (const entry of skips) {
        this.stream.write(`    ${pad(entry.id)}  ${entry.what}\n           ${entry.detail}\n`);
      }
    } else {
      this.stream.write('\n  SKIPPED — none. Every check ran.\n');
    }

    const fails = this.entries.filter((e) => e.state === 'fail');
    if (fails.length) {
      this.stream.write(`\n  FAILED — ${fails.length} check(s):\n`);
      for (const entry of fails) {
        this.stream.write(`    ${pad(entry.id)}  ${entry.what}\n           ${entry.detail}\n`);
      }
    }

    if (this.prove) {
      const unproved = this.entries.filter((e) => e.state !== 'skip' && e.proof !== 'fails as required');
      this.stream.write(
        unproved.length
          ? `\n  UNPROVED — ${unproved.length} check(s) were not shown to fail:\n` +
            unproved.map((e) => `    ${pad(e.id)}  ${e.what} (${e.proof})\n`).join('')
          : '\n  PROVED — every check was made to fail on purpose.\n',
      );
    }

    this.stream.write(
      `\n  ${this.label}: ${total} checks — ${passed} passed, ${failed} failed, ` +
        `${skipped} skipped   (${seconds}s)\n\n`,
    );
    return failed === 0 ? 0 : 1;
  }
}

/**
 * Parse the flags both suites share.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const args = argv.slice(2);
  return {
    requireLive: args.includes('--require-live'),
    prove: args.includes('--prove'),
    only: (args.find((a) => a.startsWith('--only='))    ?? '').slice('--only='.length),
    baseUrl: args.find((a) => /^https?:\/\//.test(a)) ?? null,
  };
}
