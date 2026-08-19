# Sattva Index Flows

A dashboard that tracks and forecasts what global index-tracking ETFs must buy and sell in Indian
equities around MSCI's quarterly reviews. It covers every listed Indian company above ₹2,000 Cr —
**1,202 companies**, of which **619** are held by at least one of the three iShares funds it follows —
and for each one shows its free-float market cap on the exchange's own published figure, which index
segment it sits in, its weight in each fund, how far it is from the size thresholds, and a rupee flow
estimate where a threshold crossing is implied.

---

## Two things only the repository owner can do

**1. Add `MUNS_TOKEN` to repository secrets** — Settings → Secrets and variables → Actions → New
repository secret. Until then the `Interface — Worker` CI job renders as **Skipped** (not passing —
see `docs/HANDOFF.md`) and assertion 39 is exercised only when someone runs the suite locally against
`wrangler dev`.

**2. Run the liveness probe inside market hours** — 09:15–15:30 IST, Monday to Friday:

```bash
node scripts/probe-liveness.mjs --symbols RELIANCE,HFCL,TCS --gap-seconds 600
```

It answers one open question: does the upstream quote feed actually move intraday, or does it serve
a stale close? Nothing in the repo depends on the answer, but the "Live · NSE" pill claims it. The
result belongs in `docs/OPEN-ITEMS.md`. **It has not yet been run** — every attempt so far has landed
outside market hours.

---

## Run it

```bash
python3 -m http.server 8080 -d public
```

That is the whole thing. No build, no bundler, no install, no `package.json`, no `node_modules`.
Vanilla ES modules and Tailwind from a CDN. Every row sits on its committed end-of-day price, the
header reads "Last close · BSE", and that is the **designed floor** — not a degraded mode.

For live intraday prices you also need the Worker, which exists solely to hold the upstream token so
the browser never sees it:

```bash
echo 'MUNS_TOKEN=...' > .dev.vars     # gitignored; never committed
npx wrangler dev                      # serves the same site plus POST /api/quotes
```

---

## Verify it

Two suites, 42 assertions, both exit non-zero on any failure.

```bash
node scripts/verify-data.mjs                                      # 21 checks, no browser, no network
node scripts/verify-ui.mjs                                        # 21 checks vs http://127.0.0.1:8080
node scripts/verify-ui.mjs http://127.0.0.1:8787 --require-live   # vs `npx wrangler dev`
node scripts/verify-data.mjs --prove                              # break each check; it must go red
node scripts/verify-ui.mjs --prove
```

**Read `--prove` before you add a check.** It breaks each assertion on purpose and reports
**CANNOT FAIL — as a failure** for any that survives. Its first runs failed seven of the suite's own
checks, all of which had been showing a tick, and one of which could never have failed at all. A
check that has not been seen to fail is an assumption wearing a tick mark.

`verify-ui` needs Playwright, which is a **global tool, never a dependency of this repo**:

```bash
npm install -g playwright && playwright install chromium
```

**SKIP is a real result, never rounded up to a pass.** Against the static server the live checks skip
and say so; `--require-live` turns a skip in that block into a failure. Two checks also skip when the
Tailwind CDN is unreachable, because layout and colour cannot be measured without a stylesheet.

---

## Refresh the data

Every file under `public/data/` is a generated artefact that is **committed**, so the static site
works with no network. Never hand-edit one — change the script and re-run.

| Cadence | Command | What it refreshes |
| --- | --- | --- |
| Weekdays 20:00 IST (CI) | `node scripts/fetch-bhavcopy.mjs && node scripts/build-companies.mjs` | closing prices, then the joined record |
| 1st of the month (CI) | the full order below | float factors, share counts, ADV, the universe |
| When BlackRock publish | `node scripts/import-ishares.mjs` | fund holdings, from the committed workbooks |

Full monthly order — later scripts read what earlier ones write:

```bash
node scripts/import-ishares.mjs        # 3 workbooks, no network
node scripts/fetch-bse-master.mjs      # 1 request, ~1.7 MB
node scripts/fetch-nse-universe.mjs    # 2 requests, the ISIN bridge
node scripts/scrape-nse-freefloat.mjs  # 3 requests, 261 symbols
node scripts/scrape-bse-freefloat.mjs  # ~3,600 requests, ~25 min — the long one
node scripts/fetch-bhavcopy.mjs        # 1 request, the whole market's closes
node scripts/fetch-quote-stats.mjs --concurrency 1 --gap-ms 1200
node scripts/reconcile-shares.mjs      # share-count outliers -> quarantine
node scripts/build-companies.mjs       # no network; joins everything
```

`scrape-bse-freefloat.mjs --limit 20` checks the endpoint is healthy and **writes nothing** — use it
before spending twenty-five minutes. Every writer refuses to replace a good snapshot with a smaller
one; pass `--allow-shrink` only when the universe genuinely shrank.

---

## Deploy it

```bash
npx wrangler deploy --dry-run     # validates without credentials
npx wrangler secret put MUNS_TOKEN
npx wrangler deploy
```

`wrangler.jsonc` serves `public/` as static assets and routes only `POST /api/quotes` through the
Worker. Details, including the custom-domain step, are in `docs/HANDOFF.md`.

---

## Where to read next

| | |
| --- | --- |
| `docs/CLIENT-BRIEF.md` | **Start here if you commissioned this.** What it answers, what it will not tell you, and the two places we did not build what was asked. |
| `docs/HANDOFF.md` | The map: pipeline, architecture, every trap and its misleading symptom. |
| `docs/SPEC.md` | The product as shipped: navigation, tokens, the model, the honesty rules. |
| `docs/DATA-CONTRACTS.md` | Every JSON shape, unit, source and cadence — and where the model is weakest. |
| `docs/OPEN-ITEMS.md` | What is not done, ranked by what it changes. |
| `CLAUDE.md` | The working contract. Binding on anyone changing this repo. |
