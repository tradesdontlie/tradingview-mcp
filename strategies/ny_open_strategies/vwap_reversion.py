"""
VWAP mean-reversion: fade the touch of a VWAP +/- N-sigma band, optionally
requiring confluence with an actual liquidity sweep of a known important
level (PDH/PDL, prior NY session high/low, a recent swing high/low, or the
current Asian range) — not just "far from VWAP," but "far from VWAP AND
that stretch took out a level worth defending." Reuses the exact same
LevelTracker as strategies/asian_failed_breakout (5m-bar-based, causal —
same discipline as that module: a level is only visible once the 5m bar
that defines it has actually closed).

NOTE on prior evidence in this repo: earlier ML analysis this session found
that, at a ~30-60min horizon with wide fixed TP/SL, distance from VWAP
predicted *continuation* rather than reversion in this data (see the
Aug-22 conversation's VWAP-distance decile breakdown). Entering directly at
the sigma touch — with no confirmation that price has actually turned —
is exactly the shape of signal that finding argues against. The level-sweep
filter is one way to test whether adding that confluence recovers an edge
the raw sigma-touch alone doesn't have; read the backtest numbers as a test
of that question, not as settled proof either way.

Long: dist_from_vwap_sigma crosses down through -entry_sigma this bar
      (first touch, edge-triggered), AND (if require_level_sweep) a
      low-side level was swept within level_sweep_lookback_bars.
Short: mirror, crossing up through +entry_sigma with a high-side sweep.
Stop: (entry_sigma + stop_sigma_buffer) sigma beyond VWAP — a volatility-
      scaled stop, since a fixed point buffer doesn't make sense across
      different sigma thresholds or symbols.
Target: VWAP itself (snapshotted at signal time), or fixed_price if
        cfg.target_mode="fixed_price" is set (used for the swing-target
        sweep).

Run as a module from the repo root:
    python -m strategies.ny_open_strategies.vwap_reversion --symbol MGC1! --days 30
    python -m strategies.ny_open_strategies.vwap_reversion --symbol MGC1! --entry-sigma 2.5
    python -m strategies.ny_open_strategies.vwap_reversion --symbol MGC1! --no-level-sweep-filter
"""
import argparse
import json
import sys
from dataclasses import dataclass, field

import pandas as pd

from ..asian_failed_breakout.config import AsianRangeConfig, LevelToggles, SessionConfig, SwingConfig
from ..asian_failed_breakout.levels import LevelTracker
from .common import (ET, OpenTrade, RAW_DIR, RiskParams, TradeLogRecord, force_close, load_1m_bars,
                      load_point_value, summarize, update_open_trade, write_csv)

HIGH_SIDE_LEVELS = ("pdh", "prev_ny_high", "swing_high", "asian_range_high")
LOW_SIDE_LEVELS = ("pdl", "prev_ny_low", "swing_low", "asian_range_low")


@dataclass
class VWAPReversionConfig:
    entry_sigma: float = 2.0  # try 2.5 too — see main()'s --entry-sigma
    stop_sigma_buffer: float = 0.5  # stop placed (entry_sigma + this) sigma beyond vwap
    no_trade_minutes: int = 15
    # partial_fraction=1.0: a single VWAP target, no partial/runner split,
    # since "return to the mean" is one natural target, not two.
    risk: RiskParams = field(default_factory=lambda: RiskParams(partial_fraction=1.0, max_risk_points=30.0))
    target_mode: str = "vwap"  # "vwap" (default) or "fixed_price" — see run_backtest
    target_price_points: float | None = None

    # Confluence filter: don't take the VWAP-sigma touch on its own — require
    # it to coincide with an actual sweep of a known level. asian_range_high/
    # low is excluded by default: it's the currently-forming session's own
    # still-extending range, so "swept" it is close to tautological (any
    # fresh local extreme trivially exceeds the running max/min so far) —
    # confirmed empirically (it fired more than the genuinely prior levels
    # combined). "Prior high or low" per the brief means PDH/PDL, the
    # previous NY session's high/low, and confirmed swing points.
    require_level_sweep: bool = True
    level_sweep_lookback_bars: int = 5
    levels: LevelToggles = field(default_factory=lambda: LevelToggles(asian_range_high=False, asian_range_low=False))
    session: SessionConfig = field(default_factory=SessionConfig)
    swing: SwingConfig = field(default_factory=SwingConfig)
    asian_range: AsianRangeConfig = field(default_factory=AsianRangeConfig)


def _load_5m_bars(symbol: str) -> pd.DataFrame:
    stem = symbol.replace(":", "_").replace("!", "")
    path = RAW_DIR / f"{stem}_5.parquet"
    if not path.exists():
        raise FileNotFoundError(f"No raw 5m data at {path} — run ml/data_collection/collect_replay.py first.")
    return pd.read_parquet(path).sort_values("time").reset_index(drop=True)


def run_backtest(symbol: str, cfg: VWAPReversionConfig, days: int | None = None, session: str = "ny"):
    df = load_1m_bars(symbol, days=days, no_trade_minutes=cfg.no_trade_minutes, session=session)
    point_value = load_point_value(symbol)

    sigma_series = df["dist_from_vwap_sigma"]
    prev_sigma = sigma_series.shift(1)

    tracker = None
    df5 = et5 = None
    j = n5 = 0
    bars_since_high_sweep = 10 ** 9
    bars_since_low_sweep = 10 ** 9
    if cfg.require_level_sweep:
        tracker = LevelTracker(cfg.session, cfg.swing, cfg.asian_range)
        df5 = _load_5m_bars(symbol)
        et5 = pd.to_datetime(df5["time"], unit="s", utc=True).dt.tz_convert(ET)
        n5 = len(df5)

    records: list[TradeLogRecord] = []
    open_trades: list[OpenTrade] = []

    n = len(df)
    for i in range(n):
        t = int(df["time"].iloc[i])
        bar = {"time": t, "open": df["open"].iloc[i], "high": df["high"].iloc[i],
               "low": df["low"].iloc[i], "close": df["close"].iloc[i]}

        still_open = []
        for trade in open_trades:
            rec = update_open_trade(trade, bar, cfg.risk, point_value)
            (records.append(rec) if rec else still_open.append(trade))
        open_trades = still_open

        if cfg.require_level_sweep:
            while j < n5 and int(df5["time"].iloc[j]) + 300 <= t:
                bar5 = {"time": int(df5["time"].iloc[j]), "open": df5["open"].iloc[j], "high": df5["high"].iloc[j],
                        "low": df5["low"].iloc[j], "close": df5["close"].iloc[j]}
                tracker.update(bar5, et5.iloc[j])
                j += 1

            levels = tracker.get_levels(cfg.levels)
            swept_high = any(bar["high"] > levels[name] for name in HIGH_SIDE_LEVELS if name in levels)
            swept_low = any(bar["low"] < levels[name] for name in LOW_SIDE_LEVELS if name in levels)
            bars_since_high_sweep = 0 if swept_high else bars_since_high_sweep + 1
            bars_since_low_sweep = 0 if swept_low else bars_since_low_sweep + 1

        if not bool(df["tradeable"].iloc[i]) or i < 1:
            continue

        sigma = sigma_series.iloc[i]
        p_sigma = prev_sigma.iloc[i]
        vwap = df["vwap"].iloc[i]
        vwap_std = df["vwap_std"].iloc[i]
        if pd.isna(sigma) or pd.isna(p_sigma) or pd.isna(vwap) or pd.isna(vwap_std):
            continue

        has_long_open = any(t2.direction == "long" for t2 in open_trades)
        has_short_open = any(t2.direction == "short" for t2 in open_trades)

        # edge-triggered: only the bar that first crosses the threshold
        long_signal = not has_long_open and sigma <= -cfg.entry_sigma < p_sigma
        short_signal = not has_short_open and sigma >= cfg.entry_sigma > p_sigma

        if cfg.require_level_sweep:
            long_signal = long_signal and bars_since_low_sweep <= cfg.level_sweep_lookback_bars
            short_signal = short_signal and bars_since_high_sweep <= cfg.level_sweep_lookback_bars

        for direction, signal in (("long", long_signal), ("short", short_signal)):
            if not signal:
                continue
            is_long = direction == "long"
            stop_sigma = cfg.entry_sigma + cfg.stop_sigma_buffer
            stop = vwap - stop_sigma * vwap_std if is_long else vwap + stop_sigma * vwap_std
            entry_price = bar["close"]
            risk_distance = abs(entry_price - stop)
            if cfg.target_mode == "fixed_price" and cfg.target_price_points is not None:
                target = entry_price + cfg.target_price_points if is_long else entry_price - cfg.target_price_points
            else:
                target = vwap

            rec = TradeLogRecord(strategy="vwap_reversion", symbol=symbol, direction=direction,
                                  signal_time=bar["time"], entry_price=entry_price, entry_time=bar["time"],
                                  stop_price=stop, target_price=target, risk_distance=risk_distance,
                                  note=f"vwap_sigma_at_signal={sigma:.2f}")
            if risk_distance <= 0 or risk_distance > cfg.risk.max_risk_points:
                rec.status, rec.reject_reason = "REJECTED", "RISK_TOO_LARGE"
                records.append(rec)
                continue
            rec.status = "OPEN"
            open_trades.append(OpenTrade(direction=direction, entry_price=entry_price, entry_time=bar["time"],
                                          stop_price=stop, initial_risk=risk_distance,
                                          partial_target_price=target, final_target_price=target, record=rec))

    if n:
        last_bar = {"time": int(df["time"].iloc[-1]), "close": float(df["close"].iloc[-1])}
        for trade in open_trades:
            records.append(force_close(trade, last_bar, point_value))

    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", default="MGC1!")
    parser.add_argument("--days", type=int, default=None)
    parser.add_argument("--entry-sigma", type=float, default=2.0)
    parser.add_argument("--no-level-sweep-filter", action="store_true", help="disable the level-sweep confluence filter")
    args = parser.parse_args()

    cfg = VWAPReversionConfig(entry_sigma=args.entry_sigma, require_level_sweep=not args.no_level_sweep_filter)
    records = run_backtest(args.symbol, cfg, args.days)
    path = write_csv(records, args.symbol, "vwap_reversion")
    print(f"Wrote {len(records)} records to {path}", file=sys.stderr)
    print(json.dumps(summarize(records), indent=2, default=str))


if __name__ == "__main__":
    main()
