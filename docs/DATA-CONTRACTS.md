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
| `nseSymbol` | string \| null | **Only ever from `nse-universe.json`, keyed on ISIN.** Never inferred from BSE's `scripId`. |
| `bseScripCode` | string \| null | `null` for NSE-only listings — CDSL and BSE Ltd are real examples. |
| `fullMcapInr` | number \| null, ₹ | Tier 1, BSE. |
| `sharesOutstanding` | number \| null | **Tier 2** — `fullMcapInr / priceInr`, both BSE. |
| `priceInr`, `priceSource`, `priceAsOf` | | Tier 1, BSE. |
| `floatFactor` | number \| null | **The factor in force.** NSE's where it exists, else BSE's. |
| `floatSource` | `'nse'` \| `'bse'` \| null | Which one that is. **Travels with the number everywhere, including exports.** |
| `floatFactorNse` | number \| null | **Tier 2** — `nseFloatShares / totalShares`; see below. `null` when NSE has no reading. |
| `floatFactorBse` | number \| null | **Tier 2** — kept even when NSE wins, so the disagreement stays inspectable. |
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

## Not built yet

These will get contracts in this document when they land, and not before:

- **Weight history** — quarter-on-quarter weight deltas per fund, the input to flow estimates.
  Requires storing dated snapshots of `msci-funds.json`, which nothing does yet.
- **Flow estimates** — `Δweight × totalMarketValueUsd`. Tier 2; the formula renders with the number.
- **Review forecasts** — inclusion / exclusion / re-weight probabilities. **Tier 3**: rendered with
  the rules that fired, the thresholds used, and the fact that those thresholds are the desk's
  assumption and not MSCI's published rule. Thresholds already live in
  `public/js/config/thresholds.mjs`; nothing may add a second home for one.
- **The interface.** `public/index.html` is a placeholder that deliberately shows no figures.

### Known gaps in what *is* built

- **The four REITs and the three `--` demergers have no float reading from any source here.** They
  are not a resolver failure; BSE's equity segment and NSE's pre-open set both genuinely exclude
  them. Closing this needs a third source, not a better matcher.
- **`nseSymbol` is only available for the 750 companies in the niftyindices lists.** A company
  resolved to a BSE scrip outside those lists carries `nseSymbol: null`, which is honest and does
  cost the NSE float comparison for that name.
- **Free float is a monthly snapshot.** The stored `floatFactor` is price-independent by design, so
  a daily price re-values it — but nothing in this repo fetches a daily price yet.
