# Sattva Index Flows — what it does, and what it does not

For the person who wrote the requirements. No engineering vocabulary. Two pages.

---

## 1. What the dashboard answers today

It covers **every listed Indian company worth more than ₹2,000 Cr — 1,202 of them.** Of those,
**619 are held** by at least one of the three iShares funds it follows, and 583 are not held by any
of them but are large enough to be candidates.

For each company it shows:

- **Its free-float market cap** — the part of the company that actually trades, which is what index
  weights are built from. This is the exchange's own published figure, carried through unchanged.
  NSE publishes it for 261 companies; BSE publishes it for the rest. **Every row says which exchange
  its figure came from**, because the two exchanges define float slightly differently and do not
  agree.
- **Which MSCI segment it sits in** — Standard, Small Cap, or held by none of the funds.
- **Its weight in each of the three funds**, side by side. A blank means *not held by that fund*.
  It never means zero.
- **How far it is from the size thresholds**, as a percentage. This is the column that ranks the
  watchlist: the companies worth looking at are the ones close to a line.
- **An estimated rupee flow and how many days of normal trading volume it represents** — but only
  where a threshold crossing is implied. A company sitting comfortably inside its segment gets no
  rupee figure at all, because no trade is implied.

Prices update through the day while the market is open. Everything else — the float figures, the
share counts — is a monthly snapshot, and the screen always tells you the date of the oldest
ingredient rather than the freshest.

---

## 2. Two places we deliberately did not build what was asked

### §6 — Weight drift does not cause buying

The requirement asked for the rupee flow caused by a stock's weight rising. **We built the drift
column, but it carries no rupee figure, and it is labelled "no trade required".** Here is why, using
a real company in the current data.

The India Small-Cap fund owns **744,872 shares of Laurus Labs**, worth **₹134.8 Cr**. Between
17 and 19 August the share price moved, and Laurus's weight in that fund went from **1.82991% to
1.83008%**.

**The fund bought and sold nothing. It still owns 744,872 shares.**

That is not an oversight in the fund; it is how index tracking works. The fund holds a fixed number
of shares. When the price rises, the value of its holding rises — and the index weight it is
tracking rises by *exactly the same proportion*, because the index is built from the same prices.
The two move together, so there is nothing to correct. A weight that rises on price alone generates
no trade at all, ever.

The trade comes at a **review**, when the index's own inputs change. Laurus is currently the largest
company in the small-cap fund. If MSCI moves it up into the Standard segment at a review, then on
one day the small-cap funds must sell **the whole ₹148.6 Cr position** and the EM fund must buy
**about ₹1,288.6 Cr** — roughly **nine times as much**.

*Every figure above is on the dashboard: open Laurus Labs, and the position is under "Index
participation", the weight movement under "Weight drift — no trade required", and the two flows under
"Assessment".*

So the relationship is this: **outperformance is the leading indicator; the threshold crossing is the
cause.** A stock that keeps outperforming will eventually cross a line, and that crossing is the
event worth ₹1,288 Cr. The drift itself is worth nothing.

We show drift anyway, because watching it is how you spot a company walking toward the line months
before it gets there. But we never multiply it by fund size and print rupees, because that number
would describe a trade that nobody makes — and it would be the largest number on the screen.

### §8 — No probability percentage

The requirement asked for the probability that a company is included or excluded at the next review.
**We do not print one.** This is not caution; it is that the number cannot be honestly produced from
what this project has.

A probability needs a **base rate**: of all the companies that have historically sat this far above
the line, how many were actually included? A base rate needs history. This project has **one holdings
file per fund** — a single snapshot of today. There is nothing in it from which a hit rate can be
calculated. "68% likely" would be invented precision, and it would be the one number on the dashboard
that nobody — including us — could check.

What you get instead is a **banded verdict with its full working attached**. Every company is labelled
*likely inclusion*, *possible inclusion*, *migration up*, *migration down*, *exclusion risk*,
*likely exclusion*, *stable*, or *unknown* — and clicking it shows exactly which rules produced that
label: what number went in, what threshold it was measured against, **whose assumption that threshold
is**, and what the comparison returned. You can disagree with a verdict by disagreeing with a rule,
which you cannot do with a percentage.

The verdicts are also honest about their own bands. The ₹3,500–4,000 Cr inclusion and
₹2,000–2,400 Cr exclusion cut-offs are **your desk's rule of thumb, not MSCI's published rule** —
MSCI derives its size cut-offs globally at each review and does not publish them in advance. Every
screen that uses those numbers says so.

**The upgrade path to a real percentage exists and is not exotic.** BlackRock publish dated holdings
files. Fetch roughly three years of month-end files for the three funds; comparing consecutive files
reconstructs every entry, exit and segment migration that actually happened. Then, using daily
closing prices, reconstruct how far each of those companies was from the line at the time. That gives
a genuine curve: *companies this far above the line were included X% of the time*. Roughly a week of
work, and the output would be **checkable against what MSCI actually did** — which is the entire
difference between it and a number invented today.

---

## 3. What it cannot tell you

Four limits that would change a decision. All four are measured, not guessed.

**Size is necessary but not sufficient.** MSCI also screens liquidity, how much of a company
foreigners may still buy, minimum float, and how long a company has been listed. **None of those are
in this model.** So the inclusion list is an *upper bound*: it contains companies MSCI will pass over,
and the tool cannot say which. Treat it as a shortlist to research, not a prediction.

**Nothing here has been checked against an actual review.** Every figure is computed from today's
data. There is no track record, no hit rate, and no evidence that a "likely inclusion" verdict has
ever preceded an inclusion. The model is reasonable; it is not validated, and those are different
claims.

**Most inclusion candidates are ranked using BSE's float figure, and MSCI follows NSE.** NSE
publishes free float for only 261 companies — the largest ones. Inclusion candidates are by
definition not among them, so **72 of the 87 inclusion verdicts rest on BSE's number.** The two
exchanges disagree by about 1% on a large company; on a small one the gap is unmeasured.

**An exit is nearly a measurement; an entry is an estimate.** When a company leaves an index, the
fund sells the position it already holds, and that position is stated exactly in the holdings file —
that number is close to a fact. When a company *enters*, we have to estimate the weight it will be
given, from its share of the segment's total float. Both numbers appear on screen, but the drill panel
marks which is which, and they do not deserve equal confidence.

---

## 4. What it would take to close each gap

| Gap | Effort | What you would get |
| --- | --- | --- |
| **No track record** | ~1 week | The single change that alters what the tool *means*: verdicts stop being an ordering and become a forecast with a measured hit rate. Needs historical holdings files, which BlackRock publish. |
| Liquidity and foreign-room screens | ~3–4 days | Turns the inclusion list from an upper bound into a real shortlist. The data for the liquidity half is already being fetched. |
| NSE float beyond 261 companies | ~2–3 days, and may not be possible | Would rank candidates on the exchange MSCI actually follows. Blocked on an NSE endpoint that currently refuses server requests; may need a licensed data source. |
| Confirming the review calendar | ~half a day, mostly reading | The tool assumes the review takes effect on the last business day of the month, and assumes nothing about which day's prices MSCI uses. If MSCI strikes its prices weeks earlier, the distances that matter are those from that date, not today's. |
| Four companies marked "unknown" | ~1 day | Their share counts disagree between two sources by an exact corporate-action ratio, so we quarantined them rather than pick a side. A third source settles each one. |
| Property trusts (REITs) | ~2–3 days | Four names, 2.26% of the India Small-Cap fund, with no float figure from any source used here. They are a different instrument class, not a matching failure. |

---

## In one line

**This tool tells you, accurately, where every large Indian company stands relative to the lines that
matter, and what it would cost the funds if a line were crossed today. It does not tell you whether
MSCI will cross it.** Nothing on the screen should be read as more confident than that.
