"""
NY-session liquidity-sweep reversal: the exact same failed-breakout state
machine as strategies/asian_failed_breakout (imported directly — that
engine was written to be generic, not duplicated here), reconfigured for
NY-relevant levels: PDH/PDL, the overnight Asian range, the London range,
and the NY pre-market range. New setups may only start once ny_tradeable is
True — i.e. never inside the no-trade opening window.

Deliberately does NOT include swing points or the 15-minute opening range —
found directly by tracing a real case (MNQ1! 2026-08-21, a ~250pt trending
crash around 10:00 ET): the engine kept picking opening_range_low as the
level to fade, six separate times, purely because it happened to be the
CLOSEST level to price each time a new candidate started (the state machine
only tracks one candidate per direction at once) — correctly rejected every
time by the acceptance filter since it was a real trend, not a failed
breakdown, but it meant PDL/asian_range_low, the more meaningful levels
that move ALSO swept through, never got their own chance to be evaluated.
Narrowing to only the levels below matches what MGC/MNQ sweeps normally
react to (PDH/PDL and session ranges), not a level that's redefined every
single day and often sits closer to price by coincidence.

"Already swept" exclusion: a level is only offered as a fade candidate while
it is still UNTOUCHED — i.e. price has not already traded beyond it at any
earlier point since that level's current value was established (a level
swept once during Asian or London hours has already had its liquidity taken;
fading it a second time isn't the same setup). This is tracked independently
of the state machine's own candidate (which only starts watching a level
once it's approached) — every bar checks every currently-known level for a
first-touch sweep and marks it "used" from that point on, whether or not the
strategy happened to be watching it. The one sweep that's still eligible is
the first one — if that first sweep happens during NY hours, it's exactly
the live setup this strategy exists to trade; only a PRIOR sweep (Asian,
London, pre-market) disqualifies a level for the rest of that level's
lifetime (until it resets — all four level types roll over once per Globex
day).

Direction logic (unchanged, just restated): a swept HIGH that fails to hold
-> SHORT once reclaimed + EMA9-confirmed; a swept LOW that fails to hold ->
LONG once reclaimed + EMA9-confirmed. Never a signal on the sweep itself.

Run as a module from the repo root:
    python -m strategies.ny_open_strategies.liquidity_sweep_reversal --symbol MGC1! --days 30
"""
import argparse
import json
import sys

import pandas as pd

from ..asian_failed_breakout.config import StrategyConfig
from ..asian_failed_breakout.engine import StrategyEngine
from ..asian_failed_breakout.levels import LevelTracker, _globex_day_id, _in_window, _parse_hm
from .common import ET, OUT_DIR, RAW_DIR, add_session_window, load_point_value

NY_LONG_LEVEL_FIELDS = ("pdl", "asian_range_low", "london_range_low", "ny_premarket_low")
NY_SHORT_LEVEL_FIELDS = ("pdh", "asian_range_high", "london_range_high", "ny_premarket_high")

# Levels whose min-penetration sweep threshold gates "already touched" —
# reuses the same value the reversal engine itself uses to define a sweep,
# so "already swept" means the same thing here as it does inside the engine.
_SWEEP_DIRECTION = {  # True = level is a "low" (touched when price trades BELOW it)
    "pdl": True, "pdh": False,
    "asian_range_low": True, "asian_range_high": False,
    "london_range_low": True, "london_range_high": False,
    "ny_premarket_low": True, "ny_premarket_high": False,
}


class _SessionRangeTracker:
    """Generic session-range tracker (high/low within a configurable ET
    window, resetting once per Globex day) — used here for both London
    (03:00-08:00) and NY pre-market (04:00-09:29). Same pattern as
    strategies/fabio_strategy/levels.py's LocationTracker; not imported from
    there to keep this package's own dependency graph shallow (it already
    depends on asian_failed_breakout; adding a second, larger sibling
    package as a dependency for ~15 lines of logic isn't worth it)."""
    def __init__(self, start: str, end: str, rollover_hour: int = 18):
        self._start_min = _parse_hm(start)
        self._end_min = _parse_hm(end)
        self._rollover_hour = rollover_hour
        self._day = None
        self.high = None
        self.low = None

    def update(self, bar: dict, et_ts) -> None:
        day = _globex_day_id(et_ts, self._rollover_hour)
        if day != self._day:
            self._day = day
            self.high = None
            self.low = None
        tod = et_ts.hour * 60 + et_ts.minute
        if _in_window(tod, self._start_min, self._end_min):
            if self.high is None:
                self.high, self.low = bar["high"], bar["low"]
            else:
                self.high = max(self.high, bar["high"])
                self.low = min(self.low, bar["low"])


def _load_bars(symbol: str, timeframe: str) -> pd.DataFrame:
    stem = symbol.replace(":", "_").replace("!", "")
    path = RAW_DIR / f"{stem}_{timeframe}.parquet"
    if not path.exists():
        raise FileNotFoundError(f"No raw data at {path} — run ml/data_collection/collect_replay.py first.")
    return pd.read_parquet(path).sort_values("time").reset_index(drop=True)


def run_backtest(symbol: str, cfg: StrategyConfig, days: int | None = None,
                  no_trade_minutes: int = 15) -> pd.DataFrame:
    df1 = _load_bars(symbol, "1")
    df5 = _load_bars(symbol, "5")
    if days is not None:
        cutoff = int(df1["time"].max()) - days * 86400
        df1 = df1[df1["time"] >= cutoff].reset_index(drop=True)

    df1["ema9"] = df1["close"].ewm(span=cfg.ma9.ema_period, adjust=False).mean()
    df1["et"] = pd.to_datetime(df1["time"], unit="s", utc=True).dt.tz_convert(ET)
    df1["tod_min"] = df1["et"].dt.hour * 60 + df1["et"].dt.minute
    df1["calendar_date"] = df1["et"].dt.date
    add_session_window(df1, "ny", no_trade_minutes)

    et5 = pd.to_datetime(df5["time"], unit="s", utc=True).dt.tz_convert(ET)
    tf5_close_offset = 5 * 60

    rollover = cfg.session.globex_day_rollover_hour
    tracker = LevelTracker(cfg.session, cfg.swing, cfg.asian_range)
    london_tracker = _SessionRangeTracker("03:00", "08:00", rollover)
    premarket_tracker = _SessionRangeTracker("04:00", "09:29", rollover)
    engine = StrategyEngine(cfg, symbol, load_point_value(symbol),
                             long_level_fields=NY_LONG_LEVEL_FIELDS, short_level_fields=NY_SHORT_LEVEL_FIELDS,
                             session_label="ny")

    pen = cfg.sweep.min_penetration_points
    last_value: dict[str, float] = {}
    already_swept: dict[str, bool] = {}

    j, n5 = 0, len(df5)
    records = []
    for i in range(len(df1)):
        t = int(df1["time"].iloc[i])
        while j < n5 and int(df5["time"].iloc[j]) + tf5_close_offset <= t:
            bar5 = {"time": int(df5["time"].iloc[j]), "open": df5["open"].iloc[j], "high": df5["high"].iloc[j],
                    "low": df5["low"].iloc[j], "close": df5["close"].iloc[j]}
            ts5 = et5.iloc[j]
            tracker.update(bar5, ts5)
            london_tracker.update(bar5, ts5)
            j += 1
        # NY pre-market is tracked on 1m bars directly (5m granularity would
        # be too coarse for a 5.5-hour window that itself feeds into an
        # early-morning setup) — updated every 1m bar, not gated behind the
        # 5m close-alignment used for the other trackers above.
        premarket_tracker.update({"high": df1["high"].iloc[i], "low": df1["low"].iloc[i]}, df1["et"].iloc[i])

        # "Already swept" exclusion applies to all four level types (PDH/PDL,
        # Asian range, London range, NY pre-market range) — a level is only
        # offered while price hasn't already traded beyond it since it was
        # last established.
        sweep_tracked_levels = {"pdl": tracker.pdl, "pdh": tracker.pdh,
                                 "asian_range_low": tracker.asian_range_low, "asian_range_high": tracker.asian_range_high,
                                 "london_range_low": london_tracker.low, "london_range_high": london_tracker.high,
                                 "ny_premarket_low": premarket_tracker.low, "ny_premarket_high": premarket_tracker.high}
        sweep_tracked_levels = {k: v for k, v in sweep_tracked_levels.items()
                                 if v is not None and not (isinstance(v, float) and pd.isna(v))}

        bar_high, bar_low = df1["high"].iloc[i], df1["low"].iloc[i]
        levels = {}
        for name, value in sweep_tracked_levels.items():
            if last_value.get(name) != value:
                # the level's underlying value moved (new day/session) ->
                # it's a fresh, untouched level again regardless of history.
                last_value[name] = value
                already_swept[name] = False
            is_low_side = _SWEEP_DIRECTION[name]
            touched_now = (bar_low < value - pen) if is_low_side else (bar_high > value + pen)
            if not already_swept.get(name, False):
                levels[name] = value  # still fresh as of BEFORE this bar — eligible
            if touched_now:
                already_swept[name] = True  # mark used (whether or not it was offered above)

        bar1 = {"time": t, "open": df1["open"].iloc[i], "high": bar_high, "low": bar_low, "close": df1["close"].iloc[i]}
        recs = engine.on_bar(bar1, float(df1["ema9"].iloc[i]), levels, bool(df1["ny_tradeable"].iloc[i]))
        records.extend(recs)

    if len(df1):
        last_bar = {"time": int(df1["time"].iloc[-1]), "close": float(df1["close"].iloc[-1])}
        records.extend(engine.force_close_all(last_bar))

    out = pd.DataFrame([r.__dict__ for r in records])
    if not out.empty:
        for col in ("timestamp", "break_timestamp", "reclaim_timestamp", "ema9_trigger_timestamp", "exit_timestamp"):
            if col in out.columns:
                out[col.replace("timestamp", "et")] = pd.to_datetime(out[col], unit="s", utc=True).dt.tz_convert(ET)
        out = out.sort_values("timestamp").reset_index(drop=True)
    return out


def summarize(df: pd.DataFrame) -> dict:
    if df.empty:
        return {"n_setups": 0}
    status_counts = df["setup_status"].value_counts().to_dict()
    reason_counts = df["invalid_reason"].dropna().value_counts().to_dict()
    filled = df[df["setup_status"].isin(["FILLED", "OPEN_AT_BACKTEST_END"])]
    summary = {"n_setups_logged": len(df), "status_counts": status_counts, "rejection_reasons": reason_counts,
               "n_trades_filled": len(filled)}
    if len(filled):
        wins = filled[filled["pnl_points"] > 0]
        gross_profit = filled.loc[filled["pnl_dollars"] > 0, "pnl_dollars"].sum()
        gross_loss = -filled.loc[filled["pnl_dollars"] < 0, "pnl_dollars"].sum()
        summary.update({
            "win_rate": float(len(wins) / len(filled)),
            "total_pnl_dollars": float(filled["pnl_dollars"].sum()),
            "avg_r_multiple": float(filled["r_multiple"].mean()),
            "profit_factor": float(gross_profit / gross_loss) if gross_loss > 0 else None,
            "by_direction": filled.groupby("direction")["pnl_dollars"].agg(["count", "sum", "mean"]).to_dict("index"),
        })
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", default="MGC1!")
    parser.add_argument("--days", type=int, default=None)
    args = parser.parse_args()

    cfg = StrategyConfig()
    df = run_backtest(args.symbol, cfg, args.days)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stem = args.symbol.replace(":", "_").replace("!", "")
    out_path = OUT_DIR / f"{stem}_ny_liquidity_sweep_reversal.csv"
    df.to_csv(out_path, index=False)
    print(f"Wrote {len(df)} setup records to {out_path}", file=sys.stderr)
    print(json.dumps(summarize(df), indent=2, default=str))


if __name__ == "__main__":
    main()
