# Handover

For someone competent who has never seen this repository. Read `docs/CLIENT-BRIEF.md` first if you
want to know what it is *for*; this document is how it works and where it will bite you.

---

## 1. Measured, derived, modelled — check this before quoting any number

Every figure on screen belongs to exactly one of three tiers, and they are visually distinct. **If
you are asked "is this number real?", this is the answer.**

| Tier | Means | Where it comes from |
| --- | --- | --- |
| **Measured** | Somebody else published it; we carried it through unchanged. | `public/data/msci-funds.json` (iShares weights, quantities, market values, prices), `nse-freefloat.json`, `bse-freefloat.json`, `prices.json` |
| **Derived** | Arithmetic we performed on measured inputs, with the formula shown beside the number. | `public/js/core/format.js`, `scripts/lib/recompute.mjs` — free-float market cap, day change, weight drift, flow primitives |
| **Modelled** | An opinion produced by rules we wrote. | `public/js/model/` — segment placement, verdict, flow estimate |

A modelled figure never renders as a bare number. It renders as a band with its rules, thresholds
and threshold *sources* attached. `public/js/model/assess.js` exports `verdictFromRules()`, which
replays a verdict from its own rule record; `scripts/build-companies.mjs` asserts the replay matches
for all 1,202 companies on every build. A drill panel showing working that did not produce the answer
beside it is worse than a wrong answer, because it looks checkable.

---

## 2. The data pipeline, source by source

Everything under `public/data/` is a **generated artefact that is committed**, so the static site
needs no network. Change the script, re-run, commit the output. Never hand-edit.

### iShares workbooks — the funds

- **Gives**: holdings for three ETFs — EM (`eem`), India Small-Cap (`smin`), EM Small-Cap (`eems`):
  ticker, name, sector, market value, weight, quantity, price, exchange, FX rate.
- **Cadence**: whenever BlackRock publish. The workbooks are committed under `scripts/fixtures/`;
  `import-ishares.mjs` reads them with no network at all.
- **Coverage**: India equity rows **165 / 461 / 414**, weight sums **11.315% / 99.729% / 21.271%**.
- **Fails**: `import-ishares.mjs` refuses to write if any count or weight drifts from the `EXPECTED`
  table in the script. That table describes *the committed fixtures*, not the funds in general — when
  you drop in fresh workbooks, re-measure and update it **in the same commit**. Never loosen it.

### NSE pre-open — free float for the largest names

- **Gives**: `metadata.marketCap` from `/api/market-data-pre-open?key={NIFTY|FO|SME}`, which **is**
  free-float market cap in rupees.
- **Cadence**: monthly. Struck at the pre-open indicative price (09:00–09:08 IST), not at the close.
- **Coverage**: **261 of ~2,000** distinct symbols (NIFTY 50 + FO 208 + SME 53, unioned). `OTHERS`
  and `ALL` return `"-"` for every row; `BANKNIFTY` is 403.
- **Fails**: a blocked key goes into `failed[]` with its reason, never becomes an empty result. The
  script refuses to overwrite a good snapshot with a smaller one and exits non-zero if it collected
  nothing.

### BSE — the scrip master and per-scrip free float

- **Gives**: the entire active scrip master in one request (~1.7 MB), then per scrip `MktCapFull` and
  `MktCapFF` (the float factor), `CurrRate.LTP`, `ISIN` and sector.
- **Cadence**: monthly. ~3,600 requests, ~25 minutes, concurrency 4 with a gap.
- **Coverage**: **1,199 companies** — every active scrip above ₹2,000 Cr plus everything the funds
  hold. That floor is safe by construction: free float can never exceed full market cap, so nothing
  below it can be an inclusion candidate. **978 of the 978** active scrips above the desk's ₹3,500 Cr
  entry band are covered.
- **Fails**: no bot protection and no throttling observed over thousands of requests. The danger is
  not failure but **silent success on the wrong thing** — see traps 5 and 6.

### BSE bhavcopy — daily closes

- **Gives**: open/high/low/close/previous-close/volume for the whole market, one CSV.
- **Cadence**: weekdays 20:00 IST via `.github/workflows/daily-refresh.yml`.
- **Coverage**: **1,198 of 1,202** companies priced end-of-day, 1 carried forward stale, 3 unpriced.
- **Fails**: loudly. `assertBhavcopyShape` validates that the response parses as CSV, carries the
  expected columns, and that its own `TradDt` is the date requested; `assertContinuity` checks that
  today's previous-close equals yesterday's close, per scrip. The committed `prices.json` records its
  own result — **1,195 compared, 0 failures against 2026-08-18** — over the 1,199-company universe the
  pipeline tracks. (A one-off whole-file comparison over both complete bhavcopies gave 4,562 compared
  / 0 failures; that figure appears in `CLAUDE.md` and is **not reproducible from this repository**,
  because the full CSVs are not committed — only a 250-row sample, for assertion 18.) The job commits
  nothing on failure.

### Munshot — live prices, ADV, momentum

- **Gives**: intraday quotes through `POST /api/quotes` on the Worker; 3-month average daily volume,
  splits and yearly change through `fetch-quote-stats.mjs`.
- **Cadence**: live prices every 30 s while the market is open; statistics monthly.
- **Coverage**: **749 of 1,202** companies are live-eligible — those with a confirmed NSE symbol.
  The other 453 stay on their committed close and say so.
- **Fails**: see trap 7. Its failure mode is the most dangerous in the project because it looks like
  data rather than an outage.

---

## 3. The architecture, in one page

```
        browser
           │
           ├── public/index.html + public/js/**          static ES modules, no build step
           │      └── reads public/data/companies.json   the join of everything else
           │
           └── POST /api/quotes ──► Cloudflare Worker ──► fastapi.muns.io
                                    (worker/index.js)     holds MUNS_TOKEN
```

**The Worker does exactly one thing**: it holds the upstream token so the browser never sees it. It
serves `public/` as static assets and proxies one route. Nothing else routes through it.

**The static site is the floor, and it must always work.** Served by
`python3 -m http.server 8080 -d public` there is no `/api/quotes`; the poller records `no-worker`,
every row stays on its committed end-of-day price, and the header reads "Last close · BSE". That is
the designed state, not a degradation, and assertion 41 asserts it. Verify it after any change to the
live path.

**The monthly/daily split is the reason free float can be current without a monthly scrape.** What is
stored is the **float factor** — `MktCapFF / MktCapFull`, dimensionless and price-independent — and
the share count. Both move only when shareholding moves, which is quarterly. The price is daily, or
live. So:

```
freeFloatMcap(now) = floatFactor × sharesOutstanding × price(now)
```

A rupee free-float figure struck at one moment's price is wrong by the next day's open; the factor is
not. **The oldest input still governs the freshness claim** — a live price does not make a month-old
float factor live, and the header names the oldest feed, not the newest.

---

## 4. The traps

Each of these cost real time. Every one is listed with **the symptom that would make you misdiagnose
it**, because in every case the obvious diagnosis is wrong.

**1. The iShares `.xls` files are not `.xls` files.**
*Symptom*: your spreadsheet library throws "not a valid workbook", or opens it and gets garbage.
They are SpreadsheetML 2003 — plain UTF-8 XML with CRLF endings under
`urn:schemas-microsoft-com:office:spreadsheet`. Not binary BIFF, not CSV.
`scripts/lib/spreadsheetml.mjs` is the only place in the repo that knows this. Do not add a parsing
library; do not open them as binary.

**2. The three workbooks do not share a column set.**
*Symptom*: two funds parse perfectly and the third has sector data in the asset-class column — and
**nothing throws**. The EM ETF has a `Type` column the two small-cap funds lack. **Read every column
by header name, never by index**, and find the header row by looking for the cell reading `Ticker`
rather than trusting a row number.

**3. `ss:Index` sparse cells.**
*Symptom*: every column after some arbitrary point is shifted one to the left, silently. A `<Cell>`
may carry `ss:Index="7"`, meaning it jumps to column 7 — the columns before it are simply absent from
the XML. `ss:Index` on `<Row>` and `ss:MergeAcross` on `<Cell>` do the same. All three are handled in
the reader; a reader that pushes cells in document order is wrong and throws nothing.

**4. `parseFloat` on Indian digit grouping.**
*Symptom*: a company's market cap is 8. Not `NaN`, not an error — the number 8, which sorts, sums and
ranks perfectly happily. BSE returns money as strings like `"8,71,532.61"`, and `parseFloat` stops at
the first comma. **`parseFloat` is banned anywhere near a BSE figure**; assertion 5 greps for it.
Everything goes through `parseGroupedNumber` in `scripts/lib/bse.mjs`, which validates the whole
string before converting and normalises to rupees at that boundary so exactly one unit exists
downstream.

**5. BSE serves delisted scrips as though nothing happened.**
*Symptom*: a perfectly clean-looking float factor for a company that no longer exists. Scrip `500010`
answers happily with a 0.9900 factor for **Housing Development Finance Corporation**, which merged
into HDFC Bank in July 2023. Nothing in the response says so. The only thing standing between this
project and a three-year-stale number is the `status=Active` filter on the scrip master, and the fact
that the scrape universe is built from that master rather than from hand-entered codes. **Never
scrape a scrip code that did not come from the active master.** Assertion 16 checks every code in the
record is present and Active.

**6. A 200 is not a contract.**
*Symptom*: the price file is empty and every free-float figure goes null, on a day when nothing was
wrong. BSE serves its single-page-app shell — HTTP 200, `content-type: text/html`, ~14 KB — for
download URLs that do not exist. **Validate the shape, never the status.** `assertBhavcopyShape`
checks it parses as CSV, carries the expected columns, and that its own `TradDt` is the date
requested. Assertion 17 proves it against a committed capture of that exact HTML page.

**7. Munshot `not_found` is not a fact about the symbol.**
*Symptom*: "this company has no quote" — for RELIANCE. Under sustained load `fastapi.muns.io` answers
`status: "not_found"` for tickers it served correctly minutes earlier. It does not return 429 and it
does not say "rate limited". **Treat `not_found` exactly like a timeout: a failure for this run,
never a durable fact.** Anything that cached it would permanently blacklist real companies, and the
blacklist would look like data. `fetch-quote-stats.mjs` refuses to write below a coverage floor for
the same reason. Observed live during this project's final verification: RELIANCE, TCS and HDFCBANK
all `not_found` at 23:22 IST, all resolving again by 00:05.

**8. `--retry-all-errors` does nothing to a 403 without `--fail`.**
*Symptom*: the very first throttle becomes a permanent outage, and your retry flag appears to do
nothing. Without `--fail` / `--fail-with-body`, curl treats an HTTP 403 as a **successful** transfer
(exit 0) carrying an error page — so there is nothing for `--retry-all-errors` to retry.

**9. The 81-symbol batch cap.**
*Symptom*: HTTP 400 from the upstream on a request that is structurally identical to one that
worked. The upstream caps a batch at 81 symbols. `worker/index.js` chunks at **50**, deliberately
below the cap, and documents why at the top of the file.

**10. A guard may never read its threshold from the value under test.**
*Symptom*: your tripwire passes a file you deliberately corrupted. The unit check was written as "no
`…Inr` field below ₹1e5 for a company whose market cap is above ₹2,000 Cr" — both halves read the
same field. So when a crore value leaked into a rupee field, the market cap fell by the same
ten-million, dropped under the floor, and **the corrupted row exempted itself from the check that
existed to catch it**. Largeness is now judged from the BSE master's independently-fetched figure — a
different read of a different field. Sabotaged, it fails with `ratio 1.00e-7`. Assertion 21 proves
both halves: that the naive guard exempts its own victim, and that the real one catches it.
**Watch for the same shape elsewhere**: a staleness check reading the timestamp it validates, a
row-count check counting the rows it verifies, a coverage percentage whose denominator comes from the
same filtered set as its numerator.

**11. A formatter may round a real value to nothing.**
*Symptom*: a company appears not to be held, or a flow appears not to exist. A ₹1,023,939 flow is
₹0.1024 Cr, which at no-decimal precision prints **"₹0 Cr"**. A weight of 0.00045% at three decimals
prints **"0.000%"**, which reads as *not held* — the one thing this project is most careful never to
say by accident. It always strikes the smallest positions in the smallest companies, which are the
rows least likely to be checked; both cases measured here were the same company, Genus Prime Infra.
Every formatter that can meet a small number now carries a floor (`<₹0.01 Cr`, `<0.001%`, `<1`), and
a genuine zero still prints as zero because none is a fact. Assertion 14 runs every real weight and
every real flow in the record through its formatter.

**12. A `MutationObserver` whose callback writes to what it observes.**
*Symptom*: the process hangs with no output and no error, and you suspect the network. Assigning
`textContent` fires a `characterData` mutation **even when the value is unchanged**, and `prepend()`
is itself a `childList` mutation — so the callback re-triggers itself for ever. Two of the suite's own
sabotages did this. The fix is to `disconnect()` while writing and re-observe afterwards, which also
clears the pending record queue. Because a hang is an outage reported as nothing, the harness now
carries a per-check deadline and a runaway check fails on its own line.

**13. `pkill -f <pattern>` matches its own shell.**
*Symptom*: a compound command dies halfway through with exit code 143 or 144, and the part after the
`pkill` never runs — so you verify a stale copy and believe it. The pattern matches the `bash -c`
process whose command line contains it. Use a PID (`kill $PID`, `kill -0 $PID` to poll) or start
servers with `setsid` and track them explicitly. The same self-match breaks
`until pgrep -f "..."; do sleep; done` wait loops.

**14. Node's `fetch` cannot read NSE, and it is not a header problem.**
*Symptom*: 403 from Node while the identical request works in curl, so you spend an afternoon tuning
headers.

```
curl + a browser User-Agent, no cookies      → HTTP 200
curl with no User-Agent                      → connection refused
node fetch() with the SAME User-Agent        → HTTP 403
node fetch() with a full browser header set  → HTTP 403
```

Node's built-in `fetch` (undici) is TLS/HTTP2-fingerprinted and rejected by NSE's Akamai edge
regardless of headers. `scripts/scrape-nse-freefloat.mjs` **must** shell out to `curl` via
`node:child_process`. Do not "modernise" it. NSE also throttles intermittently from the same machine
with the same headers — retry.

---

## 5. Three application defects the suite found on its first run

None of these would have been caught by any check that existed before it.

**A superseded drill panel cleared its successor's URL.** `openDrill()` begins with `closeDrill()`,
which fires the outgoing panel's `onClose` — and that handler's job is to remove `?company=` from the
URL. On the cold-load path the drill opens twice in quick succession, so the panel sat open above an
address bar that no longer named it: copy the link, share a page with no drill on it. *Found by*
assertion 30, which reloads the document for real rather than changing the hash — a hash-only
navigation is same-document and proves nothing about a cold arrival. *Fixed by* `closeDrill({
superseded: true })`, which skips `onClose` when a panel is being replaced rather than closed.

**`fetchQuotes()` discarded `failed[]` on the not-ok path.** The Worker names every symbol it could
not resolve and why; the client kept only `"upstream"`. So during exactly the outage the per-symbol
detail exists to describe, `liveFailedSymbols()` was empty and the sources modal could name nothing.
*Found by* assertion 39's degraded-upstream branch, while the upstream happened to be degraded.
*Fixed by* carrying `failed` through the failure return.

**A real weight printed as "0.000%".** Covered as trap 11 above. *Found by* assertion 14 once it was
extended beyond rupees to percentages and counts.

---

## 6. The CI story — three failures, in the thing that runs the suite

This is the most persuasive argument in this document for why the discipline is worth keeping. The
workflow that runs the verification suite reproduced, in itself, three failures the suite exists to
prevent.

**A job reported SUCCESS while every meaningful step inside it was skipped.** `MUNS_TOKEN` is not
configured as a repository secret, so each step in the Worker job skipped on its `if:` guard — and
the job went green. **A green tick over work that did not happen** is precisely what the suite's
SKIP-is-not-a-pass rule exists to stop, and step-level guards cannot express "this job did not run".
*Fixed by* a one-step `secret` job that turns the secret's presence into an output, with `ui-worker`
guarding on it at **job** level, so the checks list reads **Skipped**.
*Teaches*: it is not enough for the tests to be honest; the thing that reports on the tests must be
honest too, and it is subject to exactly the same failure modes.

**Two unbounded jobs hung instead of failing.** `playwright install --with-deps chromium` sat for
over fourteen minutes with no output, twice, and no job had a `timeout-minutes`. An unbounded job
renders as "in progress" indefinitely rather than as broken. *Fixed by* bounding every job, and by
dropping `--with-deps` — it shells out to apt, and the runner image already carries what Chromium
needs.
*Teaches*: a hang is an outage reported as nothing. This is the same rule that put per-check
deadlines in the harness, arriving from a different direction.

**A probe failed for a reason unrelated to what it tested.** The replacement launch check ran
`require('playwright')` without `NODE_PATH`, so it could not resolve the global install and reported
a browser problem when it had only failed to resolve a module. *Fixed by* exporting `NODE_PATH` the
way the verify steps already do.
*Teaches*: a check that fails for the wrong reason is as misleading as one that passes for the wrong
reason — and this one **failed in sixteen seconds with a named error** instead of hanging, because
the previous fix was already in place.

---

## 7. Verification

**42 assertions.** 21 over the committed data with no browser and no network; 21 against the served
site in a real browser. Both exit non-zero on any failure. Every assertion is a trap that actually
happened — the full mapping from assertion to trap is the table in `docs/DATA-CONTRACTS.md`.

**SKIP is a first-class result and is always explained.** Against the static server the live block
skips, and that run is worth doing because it exercises the end-of-day floor — the state the site is
in most of the time. `--require-live` turns a skip in that block into a failure. Two checks also skip
when the Tailwind CDN is unreachable: layout and computed colour cannot be attributed to the layout
without a stylesheet, and a suite that guessed would be worse than one that abstains. Every run
prints how many skipped and why.

**`--prove` is the most valuable thing in this repository. Read it before adding a check.** It clones
the context, breaks precisely what each assertion exists to catch, and reports **CANNOT FAIL — as a
failure** — for any that survives. Its first runs failed **seven** of the suite's own checks, every
one of which had been showing a tick:

- a sabotage that no longer matched the pattern it was written for, after that pattern was tightened;
- a captured fixture that happened not to contain the trap it was chosen for;
- four one-shot DOM sabotages, wiped by the reload the check itself performs before a single
  assertion ran;
- an assertion on `documentElement.scrollWidth`, which the `overflow-x: hidden` backstop in
  `index.html` pins to the viewport — **it could never have failed at all.**

**A check that cannot fail is not a check.** Before adding one, break the thing it tests and confirm
it goes red. If you cannot make it fail, say so in the report rather than counting it. Every
assertion here carries a `sabotage()` for exactly this reason, and CI runs `--prove` on every push.

---

## 8. Deploying

```bash
npx wrangler deploy --dry-run     # validates the build; needs no credentials
npx wrangler secret put MUNS_TOKEN
npx wrangler deploy
```

`wrangler.jsonc` serves `./public` as static assets with an `ASSETS` binding, runs `worker/index.js`,
and sets `not_found_handling: single-page-application` so the hash router survives a deep link.
Observability is on.

**The dry run is the check that costs nothing.** On the current tree it reports:

```
✨ Read 39 files from the assets directory /home/user/Sattva-Global-Indices/public
Total Upload: 10.99 KiB / gzip: 3.84 KiB
Your Worker has access to the following bindings:
Binding            Resource
env.ASSETS         Assets
```

Note what is **not** in that list: secrets do not appear in a dry run, so a green dry run says nothing
about whether `MUNS_TOKEN` is set. `GET /api/health` is the check that does — it returns
`tokenConfigured`.

### Custom domain

Add a custom domain to the Worker in the Cloudflare dashboard (Workers & Pages → your Worker →
Settings → Domains & Routes → Add → Custom Domain), on a zone in the same account. Cloudflare creates
the DNS record and issues the certificate; no `route` entry in `wrangler.jsonc` is needed for this
path. The Worker then answers on that hostname for both the static assets and `/api/quotes`.

### If a future upstream on the same account ever needs proxying

**Use a service binding, or a custom domain. Never another `fetch()` from inside the Worker.**

A Worker calling another Worker on the same account by URL leaves Cloudflare's network and comes back
in. That costs a full round trip, bills a second request, and — the part that actually bites — can
loop back to the *same* Worker if the hostname resolves to it, which presents as a mysterious
recursion limit rather than as a routing mistake. A **service binding** is a direct
Worker-to-Worker call inside the runtime: no network hop, no extra request billed, and the
relationship is declared in `wrangler.jsonc` where it can be read:

```jsonc
"services": [
  { "binding": "UPSTREAM", "service": "some-other-worker" }
]
```

then `env.UPSTREAM.fetch(request)`. If the upstream is genuinely external — as `fastapi.muns.io` is —
then a plain `fetch()` is correct and is what `worker/index.js` already does.

### The two scheduled jobs

| Workflow | Cron (UTC) | IST | Does |
| --- | --- | --- | --- |
| `daily-refresh.yml` | `30 14 * * 1-5` | **20:00 IST, Mon–Fri** | fetch the BSE bhavcopy, rebuild `companies.json`, commit if anything changed |
| `monthly-float.yml` | `30 20 1 * *` | **02:00 IST on the 2nd** | scrip master, NSE universe, NSE + BSE free float, quote stats, prices, rebuild, commit |

The daily job runs comfortably after the 15:30 IST close and after BSE has published. The monthly
cron crosses midnight in conversion — 20:30 UTC on the 1st is 02:00 IST on the *second* — which the
comment in the file used to get wrong; the schedule is fine and the arithmetic is now stated there.

**Both fail loudly and commit nothing on failure.** Every guard is in the fetch scripts and in
`build-companies.mjs`, and each exits non-zero rather than writing: the response is not a bhavcopy;
its own `TradDt` is not the date requested; row-level continuity against yesterday's closes fails;
fewer than 95% of the universe priced; any measured count or weight drifts from `EXPECTED`. A
dashboard silently serving yesterday's prices under today's date is worse than one that visibly
failed, so **a red run here is the designed outcome**, not something to suppress.

---

## 9. If you change something

- **Work on `main`.** Never create a branch. This is rule 1 of `CLAUDE.md` and it is not a preference.
- **No build step, no bundler, no framework, no dependencies, no `package.json` anywhere.** Playwright
  and wrangler are global tools invoked through `npm -g` and `npx`; neither installs into this repo.
  CI asserts that no `package.json` or `node_modules` exists.
- **Never commit a credential.** `.dev.vars` is gitignored; production uses a Worker secret. CI greps
  every tracked file, and assertion 40 fetches the **served** site and greps that, because checking
  the repo is not the same question.
- **Run both suites and `--prove` before you push.** `CLAUDE.md` §2.20–2.22 are the rules most easily
  broken by a well-meaning change.
