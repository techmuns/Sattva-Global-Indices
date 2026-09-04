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

Rounding can manufacture a zero by a different route, and that has its own rule — **§2.20**.

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
| EM ETF | 165 of 165 | 165 of 165 | 11.3% of 11.3% |
| India Small-Cap | 458 of 461 | 457 of 461 | 99.6% of 99.7% |
| EM Small-Cap | 412 of 414 | 411 of 414 | 21.2% of 21.3% |

That is after adding BSE. **Measured on NSE alone on 20 Aug 2026: 208 of 1,249 companies, and by
India weight 97.4% / 22.4% / 22.2%** — the large caps are fine and the small caps, exactly where
inclusion forecasting matters, are three-quarters blind. That gap is the whole reason BSE is the
primary source. A screen that says "453 companies" without saying "of 461" hides what is missing.

And the source split, from the same `coverage` block:

| Where the figure came from | Companies |
| --- | --- |
| BSE, the only exchange publishing for that company | 1,020 |
| BSE, both publish and they agree within 2% | 183 |
| NSE, both publish and they differ by more than 2% | 23 |
| NSE, BSE has no reading at all | 3 |
| No reading from either exchange | 21 |

The 21 are not a failure to try, and **every one carries its reason on its record**:

- **19 are not on BSE at all** — checked by ISIN against every one of BSE's 12,685 active scrips.
  They are NSE-only listings, and NSE publishes free float for about 250 symbols, none of them
  these. No exchange publishes a figure. Six are NSE-listed InvITs; the rest are mostly Emerge names.
- **2 are Suspended on BSE** — Colab Platforms (542866) and RRP Semiconductor (504346). BSE still
  answers for both with a clean-looking factor and `Category: "Listed"`; only the active master says
  otherwise, and it is believed. See §3.8.

This was **43** until 20 Aug 2026. The 22 that closed were REITs and InvITs, and they were never a
data problem — see §3.8 on `segment=Equity`.

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

The median gap across the 206 companies carrying both readings is **0.071%**, and 59% of them agree
to within 0.1%. But the tail is real: **32 differ by more than 1%, 14 by more than 5%**, and the
worst is 35.8% (Premier Energies — NSE counts 118.5M free-float shares, BSE counts 170.2M, on a
total share count both exchanges agree about and prices 1.1% apart).

**Why the disagreement exists is not established.** The obvious explanation — lock-in shares from
recent IPOs, released on different schedules — was tested against NSE's listing dates and does not
hold: the median gap is flat across every listing-age cohort, and the worst offenders include
Torrent Pharmaceuticals (listed 23.7 years) and Adani Enterprises (29.2 years). Treat the cause as
unknown; the gap itself is measured and reproducible.

#### The rule, which is the desk's

**BSE is primary. NSE wins where the two materially disagree. NSE is the source where BSE has
nothing.**

1. **BSE is the primary source**, because it is the only one that can carry the screen at all. BSE
   serves a free-float factor for **1,198 of 1,198** active scrips above ₹2,000 Cr; NSE publishes
   free float for about **250 symbols** in total and its `ALL` key returns `marketCap: "-"` for
   every one of 2,093 rows. Measured, both, on 20 Aug 2026.
2. **Where NSE also publishes and the two differ by more than
   `FLOAT_SOURCE_PREFER_NSE_GAP_PCT` (2%), NSE's factor is used**, because the desk's
   understanding is that MSCI follows NSE. Below that, the difference is definitional noise and
   switching source for it would churn the record without changing a decision.
3. **Where BSE has no reading, NSE is the source.** BSE Ltd, CDSL and TSF Investments are NSE-only
   listings and are not in BSE's equity master at all — no amount of scraping will ever change that.
4. **The 2% switch point is nobody's published methodology.** Not NSE's, not BSE's, not MSCI's. It
   is the desk's rule and every surface that acts on it says so.

The gap is measured on the **dimensionless factor**, never on a rupee figure — two rupee free floats
from two exchanges differ by the price difference as well as the float difference, so a 2% test on
them would fire on price noise.

#### And the parts that did not change

5. **Never average, blend, or silently prefer.** Every company carries `floatSource: 'nse' | 'bse'`,
   and where both readings exist **both factors stay on the record** (`floatFactorNse`,
   `floatFactorBse`) so the disagreement is inspectable rather than resolved away.
6. **The rule that chose travels with the number.** `floatChoice` records which rule fired
   (`bse-primary`, `nse-preferred-on-material-gap`, `bse-only`, `nse-only`), the measured gap, the
   threshold used and a sentence of why. A source chosen by a rule the reader cannot see is a
   tier-3 judgement wearing a tier-1 face.
7. **The source travels with the number** — to the screen, to the drill-down, and to row 1 of any
   export. A reader comparing two rows must be able to see that one is NSE-sourced and one is not.
8. **Nothing sums or ranks across the two without saying so.** A league table mixing NSE-sourced and
   BSE-sourced free floats is defensible. Presenting it as "NSE free float" is not.

> **This rule was inverted once already.** Until 20 Aug 2026 it read "NSE wins wherever it exists,
> BSE fills gaps only". If you are reading old code, old docs or an old commit message that says
> that, it is describing the previous rule, not a bug.

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

### 2.12.1 A trend is not independent evidence about a rank

**Read this alongside 2.11; the two failures are the same shape at different window lengths.**

A migration verdict turns on a **rank by free-float market cap**, and free float is
`floatFactor × sharesOutstanding × price`. Today's rank therefore *already contains* every past price
move — that is how the company reached it. Measuring the same price channel over a longer window and
setting the answer beside the verdict as corroboration counts one piece of evidence twice, and the
near-total agreement that results looks like confirmation when it is arithmetic.

So relative performance **never moves a verdict**, and `verify-data` check 37 sweeps it from −200 to
+200 pp asserting the verdict multiset does not move at any point.

There is exactly one role that does not double-count, and it is the one the desk actually wants.
Today's rank is a **point forecast** of the rank in MSCI's *next* price window, which has not
happened. A trend that holds whichever day MSCI prices on is evidence about which way that forecast
moves. `trendSignal()` marks a company sitting within `nearBoundaryPct` of the observed cutoff whose
robust trend points **across** a boundary its rank has not crossed — beside the verdict pill, never
inside it, so the label continues to describe what it claims to describe.

### 2.12.2 MSCI does not say which of the ten days it priced on, and the answer moves

The price cut-off is *one of the last 10 business days of the month before the review month*. MSCI
does not publish which. That is not a footnote: the same quarter has **100** `(from-day, to-day)`
pairs it could have meant, and they do not agree. Measured across all 1,177 companies with a reading:

| | |
| --- | --- |
| envelope width | p10 **8.30** · median **14.73** · p75 **21.03** · p90 **29.16** · max **133.15** pp |
| entirely one side of zero | **807 of 1,177** (68.6%) |

For **31.4% of companies the sign of the answer depends on the day you pick.** Therefore:

- the point estimate is the **mean of all ten days** at each end — no single day is privileged;
- the full span is carried as a first-class field beside it, never as a footnote;
- **a direction is claimed only where the whole span clears the band**, and the screen's colour
  follows *robustness*, not sign — an unstable reading renders neutral however large it looks;
- **no threshold may be set below the median span.** A band of 5 or 10 pp — both were proposed — is
  inside the noise of its own input, and a threshold smaller than its measurement's uncertainty
  produces state changes that are noise wearing a threshold's face.

The consequence is a gate that admits few rows: 198 of 1,177 readings are robust, 2 of 37 migration
rows. **That is a finding about how noisy a ten-undisclosed-day window is, not a calibration failure
to be tuned away.** Report the fire rate; never loosen the band to make a column look populated.

### 2.12.3 The desk's baseline is the rebalance DATE, not the window MSCI priced on

Two dates belong to every review and confusing them is the easiest mistake in this codebase, because
**both are real dates in our own files and either produces a plausible number on every row**:

| | May 2026 review |
| --- | --- |
| **Price window** — the ten days MSCI struck its market caps in (§2.12.2) | 17–30 April 2026 |
| **Effective date** — the day the new composition took effect and every tracking fund traded | **29 May 2026** |

Six weeks apart. The desk's question — *how has this stock done against the index since the last
rebalance* — is baselined on the **second**. `relativePerformance` measures the first pair of windows;
`sinceRebalance` measures from the effective date to the latest committed close, and
`closedReviews()` in `calendar.js` derives the dates so neither is ever typed.

**Both ship, and neither substitutes for the other.** Measured on the committed record they disagree
about the **sign for 326 of 1,174 companies (27.8%)**, 129 of them with both readings above 5%. So
every surface names its own window, nothing sums or compares across them, and `verify-data` check 42
asserts no baseline is ever a price-window date.

**There is no ten-day mean at the rebalance end**, and the reason the mean exists upstream is exactly
why it must not be copied here: it exists because MSCI does not publish *which* of its ten days it
used. The rebalance date is published. Averaging it with its neighbours would baseline the reading on
a window nobody asked for.

What replaces the day-choice envelope is a **sensitivity test** — would the sign survive if the
baseline were struck a session or two either side? Measured: p10 **1.56**, median **3.64**, p75
**5.66**, p90 **9.56**, max **49.29** pp, and **1,084 of 1,193** spans sit entirely one side of zero
(90.9%, against 68.6% for the window reading). `REBALANCE_BASELINE.bandPct` is **4 pp** — the first
whole number at or above that measured median, on the same principle as §2.12.2's band, and set from
the measurement rather than picked. **849 of 1,193 readings are robust.**

The test varies the **baseline end only**. The latest close is the newest fact, not a choice anybody
makes, and a reader watches it move daily; the baseline is the fixed, invisible choice.

⚠ **The corporate-action interval is half-open here and it is NOT the window function's interval.**
Both ends are single days whose closes are already struck, so `baselineDate < exDate <= latestDate`:
an action ex *on* the baseline is already in that close, one ex *on* the latest date must be applied.
Copying `adjustmentFor`'s bounds across is a silent 2× error on a bonus.

**The default baseline follows the calendar on its own.** `REBALANCE_BASELINE.defaultReview` is
`null`, and `chooseBaseline()` in `calendar.js` picks the newest captured rebalance at build time,
resolved against the newest session the exchange served and never against the clock. There is no date
to edit when a review takes effect: the first build with a later session moves it. The reader may
still override it from the screener; the alternates live in `public/data/relative-baselines.json` and
are fetched only when someone actually re-bases.

> ### ⚠ "The date has passed" is the wrong test. "There is a session after it" is the right one
>
> A rebalance whose date IS the newest committed close gives a window of **zero length**, and every
> company then reads **+0.0%** against its index on three columns at once. That is not a return of
> zero — it is the absence of any elapsed time — and a reader takes it as *nothing has moved since
> the rebalance* when it means *nothing has happened yet*. Same lie as a fabricated zero (§2.3),
> arriving by arithmetic on two identical dates rather than by a null.
>
> So the default walks back to the newest baseline with a session **strictly** after it, judged on
> the date it RESOLVED to — a baseline walked back to the session before a market holiday does have a
> session after it. The reviews stepped over come back in `sinceRebalance.awaitingSession`.
>
> The August 2026 review is the live case: it takes effect on **31 Aug 2026**, and the first session
> that can measure anything from it is **1 Sep**. verify-data 43 proves the walk-back on those exact
> dates rather than only against whatever the committed record happens to contain.

**A rebalance that has happened is never silent, even when it cannot be measured.** Between a review's
effective date and the next successful refresh, the screen would otherwise show the *previous*
rebalance's baseline with nothing to say that the funds have already traded. The strip carries an
amber chip — *"August 2026 rebalanced 31 Aug 2026 · not measurable yet"* — naming the review, its
assumed effective date (§2.18), what is being measured instead, and why.

> **This is the one place the clock is read**, and only to produce that sentence. Every *figure* is
> still resolved against the newest session on the record, because a build must not depend on when it
> ran — but whether a rebalance has happened *since* that session cannot be answered from the record,
> which is exactly the thing that is behind. verify-ui 53 asserts the chip appears when the calendar
> says it should and is absent when it should not, so it cannot rot into a hard-coded warning.

### 2.12.4 "Flow pressure" is a direction, and §2.11 is why it is not a flow

The desk asked for out/under-performance to be reflected in the verdict. It is reflected **beside**
it, never inside it: `flowPressure()` labels each reading `positive`, `negative` or `neutral` and
carries the rule, the input, the band and whose band it is. **No verdict key moves** — `verify-data`
check 37 sweeps *both* readings across ±200 pp asserting the verdict multiset is unchanged, and
`verify-ui` check 45 switches the baseline through the interface and asserts all three columns move
and not one verdict does.

**It is not money moving.** §2.11 is absolute: a rising weight forces no trade, because the fund's
holding and the index weight rise by the same proportion. The signal says only that at the *next*
review, when MSCI re-ranks, the forced trade would point one way rather than the other. It therefore
carries a direction and **never a rupee figure**.

**The chip beside the verdict fires on `notable` rows, not on robust ones.** 849 of 1,193 readings
are robust — two rows in three — and a marker on two rows in three is a marker readers stop seeing.
A row earns a chip only where the reading says something the verdict does not: it contradicts a
migration, inclusion or exclusion verdict, or the row is `stable` and within `nearBoundaryPct` of the
rank cutoff. Every other row still shows the number, one column away.

### 2.13 A verdict is a label on a rule, and there is no probability

The requirement asks for a probability of inclusion or exclusion. **We do not print one, and the
reason is not squeamishness.** A probability needs a base rate; a base rate needs history — past
reviews, MSCI's actual cut-off at each, and which companies at which distances were added or
dropped. This repo holds one holdings file per fund. "68% likely" would be invented precision and
the one figure on the dashboard a reader could not check.

So every assessment is a **banded, rule-derived verdict with its working attached**. Each carries
`rulesFired: [{ key, label, input, threshold, thresholdSource, result }]`, and
`verdictFromRules()` replays that record to recover the verdict. **`build-companies.mjs` asserts the
replay matches for every company** — a drill panel showing a derivation that did not produce the
answer beside it is worse than a wrong answer, because it looks checkable and is not.

The upgrade path to a genuine probability is in `docs/DATA-CONTRACTS.md`. It needs dated historical
iShares holdings files, which BlackRock publish.

### 2.14 Two thresholds, and they answer different questions

**Do not reconcile them. Where they disagree, the disagreement is information.**

| | Source | Answers | Measured |
| --- | --- | --- | --- |
| Desk bands | `config/thresholds.mjs` | index **entry and exit** — is a company in MSCI India IMI at all? | ₹3,500–4,000 Cr inclusion, ₹2,000–2,400 Cr exclusion |
| Observed boundary | current constituents | **which segment** — Standard or Small Cap? | Standard floor ₹18,521 Cr, Small Cap ceiling ₹70,169 Cr |

They are an order of magnitude apart because they are different boundaries, not competing estimates.
Measured: **0%** of Standard constituents, **20%** of Small Cap constituents and **85%** of unheld
companies fall below ₹3,500 Cr — the desk band sits exactly at the unheld/Small-Cap line.

Every verdict names the threshold that produced it and where that threshold came from.

> ### ⚠ SINCE SEPTEMBER 2026 NEITHER OF THESE DECIDES A VERDICT — see §2.33
>
> The August review scored the desk-band model at 13.9% precision, and the verdict now follows MSCI's
> published geometry applied to cutoffs derived by rank on **full** market cap. Both rows above are
> still measured and still on every record: the desk's bands fire as their own rules so the
> disagreement stays visible, and the observed boundary is still reported. What changed is which one
> the verdict follows. **A third threshold source now exists — `msci` — and the rule that fires names
> which of the three produced it.**

> ### ⚠ The observed floor cannot classify a constituent — it IS one
>
> The Standard floor is the smallest Standard constituent, so "is this Standard constituent below
> the floor?" can never be true. That is the guard-reads-its-own-threshold trap (§3.8) wearing a
> different hat.
>
> The non-circular test is a **rank crossing against the whole universe**: MSCI Standard holds N
> India names, so take the top N companies by free-float market cap across the entire record. A
> Standard constituent outside that top N has been overtaken; a non-Standard company inside it has
> overtaken. Each is measured against the *other* segment and the unheld universe, never against its
> own segment's own extremum. On the committed data that yields 19 migration-down and 12
> migration-up candidates — small, specific and checkable.

### 2.15 The segments are disjoint and EM Small-Cap only samples

Measured on the committed holdings: `EM ∩ India SC = 0`, `EM ∩ EM SC = 0`. So segment membership is
**derived**, not assumed — and `assertDisjoint()` re-checks it every build, because a future holdings
file that breaks the pattern invalidates the derivation.

**EM Small-Cap holds 408 of India Small-Cap's 454 India companies and zero that India Small-Cap
lacks.** It samples the segment; India Small-Cap replicates it. So an entry draws a flow from India
Small-Cap **for certain** and from EM Small-Cap **only if that fund already samples the company**. A
company EM SC does not hold has no basis for an EM SC estimate: the output is **"not sampled"**,
never zero.

### 2.16 Only a trade-implying verdict gets a rupee figure

`stable`, `unknown` and `passiveDrift` produce **none**, ever. The four shapes that do, and how
certain each is:

| Shape | Certainty |
| --- | --- |
| **Exit** — the whole current position | nearly a **measurement**: the holdings file states the position exactly |
| **Entry** — a new position | **estimated**: target weight = the company's free float ÷ the segment's total free float, and both halves are shown |
| **Migration** | **two flows, never netted** — small-cap funds sell, EM buys. Different funds, different directions; netting them would imply a market-clearing that does not happen |
| **Not sampled** | no figure at all, and it says so |

`daysOfAdv` is the number a trader acts on. Where `advQty` is unknown it is **`null`** and renders an
em dash — never zero, never "instant".

#### ⚠ NSE ASM qualifies a forced flow; it never suppresses it and never moves the verdict

A trade-implying verdict on a company under NSE's Additional Surveillance Measure is the desk's one
case where a forced flow is **not mandated**: a passive fund is not obliged to rebalance an ASM name on
the review schedule, and the severe stages (trade-to-trade, no intraday netting) stretch or defer
execution. So a flow on such a name keeps its **mechanical rupee size** — that figure is a real derived
quantity and hiding it is its own dishonesty (§2.6) — but it is marked `constrainedByAsm`, carries an
`asmConstraint` naming the stage and the caveat, and its `daysOfAdv` is called **understated**. This is
`ASM_FLOW_CONSTRAINT` in `config/thresholds.mjs`, it is **the desk's assumption and never MSCI's**
(§2.25 — MSCI publishes no ASM carve-out), and it **never changes the verdict**: ASM fires an
`asm-flow-constraint` rule that is inert to `verdictFromRules`, because the verdict is a size question
and ASM is not a size fact. `verify-data` 53 proves the rule cannot move the verdict; `verify-ui` 57
proves the figure is shown-with-caveat, not suppressed.

### 2.17 A suspect input produces `unknown`, not a confident answer

`sharesOutstanding` feeds free-float market cap, which decides every verdict. A wrong share count
does not produce a visibly broken row — it produces a confident, well-formatted, **wrong** verdict.

`scripts/reconcile-shares.mjs` compares BSE's implied share count against Munshot's, each derived
inside its own source so no price difference leaks in. A disagreement is usually an **exact rational
ratio** (10×, 2×, 1.5×, 0.5×) because corporate actions are exact — which proves a corporate action
is involved but **not which side missed it**. Only a third source can settle that, and this project
has one: NSE's published free float, covering 261 symbols.

Anything a third source does not settle is **quarantined**: `verdict: 'unknown'` with the reason
attached. A hypothesis is not a resolution, and a verdict computed from a share count we do not
trust is worse than no verdict.

### 2.18 The review calendar is an assumption

MSCI reviews quarterly in February, May, August and November — that much is public. The **exact
effective date and the price-snapshot convention are not things this project can cite.** They live in
`public/js/model/calendar.js`, every surface says "assumed", and correcting them is a one-line edit.
Do not let a plausible date harden into an apparent fact by being rendered without its caveat.

### 2.19 The model's own weaknesses are written down, not discovered later

`docs/DATA-CONTRACTS.md` → **"Where this model is weakest"** is a ranked, measured list of every
load-bearing assumption under the verdicts and flows: no backtest exists, size is a necessary and
not a sufficient condition, liquidity never gates a verdict, 64 of the 145 non-stable verdicts sit
within ±20% of the threshold that produced them, 72 of the 87 inclusion verdicts rest on a BSE float
factor when MSCI follows NSE, and an entry flow is an estimate of a weight that does not exist yet.

**Keep it current.** A model whose limits are catalogued can be argued with; one whose limits are
implicit gets traded on. When a rule changes, update that section in the same commit — it is part of
the deliverable, not commentary on it.

### 2.20 A formatter may never round a real value to something that reads as nothing

This is a **different failure from §2.3 with the same consequence**, and it does not arrive as a
null. It arrives as arithmetic.

A ₹1,023,939 flow is ₹0.1024 Cr. Printed at the no-decimal precision the rest of the screen uses, it
reads **"₹0 Cr"** — and a reader takes that as *no flow*. A weight of 0.00045% printed at three
decimals reads **"0.000%"**, which says *not held* — the one thing this project is most careful never
to say by accident. A fractional count reads "0". In each case a real quantity has been erased by its
own formatter, and it always lands on **the smallest positions in the smallest companies**, which are
the rows least likely to be eyeballed. Both of the cases measured in the committed record are the
same company: Genus Prime Infra, 0.00139% of the India Small-Cap fund.

So **every formatter that can meet a small number carries a floor**, in
`public/js/core/format.js` and nowhere else:

| | Below its precision, prints |
| --- | --- |
| `inrFlow()` | `<₹0.01 Cr` |
| `pct()`, `factorPct()`, `signedPct()` | `<0.001%` / `>-0.001%` |
| `pp()` | `<0.01 pp` |
| `count()` | `<1` |

**A genuine zero still prints as zero**, because none is a fact and a floor that swallowed it would
trade one lie for another. Assertion 14 in `scripts/verify-data.mjs` runs every real weight and every
real flow in the record through its formatter and fails on any that reads as nothing — and asserts
the genuine zeros still read as zero.

### 2.21 A negative control, or the measurement is of your own code

The `scrip_id`-as-NSE-symbol run (§3.9) reported **26 of 157 candidates were a different company**.
The replay reported **none were**. The difference was not the data: 43 of the "mismatches" were an
absent name field scored as a wrong company, three were `&` against `and`, and the 60 "upstream
failures" were the `not_found`-under-load trap. **The mismatch rate measured the normaliser.**

What settled it was a control the first run did not have: three symbols that cannot exist
(`ZZQXNOTREAL`, `XKCDFAKE1`, `QQZZWWVV`) all returned HTTP 404, proving the endpoint is an existence
test and not a fuzzy matcher — and then reading the answer off the response's own `Exchange` field
rather than off a string comparison we wrote.

So: **before believing a rate, run the input that must fail.** If it passes, the instrument is
measuring itself. And when a measurement covers only part of a population, it does not get written
into a field that carries a stronger provenance — it gets its own field, or it gets discarded.

### 2.22 Every guard is proved by breaking the thing it guards

`node scripts/verify-data.mjs --prove` and `node scripts/verify-ui.mjs --prove` clone the context,
sabotage precisely what each check exists to catch, and report **CANNOT FAIL — as a failure** for any
check that survives. This is not decoration: the first `--prove` runs failed **seven** of the suite's own checks, every one
of which had been reporting a tick:

- a sabotage that no longer matched the pattern it was written for, after that pattern was tightened;
- a captured fixture that happened not to contain the trap it was chosen for (no comma inside any
  value, so a naive `split(',')` passed it);
- four one-shot DOM sabotages wiped by the re-render or reload the check itself performs before a
  single assertion ran;
- an assertion on `documentElement.scrollWidth`, which the `overflow-x: hidden` backstop in
  `index.html` pins to the viewport, so it could never fail at all.

**A check that cannot fail is not a check.** Before adding one, break the thing it tests and confirm
it goes red; if you cannot make it fail, say so in the report rather than counting it.

---

---

### 2.23 The universe is a union recomputed every run, never a frozen list

The desk's instruction is "track every company above ₹2,000 Cr market cap", and it supplied a
Screener export of exactly that screen — 1,253 companies, every one with an ISIN, no duplicates.

**That file is a seed and an identity bridge. It is not the universe.** A frozen list goes stale in
precisely the way that matters:

- Companies cross ₹2,000 Cr in both directions constantly. La Opala (₹2,081 Cr) and TeamLease
  (₹2,071 Cr) sit above the floor in our own BSE data and below it in Screener's — same companies,
  different minutes. A frozen list drops them silently.
- **A company the funds hold is in scope at any size.** Genus Prime Infra is ₹52 Cr and held. It is
  not on the seed list and must never be dropped from the record.

So the universe is recomputed on every run as a union of three inputs:

```
  active BSE scrips with full mcap ≥ ₹2,000 Cr     self-maintaining, from BSE's own master
∪ every company held by any fund                    any size, always
∪ the desk's seed list                              catches what BSE's equity master cannot see
```

The third term is not redundant. BSE's master is filtered `segment=Equity&status=Active`, so it
cannot see **NSE-only listings** — BSE Ltd (₹1.34 lakh Cr), CDSL (₹28,129 Cr) and TSF Investments
(₹9,433 Cr) are all above the floor and none is in BSE's equity master at all.

**A seed code is only believed when the active master carries it AND agrees on the ISIN.** Anything
else is recorded and not fetched: a code the active master does not carry may belong to a delisted
company that BSE will happily answer for with three-year-old figures (§3.8). Measured on this
export, 24 of the seed's BSE codes are rejected that way, and almost all of them are REITs and
InvITs — Embassy Office Parks, Mindspace, Nexus Select, Brookfield India, IndiGrid, IRB InvIT,
PowerGrid InvIT, Cube Highways, Knowledge Realty. BSE files those **outside** the equity segment,
correctly: they are a different instrument class, not missing names.

Every company that ends up with no BSE record carries `noBseReason` saying which of those it is. An
em dash with no reason reads as a fact about the company rather than a gap in our sources (§2.3).

**The seed also carries the best ISIN → NSE symbol bridge we have.** `nse-universe.json` is built
from two niftyindices index lists, so it only knows names those indices contain; the seed names an
NSE code for ~1,217 companies. Both are used, `nse-universe` first, each recorded in
`nseSymbolSource` — and where both name a symbol for one ISIN **they must agree or the build
stops**, because a disagreement means one of them has the wrong company on that ISIN and every
float reading keyed on the symbol would belong to somebody else.

### 2.24 A size cut-off is not an absolute rupee figure

The desk's bands are fixed: **₹3,500–4,000 Cr** for inclusion, **₹2,000–2,400 Cr** for exclusion.
MSCI's real cut-offs are not. They are derived **at each review from the investable universe**, so
the bar rises with a rising market and falls with a falling one.

That gap is directional and it hits every company at once. In a segment that rose 12%, a fixed band
**over-calls inclusions** — companies clear a bar that has itself moved up. In a segment that fell it
under-calls. And a company whose free float grew 4% while its segment grew 12% has become
**relatively smaller**: closer to exclusion, not further from it. A fixed rupee band cannot see that.

So each band is floated by its own segment's price return since the last review's effective date:

```
adjustedBand = band × (1 + segmentReturnSinceLastReview)
```

`SEGMENT_BAND_ADJUSTMENT` in `public/js/config/thresholds.mjs` owns it, including which fund proxies
which segment. `outside` uses the India small-cap fund, because a company entering the index enters
MSCI India Small Cap — that is the bar it has to clear.

**Both numbers stay on every rule.** `rulesFired[].band` carries the desk's raw band, the segment
move, the factor and the reason, so a reader can see how far the bar moved and what the verdict would
have been without it. A floated threshold rendered as a bare number is a tier-3 adjustment wearing a
tier-1 face.

Measured on the 20 Aug 2026 record: SMIN **+5.73%** and EEM **−3.44%** in rupees since the May
review. **22 companies change verdict, 14 of them held** — mostly small caps at ₹2,430–2,520 Cr that
read `stable` against a fixed ₹2,400 Cr and `exclusion-risk` against a floated ₹2,538 Cr.

> ### ⚠ These funds are priced in dollars and free float is in rupees
>
> SMIN, EEMS and EEM all quote in USD, so their headline return folds in the INR/USD move. Measured
> over the year to 20 Aug 2026:
>
> | Fund | USD return | INR return | FX contribution |
> | --- | --- | --- | --- |
> | SMIN | **−3.62%** | **+5.44%** | +9.05 pp — *the sign flips* |
> | EEMS | +12.86% | +23.46% | +10.60 pp |
> | EEM | +33.91% | +46.96% | +13.05 pp |
>
> Comparing an Indian company's rupee growth against SMIN's **dollar** return would have said the
> segment shrank 3.6% when it grew 5.4%, and every relative judgement built on it would be wrong in
> the same direction for every company.
>
> The conversion is exact, not a correction factor. An ETF's price is the rupee value of its basket
> expressed in dollars, so `basket_inr = price_usd × usdinr` and the rupee return multiplies each end
> of the window by **that date's** rate. `USDINR=X` is fetched alongside for exactly this, and
> `verify-data` assertion 26 fails if the two returns ever come out equal — an FX step that changes
> nothing is decoration.

**It is the ETF, not the index.** An ETF carries tracking error and trades at a premium or discount
to NAV, so this is a close proxy and never the index itself. MSCI's index levels are licensed and
this project has no entitlement to them. It is also a **price** return, not total return: a free-float
market cap moves with price, not with a distribution paid out in cash.

**The adjustment is the desk's, twice over** — MSCI derives cut-offs from the whole investable
universe rather than one segment, and the proxy is a fund rather than an index. Directionally right,
approximately sized, and never to be shown as MSCI's arithmetic. Below `minMovePct` (1%) it is
recorded and not applied, because a segment that moved a fraction of a percent cannot meaningfully
have moved MSCI's cut-off and applying it would churn verdicts on noise. **That is the normal state
for the first weeks of a quarter**, when the window since the review is a few sessions long — 0
floated rules is the correct answer then, not a broken build (§2.34).

> ### ⚠ The baseline needs a session after it here too, and this path did not have one
>
> The window is `previousReview(prices.tradeDate)` → the newest close, and `previousReview` is
> INCLUSIVE: on the day a review takes effect it returns that review, with `daysSince: 0`. The
> segment return is then struck over no elapsed time at all and comes out **0.000%** for every
> segment — a fabricated zero of exactly the shape §2.12.3 names, on a different code path.
>
> `sinceRebalance` was given the walk-back through `chooseBaseline()`; this was not. On 31 Aug 2026 it
> produced a record with no floated band anywhere and turned the daily refresh red. It now steps back
> to the review before, and says so on the build's own output.

### 2.25 MSCI's published rules are not the desk's heuristics, and the code must never blur them

`public/js/config/thresholds.mjs` holds **the desk's** numbers. `public/js/config/msci-methodology.mjs`
holds **MSCI's**, read from the GIMI Methodology (August 2026, 192 pp.) on 24 Aug 2026, every value
cited to a page. `docs/MSCI-METHODOLOGY.md` is the full study. Three facts from it change how this
model should be read:

**1. The size cut-off is on FULL market cap, not free float.** Coverage targets (85% Standard, 99%
IMI) are measured in free float; the cut-off that falls out of the procedure is a full market cap
(p. 28). Free float enters through a *separate* test — free-float mcap ≥ 50% of that cut-off (p. 30),
with existing constituents allowed 2/3 of it (p. 45). **We compare one quantity where MSCI compares
two.** That is the largest known gap between this model and the index it forecasts.

**2. Migration is buffered and asymmetric** (pp. 44–45). An existing constituent leaves only below
**2/3 (−33%)** of the cut-off; a non-constituent enters only above **1.5× (+50%)**. Our flat bands
have no hysteresis, so we over-predict migration in both directions. And entry is **competitive**:
a company above the Small Cap Entry Buffer is added *"only to the extent that they replace current
constituents which have fallen below the Small Cap Lower Buffer"*. Clearing the bar makes a company
eligible, not included — which is why an inclusion verdict here can only ever be a candidacy.

**3. ⚠ The review is decided a month before it happens.** The price cut-off is **any one of the last
10 business days of the month BEFORE the review month**, and MSCI does not say which (p. 49). For the
August review that is 20–31 July. This was recorded here as "unconfirmed" and it is now confirmed, so
`CONVENTION.confirmed` is `true` and carries its citation. Once that window has closed, a verdict on
today's price describes where a company stands **now**, not the snapshot MSCI took — and the screener
says so.

Corroboration worth keeping: our computed August-2026 price window opens on 20 July 2026, which is
exactly the date MSCI stamps its own August size-reference table (p. 26). Two unrelated parts of the
book agree, and assertion 28 asserts it.

**All four reviews have been comprehensive since February 2023** (p. 152) — before that, May and
November were Semi-Annual and February and August were lighter. Treating all four alike is right for
the current book and wrong for history.

**Never present an MSCI rule as the desk's, or a desk band as MSCI's.** `model.thresholdSources` now
carries three sources — `desk`, `observed`, `msci` — and assertion 29 fails if an MSCI rule block
loses its page citation or if the buffer geometry is made symmetric.

### 2.26 Two methodologies are computed; ONE renders, and the other is never hidden

§2.25 names three gaps between this model and MSCI's rules. They are **implemented**, in
`public/js/model/gimi.js`:

| Model | What decides a verdict | Where it appears |
| --- | --- | --- |
| `freefloatmarketcap`, `assess.js` | free-float market cap vs the desk's rupee bands | **the screen** — every row, every column, every export |
| `freefloat+fullmarketcap`, `gimi.js` | MSCI's procedure: rank by full mcap, count free float to the coverage target, test free float separately, with MSCI's buffers | **the drill panel of each row**, and verify-data 30–32 |

> **The toggle is gone (31 Aug 2026), and the second model is not.** Both were switchable at the top
> of the screener until the desk asked for one view. What went is the *control* and the banner that
> counted disagreements across the universe; what stayed is the comparison itself, moved to where it
> belongs to a single company. `state.METHODOLOGY` is the constant `'freefloat'`, the same shape
> §2.27 gave `state.SCOPE`.
>
> **A count above a table is the weaker form of this disclosure anyway.** "252 of 1,265 verdicts are
> method-dependent" tells a reader that some row on this screen is fragile; the drill tells them
> whether *this* one is, names the other model's verdict beside it, and says which size number the
> disagreement turns on. Assertion 25 fails if the drill stops saying so, and fails if a model
> control reappears.

Both are computed because the desk's model is already useful and the client accepts it. The honest
way to argue for a better one is to **show the difference**, not assert it. Measured on the committed
record: **249 of 1,254 verdicts differ**, **432 companies move more than 100 ranks** depending on
which size measure ranks them, **168** sit sheltered by the lower buffer and **166** are held back by
the entry buffer.

The case that proves the point is **LIC**: ₹18,759 Cr of free float, far above the desk's ₹4,000 Cr
band, so the shipped model calls it a likely inclusion. Its Foreign Inclusion Factor is 0.035 against
MSCI's floor of **0.15**, so MSCI would not include it at all. One model cannot see that; the other
says so on the row.

Rules that bind both:

- **Neither model may be presented as MSCI's own output.** The GIMI cutoffs are derived by MSCI's
  procedure from **our** universe — the ~1,254 Indian companies we hold, floated by the exchanges —
  while MSCI derives its own across all of emerging markets using its own float factors. The
  structure is MSCI's; the number is ours. `CUTOFF_DISCLOSURE` states this on every surface showing a
  cutoff, and the derived IMI cutoff (₹3,338 Cr) landing inside MSCI's own published reference range
  (₹2,952–6,789 Cr) is corroboration, not proof.

  > ⚠ **And that corroboration is about THIS module's cutoff only.** Since §2.33 the shipped model
  > derives its cutoffs by rank against the constituent count instead, and that one lands at
  > **USD 998m against MSCI's published EM IMI range of USD 309–710m** — 1.41× above the top, because
  > the funds sample rather than replicate. Do not carry the sentence above across to it;
  > `model.sizeCutoffReference` states the comparison for the shipped model and verify-data 46 fails
  > if it goes missing.
- **Both models see the same universe** or the comparison is meaningless — no row is assessed by one
  and not the other. verify-data 32 asserts they disagree about real companies rather than being a
  relabelling of each other, and is proved by making the second return the first's verdicts.
- **The second model prices nothing.** Flow estimates follow the shipped verdict only: a rupee figure
  derived from a verdict the screen does not show is a number nobody could trace back to a row.
- **Every rule carries the UNIT of its own numbers** — `inr`, `rank` or `factor`. Rendering MSCI's
  FIF floor of 0.15 as "₹0 Cr" is not a rounding artefact, it is a different number.
- **A distance is paired with the rule it was measured against**, named by the model, never "the last
  rule fired". LIC is what proved it: the verdict turns on the FIF floor while the last rule recorded
  is about free float, so the sentence reported a real percentage against an unrelated threshold.
- **A company missing either size is excluded from the walk and counted**, never zeroed — a zero
  sorts to the bottom, inflates the denominator and drags both cutoffs down. The coverage cost of the
  correction is 3 extra `unknown` verdicts, and it is reported rather than absorbed.

### 2.27 The scope toggle is gone; the screener shows every company

Held-versus-all was removed on 26 Aug 2026. A candidate no fund holds yet is precisely what an
inclusion forecast is *about*, so defaulting to "held" made the product's own subject something a
reader had to opt into. `state.SCOPE` is now the constant `'all'`.

The model toggle took its place in the header and then went the same way on 31 Aug 2026 (§2.26), so
**the header now carries one control: the status pill.** Twice now a toggle has been removed rather
than defaulted, and the reason is the same both times — a screen that asks a reader to choose before
it will answer has made its own subject optional.

### 2.28 A figure the reader types is an input, and it gets the same suspicion as a feed

The market-cap filter became a typed min–max range on 31 Aug 2026 — `₹ [min] – [max] Cr` — because
five fixed bands could answer "roughly how big" and could not answer "show me ₹3,000 to ₹8,000 Cr",
which is the question when a company is being weighed against a cut-off.

It moves a parsing problem out of the pipeline and into the interface, where it is **harder**. A
feed that arrives malformed has an upstream file to check the answer against; an entry has nobody
but the person who typed it, and they will read whatever comes back as the answer to what they
asked. Two traps, both of which arrived on the way in:

> ### ⚠ `parseFloat` is banned on the way IN as well as on the way out
>
> `parseFloat("3,000")` is `3`. Not an error, not `NaN` — a plausible small number that filters,
> sorts and ranks perfectly happily, and fills the screen with confident, well-formatted, entirely
> wrong companies. It is §3.8's trap wearing a different hat, and it is worse here because the
> reader typed the input themselves and has every reason to trust the output.
>
> `public/js/core/range.js` validates the whole string before it converts anything, and it is
> unit-free: it reads numbers, and the caller owns what they mean. Assertion 38 pins the parse table
> with no browser at all, and `--prove` swaps in the naive reader to show the check catches it.

> ### ⚠ A conversion can manufacture a zero from a null
>
> `toCrore(null)` is `null / 1e7`, which is **`0`** — a real, finite zero that passes every
> `Number.isFinite` guard downstream. Converting before checking for a missing value therefore hands
> every unmeasured company to the filter as though it were worth nothing, and a range starting at 0
> lists all 26 of them beside companies whose size is known (§2.3, by a route that does not look like
> §2.3 at all).
>
> **The missing check comes before the conversion.** Assertion 44 caught this on its first run,
> which is the argument for writing the check before believing the code.

The rest is §2.3 and §2.4 applied to a control rather than to a number:

- **Both ends are included**, and the status line says so rather than leaving it to be discovered.
  The old bands were half-open because they had to tile a universe with no gaps and no overlaps; a
  typed range has no such duty.
- **A blank end is an open end, never a zero.**
- **An entry that cannot be read hides nothing**, and says what was wrong and that the range is not
  in force — an unreadable entry silently filtered to an empty table would report a typo as a
  finding about the companies. A minimum above a maximum is the same state, and it is **not**
  quietly swapped: correcting what somebody typed changes the question they asked without telling
  them.
- **What the entry was read as is on screen**, in the reader's sight line, and the same sentence
  travels into row 1 of any export — including when it says the range could not be read.
### 2.29 A column width can manufacture a wrong number, and it looks exactly like a right one

The reader can drag any column's right edge, put away columns they do not need, and both choices
persist. Fourteen columns is more than most desks read at once, so this is a real ask — and it opens a
route to a false figure that no formatter guard can see.

**Measured, before the guard existed.** With `table-layout: fixed` and the Free float column dragged
to 70px, HDFC Bank's **₹10,99,757 Cr rendered as `10,99,75`** — not blank, not an em dash, a clean and
plausible ten-times-wrong number on the largest bank in the country, with nothing on screen saying it
had been cut. That is **§2.20 at the layout layer**: a formatter may never round a real value to
something that reads as nothing, and a column width may never truncate one into something that reads
as a different value.

So a narrowed column must make its own clipping visible, and which mechanism does that had to be
measured rather than assumed. Chrome draws a `text-overflow` ellipsis by replacing trailing items on
the line, so a line box holding exactly **one atomic inline** — an `inline-flex` or `inline-block`
wrapper around the whole cell — has nothing to replace and is simply cut:

| cell content | squeezed, renders as | |
| --- | --- | --- |
| plain text | `12,34…` | ellipsis |
| inline flow + chips | `10,9…` | ellipsis |
| two or more chips | `SMIN …` | ellipsis |
| **one atomic inline box** | `10,99,75` | **no ellipsis** |

Wrapping the atomic box in a plain `<span>` does not rescue it. A trailing zero-width space does not
either, and a leading one puts the ellipsis first and eats the whole cell. Both were tried.

Hence **two mechanisms, not one**, in `public/js/ui/screener.js`:

1. **`text-overflow: ellipsis` on every body cell**, which covers every cell whose content is inline
   flow. Cell renderers must stay inside that shape — Free float, Funds and the three rebalance
   columns in `tabs/companies.js` each lost a single flex wrapper for this, and `sourceChip` is
   spaced by its own `ml-1` rather than by a flex gap on whatever holds it.
2. **A fade mask on the clipped edge**, which needs no cooperation from the cell's markup at all. It
   is exactly the cell's own padding wide, so content that *fits* — which stops at the padding edge —
   is never touched, and content that is *cut* — which runs to the border edge — always is. That is
   the backstop for the lone-atomic case and for any renderer written later.

And the rest of the rules the feature carries:

- **`MIN_COL_PX` is 48 and `MAX_COL_PX` is 900.** Below the floor a column is invisible while still
  sorting the table, which is a control whose effect the reader cannot see; above the ceiling a
  runaway drag strands every other column off-screen.
- **The table's width is the sum of its columns, never `100%`.** Under `table-layout: fixed` a table
  told to be 100% wide redistributes the slack, so every width the reader set comes out as something
  else and dragging one column silently moves its neighbours.
- **Putting a column away re-shares its width across the rest**, so the table still fills the screen.
  Subtracting it is what the sum rule above does on its own, and it left the reader — who removed a
  column to give the others more room — looking at a band of white where it had been: measured,
  hiding Funds at 1,320px left the table 1,206px and 114px of nothing. The obvious fix is the one
  forbidden above, so the widths are re-shared in proportion instead and the table stays equal to
  their sum. **A drag is not re-shared** — narrowing a column by hand and watching its neighbours
  grow back into the space would make the table impossible to shrink. And a table the reader has
  deliberately dragged *wider* than the screen keeps its widths and keeps scrolling: closing a gap is
  one thing, overruling a stretch is another. Check 53, whose sabotage is the re-share deleted.
- **Widths are keyed by column label, never by position.** A stored `{ 3: 210 }` would follow the
  third column wherever a later release moves it, so a reader who widened Free float would come back
  to a widened Float %.
- **A hidden column is collapsed by CSS, not removed from the tree**, so headings and cells stay
  index-aligned and every index-addressed assertion in `verify-ui` keeps addressing the column it
  means.
- **The name column cannot be hidden.** A row nobody can identify makes the rest of the line
  meaningless.
- **What the reader put away is stated where they put it away.** The control reads "9 of 13", the
  note names every hidden column, and **a sort whose column is hidden says so in words** — otherwise
  the rows sit in an order whose basis is off-screen, which reads as no order at all on the one table
  where the order *is* the finding.
- **Hiding changes this screen only.** The CSV export carries every field whatever is on screen,
  and check 49 tests that against the file rather than repeating the claim.
- **Reset returns the layout the table ships with** — automatic widths, every column — not a
  different set of fixed numbers. A reader who never touches the controls gets exactly what shipped.
- **Geometry this code measures is set inline, never left to Tailwind.** The play CDN generates
  classes *asynchronously*, so a `w-72` panel measured in the tick it was appended is still
  `width: auto`. The column menu's off-screen check read that phantom box, decided the panel was fine
  and did nothing — and at 390px the real panel then sat 37px off the left edge, where the
  `overflow-x: hidden` backstop makes it unreachable rather than merely ugly. Measured. Only the
  paint is left to the CDN.

Checks 47–50 and 53 in `scripts/verify-ui.mjs` cover the claims. **Three of the four sabotages were
survived on the first `--prove` run**, and both reasons generalise:

- **A MutationObserver sabotage loses the race against a synchronous read.** Checks 47 and 49 squeeze
  or hide and then read inside one `page.evaluate`; an observer fires on a microtask, after that
  evaluate has finished. Both now sabotage statically — an `!important` override for the fade, and a
  swallowed `textContent` setter for the note.
- **A computed-style assertion measures the CDN, not the code.** Check 48 read
  `getComputedStyle(el).display` to find a lone atomic box; with Tailwind unreachable an
  `inline-flex` wrapper computes to plain `inline` and the check saw nothing wrong. It now tests the
  class contract as well, so it holds in both environments.

### 2.30 A standing paragraph is not provenance, and a control is not a caption

Three blocks of explanatory chrome have now been removed from above the table, and the argument was
the same every time:

| Removed | What it said | Where that lives now |
| --- | --- | --- |
| the blanket footer disclosure (28 Aug 2026) | "nothing here is a forecast yet" | every figure's own source chip, formula, rule table and as-of |
| the model banner (31 Aug 2026) | which model is in force, what it does differently, how many rows disagree | the drill panel of each row, per company (§2.26) |
| the baseline card (31 Aug 2026) | what the relative columns measure, from when, and how many rows carry a reading | each of the three cells, the drill, and row 1 of the export |

**A standing paragraph that duplicates per-number provenance teaches readers to skip the paragraph,
not to trust the numbers.** The doctrine in §2.1–§2.7 is that disclosure travels *with* the figure —
on the row, in the drill, into the export — and a block above the table is the one place a reader
learns to scroll past. Removing one is only safe when the per-number disclosure is already there, so
check that first: the test is whether a reader who never scrolls up can still tell where the number
came from and what it does not say.

> ### ⚠ A control is not a caption, and it does not go with the card it sat in
>
> The baseline card contained the baseline *picker*, and the desk had asked for the baseline to be
> overridable one commit earlier. What survives is one line — the date the columns measure from, the
> date they measure to, and the means to change the first — carrying the long form on its `title`.
> Deleting a requested control because it shared a box with prose would answer a question about
> layout by removing a feature.

### 2.31 A repaint is not a rebuild, and a fresh table is not one somebody scrolled to the end of

Changing the rebalance baseline used to block the reader's main thread for **1,092 ms**. Three
separate things were wrong, and only the third is about performance in the ordinary sense.

**1. It rebuilt what it is forbidden to change.** A baseline switch called `build()`, which re-derives
every verdict, every rule, every flow and every GIMI assessment for 1,265 companies — while §2.12.4
guarantees not one verdict can come out different. The only possible effect of that work was a defect.
What actually moves is the flow-pressure classification and three columns, so `rebasePressures()`
recomputes the pressures in place and the table's row markup is invalidated. Measured: the model
rebuild that used to run on every switch is **64–86 ms** of the cost; parsing the 1.2 MB alternates
file is **8 ms**. Neither was the freeze.

> ### ⚠ A FRESHLY PAINTED TABLE LOOKS LIKE ONE SOMEBODY HAS SCROLLED TO THE END OF
>
> **2.** The table streams rows in after first paint, and a scroll listener flushed the rest when the
> reader reached the painted edge. Its test was
> `scrollTop + clientHeight >= scrollHeight - 400` — which, with 80 of 1,265 rows painted, is true
> **before anybody has scrolled at all**, because `scrollHeight` is barely taller than the box. The
> listener was on `window` as well as the scroller, so the very next scroll event anywhere on the
> page — *including the `scrollTop = 0` the repaint performs itself* — painted 1,185 rows in one
> synchronous block.
>
> A guard now returns early while the painted rows do not fill the box, and a genuine edge scroll
> paints a bounded burst instead of everything. `flushRemaining()` survives for the callers that
> really mean all of it now: the End key, the export, and the verification harness.

**3. A budget that bounds the loop does not bound the slice.** The idle fill sliced adaptively while
`deadline.timeRemaining() > 4` — a promise about how much idle time is *left*, not about how long the
work takes — so one generous idle window painted hundreds of rows in a single task. Replacing the
deadline with a fixed 12 ms budget was not enough either: the loop checked the clock *between*
slices, and one `appendSlice(600)` is a single uninterruptible block. Each slice is now sized from a
**measured** rows-per-millisecond rate against the budget that is actually left.

Measured after all three: the switch is visible in **~100 ms**, the idle callbacks are **5–12 ms** of
script each, and the remaining frame time is the browser laying out a growing table — the same cost
first paint has always had, not something the switch introduced.

> **The check that watched this had to move too.** verify-ui 45 waited for the table NODE to be
> replaced, which was the old rebuild's signature; the table now survives a switch, which is the
> point. The wait is `__setBaseline`, on the baseline strip being re-rendered — a signal only the
> switch produces, and produced by different code from the cells the check reads.

### 2.32 A scorecard is the easiest thing here to fake by accident

The August 2026 review happened, EEM and SMIN were re-downloaded, and the product can now say how
its forecast fared. That is the first outcome this repo has ever had — and the first number on it a
reader could be badly misled by.

> ### ⚠ THE FORECAST MUST BE FROZEN BEFORE THE ANSWER LANDS
>
> Every verdict recomputes from whatever holdings are committed. Import the post-rebalance workbooks
> and the verdicts silently recompute against the new membership; score *those* and the model is
> being marked on the answer sheet. It would score beautifully and mean nothing, and **nothing in
> the output would look wrong.**
>
> So `scripts/snapshot-predictions.mjs` writes the forecast to `predictions-<review>.json` from a
> record whose holdings predate the effective date, and refuses twice: it will not write from a
> record dated on or after the review, and it will not overwrite an existing snapshot without
> `--force`. The effective date comes from `model/calendar.js` — a source the record under test
> cannot move, which is §3.8's guard rule applied to time.
>
> `verify-data` 44 asserts both halves, and the second is the one that matters: the frozen verdicts
> must **measurably differ** from the live record. A snapshot regenerated post-hoc would be identical
> on every row. Measured: **21 of 1,265 verdicts have changed** since the freeze, which is what a
> real forecast looks like once its subject has moved. Its sabotage is that regeneration.

**Only a re-read fund is evidence about what changed.** EEMS was not supplied for this review, so a
company that left India Small-Cap is still in the fortnight-old EM Small-Cap file. A segment derived
from all three funds reads it as "still small cap" and scores a real exit as a miss that never
happened. Both sides of every comparison are therefore restricted to the funds whose workbook moved
between the two dates — measured from the dates, never a hard-coded list — and the fund left out is
**named on the page**, because *we did not look* and *nothing happened* are different facts (§2.4).

**Two figures, never one, each with its denominator.** Measured on the August review:

| | |
| --- | --- |
| companies that changed segment | **33 of 1,265** — 12 entered, 18 left, 3 migrated |
| of what we flagged, how many moved | **23 of 166** |
| of what moved, how many we flagged | **23 of 33**, and every one named the right event |
| no-change calls that held | 1,063 of 1,073 |

That last line is the trap. **1,232 of 1,265 companies did not move**, so calling "no change" is
nearly free and any blended accuracy counting those true negatives reads above 97% for a model that
never fired at all. It is shown, and captioned as a true-negative rate in the same breath. **No
single accuracy figure is offered anywhere in the product**, and `verify-ui` 54 asserts both
denominators are on screen along with that caption.

**The page shows what it missed, in a section of its own.** Ten movements were not called, Nippon
Life (₹21,445 Cr, called `stable`) the largest. Scattering them among the hits is not the same as
collecting them: the first version of check 54 asserted only that missed companies were named
*somewhere* on the page, which passed with the misses section deleted — every one of them also
appears in the entered/exited table it belongs to. `--prove` caught it. The check now asserts they
are in the misses section specifically.

**One review is one data point, and the page says so above everything else.** §2.13 refuses to print
a probability because a probability needs a base rate and a base rate needs history. A single scored
review is not that history. Nothing here changes §2.13.

> ### ⚠ The segments stopped being disjoint, exactly as §2.15 said they would
>
> §2.15 recorded `EM ∩ India SC = 0` as measured, not assumed, and said a future holdings file
> breaking the pattern would invalidate the derivation. The August files broke it in two different
> ways:
>
> | | |
> | --- | --- |
> | **Laurus Labs** | EEM (31 Aug) + EEMS (17 Aug) — it migrated up and the older workbook has not caught up. A date gap, not an overlap. |
> | **Astral** | EEM 0.0002% ($0.08m) + SMIN 0.4387% ($3.40m), both 31 Aug — a migration caught mid-trade, the leg it is leaving nearly unwound. |
>
> So the derivation gains one rule, the desk's, in `SEGMENT_OVERLAP`: **the newest file that names a
> company decides its segment; where the files share a date, the larger position decides.** Newer
> evidence beats older; equally-dated evidence is settled by where the money is. Both legs stay on
> the record so the overlap is visible rather than resolved away, and the segment is decided **once,
> at build time, with the dates** — every later reader honours `company.segment` rather than
> re-deriving without them and quietly disagreeing about two companies.
>
> What still fails the build is an **unexplained** overlap: same date, both legs substantial. That
> would mean the segments genuinely are not disjoint and every verdict resting on the derivation is
> void. `verify-data` 02 was rewritten around exactly that distinction.
>
> And the **EM SC ⊆ India SC** check cannot run across two dates at all. EM SC "holding nine
> companies India SC lacks" is precisely what a stale file looks like after a review. Passing it
> would be worse than failing it, so it reports **NOT MEASURABLE** and `CheckList` gained a `skip`
> that is printed on every run — a suite that quietly stops testing something and still reports a
> clean sheet manufactures confidence rather than providing it.

> ### ⚠ The record now mixes two holdings dates, and the freshness claim nearly lied
>
> `asOf.isharesHoldings` read `funds[0].asOf` — harmless only while all three workbooks shared a
> date. EEM is now the *newest*, so the header pill, whose whole job is to name the **oldest** input
> (§2.10), would have claimed a fortnight of currency the record does not have. It takes the minimum
> now, and `holdingsAsOfByFund` carries all three so a surface can name the stale one.
>
> That map lives **beside** `asOf`, not inside it: `asOf` is a registry of single dated feeds and the
> freshness surface walks it key by key. An object among the dates is a key no feed can carry, and
> assertion 35 said so immediately.

**Identity is ISIN here too, and it earned its keep on the first run.** BlackRock respelled Bajaj
Auto's ticker from `BAJAJ-AUTO` to `BAJAJ.AUTO` between the two files. A ticker-keyed diff reports
that as one exit and one entry — two fabricated events on a company that did not move, in a table
whose entire purpose is to count events. Keyed on ISIN it reads as what it is: no change, with a
weight move.

### 2.33 The model was wrong in KIND, not in degree, and the corrections were already published

The August 2026 forecast named **166 companies as moving; 33 moved; 23 of the 166 were right** —
13.9% precision, 69.7% recall. Diagnosed against the outcome, none of the four large errors was a
mis-set number. Each was the model asking a different question from the one MSCI answers, and each
has a correction MSCI prints and we can cite.

| Error | What MSCI does | Where it cost us |
| --- | --- | --- |
| one size measure | the cutoff is a **full** market cap (p. 28), free float is a **separate** minimum (p. 30) | the two real migration-downs |
| no hysteresis | 2/3 out, 1.5× in (pp. 44–45) | 39 migration flags, 3 events |
| no FIF floor | FIF ≥ 0.15 (pp. 21, 45) | 16 inclusion flags on companies no fund can hold |
| a fixed rupee band | cutoffs are derived at each review | exits ran to ₹3,749 Cr against a ₹2,538 Cr bar |

> ### ⚠ THE BUFFER WAS NEVER WRONG. IT WAS BEING APPLIED TO THE WRONG QUANTITY
>
> This is the finding worth carrying forward, because it looks like a threshold problem and is not.
> Measured against the Standard cutoff on **full market cap**, Balkrishna and Astral sit at −35.5%
> and −41.1% — comfortably inside MSCI's published −33.3% lower buffer. Measured on **free float**,
> the same two sit at −31.6% and −31.7%, where that same buffer misses BOTH.
>
> A first attempt read that as "MSCI's number does not transfer" and proposed a fitted −30%, on
> n=2. It transfers perfectly. **Before deciding that a published rule does not fit, check what you
> are applying it to.**
>
> ### ⚠ AND FULL MARKET CAP DOES NOT ORDER THEM BETTER — IT ORDERS THEM WORSE
>
> The obvious next sentence — "so full market cap is the better measure" — is false, and it was
> written here before it was checked. Rank the 166 Standard constituents from smallest up and the
> two real migration-downs are **#1 and #2 by free float** and **#4 and #6 by full market cap**.
> Free float orders them perfectly; full market cap does not.
>
> What full market cap buys is not a better ordering, it is **a threshold somebody else published**.
> On free float, catching both needs a bar we invent — the worst two, or −30%, fitted to n=2. On
> full market cap, MSCI's own −33.3% catches both with 7 flags. Both end at roughly seven flags and
> two hits on this review; the difference is entirely whose number sets the bar.
>
> So the reason to cut on full market cap is §2.25's, and only §2.25's: it is the quantity MSCI
> expresses a cutoff in. A separation argument for it would be reading a preference out of noise —
> as the AUC figures below already show, twice.

**The cutoffs are ours, the ratios are MSCI's, and nothing may blur them.** Both cutoffs are the Nth
company by full market cap across the **whole** record, where N is the number of India names the
funds show MSCI holding in that segment — 166 Standard, 622 IMI on the record of 31 Aug 2026. That
is §2.14's non-circular rank crossing moved onto the size measure MSCI cuts on: the Nth company is
drawn from the whole universe, never from the segment under test, which is what lets a constituent be
overtaken at all. It fires: 23 of 458 Small Cap constituents sit below the deletion buffer and 5 of
167 Standard below the migration one.

`gimi.js` derives its cutoffs by MSCI's coverage walk instead, and **on our universe that walk lands
in the wrong place**: 1,016 companies clear its IMI cutoff against 623 constituents, and 306 clear
its Standard cutoff against 165. MSCI's 85% and 99% targets are of the *Market Investable Equity
Universe* — after liquidity, foreign-room, length-of-trading and minimum-size screens — and we run
them over everything BSE lists above ₹2,000 Cr. Apply the 2/3 buffer to a cutoff that low and only
**three** constituents fall below it, none of which left. That is the whole reason the GIMI model
calls every one of August's 18 exits `stable`.

> ### ⚠ AND OUR CUTOFF IS BIASED HIGH — §2.26's CORROBORATION DOES NOT CARRY OVER
>
> §2.26 recorded the coverage-walk IMI cutoff landing inside MSCI's own published reference range as
> corroboration. The rank-derived one does not land inside it: **USD 998m against MSCI's published
> EM IMI Global Minimum Size Range of USD 309–710m** (pp. 24, 26), 1.41× above the top.
>
> The reason is in the derivation. The constituent count comes from three iShares funds that
> **sample** rather than replicate, so it under-states MSCI's real India IMI membership and the Nth
> company is bigger than MSCI's own cutoff. `model.sizeCutoffReference` computes that comparison on
> every build so it cannot go stale, and verify-data 46 fails if it is dropped. Citing MSCI's pages
> for the ratios while hiding that the bar they scale sits 40% above MSCI's own reference would be a
> tier-3 figure wearing a tier-1 face.

**The desk's bands are kept and no longer decide.** They fire as `desk-inclusion-band` and
`desk-exclusion-band` on every company, floated by `SEGMENT_BAND_ADJUSTMENT`, carrying their own
result — and nothing branches on them. Deleting them because one review disagreed would throw away
the client's frame of reference; leaving them silently beside a verdict they did not produce would be
worse. §2.14 again: where the two part company, the disagreement is the information.

#### What was rejected, and why it is worth writing down

Bands of **₹8,000 Cr and ₹3,800 Cr**, fitted to these 33 events, scored **20.5% / 97.0%** — better
than what ships. They were rejected on measurement, not on principle:

- both are a **sample maximum**: ₹8,000 Cr is 1.4% above the largest caught exit, ₹3,800 Cr is 1.4%
  above the next. A max-statistic estimator has almost no chance of covering next quarter's max.
- refit on 32 of the 33 and score the one held out, and **97.0% becomes 90.9%**; across 96
  deterministic train/test splits, pooled held-out recall is **86.0%** and one fold falls below the
  13.9% baseline's own recall.
- re-struck on **the ten days MSCI actually priced on** (20–31 July, §2.25) rather than our 28 August
  close, the fitted model catches **29 of 33 instead of 32** — a systematic four-to-six-week drift
  that recurs every quarter. **What ships loses one: 27 at 28 August, 26 on MSCI's window**, because
  a rank-derived cutoff re-prices with the companies it is compared against and a rupee band cannot.
  verify-data 50 asserts that invariance and is proved by moving one segment's share counts alone.

**The separation statistic does not carry the argument either, and it was nearly quoted as if it
did.** Over the 18 exits full market cap does score better than free float — AUC 0.919 against 0.899
— but on 18 positives that difference is +0.019 with a bootstrap 95% interval of **[−0.015, +0.054]**,
and on the 12 entries the sign reverses (0.912 against 0.923). What settles the question is that MSCI
publishes the basis, not that our sample prefers it.

#### What it scores, and why that figure is not a track record

**138 flagged, 27 right, of 33 movers — 19.6% precision, 81.8% recall**, against 166/23 = 13.9% /
69.7% as forecast. Both figures are computed by `build-rebalance.mjs` from the frozen snapshot and
live in `rebalance-2026-08.json`; neither is typed anywhere (§2.5).

**It is in-sample.** No threshold was fitted — every ratio is MSCI's, every cutoff is a constituent
count — but the *decision* to use MSCI's geometry was taken after reading the result. A model scored
on the review that motivated it is answering a question it has already seen. The page says so, the
file says so, and verify-ui 55 fails if either stops saying it. §2.13 is unchanged: one review is one
data point, and there is still no probability anywhere in this product.

**Three movers it would still miss**, and they are named on the page: Embassy Developments, below the
entry buffer; Laurus Labs, 0.7% short of the 1.5× migration bar; and Nippon Life India AMC — which
did not shrink but grew out of Small Cap, and reads as an exit only because the fund that would have
received it does not hold it.

> ### ⚠ ONE MSCI RATIO DOES NOT SURVIVE OUR CUTOFF, AND IT IS THE FREE-FLOAT MINIMUM
>
> MSCI asks a new constituent for free float of at least 50% of the size-segment cutoff (p. 30). The
> ratio is fine. The cutoff it scales is ours, and it sits **1.41× above MSCI's own published range**
> — so half of it is a bar 40% too high, and on the entry side that bites.
>
> Measured: it removed 22 of the 77 candidates clearing the IMI cutoff, and **three of the 22
> entered** (Clean Max, Amagi Media Labs, WeWork India). 13.6% of what it discarded went on to
> enter, against 11.7% of the pool it filtered — **it is anti-selective**, throwing candidates away
> at a higher rate than the ones it keeps. Gating on it cost 3 of 33 movers and bought 0.8 pp of
> precision.
>
> So it is recorded on every row and decides nothing, on the DESK_BAND_ROLE pattern. **The exit side
> keeps its free-float test**, and that is not inconsistency: there the bar is 2/3 × 50% of the same
> cutoff — low enough to still work as a floor — and it earns 4 of the 18 exits. Same ratio, same
> bias, different distance from the thing being measured.

#### The ceiling this does not break

**Inclusion cannot be fixed by a threshold, and the reason is arithmetic.** 642 companies sat outside
the index and 12 entered — a base rate of 1.9%. No size cut gets entry precision above about 15%,
because MSCI's own rule (p. 44) is that a company above the entry buffer is added *"only to the
extent that they replace current constituents which have fallen below the Small Cap Lower Buffer"*.
Clearing the bar makes a company **eligible**, and the number of slots is roughly the number of
exits. An inclusion verdict here is a candidacy and the vocabulary must keep saying so.

**Listing age is real and was not shipped.** Entry rate by age on the August record: 0–0.5y 4.4%,
0.5–1y **10.4%**, 1–2y 1.9%, 2–5y 0.0%, 5–10y 2.6%, 10y+ **0.8%** — a 13× lift, from a genuine
measured date (`DATE OF LISTING` in `nsearchives.nseindia.com/content/equities/EQUITY_L.csv`, which
answers from a datacentre IP where the main NSE API does not, 94.9% coverage of our universe). It
was left out because 4 of the 12 entrants are long-listed — Embassy Developments at 19.4 years, Adani
Energy at 11.0 — so gating on it buys precision by losing movers. It is the best-supported thing not
in the model.

### 2.34 A check may not assert what the MARKET did — that is how a suite takes the pipeline hostage

The daily refresh committed nothing for **four consecutive trading days** — 31 Aug to 3 Sep 2026 —
while fetching a correct bhavcopy every one of them. The scheduled runs fired on time, BSE served
real CSVs, `build-companies.mjs` exited 0, and then `verify-data.mjs` went red and the commit step,
gated on it, was skipped. A complete, correct record was built and thrown away, daily.

Nothing was wrong with the data. **What went red were checks whose subject was the market.**

| Check | What it demanded | Why it could not hold |
| --- | --- | --- |
| verify-data 27 | the segment band adjustment *actually fired* | §2.24 says it must NOT fire below `minMovePct`; three sessions after a review the segment had moved −0.43% |
| verify-data 39 | the geometric and arithmetic deltas *differ by >1 pp* | they differ by about `stock × index`, which over three sessions is 0.078 pp |
| verify-ui 46 | the subtraction is *visibly* wrong on screen | at one decimal it is not — the gap is below the rounding the cells already carry |
| verify-ui 51 | *both* chip directions are on screen, more than five | a chip fires only on a notable reading; three days in there was exactly one |

Every one of them passes for most of a quarter and fails for the weeks after a review, because the
window since the last rebalance is short and small returns behave differently from large ones. They
were all written while looking at a long window and they all encoded *that window's shape* as an
invariant.

**The rule.** An assertion must be about the code, the arithmetic or the contract — never about what
the numbers happened to be. Where a check needs the data to be discriminating in order to mean
anything, the requirement is not "the data is spread out"; it is one of:

- **derive the expectation from the same input the rule reads.** Check 27 now asserts the adjustment
  fired **if and only if** a segment cleared `minMovePct`, and reports the measured move either way.
- **assert against the check's own tolerance, not against a market-sized number.** Check 39 now asks
  whether any row separates the two formulas by more than the tolerance it compares with — true at
  any window length — instead of demanding a 1 pp spread.
- **assert the invariant unconditionally and report the discrimination.** Check 46 asserts every
  rendered delta is the geometric relative of its own legs at any window, and *states* when the
  window is too short for the subtraction to be distinguishable at the rendered precision — with
  verify-data 39 carrying that burden on the unrounded values.
- **assert over whatever exists, and name what is therefore untested.** Check 51 asserts the ramp on
  every chip on screen, requires both directions only when both occur, and reports "the rose/down
  half of the ramp is UNTESTED on this record" when it cannot.

> ### ⚠ And a sabotage inherits the same problem
>
> Check 46's sabotage rendered the arithmetic difference — which, on a window where the two agree to
> the rendered precision, changes nothing at all. `--prove` would then have reported CANNOT FAIL,
> correctly. A sabotage has to break the invariant the check actually asserts, at any window: it now
> offsets the delta by a point, and the subtraction instance is proved in verify-data 39 where the
> two are separable on 474 rows.

**The suite that watches main cannot see this class of failure.** `verify.yml` runs the same
assertions against the **committed** record — whose `lastReview` was still May and whose continuity
block was a real comparison — so exactly the checks that fail on fresh data pass on stale data. Main
was green through the entire outage. A red daily refresh for two consecutive trading days is the only
signal that a pipeline has stopped, and it is worth alerting on for that reason.

### 2.35 FTSE is a SECOND OPINION, and it is wired so it cannot become an input

The desk asked for FTSE's India book beside MSCI's, on the same rows and columns. It is there —
Vanguard's FTSE Emerging Markets All Cap book, 651 India holdings, 16.173% of the fund — and it
**feeds nothing**.

That is not fastidiousness. Every verdict here is MSCI's question: MSCI's published geometry (§2.25)
applied to cutoffs derived from the number of India names **the MSCI funds** show MSCI holding
(§2.33). FTSE runs a different index, with different constituents, different size rules and a
different review calendar. A FTSE holding folded into that arithmetic would move real verdicts on
the strength of an index the model is not forecasting.

So the wiring is deliberate and checkable:

- the book lands in each company's own **`ftse`** field, and in **`funds`** never — `funds` is what
  `segmentOf` and `assess` read;
- **`held` still means held by an MSCI fund.** A company only FTSE holds is still a candidate, and
  the screen still says `candidate` beside its FTSE chip;
- `verify-data` 57 **sweeps** the book four ways — stripped, zeroed, inflated, and forced onto every
  company — and asserts the verdict multiset does not move at any of them. Its sabotage is the
  mistake a future author actually makes: adding FTSE to `funds` as a fourth fund.

**Nothing sums or ranks across the two.** A FTSE weight is a percent of a different fund, so §3.5
applies to it exactly as it applies between the MSCI funds: there is no arithmetic relating them,
and every weight on screen, in the drill and in the export names its own fund.

> ### ⚠ THE MONEY COLUMN IS CANADIAN DOLLARS AND THE WORKBOOK NEVER SAYS SO
>
> Every figure in Vanguard's export is printed with a bare `$`. The fund is Vanguard **Canada's**
> product — the US one is named "FTSE Emerging Markets ETF", without "All Cap" — and its book is
> struck in CAD. Read as USD, every rupee figure derived from it is **40.65% too large**: §3.8's
> crore-for-rupee error in a different currency, and just as invisible.
>
> It was not inferred from the fund's name. It was **measured**, by taking each holding's implied
> share price (`market value / shares`), converting it, and comparing against the close this project
> already holds for that company on that day:
>
> | read as | median ratio | inside ±1% |
> | --- | --- | --- |
> | USD | 1.4065 (p1 1.4011, p99 1.4125) | **0 of 568** |
> | CAD | 1.0031 (p1 0.9992, p99 1.0073) | **566 of 568** |
>
> 568 unrelated companies agreeing on one constant is what a currency error looks like, and the
> constant was USD/CAD. `assertCurrency` re-runs that comparison on **every build** and refuses to
> write, so a future workbook struck in USD fails loudly instead of inflating the book by two-fifths.
> The rate is `CADINR=X`, fetched alongside `USDINR=X` so it inherits the timezone and duplicate-bar
> guards a currency pair actually trips (§3.8.2) — and it is **never** derived from the workbook
> itself, which would make the check read its threshold from the value under test (§3.8).

> ### ⚠ VANGUARD PUBLISHES NO ISIN, SO THE PRICE IS THE ARBITER
>
> The workbook offers a house ticker and a name, and both lie in their own way. The ticker is not an
> NSE symbol — `HDFCB` for HDFCBANK, `INFO` for INFY, `MM` for M&M — and worse, **Vanguard's codes
> collide with real listings belonging to other companies**. Its `SOTL` is Sterlite Technologies;
> `SOTL` on NSE is **Savita Oil Technologies**, a different listed company that a symbol-keyed
> resolver matches perfectly happily. The name is usually right, sometimes truncated
> (`Shaily Engineering Plastics Lt`), and sometimes absent entirely, replaced by a Bloomberg stub
> (`New Issuer: BB Company ID:183206`) on 6 of the 651 rows.
>
> So nothing resolves on a proposal alone. `market value / shares` is a share price the workbook
> never states and cannot fake; converted at the holdings-date rate it must equal our own close for
> that company on that day — a figure from BSE, fetched by another script, for a date the workbook
> fixed rather than we did. On the Sterlite collision the name reads **1.0047** and the ticker
> **0.9299**, so the gate picks the right company on evidence rather than on a rule about which field
> to trust. A symbol-only match without a passing price check is **refused**; a name match, being
> unique-or-nothing, may stand where no close exists. `verify-data` 58 proves both.
>
> Measured: **638 of 651 resolved, 99.4% of the India weight**, zero ISIN collisions. The 13 left
> over keep their weight and each states its reason (§2.3) — including `Gujarat Energy Ltd`, whose
> only name match the price gate **rejected** at a ratio of 0.548.

**And the book is the oldest input on the record, which is allowed to govern.** Vanguard publishes
monthly, so it is struck weeks before the iShares workbooks and adding it moves the headline
freshness claim *backwards*. That is the right direction: §2.10's rule is that the oldest input
governs, and the failure it guards is claiming more currency than the record has. A feed exempted
from that claim is how an overclaim creeps back in, one carve-out at a time. Every FTSE cell carries
its own as-of, and the sources modal lists each feed separately, so nothing is hidden by being
conservative.

**One row of it is §2.20 arriving in somebody else's data.** Vanguard publishes Genus Prime Infra at
`0.00%` on a live position of $1,771.94. Printing that as `0.000%` would say *not held*, which is the
one thing it must never say — so the cell renders a below-precision marker and the market value
carries the figure that survived the rounding.

## 3. Facts about the data that will cost you an hour if you rediscover them

### 3.1 The iShares `.xls` files are not `.xls` files

They are **SpreadsheetML 2003** — plain UTF-8 XML with CRLF line endings, opening with
`<?mso-application progid="Excel.Sheet"?>` under the namespace
`urn:schemas-microsoft-com:office:spreadsheet`. They are not binary BIFF and not CSV.

`scripts/lib/spreadsheetml.mjs` is the only place in the repo that knows the format. Do not add a
parsing library; do not open them as binary.

**And the Vanguard FTSE workbook is the opposite case — a REAL `.xlsx`.** It is OOXML: a ZIP of XML
parts where a cell usually holds an index into a shared-string table rather than its own text.
`scripts/lib/xlsx.mjs` reads that one, with no dependency (Node's `zlib` inflates it). **The two
readers are not interchangeable and neither can read the other's files.** Pick by the actual format,
never by the extension — the iShares files are named `.xls` and are not, and that is the whole point
of this section.

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

> ### ⚠ `segment=Equity` silently excludes every REIT and InvIT
>
> `ListofScripData?segment=Equity&status=Active` returns 4,975 scrips and **not one of BSE's 27
> `GROUP=IF` scrips** — Embassy Office Parks, Mindspace, Nexus Select, Brookfield India, IndiGrid,
> IRB InvIT, PowerGrid InvIT, Knowledge Realty and the rest. All 27 are Active. **BSE publishes
> `MktCapFull` and `MktCapFF` for every one of them**, and confirms each ISIN through `ComHeader`.
>
> Fetching the master through that filter is why 22 companies above the desk's floor carried no
> free-float reading at all, four of them **held by the funds**. Nothing was broken; nothing was
> asking.
>
> The distinction is `GROUP`, **not** the row's own `Segment` field — IndiGrid's `Segment` reads
> `"Equity"` exactly like Reliance's. Only `GROUP` separates `IF` from `A`/`B`/`X`.
>
> Measured behaviour of the `segment` parameter, `status=Active`:
>
> | `segment=` | rows |
> | --- | --- |
> | `Equity` | 4,975 |
> | `ETF` | 264 |
> | *empty* | 0 |
> | **anything else** | **12,685 — the complete set** |
>
> So BSE recognises two filters and **falls through to everything for a value it does not know**.
> That is a trap in both directions: a typo silently widens the universe, and a release that starts
> honouring the value would silently narrow it. `SCRIP_MASTER_ALL_URL` therefore uses an obviously
> fake sentinel (`ALL_SEGMENTS`) and `fetch-bse-master.mjs` **asserts the wide response is a strict
> superset of the equity one**, so a change in BSE's behaviour fails loudly instead of quietly
> costing 12,000 scrips.

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

> ### ⚠ THE OBVIOUS GUARD FOR A NARROWED BASELINE SET CANNOT FAIL
>
> `price-history.json` derives which rebalances to capture from
> `closedReviews(prices.tradeDate)`, so a stale price anchor quietly narrows the set and the run
> reports success over a set missing the very rebalance the screen should be baselined on. That is
> the 1 Sep 2026 state: the monthly job ran and passed while prices were frozen at 28 Aug, so the
> August review — effective 31 Aug, closed by then — was never captured.
>
> Asking *inside that script* whether `closedReviews(prices.tradeDate, 1)[0]` is among the captured
> baselines is **§3.8's self-defeating guard**: both sides come from the same anchor, so the answer is
> yes by construction. Measured on anchor 2026-08-28 — captured `{2026-05, 2026-02, 2025-11,
> 2025-08}`, newest closed `2026-05`, guard silent while August is missing. It was written that way
> here first, and an adversarial review of the fix is what caught it.
>
> Two guards replace it, each anchored on something the failure cannot move. The fetcher refuses to
> **lose a baseline the previous capture held** — the shrink rule every other writer here follows.
> And verify-data 56 asks the question across **two files written by different scripts**: the newest
> review the committed closes have passed must be among the baselines the record carries. That one
> fires exactly when `price-history.json` falls behind `prices.json`, and its sabotage is to drop the
> newest baseline.

> ### ⚠ A REASON THAT IS COMPUTED BUT NOT WRITTEN IS A REASON THAT DOES NOT EXIST
>
> Continuity cannot hold across a gap: if the stored file is 28 Aug and this one is 3 Sep, today's
> previous-close is 2 Sep's close and comparing it to 28 Aug's fails for essentially every scrip that
> moved. So the fetcher SKIPS the check across a gap and records why — and verify-data 18 accepts a
> stated reason in place of a comparison, precisely so that a hole in our own record is not reported
> as corruption in BSE's data.
>
> The writer dropped the reason. It named four fields — `against`, `compared`, `failures`, and the
> renamed `skipped` — and every other field the continuity logic computes went on the floor, including
> `skippedReason`, `gapDays` and `carriedForwardFrom`. So the escape hatch could not be satisfied by
> any input, and **one missed session locked the record permanently**: no comparison possible, no
> reason on disk, check 18 red, commit skipped, gap still there tomorrow.
>
> A fix in three layers — compute the reason, write it, accept it — shipped with the middle layer
> missing, and each end tested only itself. The serialisation is now one pure function
> (`continuityRecord` in `scripts/lib/bhavcopy.mjs`) with one caller, and verify-data 54 asserts the
> round trip with the four-key whitelist as its sabotage.
>
> **Recovery is sequential, never a jump.** `latestTradeDate()` never consults the stored file, so a
> catch-up run fetches only the newest session and leaves the intervening closes missing. Fetching
> `--date` for each missing session in order keeps every pair adjacent, so the tripwire actually runs:
> 31 Aug, 1, 2 and 3 Sep 2026 were repaired that way — 1,229 / 1,229 / 1,231 / 1,229 scrips compared,
> **zero failures** at every step.

> ### ⚠ A file-level date check cannot see a stale row
>
> A file whose `TradDt` is today can still carry a row copied from yesterday. The row-level tripwire
> is **continuity**: today's `PrvsClsgPric` must equal yesterday's `ClsPric`, per scrip. Measured
> 18→19 Aug 2026: **4,562 compared, 0 failures** — a sharp tripwire, not a noisy one. That figure
> came from comparing two complete bhavcopy files, which are **not committed**; what is reproducible
> here is `prices.json → continuity`, which records the same check over the 1,199-company universe
> the pipeline tracks: **1,195 compared, 0 failures**.
>
> Note the true-negative shape: 53 scrips carried byte-identical open/high/low/close across both days.
> Those are bonds and illiquid lines that genuinely did not trade, and they **pass** continuity. An
> unchanged close is not a stale row.

> ### ⚠ `/stock-data/batch` currently answers UNAUTHENTICATED
>
> Measured: `POST https://fastapi.muns.io/stock-data/batch` returns HTTP 200 with real prices and
> **no `Authorization` header at all**, and it accepts an obviously-invalid bearer token without
> complaint. The client's quote data is publicly readable by anyone who knows the URL, and that is
> worth telling them.
>
> The Worker still sends the token and still refuses to run without `MUNS_TOKEN`. Making the token
> optional by accident would turn the day it *starts* being enforced into what looks like an outage.
> (`/sql/*` is properly protected — 403 `Not authenticated` without a token.)

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

### 3.8.1 BSE does NOT adjust `PrvsClsgPric` across a corporate action

LICI closed at **829.90** on 27 May 2026 and at **411.45** on the 29th. Nothing was lost: it went
ex-bonus 1:1. Read as a raw price series that is −50.4%, and it sorts, ranks and corroborates a
migration-down verdict perfectly happily. Seven such events fall inside the May→August 2026 quarter
alone (LICI, TRENT, ANANDRATHI, ZFCVINDIA, CUB, BRIGADE, JLHL).

> ### ⚠ The obvious detector is backwards, and it fails silently
>
> It is tempting to infer actions from the bhavcopy itself: *if the exchange adjusts the previous
> close across an action, a disagreement with the prior session's raw close **is** the action* —
> free, for every scrip, with no extra feed.
>
> **BSE carries `PrvsClsgPric` unadjusted.** LICI's `PrvsClsgPric` on its own ex-date is 829.90,
> exactly the raw close of the session before. Continuity therefore *holds* across a bonus and the
> event is invisible to it. That detector found **0 actions across 303,018 comparisons** in a
> quarter known to contain seven, and only a positive control — *a detector that finds nothing is
> indistinguishable from a broken one* — stopped it being written.
>
> Nor is it rescuable from prices alone: with `PrvsClsgPric` raw, a 1:1 bonus and a genuine 50%
> crash are the same two numbers. A ratio-near-a-simple-fraction heuristic would flag real crashes
> and miss small bonuses.

Actions come from BSE's own published history —
`api.bseindia.com/BseIndiaAPI/api/DefaultData/w?scripcode=N`, one request per scrip, ~4 minutes for
the universe. It answers for **1,237 of 1,237** scrips against `quote-stats`'s 749, returns **every**
event rather than the most recent one, and uses the right noun: LICI is a **1:1 bonus**, not the
"2:1 split" `quote-stats` calls it. The two agree exactly on all seven of the quarter's events.

`priceFactor` is **ours** — the number a price is *divided* by across the ex-date — and a purpose
naming something structural without a published ratio (`Right Issue of Equity Shares`, `Spin Off`,
`Consolidation of Shares`) is `null`, **never `1.0`**. A factor of 1 asserts the action does not move
the price, which is a claim; `null` says we did not read it. **A purpose we have never seen fails the
run**, because a new wording could be a bonus we fail to match and it would pass through as a clean
return — that guard caught four wordings a 300-scrip vocabulary probe had missed.

### 3.8.2 Yahoo stamps a bar in the exchange's timezone, not in UTC

`meta.gmtoffset` is the difference and it is not decorative. USDINR=X is carried on `CCY`, timezone
Europe/London, stamped at **local midnight** — so under BST, seven months of every year, Monday
24 Aug 2026 sits at `2026-08-23T23:00Z` and a UTC date label calls it **Sunday the 23rd**. The NYSE
and Cboe funds are stamped at 09:30 local = 13:30 UTC and are unaffected, which is exactly why the
bug hid.

The committed file wore the signature in plain sight for a week:

```
FX weekday tally   Mon 104  Tue 105  Wed 104  Thu 101  Fri 45  SUN 59
```

The label was not the damage. **57 of EEM's 502 trading dates then had no exact FX point**, so
`rateOn` walked back and priced them with the *previous* day's rate — breaking the one promise the
rupee conversion rests on, that both halves of each product come from the same date. Nothing looked
wrong; every return was slightly false. Corrected, EEMS's since-last-review return moved from
−4.141% to −1.654%.

`assertSeriesDates` in `benchmarks.js` catches it, and **its threshold is the calendar** — no
exchange here trades at a weekend, and across two years of daily bars the five weekdays must appear
in roughly equal numbers. A whole-day shift cannot satisfy either test in either direction.

> ### ⚠ Counting points is the wrong shrink guard for a rolling window
>
> `range=2y` means two years back from *today*, so the start of every series walks forward and the
> count drifts a point either way forever on good data. The original guard compared raw totals and
> went red at 1,506 against 1,503 on the very run that fixed the FX. **A guard waived weekly is a
> guard nobody reads.** It now asks the only question that matters — *of the dates we already held
> inside this run's own span, how many came back* — anchored on the previous file, which the run
> cannot move. It caught precisely the 59 phantom Sundays and nothing else.

> ### ⚠ Yahoo serves TWO bars for the current session, and they carry the same date
>
> Timestamps are unique; the dates they map to are not. Yahoo appends a **live bar** for the session
> in progress beside that session's daily bar, and after the timezone shift above both land on the
> same date label. The committed file carried `USDINR=X` twice on **2026-08-28 — 95.4704 and
> 95.3600**, 0.12% apart, and nothing said so.
>
> That is not cosmetic, because every consumer builds a `Map` from the series: whichever bar came
> last **silently won**, and there was no way to see which. RELIANCE's index leg read 1.328% against
> the 1.445% a reader recomputing it by hand from the same file would get. Same family as the
> timezone bug — a well-formed number about something slightly else.
>
> The parser now collapses duplicates keeping the later bar (which is what `seriesToMap` was already
> doing by accident) and **counts the collapses**, and `assertSeriesDates` fails on any duplicate
> date, so a regression is loud instead of a tenth of a percent on every rupee return.
> `verify-data` assertion 41 is proved by pushing exactly that second bar back in.

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

> ### ⚠ The `scrip_id`-as-NSE-symbol question has an answer, and the name test is the wrong test
>
> 452 companies carry a BSE `scrip_id` that *looks* like an NSE symbol but have no entry in the
> 750-name `nse-universe.json`, so `nseSymbol` is `null` for them. Munshot answers per-symbol and
> was used as an independent third source. **Two runs disagreed, and the disagreement is the
> lesson.**
>
> Run 1 tested "does Munshot's company name match BSE's, exactly after normalisation" and reported
> 71 verified / 26 mismatched / 60 upstream failures out of 157. Run 2 replayed the same
> deterministic candidate order and got 109 / 46 / **0** out of 155. Inspecting the 46:
>
> - **43 returned `Company Name: "N/A"`** — no name at all. The test scored "missing name" as
>   "wrong company".
> - **3 were `&` versus `and`** — *Kovai Medical Center **&** Hospital Ltd* against *Kovai Medical
>   Center **and** Hospital Limited*, and two more of the same shape. The normaliser strips
>   `LIMITED`/`LTD`/`COMPANY` but never mapped `&` → `AND`.
>
> **Not one of the 46 was a different company.** The mismatch rate measured the normaliser. And run
> 1's 60 "failures" were the `not_found`-under-load trap wearing a different hat — they all resolved
> on the replay.
>
> The response carries the answer directly. `Exchange` is `NSI` — Yahoo's NSE code — with a live
> non-zero price for every candidate checked, against a `RELIANCE` control that reads the same. Three
> deliberately impossible symbols (`ZZQXNOTREAL`, `XKCDFAKE1`, `QQZZWWVV`) all returned **HTTP 404**,
> so the endpoint is a genuine existence test and not a fuzzy matcher. `NSDL` is the counter-example
> that proves the discriminator: `Exchange: "N/A"`, price `0` — served, but not confirmed listed.
>
> **So the test is `Exchange === 'NSI'` AND a non-zero price — never the name.** Nothing was written
> into the data from a partial 155-of-452 pass: `nseSymbol` is asserted from `nse-universe.json` on
> ISIN and nowhere else (above), and a second, weaker provenance smuggled into the same field would
> be invisible to every reader of it. A future run that wants these must cover all 452 and land them
> in a **separate field carrying its own provenance**.

---

---

## 4. Repository layout

```
CLAUDE.md                          this contract
docs/DATA-CONTRACTS.md             every JSON shape, unit, source and cadence
docs/MSCI-METHODOLOGY.md           what MSCI actually does, and where our model differs
scripts/
  lib/csv.mjs                      RFC 4180 reader; read by header NAME, never index
  lib/spreadsheetml.mjs            SpreadsheetML 2003 reader, zero dependencies
  lib/report.mjs                   console tables, number formatting, check lists
  lib/assert.mjs                   the verification harness: check / skip / prove
  lib/bse.mjs                      BSE client + the ₹-crore string parser
  lib/resolve.mjs                  ticker → ISIN → NSE symbol + BSE scrip code
  lib/bhavcopy.mjs                 EOD CSV parse + shape and continuity tripwires
  lib/xlsx.mjs                     OOXML .xlsx reader (ZIP + XML), zero dependencies
  lib/yahoo.mjs                    one Yahoo daily-close reader, shared by both FX fetchers
  lib/ftse-resolve.mjs             FTSE holdings → ISIN, arbitrated by an implied price; pure
  lib/munshot.mjs                  Munshot batch client + rawQuote parser, pure
  lib/recompute.mjs                free-float recompute, passive drift, flow primitives
  import-universe.mjs              Screener seed → public/data/universe.json
  fetch-fund-benchmarks.mjs        SMIN/EEMS/EEM + USDINR → public/data/fund-benchmarks.json
  import-ishares.mjs               3 workbooks → public/data/msci-funds.json
  import-ftse.mjs                  Vanguard FTSE EM workbook → public/data/ftse-funds.json
  scrape-nse-freefloat.mjs         NSE pre-open → public/data/nse-freefloat.json
  scrape-nse-asm.mjs               NSE ASM report → public/data/nse-asm.json
  fetch-bse-master.mjs             BSE scrip master → public/data/bse-scrip-master.json
  fetch-nse-universe.mjs           niftyindices CSVs → public/data/nse-universe.json
  scrape-bse-freefloat.mjs         per-scrip BSE float → public/data/bse-freefloat.json
  fetch-bhavcopy.mjs               BSE EOD prices → public/data/prices.json
  fetch-quote-stats.mjs            monthly ADV / splits → public/data/quote-stats.json
  fetch-fund-benchmarks.mjs        Yahoo daily closes → public/data/fund-benchmarks.json
  fetch-price-history.mjs          two MSCI price windows + four rebalance baselines
                                   -> public/data/price-history.json
  fetch-corporate-actions.mjs      BSE's own action history → public/data/corporate-actions.json
  build-companies.mjs              everything → public/data/companies.json
  snapshot-predictions.mjs         FREEZE the forecast before a review lands
                                   -> public/data/predictions-<review>.json
  build-rebalance.mjs              frozen forecast vs the outcome
                                   -> public/data/rebalance-<review>.json
  verify-data.mjs                  58 data assertions; no browser, no network
  verify-ui.mjs                    39 interface assertions; the served site
  check-naive-join.mjs             the pre-resolver baseline; writes nothing
  probe-liveness.mjs               is the quote feed live? reports, writes nothing
  probe-chunk-size.mjs             largest safe upstream batch; reports only
  fixtures/ishares-{eem,smin,eems}.xls    the committed input workbooks
  fixtures/screener-universe.csv          the desk's >₹2,000 Cr seed list
  fixtures/vanguard-ftse-em-allcap.xlsx   the FTSE EM holdings book (struck in CAD)
  fixtures/bhavcopy-spa-shell.html       BSE's SPA shell, served with HTTP 200
  fixtures/bhavcopy-sample-2026081{8,9}.csv  two real days, for continuity
  fixtures/munshot-rawquote-reliance.txt     one captured detail quote
public/
  index.html                       placeholder; the interface is a later prompt
  js/config/thresholds.mjs         EVERY desk threshold, and nowhere else
  js/config/msci-methodology.mjs   MSCI's published rules, cited to a page
  js/model/gimi.js                 the second methodology: MSCI's procedure, our universe
  data/universe.json               generated — the desk's tracked universe seed
  data/fund-benchmarks.json        generated — daily fund closes + FX, for the band adjustment
  data/msci-funds.json             generated — do not hand-edit
  data/ftse-funds.json             generated — the FTSE second opinion; do not hand-edit
  data/ftse-fx.json                generated — INR per CAD, for the FTSE book
  data/nse-freefloat.json          generated — do not hand-edit
  data/nse-asm.json                generated — NSE Additional Surveillance Measure list; do not hand-edit
  data/bse-scrip-master.json       generated — do not hand-edit
  data/nse-universe.json           generated — do not hand-edit
  data/bse-freefloat.json          generated — do not hand-edit
  data/prices.json                 generated — the committed EOD price floor
  data/quote-stats.json            generated — monthly ADV, splits
  data/share-reconciliation.json   generated — share-count outliers and quarantines
  data/price-history.json          generated — every close in the two MSCI price windows
                                   AND around each of the last four rebalance dates
  data/relative-baselines.json     generated — the non-default rebalance baselines,
                                   fetched by the browser only on demand
  data/corporate-actions.json      generated — BSE's published bonuses, splits, rights
  data/companies.json              generated — the record the interface reads
  data/predictions-2026-08.json    generated ONCE, before the August review took
                                   effect. Never regenerated: see 2.32
  data/rebalance-2026-08.json      generated — what the review did, and how the
                                   frozen forecast fared against it
  js/model/thresholds.js           desk bands + the observed boundary, both labelled
  js/model/segments.js             constituent → segment; disjointness re-checked
  js/model/assess.js               the rules engine → verdict + rulesFired
  js/model/flows.js                price a trade-implying verdict, and only those
  js/model/relative.js             review-window AND since-rebalance relative performance,
                                   the trend signal and flow pressure
  js/model/calendar.js             review dates (assumed, configurable)
  js/core/live.js                  visibility-aware poller
  js/core/range.js                 a typed min–max range, validated before it is converted
  js/data/quotes.js                live overlay; memory only, never written back
  js/data/rebalance.js             the single reader of rebalance-<review>.json
  js/tabs/rebalance.js             the Latest Rebalance view — the one screen
                                   that marks its own homework
worker/
  index.js                         static assets + POST /api/quotes
  http.mjs                         ETag / 304 / CORS / cache-state helpers
wrangler.jsonc                     Worker config; npx-only, no node_modules here
.github/workflows/
  daily-refresh.yml                weekdays 20:00 IST — EVERY source → verify → commit
  weekly-nse-crosscheck.yml        Saturdays 09:30 IST — NSE with 3 patient retries
  monthly-float.yml                1st of month — Munshot ADV/splits only
  verify.yml                       every push — both suites, both modes
```

Every JSON file under `public/data/` is a **generated artefact that is committed**, so the static
site works with no build and no network. Never hand-edit them; change the script and re-run.

`companies.json` is the join of all the others and the only one the interface should read.

---

## 5. Running things

Refresh order — later scripts read what earlier ones write:

```bash
node scripts/import-ishares.mjs        # workbooks; no network
node scripts/import-ftse.mjs           # the Vanguard FTSE EM workbook; no network
node scripts/import-universe.mjs       # the desk's >Rs2,000 Cr seed list; no network
node scripts/fetch-bse-master.mjs      # 1 request, ~1.7 MB
node scripts/fetch-nse-universe.mjs    # 2 requests, the ISIN bridge
node scripts/scrape-nse-freefloat.mjs  # 4 requests, ~250 symbols - THROTTLES, see below
node scripts/scrape-nse-asm.mjs        # 1 request, the NSE ASM list - THROTTLES like every NSE feed
node scripts/scrape-bse-freefloat.mjs  # ~3,600 requests, ~12 min at concurrency 8
node scripts/fetch-fund-benchmarks.mjs # 5 requests, 2y of daily closes + USDINR
node scripts/fetch-ftse-fx.mjs         # 1 request, INR per CAD for the FTSE book
node scripts/fetch-bhavcopy.mjs        # 1 request, the whole market's closes
node scripts/fetch-quote-stats.mjs     # monthly ADV/splits; --concurrency 1 --gap-ms 1200
node scripts/reconcile-shares.mjs      # share-count outliers -> quarantine list
node scripts/fetch-corporate-actions.mjs  # ~1,240 requests, ~4 min - BEFORE price history
node scripts/fetch-price-history.mjs   # 37 requests: both MSCI price windows + the rebalance baselines
node scripts/build-companies.mjs       # no network; joins everything

# BEFORE refreshing the workbooks for a review that is about to take effect:
node scripts/snapshot-predictions.mjs --review=2026-11   # freeze the forecast
# ...then drop in the fresh .xls files, re-measure EXPECTED, rerun the pipeline:
node scripts/build-rebalance.mjs --review=2026-11        # score it
node scripts/verify-data.mjs           # the data assertions; run before committing

node scripts/check-naive-join.mjs      # the pre-resolver baseline; reads only

node scripts/verify-data.mjs           # 58 assertions; no browser, no network
node scripts/verify-data.mjs --prove   # …and break each one to prove it can fail
node scripts/verify-ui.mjs             # 39 assertions vs http://127.0.0.1:8080
node scripts/verify-ui.mjs http://127.0.0.1:8787 --require-live   # vs wrangler dev
node scripts/verify-data.mjs --only=14,21   # while iterating; the summary says FILTERED

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

### The cadence, and why NSE is allowed to fail

Everything above is re-read **every trading day** by `daily-refresh.yml`. Measured end to end on
20 Aug 2026: universe import 0.2 s, BSE master 5.5 s, NSE universe 22.8 s, BSE float ~12 min at
concurrency 8, bhavcopy ~2 s, build ~4 s. That is comfortably inside one CI job, which is why the
desk's fallback plan — recompute from prices daily, re-read sources only weekly — was not needed.

**NSE is the exception and its steps are `continue-on-error`.** NSE's edge refuses a datacentre IP
unpredictably: a paired trial answered **5 of 8** identical curl requests, and the first full
pipeline run died at `FO  HTTP 403 after 6 retries`. That is survivable because the float factor is
nearly static — **814 of 1,199 companies were byte-identical day over day, 1,194 moved less than
0.1%, median movement 0.000000%** — and because `scrape-nse-freefloat.mjs` refuses to replace a good
snapshot with a partial read, so a throttled day leaves the last good file in place.

It is not survivable indefinitely, because the desk's rule uses NSE's factor wherever the two
exchanges differ by more than 2%. `weekly-nse-crosscheck.yml` therefore retries three times, ten
minutes apart, every Saturday, and **fails loudly** if none gets through.

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
| India Small-Cap | 458 of 461 | 3 |
| EM Small-Cap | 412 of 414 | 2 |

Method histogram across all 1,040 holding rows: `scrip_id` 996, `scrip_code` 16, `isin` 7, `name` 5,
`confirmed` 11, unresolved 5. **Zero collisions.**

The 5 unresolved rows are not spelling problems and no resolver will fix them:

- ~~**four REITs**~~ — **resolved on 20 Aug 2026.** Embassy Office Parks, Brookfield India, Nexus
  Select and Mindspace sat here with the reason "not in BSE's equity segment and not in NSE's
  free-float set". The first half was true and **the conclusion drawn from it was wrong**: BSE files
  REITs and InvITs under `GROUP=IF`, outside `segment=Equity`, and publishes `MktCapFull` and
  `MktCapFF` for all of them. The master was being fetched through that filter, so nothing ever
  asked. All four are now pinned in `CONFIRMED`, asserted against the master every run, and priced.
  Together they are 2.26% of the India Small-Cap fund.
- **the `--` rows** — GSPL Transmission, Triveni Power Transmission, Inox Renewable Solutions.
  Demerged entities that have not started trading. NSE carries two of them only as placeholders
  (`DUMMYTRVN`, `DUMMYINXGN`, ISINs beginning `DUM`), which are not traded securities.

Every one keeps its row, keeps its weight in every denominator, and carries a stated reason in
`companies.json → unresolved[]`. **Dropping them would quietly redefine the universe as "the ones we
could match"** — the same error class as rendering a missing value as zero.

### The seed list widened the NSE symbol bridge, not the holdings resolution

The fund-holding histogram above is unchanged by the seed: every holding that could be resolved
already was. What the seed changed is how many companies in the **whole record** carry an NSE
symbol at all, which is what decides whether NSE can even be asked for a free-float reading:

| ISIN → NSE symbol asserted from | Companies |
| --- | --- |
| `nse-universe.json` (niftyindices index membership) | 500 |
| the desk's seed list | 717 |
| neither — no NSE symbol | 32 |

**1,217 of 1,249**, against 749 before. `nse-universe.json` only knows the names its two index lists
contain, and the seed names an NSE code for essentially every company on the desk's screen.

Both sources are consulted, `nse-universe` first, and `nseSymbolSource` records which answered.
**Where both name a symbol for one ISIN they must agree or the build stops** — a disagreement means
one file has the wrong company on that ISIN, and every float reading keyed on that symbol would
belong to somebody else. Nothing downstream could see it, so it is a build-stopping check rather
than a warning.

### The pre-resolver baseline, kept on the record

`node scripts/check-naive-join.mjs` still measures the naive `iShares ticker === NSE symbol` join
against the NSE free-float set alone, with no resolver and no BSE: **152 of 165, 36 of 461, 36 of
414**, covering 96.0% / 21.0% / 20.8% of each fund's India weight. That script writes nothing and
exists so any claimed improvement can be checked against the unimproved figure.

The lesson it recorded is worth keeping: the small-cap gap was **never a ticker problem**. Case and
punctuation normalisation alone recovered one ticker per small-cap fund. The gap was the source —
NSE's pre-open API covers 261 names — and it closed by adding BSE, not by matching harder.
