#!/usr/bin/env python3

import argparse
import io
import json
from dataclasses import asdict, dataclass

import pandas as pd
import requests
import yfinance as yf

NSE_LOT_SIZE_URL = "https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv"
NSE_HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Referer": "https://www.nseindia.com/",
}


@dataclass
class SymbolConfig:
    name: str
    yahoo_symbol: str
    nse_symbol: str
    fallback_lot_size: int
    threshold_candidates: tuple[float, ...]


SYMBOLS = {
    "NIFTY": SymbolConfig(
        name="NIFTY",
        yahoo_symbol="^NSEI",
        nse_symbol="NIFTY",
        fallback_lot_size=65,
        threshold_candidates=(0.0015, 0.0020, 0.0025, 0.0030, 0.0035),
    ),
    "BANKNIFTY": SymbolConfig(
        name="BANKNIFTY",
        yahoo_symbol="^NSEBANK",
        nse_symbol="BANKNIFTY",
        fallback_lot_size=30,
        threshold_candidates=(0.0015, 0.0020, 0.0025, 0.0030, 0.0035, 0.0040),
    ),
}


def fetch_lot_sizes():
    try:
        response = requests.get(NSE_LOT_SIZE_URL, headers=NSE_HEADERS, timeout=20)
        response.raise_for_status()
        raw = pd.read_csv(io.StringIO(response.text))
        raw.columns = [str(col).strip() for col in raw.columns]
        frame = raw.copy()
        for col in frame.columns:
            frame[col] = frame[col].map(lambda value: value.strip() if isinstance(value, str) else value)
        expiry_cols = [col for col in frame.columns if col not in {"UNDERLYING", "SYMBOL"}]
        lots = {}
        for _, row in frame.iterrows():
            symbol = str(row.get("SYMBOL", "")).strip()
            if not symbol:
                continue
            values = []
            for col in expiry_cols:
                value = str(row.get(col, "")).strip()
                if value.isdigit():
                    values.append(int(value))
            if values:
                lots[symbol] = values[0]
        return lots
    except Exception:
        return {}


def load_bars(yahoo_symbol: str, period: str, interval: str) -> pd.DataFrame:
    data = yf.download(
        yahoo_symbol,
        period=period,
        interval=interval,
        progress=False,
        auto_adjust=False,
    )
    if data.empty:
        raise RuntimeError(f"No bars returned for {yahoo_symbol}")

    if isinstance(data.columns, pd.MultiIndex):
        data.columns = [column[0].lower().replace(" ", "_") for column in data.columns]
    else:
        data.columns = [column.lower().replace(" ", "_") for column in data.columns]

    data = data[["open", "high", "low", "close"]].dropna().copy()
    data.index = data.index.tz_convert("Asia/Kolkata")
    data["session"] = data.index.date
    data["bar_in_day"] = data.groupby("session").cumcount()
    return data


def backtest_first_hour_to_last_hour(
    bars: pd.DataFrame,
    lot_size: int,
    threshold: float,
    opening_bars: int = 4,
    last_hour_bars: int = 4,
):
    trades = []
    for session in bars["session"].unique():
        day = bars[bars["session"] == session].copy().reset_index()
        if len(day) < opening_bars + last_hour_bars:
            continue

        opening = day.iloc[:opening_bars]
        entry_row = day.iloc[len(day) - last_hour_bars]
        exit_row = day.iloc[-1]

        first_open = float(opening.iloc[0]["open"])
        first_close = float(opening.iloc[-1]["close"])
        signal_return = (first_close - first_open) / first_open
        if abs(signal_return) < threshold:
            continue

        direction = 1 if signal_return > 0 else -1
        entry_price = float(entry_row["open"])
        exit_price = float(exit_row["close"])
        pnl_points = (exit_price - entry_price) * direction

        trades.append(
            {
                "session": str(session),
                "direction": "LONG" if direction > 0 else "SHORT",
                "signal_return_pct": round(signal_return * 100, 4),
                "entry_time": entry_row["Datetime"].isoformat(),
                "exit_time": exit_row["Datetime"].isoformat(),
                "entry_price": round(entry_price, 2),
                "exit_price": round(exit_price, 2),
                "pnl_points": round(pnl_points, 2),
                "pnl_inr_one_lot": round(pnl_points * lot_size, 2),
            }
        )
    return trades


def summarize_trades(trades, lot_size: int):
    if not trades:
        return {
            "trade_count": 0,
            "net_points": 0.0,
            "net_inr_one_lot": 0.0,
            "win_rate": 0.0,
            "profit_factor": 0.0,
            "avg_points": 0.0,
            "avg_inr_one_lot": 0.0,
            "max_drawdown_points": 0.0,
            "largest_winner_points": 0.0,
            "largest_loser_points": 0.0,
        }

    pnl_points = pd.Series([trade["pnl_points"] for trade in trades], dtype="float64")
    gross_wins = pnl_points[pnl_points > 0].sum()
    gross_losses = -pnl_points[pnl_points < 0].sum()
    cumulative = pnl_points.cumsum()
    max_drawdown = float((cumulative.cummax() - cumulative).max())

    return {
        "trade_count": int(len(trades)),
        "net_points": round(float(pnl_points.sum()), 2),
        "net_inr_one_lot": round(float(pnl_points.sum() * lot_size), 2),
        "win_rate": round(float((pnl_points > 0).mean() * 100), 2),
        "profit_factor": round(float(gross_wins / gross_losses), 3) if gross_losses else None,
        "avg_points": round(float(pnl_points.mean()), 2),
        "avg_inr_one_lot": round(float(pnl_points.mean() * lot_size), 2),
        "max_drawdown_points": round(max_drawdown, 2),
        "largest_winner_points": round(float(pnl_points.max()), 2),
        "largest_loser_points": round(float(pnl_points.min()), 2),
    }


def pick_threshold(training_bars: pd.DataFrame, lot_size: int, candidates):
    ranked = []
    for threshold in candidates:
        trades = backtest_first_hour_to_last_hour(training_bars, lot_size=lot_size, threshold=threshold)
        summary = summarize_trades(trades, lot_size)
        score = (
            summary["net_points"],
            summary["profit_factor"] if summary["profit_factor"] is not None else -1,
            summary["trade_count"],
        )
        ranked.append((score, threshold, summary))
    ranked.sort(reverse=True)
    return ranked[0][1], ranked[0][2], ranked


def run_symbol(config: SymbolConfig, lot_size: int, period: str, interval: str, train_sessions: int, test_sessions: int):
    bars = load_bars(config.yahoo_symbol, period=period, interval=interval)
    sessions = list(bars["session"].unique())
    if len(sessions) < train_sessions + test_sessions:
        raise RuntimeError(
            f"{config.name} returned only {len(sessions)} sessions, need at least {train_sessions + test_sessions}"
        )

    training_slice = sessions[:train_sessions]
    testing_slice = sessions[-test_sessions:]

    training_bars = bars[bars["session"].isin(training_slice)].copy()
    testing_bars = bars[bars["session"].isin(testing_slice)].copy()

    threshold, training_summary, threshold_ranking = pick_threshold(
        training_bars,
        lot_size=lot_size,
        candidates=config.threshold_candidates,
    )
    test_trades = backtest_first_hour_to_last_hour(testing_bars, lot_size=lot_size, threshold=threshold)
    test_summary = summarize_trades(test_trades, lot_size)

    return {
        "symbol": config.name,
        "yahoo_symbol": config.yahoo_symbol,
        "lot_size": lot_size,
        "strategy": {
            "name": "first_hour_momentum_last_hour_entry",
            "description": (
                "If the first 60 minutes closes strongly up or down, trade in the same direction "
                "from the 14:30 IST open to the 15:30 IST close."
            ),
            "opening_bars": 4,
            "entry_bar_from_session_end": 4,
            "selected_threshold_pct": round(threshold * 100, 3),
        },
        "training_window": {
            "sessions": len(training_slice),
            "from": str(training_slice[0]),
            "to": str(training_slice[-1]),
            "summary": training_summary,
        },
        "test_window": {
            "sessions": len(testing_slice),
            "from": str(testing_slice[0]),
            "to": str(testing_slice[-1]),
            "summary": test_summary,
            "trades": test_trades,
        },
        "threshold_ranking": [
            {
                "threshold_pct": round(threshold_value * 100, 3),
                "summary": summary,
            }
            for _, threshold_value, summary in threshold_ranking
        ],
    }


def build_parser():
    parser = argparse.ArgumentParser(
        description="Backtest a simple Nifty and Bank Nifty intraday momentum strategy.",
    )
    parser.add_argument(
        "--symbols",
        nargs="+",
        default=["NIFTY", "BANKNIFTY"],
        choices=sorted(SYMBOLS.keys()),
        help="Symbols to backtest.",
    )
    parser.add_argument("--period", default="30d", help="Yahoo Finance lookback window.")
    parser.add_argument("--interval", default="15m", help="Bar interval.")
    parser.add_argument("--train-sessions", type=int, default=10, help="Calibration sessions.")
    parser.add_argument("--test-sessions", type=int, default=20, help="Out-of-sample sessions.")
    parser.add_argument("--json", action="store_true", help="Emit raw JSON.")
    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()

    lot_sizes = fetch_lot_sizes()
    reports = []
    for symbol_name in args.symbols:
        config = SYMBOLS[symbol_name]
        lot_size = lot_sizes.get(config.nse_symbol, config.fallback_lot_size)
        reports.append(
            run_symbol(
                config,
                lot_size=lot_size,
                period=args.period,
                interval=args.interval,
                train_sessions=args.train_sessions,
                test_sessions=args.test_sessions,
            )
        )

    payload = {
        "assumptions": {
            "data_source": "Yahoo Finance intraday index data",
            "lot_size_source": NSE_LOT_SIZE_URL,
            "prices_are_index_points": True,
            "transaction_costs_included": False,
        },
        "reports": reports,
    }

    if args.json:
        print(json.dumps(payload, indent=2))
        return

    print("NSE intraday momentum backtest")
    print("Signal: first-hour momentum, entry at 14:30 IST, exit at 15:30 IST")
    print("Calibration: first 10 sessions | Validation: latest 20 sessions")
    print("Costs: excluded")
    print()

    for report in reports:
        summary = report["test_window"]["summary"]
        latest = report["test_window"]["trades"][-1] if report["test_window"]["trades"] else None
        print(f"{report['symbol']} ({report['yahoo_symbol']})")
        print(
            f"  lot size: {report['lot_size']} | threshold: {report['strategy']['selected_threshold_pct']}%"
        )
        print(
            f"  test window: {report['test_window']['from']} -> {report['test_window']['to']} | "
            f"trades: {summary['trade_count']} | win rate: {summary['win_rate']}%"
        )
        print(
            f"  net: {summary['net_points']} pts | one-lot gross: Rs {summary['net_inr_one_lot']}"
        )
        print(
            f"  profit factor: {summary['profit_factor']} | max drawdown: {summary['max_drawdown_points']} pts"
        )
        if latest:
            print(
                f"  latest trade: {latest['session']} {latest['direction']} "
                f"{latest['entry_price']} -> {latest['exit_price']} | "
                f"{latest['pnl_points']} pts | Rs {latest['pnl_inr_one_lot']}"
            )
        print()


if __name__ == "__main__":
    main()
