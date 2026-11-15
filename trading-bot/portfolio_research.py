"""Research harness for strategies that have real academic support.

Tests, with realistic costs and NO parameter fitting:
  * Time-series momentum (trend), volatility-targeted, across many instruments
    (Moskowitz-Ooi-Pedersen 2012; Hurst-Ooi-Pedersen 2017)
  * Cross-sectional currency momentum (Menkhoff-Sarno-Schmeling-Schrimpf 2012)
and judges the result with the Deflated Sharpe Ratio so luck is not mistaken for skill.

    python portfolio_research.py                       # your data in data/
    python portfolio_research.py --synthetic random    # negative control: must FAIL
    python portfolio_research.py --synthetic trend     # positive control: should PASS
Needs daily files data/<SYMBOL>_D1.csv (see fetch_data.py) or H1 files to resample.
"""
import argparse
import math
from pathlib import Path

import numpy as np
import pandas as pd

from tradingbot.stats import dsr, max_drawdown, psr, sharpe

COSTS = {"EURUSD": 0.00010, "GBPUSD": 0.00015, "USDJPY": 0.012, "AUDUSD": 0.00012,
         "NZDUSD": 0.00015, "USDCAD": 0.00018, "USDCHF": 0.00018, "EURJPY": 0.020,
         "GBPJPY": 0.030, "EURGBP": 0.00015}          # full spread in price units
DEFAULT_COST_BPS = 2.0                                 # for anything not listed (gold, indices)
DEFAULT_SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "NZDUSD", "USDCAD", "USDCHF", "XAUUSD"]
G10 = {"EUR", "GBP", "AUD", "NZD", "CAD", "CHF", "JPY", "NOK", "SEK"}
DAYS = 252


# ---------------- data ----------------
def load_daily(sym: str):
    d1, h1 = Path("data") / f"{sym}_D1.csv", Path("data") / f"{sym}_H1.csv"
    if d1.exists():
        df = pd.read_csv(d1, parse_dates=["time"])
    elif h1.exists():
        df = pd.read_csv(h1, parse_dates=["time"]).set_index("time").resample("1D").last().dropna().reset_index()
    else:
        return None
    s = df.set_index(pd.to_datetime(df["time"]).dt.tz_localize(None).dt.normalize())["close"]
    return s[~s.index.duplicated(keep="last")]


def synthetic_universe(kind: str, years: int = 16, seed: int = 3) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range("2008-01-01", periods=years * 260)
    out = {}
    for sym, base in zip(DEFAULT_SYMBOLS, [1.10, 1.30, 110, 0.75, 0.65, 1.25, 0.95, 1400]):
        r = rng.normal(0, 0.006, len(idx))
        if kind == "trend":
            drift = np.zeros(len(idx))
            shocks = rng.normal(0, 0.00012, len(idx))
            for i in range(1, len(idx)):
                drift[i] = 0.98 * drift[i - 1] + shocks[i]
            r = r + drift
        out[sym] = base * np.exp(np.cumsum(r))
    return pd.DataFrame(out, index=idx)


# ---------------- engine ----------------
def run_weights(raw_w, rets, prices, target_vol, max_gross, rebalance, cost_mult, spreads):
    """raw_w: desired risk-style weights (info at close t). Returns net daily returns."""
    mask = np.arange(len(raw_w)) % rebalance == 0
    w = raw_w.where(pd.Series(mask, index=raw_w.index), np.nan).ffill().fillna(0.0)
    raw_ret = (w.shift(1) * rets.fillna(0.0)).sum(axis=1)
    pvol = raw_ret.ewm(span=60, min_periods=60).std() * math.sqrt(DAYS)
    scale = (target_vol / pvol).replace([np.inf, -np.inf], np.nan)
    gross = w.abs().sum(axis=1) * scale
    scale = scale * (max_gross / gross).clip(upper=1.0)
    w = w.mul(scale, axis=0).fillna(0.0)
    held = w.shift(1).fillna(0.0)
    cost_frac = (spreads.reindex(prices.columns) / prices.where(prices > 0)) / 2
    cost = (held.diff().abs().fillna(0.0) * cost_frac.fillna(0.0)).sum(axis=1)
    net = (held * rets.fillna(0.0)).sum(axis=1) - cost * cost_mult
    return net[pvol.notna() & scale.notna()]


def tsmom_weights(prices, lookbacks):
    rets = prices.pct_change(fill_method=None)
    vol = rets.ewm(span=60, min_periods=60).std() * math.sqrt(DAYS)
    sig = sum(np.sign(prices / prices.shift(L) - 1) for L in lookbacks) / len(lookbacks)
    return (sig / vol).replace([np.inf, -np.inf], np.nan).fillna(0.0)


def xs_momentum_weights(prices, lookback):
    """Long the strongest third of currencies, short the weakest third (vs USD)."""
    cols = {}
    for s in prices.columns:
        if len(s) == 6 and s.isalpha():
            if s.endswith("USD") and s[:3] in G10:
                cols[s[:3]] = s
            elif s.startswith("USD") and s[3:] in G10:
                cols[s[3:]] = s
    if len(cols) < 5:
        return None
    ccy = pd.DataFrame({c: (prices[s] if s.endswith("USD") else 1 / prices[s]) for c, s in cols.items()})
    vol = ccy.pct_change(fill_method=None).ewm(span=60, min_periods=60).std() * math.sqrt(DAYS)
    mom = ccy / ccy.shift(lookback) - 1
    rank = mom.rank(axis=1, pct=True)
    long, short = (rank >= 2 / 3).astype(float), (rank <= 1 / 3).astype(float)
    wc = ((long - short) / vol).replace([np.inf, -np.inf], np.nan).fillna(0.0)
    # map currency weights back onto the pair columns (USDXXX pairs go the other way)
    wp = pd.DataFrame(0.0, index=prices.index, columns=prices.columns)
    for c, s in cols.items():
        wp[s] = wc[c] if s.endswith("USD") else -wc[c]
    return wp


# ---------------- reporting ----------------
def evaluate(name, net1, net2, n_trials, var_sr):
    half = len(net1) // 2
    sh1, sh2 = sharpe(net1[:half]), sharpe(net1[half:])
    row = {
        "name": name, "sharpe": sharpe(net1), "sharpe_2x": sharpe(net2),
        "ret": net1.mean() * DAYS * 100, "vol": net1.std() * math.sqrt(DAYS) * 100,
        "mdd": max_drawdown(net1) * 100, "h1": sh1, "h2": sh2,
        "psr": psr(net1), "dsr": dsr(net1, n_trials, var_sr),
    }
    row["pass"] = (row["dsr"] >= 0.95 and sh1 > 0 and sh2 > 0 and row["sharpe_2x"] >= 0.3)
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", nargs="+", default=DEFAULT_SYMBOLS)
    ap.add_argument("--target-vol", type=float, default=0.10)
    ap.add_argument("--max-gross", type=float, default=6.0)
    ap.add_argument("--rebalance", type=int, default=5, help="days between position updates")
    ap.add_argument("--trials", type=int, default=20,
                    help="how many strategy variants you have EVER tried (be honest, count past work)")
    ap.add_argument("--synthetic", choices=["random", "trend"])
    a = ap.parse_args()

    if a.synthetic:
        prices = synthetic_universe(a.synthetic)
    else:
        series = {s: load_daily(s) for s in a.symbols}
        missing = [s for s, v in series.items() if v is None]
        if missing:
            print("No data for:", ", ".join(missing), "(run fetch_data.py for each, timeframe D1)")
        series = {s: v for s, v in series.items() if v is not None}
        if len(series) < 4:
            raise SystemExit("Need at least 4 instruments: diversification is the whole point.")
        prices = pd.concat(series, axis=1).sort_index().ffill(limit=5)
    rets = prices.pct_change(fill_method=None)
    spreads = pd.Series({s: COSTS.get(s, np.nan) for s in prices.columns})
    for s in prices.columns:                               # unlisted: DEFAULT_COST_BPS of mean price
        if np.isnan(spreads[s]):
            spreads[s] = prices[s].mean() * DEFAULT_COST_BPS / 10000

    print(f"\nUniverse: {', '.join(prices.columns)}  |  {prices.index[0].date()} -> "
          f"{prices.index[-1].date()}  ({len(prices)} days)")
    variants = [("TSMOM 1-month", tsmom_weights(prices, [21])),
                ("TSMOM 3-month", tsmom_weights(prices, [63])),
                ("TSMOM 12-month", tsmom_weights(prices, [252])),
                ("TSMOM blend 1/3/12m", tsmom_weights(prices, [21, 63, 252]))]
    xs = xs_momentum_weights(prices, 63)
    if xs is not None:
        variants.append(("FX cross-sectional momentum 3m", xs))
    else:
        print("(cross-sectional momentum skipped: needs 5+ G10 currency pairs)")

    runs = []
    for name, w in variants:
        n1 = run_weights(w, rets, prices, a.target_vol, a.max_gross, a.rebalance, 1.0, spreads)
        n2 = run_weights(w, rets, prices, a.target_vol, a.max_gross, a.rebalance, 2.0, spreads)
        runs.append((name, n1, n2))
    var_sr = float(np.var([n1.mean() / n1.std() for _, n1, _ in runs], ddof=1)) if len(runs) > 1 else None
    rows = [evaluate(n, n1, n2, a.trials, var_sr) for n, n1, n2 in runs]

    print(f"\nVolatility target {a.target_vol:.0%}, rebalance every {a.rebalance} days, "
          f"deflated for {a.trials} variants tried")
    print("PASS = DSR >= 0.95 AND both halves of history profitable AND Sharpe >= 0.3 at 2x costs\n")
    print(f"{'strategy':<31}{'Sharpe':>7}{'@2xcost':>8}{'ret%':>7}{'vol%':>6}{'maxDD%':>8}"
          f"{'1st half':>9}{'2nd half':>9}{'PSR':>6}{'DSR':>6}  verdict")
    print("-" * 112)
    for r in rows:
        print(f"{r['name']:<31}{r['sharpe']:7.2f}{r['sharpe_2x']:8.2f}{r['ret']:7.1f}{r['vol']:6.1f}"
              f"{r['mdd']:8.1f}{r['h1']:9.2f}{r['h2']:9.2f}{r['psr']:6.2f}{r['dsr']:6.2f}  "
              f"{'PASS' if r['pass'] else 'fail'}")
    Path("results").mkdir(exist_ok=True)
    pd.DataFrame(rows).to_csv("results/portfolio_summary.csv", index=False)
    print("\nDetails: results/portfolio_summary.csv. Costs include spread only; swap/financing is "
          "not modelled yet.")


if __name__ == "__main__":
    main()
