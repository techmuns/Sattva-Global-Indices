/**
 * resolve.mjs — iShares holding -> ISIN -> NSE symbol + BSE scrip code.
 *
 * Pure functions, no I/O, no network. Everything here is deterministic given
 * the three reference sets it is handed, so it can be reasoned about and
 * re-run without touching an endpoint.
 *
 * ---------------------------------------------------------------------------
 * WHY ISIN, AND WHY THE ORDER MATTERS
 * ---------------------------------------------------------------------------
 * A ticker is a label. Two exchanges spell it differently, a fund vendor
 * invents its own codes for entities that have no ticker yet, and codes get
 * REUSED when companies delist. An ISIN is a real identifier. So ISIN is the
 * key everything is carried on, and the ticker is only ever a way of finding
 * one.
 *
 * Attempts run in descending order of how much they prove:
 *
 *   1. `scrip_id`  — exact match against BSE's own scrip id. BlackRock uses
 *                    these directly for entities with no NSE ticker (TMCV,
 *                    VAML, ENRIN are all real BSE scrip ids), so this is not a
 *                    coincidence match, it is the intended key.
 *   2. `scrip_code` — exact match against the numeric BSE scrip code, which is
 *                    what BlackRock prints for rows whose Exchange is 'Bse Ltd'.
 *   3. `isin`      — the ticker, punctuation-normalised, looked up in the NSE
 *                    universe to get an ISIN, then the ISIN looked up in the
 *                    BSE master. This is what rescues NAM.INDIA (NSE spells it
 *                    NAM-INDIA) and every NSE-only listing.
 *   4. `name`      — exact match on a normalised company name, and ONLY when
 *                    that normalised name is unique in the BSE master. This is
 *                    the weakest attempt and it is deliberately unforgiving.
 *
 * ---------------------------------------------------------------------------
 * WHY THE NAME STEP IS EXACT AND NOT FUZZY
 * ---------------------------------------------------------------------------
 * A prefix or fuzzy matcher looks better on a coverage table and is how you
 * ship a wrong row. Two live examples from this dataset:
 *
 *   - `EMBASSY` is EMBASSY OFFICE PARKS REIT, which is not in BSE's equity
 *     segment at all. A prefix matcher pairs it with "Embassy Developments Ltd"
 *     (EMBDL / 532832) — a completely different company, whose free float would
 *     then be reported as the REIT's.
 *   - BSE's master contains 16 pairs of scrips whose normalised names are
 *     identical: an ordinary line and its partly-paid twin (GSAUTO/GSAILPP,
 *     APLAB/APLABPP, ...). Picking either is a coin flip.
 *
 * So: normalised-exact, unique-or-nothing. An ambiguous name is an unresolved
 * holding with "ambiguous" stated as the reason, not a guess.
 *
 * ---------------------------------------------------------------------------
 * DEMERGED ENTITIES MUST NEVER MAP TO THEIR PARENTS
 * ---------------------------------------------------------------------------
 * The workbooks contain recently-demerged companies whose NAMES are nearly
 * their parents'. TMCV is named "TATA MOTORS LTD" in the file but is the
 * demerged commercial-vehicles company with its own new ISIN, not the parent.
 * Mapping it to the parent would attach the wrong float, the wrong market cap
 * and the wrong index membership to a real position. The CONFIRMED table below
 * pins each of these by ISIN so no future change to the name matcher can
 * re-point them, and NOT_LISTED pins the ones that must stay unresolved so a
 * later run cannot "resolve" them onto a same-named listed company.
 */

/**
 * Hand-checked mappings, pinned by ISIN.
 *
 * Each entry says who checked it and what the evidence was. A mapping in here
 * is asserted against the reference data at run time — if BSE's master stops
 * agreeing, the run fails rather than quietly falling through to a weaker
 * attempt. These are not overrides that bypass the resolver; they are claims
 * the resolver must keep proving.
 *
 * Checked by: Claude, 2026-08-19, against the BSE scrip master captured the
 * same day. Evidence in each `why`.
 */
export const CONFIRMED = [
  {
    ticker: 'TMCV',
    isin: 'INE1TAE01010',
    bseScripCode: '544569',
    why: "demerged Tata Motors commercial-vehicles entity. BlackRock's ticker is BSE's own scrip_id. "
      + "Its ISIN is INE1TAE01010, NOT the parent Tata Motors' — it must never map to the parent.",
  },
  {
    ticker: 'VAML',
    isin: 'INE1CDF01017',
    bseScripCode: '544780',
    why: 'demerged Vedanta Aluminium Metal Ltd. Separate listed company from Vedanta Ltd; separate ISIN.',
  },
  {
    ticker: 'ENRIN',
    isin: 'INE1NPP01017',
    bseScripCode: '544390',
    why: 'demerged Siemens Energy India Ltd. Separate listed company from Siemens Ltd; separate ISIN.',
  },

  // ---- the four REITs, moved here from NOT_LISTED on 20 Aug 2026 ----------
  //
  // They sat in NOT_LISTED with the reason "REIT — not in BSE's equity segment
  // and not in the NSE free-float set". The first half was true and the
  // conclusion drawn from it was wrong: BSE's `segment=Equity` filter excludes
  // REITs and InvITs, but BSE PUBLISHES MktCapFull AND MktCapFF FOR ALL OF THEM.
  // Nothing was asking, because the scrip master was fetched through that
  // filter. Measured 20 Aug 2026: 24 of 24 InvIT/REIT codes returned a usable
  // factor and 24 of 24 confirmed their ISIN through BSE's own ComHeader.
  //
  // Pinned rather than left to the matchers, for the reason the old NOT_LISTED
  // entry gave: EMBASSY must never be matched to Embassy Developments Ltd
  // (EMBDL / 532832), a different company with a similar name. A pin is exact
  // and, unlike a comment, it is ASSERTED against the master on every run.
  //
  // Note the ISIN series. A REIT unit is INE…25… and an equity share is INE…01…,
  // so Embassy Office Parks REIT (INE041025011) and Embassy Developments Ltd
  // could not collide even if a matcher tried.
  {
    ticker: 'EMBASSY',
    isin: 'INE041025011',
    bseScripCode: '542602',
    why: 'Embassy Office Parks REIT. BSE GROUP=IF, outside the equity segment but fully priced '
      + 'and float-published by BSE. Must never map to Embassy Developments Ltd (EMBDL/532832).',
  },
  {
    ticker: 'BIRET',
    isin: 'INE0FDU25010',
    bseScripCode: '543261',
    why: 'Brookfield India Real Estate Trust REIT. BSE GROUP=IF.',
  },
  {
    ticker: 'NXST',
    isin: 'INE0NDH25011',
    bseScripCode: '543913',
    why: 'Nexus Select Trust REIT. BSE GROUP=IF.',
  },
  {
    ticker: 'MINDSPACE',
    isin: 'INE0CCU25019',
    bseScripCode: '543217',
    why: 'Mindspace Business Parks REIT. BSE GROUP=IF.',
  },
];

/**
 * Holdings known not to be resolvable to a BSE equity scrip, with the reason.
 *
 * This table exists so that a later, more permissive matcher cannot silently
 * "improve coverage" by attaching one of these to a same-named listed company.
 * A holding listed here is reported as unresolved WITH ITS REASON, keeps its
 * row and keeps its weight in every denominator.
 *
 * Matched on (ticker, normalised name) so that a genuine future listing under
 * a real ticker is not suppressed by this table.
 */
export const NOT_LISTED = [
  {
    ticker: '--',
    namePrefix: 'GSPL TRANSMISSION',
    reason: 'unlisted demerger entity — no ticker in the source workbook and no traded security yet.',
  },
  {
    ticker: '--',
    namePrefix: 'TRIVENI POWER TRANSMISSION',
    reason: 'unlisted demerger entity — no ticker in the source workbook. NSE carries only a '
      + 'placeholder for it (DUMMYTRVN, ISIN DUM256C01024), which is not a traded security.',
  },
  {
    ticker: '--',
    namePrefix: 'INOX RENEWABLE SOLUTIONS',
    reason: 'unlisted demerger entity — no ticker in the source workbook. NSE carries only a '
      + 'placeholder for it (DUMMYINXGN, ISIN DUM510W01014), which is not a traded security.',
  },
];

/**
 * Normalise a company name for comparison: upper case, drop the corporate-form
 * words that vendors spell differently, drop all punctuation and spacing.
 * "Shriram Finance Ltd" and "SHRIRAM FINANCE LTD" both become SHRIRAMFINANCE.
 */
export function normaliseName(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/\b(LIMITED|LTD|THE|COMPANY|CO)\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, '');
}

/**
 * Normalise a ticker for an NSE-symbol lookup: upper case, and BlackRock's dot
 * where NSE uses a hyphen (NAM.INDIA -> NAM-INDIA). Nothing else — this is a
 * spelling fix, not a search.
 */
export function normaliseTicker(value) {
  return String(value ?? '').trim().toUpperCase().replace(/\./g, '-');
}

/**
 * Build the lookup tables the resolver needs.
 *
 * @param {{scrips: Array}} bseMaster        from public/data/bse-scrip-master.json
 * @param {{symbols: Array}} nseUniverse     from public/data/nse-universe.json
 * @param {Set<string>} nseFreeFloatSymbols  symbols that have an NSE free-float reading
 */
export function buildIndex(bseMaster, nseUniverse, nseFreeFloatSymbols, universeSeed) {
  const byScripId = new Map();
  const byScripCode = new Map();
  const byIsin = new Map();
  const byName = new Map();

  for (const scrip of bseMaster.scrips) {
    if (!byScripId.has(scrip.scripId)) byScripId.set(scrip.scripId, scrip);
    if (!byScripCode.has(scrip.scripCode)) byScripCode.set(scrip.scripCode, scrip);
    if (scrip.isin) {
      const existing = byIsin.get(scrip.isin);
      if (existing) existing.push(scrip);
      else byIsin.set(scrip.isin, [scrip]);
    }
    const key = normaliseName(scrip.name);
    if (key !== '') {
      const existing = byName.get(key);
      if (existing) existing.push(scrip);
      else byName.set(key, [scrip]);
    }
  }

  const nseBySymbol = new Map(nseUniverse.symbols.map((s) => [s.symbol, s]));
  const nseByIsin = new Map();
  for (const s of nseUniverse.symbols) {
    const existing = nseByIsin.get(s.isin);
    if (existing) existing.push(s);
    else nseByIsin.set(s.isin, [s]);
  }

  // ---- the seed list, as a SECOND ISIN -> NSE symbol source ---------------
  // nse-universe.json is built from two niftyindices index lists, so it only
  // knows the names those indices contain. The desk's Screener export names an
  // NSE code for ~1,217 companies including ones no Nifty index carries, and it
  // is the only source that names the NSE-only listings at all.
  //
  // Two sources for one fact is the situation 2.8 legislates: neither is blended
  // and neither silently wins. nse-universe stays authoritative because it is the
  // exchange's own index membership; the seed only fills gaps; and where both
  // name a symbol for one ISIN they MUST agree — seedSymbolConflicts() reports
  // any that do not, and the build refuses to write on a conflict.
  const seedByIsin = new Map();
  const seedBySymbol = new Map();
  for (const row of universeSeed?.companies ?? []) {
    if (row.isin && !seedByIsin.has(row.isin)) seedByIsin.set(row.isin, row);
    if (row.nseSymbol) {
      const key = normaliseTicker(row.nseSymbol);
      if (key !== '' && !seedBySymbol.has(key)) seedBySymbol.set(key, row);
    }
  }

  return {
    byScripId,
    byScripCode,
    byIsin,
    byName,
    nseBySymbol,
    nseByIsin,
    seedByIsin,
    seedBySymbol,
    nseFreeFloatSymbols: nseFreeFloatSymbols ?? new Set(),
  };
}

/**
 * Every ISIN for which the NSE universe and the seed list name DIFFERENT NSE
 * symbols. Expected to be empty; a non-empty result means one of the two files
 * has the wrong company and the build must not proceed on either.
 */
export function seedSymbolConflicts(index) {
  const conflicts = [];
  for (const [isin, row] of index.seedByIsin) {
    const hits = index.nseByIsin.get(isin);
    if (!hits || hits.length !== 1 || !row.nseSymbol) continue;
    const fromUniverse = hits[0].symbol;
    if (normaliseTicker(fromUniverse) !== normaliseTicker(row.nseSymbol)) {
      conflicts.push({ isin, name: row.name, fromNseUniverse: fromUniverse, fromSeed: row.nseSymbol });
    }
  }
  return conflicts;
}

/** A BSE scrip reached unambiguously by ISIN, or null. */
function bseByIsin(index, isin) {
  const hits = index.byIsin.get(isin);
  if (!hits || hits.length !== 1) return null;
  return hits[0];
}

/**
 * The NSE symbol for an ISIN, with the source that asserted it.
 *
 * Asserted ONLY from a file that states the symbol outright, keyed on ISIN:
 * niftyindices' index membership first, then the desk's seed list. Never
 * inferred from BSE's scrip_id, however reliably the two agree — 3.9.
 *
 * @returns {{ symbol: string, source: 'nse-universe'|'seed' }|null}
 */
function nseSymbolEntryForIsin(index, isin) {
  if (!isin) return null;
  const hits = index.nseByIsin.get(isin);
  if (hits && hits.length === 1) return { symbol: hits[0].symbol, source: 'nse-universe' };
  const seeded = index.seedByIsin?.get(isin);
  if (seeded?.nseSymbol) return { symbol: seeded.nseSymbol, source: 'seed' };
  return null;
}

/** The symbol alone, for callers that do not need the provenance. */
function nseSymbolForIsin(index, isin) {
  return nseSymbolEntryForIsin(index, isin)?.symbol ?? null;
}

/**
 * Resolve one iShares holding.
 *
 * @returns {{
 *   isin: string|null, nseSymbol: string|null, bseScripCode: string|null,
 *   bseScripId: string|null, resolvedName: string|null,
 *   resolution: {method: string, via: string, confidence: string},
 *   reason: string|null
 * }}
 */
export function resolveHolding(holding, index) {
  const ticker = String(holding.ticker ?? '').trim();
  const normalisedTicker = normaliseTicker(ticker);
  const normalisedName = normaliseName(holding.name);

  const unresolved = (reason) => ({
    isin: null,
    nseSymbol: null,
    nseSymbolSource: null,
    bseScripCode: null,
    bseScripId: null,
    resolvedName: null,
    resolution: { method: 'none', via: 'none', confidence: 'none' },
    reason,
  });

  const fromScrip = (scrip, method, confidence) => ({
    isin: scrip.isin,
    nseSymbol: nseSymbolForIsin(index, scrip.isin),
    nseSymbolSource: nseSymbolEntryForIsin(index, scrip.isin)?.source ?? null,
    bseScripCode: scrip.scripCode,
    bseScripId: scrip.scripId,
    resolvedName: scrip.name,
    resolution: { method, via: scrip.isin ? 'isin' : 'bse-scrip', confidence },
    reason: null,
  });

  // Known-not-listed comes first: these must never fall through to a matcher.
  const blocked = NOT_LISTED.find(
    (entry) => entry.ticker === ticker && normalisedName.startsWith(normaliseName(entry.namePrefix)),
  );
  if (blocked) return unresolved(blocked.reason);

  // Hand-checked mappings, asserted against the reference data rather than trusted.
  const confirmed = CONFIRMED.find((entry) => entry.ticker === ticker);
  if (confirmed) {
    const scrip = index.byScripCode.get(confirmed.bseScripCode);
    if (!scrip || scrip.isin !== confirmed.isin) {
      return unresolved(
        `CONFIRMED mapping for ${ticker} no longer agrees with the BSE master ` +
          `(expected scrip ${confirmed.bseScripCode} / ISIN ${confirmed.isin}, ` +
          `found ${scrip ? `${scrip.scripCode} / ${scrip.isin}` : 'nothing'}). Re-check by hand.`,
      );
    }
    return fromScrip(scrip, 'confirmed', 'hand-checked');
  }

  // 1. BSE scrip id, exact.
  if (ticker !== '' && ticker !== '--') {
    const scrip = index.byScripId.get(ticker);
    if (scrip) return fromScrip(scrip, 'scrip_id', 'exact');
  }

  // 2. BSE numeric scrip code, exact.
  if (/^\d+$/.test(ticker)) {
    const scrip = index.byScripCode.get(ticker);
    if (scrip) return fromScrip(scrip, 'scrip_code', 'exact');
    return unresolved(`ticker reads as a BSE scrip code but ${ticker} is not in the active equity master`);
  }

  if (ticker === '' || ticker === '--') {
    return unresolved('no ticker in the source workbook — unlisted entity, nothing to resolve against');
  }

  // 3. ISIN, via the NSE universe.
  const nseEntry = index.nseBySymbol.get(normalisedTicker);
  if (nseEntry) {
    const scrip = bseByIsin(index, nseEntry.isin);
    if (scrip) {
      return {
        isin: nseEntry.isin,
        nseSymbol: nseEntry.symbol,
        nseSymbolSource: 'nse-universe',
        bseScripCode: scrip.scripCode,
        bseScripId: scrip.scripId,
        resolvedName: scrip.name,
        resolution: { method: 'isin', via: 'nse-universe', confidence: 'exact' },
        reason: null,
      };
    }
    // Listed on NSE, no BSE equity row. Real and common: CDSL and BSE Ltd are
    // NSE-only listings. Resolved, with no scrip code, and float can only come
    // from NSE.
    return {
      isin: nseEntry.isin,
      nseSymbol: nseEntry.symbol,
      nseSymbolSource: 'nse-universe',
      bseScripCode: null,
      bseScripId: null,
      resolvedName: nseEntry.name,
      resolution: { method: 'isin', via: 'nse-universe', confidence: 'exact' },
      reason: null,
    };
  }

  // 3b. ISIN, via the desk's seed list.
  //
  // Same shape as step 3, one step later because niftyindices is the exchange's
  // own index membership and the seed is a third-party export. This is the step
  // that reaches NSE-only listings no Nifty index carries.
  const seedEntry = index.seedBySymbol?.get(normalisedTicker);
  if (seedEntry) {
    const scrip = seedEntry.bseScripCode
      ? (index.byScripCode.get(seedEntry.bseScripCode) ?? bseByIsin(index, seedEntry.isin))
      : bseByIsin(index, seedEntry.isin);
    // The seed names a BSE code; it is only believed when the active master
    // agrees on the ISIN, so a stale or reused code cannot attach the wrong
    // company — the delisted-scrip trap in 3.8.
    if (scrip && scrip.isin === seedEntry.isin) {
      return {
        isin: seedEntry.isin,
        nseSymbol: seedEntry.nseSymbol,
        nseSymbolSource: 'seed',
        bseScripCode: scrip.scripCode,
        bseScripId: scrip.scripId,
        resolvedName: scrip.name,
        resolution: { method: 'isin', via: 'seed', confidence: 'exact' },
        reason: null,
      };
    }
    return {
      isin: seedEntry.isin,
      nseSymbol: seedEntry.nseSymbol,
      nseSymbolSource: 'seed',
      bseScripCode: null,
      bseScripId: null,
      resolvedName: seedEntry.name,
      resolution: { method: 'isin', via: 'seed', confidence: 'exact' },
      reason: null,
    };
  }

  // 4. Normalised name, exact and unique-or-nothing.
  const nameHits = index.byName.get(normalisedName);
  if (nameHits && nameHits.length === 1) {
    return fromScrip(nameHits[0], 'name', 'normalised-name');
  }
  if (nameHits && nameHits.length > 1) {
    return unresolved(
      `name "${holding.name}" matches ${nameHits.length} BSE scrips ` +
        `(${nameHits.map((s) => `${s.scripId}/${s.scripCode}`).join(', ')}) — ambiguous, not guessed`,
    );
  }

  return unresolved(
    `ticker "${ticker}" is not a BSE scrip id or code, is not an NSE symbol in the ` +
      'niftyindices universe, and its name has no exact match in the BSE equity master',
  );
}

/**
 * Resolve every holding of every fund, and refuse to return a result set that
 * contains a collision.
 *
 * A COLLISION is two rows OF THE SAME FUND resolving to one ISIN. That means
 * one of them is wrong — a fund does not hold the same company twice on two
 * lines — and the wrongness is invisible downstream, because both rows look
 * perfectly well-formed. The same ISIN appearing in two DIFFERENT funds is
 * normal and expected: the India Small-Cap and EM Small-Cap funds hold hundreds
 * of the same companies.
 *
 * @returns {{resolved: Array, unresolved: Array, collisions: Array, methodCounts: Object}}
 */
export function resolveAll(funds, index) {
  const resolved = [];
  const unresolved = [];
  const methodCounts = {};
  const perFundIsin = new Map();

  for (const fund of funds) {
    perFundIsin.set(fund.id, new Map());
    for (const [rowIndex, holding] of fund.holdings.entries()) {
      const outcome = resolveHolding(holding, index);
      const method = outcome.resolution.method;
      methodCounts[method] = (methodCounts[method] ?? 0) + 1;

      // Key on (fundId, rowIndex): `ticker` is not unique — `--` repeats.
      const record = { fundId: fund.id, rowIndex, holding, ...outcome };

      if (outcome.isin === null && outcome.bseScripCode === null) {
        unresolved.push(record);
        continue;
      }
      if (outcome.isin) {
        const seen = perFundIsin.get(fund.id);
        const previous = seen.get(outcome.isin);
        if (previous) previous.push(record);
        else seen.set(outcome.isin, [record]);
      }
      resolved.push(record);
    }
  }

  const collisions = [];
  for (const [fundId, seen] of perFundIsin) {
    for (const [isin, records] of seen) {
      if (records.length > 1) {
        collisions.push({
          fundId,
          isin,
          rows: records.map((r) => ({
            rowIndex: r.rowIndex,
            ticker: r.holding.ticker,
            name: r.holding.name,
            weightPct: r.holding.weightPct,
            method: r.resolution.method,
          })),
        });
      }
    }
  }

  return { resolved, unresolved, collisions, methodCounts };
}
