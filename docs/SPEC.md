# The product, as shipped

What is on the screen and why. For behaviour that is *data* rather than *interface*, see
`docs/DATA-CONTRACTS.md`; for the traps behind it, `docs/HANDOFF.md`.

---

## 1. Navigation and scope

One route: `#/companies`. `public/js/core/router.js` owns the hash and holds two parameters.

**`scope`** — the toggle in the header, `Held` / `All`.

| | Rows | Means |
| --- | --- | --- |
| `Held` | 619 | held by at least one of the three funds |
| `All` | 1,202 | every company in the record, held or not |

The scope is a genuine filter on the record, not a view of a subset — the denominator on screen
changes with it and every count reads **"X of Y"**. The 583 unheld companies are the inclusion
candidates; without `All` there is nothing to forecast.

**`company=<ISIN>`** — mirrors the open drill panel, so a row can be shared. Arriving at that URL by
paste, by Back, or by reload opens the panel. Keyed on **ISIN**, never a ticker: a ticker is a label,
two exchanges spell it differently, and codes get reused when companies delist.

---

## 2. Design tokens

Declared once in `public/index.html` and nowhere else. Light theme only. Tailwind from the CDN — no
CSS build.

```
Brand    --brand-500 #6366f1 → --brand-mid #a855f7 → --brand-end #ec4899
Semantic --positive #059669  --caution #d97706  --negative #e11d48  --neutral #64748b
Page     --page-bg  #f8fafc
```

**The brand ramp carries no meaning.** It marks the product — the wordmark, the gradient a stat card
gets when it sets `hero` — and nothing else. A verdict, a day change, a data-quality warning: all
semantic, never brand. This is enforced, not just documented: **assertion 36** samples a pill for each of the eight verdicts and
fails if any carries an indigo utility class or computes to an indigo pixel. Measured on the shipped
build: 4 colour families (emerald, amber, rose, slate), 0 indigo.

Typography is **Inter** for body with **Plus Jakarta Sans** for display headings, both from Google
Fonts; numbers are tabular throughout, because columns of figures that do not align are columns
nobody scans.

---

## 3. The screener

**Stat strip**, four cards on one row, each with a denominator:

| Card | Shows |
| --- | --- |
| Companies in view | rows in view of rows in the record · held / candidates |
| Segment move since the last review | each tracking fund's price return **in rupees**, and why a rising segment raises the bar |
| Free-float coverage | how many rows in view carry a reading · from BSE, from NSE, none |
| Review outlook | inclusion candidates · exclusion risks · migrations, of the rows in view |

Every figure in those cards is derived from `companies.json` at render time; none is typed here,
because a figure typed into a doc goes stale on the next refresh (CLAUDE.md §2.5).

A **Data freshness** card used to sit here as a fifth, gradient tile naming all four feeds and their
dates. It was removed on 25 Aug 2026 so the strip fits one row. The disclosure did not go with it:
the **header pill names the oldest input on every branch** — `headerStatus` builds that clause in one
place precisely so a branch cannot drop it, and one already had — and the **data-sources modal**
behind that pill lists every feed with its as-of date, its cadence and its own staleness threshold.
The pill still names the *oldest* input rather than the newest. A live price does not make a
month-old float factor live. Assertion 38 reads both surfaces; it does not read the tile.

**Columns**: Company · Verdict · Free float (₹ Cr) · Day % · Float % · Full mcap (₹ Cr) ·
EM wt % · India SC wt % · EM SC wt % · Funds.

There is no **Distance** column, and its removal on 20 Aug 2026 is worth recording because the
reasoning generalises. It showed a company's free float as a percentage above or below *the
threshold that decided its verdict* — and that threshold is a different number on almost every row
(₹4,000 Cr for inclusion candidates, ₹2,000 Cr for exclusion, ₹2,400 or ₹3,500 Cr for the two ways a
company can be `stable`, ₹26,951 Cr for a migration). One sortable column, five denominators, a
range from −99.8% to +46,136.9%. Sorted descending it put the biggest inclusion candidates on top,
which reads as "most likely" and actually means "furthest above the band".

And within any single verdict the denominator is constant, so the ordering was a monotone transform
of free float — measured, identical to the free-float ordering for all seven verdicts that carry a
distance. It was redundant where it was coherent and incoherent where it was not. The per-row
sensitivity it existed to show now lives in the drill panel, which states the threshold and its
value beside the percentage, and in the CSV export, which carries both.

Every weight column names its fund. There is no combined weight column and there never will be — the
three funds have different denominators and no arithmetic relates them. Assertion 3 greps the
codebase for cross-fund weight aggregation.

**Filters**, four, and they **AND** rather than replace: Fund · Market cap · Verdict · Watchlist.
Assertion 26 exercises each one alone and then asserts that two together produce exactly the
intersection.

Two of them changed on 25 Aug 2026 and the reasoning is worth keeping.

**Float source was removed.** It offered NSE / BSE / no reading, and the same fact is on every row
already — the source chip in the float column, and the drill panel, which names the rule that chose
between the two exchanges and keeps both factors. A filter is worth a slot in the toolbar when it
answers a question the columns cannot.

**Size band became Market cap.** It used to slice *free float* at the desk's own review cut-offs
(₹2,000 / ₹2,400 / ₹3,500 / ₹4,000 Cr), which put four of its five boundaries inside a ₹2,000 Cr
window and made it useless for navigating a universe that spans four orders of magnitude. It now
slices **full market cap** into five wide, round ranges — `< ₹10,000`, `₹10,000–30,000`,
`₹30,000–70,000`, `₹70,000–2,00,000`, `≥ ₹2,00,000 Cr` — which between them cover every company that
has a reading.
The boundaries live in `MARKET_CAP_FILTER_BANDS` in `public/js/config/thresholds.mjs`, beside the
review thresholds but explicitly *not* of them: no rule reads them and they decide nothing.

A company with **no** market-cap reading matches no band in either direction, and the note under the
filters says how many that is — derived, not typed. Putting it in the bottom bucket would report an
absence as a fact.

The **Fund** filter's `held by none` became `held by all`, and the note under it discloses what that
currently matches. The answer is zero and it is structural, not a data gap: the EM ETF tracks the
standard segment and the two small-cap funds track small caps, so a company is in one or the other
and never both. An option that can only return an empty table has to say so where the reader picks
it, or the empty table reads as a finding about the companies.

**Table behaviour**: sort by any column, ascending and descending, with **missing values sorting last
in both directions** — a null is not a zero and must not rank as one. Rows stream in so 1,202 rows do
not block the main thread, and `data-rows-pending` clears when the fill completes; that attribute is
what the test suite waits on, never a sleep. A live price tick repaints **only the rows whose price
moved** and leaves the reader's search, filters, sort and watchlist untouched.

**Wide content scrolls inside its own container**; the page body never scrolls sideways. Measured
with the stylesheet in force: body 1440/1440, 1024/1024, 390/390, with the table scrolling internally
at the lower two.

---

## 4. The drill panel

Seven sections, in this order:

1. **Identity** — name, NSE symbol, BSE scrip code, ISIN, sector and where the sector came from.
2. **Assessment** — the verdict, the distance, and the **rules table**: each rule's input, threshold,
   threshold *source*, and result. This sits above Free float deliberately: it is the modelled
   content, and a reader must meet its working before its conclusion.
3. **Free float** — the factor, the source exchange, both factors where NSE and BSE disagree, and the
   formula that produced the rupee figure.
4. **Index participation** — the per-fund weight, quantity and market value. Not held renders as an
   em dash with a title saying so.
5. **Weight drift — no trade required.** Named that way in the heading, not in a footnote.
6. **Flow primitives — inputs, not results.** Fund AUM and FX rate, both as of the holdings date.
7. **Provenance** — the three tiers, each naming what on this row belongs to it.

Focus is trapped inside the panel, ESC closes it, and focus returns to the row that opened it.

---

## 5. The model

### Segments

Derived from fund membership, never assumed: **Standard 165 · Small Cap 454 · outside 583.**
Verified disjoint on every build — EM ∩ India SC = 0, EM ∩ EM SC = 0 — because a future holdings file
that breaks the pattern would invalidate the derivation.

**EM Small-Cap samples; India Small-Cap replicates.** EM SC holds 408 of India SC's 454 India
companies and zero that India SC lacks. So an entry draws a flow from India Small-Cap for certain and
from EM Small-Cap **only if that fund already samples the company**. Where it does not, the output is
**"not sampled"** — never zero. Assertion 11 asserts no EM SC flow exists without a holding.

### Two thresholds, deliberately not reconciled

| | Source | Answers | Measured |
| --- | --- | --- | --- |
| **Desk bands** | `public/js/config/thresholds.mjs` | index **entry and exit** | ₹3,500–4,000 Cr inclusion, ₹2,000–2,400 Cr exclusion |
| **Observed boundary** | current constituents | **which segment** | Standard floor ₹18,521 Cr (SBI Cards), Small Cap ceiling ₹70,169 Cr (Laurus Labs) |

They are an order of magnitude apart because they are different boundaries, not competing estimates.
0% of Standard constituents, 20% of Small Cap and 85% of unheld companies fall below ₹3,500 Cr — the
desk band sits exactly at the unheld/Small-Cap line. The overlap between floor and ceiling is 3.79×
wide and contains 157 companies; inside it, size alone cannot say which segment a company belongs to.

**The desk bands are the desk's rule of thumb, not MSCI's published rule**, and every surface using
them says so in words the reader sees.

**The observed floor cannot classify a constituent — it *is* one.** "Is this Standard constituent
below the Standard floor?" can never be true. Migration therefore uses a **rank crossing against the
whole universe**: MSCI Standard holds N India names, so take the top N companies by free float across
the entire record. A Standard constituent outside that top N has been overtaken; a non-Standard
company inside it has overtaken. Each is measured against the *other* segment and the unheld
universe, never against its own segment's own extremum.

### Verdict vocabulary

| Verdict | Count | Means |
| --- | --- | --- |
| `stable` | 1,052 | comfortably inside its segment; no trade implied |
| `likely-inclusion` | 72 | unheld, above the desk's upper entry band |
| `possible-inclusion` | 15 | unheld, between the two entry bands |
| `migration-up` | 12 | a Small Cap constituent now ranking inside Standard |
| `migration-down` | 19 | a Standard constituent overtaken out of the top N |
| `exclusion-risk` | 16 | held, below the desk's upper exit band |
| `likely-exclusion` | 11 | held, below the desk's lower exit band |
| `unknown` | 5 | an input we do not trust — no verdict offered |

**There is no probability, and that is a decision rather than an omission** — see
`docs/CLIENT-BRIEF.md` §2. Every verdict carries `rulesFired`, and `verdictFromRules()` replays the
verdict from that record alone; the build asserts the replay matches for all 1,202 companies.

`unknown` is reserved for a suspect input. Four companies have share counts that disagree between two
sources by an exact corporate-action ratio, which proves a corporate action is involved but not which
side is stale; they are quarantined rather than guessed, and carry no verdict and no flow.

### How flows are priced

**Only a trade-implying verdict gets a rupee figure.** `stable`, `unknown` and passive drift produce
none, ever.

| Shape | Certainty |
| --- | --- |
| **Exit** — the whole current position | nearly a **measurement**: the holdings file states it exactly |
| **Entry** — a new position | **estimated**: target weight = company free float ÷ segment total free float, both shown |
| **Migration** | **two flows, never netted** — small-cap funds sell, EM buys, on different days for different reasons |
| **Not sampled** | no figure at all, and it says so |

`daysOfAdv` is the number a trader acts on. Where average daily volume is unknown it is **`null`** and
renders as an em dash — never zero, never "instant". 30 of the 201 flows are in that state.

### The review calendar is an assumption

MSCI reviews quarterly in February, May, August and November; that much is public. The **exact
effective date and the price-snapshot convention are not things this project can cite.** They live in
`public/js/model/calendar.js`, every surface says "assumed", and correcting them is a one-line edit.

---

## 6. The honesty rules, as they appear on screen

These are the product, not decoration around it. The full doctrine is `CLAUDE.md` §2.

- **Three tiers never look alike.** Measured, derived and modelled are visually and verbally
  distinct, and the drill's Provenance section names which of this row's figures belong to each.
- **Missing is never zero.** Absent renders as an em dash with a title saying *which kind* of missing;
  it is excluded from every total and denominator, and sorts to its own group at the end in **both**
  directions.
- **A real value is never rounded to nothing.** Every formatter that can meet a small number carries a
  floor — `<₹0.01 Cr`, `<0.001%`, `<1` — because "₹0 Cr" reads as *no flow* and "0.000%" reads as
  *not held*. A genuine zero still prints as zero.
- **A failure is not an absence.** A blocked scrape, a 403, an expired session each reach the screen
  in those words. The sources modal names which feed failed and why.
- **Always print the denominator.** Every count reads "X of Y", and no figure in any caption or
  heading is typed by hand — all derive from the module that owns the data.
- **Provenance survives an export.** Seven banner rows lead every CSV, including
  *"VERDICTS ARE MODELLED BY US. They are not MSCI's decision and not probabilities."* A filtered
  export says which filter produced it.
- **Live is claimed only when a byte arrived**, and only during 09:15–15:30 IST. Otherwise the pill
  reads "Last close · BSE" with the trade date.

---

## 7. Where this model is weakest

Twelve ranked, measured limits — no backtest, size is necessary but not sufficient, liquidity never
gates a verdict, 64 of the 145 non-stable verdicts sit within ±20% of their threshold, and more.

**They live in `docs/DATA-CONTRACTS.md` → "Where this model is weakest" and are not duplicated here.**
Read them before quoting anything on this screen to someone who will act on it.
