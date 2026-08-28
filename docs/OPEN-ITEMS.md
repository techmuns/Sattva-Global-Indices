# Open items

Ranked by what each one changes, not by how hard it is. Effort is in working days for someone who has
read `docs/HANDOFF.md`.

| Item | Effort | What it changes | Unblocks |
| --- | --- | --- | --- |
| **Historical backtest** | large (~1 week) | **The only item that changes what the model *means*.** Turns the verdict column from an ordering of candidates into a forecast with a measured hit rate. | A probability percentage; a stated false-positive rate; weight-history deltas |
| **Liveness probe** | 10 min | Closes the last unmeasured claim in the project — that the upstream quote feed actually moves intraday rather than serving a stale close. | Confidence in the "Live · NSE" pill |
| **`MUNS_TOKEN` repository secret** | 2 min | Unblocks the live CI job, which currently renders Skipped. | Assertion 39 running on every push instead of only locally |
| ~~**NSE float beyond 261 names**~~ **CLOSED — not achievable, RE-CONFIRMED 28 Aug 2026** | — | Re-probed independently on 28 Aug 2026 from a second network and reproduced exactly (see `scripts/probe-nse-reach.mjs`). New ground covered that time: **`nsearchives.nseindia.com` is a different edge policy from `www.nseindia.com` and it serves** — but what it serves is prices and identifiers, never market cap. `EQUITY_L.csv` carries symbols, ISINs and listing dates; the UDiFF bhavcopy carries 34 columns of OHLC and volume across 3,650 instruments; `sec_bhavdata_full` adds delivery. Every `MCAP*.csv` path pattern is a 404 and the `daily-reports` index that would list one is itself 403. niftyindices constituent lists carry Company/Industry/Symbol/Series/ISIN and no market cap. **NSE publishes no bulk market-cap file of any kind**, and `quote-equity` — the one surface with both numbers — stayed 403 with warmed cookies. **Settled from a GitHub Actions runner too** (egress 57.154.5.193, `.github/workflows/probe-nse.yml`): two passes ten minutes apart, both 403 on `quote-equity` and on the NSE homepage itself, so no cookie jar is obtainable there at all. Identical readings ten minutes apart rule out a throttle — the block is categorical for datacentre IPs, not machine-specific and not transient. The pre-open API, `EQUITY_L.csv` and the niftyindices lists all answered 200 from the same runner, so the runner is not blanket-blocked; only that one endpoint family is. Originally probed 20 Aug 2026: 18 pre-open keys brute-forced, 8 API paths, the archive host, the index provider and NSE's own JS bundle. NSE publishes free float for **250 symbols** and returns `marketCap: "-"` for all 2,093 rows of its `ALL` key — proved not to be a time-of-day artefact by finding 258 of 258 symbols carrying a number under one key and a dash under another in the same minute. `quote-equity?section=trade_info`, which would carry it for the whole universe, is Akamai-denied and cookie warming does not open it. NSE Indices' Investible Weight Factor page is methodology only, with no per-company values. | Weakness #7 stands and is now **permanent**, not pending. It is stated as such rather than tracked as work. |
| **Symbol expansion to all 452** | small (~1 day) | Live intraday prices for the 453 companies now stuck on their committed close. Method and controls already proven. | Live pricing for 38% of the record |
| **Liquidity and foreign-room screens** | medium (~3–4 days) | Turns an upper bound on inclusions into a real shortlist. Weakness #2 and #3. | Removing candidates MSCI would screen out on grounds other than size |
| **REIT free float** | medium (~2–3 days) | Four names, **2.26 pp of the India Small-Cap fund** — roughly a third of everything still uncovered there. | Complete coverage of the India Small-Cap fund |
| **Resolve 4 quarantined share counts** | small (~1 day) | Four companies currently carry `verdict: unknown` and no flow. | Four verdicts |
| **Confirm the MSCI review calendar** | small (~half a day) | The snapshot-date assumption, weakness #11. If MSCI strikes prices weeks before the effective date, the distances that decide the review are those from that date, not today's. | A snapshot-date mode |

---

## Detail on the two the owner must do

### Liveness probe — **not yet run**

```bash
node scripts/probe-liveness.mjs --symbols RELIANCE,HFCL,TCS --gap-seconds 600
```

Must run inside **09:15–15:30 IST, Monday to Friday**. It samples the same symbols twice, ten minutes
apart, and reports whether the prices moved. Attempted at the end of prompts 4, 5 and 6; every
attempt landed outside market hours, most recently at **01:08 IST on 20 August 2026**. It writes
nothing and is safe to run at any time — outside market hours it will simply report that the market
is closed, which is not the measurement wanted.

Put the result here when you have it.

**Related measurement that *was* taken**, and worth recording because it is the same feed: on
19 August at **23:22 IST**, `POST /api/quotes` returned `not_found` for RELIANCE, TCS and HDFCBANK
simultaneously; by **00:05** the same call resolved 6 of 6 symbols. That is the documented
`not_found`-under-load behaviour (`docs/HANDOFF.md`, trap 7), observed degrading and recovering. It
does not answer the liveness question, which is about intraday movement.

### `MUNS_TOKEN` repository secret

Settings → Secrets and variables → Actions → New repository secret, named `MUNS_TOKEN`.

Until it exists, `.github/workflows/verify.yml` resolves `needs.secret.outputs.available` to `false`
and the `Interface — Worker` job is **skipped at job level** — it renders as *Skipped* in the checks
list, deliberately, rather than as a green tick over work that did not happen. Assertion 39 is then
exercised only when someone runs the suite locally against `wrangler dev`.

The same secret is needed in production, and it is a **different** operation:

```bash
npx wrangler secret put MUNS_TOKEN     # the deployed Worker
```

Locally it lives in `.dev.vars`, which is gitignored. It must never appear in `public/`; assertion 40
fetches the served site and greps it, and CI greps every tracked file.

---

## Things deliberately not on this list

**The four REITs and three `--` demerger rows have no float reading from any source used here.** That
is not a resolver failure — BSE's equity segment and NSE's pre-open set both genuinely exclude them,
and they are a different instrument class. Closing it needs a fourth source, not a better matcher. It
is on the table above with its weight at stake so it can be picked up rather than rediscovered.

**A fuzzy ticker matcher.** It would improve the coverage table and ship a wrong row. `EMBASSY` is a
REIT that is not in BSE's equity segment at all; a prefix matcher pairs it with Embassy Developments
Ltd, a different company whose free float would then be reported as the REIT's. BSE's master also
contains 16 pairs of scrips with identical normalised names — an ordinary line and its partly-paid
twin — where picking either is a coin flip. The name step stays exact-normalised and
unique-or-nothing.

**Writing the 155 verified NSE symbols into `nseSymbol`.** They were verified against a real existence
test (`Exchange === 'NSI'` plus a non-zero price, with HTTP 404 for impossible symbols), but the pass
covered 155 of 452. `nseSymbol` is asserted from `nse-universe.json` on ISIN and nowhere else; a
second, weaker provenance smuggled into the same field would be invisible to every reader of it. A
future run should cover all 452 and land them in a **separate field carrying its own provenance** —
that is the "symbol expansion" row above.
