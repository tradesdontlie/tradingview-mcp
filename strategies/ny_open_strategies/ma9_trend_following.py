"""
MA9 trend-following (continuation, not reversal): trade WITH a rising/falling
1m EMA9, entering on a shallow pullback that touches the EMA9 and then closes
back away from it in the trend direction — the inverse premise of the sweep
strategies (there, price failing at an extreme is the signal; here, an
established trend continuing through a pullback is the signal).

Trend: EMA9 has moved at least min_slope_points over slope_lookback_bars,
       and price is on the trend side of it.
Pullback + continuation: low (long) / high (short) touched within
       pullback_tolerance_points of EMA9 at some point in the last
       pullback_lookback_bars bars (not this bar), and this bar closes back
       above/below EMA9 with a same-direction candle.

Run as a module from the repo root:
    python -m strategies.ny_open_strategies.ma9_trend_following --symbol MGC1! --days 30
"""
import argparse
import json
import sys
from dataclasses import dataclass, field

from .common import (OpenTrade, RiskParams, TradeLogRecord, force_close, load_1m_bars, load_point_value,
                      summarize, update_open_trade, write_csv)


@dataclass
class MA9TrendConfig:
    slope_lookback_bars: int = 10
    min_slope_points: float = 0.5
    pullback_lookback_bars: int = 5
    pullback_tolerance_points: float = 0.3
    no_trade_minutes: int = 15
    target_mode: str = "fixed_r"  # "fixed_r" or "fixed_price"
    target_price_points: float | None = None
    risk: RiskParams = field(default_factory=lambda: RiskParams(target_r_multiple=2.0, partial_r_multiple=1.0))


def run_backtest(symbol: str, cfg: MA9TrendConfig, days: int | None = None, session: str = "ny"):
    df = load_1m_bars(symbol, days=days, no_trade_minutes=cfg.no_trade_minutes, session=session)
    point_value = load_point_value(symbol)

    ema9 = df["ema9"]
    slope = ema9.diff(cfg.slope_lookback_bars)
    trend_up = (slope > cfg.min_slope_points) & (df["close"] > ema9)
    trend_down = (slope < -cfg.min_slope_points) & (df["close"] < ema9)

    # Separate up/down touch definitions: for a long pullback we only care
    # the LOW came down near ema9; for a short pullback, the HIGH came up
    # near ema9.
    touched_from_above = df["low"] <= ema9 + cfg.pullback_tolerance_points  # pulled back down to ema9 in an uptrend
    touched_from_below = df["high"] >= ema9 - cfg.pullback_tolerance_points  # pulled back up to ema9 in a downtrend
    recent_touch_up = touched_from_above.rolling(cfg.pullback_lookback_bars).max().shift(1).fillna(0).astype(bool)
    recent_touch_down = touched_from_below.rolling(cfg.pullback_lookback_bars).max().shift(1).fillna(0).astype(bool)

    rolling_min_low = df["low"].rolling(cfg.pullback_lookback_bars).min()
    rolling_max_high = df["high"].rolling(cfg.pullback_lookback_bars).max()

    records: list[TradeLogRecord] = []
    open_trades: list[OpenTrade] = []
    n = len(df)

    for i in range(n):
        bar = {"time": int(df["time"].iloc[i]), "open": df["open"].iloc[i], "high": df["high"].iloc[i],
               "low": df["low"].iloc[i], "close": df["close"].iloc[i]}

        still_open = []
        for trade in open_trades:
            rec = update_open_trade(trade, bar, cfg.risk, point_value)
            (records.append(rec) if rec else still_open.append(trade))
        open_trades = still_open

        if not bool(df["tradeable"].iloc[i]) or i < max(cfg.slope_lookback_bars, cfg.pullback_lookback_bars):
            continue

        has_long_open = any(t.direction == "long" for t in open_trades)
        has_short_open = any(t.direction == "short" for t in open_trades)

        long_signal = (not has_long_open and bool(trend_up.iloc[i]) and bool(recent_touch_up.iloc[i])
                       and bar["close"] > float(ema9.iloc[i]) and bar["close"] > bar["open"])
        short_signal = (not has_short_open and bool(trend_down.iloc[i]) and bool(recent_touch_down.iloc[i])
                        and bar["close"] < float(ema9.iloc[i]) and bar["close"] < bar["open"])

        for direction, signal in (("long", long_signal), ("short", short_signal)):
            if not signal:
                continue
            is_long = direction == "long"
            extreme = rolling_min_low.iloc[i] if is_long else rolling_max_high.iloc[i]
            stop = extreme - cfg.risk.stop_buffer_points if is_long else extreme + cfg.risk.stop_buffer_points
            entry_price = bar["close"]
            risk_distance = abs(entry_price - stop)

            rec = TradeLogRecord(strategy="ma9_trend_following", symbol=symbol, direction=direction,
                                  signal_time=bar["time"], entry_price=entry_price, entry_time=bar["time"],
                                  stop_price=stop, risk_distance=risk_distance,
                                  note=f"ema9_slope={float(slope.iloc[i]):.2f}")
            if risk_distance <= 0 or risk_distance > cfg.risk.max_risk_points:
                rec.status, rec.reject_reason = "REJECTED", "RISK_TOO_LARGE"
                records.append(rec)
                continue

            partial_target = entry_price + cfg.risk.partial_r_multiple * risk_distance if is_long else \
                              entry_price - cfg.risk.partial_r_multiple * risk_distance
            if cfg.target_mode == "fixed_price" and cfg.target_price_points is not None:
                final_target = entry_price + cfg.target_price_points if is_long else entry_price - cfg.target_price_points
            else:
                final_target = entry_price + cfg.risk.target_r_multiple * risk_distance if is_long else \
                                entry_price - cfg.risk.target_r_multiple * risk_distance
            rec.target_price = final_target
            rec.status = "OPEN"
            open_trades.append(OpenTrade(direction=direction, entry_price=entry_price, entry_time=bar["time"],
                                          stop_price=stop, initial_risk=risk_distance,
                                          partial_target_price=partial_target, final_target_price=final_target,
                                          record=rec))

    if n:
        last_bar = {"time": int(df["time"].iloc[-1]), "close": float(df["close"].iloc[-1])}
        for trade in open_trades:
            records.append(force_close(trade, last_bar, point_value))

    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", default="MGC1!")
    parser.add_argument("--days", type=int, default=None)
    args = parser.parse_args()

    cfg = MA9TrendConfig()
    records = run_backtest(args.symbol, cfg, args.days)
    path = write_csv(records, args.symbol, "ma9_trend_following")
    print(f"Wrote {len(records)} records to {path}", file=sys.stderr)
    print(json.dumps(summarize(records), indent=2, default=str))


if __name__ == "__main__":
    main()
