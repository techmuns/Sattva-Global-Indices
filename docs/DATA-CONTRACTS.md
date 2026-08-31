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

## `public/data/bse-scrip-master.json`

The listed-equity universe. One request, and the file that turns "the 261 names NSE's pre-open API
will tell us about" into "every company that could plausibly be in an MSCI review".

| | |
| --- | --- |
| **Produced by** | `node scripts/fetch-bse-master.mjs` |
| **Upstream source** | `api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?…&segment=Equity&status=Active` |
| **Tier** | 1 throughout. `indicativeFullMcapInr` is BSE's own `Mktcap`, converted from ₹ crore to rupees — a unit change, not a recomputation. |
| **Cadence** | Monthly, alongside the free-float scrape. |
| **Failure mode** | Refuses to write below a sanity floor (4,000 scrips / 3,500 with an INE ISIN) or on a >5% drop from the existing file. Count drift from the reference is **reported, not fatal** — see below. |

| Field | Type | Meaning |
| --- | --- | --- |
| `scripCode` | string | BSE's numeric scrip code, e.g. `"500325"`. Unique. What BlackRock prints for `Exchange = 'Bse Ltd'` rows. |
| `scripId` | string | BSE's own short id, e.g. `"RELIANCE"`. Unique. Tracks the NSE symbol closely — **and is never used as one**; see `nse-universe.json`. |
| `name` | string | BSE's scrip name. |
| `issuerName` | string \| null | BSE's issuer name. |
| `isin` | string \| null | `null` unless it matches `IN[A-Z0-9]{10}`. The identity key for everything downstream. |
| `group` | string \| null | BSE trading group (`A`, `B`, `T`, `XT`, `Z`, …). |
| `faceValue` | number \| null | |
| `indicativeFullMcapInr` | number \| null, ₹ | **Selects the scrape universe and nothing else.** BSE's `Mktcap`, struck at a moment this endpoint does not disclose. It agrees exactly with the per-scrip `MktCapFull`, but it must never render as a company's market cap — the authoritative figure comes from `bse-freefloat.json`, alongside the free float it is divided by. |

**Why drift is reported here and fatal in `import-ishares.mjs`.** That script reads three workbooks
committed in this repo: those bytes cannot change unless somebody changes them, so a moved number is
always a bug. This one reads a live endpoint, and BSE lists and delists continuously. An exact-count
assertion would break the monthly refresh the first time a company IPOs — punishing the data for
being current. The reference counts are checked and any difference is printed loudly; only a
collapse below the floor refuses to write. Do not make this strict, and do not make the other lax.

`INDUSTRY` is present in the upstream response and is `null` for every row; it is not carried.
Sector comes from `ComHeader.IndustryNew` in the free-float scrape.

---

## `public/data/nse-universe.json`

The NSE symbol ↔ ISIN bridge.

| | |
| --- | --- |
| **Produced by** | `node scripts/fetch-nse-universe.mjs` |
| **Upstream source** | `niftyindices.com/IndexConstituent/ind_nifty500list.csv` and `ind_niftytotalmarket_list.csv` |
| **Tier** | 1. |
| **Cadence** | Monthly, or after any index reconstitution. |
| **Failure mode** | Refuses to write below 400 symbols. A symbol carrying two different ISINs across the two files lands in `failed[]`. |

| Field | Type | Meaning |
| --- | --- | --- |
| `symbol` | string | The NSE symbol. **The only authoritative source of one in this project.** |
| `isin` | string | Validated `IN[A-Z0-9]{10}`. |
| `name`, `industry`, `series` | string \| null | As published. |
| `sources` | string[] | Which CSV(s) carried it. Nifty 500 is a strict subset of Nifty Total Market. |

`placeholders[]` holds rows excluded from the symbol map because their ISIN begins `DUM`: **NSE
demerger placeholders**, standing in for an entity that has been demerged but has not started
trading. They are not securities and must not enter the map, but they are not malformed data either
— they are the NSE-side counterpart of the iShares rows whose ticker is `--`, and two of them
(`DUMMYTRVN`, `DUMMYINXGN`) correspond directly to unresolved holdings. Recorded, not dropped.

**The CSV parser honours quoted fields.** Several company names contain commas; a naive split pairs
a name fragment with the wrong ISIN and throws nothing.

---

## `public/data/bse-freefloat.json`

Free float, full market cap, price and sector for the scrape universe.

| | |
| --- | --- |
| **Produced by** | `node scripts/scrape-bse-freefloat.mjs` |
| **Upstream source** | `api.bseindia.com` — `StockTrading`, `getScripHeaderData`, `ComHeader`, three requests per scrip |
| **Tier** | 1 for `fullMcapInr`, `freeFloatMcapInr`, `priceInr`, `sector`. **Tier 2** for `floatFactor` and `sharesOutstanding`. |
| **Cadence** | Monthly. The stored factor is price-independent, so a daily price move re-values free float with no new scrape. |
| **Failure mode** | Every unreadable scrip lands in `failed[]` with its reason; partial reads land in `notes[]`. Refuses to replace a larger snapshot. Exits non-zero if it collected nothing. |

**Universe**: every scrip a fund holds, at any size, **plus** every scrip whose indicative full market
cap clears the desk's exclusion floor (₹2,000 Cr, from `public/js/config/thresholds.mjs`). A company
the funds own is in scope however small it has become — a position we cannot price is a hole in the
product, whereas a small company we do not own is merely absent from a candidate list.

| Field | Type | Unit / meaning |
| --- | --- | --- |
| `scripCode`, `scripId`, `name` | string | From the master. |
| `isin` | string \| null | The master's ISIN — authoritative. |
| `isinFromComHeader` | string \| null | Fetched independently per scrip as a **cross-check**. A mismatch is recorded in `notes[]`. |
| `sector` | string \| null | `ComHeader.IndustryNew`. BSE's taxonomy, used for every company so one column never mixes two taxonomies. |
| `fullMcapInr` | number, ₹ | **Tier 1.** `MktCapFull`, converted from ₹ crore. |
| `freeFloatMcapInr` | number, ₹ | **Tier 1.** `MktCapFF`, converted from ₹ crore. |
| `floatFactor` | number, dimensionless | **Tier 2 — derived by us.** `MktCapFF / MktCapFull`, both from one response at one instant, so no price difference can leak in. Asserted to lie in (0, 1.02]. |
| `priceInr` | number \| null, ₹ | **Tier 1.** `CurrRate.LTP`. `null` when the price call failed — which costs the share count, not the factor. |
| `priceAsOf` | string \| null | BSE's own `Ason` stamp, verbatim. |
| `sharesOutstanding` | number \| null | **Tier 2 — derived by us.** `fullMcapInr / priceInr`, **both BSE**. |

A scrip whose `MktCapFF` exceeds `MktCapFull` is rejected into `failed[]` rather than stored with a
factor above 1.

---

## `public/data/companies.json`

The join, and the only file the interface should read.

| | |
| --- | --- |
| **Produced by** | `node scripts/build-companies.mjs` |
| **Inputs** | `msci-funds.json`, `bse-scrip-master.json`, `nse-universe.json`, `nse-freefloat.json`, `bse-freefloat.json` |
| **Tier** | mixed, per field — every record says which. |
| **Cadence** | Whenever any input is refreshed. No network; cheap to re-run. |
| **Failure mode** | **Refuses to write** on a resolution collision, on a float factor outside (0, 1.02], or if the unit tripwire fires. |

### Top level

| Field | Meaning |
| --- | --- |
| `asOf` | The as-of stamp of **every** input, separately. They are different moments and are never collapsed into one. |
| `thresholds` | The values used, with the attribution that they are the desk's, not MSCI's. |
| `coverage` | **Every denominator the interface prints comes from here.** Nothing on screen may hand-type a count. |
| `resolutionMethodCounts` | Histogram of how each holding row was resolved. |
| `floatFactorDisagreement` | Median, worst, everything over the review threshold, and the ten largest gaps. |
| `handCheckedMappings` | The `CONFIRMED` table, with who checked each and why. |
| `knownNotListed` | The `NOT_LISTED` table — holdings pinned as unresolvable so a later matcher cannot "resolve" them onto a same-named company. |
| `companies` | One record per company, sorted by full market cap. |
| `unresolved` | Every holding row that could not be resolved, with its weight and a stated reason. |

### `companies[]`

| Field | Type | Tier / meaning |
| --- | --- | --- |
| `isin` | string \| null | The identity key. |
| `name`, `sector`, `sectorSource` | string \| null | `sectorSource` names the taxonomy. |
| `nseSymbol` | string \| null | **Only ever from a file that states it outright, keyed on ISIN** — `nse-universe.json` first, then the desk's seed list. Never inferred from BSE's `scripId`. |
| `nseSymbolSource` | `'nse-universe'` \| `'seed'` \| null | Which file asserted it. Where both speak they must agree or the build stops. |
| `bseScripCode` | string \| null | `null` for NSE-only listings — CDSL and BSE Ltd are real examples. |
| `seedBseScripCode` | string \| null | A BSE code the seed named that the **active** master does not carry. Kept visible, never fetched — a code the active master lacks may belong to a delisted company. |
| `noBseReason` | string \| null | Why this company has no BSE record, in words. Either the scrip is **Suspended** on BSE, or the company is not on BSE at all. |
| `instrumentKind` | `'equity'` \| `'invit-reit'` \| null | BSE's own `GROUP` code decides it: `IF` is the InvIT/REIT group. An InvIT unit is a real, priced, free-float-publishing security and it is **not** an equity share — anything that ranks or sums across the two has to say which is which. |
| `fullMcapInr` | number \| null, ₹ | Tier 1, BSE. |
| `sharesOutstanding` | number \| null | **Tier 2** — `fullMcapInr / priceInr`, both BSE. |
| `priceInr`, `priceSource`, `priceAsOf` | | Tier 1, BSE. |
| `floatFactor` | number \| null | **The factor in force.** BSE's, unless NSE also publishes and the two differ by more than `FLOAT_SOURCE_PREFER_NSE_GAP_PCT` (2%), or BSE has no reading. |
| `floatSource` | `'nse'` \| `'bse'` \| null | Which one that is. **Travels with the number everywhere, including exports.** |
| `floatChoice` | object \| null | **Tier 3 — a judgement made by a rule we wrote.** `{ rule, chose, gapPct, thresholdPct, why }`. `rule` is one of `bse-primary`, `nse-preferred-on-material-gap`, `bse-only`, `nse-only`, `nse-only-published-rupees`. A source chosen by a rule the reader cannot see is a tier-3 judgement wearing a tier-1 face. |
| `floatGapPct` | number \| null | **Tier 2** — `(nse − bse) / bse × 100`, signed. `null` unless both publish. |
| `floatFactorNse` | number \| null | **Tier 2** — `nseFloatShares / totalShares`; see below. `null` when NSE has no reading. |
| `floatFactorBse` | number \| null | **Tier 2** — kept even when NSE is the one in force, so the disagreement stays inspectable. |
| `freeFloatMcapInr` | number \| null, ₹ | **Tier 2** — `floatFactor × fullMcapInr`. |
| `held` | boolean | Whether any fund holds it. |
| `funds` | object | `{ eem, smin, eems }`. **`null` means NOT HELD by that fund. It is never `0`** — a 0% weight and an absent holding are different facts that sort differently. |
| `resolution` | object | `{ method, via, confidence }`. |

**How `floatFactorNse` avoids mixing prices:**

```
nseFloatShares = nse.freeFloatMcapInr / nse.iep        // both NSE
totalShares    = bse.fullMcapInr      / bse.priceInr   // both BSE
floatFactorNse = nseFloatShares / totalShares
```

Each division stays inside one source. The two are combined only in the **share-count** domain,
where a share is a share whoever quoted it. A result above 1.02 means the two sources disagree about
the *share count* — usually a corporate action one has processed and the other has not — which is
not a float reading and is stored as `null` rather than presented as one.

### The unit tripwire

BSE publishes ₹ crore and everything here is rupees, so a leaked crore value is a ten-million-fold
error that reads as a plausible small number. The build asserts that **no `…Inr` field is below
₹100,000 for any company above the ₹2,000 Cr floor** and refuses to write if one is.

---

## `public/data/prices.json`

End-of-day closing prices for the scrape universe. **The floor**: the static site renders fully from
this with no Worker and no network.

| | |
| --- | --- |
| **Produced by** | `node scripts/fetch-bhavcopy.mjs` |
| **Upstream source** | `bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_YYYYMMDD_F_0000.CSV` |
| **Tier** | 1 — BSE's own closing prices, carried through unchanged. |
| **Cadence** | Weekdays, ~20:00 IST, by `.github/workflows/daily-refresh.yml`. |
| **Failure mode** | Exits non-zero and writes NOTHING if the response is not a bhavcopy, its `TradDt` is not the date requested, continuity fails, or coverage is below 95%. |

| Field | Meaning |
| --- | --- |
| `tradeDate` | BSE's own trade date for the file. Not our capture time. |
| `prices[scripCode]` | `{ scripCode, isin, symbol, tradeDate, open, high, low, close, prevClose, volume, staleDays, source }` |
| `staleDays` | `0` for a price from this file. Above zero means **the stock did not trade** and its last close was carried forward. That is not zero and not "unchanged". |
| `source` | `bhavcopy-bse` or `bhavcopy-bse-carried`. |
| `carriedForward[]` | Every carried scrip, **named**, with its last trade date. |
| `missing[]` | Every scrip with no price from any source, **named**. Never merely counted. |
| `continuity` | `{ against, compared, failures[], noCounterpart }` — see below. |

**Two tripwires, both proven rather than assumed.**

*Shape.* BSE serves its single-page-app shell with HTTP 200 and `content-type: text/html` for
download URLs that do not exist (`EQ_ISINCODE_180826.zip` → 200, 13,850 bytes, HTML). A status check
alone would write an empty price file and turn every free-float figure null on a day when nothing was
wrong. `assertBhavcopyShape` rejects HTML, missing columns, and a `TradDt` that is not the date asked
for; the fetcher is tested against that exact URL.

*Continuity.* A file dated today can still carry a row copied from yesterday, which a file-level date
check cannot see. So today's `PrvsClsgPric` must equal yesterday's `ClsPric`, per scrip. Measured
18→19 Aug 2026: 4,562 compared, **0 failures** — measured over two complete bhavcopy files, which are
not committed; the reproducible figure is `prices.json → continuity`, **1,195 compared, 0 failures**,
over the universe the pipeline tracks. Scrips with byte-identical bars across two days pass —
an unchanged close is a stock that did not trade, not a stale row.

---

## `public/data/quote-stats.json`

Monthly per-company statistics from Munshot. Optional: the record builds without it.

| | |
| --- | --- |
| **Produced by** | `node scripts/fetch-quote-stats.mjs --concurrency 1 --gap-ms 1200` |
| **Upstream source** | `fastapi.muns.io` — `stockquote_batch` and the undocumented `detailquote` |
| **Tier** | 1 for the published figures; the ADV **source is recorded, never blended**. |
| **Cadence** | Monthly. None of these move fast enough to be worth a request during a session. |
| **Failure mode** | Refuses to write below a coverage floor (default 80% of fetchable companies). |

| Field | Meaning |
| --- | --- |
| `advQty`, `advSource` | Average daily volume and **which figure it came from** — `munshot-3m-detail`, `munshot-3m-batch` or `munshot-10d`. The batch and detail calls disagree slightly (13,637,505 vs 13,943,013 for RELIANCE); neither is averaged into the other. |
| `yearlyChangePct` | As published. |
| `lastSplitFactor`, `lastSplitDate` | A split changes the share count, and a share-count change is one of the few things that actually forces an index fund to trade. **`Last Split Date` is UNIX EPOCH SECONDS upstream** — read as a string it gives 1970. |
| `munshotMarketCapInr`, `munshotVsBseMcapPct` | A cross-check, not a correction. Munshot is NSE-priced and our full market cap is BSE-priced. |

Only companies with an **asserted NSE symbol** appear. Munshot is keyed on NSE tickers, and BSE's
`scrip_id` is not one however often it looks like one — guessing would attach another company's
volume to a row.

---

## The live overlay — `POST /api/quotes`

Served by `worker/index.js`. **Not part of any committed file.**

Request `{ "symbols": ["RELIANCE", …] }`; response
`{ ok, asOf, requested, resolved, chunks, chunkSize, quotes: { SYMBOL: { price, prevClose, open, dayLow, dayHigh, lastVolume, source } }, failed: [{symbol, reason}] }`.

| Rule | Why |
| --- | --- |
| The token lives in `env.MUNS_TOKEN` and the browser never sees it | A token shipped to the client is a token published. |
| Chunked at **50** symbols | Measured: the upstream caps a batch at **81** and returns HTTP 400 above it. The cliff is a COUNT limit, not body length — 80 of the longest symbols pass, 85 of the shortest fail. 50 leaves margin on an undocumented cap that can move. |
| Edge-cached ~30 s, failures ~15 s | A hundred readers cost the upstream one fetch per window. `x-siflows-cache` reads `live` then `hit` — verifiable from outside, unlike a claim in a comment. |
| Failures return **200 with `ok:false`** | The request to *our* Worker succeeded. `no-token` and `unauthorised` name a command an operator runs; `upstream` and `unreachable` are things to wait out. |
| `status: "timeout"` and `status: "not_found"` are FAILURES | The row keeps its EOD price and is listed in `failed[]`. Never a missing value, and never a durable fact about the symbol — this upstream reports `not_found` for tickers it served minutes earlier when pushed. |

**Live values are merged into memory and never written back to a committed file.** The committed
file is the exchange's own bytes under the exchange's own date.

---

## Price, drift and flow fields on `companies[]`

| Field | Meaning |
| --- | --- |
| `priceInr`, `prevCloseInr`, `priceDate` | The committed EOD figures. A live quote overlays these in the browser only. |
| `priceTier` | `eod` \| `stale` \| `null`. **`live` never appears in a committed file.** |
| `priceStaleDays` | Above zero means the stock did not trade. |
| `priceSource`, `priceExchange` | `bhavcopy-bse` / `BSE`. A live row becomes `munshot-nse` / `NSE` in memory — **a different exchange**, which is why the source travels with the number. |
| `dayChangePct` | `null` where the stock did not trade — **not 0.0%**. |
| `freeFloatMcapInr` | Recomputed: `floatFactor × sharesOutstanding × price`. |
| `freeFloatMcapAtCaptureInr` | What the exchange published when the float file was captured, kept for comparison rather than replaced. |
| `advQty`, `advSource`, `yearlyChangePct`, `lastSplitFactor`, `lastSplitDate` | From `quote-stats.json`, `null` when absent. |
| `passiveDrift[fundId]` | `{ weightAtCapturePct, impliedWeightNowPct, driftPp, requiresTrade: false }` |

**`requiresTrade` is hard-coded `false`.** A price move changes a fund's holding value and its index
weight by the same proportion, so it forces no trade. Drift is measured relative to the fund's own
basket; a one-sided distribution would mean prices from different dates, and the build asserts both
signs are present.

`flowPrimitives[fundId]` at the top level carries `fundAumUsd`, `fxRate`, `inrPerWeightPoint` and
`inrPerBasisPointOfWeight` — **inputs to a later calculation, not results**. AUM and FX are both as of
the holdings date. **No rupee flow figure exists anywhere in this build.**

---

## The model — segments, verdicts and flows

Five modules under `public/js/model/`. They are plain ES modules, imported by the browser AND by
`scripts/build-companies.mjs`, so there is one implementation and two sets of inputs: the build
assesses against the committed end-of-day price, the interface re-assesses against whatever price is
in force. Verdicts stored in `companies.json` are therefore **the EOD verdict**, exactly as
`freeFloatMcapInr` already is.

### `segments.js` — membership is derived, not assumed

Measured on the committed holdings: `EM ∩ India SC = 0`, `EM ∩ EM SC = 0`, `India SC ∩ EM SC = 408`.

| Held by | Segment |
| --- | --- |
| EM ETF | MSCI India Standard (large + mid) |
| India Small-Cap and/or EM Small-Cap | MSCI India Small Cap |
| none of the three | outside MSCI India IMI |

`assertDisjoint()` re-checks this every build. **EM Small-Cap is a strict subset of India Small-Cap**
— 408 of 454, zero names India SC lacks — so it samples the segment while India SC replicates it.
That distinction drives flow estimation and is asserted too.

### `thresholds.js` — two thresholds, deliberately not reconciled

| | Source | Question | Committed value |
| --- | --- | --- | --- |
| Desk bands | `config/thresholds.mjs` | index entry / exit | ₹3,500–4,000 Cr, ₹2,000–2,400 Cr |
| Observed boundary | current constituents | which segment | floor ₹18,521 Cr, ceiling ₹70,169 Cr |

`observedBoundary()` returns both extremes, the companies that define them, the overlap and the
**rank cutoff** — the Nth-largest free float where N is the Standard constituent count. The rank
cutoff exists because the floor cannot classify a Standard constituent: the floor *is* one.

### `assess.js` — the rules engine

`assess(company, context)` returns `{ verdict, segment, distancePct, rulesFired, notes }`. Every rule
records `{ key, label, input, threshold, thresholdSource, result }`.

| Verdict | Rule |
| --- | --- |
| `likely-inclusion` | unheld, free float ≥ the desk's upper inclusion band |
| `possible-inclusion` | unheld, inside the desk's inclusion band |
| `migration-up` | a Small Cap constituent ranking inside the top N by free float |
| `migration-down` | a Standard constituent ranking outside the top N |
| `exclusion-risk` | a constituent inside the desk's exclusion band |
| `likely-exclusion` | a constituent below the desk's lower exclusion band |
| `stable` | no rule fired |
| `unknown` | the share count is quarantined, or there is no free-float reading |

`verdictFromRules(rulesFired)` replays the record and recovers the verdict; the build asserts the
replay matches **for every company**. A drill showing a derivation that did not produce the answer
beside it is worse than a wrong answer, because it looks checkable and is not.

**There is no probability anywhere.** See §2.13 of CLAUDE.md and the upgrade path below.

### `flows.js` — only trade-implying verdicts

```
flowInr    = targetWeightPp × inrPerWeightPoint(fund)
flowShares = flowInr / priceInr
daysOfAdv  = flowShares / advQty        // null, never 0, where advQty is unknown
```

`certainty` is `measured-position` for an exit (the holdings file states the position exactly) and
`estimated` for an entry (target weight = the company's free float ÷ the segment's total, and the
record carries both). A migration produces **two** flows with opposite signs, never netted.
`notSampled[]` records a fund that has no basis for an estimate rather than emitting a zero.

### `calendar.js` — assumed dates

Quarterly Feb/May/Aug/Nov is public. The effective date and snapshot convention are **not cited**;
`CONVENTION.confirmed` is `false` and every surface says "assumed".

### Fields these add to `companies[]`

| Field | Meaning |
| --- | --- |
| `segment` | `standard` \| `smallcap` \| `outside`, derived |
| `assessment` | `{ verdict, distancePct, rulesFired, notes, disclosure, basis }` |
| `flowEstimate` | `{ shape, flows[], notSampled[] }`, or `null` |
| `shareCountQuarantine` | `{ reason, gapPct }` when the share count could not be corroborated |

Top level gains `model` — segment counts, the observed boundary, verdict counts, the next review, and
the disclosure string that must accompany any verdict.

---

## `public/data/share-reconciliation.json`

| | |
| --- | --- |
| **Produced by** | `node scripts/reconcile-shares.mjs` |
| **Why** | `sharesOutstanding` feeds free-float market cap, which decides every verdict. A wrong share count produces a confident, well-formatted, wrong answer. |

Compares BSE's implied share count (`MktCapFull / LTP`) against Munshot's (`Market Cap / Current
Price`) — each derived inside its own source, so no price difference leaks in. A disagreement is
adjudicated against NSE's published free float where NSE covers the company; where it does not, the
company is **quarantined** and its verdict becomes `unknown`.

`quarantinedIsins[]` is what `build-companies.mjs` reads.

---

## `public/data/price-history.json`

| | |
| --- | --- |
| **Produced by** | `node scripts/fetch-price-history.mjs` |
| **Cadence** | once per review, when a new price window closes |
| **Why** | The desk's question is review-to-review, and the repo held one trading day of prices. |

Each scrip's raw close on every business day of the two most recent **closed** MSCI price windows,
**and** on a short span around each of the last four **rebalance effective dates** — 37 sessions,
4,792 scrips. `dates[]` is the union of every captured session in order; `scrips[code].closes[]` is
index-aligned to it, with `null` for a session the scrip did not trade. `firstSeen` separates that
from *not yet listed*, which index-aligned nulls cannot tell apart on their own.

`windows[]` and `baselines[]` are **two different things and answer two different questions**:

| | `windows[]` | `baselines[]` |
| --- | --- | --- |
| What | the ten days MSCI struck a review's market caps in | the day that review's composition took **effect** |
| For the May 2026 review | 17–30 Apr 2026 | 29 May 2026 |
| Sessions each | 10 | 4–5 (the effective date ± 2 business days) |
| The extra days are | the window itself — all ten are averaged | a **sensitivity span**; only `resolvedDate` is used |

Each baseline carries `resolvedDate`, `walkedBackDays` and `tradedOnEffectiveDate`, because MSCI's
effective date is a global index date and **the Indian market can be shut on it**. The baseline then
resolves to the nearest earlier session in the span and says so. On the committed capture all four
effective dates were Indian sessions, so nothing walked back.

**Closes are unadjusted.** They are BSE's own published figures carried through unchanged, so an
adjusted price — a number no exchange published — never enters the record. Adjustment happens in
`relative.js`, from `corporate-actions.json`, with the factor and the formula on the surface.

**The continuity check inside this script is an INTEGRITY check, not an action detector.** BSE
carries `PrvsClsgPric` unadjusted, so a bonus passes it cleanly — see below.

---

## `public/data/corporate-actions.json`

| | |
| --- | --- |
| **Produced by** | `node scripts/fetch-corporate-actions.mjs` |
| **Endpoint** | `api.bseindia.com/BseIndiaAPI/api/DefaultData/w?scripcode=N`, one request per scrip |
| **Cadence** | monthly, and before any review-window measurement |
| **Why** | A raw close across a bonus issue is a collapse that never happened. |

LICI closed at 829.90 on 27 May 2026 and at 411.45 on the 29th. It went ex-bonus 1:1; nothing was
lost. Read as a raw series that is −50.4%, and it sorts, ranks and corroborates a migration-down
verdict perfectly happily. Seven such events fall inside the May→August 2026 quarter alone.

> ### ⚠ BSE does NOT adjust `PrvsClsgPric` across an action
>
> The obvious detector infers actions from the bhavcopy itself: if the exchange adjusts the previous
> close across an action, a disagreement with the prior session's raw close *is* the action — free,
> for every scrip. **BSE does not adjust it.** LICI's `PrvsClsgPric` on its own ex-date is 829.90,
> exactly the raw close of the session before. Continuity holds across a bonus and the event is
> invisible to it.
>
> That detector found **0 actions across 303,018 comparisons** in a quarter known to contain seven,
> and only a positive control — *finding nothing means you are broken* — stopped it being written.
>
> Nor is it rescuable from prices alone: with `PrvsClsgPric` raw, a 1:1 bonus and a genuine 50%
> crash are the same two numbers.

`Ex_date` and `Purpose` are BSE's own strings, verbatim. `priceFactor` is **ours** — the number a
price is *divided* by across the ex-date, i.e. how many shares one share became — and `factorRule`
names the rule that produced it so it can be checked rather than trusted:

| BSE's words | `kind` | `priceFactor` |
| --- | --- | --- |
| `Bonus issue a:b` | `bonus` | `(a + b) / b` |
| `Stock  Split From Rs.X/- to Rs.Y/-` (note the double space) | `split` | `X / Y` |
| `Consolidation From Rs.X/- to Rs.Y/-` | `consolidation` | `X / Y`, below 1 |
| `Right Issue of…`, `Spin Off`, `Scheme of Arrangement`, `Consolidation of Shares`, `Sub Division of…` | `rights` / `demerger` / … | **`null`** — the price moves and BSE publishes no ratio |
| `Dividend…`, `Buy Back of Shares`, `Income Distribution…`, `E.G.M.` | *not carried* | not a mechanical price event |

A purpose naming something structural without the numbers is `priceFactor: null`, **never `1.0`** —
a factor of 1 asserts the action does not move the price, which is a claim; `null` says we did not
read it, which is the truth. Dividends are excluded because the index leg is also a price return
with distributions stripped, so adjusting one leg and not the other would put them on different
conventions.

**A purpose we have never seen fails the run.** A new wording could be a bonus we fail to match, and
it would pass through as a clean return. That guard caught four wordings a 300-scrip vocabulary
probe had missed, one of them `Consolidation of Shares`.

Coverage: **1,237 of 1,237** scrips, 0 failed, 643 with at least one action. It supersedes
`quote-stats`'s `lastSplitFactor` on every axis — that reached 749 companies, stored only the most
recent event, and called LICI a "2:1 split" rather than a 1:1 bonus. Cross-checked on all seven of
the quarter's events, the two agree exactly.

---

## `relativePerformance` on `companies[]`

| | |
| --- | --- |
| **Produced by** | `public/js/model/relative.js`, called from `build-companies.mjs` |
| **Tier** | 2 — derived by us from tier-1 closes and tier-1 published actions |

How a company moved against its segment, from one MSCI price window to the next. Computed in the
build and stored, because it is a historical window that no live price can move.

```
stockPct     = (meanTo - meanFrom / adjustmentFactor) / (meanFrom / adjustmentFactor) x 100
indexPct     = (indexMeanTo - indexMeanFrom) / indexMeanFrom x 100      // in RUPEES
relativePct  = ((1 + stockPct/100) / (1 + indexPct/100) - 1) x 100      // GEOMETRIC
```

**Geometric, not an arithmetic point difference.** WELCORP against SMIN is a 115.2 pp difference and
a +110.0% outperformance; a reader who reconstructs from the two legs on screen finds neither
matches the other.

**The benchmark is INDA for Standard and SMIN for Small Cap** — the index that decides the segment,
not the fund that holds the stock. Only a benchmark whose basket is actually Indian may be
differenced against an Indian company; `comparableInInr` in `benchmarks.js` is the gate.

### The day-choice envelope

MSCI prices on *one of the last 10 business days* and does not publish which, so the same quarter has
100 `(from-day, to-day)` pairs it could have meant. Measured across all 1,177 companies with a
reading:

| | |
| --- | --- |
| envelope width | p10 **8.30** · median **14.73** · p75 **21.03** · p90 **29.16** · max **133.15** pp |
| entirely one side of zero | **807 of 1,177** (68.6%) |

For **31.4%** of companies the *sign* depends on the day. `envelope` carries the full span,
`widthPp` its width, and `robust` is true only when the whole span clears
`RELATIVE_PERFORMANCE.bandPct` — which is set **at the measured median**, because a threshold
smaller than its own measurement's uncertainty produces state changes that are noise wearing a
threshold's face. 198 of 1,177 readings are robust.

**A direction is claimed only where the reading is robust**, and the column's colour follows
robustness rather than sign. `verify-ui` check 43 sabotages exactly that.

### The states

| `state` | Meaning | Count |
| --- | --- | --- |
| `measured` | both windows complete, no action in the quarter | 1,168 |
| `adjusted` | an action fell **between** the windows; the earlier window is divided by BSE's factor | 9 |
| `incomplete-window` | the scrip did not trade on every day of a window | 39 |
| `no-price-history` | no BSE scrip code, or absent from the archived bhavcopies | 39 |
| `action-inside-window` | an action fell **inside** a window, so its ten-day mean straddles two share bases | 5 |
| `unquantifiable-action` | a rights issue or demerger moved the price by an amount BSE does not publish | 3 |

`action-inside-window` is a genuinely unfixable case, and it is measurable: JLHL's action fell on
24 July, inside the August window, and the naive adjustment disagrees with an independent
split-adjusted source by **195 pp**. Against a no-action baseline of p50 2.18 pp and p90 10.18 pp
across 38 companies, that is not a tolerance question.

### What it may NOT do

**It never changes a verdict**, and `verify-data` check 37 sweeps it from −200 to +200 pp asserting
the verdict multiset does not move. A migration verdict turns on a rank by free-float market cap, and
free float is `floatFactor x shares x price` — so today's rank **already contains** every past price
move. Re-reading the trend against that rank double-counts.

`trendSignal()` is the one role that does not. Today's rank is a *point forecast* of the rank in
MSCI's next price window, which has not happened, so a robust trend is evidence about which way that
forecast moves. It marks a company within `nearBoundaryPct` of the observed rank cutoff whose robust
trend points **across** a boundary its rank has not crossed — additively, never inside a verdict.

> **Where it renders changed on 31 Aug 2026.** `trendSignal()` used to be the chip beside the
> verdict pill. That chip is now driven by `flowPressure()` on the **since-rebalance** reading, and
> `trendSignal()` lives in its own drill section beside the window it belongs to. Two chips, on two
> windows that disagree about the sign for 27.8% of companies, beside one verdict was a reader's
> trap: whichever one you read, you could not tell which window it meant.

---

## `sinceRebalance` on `companies[]` — the desk's baseline

| | |
| --- | --- |
| **Produced by** | `public/js/model/relative.js` → `assessSinceRebalance()`, called from `build-companies.mjs` |
| **Tier** | 2 — derived by us from tier-1 closes and tier-1 published actions |
| **Alternates** | `public/data/relative-baselines.json`, fetched only when a reader re-bases |

How a company moved against its segment **since the last rebalance took effect**. This is not a
variant of `relativePerformance` above; it is a different window answering a different question, and
the two are kept side by side because neither substitutes for the other.

| | `relativePerformance` | `sinceRebalance` |
| --- | --- | --- |
| Baseline | MSCI's ten-day **price window** — 17–30 Apr 2026 | the **rebalance effective date** — 29 May 2026 |
| Far end | MSCI's next price window — 20–31 Jul 2026 | the latest committed close — 28 Aug 2026 |
| Each end is | the mean of ten closes | one close |
| Uncertainty | which of MSCI's ten undisclosed days | how fragile one published date is |
| Answers | what MSCI's *next* size decision will see | what has happened since it last traded |

The two are **six weeks apart at the near end** and on the committed record they **disagree about
the sign for 326 of 1,174 companies (27.8%)**, 129 of them with both readings above 5%. Nothing may
sum, average or substitute one for the other.

```
stockPct     = (latestClose - baselineClose / adjustmentFactor) / (baselineClose / adjustmentFactor) x 100
indexPct     = (indexLatest - indexBaseline) / indexBaseline x 100        // in RUPEES
relativePct  = ((1 + stockPct/100) / (1 + indexPct/100) - 1) x 100        // GEOMETRIC
```

### Why there is no ten-day mean here

The mean upstream exists because MSCI does not publish *which* of its ten price days it used, so no
single day is privileged. **That reasoning does not transfer.** The rebalance date is published and
unambiguous — averaging it with its neighbours would baseline the reading on a window nobody asked
for.

### The sensitivity test, which replaces the envelope

What replaces the day-choice envelope is a fragility measure: if the baseline had been struck a
session or two either side, would the sign survive? Measured across the committed record over the
five candidate sessions around 29 May 2026:

| | |
| --- | --- |
| sensitivity width | p10 **1.56** · median **3.64** · p75 **5.66** · p90 **9.56** · max **49.29** pp |
| entirely one side of zero | **1,084 of 1,193** (90.9%) |

Far more stable than the window reading (90.9% against 68.6%) — and for a reason rather than by
luck: the only uncertainty is a day or two of price noise, not 100 undisclosed day-pairs.
`REBALANCE_BASELINE.bandPct` is **4 pp**, the first whole number at or above that measured median,
on the same principle as the 15 pp band above. **849 of 1,193 readings are robust (71.2%)**, and 24
of the 39 migration rows.

⚠ **The test varies the BASELINE end only.** The latest close is the newest fact, not a choice
anybody makes, and a reader watches it move daily. The baseline is the fixed, invisible choice, so it
is the one worth testing.

⚠ **The action interval is HALF-OPEN, and it is not the interval `adjustmentFor` uses.** Both ends
here are single days whose closes are already struck, so `baselineDate < exDate <= latestDate`: an
action ex *on* the baseline is already in that close and is not applied; one ex *on* the latest date
must be. Copying the window function's bounds across is a silent 2× error on a bonus.

### The states

| `state` | Meaning | Count |
| --- | --- | --- |
| `measured` | both ends traded, no action between them | 1,181 |
| `adjusted` | an action went ex between the two dates; the baseline is divided by BSE's factor | 13 |
| `not-yet-listed` | the company first appears after this rebalance date | 17 |
| `no-price-history` | no BSE scrip code, or absent from the archived bhavcopies | 39 |
| `unquantifiable-action` | a rights issue or demerger moved the price by an amount BSE does not publish | 7 |
| `no-baseline-close` | the scrip did not trade on the rebalance date or anywhere in its span | 4 |
| `no-latest-close` | no close in the latest committed bhavcopy | 3 |
| `no-action-data` | BSE did not answer for this scrip — unknown actions, not none | 1 |
| `no-index-leg` | the benchmark has no close on one of the two dates | 0 |
| `no-benchmark` | no Indian benchmark stands for this segment | 0 |

`not-yet-listed` is the state this reading has and the window one does not, and it earns its place:
an older baseline is a date more companies did not exist on. Rendering it as "did not trade" would
report a listing date as a gap in the data.

### The baseline, and overriding it

`REBALANCE_BASELINE.defaultReview` (`null` = the most recent rebalance whose date has passed) is
resolved **at build time against the newest session the exchange served**, never against the clock.
`REBALANCE_BASELINE.offerCount` (4) decides how many past rebalances the reader may switch to;
`sensitivityDays` (2) how wide each fragility span is.

The default reading is inline on every company. The alternates are in
`public/data/relative-baselines.json` — 1.27 MB, **fetched only when a reader re-bases**, because it
answers a question most readers never ask. Both carry **the same fields**: `state` is the key into
`REBASE_STATES` and the prose is not duplicated 1,265 times per baseline.

`data.readingFor()` returns `undefined` while a baseline is loading and `null` when a company has no
reading. The two must not be collapsed: one is a fact about the fetch, the other about the company.

⚠ **A stored override must be resolved at startup, and once was not.** The choice lives in
localStorage and survives a reload; the file lives in memory and does not, and the only caller of
`ensureBaseline` was the picker's own change handler. So a reader who re-based yesterday came back to
the baseline they picked named in the heading and **1,265 em dashes underneath — the loading state,
permanently true**. Measured before the fix: 0 flow chips after a reload on the August 2025 baseline,
against 15 up and 36 down before it. `verify-ui` check 48 reloads on an alternate baseline and
asserts the numbers come back and that not one row is left saying "still loading".

### `flowPressure()` — how it is reflected in the verdict

The desk asked for the out/under-performance to be reflected in the verdict. It is reflected
**beside** it: `flowPressure()` classifies every reading as `positive`, `negative` or `neutral`
carrying the rule, the input, the band and whose band it is, and the verdict key is untouched.

⚠ **"Flow pressure" is not flow, and CLAUDE.md §2.11 is why.** A rising weight forces no trade at
all. What the signal says is that at the *next* review, when MSCI re-ranks, the forced trade would
point one way rather than the other. It carries a direction and **never a rupee figure**.

The chip beside the verdict fires on `notable` rows, **not on robust ones**: 849 of 1,193 readings
are robust, and a marker on two rows in three is a marker readers stop seeing. A row is notable when
the reading says something the verdict does not — it contradicts a migration, inclusion or exclusion
verdict, or the row is `stable` and within `nearBoundaryPct` of the rank cutoff. Every other row
still shows the number, one column away.

### What it may NOT do

**It never changes a verdict.** `verify-data` check 37 sweeps *both* readings from −200 to +200 pp
and asserts the verdict multiset does not move; `verify-ui` check 45 switches the baseline through
the interface and asserts every one of the three columns moves and **not one verdict does**. Check 37
also asserts `flowPressure()` yields the same direction with or without a verdict — the verdict only
decides whether the row is *marked* — and that the classification carries no rupee figure.

### On screen

Three columns, in the order the arithmetic reads: **Index return %**, **Stock return %**, **Δ vs
index %**. They replaced a single `vs segment %` column that put both legs in a tooltip, so a reader
saw an answer and not the working — and could not tell a stock that fell 2% against a flat index from
one that rose 8% against an index up 10%. Same delta, different events.

The delta's colour follows **robustness**, never sign. `verify-ui` check 46 asserts every rendered
delta is the geometric one — its tolerance is *derived* from the one-decimal rendering and the
formula's own error amplification (`1/(1+i)` and `(1+s)/(1+i)²`), because a flat allowance fails 422
of 1,194 rows on correct arithmetic.

The **flow chip beside the verdict is emerald up and rose down** — the same ramp the delta column
uses, because two meanings on one pair of colours in a single row teaches a reader to distrust both.
`verify-ui` check 47 asserts the mapping, that both directions actually occur on screen, and that
each chip's arrow agrees with the delta on its own row.

That colour used to key on `notableKind` — amber where the reading contradicts the verdict, sky where
it approaches a boundary. The distinction is not lost: it is the first sentence of the chip's title,
and in the drill it keeps an amber **"Marked beside the verdict"** line. It has to stay visible
somewhere, because a disagreement that reads as agreement is the worse failure of the two.

---

## The route to a real probability

The requirement asked for a probability of inclusion or exclusion, and this build does not provide
one. It is reachable, and this is what it would take:

1. **Historical iShares holdings.** BlackRock publish per-date holdings files at the same URL pattern
   as the committed fixtures. Fetching, say, three years of month-end files for the three funds gives
   the constituent set at each date.
2. **Reconstruct the events.** Diffing consecutive files yields entries, exits and segment
   migrations, dated to a review.
3. **Reconstruct the distances.** For each event, the company's free-float market cap at that date
   (which needs historical prices — bhavcopy is available per day, and the float factor changes only
   quarterly) gives its distance from the then-observed boundary.
4. **Fit a base rate.** Entries and exits binned by distance-to-threshold give an empirical
   probability curve, and the observed cut-off per review gives the boundary's own volatility.

Cost: roughly 100 workbook fetches and a few thousand bhavcopy days, plus a fitting step. **The
output would be checkable** — that is the whole difference between it and a number invented today.

---

## The verification suite

Two commands. Neither needs the other, and both exit non-zero if any check failed.

```bash
node scripts/verify-data.mjs                                   # 21 checks, no browser, no network
node scripts/verify-ui.mjs                                     # 21 checks vs http://127.0.0.1:8080
node scripts/verify-ui.mjs http://127.0.0.1:8787 --require-live  # vs `npx wrangler dev`
node scripts/verify-data.mjs --prove                           # break each check; it must go red
```

`.github/workflows/verify.yml` runs both on every push and pull request, in both modes.

### Every check is a bug that actually happened

The suite is not a coverage exercise. Each assertion is a trap found while building prompts 1–5, so
that undoing the fix turns something red:

| | Data-layer assertion | The trap it remembers |
| --- | --- | --- |
| 1 | workbook counts and weight sums | positional column reads; a silently-misparsed third file |
| 2 | segments strictly disjoint, EM SC ⊆ India SC | segment membership assumed rather than derived |
| 3 | no cross-fund weight arithmetic | three denominators that no arithmetic relates |
| 4 | `…Inr` vs the master's independent `Mktcap`, within 100× | ₹ crore leaking into a rupee field |
| 5 | zero `parseFloat` call sites | `parseFloat("8,71,532.61")` → `8` |
| 6 | free-float round-trip for every company | recomputing a factor from a price |
| 7 | every verdict replays from its own `rulesFired` | a derivation shown beside an answer it did not produce |
| 8 | no probability, in code or in the record | invented precision with no base rate behind it |
| 9 | `driftPp` never multiplied | a rising weight printed as a forced trade |
| 10 | migrations two-directional, never netted | a netted migration implying a market-clearing |
| 11 | EM SC flows only where EM SC holds | "not sampled" rendered as zero |
| 12 | quarantined ⇒ `unknown`, no flow | a confident verdict on a share count we do not trust |
| 13 | `daysOfAdv` null, never 0 | zero days of volume reading as "instant" |
| 14 | no formatter renders a real value as nothing | ₹0.10 Cr printed "₹0 Cr"; 0.00045% printed "0.000%" |
| 15 | null weight never rendered or sorted as 0 | a fabricated zero sorting a company to the bottom |
| 16 | every scrip Active in the master | BSE answering happily for a scrip delisted in 2023 |
| 17 | shape guard rejects the HTML-with-200 fixture | a 200 that is not a contract |
| 18 | row-level continuity across two committed days | a file dated today carrying yesterday's row |
| 19 | `rawQuote` round-trips; absent ⇒ null | a digit-leading key swallowed into the previous value |
| 20 | the collision guard fires when forced | two rows of one fund on one ISIN |
| 21 | the naive tripwire is proved to exempt its own victim | a guard reading its threshold from the value under test |

| | Interface assertion | The trap it remembers |
| --- | --- | --- |
| 22 | zero console errors beyond the two CDN families | filtering by message text, which hides real errors |
| 23 | every row in the DOM; the count reads the array | a count that counts what it is verifying |
| 24 | rendered `(ISIN, name)` pairs vs the source array | counting cannot catch a key collision |
| 25 | scope toggle changes the count; denominator printed | a bare "X" with no "of Y" |
| 26 | search by name/symbol/ISIN; filters AND | filters that replace rather than compose |
| 27 | sort both ways; missing last in both | nulls sorting as zero |
| 28 | the sort button survives its own click | `thead.innerHTML = …` detaching the focused node |
| 29 | the star fills on the click, filters, survives reload | a glyph that disagrees with what is stored |
| 30 | `?company=` survives a real `page.reload()` | a superseded panel's `onClose` clearing its successor's URL |
| 31 | focus trapped, ESC closes, focus restored | a panel a keyboard cannot leave, or return from |
| 32 | every `<th>` carries `scope="col"` | a header unannounced to a screen reader |
| 33 | no sideways body scroll at 1440 / 1024 / 390 | wide content clipped rather than scrolled |
| 34 | a scope switch never blocks past 400 ms | a rebuild that freezes the tab |
| 35 | all three provenance tiers present and populated | a "modelled" tier that still says nothing |
| 36 | verdict pills semantic; never the brand indigo | brand colour standing in for meaning |
| 37 | CSV round-trips with every banner line | a workbook that leaves without its disclosure |
| 38 | the header pill names the oldest input; the sources modal carries every feed's date | a live price implying a live float factor |
| 39 | `/api/quotes` live→hit; a bad ticker in `failed[]` | one bad symbol taking the batch down |
| 39b | a tick repaints only changed rows | a rebuild throwing away the reader's search and sort |
| 40 | the token appears in zero **served** files | checking the repo instead of what is served |
| 41 | Worker unreachable ⇒ EOD, "Last close" | claiming live when no byte arrived |

Three checks in `verify-data` cover the second methodology (`public/js/model/gimi.js`):

| # | Asserts | The bug it would have caught |
| --- | --- | --- |
| 30 | the cutoff is COUNTED in free float and ANSWERED in full market cap | ranking by the wrong size, which moves 432 companies more than 100 places |
| 31 | the buffers are asymmetric and genuinely shelter companies | a symmetric pair, predicting migration MSCI's hysteresis suppresses |
| 32 | the two models disagree on real companies | a second model that is a relabelling of the first |
| 42 | the stat strip is one row at 1440px, however many cards | a card wrapping out of sight below the fold |

### SKIP is a result, and it is always explained

- **Static mode** (`python3 -m http.server`): the live block reports SKIP. Running it here is the
  point — it exercises the end-of-day floor, which is the state the site is in most of the time.
- **Worker mode** (`npx wrangler dev`): `--require-live` turns any SKIP in the live block into a
  failure, because there a skip means the live path was never exercised.
- Every run prints **how many checks skipped and why**. A suite that quietly skips half of itself and
  reports "all passed" manufactures confidence rather than providing it.

Two checks skip when the Tailwind CDN is unreachable (offline or sandboxed CI): **33** entirely,
because `overflow-auto` is inert without the stylesheet and the body then measures 1014 against a
390 viewport — a fact about the network, not the layout; and the **pixel half of 36**, which falls
back to asserting the class contract and says so in its note.

### What the suite found on its first run

Three defects, none of which any earlier check would have caught:

- **A superseded drill panel cleared its successor's URL.** `openDrill()` begins with
  `closeDrill()`, which fires the outgoing panel's `onClose` — and that handler's job is to remove
  `?company=` from the URL. Opening a drill twice in quick succession (the cold-load path does)
  therefore left a panel open above an address bar that no longer named it, so copying the link
  shared a page with no drill on it. `closeDrill({ superseded: true })` now skips `onClose`.
  Assertion 30 is the regression test.

- **`fetchQuotes()` discarded `failed[]` on the not-ok path.** The Worker names every symbol it
  could not resolve and why; the client threw that away and kept only "upstream". So during exactly
  the outage the per-symbol detail exists to describe, `liveFailedSymbols()` was empty and the
  sources modal could say nothing about which symbols were affected. Assertion 39's degraded-upstream
  branch is what surfaced it.

- **A real weight printed as "0.000%".** Genus Prime Infra is 0.00045% of EM Small-Cap; at three
  decimals that reads as *not held*. Same company whose two flows printed "₹0 Cr". See §2.20 in
  `CLAUDE.md`; assertion 14 runs every real weight and every real flow through its formatter.

And a fourth, in the workflow rather than the application. The first CI run reported the Worker job
as **SUCCESS while every meaningful step inside it was skipped**, because `MUNS_TOKEN` is not
configured as a repository secret — a green tick over work that did not happen, which is the precise
failure this suite exists to prevent, reproduced in the thing that runs it. Guarding each *step* with
`if:` cannot express "this job did not run"; the `secret` job now turns the secret's presence into an
output and `ui-worker` guards on it at *job* level, so the checks list reads **Skipped**.

Two more runs then sat on `playwright install --with-deps chromium` for over fourteen minutes each
with no output and no deadline. Every job now carries `timeout-minutes`, and the next failure took
sixteen seconds and named itself — a probe calling `require('playwright')` without `NODE_PATH`, which
is a fact about module resolution and not about whether Chromium runs.

**Measured on the runner** (run 4): data 15 s; interface static 2 m 23 s, of which `--prove` is 86 s;
Worker job skipped. Tailwind loads there, so assertions 33 and 36 run in full — including the
computed-pixel half of 36 that has to skip in an offline sandbox.

### Assertion 39 has three branches, because a degraded upstream is neither a pass nor a fail

`/api/quotes` can be in three states, and collapsing them would make the check useless in exactly
the situation it matters:

1. **No Worker** — the static floor. SKIP, with the remedy printed.
2. **Worker and upstream both healthy** — every assertion runs: `live` then `hit`, the bogus ticker
   in `failed[]`, the real symbols resolved alongside it.
3. **Worker healthy, upstream refusing everything** — `fastapi.muns.io` answers `not_found` for
   tickers it served minutes earlier, RELIANCE included, and never says "rate limited". Measured
   again while writing this suite. Here the resolution assertions cannot run, but the important ones
   still can, and they are about **honesty rather than success**: `ok` is false, the reason is named,
   `quotes` is empty rather than fabricated, and **every requested symbol appears in `failed[]` with
   its own reason** — a dropped symbol would be an absence reported as nothing. The cache still has
   to read `live` then `hit`.

Branch 3 is deliberately specific. A vaguer version — "pass if the upstream might be down" — would
let a genuinely broken Worker through on that excuse.

The check also offsets its symbol slice at random. The cache key is a hash of the symbol set with a
30-second TTL, so a fixed slice reads `hit` on the first call of a re-run, and the cache assertion
would then be testing the previous run rather than this one.

### `--prove`: a check that cannot fail is not a check

`--prove` clones the context, applies each check's own `sabotage()`, and demands the check goes red.
A check that survives is reported **CANNOT FAIL**, as a failure. This is not ceremony — the first
`--prove` runs failed seven checks that had been passing:

- **3** — the sabotage no longer matched the pattern it was written for, after the pattern was
  tightened. It had been proving nothing since.
- **19** — the captured `rawQuote` fixture contains no comma inside any value, so a naive
  `split(',')` passed it. The fixture was real; it simply did not exercise the trap.
- **25, 27, 29, 41** — the sabotage was a one-shot DOM edit, and each check's first act re-rendered
  or reloaded the page, wiping it before a single assertion ran.
- **33** — `documentElement.scrollWidth` is pinned by the `overflow-x: hidden` backstop in
  `index.html`, so the assertion could never fail. It now measures `body.scrollWidth`, which sees
  content pushed out of view. **Clipped overflow is worse than a scrollbar, not better.** Measured
  with the stylesheet in force: body 1440/1440, 1024/1024 and 390/390, with the table scrolling
  inside its own container at the lower two.

**The same two traps caught the next two sabotages written, on 31 Aug 2026 — checks 46 and 45.**
One was new and is worth naming, because nothing about it is visible at the site of the bug:

> A `persistent()` sabotage body is a **JS template literal**, and an untagged template literal
> **silently eats an unrecognised escape**. `\d` inside one arrives in the browser as a bare `d`, so
> the sabotage's own `text.match(/[+-]?\d+/)` stopped matching digits, every cell read as "no
> number", and the sabotage **mutated nothing while throwing nothing**. `--prove` reported SURVIVED,
> and both the check and the sabotage read perfectly correctly on the page. The identical regex in
> the check body — a real function, not a string — worked fine. Backslashes inside a sabotage body
> must be doubled. A backtick inside one closes it, so the comment explaining this cannot contain
> one either.

Two of the earlier sabotages had to be repaired for a second reason, and the new pair repeated it: a
`MutationObserver` whose callback writes to the thing it observes re-triggers itself for ever, and
both hung the run rather than failing it. Checks 46 and 45 mark each cell they have already written
so the second pass is a no-op; before that, check 46 took **238 seconds** to report SURVIVED. Assigning `textContent` fires a `characterData` mutation even when the value is
unchanged, and `prepend()` is itself a `childList` mutation. Both now `disconnect()` while they
write — which also clears the pending record queue, so the reconnect is safe. **A hang is an outage
reported as nothing**, so the harness now carries a per-check deadline (60 s for data, 150 s for
the interface, against a slowest healthy check of about 12 s) and a runaway check fails on its own
line instead of stalling the run in silence.

---

## Where this model is weakest

Written down deliberately, and before a client finds it. Every layer under this model was built in
this repo, so these are not suspicions — they are the known load-bearing assumptions, ranked by how
much a portfolio manager would lose by not knowing about them.

### 1. Nothing here has ever been checked against a review

Every figure is computed from today's data. There is no backtest, no hit rate, no measured
false-positive rate, and no evidence that a `likely-inclusion` verdict has ever preceded an
inclusion. The model is *reasonable*; it is not *validated*, and those are different claims. The
section above is the route to closing this, and until it is closed, the verdict column is an
ordering of candidates and not a forecast of outcomes.

### 2. The verdict tests a necessary condition, not a sufficient one

Size is one of MSCI's screens. It also applies liquidity screens (annualised traded value ratio and
months of trading), a minimum free-float requirement, foreign-room limits, a minimum length of
listing, and buffer rules that deliberately resist churn near the boundary. **None of those are in
this model.** So the inclusion list is an *upper bound* on entries: it will contain names MSCI
passes over, and the model has no way to say which. The same is true in reverse for exclusions,
where the buffer rule is the specific thing missing — MSCI does not exclude a company the moment it
crosses a line.

### 3. Liquidity is displayed but never gates a verdict

`daysOfAdv` annotates a flow and nothing more. **30 of the 201 flows have no ADV reading at all**,
so even the annotation is incomplete. Liquidity is among the most common reasons a large-enough
company is not included, which makes this the single largest missing screen in §2.

### 4. Verdicts are sensitive to a threshold nobody published

**67 of the 148 non-stable verdicts sit within ±20% of the threshold that produced them** (39 within
±10%). The desk's band is a rule of thumb, not MSCI's rule, and a 20% move in it — well inside the
uncertainty of an unpublished heuristic — reclassifies roughly 45% of the actionable list. The
aggregate is the number that matters: *most of the interesting names are near the line, because that
is what "interesting" means here.*

This used to be readable per row from a **Distance** column on the screener. That column was removed
on 20 Aug 2026: it divided by a different threshold on almost every row while presenting one sortable
number, and within any single verdict its ordering was identical to free float. The per-row figure
survives in the drill panel — where the threshold and its value are stated beside the percentage —
and in the CSV export, which now carries the threshold's name and value in their own columns so the
sensitivity above can still be reproduced from a sheet.

### 5. The segment boundary is inferred from three funds, and a fund is not an index

Segments are derived from which iShares fund holds a company. Two consequences:

- **EM Small Cap samples.** It holds 408 of the India Small-Cap fund's 454. A company it does not
  hold may be a genuine index member the fund chose not to sample, so "not held by EM Small Cap"
  is not "not in the index". `isSampledByEmSmallCap()` keeps this visible and `flows.js` refuses to
  print a figure for a name the fund does not hold — but the underlying ambiguity is unresolved.
- **The India Small-Cap fund is treated as the small-cap roster.** It is one vendor's replication of
  one index, with its own tracking decisions.

### 6. The overlap is wide, and inside it size does not determine segment

Standard floor ₹18,521 Cr (SBI Cards), Small-Cap ceiling ₹70,169 Cr (Laurus Labs) — **3.79× wide,
157 companies inside it** (105 standard, 38 small cap, 14 unheld). Within that band, free-float size
alone cannot say which segment a company belongs to; migration verdicts there rest on the
rank-crossing test, which is a *proxy* for MSCI's actual cut-off. MSCI derives that cut-off globally
at each review and does not publish it in advance.

### 7. Most inclusion candidates are measured on the exchange MSCI does not follow

Nearly every inclusion verdict rests on a BSE float factor, because NSE publishes free float for
about 250 symbols and the candidates are by definition not among the largest. The desk's own
understanding is that MSCI follows NSE — so the rank these candidates hold is measured on the
exchange the index does not use, and the model cannot do better for them.

**This is now permanent, not pending.** It was probed exhaustively on 20 Aug 2026 — 18 pre-open keys
brute-forced, 8 API paths, the archive host, the index provider, and NSE's own JavaScript bundle.
NSE's `ALL` key returns 2,093 rows with `marketCap: "-"` on every one, and that is not a
time-of-day artefact: 258 of 258 symbols carry a number under `NIFTY`/`FO` and a dash under `ALL`
**in the same minute**. The one endpoint that would carry it for the whole universe,
`quote-equity?section=trade_info`, is Akamai-denied and stays denied through a warmed cookie
session. NSE Indices publishes an Investible Weight Factor *page*, but it is methodology only with
no per-company values, and IWF is defined only for index constituents in any case.

What the desk's 2% rule does about it: where NSE **does** publish and materially disagrees, NSE's
factor is used. That covers the large caps and nothing else. Below them, BSE is the only measurement
that exists, and the record says so on every row.

### 8. An entry flow is an estimate of a weight that does not exist yet

An **exit** flow is measured: the fund's position is a line in the workbook. An **entry** flow is
modelled — the company's weight is estimated as its free float over the segment's float total, then
multiplied by fund AUM. The segment total is itself this model's segment assignment. So an entry
flow inherits every error in §5, §6 and §7 at once. `flows.js` marks it `certainty: 'estimated'`
against the exit's `'measured-position'`; a reader who ignores that distinction will treat the two
as equally solid, and they are not.

### 9. AUM and FX are as of the holdings date, not today

`fundAumUsd` and `fxRate` both come from the committed workbooks (17 Aug 2026). A rupee flow is
right to the extent the fund has neither grown nor shrunk since. That is days now; it is months if
the fixtures are not refreshed, and nothing on screen decays to warn about it.

### 10. Share count is derived, and the reconciliation can only catch disagreements

`sharesOutstanding = fullMcapInr / price`, both from BSE, and every free-float figure multiplies by
it. `reconcile-shares.mjs` compares that against Munshot's independently derived count and
quarantined 4 companies. It finds counts that **disagree** between two sources; it cannot find one
where both sources are stale in the same way, and it cannot adjudicate an exact corporate-action
ratio without a third source — which is precisely why those 4 are quarantined rather than corrected.

### 11. The calendar is an assumption, and the snapshot date is the part that matters

`CONVENTION.confirmed` is `false`. The effective date is assumed to be the last business day of the
review month; **the price snapshot window is unconfirmed**. If MSCI strikes its snapshot weeks
before the effective date, then the distances that decide the review are the ones on *that* date,
not today's — and this model has no snapshot-date mode. It always answers "if the review were
struck on today's prices".

### 12. The candidate universe floor is provably safe; the master's timestamp is not

The BSE scrape covers every active scrip with indicative full market cap ≥ ₹2,000 Cr, plus every
held name — **978 of the 978 active scrips above the desk's ₹3,500 Cr entry band**. Free float can
never exceed full market cap, so a company below that floor cannot be an entry candidate at today's
price: the floor is safe by construction, not by luck. The soft spot is that `Mktcap` in the scrip
master is struck at an undisclosed moment. **118 active scrips sit between ₹1,500 Cr and ₹2,000 Cr**,
and one that has re-rated sharply since the master was cut would be invisible to the scrape and
therefore to the model.

### 13. Two relative readings ship side by side, and they disagree about the sign a quarter of the time

`relativePerformance` measures MSCI's price window to MSCI's price window; `sinceRebalance` measures
from the rebalance effective date to the latest close. Both are correct answers to different
questions, and on the committed record **326 of 1,174 companies (27.8%) get opposite signs from
them**, 129 with both readings above 5%. Neither is wrong; a reader who takes one for the other is.

That is a real cost of shipping both, and it is mitigated rather than removed: each names its own
window everywhere it appears, only one drives the chip beside the verdict, and the export's banner
says in as many words that the two families must never be summed or compared. **The residual risk is
a reader who sorts by one column and reasons about the other**, which no amount of labelling fully
prevents.

The second-order weakness is narrower. `sinceRebalance` is struck on **one close at each end**,
where the window reading averages ten. The sensitivity span says how fragile the baseline end is —
median 3.64 pp — but says nothing about the *latest* end, deliberately, because "today" is not a
choice. A company whose last print was an outlier carries that outlier into the delta with nothing
on screen marking it.

### What would move the needle most

In order: (1) the historical backtest in the section above — it converts everything here from
plausible to measured; (2) an ATVR liquidity screen, which is the largest missing rule and is
computable from data already fetched; (3) NSE free-float coverage beyond 261 names, which is
blocked on `/api/quote-equity` and is the reason §7 exists.

---

## Resolution: how a holding becomes a company

`scripts/lib/resolve.mjs`. Pure, deterministic, no I/O.

**Identity is ISIN.** A ticker is a label — two exchanges spell it differently, a fund vendor invents
its own codes, and codes get reused when companies delist. Attempts run in descending order of what
each one proves, and `resolution.method` records which fired:

| Order | `method` | What it matches | Rows |
| --- | --- | --- | --- |
| 0 | `confirmed` | hand-checked, pinned by ISIN, re-asserted against the master every run | 3 |
| 1 | `scrip_id` | exact BSE scrip id — BlackRock uses these directly for tickerless entities | 996 |
| 2 | `scrip_code` | exact numeric BSE scrip code | 16 |
| 3 | `isin` | ticker → NSE symbol (punctuation-normalised) → ISIN → BSE scrip | 7 |
| 4 | `name` | exact normalised name, **unique in the master or nothing** | 5 |
| — | `none` | unresolved, with a stated reason | 13 |

**The name step is unique-or-nothing on purpose.** `EMBASSY` is Embassy Office Parks REIT; a prefix
matcher pairs it with Embassy Developments Ltd (EMBDL/532832), a different company. The master also
contains 16 pairs whose normalised names are identical — an ordinary line and its partly-paid twin
(`GSAUTO`/`GSAILPP`, …) — where picking either is a coin flip. An ambiguous name is unresolved with
"ambiguous" as the reason.

**A collision refuses the build.** Two rows *of the same fund* on one ISIN means one is the wrong
company, and both rows look well-formed downstream. Across *different* funds it is normal.

**`CONFIRMED` and `NOT_LISTED`** are exported from `resolve.mjs` and copied into `companies.json` as
`handCheckedMappings` and `knownNotListed`, so the hand judgements travel with the data.

Coverage per fund lives in `companies.json → coverage.byFund`, never hand-typed anywhere.

---

## The pre-resolver baseline

`node scripts/check-naive-join.mjs` measures the naive `iShares ticker === NSE symbol` join against
the NSE free-float set alone — no resolver, no BSE — and writes nothing:

| Fund | Matched holdings | Matched India weight |
| --- | --- | --- |
| EM ETF | 152 of 165 | 96.0% |
| India Small-Cap | 36 of 461 | 21.0% |
| EM Small-Cap | 36 of 414 | 20.8% |

It exists so any claimed improvement can be checked against the unimproved figure. Re-run it rather
than quoting this table.

---

## What the interface reads

`public/js/data/companies.js` is the only reader of `companies.json`, and the only place a count on
screen may come from. Every denominator in the stat strip, the scope chip and the sources modal
traces back to the `coverage` block the build computed — nothing is typed into the markup, so no
figure can go stale when the data moves.

Three shapes the interface depends on, which later work must not break:

| Field | Interface depends on it for |
| --- | --- |
| `coverage.byFund[id].shortName` | every fund column heading and chip label |
| `funds[fundId] === null` | rendering "not held" as an em dash rather than a zero weight |
| `freeFloatBasis` | the drill's "how this figure was produced" line |

`window.__sattva` exposes `data`, `state`, `view` and `rows()` for the verification harness. It is
read-only and drives nothing a human cannot already do.

---

## Not built yet

These will get contracts in this document when they land, and not before:

- **Weight history** — quarter-on-quarter weight deltas per fund, measured rather than modelled.
  Requires storing dated snapshots of `msci-funds.json`, which nothing does yet. This is also step 1
  of "The route to a real probability" above, and the two want the same files.
- **A calibrated probability.** Deliberately absent, not overlooked. The verdict column is a label
  on rules that fired, and the route to replacing it with a fitted base rate is set out above. Until
  a backtest exists, nothing here may render a percentage of inclusion.
- **A liquidity screen.** `daysOfAdv` annotates a flow; no ATVR test gates a verdict. It is the
  largest missing MSCI rule and is computable from data already fetched.
- **A snapshot-date mode.** Every distance is struck on today's price. MSCI's own price-snapshot
  window is unconfirmed (`calendar.js`), and if it sits weeks before the effective date, that is the
  date the model should be answering on.

### Known gaps in what *is* built

- **The four REITs and the three `--` demergers have no float reading from any source here.** They
  are not a resolver failure; BSE's equity segment and NSE's pre-open set both genuinely exclude
  them. Closing this needs a fourth source, not a better matcher. **Deliberately left open** — the
  weight at stake is recorded here so it can be picked up later rather than rediscovered:

  | Holding | India Small-Cap | EM Small-Cap |
  | --- | --- | --- |
  | Embassy Office Parks REIT | 1.08062% | 0.22166% |
  | Brookfield India Real Estate Trust | 0.51300% | 0.09940% |
  | Nexus Select Trust REIT | 0.38658% | 0.08063% |
  | Mindspace Business Parks REIT | 0.27784% | 0.06713% |
  | **REIT total** | **2.25804 pp of 99.729** | **0.46882 pp of 21.271** |
  | GSPL Transmission | 0.04384% | 0.01024% |
  | Triveni Power Transmission | 0.03682% | 0.01232% |
  | Inox Renewable Solutions | 0.00177% | — |
  | **Unlisted demerger total** | **0.08243 pp** | **0.02256 pp** |

  The REITs are **2.26 pp of the India Small-Cap fund**, roughly a third of everything still
  uncovered there. The demergers are rounding error by weight and will resolve themselves when the
  entities start trading. Any future work here should target REIT free float and nothing else.
- **`nseSymbol` is only available for the 750 companies in the niftyindices lists.** A company
  resolved to a BSE scrip outside those lists carries `nseSymbol: null`, which is honest and does
  cost the NSE float comparison for that name. **The route to closing it is now measured**: 452 of
  those companies carry a BSE `scrip_id` that looks like an NSE symbol, and Munshot's per-symbol
  response confirms one directly via `Exchange === 'NSI'` plus a non-zero price — with HTTP 404 for
  impossible symbols, so it is a real existence test. A 155-company sample confirmed every candidate
  that returned data. Nothing was written from a partial pass; see the warning box in `CLAUDE.md`
  §3.9 for why the company-name test was the wrong test, and why these must land in a **separate
  field with its own provenance** rather than in `nseSymbol`.
- **Free float is a monthly snapshot re-valued daily.** The stored `floatFactor` is price-independent
  by design, and `prices.json` plus the live overlay re-value it every day. What is still monthly is
  the factor and the share count — a price arriving never restamps them, and the oldest input governs
  the freshness claim on screen.
