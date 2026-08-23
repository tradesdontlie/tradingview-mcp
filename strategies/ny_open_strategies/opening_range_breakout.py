"""
Opening range breakout: the range formed in the first `orb_minutes` after NY
open (default 15 — the same window every strategy in this family is barred
from *trading* in) is used purely to define the range, then breakouts of it
are traded starting once the range closes.

Long: first close above orb_high after the range has formed.
Short: first close below orb_low after the range has formed.
Stop: opposite side of the opening range (classic ORB convention), plus
      buffer — rejected via max_risk_points if the range itself is too wide.
Target: fixed-R by default, or the "measured move" (range height projected
      from the breakout point) if target_mode="measured_move".
At most one long and one short entry per calendar day (a fresh breakout
attempt after being stopped out same-day isn't part of this base rule).

Run as a module from the repo root:
    python -m strategies.ny_open_strategies.opening_range_breakout --symbol MGC1! --days 30
"""
import argparse
import json
import sys
from dataclasses import dataclass, field

import pandas as pd

from .common import (OpenTrade, RiskParams, TradeLogRecord, force_close, load_1m_bars, load_point_value,
                      summarize, update_open_trade, write_csv)


@dataclass
class ORBConfig:
    orb_minutes: int = 15
    no_trade_minutes: int = 15  # kept equal to orb_minutes by convention — see module docstring
    target_mode: str = "fixed_r"  # "fixed_r", "measured_move", or "fixed_price"
    target_price_points: float | None = None
    # Stop is the opposite side of the opening range — checked empirically
    # against the actual data (median ~15pt, up to ~38pt on wide-range days)
    # since the sweep strategy's 6pt default gate rejected every signal here.
    risk: RiskParams = field(default_factory=lambda: RiskParams(target_r_multiple=2.0, partial_r_multiple=1.0,
                                                                  max_risk_points=20.0))


def run_backtest(symbol: str, cfg: ORBConfig, days: int | None = None, session: str = "ny"):
    df = load_1m_bars(symbol, days=days, no_trade_minutes=cfg.no_trade_minutes, orb_minutes=cfg.orb_minutes,
                       session=session)
    point_value = load_point_value(symbol)

    records: list[TradeLogRecord] = []
    open_trades: list[OpenTrade] = []
    traded_today = {"long": None, "short": None}  # calendar_date last traded, per direction
    n = len(df)

    for i in range(n):
        bar = {"time": int(df["time"].iloc[i]), "open": df["open"].iloc[i], "high": df["high"].iloc[i],
               "low": df["low"].iloc[i], "close": df["close"].iloc[i]}
        date = df["calendar_date"].iloc[i]

        still_open = []
        for trade in open_trades:
            rec = update_open_trade(trade, bar, cfg.risk, point_value)
            (records.append(rec) if rec else still_open.append(trade))
        open_trades = still_open

        if not bool(df["tradeable"].iloc[i]) or not bool(df["orb_formed"].iloc[i]):
            continue
        orb_high, orb_low = df["orb_high"].iloc[i], df["orb_low"].iloc[i]
        if pd.isna(orb_high) or pd.isna(orb_low):
            continue

        prev_close = df["close"].iloc[i - 1]
        long_signal = (traded_today["long"] != date and bar["close"] > orb_high and prev_close <= orb_high)
        short_signal = (traded_today["short"] != date and bar["close"] < orb_low and prev_close >= orb_low)

        for direction, signal in (("long", long_signal), ("short", short_signal)):
            if not signal:
                continue
            is_long = direction == "long"
            entry_price = bar["close"]
            stop = orb_low - cfg.risk.stop_buffer_points if is_long else orb_high + cfg.risk.stop_buffer_points
            risk_distance = abs(entry_price - stop)

            rec = TradeLogRecord(strategy="opening_range_breakout", symbol=symbol, direction=direction,
                                  signal_time=bar["time"], entry_price=entry_price, entry_time=bar["time"],
                                  stop_price=stop, risk_distance=risk_distance,
                                  note=f"orb_high={orb_high:.2f} orb_low={orb_low:.2f}")
            traded_today[direction] = date  # counts against the daily cap even if rejected — one attempt/day
            if risk_distance <= 0 or risk_distance > cfg.risk.max_risk_points:
                rec.status, rec.reject_reason = "REJECTED", "RISK_TOO_LARGE"
                records.append(rec)
                continue

            range_height = orb_high - orb_low
            if cfg.target_mode == "measured_move":
                final_target = entry_price + range_height if is_long else entry_price - range_height
            elif cfg.target_mode == "fixed_price" and cfg.target_price_points is not None:
                final_target = entry_price + cfg.target_price_points if is_long else entry_price - cfg.target_price_points
            else:
                final_target = entry_price + cfg.risk.target_r_multiple * risk_distance if is_long else \
                                entry_price - cfg.risk.target_r_multiple * risk_distance
            partial_target = entry_price + cfg.risk.partial_r_multiple * risk_distance if is_long else \
                              entry_price - cfg.risk.partial_r_multiple * risk_distance

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
    parser.add_argument("--target-mode", choices=["fixed_r", "measured_move"], default="fixed_r")
    args = parser.parse_args()

    cfg = ORBConfig(target_mode=args.target_mode)
    records = run_backtest(args.symbol, cfg, args.days)
    path = write_csv(records, args.symbol, "opening_range_breakout")
    print(f"Wrote {len(records)} records to {path}", file=sys.stderr)
    print(json.dumps(summarize(records), indent=2, default=str))


if __name__ == "__main__":
    main()
