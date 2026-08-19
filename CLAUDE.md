# Sattva Index Flows — working contract

A dashboard that tracks and forecasts what global index-tracking ETFs must buy and sell in Indian
equities.

Roughly 30–40% of foreign money in India is index-based, and about 60% of that follows MSCI. Those
funds are mandatory followers: when a company's index weight changes, they have no discretion — they
must trade. This tool forecasts those forced trades around the quarterly MSCI reviews
(February, May, August, November): inclusions, exclusions, and weight rebalances.

The audience is a portfolio manager who will act on a number they read here. That single fact
determines everything below.

---

## 1. Hard rules

These bind every prompt, every commit, every future session. They are not preferences.

1. **Work on `main` only. Never create a branch.** Commit and push to `main`.
2. **No build step, no bundler, no framework, no npm dependencies, and no `package.json` anywhere —
   including for scripts.** Vanilla ES modules served as static files. Node 22 scripts under
   `scripts/` for data refresh. When a script needs a capability, build the small version of it in
   `scripts/lib/` rather than adding a dependency. There is no `node_modules` in this repo, and
   `git status` must never show one.
3. **Everything must run by opening the static site:**
   ```bash
   python3 -m http.server 8080 -d public
   ```
   No compile, no watch process, no install step. If a change would break that command, it is the
   wrong change.
4. **Tailwind comes from the CDN. Light theme only.** No CSS build.
5. **Never commit credentials.** No username, password, token or API key in any file in this repo —
   not in a script, not in a comment, not in a fixture, not in a test. Local secrets live in
   `.dev.vars` (gitignored); deployed secrets are Cloudflare Worker secrets.

---

## 2. The honesty doctrine

This dashboard's whole value is that a portfolio manager can trust a number on it. A number that is
wrong is bad; a number that is wrong **and looks authoritative** is what gets someone fired. So the
rules below are about provenance and about what the screen is allowed to imply, not about accuracy
alone.

### 2.1 Three tiers of number, and they never look alike

Every figure that reaches a human belongs to exactly one tier, and the three must be visually and
verbally distinguishable at a glance.

**Tier 1 — Measured, reproduced.** Somebody else's published figure, carried through unchanged.
iShares weights, quantities, market values and prices. NSE free-float market cap. We do not re-band
it, re-round it, smooth it, or recompute it from its parts. **Name the source and the as-of date on
the surface where it appears** — "BlackRock, holdings as of 17 Aug 2026", "NSE pre-open,
19-Aug-2026 09:07:24". If we changed the number in any way, it is not tier 1.

**Tier 2 — Derived by us.** Today's free-float market cap from a stored share count and today's
price. An estimated rupee flow from a weight delta. A quarter-on-quarter weight change. These are
arithmetic we performed on tier-1 inputs. **Label them as derived and state the formula on the
surface where they appear**, not in a footnote three clicks away — `float shares × today's price`,
`Δweight × fund AUM`. A reader must be able to reconstruct the number from what is on screen.

**Tier 3 — Modelled judgement.** The probability that a company is included, excluded, or
re-weighted at the next review. This is an *opinion produced by rules we wrote*. It must never
render as a bare number that could be mistaken for a measurement — no lone "78%" in a cell.
Show **which rules fired**, **the thresholds they used**, and **whose assumption those thresholds
are**. A tier-3 figure without its reasoning visible is not shippable.

### 2.2 The inclusion/exclusion cut-offs are the desk's heuristic, not MSCI's rule

The desk works to roughly **>₹3,500–4,000 Cr for inclusion** and **<₹2,000–2,400 Cr for exclusion**.

MSCI does not publish these numbers. MSCI derives its size cut-offs globally at each review from the
investable universe, and the rupee figures above are a rule of thumb that has worked for this desk.
They are useful. They are not the rule.

Therefore:

- **Every threshold lives in one config module** — `public/js/config/thresholds.mjs` when the
  forecasting work lands. Not scattered as literals, not duplicated between a script and a screen.
- Each threshold carries a comment saying it is the desk's assumption and roughly where it came from.
- **Every screen that uses a threshold says so in words the reader will see** — "the desk's cut-off,
  not MSCI's published rule".
- **Never print a threshold as though MSCI published it.** No "MSCI's ₹3,500 Cr cut-off". Ever.

### 2.3 Missing is never zero

A company absent from a fund is **not held**. It is not a 0% weight. A company with no NSE
free-float reading has **no reading**. It is not ₹0 of float.

The difference matters because zero sorts, sums and ranks — and a fabricated zero will quietly place
a company at the bottom of a table it does not belong in at all.

So a missing value:

- renders as an **em dash (—)** with a title attribute saying *which* kind of missing it is
  ("not held by this fund", "no NSE free-float reading");
- is **excluded from every total, average and denominator**;
- **never sorts as zero** — missing rows sort to their own group, at the end, in either direction.

In JSON, missing is `null`. Never `0`, never `""`, never `"-"`.

### 2.4 A failure is not an absence

A blocked scrape, an HTTP 403, an expired session, a workbook that failed its checks — each is its
own named state, and it reaches the screen **in those words**.

Rendering a failed read as zero rows reports an outage as an event that did not happen. If the NSE
scrape is blocked and the dashboard says "0 companies have free float", we have not degraded
gracefully — we have lied. `scripts/scrape-nse-freefloat.mjs` therefore records every unreadable key
in `failed[]` with its reason, refuses to overwrite a good snapshot with a smaller one, and exits
non-zero when it collected nothing.

### 2.5 Always print the denominator

Free-float coverage is uneven, and the gap **is the story**.

Measured on the committed data (`node scripts/check-naive-join.mjs`): the 261-symbol NSE set covers
**96.0% of the EM ETF's India weight** but only **21.0%** of the India Small-Cap fund's and **20.8%**
of the EM Small-Cap fund's — and the small caps are exactly where inclusion forecasting matters. A
screen that says "36 companies" without saying "of 461" hides the entire limitation of the product.

So: **every count on screen reads "X of Y"**, never a bare X. And **no figure in any registry,
caption, heading or doc may be typed by hand** — derive it from the module that owns the data, so it
cannot go stale when the data moves. A hand-typed "261" is a bug waiting for the next refresh.

### 2.6 Never fabricate a number to fill a component

If a feed has not landed, render an honest "no data yet" panel naming what is missing and how to get
it. Drop the ranking; do not populate it with a plausible placeholder. Sample data, lorem-ipsum
figures and "representative" values are forbidden in anything that renders — a plausible fake is
strictly worse than a visible gap, because a gap gets fixed and a fake gets traded on.

### 2.7 Provenance must survive an export

A workbook leaves the page without any of its chrome. Row 1 of every exported sheet therefore
carries the same disclosure the screen does:

- **which fund** a weight belongs to;
- that free float is **NSE's published figure**, not computed from promoter holding;
- that a probability is **modelled by us**, with the thresholds used;
- the **as-of dates** for every source in the sheet.

---

## 3. Facts about the data that will cost you an hour if you rediscover them

### 3.1 The iShares `.xls` files are not `.xls` files

They are **SpreadsheetML 2003** — plain UTF-8 XML with CRLF line endings, opening with
`<?mso-application progid="Excel.Sheet"?>` under the namespace
`urn:schemas-microsoft-com:office:spreadsheet`. They are not binary BIFF and not CSV.

`scripts/lib/spreadsheetml.mjs` is the only place in the repo that knows the format. Do not add a
parsing library; do not open them as binary.

**The sparse-cell trap.** A `<Cell>` may carry `ss:Index="7"`, meaning it jumps to column 7 — the
columns before it are absent from the XML entirely. A reader that pushes cells in document order
shifts every later column one to the left and throws nothing. `ss:Index` on `<Row>` and
`ss:MergeAcross` on `<Cell>` do the same thing. All three are handled in the reader.

### 3.2 The three workbooks do not share a column set

The EM ETF has a **`Type`** column that the two small-cap funds do not:

| Fund | Columns |
| --- | --- |
| EM ETF | `Ticker, Name, Type, Sector, Asset Class, Market Value, Weight (%), Notional Value, Quantity, Price, Location, Exchange, Currency, FX Rate, Accrual Date` |
| India Small-Cap, EM Small-Cap | the same, **without `Type`** |

**Read every column by header name. Never by index.** A positional reader parses two of the three
files correctly and silently misreads the third: sector becomes asset class, weight becomes notional
value, and nothing throws.

Locate the header row by finding the row whose first cell is exactly `Ticker`. Do not hard-code
row 7 — the preamble height is not a guaranteed constant.

### 3.3 India is `Location === 'India'` **and** `Asset Class === 'Equity'`

The files also carry `Cash`, `Cash Collateral and Margins`, `FX`, `Futures` and `Money Market` rows.
Each fund's India slice contains exactly one non-equity row (an INR cash line).

### 3.4 The `Ticker` column is not reliably an NSE symbol

| Value in the file | What it actually is |
| --- | --- |
| `HDFCBANK`, `LAURUSLABS`, `M&M` | a true NSE symbol (the ampersand is legitimate) |
| `534091`, `532483` | a **BSE numeric scrip code**; these rows have `Exchange = 'Bse Ltd'` |
| `--` | **no ticker at all** — unlisted demerger entities not yet trading |
| `NAM.INDIA` | a dot where NSE uses a hyphen (`NAM-INDIA`) |
| `SHFL`, `TMCV`, `ENRIN`, `VAML` | BlackRock house codes (Shriram Finance, Tata Motors, Siemens Energy India, Vedanta Aluminium) |

**Store the ticker verbatim.** `tickerKind` records how it *reads* (`nse` / `bse-code` / `none`) —
it is not a resolution and nothing has been looked up. A row whose ticker cannot be resolved
**keeps its row, with the reason stated**. Never dropped, never silently renamed.

`ticker` is **not a unique key**: `--` appears three times in the India Small-Cap fund and twice in
the EM Small-Cap fund. Key on `(fundId, rowIndex)` if you need identity.

### 3.5 A weight belongs to one fund and one fund only

`HDFCBANK` is 0.683% of the EM ETF; `LAURUSLABS` is 1.830% of the India Small-Cap ETF. These are
percentages of different denominators. There is **no arithmetic that relates them**.

Nothing in this project may sum, average, rank or diff weights across funds. Every weight that
reaches a screen or an export names the fund it belongs to.

### 3.6 Fund AUM is computed over **all** rows, not the India slice

Flow in dollars is `Δweight × total fund AUM`. Computing AUM from India rows only understates EM ETF
flows by about **nine times** (the EM ETF is 11.3% India). `msci-funds.json` stores both
`totalMarketValueUsd` (every row) and `indiaMarketValueUsd` (the India equity slice); use the first
for flows.

### 3.7 NSE free float — the endpoint, and the trap

Free-float market cap must come **from NSE**. The Screener-style formula
`(100 − promoter%) × market cap` is **explicitly rejected and must not appear anywhere in this
codebase**: lock-in shares held by VCs and PE firms are not promoter holdings but are not free float
either, so the two disagree — and the global indices follow NSE.

The endpoint that works from a server:

```
https://www.nseindia.com/api/market-data-pre-open?key={NIFTY|FO|SME}
```

`metadata.marketCap` on that response **is free-float market cap, in rupees**. Coverage:
`NIFTY` 50, `FO` 208, `SME` 53 → **union 261 distinct symbols**. `OTHERS` (1,971 rows) and `ALL`
(2,179 rows) return `marketCap: "-"` for every row; `BANKNIFTY` is 403.

Blocked from a server, do not waste time: `/api/quote-equity?section=trade_info` (403 — this is the
one that would carry `ffmc` for the full ~700-name universe), `/api/equity-stockIndices` (403), and
the `nseindia.com` homepage itself (403). Cookie warming does not help; the pre-open endpoint
returns 200 with no cookie jar at all.

> ### ⚠ Node's `fetch` cannot read NSE. It is not a header problem.
>
> ```
> curl + a browser User-Agent, no cookies      → HTTP 200
> curl with no User-Agent                      → connection refused
> node fetch() with the SAME User-Agent        → HTTP 403
> node fetch() with a full browser header set  → HTTP 403
> ```
>
> Node's built-in `fetch` (undici) is TLS/HTTP2-fingerprinted and rejected by NSE's Akamai edge
> regardless of what headers you send. `curl` passes. **`scripts/scrape-nse-freefloat.mjs` must
> shell out to `curl` via `node:child_process`.** The failure presents as a headers problem and is
> not one — no amount of header tuning fixes it. Do not "modernise" that script to `fetch`.

**NSE also throttles intermittently and unpredictably**, from the same machine with the same
headers: a request that succeeded a minute ago can 403 and then succeed seconds later. Retry.

> ### ⚠ `--retry-all-errors` does nothing to a 403 without `--fail`
>
> Without `--fail` / `--fail-with-body`, curl treats an HTTP 403 as a **successful** transfer
> (exit 0) that happens to carry an error page — so `--retry-all-errors` sees nothing to retry and
> the very first throttle becomes a permanent "outage". The working invocation is:
>
> ```bash
> curl -s -S --fail-with-body \
>   -A 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' \
>   --retry 6 --retry-delay 20 --retry-all-errors --max-time 40 \
>   'https://www.nseindia.com/api/market-data-pre-open?key=FO'
> ```

**A blocked key is a failure, never an empty result.** It goes in `failed[]` with its reason, it
does not overwrite a good file with a smaller one, and a scrape that collected nothing exits
non-zero.

**The pre-open session runs 09:00–09:08 IST**, so `marketCap` is struck at the indicative
equilibrium price (IEP), not at the close. Carry NSE's own `timestamp` verbatim as `sessionTimestamp`
and **never restamp it** — when NSE measured it is a different fact from when we fetched it
(`capturedAt`).

**Free float is stored as a share count**, `impliedFreeFloatShares = freeFloatMcapInr / iep`, so a
daily price move can re-value it without a fresh scrape. The `implied` prefix is deliberate: it marks
the figure as ours (tier 2), so nothing downstream can mistake it for something NSE published.

---

## 4. Repository layout

```
CLAUDE.md                          this contract
docs/DATA-CONTRACTS.md             every JSON shape, unit, source and cadence
scripts/
  lib/spreadsheetml.mjs            SpreadsheetML 2003 reader, zero dependencies
  lib/report.mjs                   console tables, number formatting, check lists
  import-ishares.mjs               3 workbooks → public/data/msci-funds.json
  scrape-nse-freefloat.mjs         NSE pre-open → public/data/nse-freefloat.json
  check-naive-join.mjs             measures the ticker-resolution gap; writes nothing
  fixtures/ishares-{eem,smin,eems}.xls    the committed input workbooks
public/
  index.html                       placeholder; the interface is a later prompt
  data/msci-funds.json             generated — do not hand-edit
  data/nse-freefloat.json          generated — do not hand-edit
```

Both JSON files under `public/data/` are **generated artefacts that are committed**, so the static
site works with no build and no network. Never hand-edit them; change the script and re-run.

---

## 5. Running things

```bash
node scripts/import-ishares.mjs        # prints the per-fund table, exits 0
node scripts/scrape-nse-freefloat.mjs  # prints per-key counts, exits 0; needs network
node scripts/check-naive-join.mjs      # prints the resolver baseline; reads only

python3 -m http.server 8080 -d public  # the site
```

`import-ishares.mjs` **refuses to write** if any measured count or weight drifts from the `EXPECTED`
table in the script. That table describes *the workbooks committed in `scripts/fixtures/`*, not the
funds in general — a fresh download will legitimately move every number in it. When you replace the
fixtures, re-measure and update `EXPECTED` **in the same commit**. Never loosen the check to make a
run pass.

---

## 6. Ticker resolution is not built yet

The naive join (`iShares ticker === NSE symbol`, exact, no resolver) currently matches:

| Fund | By holding count | By India weight |
| --- | --- | --- |
| EM ETF | 152 of 165 | 96.0% |
| India Small-Cap | 36 of 461 | 21.0% |
| EM Small-Cap | 36 of 414 | 20.8% |

That is the **baseline a resolver must beat**, and it is on the record so any claimed improvement can
be checked. Re-run `node scripts/check-naive-join.mjs` for the current figures and the full
unmatched list — do not quote the table above without re-running it.

Note that most small-cap misses are not spelling problems at all: those companies are simply **not in
the 261-symbol NSE pre-open set**, so no resolver can find them a free-float reading from this
source. `MRF` is one such case — absent from the set entirely, not spelled differently. Keep the two
causes separate in any resolver work: *unmatched because of the symbol* and *unmatched because there
is no reading* are different problems with different fixes.
