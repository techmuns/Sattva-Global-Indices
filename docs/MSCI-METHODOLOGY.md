# What MSCI actually does, and where our model differs

**Source.** MSCI Global Investable Market Indexes Methodology, **August 2026**, 192 pages, from
`https://www.msci.com/index/methodology/latest/GIMI`, read 24 Aug 2026. Every rule below cites its
page. Nothing here is inferred from market behaviour or from memory.

**The indexes we are actually forecasting**, verbatim from the iShares fund pages (24 Aug 2026):

| Fund | Index | Segment | Holdings |
| --- | --- | --- | --- |
| EEM | MSCI Emerging Markets Index | Standard | 1,196 |
| SMIN | MSCI India Small Cap Index | Small Cap | 461 |
| EEMS | MSCI Emerging Markets Small Cap Index | Small Cap | 1,692 |

SMIN's stated 461 holdings match the India row count in our committed workbook exactly.

---

## 1. How a company gets into an index

Four stages, in order (§2, pp. 14–31).

**1. Equity Universe** — every listed equity, classified by country.

**2. Market Investable Equity Universe** — seven investability screens (p. 17):

| Screen | Rule | Page |
| --- | --- | --- |
| Equity Universe Minimum Size | Full mcap ≥ the company at 99% cumulative free-float coverage of the **DM** Equity Universe | 17 |
| Minimum Free Float Mcap | see §3 below | 18 |
| **EM Minimum Liquidity** | **15%** 3-month ATVR, **15%** 12-month ATVR, **80%** 3-month Frequency of Trading, over 4 consecutive quarters | 19 |
| **Global Minimum FIF** | **FIF ≥ 0.15** | 21 |
| Minimum Length of Trading | IPO seasoning | 21 |
| Minimum Foreign Room | headroom under foreign ownership limits | 21 |
| Financial Reporting | | 22 |

**3. Size segments** — coverage targets, in **free-float-adjusted** market cap (p. 24):

- Large Cap **70% ± 5%**
- Standard **85% ± 5%**
- IMI **99% (+1% / −0.5%)**

Mid Cap is Standard minus Large. **Small Cap is IMI minus Standard — a residual, not a band.** A
company is in Small Cap because it is investable and *not* in Standard.

**4. Final size-segment investability requirements** (§2.3.6, pp. 29–31).

---

## 2. ⚠ The distinction this project had wrong

**The Market Size-Segment Cutoff is a FULL market capitalisation figure.** The coverage targets are
measured in free float; the cutoff that falls out of the procedure is not. From MSCI's own worked
example (p. 28):

> "companies are counted in descending order of **full market capitalization** … until the cumulative
> **free float-adjusted market capitalization** … reaches 85% … the full market capitalization of the
> last company counted (USD 4.1 billion) defines the Market Size-Segment Cutoff"

Our model compares **free-float market cap** against the desk's rupee bands. That is one quantity
where MSCI uses two:

1. **size segment** — full mcap vs the cutoff, with buffers;
2. **a separate free-float test** — free-float mcap ≥ 50% of that cutoff.

This is the largest known gap between this model and the index it forecasts, and closing it needs
something we do not have: India's Market Investable Equity Universe ranked by full mcap with MSCI's
own float factors.

---

## 3. The buffer zones — the structure the model was missing entirely

§3.1.5.1, pp. 44–45:

> "An existing constituent is generally allowed to remain in its current size-segment even if its
> company full market capitalization falls below (above) the Market Size-Segment Cutoff … as long as
> it falls within a buffer zone … defined with boundaries of **2/3rd of and 1.5 times** the Market
> Size-Segment Cutoff."

So migration is **asymmetric and hysteretic**:

- an **existing** constituent leaves only below **2/3 (−33%)** of the cutoff;
- a **non-constituent** enters only above **1.5× (+50%)** of the cutoff.

Named buffers: Large Cap / Mid Cap-Standard / Small Cap Lower Buffers (−33%); Mid Cap, Small Cap and
Small Cap **Entry** Buffers (+50%).

**Index entry is competitive, not absolute** (p. 44). A non-constituent above the Small Cap Entry
Buffer is added *"only to the extent that they replace current constituents which have fallen below
the Small Cap Lower Buffer."* Clearing the bar makes a company **eligible**; it does not make it
**included**. Nothing in our model can see this, which is precisely why an inclusion verdict here can
only ever be a candidacy.

**Free-float relief for incumbents** (p. 45): existing constituents may stay at **2/3** of the
minimum free-float requirement; existing Small Cap constituents must keep **FIF ≥ 0.15**.

---

## 4. The desk's bands, measured against MSCI's

MSCI publishes the **Global Minimum Size Reference** (p. 26, data as of the close of 20 July 2026).
EM is defined as exactly half of DM (p. 25). The actual cutoff sits somewhere in **0.5× to 1.15×**
the Reference (p. 24). Converted at USDINR 95.685 (21 Aug 2026):

| EM segment | Reference | Cutoff range (**full** mcap) |
| --- | --- | --- |
| Large Cap | USD 26,939 mn | ₹1,28,883 – 2,96,431 Cr |
| Standard | USD 8,138 mn | ₹38,934 – 89,549 Cr |
| **IMI (Small Cap floor)** | **USD 617 mn** | **₹2,952 – 6,789 Cr** |

Applying the 50% free-float rule to that IMI range, and the 2/3 incumbent relief:

| | MSCI-derived (free float) | The desk's band |
| --- | --- | --- |
| New entrant | ₹1,476 – 3,395 Cr | **₹3,500 – 4,000 Cr** (inclusion) |
| Existing constituent | ₹984 – 2,263 Cr | **₹2,000 – 2,400 Cr** (exclusion) |

Two things follow, and they point in opposite directions:

- **The desk's exclusion band is well placed** — it sits at the top of MSCI's incumbent range, i.e.
  slightly conservative, which is the right way to be wrong about an exit.
- **The desk's inclusion band may be set too high.** It begins above the top of MSCI's new-entrant
  range, so the screen may be missing candidates MSCI would consider.

And the geometry is a close hand-fit: MSCI's entry-to-exit ratio is `1.5 ÷ (2/3) = 2.25`; the desk's
`4,000 ÷ 2,000 = 2.00`.

> **This is indicative, not conclusive.** The Reference is a *global EM* figure; India's own cutoff
> is set by India's 99% coverage point and could sit anywhere in the range, or outside it. Do not
> re-cut the desk's bands on this table alone.

---

## 5. ⚠ The review is decided a month before it happens

§3.1.9, p. 49 — three cutoff dates, all published:

| Cutoff | When | Used for |
| --- | --- | --- |
| Equity Universe | last business day, **3 months** before | universe, minimum size |
| Liquidity | last business day, **2 months** before | ATVR, frequency of trading |
| **Price** | **any one of the last 10 business days of the month before** | **market caps**, FIF, NOS |

For the **August 2026** review that is **20–31 July 2026** — and **MSCI does not publish which of
those ten days it used.**

This project previously recorded the snapshot window as "unconfirmed". It is confirmed, and the
consequence is sharp: once the window has closed, a verdict computed on today's price describes
where a company stands **now**, not the snapshot MSCI has already taken. The screener says so
explicitly whenever the window is in the past.

**Independent corroboration:** our computed August-2026 window opens on 20 July 2026 — exactly the
date MSCI stamps its own August size-reference table (p. 26). Two unrelated parts of the book agree.
`verify-data` assertion 28 asserts this.

**All four reviews have been comprehensive since February 2023** (p. 152). Before that, May and
November were Semi-Annual Index Reviews and February and August were lighter Quarterly Index
Reviews. Treating all four alike is right for the current book and wrong for anything historical.

---

## 6. What we can and cannot do with this

**Now implemented**

- `public/js/config/msci-methodology.mjs` — every rule above, cited to a page, kept strictly apart
  from the desk's heuristics in `thresholds.mjs`.
- The review calendar carries MSCI's real cutoff dates instead of an assumption.
- The screener states the price window and warns when it has closed.
- Assertions 28 and 29, each proved by breaking it.

**Known gaps, in the order they cost us accuracy**

1. **Full vs free-float mcap.** We test one quantity; MSCI tests two. Closing this needs India's
   Market Investable Equity Universe ranked by full mcap.
2. **No buffers in the verdict.** We have MSCI's −33% / +50% geometry on the record but the verdict
   still uses flat bands, so we over-predict migration in both directions.
3. **Entry is competitive.** We cannot model "replaces a constituent that fell out", so an inclusion
   verdict is a candidacy and is labelled as one.
4. **FIF ≠ exchange free float.** FIF also carries foreign ownership limits. Close for most Indian
   companies, not for any near a sectoral FDI cap.
5. **ATVR ≠ our ADV.** We hold a 3-month average daily volume from a third party. MSCI uses the
   Annualised Traded Value Ratio. Different measure; not substitutable.
6. **The deciding price is a day we do not know**, inside a ten-day window.

**What would move the needle most:** a full-market-cap ranking of the Indian investable universe. We
already fetch full market cap for 1,226 companies from BSE — the missing pieces are MSCI's
investability screens and its float factors, not the market caps.
