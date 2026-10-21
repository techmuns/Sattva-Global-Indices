/**
 * playwright.mjs — the browser driver, from wherever it is installed globally.
 *
 * There is no package.json in this repo and there is not going to be one
 * (CLAUDE.md §1), so Playwright is a GLOBAL tool, never a dependency: CI runs
 * `npm install -g playwright` and sets NODE_PATH, and a laptop that has it
 * installed globally works the same way. Two callers share this loader —
 * verify-ui.mjs drives the served site, fetch-ftse.mjs presses Vanguard's own
 * download button — so the resolution rules cannot drift between them.
 *
 * Returns null when it is absent. Each caller decides what that means: for the
 * suite it is an environment failure, for the fetcher a source it could not
 * read today.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';

export async function loadPlaywright() {
  // ESM does not honour NODE_PATH, so the global root is turned into an
  // explicit path rather than left to bare-specifier resolution. CI sets
  // NODE_PATH="$(npm root -g)" and the runner's own location differs by image.
  const globalRoots = (process.env.NODE_PATH ?? '').split(/[:;]/).filter(Boolean);
  const candidates = [
    'playwright',
    ...globalRoots.map((root) => join(root, 'playwright', 'index.js')),
    '/opt/node22/lib/node_modules/playwright/index.js',
    '/usr/lib/node_modules/playwright/index.js',
    '/usr/local/lib/node_modules/playwright/index.js',
    '/usr/local/share/npm-global/lib/node_modules/playwright/index.js',
  ];
  for (const specifier of candidates) {
    try {
      const mod = await import(specifier);
      return mod.default ?? mod;
    } catch { /* try the next one */ }
  }
  const require = createRequire(import.meta.url);
  try { return require('playwright'); } catch { /* fall through */ }
  return null;
}
