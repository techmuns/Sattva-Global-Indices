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

Measured on the committed data (`node scripts/build-companies.mjs`, whose `coverage` block is the
only place these figures may come from):

| Fund | Holdings resolved | With a free-float reading | India weight covered |
| --- | --- | --- | --- |
| EM ETF | 165 of 165 | 165 of 165 | 100.0% |
| India Small-Cap | 454 of 461 | 453 of 461 | 97.6% |
| EM Small-Cap | 408 of 414 | 407 of 414 | 97.6% |

That is after adding BSE. On NSE alone it was 96.0% / 21.0% / 20.8%, and the small caps are exactly
where inclusion forecasting matters — so the gap that closed was the whole product. A screen that
says "453 companies" without saying "of 461" hides what is still missing.

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

### 2.8 Two sources for one number, and they disagree

NSE and BSE both publish free-float market cap, and they do not agree. For RELIANCE the implied
float factor is about **0.4978 from NSE** and **0.4926 from BSE** — roughly 1% apart. That gap is
real. It is not a price-timestamp artefact and it does not go away if you look harder: the two
exchanges apply slightly different definitions of what counts as float.

This is an ordinary two-source measurement problem and it gets the ordinary treatment:

1. **NSE wins wherever it exists.** The desk's requirement is explicit — MSCI follows NSE, and the
   Screener formula was rejected precisely because it disagreed with NSE. **BSE fills gaps only.**
2. **Never average, blend, or silently prefer.** Every company carries `floatSource: 'nse' | 'bse'`,
   and where both readings exist **both factors stay on the record** (`floatFactorNse`,
   `floatFactorBse`) so the disagreement is inspectable rather than resolved away.
3. **The source travels with the number** — to the screen, to the drill-down, and to row 1 of any
   export. A reader comparing two rows must be able to see that one is NSE-sourced and one is not.
4. **Nothing sums or ranks across the two without saying so.** A league table mixing NSE-sourced and
   BSE-sourced free floats is defensible. Presenting it as "NSE free float" is not.

### 2.9 Store the float factor, not a rupee figure

```
floatFactor = MktCapFF / MktCapFull        // dimensionless, price-independent
```

A rupee free-float figure is struck at one moment's price and is wrong by the next day's open. The
factor is not: it moves only when shareholding moves, which is the quarterly event this product
exists to forecast. So free float is always reconstructed, never stored as rupees:

```
freeFloatMcap(today) = floatFactor × sharesOutstanding × price(today)
```

That is the monthly-snapshot-plus-daily-recompute the desk asked for, and it only works because what
is persisted is price-independent.

**Both halves of a factor must come from one source at one instant.** `MktCapFF / MktCapFull` comes
from a single BSE response. NSE's factor is derived as
`nseFloatShares / totalShares`, where `nseFloatShares = nse.freeFloatMcapInr / nse.iep` (both NSE)
and `totalShares = bse.fullMcapInr / bse.priceInr` (both BSE). The two sources are combined **only in
the share-count domain**, where a share is a share whoever quoted it. **Never divide BSE's market cap
by NSE's price** — that folds a price difference into a float difference and makes the comparison
meaningless.

---

### 2.10 A live price swaps the exchange, it does not merely refresh the number

Munshot reports `Symbol=RELIANCE.NS, Exchange=NSI` — it is **Yahoo Finance NSE** data. The committed
EOD baseline is **BSE bhavcopy**. On 19 Aug 2026 BSE closed RELIANCE at 1307.50 while Munshot showed
1311.00.

So a live price does not just make a figure fresher; it **changes which exchange produced it**. The
rule is the same as for NSE-vs-BSE float: the source travels with the number, nothing blends them,
and every row says which exchange priced it. **A reader must never watch a free-float figure move
and be unable to tell whether the stock moved or the source did.**

Three price tiers, and a row always knows which it is on:

| Tier | Meaning |
| --- | --- |
| `live` | this session's NSE quote, in memory only |
| `eod` | the committed BSE close from bhavcopy |
| `stale` | a close carried forward because the stock did not trade, with a day count |

**A stock absent from today's bhavcopy has not traded.** That is neither zero nor "unchanged": its
last close is carried forward with `priceStaleDays`, and every figure computed from it is marked.

**Live prices are folded into memory only and are NEVER written back to a committed file.** The
committed file is the exchange's own bytes under the exchange's own date; a locally patched copy
would destroy the basis for trusting either.

**The factor and the share count are monthly; the price is live.** Separate files, separate as-of
dates, and the float file is never restamped because a price arrived. **The oldest input still
governs the freshness claim** — a live price does not make a month-old float factor live.

**Outside 09:15–15:30 IST there is no live price, only the last one.** The pill reads "Live · NSE"
only during market hours and "Last close · BSE" otherwise, and it claims live only when a byte
actually arrived. A chip that says "just now" whether or not anything was confirmed teaches readers
to ignore it.

### 2.11 A rising weight does not force a trade

**Read this twice; getting it backwards makes every flow figure wrong in the same direction.**

An index weight is `freeFloatMcap_i / Σ freeFloatMcap` across members, and an index fund holds each
member in proportion. When a stock's price rises, the value of the fund's holding rises by **exactly
the same proportion** as its index weight. The weight drifts upward and **the fund trades nothing**.

Trading is forced only when the index's own inputs change, at a review:

| Event | Who trades | Size |
| --- | --- | --- |
| Segment migration (Small Cap ⇄ Standard) | small-cap funds sell, EM funds buy | largest |
| Index entry | every fund tracking it buys | large |
| Index exit | every fund tracking it sells | large |
| Float-factor revision (lock-in expiry, promoter change) | funds adjust by the delta | moderate |
| Share-count revision (issuance, buyback, split) | funds adjust by the delta | moderate |

Therefore:

- **`passiveDrift.requiresTrade` is hard-coded `false`.** That is not a placeholder — no input to a
  passive-drift calculation could make it true.
- Drift is shown because it is how a company **closing on a size cut-off** becomes visible. It must
  **never be multiplied by AUM and printed in rupees**.
- Drift is measured **relative to the fund's own basket**, not in absolute terms: the other holdings
  moved too. **If every drift shares a sign, that is a bug** — almost always prices from two
  different dates — and `build-companies.mjs` asserts both signs are present.
- `flowPrimitives` are **inputs to a later calculation, not results**. `fundAumUsd` and `fxRate` are
  both as of the **holdings date**; pairing a live FX rate with a month-old AUM is precision on one
  input pretending to be precision on the answer.
- **No rupee flow figure exists anywhere in this codebase**, because no index event has been
  identified yet.

### 2.12 Nothing recomputes a factor from a price

```
freeFloatMcapInr(now) = floatFactor × sharesOutstanding × price(now)
```

If you find yourself dividing a rupee figure by a price to recover a factor you already hold, you
have added a rounding path for nothing. `build-companies.mjs` asserts the round trip for every
company.

---

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

### 3.8 BSE is the opposite of NSE in every respect

`api.bseindia.com` has **no bot protection**. A browser `user-agent` and `referer:
https://www.bseindia.com/` are the whole requirement — no cookie warming, no TLS fingerprint
problem, no throttling observed over thousands of requests. It is the only source that covers the
whole listed universe rather than 261 names.

| Endpoint | What it gives |
| --- | --- |
| `/api/ListofScripData/w?…&segment=Equity&status=Active` | the entire scrip master in one ~1.7 MB request |
| `/api/StockTrading/w?…&scripcode=N` | `MktCapFull` and `MktCapFF` — the float factor |
| `/api/getScripHeaderData/w?…&scripcode=N` | `CurrRate.LTP` — the price the market caps were struck at |
| `/api/ComHeader/w?…&scripcode=N` | `ISIN` (a genuine cross-check) and `IndustryNew` (sector) |

`Mktcap` in the scrip master is **full market cap in ₹ crore**, and it agrees exactly with
`MktCapFull` from the per-scrip endpoint. It is used **only** to choose which scrips are worth a
request; it is struck at an undisclosed moment and must never render as a company's market cap.

`INDUSTRY` in the master is `null` for every row. Sector comes from `ComHeader.IndustryNew`.

> ### ⚠ BSE serves delisted scrips as though nothing happened
>
> `StockTrading` and `ComHeader` answer happily for a **delisted** scrip code and return that
> company's frozen last figures, with nothing in the response saying so. Scrip `500010` returns
> `MktCapFull 5,05,430.17 / MktCapFF 5,00,375.87` — a clean-looking 0.9900 factor for **Housing
> Development Finance Corporation Ltd**, which merged into HDFC Bank on 13 July 2023 and has
> `Status: "Delisted"` in the master. HDFC Bank is **500180**, and its factor is 0.9911 against a
> full market cap more than twice as large.
>
> The only thing standing between this project and a three-year-stale number is the
> `status=Active` filter on the scrip master, and the fact that the scrape universe is built from
> that master rather than from hand-entered codes. **Never scrape a scrip code that did not come
> from the active master**, and be suspicious of any hand-checked figure that did.

> ### ⚠ A 200 is not a contract
>
> BSE serves its single-page-app shell — HTTP 200, `content-type: text/html`, ~14 KB — for download
> URLs that do not exist:
>
> ```
> …/download/BhavCopy/Equity/EQ_ISINCODE_180826.zip  →  200, 13,850 bytes, text/html
> ```
>
> A fetcher that trusts the status code writes an empty price file, and every free-float figure on
> the dashboard goes null on a day when nothing was wrong. So **validate the SHAPE, never the
> status**: it must parse as CSV, carry the columns expected, and its own `TradDt` must be the date
> requested. `assertBhavcopyShape` in `scripts/lib/bhavcopy.mjs` does all three and is proven by
> pointing the fetcher at that URL.
>
> Same family as the delisted-scrip trap: the response is well-formed and about something else.

> ### ⚠ A file-level date check cannot see a stale row
>
> A file whose `TradDt` is today can still carry a row copied from yesterday. The row-level tripwire
> is **continuity**: today's `PrvsClsgPric` must equal yesterday's `ClsPric`, per scrip. Measured
> 18→19 Aug 2026: **4,562 compared, 0 failures** — a sharp tripwire, not a noisy one.
>
> Note the true-negative shape: 53 scrips carried byte-identical open/high/low/close across both days.
> Those are bonds and illiquid lines that genuinely did not trade, and they **pass** continuity. An
> unchanged close is not a stale row.

> ### ⚠ `not_found` from Munshot is not a fact about the symbol
>
> Measured the hard way. Under sustained load `fastapi.muns.io` begins answering
> `status: "not_found"` for tickers it served correctly minutes earlier — RELIANCE included. It does
> not return 429 and it does not say "rate limited"; it says the symbol does not exist.
>
> So **`not_found` is treated exactly like a timeout**: a failure for this run, never a durable fact.
> Anything that cached it as "this company has no quote" would permanently blacklist real companies,
> and the blacklist would look like data. `scripts/fetch-quote-stats.mjs` refuses to write below a
> coverage floor for the same reason: a half-populated statistics file is worse than none, because
> the missing half renders as an em dash that reads as a property of the company.

> ### ⚠ A guard may never read its threshold from the value under test
>
> This is general, and it is the rule that the unit tripwire in `build-companies.mjs` broke on its
> first attempt.
>
> That check was written as "no `…Inr` field below ₹1e5 **for a company whose full market cap is
> above ₹2,000 Cr**". Both halves read the same field. So when a crore value leaks into a rupee
> field, the market cap it is checked against falls by the same ten-million, drops under the
> ₹2,000 Cr floor, and **the corrupted row exempts itself from the check that exists to catch it**.
> The guard passed a deliberately sabotaged file.
>
> A guard needs a **threshold from a source the failure cannot move**. Largeness is now judged from
> the BSE master's independently-fetched `Mktcap` — a different read of a different field — and the
> load-bearing assertion compares the per-scrip market cap against it: the two are struck at
> different moments and will never be equal, but they cannot be a million times apart unless a unit
> was lost. Sabotaged, that one fails with `ratio 1.00e-7`.
>
> The same shape appears elsewhere, so watch for it: a staleness check that reads the timestamp it
> is validating, a row-count check that counts the rows it is verifying, a coverage percentage whose
> denominator comes from the same filtered set as its numerator. **Every guard in this repo must be
> proven by deliberately breaking the thing it guards** — if it still passes, it is decoration.

Concurrency stays at **4** with a gap between requests. BSE tolerates far more. It is somebody
else's free service and this job runs monthly — there is no reason to lean on it.

> ### ⚠ `parseFloat` will silently destroy a BSE number
>
> BSE returns money as **strings with Indian digit grouping, in ₹ crore** — `"17,69,379.44"`.
> NSE returns a **raw number, in rupees** — `8894519619599.8`.
>
> ```js
> parseFloat("8,71,532.61")   // => 8      <-- not an error. Not NaN. Just 8.
> ```
>
> It stops at the first comma and returns a plausible small number that will sort, sum and rank
> perfectly happily. **`parseFloat` is banned anywhere near a BSE figure.** Everything goes through
> `parseGroupedNumber` in `scripts/lib/bse.mjs`, which validates the entire string before
> converting, and every value is normalised to **rupees at that boundary** so exactly one unit
> exists downstream. A crore value in a rupee field is a ten-million-fold error that looks like a
> formatting bug.

### 3.9 Identity is ISIN, never a ticker

A ticker is a label: two exchanges spell it differently, a fund vendor invents its own codes, and
codes get reused when companies delist. **ISIN is the key everything is carried on.**

The resolver (`scripts/lib/resolve.mjs`) attempts, in descending order of what each proves:
`scrip_id` → numeric `scrip_code` → `isin` (via the niftyindices NSE universe) → normalised `name`.
It records which one fired and prints the histogram every run.

**BSE's `scrip_id` is not the NSE symbol, however often it looks like one.** Anchored on ISIN it
agrees for 747 of the 747 companies present in both sets and differs for none — a good record, and
still not a licence, because "always so far, across the 750 largest names" is exactly the assumption
that produces one wrong row in the long tail. The NSE symbol is only ever asserted from
`nse-universe.json`, keyed on ISIN. Where that file has no entry, `nseSymbol` is `null`.

**The name step is exact-normalised and unique-or-nothing.** A fuzzy matcher looks better on a
coverage table and is how you ship a wrong row:

- `EMBASSY` is Embassy Office Parks REIT, which is not in BSE's equity segment at all. A prefix
  matcher pairs it with **Embassy Developments Ltd** (EMBDL/532832) — a different company whose
  free float would then be reported as the REIT's.
- BSE's master contains **16 pairs** of scrips with identical normalised names: an ordinary line and
  its partly-paid twin (`GSAUTO`/`GSAILPP`, `APLAB`/`APLABPP`, …). Picking either is a coin flip.

**Demerged entities must never map to their parents.** `TMCV` is named `TATA MOTORS LTD` in the
workbook but is the demerged commercial-vehicles company with its own ISIN (`INE1TAE01010`), not the
parent. Likewise `VAML` (Vedanta Aluminium, `INE1CDF01017`) and `ENRIN` (Siemens Energy India,
`INE1NPP01017`). All three are real **BSE scrip ids**, so the `scrip_id` step resolves them
correctly before any name matcher sees them. They are additionally pinned in the `CONFIRMED` table
in `resolve.mjs`, which is **asserted against the master every run** rather than trusted — if BSE
stops agreeing, the build fails.

`NOT_LISTED` in the same module pins the holdings that must stay unresolved (the four REITs and the
`--` demergers), so a later, more permissive matcher cannot "improve coverage" by attaching one of
them to a same-named listed company.

**A collision stops the build.** Two rows *of the same fund* resolving to one ISIN means one of them
is the wrong company, and the wrongness is invisible downstream because both rows look well-formed.
The same ISIN across *different* funds is normal — the two small-cap funds hold hundreds of the same
companies.

---

---

## 4. Repository layout

```
CLAUDE.md                          this contract
docs/DATA-CONTRACTS.md             every JSON shape, unit, source and cadence
scripts/
  lib/spreadsheetml.mjs            SpreadsheetML 2003 reader, zero dependencies
  lib/report.mjs                   console tables, number formatting, check lists
  lib/bse.mjs                      BSE client + the ₹-crore string parser
  lib/resolve.mjs                  ticker → ISIN → NSE symbol + BSE scrip code
  lib/bhavcopy.mjs                 EOD CSV parse + shape and continuity tripwires
  lib/munshot.mjs                  Munshot batch client + rawQuote parser, pure
  lib/recompute.mjs                free-float recompute, passive drift, flow primitives
  import-ishares.mjs               3 workbooks → public/data/msci-funds.json
  scrape-nse-freefloat.mjs         NSE pre-open → public/data/nse-freefloat.json
  fetch-bse-master.mjs             BSE scrip master → public/data/bse-scrip-master.json
  fetch-nse-universe.mjs           niftyindices CSVs → public/data/nse-universe.json
  scrape-bse-freefloat.mjs         per-scrip BSE float → public/data/bse-freefloat.json
  fetch-bhavcopy.mjs               BSE EOD prices → public/data/prices.json
  fetch-quote-stats.mjs            monthly ADV / splits → public/data/quote-stats.json
  build-companies.mjs              everything → public/data/companies.json
  check-naive-join.mjs             the pre-resolver baseline; writes nothing
  probe-liveness.mjs               is the quote feed live? reports, writes nothing
  probe-chunk-size.mjs             largest safe upstream batch; reports only
  fixtures/ishares-{eem,smin,eems}.xls    the committed input workbooks
public/
  index.html                       placeholder; the interface is a later prompt
  js/config/thresholds.mjs         EVERY threshold, and nowhere else
  data/msci-funds.json             generated — do not hand-edit
  data/nse-freefloat.json          generated — do not hand-edit
  data/bse-scrip-master.json       generated — do not hand-edit
  data/nse-universe.json           generated — do not hand-edit
  data/bse-freefloat.json          generated — do not hand-edit
  data/prices.json                 generated — the committed EOD price floor
  data/quote-stats.json            generated — monthly ADV, splits
  data/companies.json              generated — the record the interface reads
  js/core/live.js                  visibility-aware poller
  js/data/quotes.js                live overlay; memory only, never written back
worker/
  index.js                         static assets + POST /api/quotes
  http.mjs                         ETag / 304 / CORS / cache-state helpers
wrangler.jsonc                     Worker config; npx-only, no node_modules here
.github/workflows/
  daily-refresh.yml                weekdays 20:00 IST — bhavcopy → rebuild → commit
  monthly-float.yml                1st of month — float + universe + stats → commit
```

Every JSON file under `public/data/` is a **generated artefact that is committed**, so the static
site works with no build and no network. Never hand-edit them; change the script and re-run.

`companies.json` is the join of all the others and the only one the interface should read.

---

## 5. Running things

Refresh order — later scripts read what earlier ones write:

```bash
node scripts/import-ishares.mjs        # workbooks; no network
node scripts/fetch-bse-master.mjs      # 1 request, ~1.7 MB
node scripts/fetch-nse-universe.mjs    # 2 requests, the ISIN bridge
node scripts/scrape-nse-freefloat.mjs  # 3 requests, 261 symbols
node scripts/scrape-bse-freefloat.mjs  # ~3,600 requests, ~25 min — the long one
node scripts/fetch-bhavcopy.mjs        # 1 request, the whole market's closes
node scripts/fetch-quote-stats.mjs     # monthly ADV/splits; --concurrency 1 --gap-ms 1200
node scripts/build-companies.mjs       # no network; joins everything

node scripts/check-naive-join.mjs      # the pre-resolver baseline; reads only

python3 -m http.server 8080 -d public  # the site, EOD only — no live prices
npx wrangler dev                       # the site WITH /api/quotes and live prices
```

**The static site is the floor and must always work.** With `python3 -m http.server` there is no
`/api/quotes`, the poller records `no-worker`, every row stays on its committed EOD price and the
header says "Last close". That is the designed state, not a degradation — verify it after any change
to the live path.

`npx wrangler` installs into the npx cache, not into this repo. There is still **no `package.json`
and no `node_modules` here**, and `git status` must keep proving it.

The upstream token lives in `.dev.vars` locally (gitignored) and as a Worker secret in production
(`npx wrangler secret put MUNS_TOKEN`). **It must never appear in `public/`** — grep the served site
after any change to the Worker.

`scrape-bse-freefloat.mjs --limit N` fetches only the largest N scrips and **writes nothing** — use
it to check the endpoint is healthy before spending twenty-five minutes on the full run.

Every writer refuses to replace a good snapshot with a smaller one; pass `--allow-shrink` only when
the universe genuinely shrank and you mean it.

`import-ishares.mjs` **refuses to write** if any measured count or weight drifts from the `EXPECTED`
table in the script. That table describes *the workbooks committed in `scripts/fixtures/`*, not the
funds in general — a fresh download will legitimately move every number in it. When you replace the
fixtures, re-measure and update `EXPECTED` **in the same commit**. Never loosen the check to make a
run pass.

---

## 6. Ticker resolution

Built, in `scripts/lib/resolve.mjs`. It is pure and deterministic given its three reference sets, so
it can be re-run and reasoned about without touching an endpoint.

**Resolution of holding rows** (`node scripts/build-companies.mjs` prints this every run):

| Fund | Resolved | Unresolved |
| --- | --- | --- |
| EM ETF | 165 of 165 | 0 |
| India Small-Cap | 454 of 461 | 7 |
| EM Small-Cap | 408 of 414 | 6 |

Method histogram across all 1,040 holding rows: `scrip_id` 996, `scrip_code` 16, `isin` 7, `name` 5,
`confirmed` 3, unresolved 13. **Zero collisions.**

The 13 unresolved rows are not spelling problems and no resolver will fix them:

- **four REITs** — Embassy Office Parks, Brookfield India, Nexus Select, Mindspace. Not in BSE's
  equity segment and not in NSE's free-float set. A different instrument class, not a missing name.
- **the `--` rows** — GSPL Transmission, Triveni Power Transmission, Inox Renewable Solutions.
  Demerged entities that have not started trading. NSE carries two of them only as placeholders
  (`DUMMYTRVN`, `DUMMYINXGN`, ISINs beginning `DUM`), which are not traded securities.

Every one keeps its row, keeps its weight in every denominator, and carries a stated reason in
`companies.json → unresolved[]`. **Dropping them would quietly redefine the universe as "the ones we
could match"** — the same error class as rendering a missing value as zero.

### The pre-resolver baseline, kept on the record

`node scripts/check-naive-join.mjs` still measures the naive `iShares ticker === NSE symbol` join
against the NSE free-float set alone, with no resolver and no BSE: **152 of 165, 36 of 461, 36 of
414**, covering 96.0% / 21.0% / 20.8% of each fund's India weight. That script writes nothing and
exists so any claimed improvement can be checked against the unimproved figure.

The lesson it recorded is worth keeping: the small-cap gap was **never a ticker problem**. Case and
punctuation normalisation alone recovered one ticker per small-cap fund. The gap was the source —
NSE's pre-open API covers 261 names — and it closed by adding BSE, not by matching harder.
