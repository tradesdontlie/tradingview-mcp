#!/usr/bin/env python3
"""What the dashboard watches, and which published series backs each reading.

One entry per indicator. Nothing on the page is typed by hand: every number is
computed from the series named here, and a pillar whose sources all fail is
rendered as an explicit gap rather than carried forward as prose.

Fields
    key        short id, used in the change ledger
    label      what the card calls it
    provider   fred | ecb | oecd | eurostat | cboe
    ident      the publisher's own identifier
    cadence    d | w | m — how often the publisher releases, drives freshness
    unit       how to format the level
    scale      divide the raw value by this before formatting
    transform  which derived quantity is the headline reading
    score_on   which quantity is percentile-ranked into the pillar score
    polarity   +1 when a higher score_on value means more liquidity / better
    weight     relative weight inside its pillar; near-duplicate series get less
    scored     False for a series that is shown on the card but kept out of the score
    source     human name and URL for the audit trail

Choosing score_on matters more than it looks. Percentile-ranking the DAILY
CHANGE of an administered rate is ranking a constant: the Fed funds target and
IORB each had 260 of 260 zero daily changes over the year to this build, so the
resulting score was an artifact of how ties are counted rather than a reading of
anything. Rates, spreads and prices are therefore ranked on their LEVEL — where
the rate sits within its own history — and only genuine flows (balance-sheet
stocks, week over week) are ranked on a change.
"""

# Formatting units. usd_mn / eur_mn are the publishers' native millions.
# ------------------------------------------------------------------ pillars

PILLARS = [
    # id        glyph      geo       pillar       title                              weight
    ("US-INF", "π / US", "US", "inflation", "US inflation", 0),
    ("US-GRO", "G / LAB", "US", "growth", "Growth / labour", 0),
    ("US-POL", "F / POL", "US", "policy", "Fed / policy impulse", 15),
    ("US-LIQ", "$ / TGA", "US", "liquidity", "Treasury / Fed liquidity", 30),
    ("EU-LIQ", "€ / ECB", "Europe", "liquidity", "ECB liquidity", 15),
    ("JP-LIQ", "¥ / BOJ", "Japan", "liquidity", "BoJ / Japan money", 10),
    ("CN-CRD", "CN / CR", "China", "liquidity", "PBoC / China credit & activity", 10),
    ("GL-FND", "σ / FND", "Global", "funding", "Funding stress", 20),
    ("GL-MKT", "β / MKT", "Global", "market", "Positioning / market regime", 0),
]

FRED_URL = "https://fred.stlouisfed.org/series/{}"
ECB_URL = "https://data.ecb.europa.eu/data/datasets/ILM"
ECB_RATE_URL = "https://data.ecb.europa.eu/data/datasets/EST"
OECD_URL = "https://data-explorer.oecd.org/vis?df[ds]=dsDisseminateFinalDMZ&df[id]=DSD_KEI%40DF_KEI"
ESTAT_URL = "https://ec.europa.eu/eurostat/databrowser/view/{}/default/table"
CBOE_URL = "https://www.cboe.com/tradable_products/vix/"


def _fred(key, label, sid, cadence, unit, transform, score_on, polarity,
          scale=1.0, weight=1.0, scored=True):
    return dict(key=key, label=label, provider="fred", ident=sid, cadence=cadence,
                unit=unit, scale=scale, transform=transform, score_on=score_on,
                polarity=polarity, weight=weight, scored=scored,
                source=f"FRED {sid}", url=FRED_URL.format(sid))


def _spec(key, label, provider, ident, cadence, unit, transform, score_on, polarity,
          source, url, scale=1.0, weight=1.0, scored=True):
    return dict(key=key, label=label, provider=provider, ident=ident, cadence=cadence,
                unit=unit, scale=scale, transform=transform, score_on=score_on,
                polarity=polarity, weight=weight, scored=scored, source=source, url=url)


INDICATORS = {
    # ---------------------------------------------------------------- US-INF
    # Price indices arrive as levels; every reading the card shows is derived.
    "US-INF": [
        _fred("cpi_core", "CPI core", "CPILFESL", "m", "pct", "yoy", "yoy", -1, weight=2.0),
        _fred("cpi_head", "CPI headline", "CPIAUCSL", "m", "pct", "yoy", "yoy", -1),
        _fred("ppi_core", "PPI core (final demand ex food/energy)", "PPIFES", "m", "pct", "yoy", "yoy", -1, weight=1.5),
        _fred("ppi_head", "PPI final demand", "PPIFIS", "m", "pct", "yoy", "yoy", -1, weight=0.5),
        _fred("pce_core", "PCE core", "PCEPILFE", "m", "pct", "yoy", "yoy", -1, weight=1.5),
        _fred("breakeven", "10y breakeven", "T10YIE", "d", "pct_raw", "level", "level", -1),
    ],
    # ---------------------------------------------------------------- US-GRO
    "US-GRO": [
        _fred("payrolls", "Nonfarm payrolls", "PAYEMS", "m", "k", "chg", "chg", 1, weight=2.0),
        _fred("unemp", "Unemployment rate", "UNRATE", "m", "pct_raw", "level", "level", -1, weight=1.5),
        _fred("u6", "U-6 underemployment", "U6RATE", "m", "pct_raw", "level", "level", -1),
        _fred("partic", "Participation rate", "CIVPART", "m", "pct_raw", "level", "level", 1),
        _fred("retail", "Retail sales", "RSAFS", "m", "usd_mn", "mom", "yoy", 1, weight=1.5),
        _fred("claims", "Initial claims", "ICSA", "w", "k", "level", "level", -1),
        _fred("contclaims", "Continuing claims", "CCSA", "w", "k", "level", "level", -1, weight=0.5),
        _fred("indpro", "Industrial production", "INDPRO", "m", "idx", "yoy", "yoy", 1),
        _fred("ahe", "Average hourly earnings", "CES0500000003", "m", "usd", "yoy", "yoy", 1),
    ],
    # ---------------------------------------------------------------- US-POL
    # A policy impulse is easier the lower the real rate and the steeper the
    # curve. Every member is ranked on its level: the administered rates do not
    # move on most days, so their daily change carries no information at all.
    "US-POL": [
        _fred("target_up", "Fed funds target (upper)", "DFEDTARU", "d", "pct_raw", "level", "level", -1, weight=1.5),
        _fred("effr", "Effective fed funds", "EFFR", "d", "pct_raw", "level", "level", -1, weight=0.5),
        _fred("dgs2", "2y Treasury", "DGS2", "d", "pct_raw", "level", "level", -1),
        _fred("dgs10", "10y Treasury", "DGS10", "d", "pct_raw", "level", "level", -1),
        _fred("curve", "10y-2y curve", "T10Y2Y", "d", "pp", "level", "level", 1),
        _fred("realrate", "10y TIPS real rate", "DFII10", "d", "pct_raw", "level", "level", -1, weight=1.5),
    ],
    # ---------------------------------------------------------------- US-LIQ
    # Reserves and the Treasury cash balance carry the pillar. Fed assets and
    # securities-held are near-duplicates — securities are most of assets — so
    # each takes half weight rather than counting one fact twice.
    "US-LIQ": [
        _fred("reserves", "Reserve balances", "WRESBAL", "w", "usd_mn", "wow", "wow", 1, weight=2.0),
        _fred("tga", "Treasury General Account", "WTREGEN", "w", "usd_mn", "wow", "wow", -1, weight=1.5),
        _fred("rrp", "Overnight reverse repo", "RRPONTSYD", "d", "usd_bn", "chg", "level", -1),
        _fred("walcl", "Fed total assets", "WALCL", "w", "usd_mn", "wow", "wow", 1, weight=0.5),
        _fred("secheld", "Securities held outright", "WSHOSHO", "w", "usd_mn", "wow", "wow", 1, weight=0.5),
    ],
    # ---------------------------------------------------------------- EU-LIQ
    # FRED carries only ECB total assets. The balance-sheet detail that makes
    # this pillar readable — QT runoff, excess liquidity, the stress facility —
    # exists only on the ECB's own portal.
    "EU-LIQ": [
        _spec("ecb_mpo", "Securities held for monetary policy", "ecb",
              "ILM/W.U2.C.A070100.U2.EUR", "w", "eur_mn", "wow", "wow", 1,
              "ECB Data Portal ILM A070100", ECB_URL, weight=2.0),
        # The deposit facility and the current account are the two halves of
        # euro-area excess liquidity, so they share one member's worth of weight.
        _spec("ecb_df", "Deposit facility", "ecb", "ILM/W.U2.C.L020200.U2.EUR",
              "w", "eur_mn", "wow", "wow", 1, "ECB Data Portal ILM L020200", ECB_URL, weight=0.5),
        _spec("ecb_ca", "Credit institutions' current account", "ecb",
              "ILM/W.U2.C.L020100.U2.EUR", "w", "eur_mn", "wow", "wow", 1,
              "ECB Data Portal ILM L020100", ECB_URL, weight=0.5),
        _spec("ecb_lend", "MRO + LTRO lending", "ecb", "ILM/W.U2.C.A050000.U2.EUR",
              "w", "eur_mn", "wow", "level", -1, "ECB Data Portal ILM A050000", ECB_URL),
        _spec("estr", "€STR", "ecb", "EST/B.EU000A2X2A25.WT", "d", "pct_raw",
              "level", "level", -1, "ECB Data Portal €STR", ECB_RATE_URL),
        _spec("ecb_dfr", "Deposit facility rate", "ecb", "FM/D.U2.EUR.4F.KR.DFR.LEV",
              "d", "pct_raw", "level", "level", -1, "ECB Data Portal key rates",
              ECB_RATE_URL, weight=1.5),
        _spec("ea_hicp", "Euro-area HICP", "eurostat", ("prc_hicp_manr", {"coicop": "CP00"}),
              "m", "pct_raw", "level", "level", -1, "Eurostat prc_hicp_manr",
              ESTAT_URL.format("prc_hicp_manr")),
    ],
    # ---------------------------------------------------------------- JP-LIQ
    # FRED's Japan M2 mirror (MYAGM2JPM189S) stopped in February 2017. OECD
    # still publishes the aggregates, so the money readings come from there and
    # only the BoJ balance sheet — which FRED does keep current — comes from FRED.
    "JP-LIQ": [
        _fred("boj_assets", "BoJ total assets", "JPNASSETS", "m", "jpy_100mn", "yoy", "yoy", 1, weight=2.0),
        _spec("jp_m3", "Japan M3", "oecd", "JPN.M.MABM.GR._Z.Y.GY", "m", "pct_raw",
              "level", "level", 1, "OECD KEI Japan M3 y/y", OECD_URL, weight=1.5),
        _spec("jp_m3_mom", "Japan M3 monthly", "oecd", "JPN.M.MABM.GR._Z.Y.G1", "m",
              "pct_raw", "level", "level", 1, "OECD KEI Japan M3 m/m", OECD_URL, weight=0.5),
        _spec("jp_call", "Call money rate", "oecd", "JPN.M.IRSTCI.PA._Z._Z._Z", "m",
              "pct_raw", "level", "level", -1, "OECD KEI Japan call rate", OECD_URL),
        _spec("jp_10y", "JGB 10y", "oecd", "JPN.M.IRLT.PA._Z._Z._Z", "m", "pct_raw",
              "level", "level", -1, "OECD KEI Japan long rate", OECD_URL),
        _fred("usdjpy", "USD/JPY", "DEXJPUS", "d", "px", "level", "level", -1, weight=0.5),
    ],
    # ---------------------------------------------------------------- CN-CRD
    # FRED's China CPI mirror stopped in April 2025; OECD still publishes it.
    # Exports and imports move together, so between them they carry one member.
    "CN-CRD": [
        _spec("cn_exports", "Exports y/y", "oecd", "CHN.M.EX.GR._T.Y.GY", "m",
              "pct_raw", "level", "level", 1, "OECD KEI China exports", OECD_URL, weight=0.5),
        _spec("cn_imports", "Imports y/y", "oecd", "CHN.M.IM.GR._T.Y.GY", "m",
              "pct_raw", "level", "level", 1, "OECD KEI China imports", OECD_URL, weight=0.5),
        _spec("cn_cpi", "China CPI y/y", "oecd", "CHN.M.CP.GR._Z._Z.GY", "m",
              "pct_raw", "level", "level", 1, "OECD KEI China CPI", OECD_URL),
        _spec("cn_cli", "Composite leading indicator", "oecd", "CHN.M.LI.IX._T.AA._Z",
              "m", "idx", "level", "level", 1, "OECD KEI China CLI", OECD_URL, weight=1.5),
        _spec("cn_bci", "Business confidence", "oecd", "CHN.M.BCICP.PB.C.Y._Z", "m",
              "idx", "level", "level", 1, "OECD KEI China business confidence", OECD_URL),
        _spec("cn_3m", "3m interbank rate", "oecd", "CHN.M.IR3TIB.PA._Z._Z._Z", "m",
              "pct_raw", "level", "level", -1, "OECD KEI China 3m rate", OECD_URL),
    ],
    # ---------------------------------------------------------------- GL-FND
    # The tells that separate an orderly drain from an accident: emergency
    # facility use, swap lines, the money-market spread and credit spreads.
    # SOFR and IORB are shown but not scored individually — what matters is the
    # spread between them, which build.py computes as a derived scored member.
    "GL-FND": [
        _fred("primary", "Fed primary credit", "WLCFLPCL", "w", "usd_mn", "level", "level", -1),
        _fred("swaps", "Central bank liquidity swaps", "SWPT", "w", "usd_mn", "level", "level", -1, weight=0.5),
        _fred("sofr", "SOFR", "SOFR", "d", "pct_raw", "level", "level", -1, scored=False),
        _fred("iorb", "Interest on reserve balances", "IORB", "d", "pct_raw", "level", "level", -1, scored=False),
        _fred("hy_oas", "High-yield OAS", "BAMLH0A0HYM2", "d", "pp", "level", "level", -1, weight=2.0),
        _fred("ig_oas", "Investment-grade OAS", "BAMLC0A0CM", "d", "pp", "level", "level", -1, weight=1.5),
        _spec("ecb_mlf", "ECB marginal lending facility", "ecb", "ILM/W.U2.C.A050500.U2.EUR",
              "w", "eur_mn", "level", "level", -1, "ECB Data Portal ILM A050500", ECB_URL, weight=0.5),
    ],
    # ---------------------------------------------------------------- GL-MKT
    "GL-MKT": [
        _spec("vix", "VIX", "cboe", "VIX", "d", "px", "level", "level", -1,
              "CBOE VIX history", CBOE_URL, weight=1.5),
        _spec("vix3m", "VIX3M", "cboe", "VIX3M", "d", "px", "level", "level", -1,
              "CBOE VIX3M history", CBOE_URL, weight=0.5),
        _spec("vvix", "VVIX", "cboe", "VVIX", "d", "px", "level", "level", -1,
              "CBOE VVIX history", CBOE_URL),
        _spec("skew", "SKEW", "cboe", "SKEW", "d", "px", "level", "level", -1,
              "CBOE SKEW history", CBOE_URL),
        _fred("dollar", "Broad dollar index", "DTWEXBGS", "d", "idx", "level", "level", -1),
        # A high oil price is a cost shock and a demand signal at once, so the
        # sign genuinely cuts both ways. Shown on the card, kept out of the score.
        _fred("wti", "WTI crude", "DCOILWTICO", "d", "px", "level", "level", -1, scored=False),
    ],
}


# Composite weights, from PILLARS. A pillar with weight 0 informs the regime
# geometry and the alerts but is deliberately outside the liquidity composite —
# the composite is a liquidity measure, not a summary of everything on the page.
WEIGHTS = {pid: w for pid, _g, _geo, _p, _t, w in PILLARS if w}

# How stale an observation may be before the card stops calling itself current.
# One publication interval plus a grace period, in days.
CADENCE_DAYS = {"d": 6, "w": 13, "m": 48}
CADENCE_NAME = {"d": "daily", "w": "weekly", "m": "monthly"}
