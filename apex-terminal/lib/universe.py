#!/usr/bin/env python3
"""What the terminal watches. Symbols are Yahoo tickers."""

# Cross-Asset Scorecard. One card each, ordered as they should render.
SCORECARD = [
    ("SPY",      "S&P 500",            "US Equity"),
    ("QQQ",      "Nasdaq 100",         "US Equity"),
    ("IWM",      "Russell 2000",       "US Equity"),
    ("EFA",      "Developed ex-US",    "Intl Equity"),
    ("EEM",      "Emerging Markets",   "Intl Equity"),
    ("TLT",      "20Y+ Treasuries",    "Rates"),
    ("HYG",      "High Yield Credit",  "Credit"),
    ("LQD",      "IG Credit",          "Credit"),
    ("GLD",      "Gold",               "Commodity"),
    ("CL=F",     "WTI Crude",          "Commodity"),
    ("DX-Y.NYB", "US Dollar Index",    "FX"),
    ("BTC-USD",  "Bitcoin",            "Crypto"),
]

# Volatility & Stress Radar inputs.
VOL_COMPLEX = ["^VIX", "^VIX9D", "^VIX3M", "^VVIX", "^SKEW", "^VXTLT", "^MOVE"]
CREDIT = ["HYG", "LQD", "TLT"]

# Strategy Backtest tabs. 200-day trend rule vs buy-and-hold.
BACKTEST = [
    ("SPY", "S&P 500 ETF"),
    ("QQQ", "Nasdaq 100 ETF"),
    ("IWM", "Russell 2000 ETF"),
    ("GLD", "Gold ETF"),
]

# Market Pulse universe, symbol -> display name. Yahoo's predefined screeners
# need an authenticated crumb, so gainers/losers/most-active are ranked within
# this stated large-cap universe rather than across the whole market — the panel
# says so. Names are carried here so the table reads the same whichever
# provider served the prices.
PULSE_NAMES = {
    "AAPL": "Apple", "MSFT": "Microsoft", "NVDA": "NVIDIA", "GOOGL": "Alphabet",
    "AMZN": "Amazon", "META": "Meta Platforms", "TSLA": "Tesla", "AVGO": "Broadcom",
    "BRK-B": "Berkshire Hathaway B", "LLY": "Eli Lilly", "JPM": "JPMorgan Chase",
    "V": "Visa", "XOM": "Exxon Mobil", "UNH": "UnitedHealth", "MA": "Mastercard",
    "COST": "Costco", "HD": "Home Depot", "PG": "Procter & Gamble",
    "JNJ": "Johnson & Johnson", "ABBV": "AbbVie", "WMT": "Walmart", "NFLX": "Netflix",
    "CRM": "Salesforce", "BAC": "Bank of America", "AMD": "AMD", "KO": "Coca-Cola",
    "PEP": "PepsiCo", "TMO": "Thermo Fisher", "CVX": "Chevron", "ORCL": "Oracle",
    "MRK": "Merck", "ADBE": "Adobe", "CSCO": "Cisco", "ACN": "Accenture",
    "MCD": "McDonald's", "INTC": "Intel", "QCOM": "Qualcomm", "TXN": "Texas Instruments",
    "DIS": "Walt Disney", "GE": "GE Aerospace",
}

PULSE = list(PULSE_NAMES)

# Smart Money watchlist — the frontend hardcodes these five tickers.
MEGA_CAP = ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN"]

# Macro Snapshot. Each indicator names its provider explicitly, because FRED
# silently retires its OECD mirrors: UK CPI stopped there in March 2025 and
# euro-area unemployment in January 2023, while both still publish upstream.
#   fred     series id, CSV download            unit: percent | index_yoy | usd_millions
#   oecd     SDMX key, already a YoY rate       unit: percent
#   eurostat dataset + filters, already a rate  unit: percent
MACRO = {
    "United States": [
        ("GDP Growth Rate",     "fred", "A191RL1Q225SBEA", "percent"),
        ("Inflation Rate",      "fred", "CPIAUCSL",        "index_yoy"),
        ("Core Inflation Rate", "fred", "CPILFESL",        "index_yoy"),
        ("Unemployment Rate",   "fred", "UNRATE",          "percent"),
        ("Interest Rate",       "fred", "DFEDTARU",        "percent"),
        ("Balance of Trade",    "fred", "BOPGSTB",         "usd_millions"),
    ],
    "Euro Area": [
        ("GDP Growth Rate",   "fred",     "CLVMNACSCAB1GQEA19", "index_yoy"),
        ("Inflation Rate",    "fred",     "CP0000EZ19M086NEST", "index_yoy"),
        ("Unemployment Rate", "eurostat", ("une_rt_m", {"s_adj": "SA", "age": "TOTAL",
                                                        "unit": "PC_ACT", "sex": "T"}), "percent"),
        ("Interest Rate",     "fred",     "ECBDFR",             "percent"),
    ],
    "United Kingdom": [
        ("GDP Growth Rate",   "fred", "NGDPRSAXDCGBQ",          "index_yoy"),
        ("Inflation Rate",    "oecd", "GBR.M.N.CPI.PA._T.N.GY", "percent"),
        ("Unemployment Rate", "fred", "LRHUTTTTGBM156S",        "percent"),
    ],
    # Japan's CPI stops at June 2021 in the OECD prices dataset and FRED mirrors
    # that dead series. No keyless replacement found, so the staleness guard in
    # panels.build_macro blanks it rather than showing a five-year-old print.
    "Japan": [
        ("GDP Growth Rate",   "fred", "JPNRGDPEXP",             "index_yoy"),
        ("Inflation Rate",    "oecd", "JPN.M.N.CPI.PA._T.N.GY", "percent"),
        ("Unemployment Rate", "fred", "LRHUTTTTJPM156S",        "percent"),
    ],
}

YOY_UNITS = {"index_yoy"}
