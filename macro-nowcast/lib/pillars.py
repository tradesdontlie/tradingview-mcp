#!/usr/bin/env python3
"""One signal card per pillar, built entirely from fetched observations.

A card carries a score, a direction, a confidence and the level/velocity/
acceleration triad. All four are computed:

    score        the polarity-adjusted percentile of each member indicator
                 within its own five-year history, weighted and averaged
    direction    how that score moved against the previous stored vintage
    confidence   coverage (how many members resolved and are current) blended
                 with agreement (how tightly the members' scores cluster)
    freshness    the worst verdict among the members that carry the headline

A member that failed to fetch lowers coverage and is named in the card's gap
list. It is never replaced by a carried-forward number pretending to be current.
"""
import derived
import fmt
import indicators as I
import universe as U


def _dir_word(delta, band=1.5):
    if delta is None:
        return "mixed"
    if delta > band:
        return "improving"
    if delta < -band:
        return "deteriorating"
    return "mixed"


def _tone(score, direction):
    """Colour follows the level, nudged by the direction it is moving."""
    if score is None:
        return "warn"
    if score >= 60:
        return "good" if direction != "deteriorating" else "warn"
    if score >= 42:
        return "warn"
    return "bad" if direction != "improving" else "warn"


def build_readings(pid, fetched, previous_periods):
    """Every member indicator of one pillar, computed. Missing ones are gaps.

    Derived members (the SOFR-IORB spread, net liquidity, the VIX term
    structure) are built from the fetched members and then treated identically:
    same triad, same percentile score, same freshness rule.
    """
    readings, gaps = {}, []
    member_obs = {spec["key"]: fetched.get((pid, spec["key"])) for spec in U.INDICATORS[pid]}
    specs = [(spec, member_obs.get(spec["key"])) for spec in U.INDICATORS[pid]]
    for key, (spec, obs) in derived.build(pid, member_obs).items():
        specs.append((spec, obs))

    for spec, obs in specs:
        if obs is None:
            gaps.append(spec["key"])
            continue
        calc = I.compute(obs, spec)
        hist = I.score_history(obs, spec)
        raw_pct = I.percentile(hist, calc["score_value"])
        fresh, age, when = I.freshness(obs, spec,
                                       previous_period=previous_periods.get(spec["key"]))
        # Polarity turns "high" into "good for liquidity" or its opposite, so
        # every member score points the same way before they are combined.
        score = None if raw_pct is None else (raw_pct if spec["polarity"] > 0 else 100 - raw_pct)
        readings[spec["key"]] = {
            "spec": spec, "obs": obs, "calc": calc, "fresh": fresh, "age": age,
            "when": when, "period": obs.last_period, "score": score, "pctile": raw_pct,
            "scored": spec.get("scored", True), "weight": spec.get("weight", 1.0),
        }
    return readings, gaps


def score_pillar(readings):
    """(score, coverage, agreement) for one pillar's members.

    Weighted, so that near-duplicate series (Fed assets and securities-held;
    the deposit facility and the current account) cannot outvote the reading
    they are both restating, and so a display-only member — one whose sign is
    genuinely ambiguous, like the oil price — stays out of the arithmetic.
    """
    scored = [r for r in readings.values() if r["score"] is not None and r["scored"]]
    if not scored:
        return None, 0.0, None
    total_w = sum(r["weight"] for r in scored) or 1.0
    score = sum(r["score"] * r["weight"] for r in scored) / total_w

    current = sum(1 for r in readings.values() if r["fresh"] != "stale")
    coverage = current / max(len(readings), 1)

    # Members that disagree wildly make the pillar score less trustworthy. A
    # weighted population standard deviation of 0 is unanimity; 50 is the
    # maximum spread two members ranked 0 and 100 can produce.
    agreement = None
    if len(scored) > 1:
        var = sum(r["weight"] * (r["score"] - score) ** 2 for r in scored) / total_w
        agreement = max(0.0, 1.0 - (var ** 0.5) / 50.0)
    return score, coverage, agreement


def confidence_word(coverage, agreement, gaps):
    conf = coverage * (0.65 + 0.35 * (agreement if agreement is not None else 0.5))
    if gaps:
        conf *= 0.85
    if conf >= 0.78:
        return "high", conf
    if conf >= 0.55:
        return "medium", conf
    return "low", conf


def worst_freshness(readings, keys):
    order = {"verified": 0, "carry": 1, "stale": 2}
    present = [readings[k]["fresh"] for k in keys if k in readings]
    if not present:
        return "stale"
    return max(present, key=lambda f: order[f])


# --------------------------------------------------------------- presentation
# Which members supply the headline triad and the fact tiles, and how each is
# worded. Values are always computed; only the choice of what to show is fixed.

def _triad(readings, entries):
    out = []
    for label, key, fn in entries:
        r = readings.get(key)
        out.append(f"{label} n/a" if r is None else fn(r["calc"], r))
    return out


def _facts(readings, entries):
    out = []
    for key, fn, caption in entries:
        r = readings.get(key)
        out.append([fn(r["calc"], r) if r else "n/a", caption])
    return out


def us_inflation(readings):
    c = lambda k: readings[k]["calc"] if k in readings else {}
    triad = _triad(readings, [
        ("CPI core", "cpi_core", lambda c, r: f"CPI core {fmt.pct(c['yoy'])} y/y"),
        ("CPI core", "cpi_core", lambda c, r: f"CPI core {fmt.signed_pct(c['mom'], 2)} m/m"),
        ("PPI core", "ppi_core", lambda c, r: f"PPI core {fmt.signed_pct(c['accel_mom'], 2)} accel"),
    ])
    facts = _facts(readings, [
        ("cpi_head", lambda c, r: fmt.pct(c["yoy"]), "CPI headline y/y"),
        ("ppi_core", lambda c, r: fmt.pct(c["yoy"]), "PPI core y/y"),
        ("ppi_head", lambda c, r: fmt.signed_pct(c["mom"], 2), "PPI final demand m/m"),
        ("pce_core", lambda c, r: fmt.pct(c["yoy"]), "PCE core y/y"),
        ("breakeven", lambda c, r: fmt.pct(c["level"], 2), "10y breakeven"),
    ])
    core = c("cpi_core").get("yoy")
    ppi = c("ppi_core").get("yoy")
    if core is None:
        status, copy = "COVERAGE GAP", "Core CPI did not resolve this bake."
    elif core <= 2.5 and (ppi is None or ppi <= 3.0):
        status = "DISINFLATING"
        copy = (f"Core CPI at {fmt.pct(core)} y/y with producer core at {fmt.pct(ppi)} "
                "leaves the consumer and pipeline signals pointing the same way.")
    elif core <= 3.0:
        status = "DISINFLATING, PIPELINE STICKY"
        copy = (f"Core CPI improved to {fmt.pct(core)} y/y, but producer core prices at "
                f"{fmt.pct(ppi)} prevent a uniformly benign signal.")
    else:
        status = "STICKY ABOVE TARGET"
        copy = (f"Core CPI at {fmt.pct(core)} y/y is running above the consistent-with-2% "
                f"pace, with producer core at {fmt.pct(ppi)}.")
    return status, copy, triad, facts, ["cpi_core", "ppi_core"]


def us_growth(readings, score=None):
    triad = _triad(readings, [
        ("Payrolls", "payrolls", lambda c, r: f"Payrolls {fmt.signed_thousands(c['chg'] * 1000 if c['chg'] else None)}"),
        ("Unemp", "unemp", lambda c, r: f"Unemployment {fmt.pct(c['level'], 1)}"),
        ("Claims", "claims", lambda c, r: f"Claims {fmt.thousands(c['level'])}"),
    ])
    facts = _facts(readings, [
        ("payrolls", lambda c, r: fmt.signed_thousands(c["chg"] * 1000 if c["chg"] else None), "Monthly payroll change"),
        ("u6", lambda c, r: fmt.pct(c["level"], 1), "U-6 underemployment"),
        ("partic", lambda c, r: fmt.pct(c["level"], 1), "Participation rate"),
        ("retail", lambda c, r: fmt.signed_pct(c["mom"], 1), "Retail sales m/m"),
        ("contclaims", lambda c, r: fmt.thousands(c["level"]), "Continuing claims"),
        ("ahe", lambda c, r: fmt.pct(c["yoy"]), "Average hourly earnings y/y"),
    ])
    pay = readings.get("payrolls", {}).get("calc", {}).get("chg")
    unemp_chg = readings.get("unemp", {}).get("calc", {}).get("chg")
    jobs = pay * 1000 if pay is not None else None
    if jobs is None:
        status, copy = "COVERAGE GAP", "The payroll series did not resolve this bake."
    elif jobs >= 100_000 and (unemp_chg is None or unemp_chg <= 0):
        # A strong headline print does not entitle the card to call the pillar
        # resilient when the rest of its members sit below their own median.
        if score is not None and score < 50:
            status = "PAYROLLS FIRM, BREADTH SOFT"
            copy = (f"Payrolls added {fmt.signed_thousands(jobs)} and unemployment did not rise, "
                    f"but the pillar scores {score:.0f}: the other members sit below their own "
                    "five-year medians.")
        else:
            status = "RESILIENT"
            copy = (f"Payrolls added {fmt.signed_thousands(jobs)} while the unemployment rate did "
                    "not rise, so demand for labour is still absorbing the supply reaching it.")
    elif jobs >= 100_000:
        status = "GROWING, SLACK RISING"
        copy = (f"Payrolls added {fmt.signed_thousands(jobs)}, but the unemployment rate rose "
                f"{fmt.signed_pp(unemp_chg, 1)}, so the household side is not confirming.")
    elif jobs > 0:
        status = "SLOWING"
        copy = (f"Payroll growth of {fmt.signed_thousands(jobs)} is below the pace that holds "
                "the unemployment rate flat as the labour force grows.")
    else:
        status = "CONTRACTING"
        copy = f"Payrolls fell {fmt.signed_thousands(jobs)} on the month."
    return status, copy, triad, facts, ["payrolls", "unemp", "claims"]


def us_policy(readings):
    triad = _triad(readings, [
        ("Target", "target_up", lambda c, r: f"Target {fmt.pct(c['level'], 2)} upper"),
        ("2y", "dgs2", lambda c, r: f"2y {fmt.pct(c['level'], 2)}"),
        ("Curve", "curve", lambda c, r: f"10y-2y {fmt.signed_pp(c['level'], 2)}"),
    ])
    facts = _facts(readings, [
        ("effr", lambda c, r: fmt.pct(c["level"], 2), "Effective fed funds"),
        ("dgs10", lambda c, r: fmt.pct(c["level"], 2), "10y Treasury"),
        ("realrate", lambda c, r: fmt.pct(c["level"], 2), "10y TIPS real rate"),
        ("dgs2", lambda c, r: fmt.bp(c["chg"]), "2y daily change"),
        ("curve", lambda c, r: fmt.signed_pp(c["level"], 2), "Curve slope"),
    ])
    two = readings.get("dgs2", {}).get("calc", {}).get("level")
    target = readings.get("target_up", {}).get("calc", {}).get("level")
    curve = readings.get("curve", {}).get("calc", {}).get("level")
    if None in (two, target):
        status, copy = "COVERAGE GAP", "The policy path series did not resolve this bake."
    elif two < target - 0.25:
        status = "MARKET PRICING RELIEF"
        copy = (f"The 2y at {fmt.pct(two, 2)} sits {fmt.pp(target - two)} below the "
                f"{fmt.pct(target, 2)} target ceiling, so the curve is discounting cuts.")
    elif two > target:
        status = "HAWKISH REPRICING"
        copy = (f"The 2y at {fmt.pct(two, 2)} is above the {fmt.pct(target, 2)} target "
                "ceiling, which prices further tightening rather than relief.")
    else:
        status = "RESTRICTIVE, NO RELIEF PRICED"
        copy = (f"The 2y at {fmt.pct(two, 2)} is close to the {fmt.pct(target, 2)} target "
                f"ceiling; the curve at {fmt.signed_pp(curve, 2)} carries the adjustment.")
    return status, copy, triad, facts, ["target_up", "dgs2", "curve"]


def us_liquidity(readings):
    res = readings.get("reserves", {}).get("calc", {})
    tga = readings.get("tga", {}).get("calc", {})
    triad = _triad(readings, [
        ("Reserves", "reserves", lambda c, r: f"Reserves {fmt.usd(c['raw'])}"),
        ("Reserves", "reserves", lambda c, r: f"{fmt.signed_usd_bn(c['wow'])} w/w"),
        ("Reserves", "reserves", lambda c, r: f"{fmt.signed_usd_bn(c['accel_wow'])} accel"),
    ])
    facts = _facts(readings, [
        ("tga", lambda c, r: fmt.usd(c["raw"]), "Treasury General Account"),
        ("tga", lambda c, r: fmt.signed_usd_bn(c["wow"]), "TGA weekly change"),
        ("rrp", lambda c, r: fmt.usd_bn(c["level"]), "Overnight reverse repo"),
        ("walcl", lambda c, r: fmt.usd(c["raw"]), "Fed total assets"),
        ("secheld", lambda c, r: fmt.signed_usd_bn(c["wow"]), "Securities outright weekly"),
    ])
    # Net liquidity — Fed assets less the two accounts that sterilise reserves —
    # is a derived member with its own history, so it leads the fact tiles.
    net = readings.get("net_liq", {}).get("calc", {})
    if net.get("raw") is not None:
        facts.insert(0, [fmt.usd(net["raw"]), "Net liquidity (assets − TGA − RRP)"])
        facts.insert(1, [fmt.signed_usd_bn(net.get("wow")), "Net liquidity weekly"])

    wow = res.get("wow")
    if wow is None:
        status, copy = "COVERAGE GAP", "The H.4.1 reserve series did not resolve this bake."
    elif wow < -25:
        status = "RESERVE DRAIN DEEPENS"
        copy = (f"Reserve balances fell {fmt.signed_usd_bn(wow)} on the week to "
                f"{fmt.usd(res.get('raw'))}, with the Treasury account "
                f"{fmt.signed_usd_bn(tga.get('wow'))} over the same period.")
    elif wow < 0:
        status = "RESERVES EASING LOWER"
        copy = (f"Reserves slipped {fmt.signed_usd_bn(wow)} to {fmt.usd(res.get('raw'))} — a "
                "drain, but inside the range that has not previously transmitted.")
    else:
        status = "RESERVES REBUILDING"
        copy = (f"Reserves rose {fmt.signed_usd_bn(wow)} to {fmt.usd(res.get('raw'))} as the "
                f"Treasury account moved {fmt.signed_usd_bn(tga.get('wow'))}.")
    return status, copy, triad, facts, ["reserves", "tga", "net_liq"]


def eu_liquidity(readings):
    mpo = readings.get("ecb_mpo", {}).get("calc", {})
    df = readings.get("ecb_df", {}).get("calc", {})
    ca = readings.get("ecb_ca", {}).get("calc", {})
    triad = _triad(readings, [
        ("Securities", "ecb_mpo", lambda c, r: f"MPO stock {fmt.eur(c['raw'])}"),
        ("Runoff", "ecb_mpo", lambda c, r: f"{fmt.signed_eur_bn(c['wow'])} w/w"),
        ("Runoff", "ecb_mpo", lambda c, r: f"{fmt.signed_eur_bn(c['accel_wow'])} accel"),
    ])
    # Excess liquidity is the euro-area analogue of Fed reserves: the deposit
    # facility plus the current account, which the ECB publishes separately.
    facts = []
    if df.get("raw") is not None and ca.get("raw") is not None:
        facts.append([fmt.eur(df["raw"] + ca["raw"]), "Excess liquidity (DF + current account)"])
        if None not in (df.get("wow"), ca.get("wow")):
            facts.append([fmt.signed_eur_bn(df["wow"] + ca["wow"]), "Excess liquidity weekly"])
    facts += _facts(readings, [
        ("ecb_lend", lambda c, r: fmt.eur(c["raw"]), "MRO + LTRO lending"),
        ("estr", lambda c, r: fmt.pct(c["level"], 3), "€STR"),
        ("ecb_dfr", lambda c, r: fmt.pct(c["level"], 2), "Deposit facility rate"),
        ("ea_hicp", lambda c, r: fmt.pct(c["level"], 1), "Euro-area HICP y/y"),
    ])
    runoff = mpo.get("wow")
    if runoff is None:
        status, copy = "COVERAGE GAP", "The ECB weekly statement did not resolve this bake."
    elif runoff < -5:
        status = "QT RUNOFF ACTIVE"
        copy = (f"Monetary-policy holdings fell {fmt.signed_eur_bn(runoff)} to "
                f"{fmt.eur(mpo.get('raw'))}; balance-sheet withdrawal remains restrictive.")
    elif runoff < 0:
        status = "ORDERLY QT, RUNOFF SLOWS"
        copy = (f"Holdings still declined, by {fmt.signed_eur_bn(runoff)}, but the weekly "
                "pace has slowed against the prior week.")
    else:
        status = "HOLDINGS STABILISING"
        copy = (f"Monetary-policy holdings rose {fmt.signed_eur_bn(runoff)} on the week, "
                "interrupting the runoff.")
    return status, copy, triad, facts, ["ecb_mpo", "estr"]


def jp_liquidity(readings):
    boj = readings.get("boj_assets", {}).get("calc", {})
    m3 = readings.get("jp_m3", {}).get("calc", {})
    triad = _triad(readings, [
        ("BoJ", "boj_assets", lambda c, r: f"BoJ assets {fmt.jpy_100mn(c['raw'])}"),
        ("BoJ", "boj_assets", lambda c, r: f"{fmt.signed_pct(c['yoy'])} y/y"),
        ("BoJ", "boj_assets", lambda c, r: f"{fmt.signed_pct(c['accel_yoy'])} accel"),
    ])
    facts = _facts(readings, [
        ("jp_m3", lambda c, r: fmt.pct(c["level"], 2), "Japan M3 y/y"),
        ("jp_m3_mom", lambda c, r: fmt.signed_pct(c["level"], 2), "Japan M3 m/m"),
        ("jp_call", lambda c, r: fmt.pct(c["level"], 3), "Call money rate"),
        ("jp_10y", lambda c, r: fmt.pct(c["level"], 2), "JGB 10y"),
        ("usdjpy", lambda c, r: fmt.num(c["level"], 2), "USD/JPY"),
        ("boj_assets", lambda c, r: fmt.signed_pct(c["mom"], 2), "BoJ assets m/m"),
    ])
    yoy = boj.get("yoy")
    if yoy is None:
        status, copy = "COVERAGE GAP", "The BoJ balance sheet did not resolve this bake."
    elif yoy < -5:
        status = "BALANCE SHEET CONTRACTING"
        copy = (f"BoJ assets are {fmt.signed_pct(yoy)} y/y at {fmt.jpy_100mn(boj.get('raw'))}, "
                f"with broad money at {fmt.pct(m3.get('level'), 2)} y/y.")
    elif yoy < 0:
        status = "MARGINAL CONTRACTION"
        copy = (f"BoJ assets are {fmt.signed_pct(yoy)} y/y; broad money still grows at "
                f"{fmt.pct(m3.get('level'), 2)} y/y, so the transmission is not one-way.")
    else:
        status = "BALANCE SHEET EXPANDING"
        copy = (f"BoJ assets are {fmt.signed_pct(yoy)} y/y at {fmt.jpy_100mn(boj.get('raw'))}, "
                f"alongside broad money at {fmt.pct(m3.get('level'), 2)} y/y.")
    return status, copy, triad, facts, ["boj_assets", "jp_m3"]


def cn_credit(readings):
    ex = readings.get("cn_exports", {}).get("calc", {})
    cli = readings.get("cn_cli", {}).get("calc", {})
    triad = _triad(readings, [
        ("Exports", "cn_exports", lambda c, r: f"Exports {fmt.signed_pct(c['level'])} y/y"),
        ("Imports", "cn_imports", lambda c, r: f"Imports {fmt.signed_pct(c['level'])} y/y"),
        ("CLI", "cn_cli", lambda c, r: f"CLI {fmt.signed_pct(c['chg'], 2)} chg"),
    ])
    facts = _facts(readings, [
        ("cn_cli", lambda c, r: fmt.num(c["level"], 2), "Composite leading indicator"),
        ("cn_cpi", lambda c, r: fmt.pct(c["level"], 1), "China CPI y/y"),
        ("cn_bci", lambda c, r: fmt.num(c["level"], 1), "Business confidence"),
        ("cn_3m", lambda c, r: fmt.pct(c["level"], 2), "3m interbank rate"),
        ("cn_imports", lambda c, r: fmt.signed_pct(c["level"]), "Imports y/y"),
    ])
    exports, cli_lvl = ex.get("level"), cli.get("level")
    if exports is None:
        status, copy = "COVERAGE GAP", "The China trade series did not resolve this bake."
    elif exports > 5 and (cli_lvl is None or cli_lvl >= 100):
        status = "EXTERNAL DEMAND FIRM"
        copy = (f"Exports are {fmt.signed_pct(exports)} y/y with the leading indicator at "
                f"{fmt.num(cli_lvl, 2)}, so external demand is carrying activity.")
    elif exports > 0:
        status = "TRADE POSITIVE, LEAD SOFT"
        copy = (f"Exports are {fmt.signed_pct(exports)} y/y, but the leading indicator at "
                f"{fmt.num(cli_lvl, 2)} is below the 100 trend line.")
    else:
        status = "ACTIVITY WEAK"
        copy = (f"Exports are {fmt.signed_pct(exports)} y/y with the leading indicator at "
                f"{fmt.num(cli_lvl, 2)}.")
    # PBoC aggregate financing has no keyless feed; the card says so rather than
    # implying the credit impulse itself was read.
    return status, copy, triad, facts, ["cn_exports", "cn_cli"]


def gl_funding(readings):
    primary = readings.get("primary", {}).get("calc", {})
    hy = readings.get("hy_oas", {}).get("calc", {})
    # The SOFR-IORB spread is the money-market stress tell and is a derived
    # member with five years of its own history behind it, in basis points.
    spread_bp = readings.get("sofr_iorb", {}).get("calc", {}).get("level")
    triad = _triad(readings, [
        ("HY OAS", "hy_oas", lambda c, r: f"HY OAS {fmt.pp(c['level'])}"),
        ("HY OAS", "hy_oas", lambda c, r: f"{fmt.bp(c['chg'])} daily"),
        ("HY OAS", "hy_oas", lambda c, r: f"{fmt.bp(c['accel_chg'])} accel"),
    ])
    facts = []
    if spread_bp is not None:
        facts.append([f"{spread_bp:+.0f}bp", "SOFR − IORB spread"])
    facts += _facts(readings, [
        ("primary", lambda c, r: fmt.usd(c["raw"]), "Fed primary credit"),
        ("swaps", lambda c, r: fmt.usd(c["raw"]), "Central bank swap lines"),
        ("ig_oas", lambda c, r: fmt.pp(c["level"]), "Investment-grade OAS"),
        ("ecb_mlf", lambda c, r: fmt.eur(c["raw"]), "ECB marginal lending"),
        ("sofr", lambda c, r: fmt.pct(c["level"], 2), "SOFR"),
    ])
    hy_lvl = hy.get("level")
    # Five basis points over IORB is where repo has historically started to
    # signal reserve scarcity rather than ordinary month-end noise.
    stressed = (spread_bp is not None and spread_bp > 5) or (hy_lvl is not None and hy_lvl > 5.0)
    if hy_lvl is None:
        status, copy = "COVERAGE GAP", "The credit spread series did not resolve this bake."
    elif stressed:
        status = "TRANSMISSION APPEARING"
        copy = (f"High-yield spreads at {fmt.pp(hy_lvl)} and a SOFR−IORB spread of "
                f"{spread_bp:+.0f}bp show the drain reaching funding markets.")
    else:
        status = "ORDERLY, BUFFER THINNER"
        copy = (f"Spreads at {fmt.pp(hy_lvl)} and emergency facility use of "
                f"{fmt.usd(primary.get('raw'))} do not indicate systemic stress.")
    return status, copy, triad, facts, ["hy_oas", "primary", "sofr_iorb"]


def gl_market(readings):
    vix = readings.get("vix", {}).get("calc", {})
    term = readings.get("vix_term", {}).get("calc", {}).get("level")
    triad = _triad(readings, [
        ("VIX", "vix", lambda c, r: f"VIX {fmt.num(c['level'], 2)}"),
        ("VIX", "vix", lambda c, r: f"{fmt.signed_pct(c['mom'], 1)} daily"),
        ("VIX", "vix", lambda c, r: f"{fmt.num(c['accel_chg'], 2)} accel"),
    ])
    facts = []
    if term is not None:
        facts.append([fmt.num(term, 3), "VIX3M / VIX term structure"])
    facts += _facts(readings, [
        ("vvix", lambda c, r: fmt.num(c["level"], 1), "VVIX (vol of vol)"),
        ("skew", lambda c, r: fmt.num(c["level"], 1), "CBOE SKEW"),
        ("dollar", lambda c, r: fmt.num(c["level"], 2), "Broad dollar index"),
        ("wti", lambda c, r: fmt.num(c["level"], 2), "WTI crude"),
        ("vix3m", lambda c, r: fmt.num(c["level"], 2), "VIX3M"),
    ])
    v = vix.get("level")
    if v is None:
        status, copy = "COVERAGE GAP", "The volatility complex did not resolve this bake."
    elif term is not None and term < 1.0:
        status = "TERM STRUCTURE INVERTED"
        copy = (f"VIX at {fmt.num(v, 2)} above VIX3M inverts the term structure — the market "
                "is pricing near-term risk above three-month risk.")
    elif v < 16:
        status = "CALM, COMPLACENT"
        copy = (f"VIX at {fmt.num(v, 2)} with a term structure of {fmt.num(term, 3)} shows no "
                "market confirmation of the liquidity constraint.")
    elif v < 25:
        status = "ELEVATED, ORDERLY"
        copy = f"VIX at {fmt.num(v, 2)} is elevated but the curve remains in contango."
    else:
        status = "STRESSED"
        copy = f"VIX at {fmt.num(v, 2)} is in the range that has accompanied forced selling."
    return status, copy, triad, facts, ["vix", "vix_term"]


BUILDERS = {
    "US-INF": us_inflation, "US-GRO": us_growth, "US-POL": us_policy,
    "US-LIQ": us_liquidity, "EU-LIQ": eu_liquidity, "JP-LIQ": jp_liquidity,
    "CN-CRD": cn_credit, "GL-FND": gl_funding, "GL-MKT": gl_market,
}
