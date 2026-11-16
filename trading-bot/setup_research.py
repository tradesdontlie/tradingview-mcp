"""Backtest the CHECKLIST itself on years of hourly data, with the exact code the live bot uses.

Each trade: signal at a bar's close, entry at the NEXT bar's open, stop from the checklist,
target = rr x stop, time stop after 48 bars, spread charged, one trade per pair at a time.
If stop and target are both inside one bar, the STOP is assumed to hit first (pessimistic).

    python setup_research.py                       # your data/<PAIR>_H1.csv files
    python setup_research.py --learn               # journal blocks buckets proven to lose, as it goes
    python setup_research.py --ablation            # which checklist items actually add value?
    python setup_research.py --synthetic random    # negative control (no edge exists)
    python setup_research.py --synthetic trend     # positive control
Judged with the Deflated Sharpe Ratio; `--trials` = how many variants you have ever tried.
"""
import argparse
import math
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

from portfolio_research import COSTS as PCOSTS
from tradingbot.checklist import market_checks
from tradingbot.config import Config
from tradingbot.database import Database
from tradingbot.journal import Journal
from tradingbot.market_context import build_context, session_name
from tradingbot.models import Signal
from tradingbot.stats import dsr, psr

ITEMS = ["trend", "structure", "location", "trigger", "room", "not_chasing", "volatility",
         "session", "spread_stop"]


def load_h1(sym):
    path = Path("data") / f"{sym}_H1.csv"
    if not path.exists():
        return None
    df = pd.read_csv(path, parse_dates=["time"])
    df.index = pd.to_datetime(df["time"]).dt.tz_localize(None)
    return df[["open", "high", "low", "close"]]


def synthetic(kind, bars, seed):
    from tradingbot.broker_sim import SimBroker
    b = SimBroker(seed=seed, t0=1_699_999_200, sigma=0.0008, spread_pips=0.7,
                  trend=0.000002 if kind == "trend" else 0.0)
    b.warmup(bars)
    return {s: b.candles(s, bars) for s in ("EURUSD", "GBPUSD", "USDJPY")}


def spread_of(sym, df):
    return PCOSTS.get(sym, float(df["close"].mean()) * 2e-4)


def candidates(df, sym, cfg):
    """For every bar and side: (failed items, trigger, stop). Independent of the journal."""
    ctx = build_context(df)
    spread = spread_of(sym, df)
    recs = ctx.to_dict("records")
    out = [None] * len(recs)
    for i in range(300, len(recs) - 2):
        r = {}
        for side in ("BUY", "SELL"):
            res = market_checks(recs[i], side, spread, cfg)
            r[side] = (tuple(res.failed), res.trigger, res.stop)
        out[i] = r
    return ctx, recs, out, spread


def simulate(df, i, side, stop, cost_r, rr, max_hold=48):
    """Outcome in R of entering at the open of bar i+1."""
    o, h, l, c = df["open"].values, df["high"].values, df["low"].values, df["close"].values
    e = o[i + 1]
    s = 1 if side == "BUY" else -1
    sl, tp = e - s * stop, e + s * rr * stop
    last = min(i + max_hold, len(df) - 1)
    for j in range(i + 1, last + 1):
        hit_sl = (l[j] <= sl) if s == 1 else (h[j] >= sl)
        hit_tp = (h[j] >= tp) if s == 1 else (l[j] <= tp)
        if hit_sl:
            return -1.0 - cost_r, j, "SL"
        if hit_tp:
            return rr - cost_r, j, "TP"
    return s * (c[last] - e) / stop - cost_r, last, "TIME"


def run(data, cfg, drop=frozenset(), learn=False, cache=None):
    cache = cache if cache is not None else {}
    for sym, df in data.items():
        if sym not in cache:
            cache[sym] = candidates(df, sym, cfg)
    db = Database()
    j = Journal(db, cfg)
    blocked, trades, nid = set(), [], 0
    open_t = {s: None for s in data}
    events = sorted({(ts, s) for s, df in data.items() for ts in df.index[300:-2]})
    pos = {s: {ts: k for k, ts in enumerate(df.index)} for s, df in data.items()}
    for ts, sym in events:
        df = data[sym]
        i = pos[sym][ts]
        t = open_t[sym]
        if t and i >= t["exit_i"]:
            j.record_exit(t["id"], ts.timestamp(), t["R"])
            trades.append(t)
            open_t[sym] = None
            if learn:
                blocked = j.blocked_buckets()
        if open_t[sym] is not None:
            continue
        ctx, recs, cands, spread = cache[sym]
        c = cands[i]
        if c is None:
            continue
        for side in ("BUY", "SELL"):
            failed, trig, stop = c[side]
            if set(failed) - set(drop):
                continue
            setup = trig or "none"
            sess = session_name(int(recs[i]["hour"]))
            if learn and ({f"setup:{setup}", f"session:{sess}", f"pair:{sym}"} & blocked):
                continue
            cost_r = spread / stop
            R, exit_i, why = simulate(df, i, side, stop, cost_r, cfg.rr)
            nid += 1
            res = market_checks(recs[i], side, spread, cfg)
            j.record_entry(nid, ts.timestamp(), Signal(sym, side, stop, 0), 0, nid, setup, recs[i], res,
                           None, False, 1.0, cfg.rr, spread)
            open_t[sym] = {"id": nid, "R": R, "exit_i": exit_i, "setup": setup, "session": sess,
                           "sym": sym, "ts": ts, "why": why}
            break
    for t in open_t.values():
        if t:
            trades.append(t)
    trades.sort(key=lambda t: t["ts"])
    return trades


def stats(trades, years, trials):
    R = np.array([t["R"] for t in trades])
    n = len(R)
    if n < 5:
        return None
    wins = (R > 0).sum()
    gl = -R[R <= 0].sum()
    h = n // 2
    return {"n": n, "per_year": n / years, "win": wins / n * 100, "avgR": R.mean(), "totR": R.sum(),
            "pf": R[R > 0].sum() / gl if gl > 0 else float("inf"),
            "t": R.mean() / (R.std(ddof=1) / math.sqrt(n)),
            "h1": R[:h].mean(), "h2": R[h:].mean(), "psr": psr(R), "dsr": dsr(R, trials),
            "ddR": -(np.maximum.accumulate(np.cumsum(R)) - np.cumsum(R)).max()}


def line(name, s):
    if s is None:
        return f"{name:<24} too few trades"
    return (f"{name:<24}{s['n']:>6}{s['per_year']:>7.1f}{s['win']:>7.1f}{s['avgR']:>8.3f}{s['totR']:>8.1f}"
            f"{s['pf']:>6.2f}{s['t']:>6.1f}{s['h1']:>8.3f}{s['h2']:>8.3f}{s['dsr']:>6.2f}{s['ddR']:>8.1f}")


HEAD = (f"{'':<24}{'trades':>6}{'/yr':>7}{'win%':>7}{'avgR':>8}{'totR':>8}{'PF':>6}{'t':>6}"
        f"{'1st half':>8}{'2nd half':>8}{'DSR':>6}{'maxDD_R':>8}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", nargs="+", default=["EURUSD", "GBPUSD", "USDJPY"])
    ap.add_argument("--synthetic", choices=["random", "trend"])
    ap.add_argument("--bars", type=int, default=60000, help="synthetic only")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--learn", action="store_true")
    ap.add_argument("--ablation", action="store_true")
    ap.add_argument("--trials", type=int, default=25)
    ap.add_argument("--rr", type=float, default=3.0)
    a = ap.parse_args()
    cfg = Config.improved(rr=a.rr)

    if a.synthetic:
        data = synthetic(a.synthetic, a.bars, a.seed)
    else:
        data = {s: load_h1(s) for s in a.symbols}
        for s in [k for k, v in data.items() if v is None]:
            print(f"[skip] data/{s}_H1.csv not found")
            data.pop(s)
        if not data:
            raise SystemExit("No H1 data. Run fetch_data.py --timeframe H1 for each symbol.")
    years = max(len(df) for df in data.values()) / 6240
    print(f"\n{', '.join(data)}  |  ~{years:.1f} years of H1 bars  |  rr 1:{a.rr:g}  |  spread charged  |  "
          f"DSR deflated for {a.trials} trials\n")
    cache = {}
    base = run(data, cfg, learn=a.learn, cache=cache)
    print(HEAD)
    print("-" * len(HEAD))
    print(line("CHECKLIST (all items)", stats(base, years, a.trials)))
    for key, label in (("setup", "setup"), ("session", "session"), ("sym", "pair")):
        groups = defaultdict(list)
        for t in base:
            groups[t[key]].append(t)
        for g, ts in sorted(groups.items(), key=lambda kv: -len(kv[1])):
            print(line(f"  {label}: {g}", stats(ts, years, a.trials)))
    if a.ablation:
        print("\nABLATION: drop ONE item at a time. If avgR rises when an item is dropped, that item "
              "is hurting; if it falls, the item earns its place.")
        print(HEAD)
        for item in ITEMS:
            print(line(f"without {item}", stats(run(data, cfg, drop={item}, learn=a.learn, cache=cache),
                                                years, a.trials)))
    print("\nPASS means: avgR > 0 in BOTH halves, DSR >= 0.95, and 100+ trades so it means something.")


if __name__ == "__main__":
    main()
