# Data contracts

Every JSON shape this project produces or consumes: its fields, units, source tier, cadence and
failure states. If a field is not described here, it does not exist yet.

Read `CLAUDE.md` §2 first. The tier labels used throughout this document are defined there:

- **Tier 1 — measured, reproduced.** Somebody else's published figure, carried unchanged.
- **Tier 2 — derived by us.** Arithmetic we performed on tier-1 inputs. Formula stated.
- **Tier 3 — modelled judgement.** An opinion produced by rules we wrote. None yet.

**Missing is `null`.** Never `0`, never `""`, never `"-"`. A `null` means *there is no reading* and
must be excluded from every total, average and denominator downstream.

---

## `public/data/msci-funds.json`

The India equity slice of three iShares ETFs, plus the fund-level figures needed to turn a weight
change into a dollar flow.

| | |
| --- | --- |
| **Produced by** | `node scripts/import-ishares.mjs` |
| **Input** | `scripts/fixtures/ishares-{eem,smin,eems}.xls` (committed) |
| **Upstream source** | BlackRock / iShares fund-holdings downloads |
| **Tier** | 1 throughout — every value is BlackRock's, reproduced unchanged. Nothing here is derived. |
| **Cadence** | On demand, whenever fresh workbooks are committed. iShares publishes daily; the desk cares about month-end and the weeks around each MSCI review. |
| **Committed?** | Yes. The static site must work with no build and no network. |
| **Failure mode** | The importer **refuses to write** and exits 1 if any measured count or weight has drifted from its `EXPECTED` table. A stale file is left in place rather than replaced with a wrong one. |

### Top level

| Field | Type | Meaning |
| --- | --- | --- |
| `source` | string | Human-readable provenance, carried into exports. |
| `importedAt` | ISO 8601 UTC | When **we** ran the import. Not when the holdings were struck — that is `funds[].asOf`. |
| `fixtures` | string[] | The exact input files this run read, repo-relative. |
| `units` | object | Free-text unit notes for the numeric fields, so an export can carry them. |
| `funds` | Fund[] | Exactly three, in the order EM, India Small-Cap, EM Small-Cap. |

### `funds[]`

| Field | Type | Unit / meaning |
| --- | --- | --- |
| `id` | `"eem"` \| `"smin"` \| `"eems"` | Stable key. Use this, never the display name. |
| `name` | string | The fund's own name as printed in its workbook. |
| `shortName` | `"EM"` \| `"India SC"` \| `"EM SC"` | For column headers and chart legends. |
| `asOf` | `YYYY-MM-DD` | The workbook's "Fund Holdings as of" date. **This is the as-of for every holding below.** |
| `inceptionDate` | `YYYY-MM-DD` | From the workbook preamble. |
| `securitiesCount` | integer | The workbook's own "Number of Securities (excluding cash and derivatives)", across all countries — **not** a count of the rows in `holdings`. |
| `sharesOutstanding` | number | ETF shares outstanding. |
| `navPerShare` | number, USD | Latest dated row of the workbook's `Historical` sheet. |
| `navAsOf` | `YYYY-MM-DD` | Date of that NAV row. May differ from `asOf`. |
| `totalMarketValueUsd` | number, USD | **Sum of `Market Value` over EVERY row in the workbook** — all countries, all asset classes. **This is the AUM that flows are computed against.** |
| `indiaMarketValueUsd` | number, USD | Sum over the India equity slice only. Never use this as the flow denominator. |
| `indiaWeightPct` | number, percentage points, 5 dp | Sum of `holdings[].weightPct`. Percent **of this fund**. |
| `indiaEquityCount` | integer | `holdings.length`. Always print it as "X of `securitiesCount`", never bare. |
| `holdings` | Holding[] | India equity rows only. |

`navPerShare × sharesOutstanding` lands within about 1% of `totalMarketValueUsd`. The importer
**prints that residual and does not assert it** — the two are struck at different moments and a small
gap is honest. Measured on the committed fixtures: EM +0.577%, India SC −0.234%, EM SC +0.037%.

### `funds[].holdings[]`

One row per India equity holding, in the workbook's own order (descending weight). Every India equity
row in the file is present; **nothing is dropped**, including rows whose ticker means nothing.

| Field | Type | Unit / meaning |
| --- | --- | --- |
| `ticker` | string | **Verbatim from BlackRock. Not resolved to an NSE symbol.** See `tickerKind`. Not unique — `"--"` repeats. |
| `name` | string | BlackRock's security name. |
| `sector` | string | BlackRock's sector. Note `"Communication"`, not "Communication Services". |
| `exchange` | string | `"National Stock Exchange Of India"` or `"Bse Ltd"`. |
| `weightPct` | number, percentage points | **Percent of THIS fund.** See the warning below. |
| `marketValueUsd` | number, USD | BlackRock's figure. |
| `quantity` | number, shares | BlackRock's figure. |
| `priceUsd` | number, USD/share | BlackRock's figure, rounded to cents at source. |
| `fxRate` | number | Local currency units per USD, as BlackRock reports it. `95.61125` INR/USD in the committed fixtures. |
| `tickerKind` | `"nse"` \| `"bse-code"` \| `"none"` | How the ticker **reads**. Not a resolution — nothing was looked up. |

> **A weight belongs to one fund and one fund only.** `weightPct` is a percentage of the fund it sits
> inside. `HDFCBANK` at 0.683% of the EM ETF and `LAURUSLABS` at 1.830% of the India Small-Cap ETF are
> percentages of different denominators, and no arithmetic relates them. **Never sum, average, rank or
> diff `weightPct` across funds.** Every weight that reaches a screen or an export names its fund.

`tickerKind` values:

| Value | Meaning | Example |
| --- | --- | --- |
| `nse` | Reads like an NSE symbol. May still be a BlackRock house code (`SHFL`, `TMCV`, `ENRIN`, `VAML`) or use different punctuation (`NAM.INDIA` vs NSE's `NAM-INDIA`). Only a resolver can tell, and there is not one yet. | `HDFCBANK`, `M&M` |
| `bse-code` | An all-digit BSE scrip code, not an NSE symbol. These rows carry `exchange: "Bse Ltd"`. | `534091`, `532483` |
| `none` | The file prints `--`: BlackRock has no ticker for this row. In practice, demerged entities that have not started trading. **This row is kept, with `tickerKind` stating why it cannot be matched.** | `TRIVENI POWER TRANSMISSION LIMITED` |

### Measured shape of the committed fixtures

Asserted by the importer; it refuses to write if any of these drift.

| | EM ETF | India Small-Cap | EM Small-Cap |
| --- | --- | --- | --- |
| Fund name | iShares MSCI Emerging Markets ETF | iShares MSCI India Small-Cap ETF | iShares MSCI Emerging Markets Small-Cap ETF |
| Holdings as of | 2026-08-17 | 2026-08-17 | 2026-08-17 |
| Has a `Type` column | yes (15 cols) | no (14 cols) | no (14 cols) |
| Declared securities count | 1,197 | 461 | 1,693 |
| Shares outstanding | 464,850,000 | 10,750,000 | 5,000,000 |
| Total data rows | 1,323 | 466 | 1,725 |
| India rows (all asset classes) | 166 | 462 | 415 |
| **India equity rows** | **165** | **461** | **414** |
| India equity weight sum (3 dp) | **11.315** | **99.729** | **21.271** |
| — on NSE | 163 | 454 | 407 |
| — on BSE | 2 | 7 | 7 |
| — ticker `--` | 0 | 3 | 2 |

The NSE/BSE split is by the `Exchange` column and accounts for every India equity row. The `--` count
is a **subset** of the NSE column — those rows sit on NSE with no ticker assigned.

---

## `public/data/nse-freefloat.json`

Free-float market capitalisation for the NSE-listed universe reachable from a server.

| | |
| --- | --- |
| **Produced by** | `node scripts/scrape-nse-freefloat.mjs` |
| **Upstream source** | `https://www.nseindia.com/api/market-data-pre-open?key={NIFTY,FO,SME}` |
| **Tier** | 1 for `freeFloatMcapInr`, `iep`, `previousClose`, `sessionTimestamp`. **Tier 2** for `impliedFreeFloatShares` (see below). |
| **Cadence** | Designed for a monthly snapshot plus a daily recompute from price moves. That only works because what we persist is a **share count**, not a rupee figure. |
| **Committed?** | Yes. |
| **Failure mode** | Every unreadable key lands in `failed[]` with its reason. The script refuses to replace a larger existing snapshot with a smaller one (override with `--allow-shrink`) and exits non-zero if it collected nothing. |

> **`freeFloatMcapInr` is NSE's published free-float market cap.** It is **not** computed from
> promoter holding. The Screener-style formula `(100 − promoter%) × market cap` is explicitly
> rejected and must not appear anywhere in this codebase: lock-in shares held by VCs and PE firms are
> not promoter holdings but are not free float either, so the two disagree — and the global indices
> follow NSE.

### Top level

| Field | Type | Meaning |
| --- | --- | --- |
| `source` | string | Provenance, carried into exports. |
| `note` | string | The "NSE's figure, not computed from promoter holding" disclosure, so it survives an export. |
| `capturedAt` | ISO 8601 UTC | When **we** fetched. |
| `sessionTimestamp` | string, e.g. `"19-Aug-2026 09:07:24"` | **When NSE struck these prices**, carried verbatim in NSE's own format. **Never restamped, never reformatted, never replaced with `capturedAt`.** These are two different facts and conflating them silently ages the data. |
| `keysRead` | KeyStat[] | Per-key denominators — see below. |
| `companyCount` | integer | `companies.length`. The denominator for every coverage claim on screen. |
| `companies` | Company[] | Deduplicated union, sorted by symbol. |
| `failed` | Failure[] | `{ key, reason }`. **Empty only when every key was genuinely read.** |

### `keysRead[]`

The denominators, kept so no screen has to hard-code one.

| Field | Type | Meaning |
| --- | --- | --- |
| `key` | `"NIFTY"` \| `"FO"` \| `"SME"` | The pre-open key. |
| `rowsReturned` | integer | Rows NSE sent for this key. |
| `rowsWithFreeFloat` | integer | How many carried a usable `marketCap`. Print as "X of `rowsReturned`". |
| `newSymbols` | integer | How many this key contributed that earlier keys had not. NIFTY 50 is largely a subset of F&O, so the overlap is large by design. |
| `sessionTimestamp` | string | NSE's timestamp for this key, kept per-key so a disagreement between keys is visible rather than averaged away. |

Measured: `NIFTY` 50 of 50, `FO` 208 of 208, `SME` 53 of 53 → **union 261**. `OTHERS` (1,971 rows)
and `ALL` (2,179 rows) return `marketCap: "-"` for every row and are not read; `BANKNIFTY` is 403.

### `companies[]`

| Field | Type | Unit / meaning |
| --- | --- | --- |
| `symbol` | string | NSE symbol. |
| `freeFloatMcapInr` | number, ₹ | **Tier 1.** NSE's free-float market cap, in rupees, struck at the pre-open IEP. |
| `iep` | number \| null, ₹/share | **Tier 1.** Indicative equilibrium price from the 09:00–09:08 IST pre-open session. `null` when NSE published none. |
| `previousClose` | number \| null, ₹/share | **Tier 1.** |
| `impliedFreeFloatShares` | number \| null, shares | **Tier 2 — derived by us.** `round(freeFloatMcapInr / iep)`, falling back to `lastPrice` when `iep` is absent, `null` when neither exists. The `implied` prefix is load-bearing: **NSE never published a share count**, and nothing downstream may present this as though it did. |
| `sourceKey` | `"NIFTY"` \| `"FO"` \| `"SME"` | Which key this symbol came from. A symbol under more than one key is stored once, under the first key read (NIFTY, then FO, then SME). |

**Why a share count and not rupees.** The plan is a monthly NSE snapshot plus a daily recompute from
price moves. Persisting `impliedFreeFloatShares` lets today's free-float market cap be computed as
`impliedFreeFloatShares × today's price` — correct *now* rather than as of the last scrape. Persisting
the rupee figure alone would silently serve a stale number that looks current. Any such recompute is
**tier 2** and must show its formula where it renders.

**Coverage is the story, not a footnote.** Measured by `node scripts/check-naive-join.mjs`, the
261-symbol set covers 96.0% of the EM ETF's India weight but only 21.0% / 20.8% of the two small-cap
funds' — and the small caps are where inclusion forecasting matters. A company absent from this set
has **no reading**, which is not the same as having no free float, and must render as an em dash.

---

## Join between the two files

There is **no resolver yet**, and no field in either file claims one. `msci-funds.json` stores
BlackRock's ticker verbatim; `nse-freefloat.json` stores NSE's symbol. They agree often enough to be
tempting and not often enough to be trusted.

`node scripts/check-naive-join.mjs` measures the exact-match baseline and writes nothing:

| Fund | Matched holdings | Matched India weight |
| --- | --- | --- |
| EM ETF | 152 of 165 | 10.860 of 11.315 pp — 96.0% |
| India Small-Cap | 36 of 461 | 20.971 of 99.729 pp — 21.0% |
| EM Small-Cap | 36 of 414 | 4.433 of 21.271 pp — 20.8% |

Two distinct causes of a miss, which a resolver must keep apart:

1. **The symbol does not match** — BSE scrip codes (`532483`), house codes (`SHFL`, `TMCV`, `ENRIN`,
   `VAML`), punctuation (`NAM.INDIA`), or no ticker at all (`--`). A resolver can fix these.
2. **The company is not in the NSE set** — it is not in NIFTY, F&O or SME, so this source has no
   free-float reading for it at any spelling. `MRF` is one of these: absent entirely, not spelled
   differently. **No resolver can fix these**; they need a different source.

Re-run the script for current numbers rather than quoting this table. Per CLAUDE.md §2.5, no count
that reaches a screen may be typed by hand.

---

## Not built yet

These will get contracts in this document when they land, and not before:

- **Ticker resolution** — BlackRock ticker → NSE symbol, with the two miss causes kept separate and
  a stated confidence per mapping.
- **Weight history** — quarter-on-quarter weight deltas per fund, the input to flow estimates.
- **Flow estimates** — `Δweight × totalMarketValueUsd`. Tier 2; the formula renders with the number.
- **Review forecasts** — inclusion / exclusion / re-weight probabilities. **Tier 3**: rendered with
  the rules that fired, the thresholds used, and the fact that those thresholds are the desk's
  assumption and not MSCI's published rule. Thresholds live in one module,
  `public/js/config/thresholds.mjs`.
