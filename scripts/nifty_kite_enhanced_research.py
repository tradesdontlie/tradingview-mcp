#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from kite_api import (
    DEFAULT_ENV_FILES,
    get_historical_candles,
    load_env_files,
    require_env,
)
from kite_strict_execution_report import (
    apply_costs,
    build_futures_orders,
    fetch_charge_rows,
    representative_future,
    summarize_trade_costs,
)

import india_intraday_research as base


REPO_ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = REPO_ROOT / "market" / "raw" / "kite"
REPORT_PATH = REPO_ROOT / "market" / "reports" / "nifty_enhanced_research.json"
PROXY_15M_PATH = RAW_DIR / "NIFTYBEES_15minute.parquet"
PROXY_15M_CSV = RAW_DIR / "NIFTYBEES_15minute.csv"
INSTRUMENTS_PATH = RAW_DIR / "reference" / "instruments_latest.csv"

ENTRY_CUTOFF = "14:45:00"
HARD_EXIT = "15:00:00"
MIN_TRAIN = 250
TEST_SIZE = 20
MIN_TRADE_COUNT = 12
HOLDOUT_SESSIONS = 40
RVOL_THRESHOLD = 1.10
ROLLING_LOOKBACK = 60
CPR_LOOKBACK = 20
SIGNAL_BARS = {
    3: "10:15",
    7: "11:15",
    11: "12:15",
    15: "13:15",
    19: "14:15",
}
EVENT_DAYS = {
    "2020-03-09": "Oil shock / COVID panic",
    "2020-03-12": "COVID crash",
    "2020-03-13": "Rebound / circuit day",
    "2020-03-18": "COVID selloff",
    "2020-03-20": "Relief rally",
    "2020-03-23": "Lockdown crash / trading halt",
    "2020-03-25": "Stimulus rebound",
    "2020-03-26": "Reversal after rebound",
    "2021-02-01": "Union Budget",
    "2024-06-04": "Election result shock",
}


@dataclass(frozen=True)
class Candidate:
    name: str
    signal_bar_index: int
    threshold: float
    use_proxy_vwap: bool
    use_proxy_rvol: bool
    use_or_band: bool
    use_cpr_narrow: bool

    def public(self) -> dict:
        payload = asdict(self)
        payload["threshold_pct"] = round(self.threshold * 100.0, 3)
        payload["entry_time"] = SIGNAL_BARS[self.signal_bar_index]
        payload.pop("threshold")
        return payload


def load_instruments() -> pd.DataFrame:
    frame = pd.read_csv(INSTRUMENTS_PATH, low_memory=False)
    for col in ("instrument_token", "lot_size", "strike"):
        if col in frame.columns:
            frame[col] = pd.to_numeric(frame[col], errors="coerce")
    if "expiry" in frame.columns:
        frame["expiry"] = pd.to_datetime(frame["expiry"], errors="coerce")
    return frame


def chunk_ranges(start_day: date, end_day: date, chunk_days: int) -> list[tuple[date, date]]:
    ranges: list[tuple[date, date]] = []
    current = start_day
    while current <= end_day:
        chunk_end = min(current + timedelta(days=chunk_days - 1), end_day)
        ranges.append((current, chunk_end))
        current = chunk_end + timedelta(days=1)
    return ranges


def ensure_proxy_15m_cache(api_key: str, access_token: str, *, refresh: bool = False) -> pd.DataFrame:
    if PROXY_15M_PATH.exists() and not refresh:
        frame = pd.read_parquet(PROXY_15M_PATH)
        frame["timestamp"] = pd.to_datetime(frame["timestamp"])
        return frame.sort_values("timestamp").reset_index(drop=True)

    instruments = load_instruments()
    matched = instruments[
        (instruments["exchange"].astype(str).str.upper() == "NSE")
        & (instruments["tradingsymbol"].astype(str).str.upper() == "NIFTYBEES")
    ]
    if matched.empty:
        raise RuntimeError("Could not resolve NIFTYBEES from Kite instruments.")
    row = matched.iloc[0]
    instrument_token = int(row["instrument_token"])

    frames: list[pd.DataFrame] = []
    for chunk_start, chunk_end in chunk_ranges(date(2020, 1, 1), date.today(), 60):
        payload = get_historical_candles(
            api_key,
            access_token,
            instrument_token,
            "15minute",
            from_ts=f"{chunk_start.isoformat()} 09:15:00",
            to_ts=f"{chunk_end.isoformat()} 15:30:00",
            oi=1,
        )
        candles = payload.get("data", {}).get("candles", []) if isinstance(payload, dict) else []
        rows = []
        for candle in candles:
            if not isinstance(candle, list) or len(candle) < 6:
                continue
            rows.append(
                {
                    "timestamp": pd.Timestamp(candle[0]).tz_localize(None),
                    "open": float(candle[1]),
                    "high": float(candle[2]),
                    "low": float(candle[3]),
                    "close": float(candle[4]),
                    "volume": float(candle[5]) if candle[5] is not None else 0.0,
                    "oi": None if len(candle) < 7 or candle[6] is None else float(candle[6]),
                    "symbol": "NIFTYBEES",
                    "tradingsymbol": str(row["tradingsymbol"]),
                    "instrument_token": instrument_token,
                    "source": "kite",
                    "interval": "15minute",
                }
            )
        if rows:
            frames.append(pd.DataFrame(rows))
    if not frames:
        raise RuntimeError("No NIFTYBEES 15m bars returned from Kite.")
    frame = pd.concat(frames, ignore_index=True).sort_values("timestamp").drop_duplicates(subset=["timestamp"]).reset_index(drop=True)
    PROXY_15M_PATH.parent.mkdir(parents=True, exist_ok=True)
    frame.to_parquet(PROXY_15M_PATH, index=False)
    frame.to_csv(PROXY_15M_CSV, index=False)
    return frame


def load_index_15m() -> pd.DataFrame:
    frame = pd.read_parquet(RAW_DIR / "NIFTY_15minute.parquet")
    frame["timestamp"] = pd.to_datetime(frame["timestamp"])
    frame = frame.sort_values("timestamp").reset_index(drop=True)
    frame["session"] = frame["timestamp"].dt.normalize()
    return frame


def load_daily() -> pd.DataFrame:
    frame = pd.read_parquet(RAW_DIR / "NIFTY_daily.parquet")
    frame["date"] = pd.to_datetime(frame["date"]).dt.normalize()
    frame = frame.sort_values("date").reset_index(drop=True)
    return frame


def session_time(session: pd.Timestamp, hhmmss: str) -> pd.Timestamp:
    return pd.Timestamp(f"{session.strftime('%Y-%m-%d')} {hhmmss}")


def indicator_vwap(day: pd.DataFrame, bar_index: int) -> tuple[float | None, float]:
    subset = day.iloc[: bar_index + 1].copy()
    volume = subset["volume"].astype(float).fillna(0.0)
    typical = (subset["high"].astype(float) + subset["low"].astype(float) + subset["close"].astype(float)) / 3.0
    total_volume = float(volume.sum())
    if total_volume <= 0.0:
        return None, total_volume
    vwap = float((typical * volume).sum() / total_volume)
    return vwap, total_volume


def build_feature_frame(proxy_15m: pd.DataFrame) -> pd.DataFrame:
    daily = load_daily()
    daily_indexed = daily.set_index("date")
    index_15m = load_index_15m()
    vix = base.load_vix()
    proxy_15m = proxy_15m.copy()
    proxy_15m["timestamp"] = pd.to_datetime(proxy_15m["timestamp"])
    proxy_15m["session"] = proxy_15m["timestamp"].dt.normalize()

    index_counts = index_15m.groupby("session").size()
    proxy_counts = proxy_15m.groupby("session").size()
    good_sessions = sorted(set(index_counts[index_counts >= 24].index) & set(proxy_counts[proxy_counts >= 24].index))

    rows = []
    for session in good_sessions:
        day = index_15m[index_15m["session"] == session].sort_values("timestamp").reset_index(drop=True)
        proxy_day = proxy_15m[proxy_15m["session"] == session].sort_values("timestamp").reset_index(drop=True)
        prev_daily = daily_indexed[daily_indexed.index < session].tail(1)
        prev_vix = vix[vix.index < session].tail(1)
        if prev_daily.empty or prev_vix.empty:
            continue
        exit_cutoff = session_time(session, HARD_EXIT)
        exit_rows = day[day["timestamp"] >= exit_cutoff]
        if exit_rows.empty:
            continue
        exit_row = exit_rows.iloc[0]
        prev_high = float(prev_daily["high"].iloc[0])
        prev_low = float(prev_daily["low"].iloc[0])
        prev_close = float(prev_daily["close"].iloc[0])
        pivot = (prev_high + prev_low + prev_close) / 3.0
        bc = (prev_high + prev_low) / 2.0
        tc = 2.0 * pivot - bc
        prev_cpr_width = abs(tc - bc) / prev_close if prev_close else np.nan
        day_open = float(day.loc[0, "open"])
        or_width = (float(day.loc[:3, "high"].max()) - float(day.loc[:3, "low"].min())) / day_open if len(day) >= 4 else np.nan

        for signal_bar_index, entry_time in SIGNAL_BARS.items():
            entry_index = signal_bar_index + 1
            if len(day) <= entry_index or len(proxy_day) <= signal_bar_index:
                continue
            entry_row = day.loc[entry_index]
            if pd.Timestamp(entry_row["timestamp"]) > session_time(session, ENTRY_CUTOFF):
                continue
            signal_close = float(day.loc[signal_bar_index, "close"])
            signal_ret = (signal_close - day_open) / day_open
            direction = 1 if signal_ret > 0 else -1 if signal_ret < 0 else 0
            proxy_vwap, proxy_cum_volume = indicator_vwap(proxy_day, signal_bar_index)
            proxy_close = float(proxy_day.loc[signal_bar_index, "close"])
            signal_range = (float(day.loc[:signal_bar_index, "high"].max()) - float(day.loc[:signal_bar_index, "low"].min())) / day_open
            rows.append(
                {
                    "session": session,
                    "signal_bar_index": signal_bar_index,
                    "entry_time": entry_time,
                    "entry_timestamp": pd.Timestamp(entry_row["timestamp"]),
                    "exit_timestamp": pd.Timestamp(exit_row["timestamp"]),
                    "day_open": day_open,
                    "signal_close": signal_close,
                    "signal_ret": signal_ret,
                    "direction_value": direction,
                    "entry_price": float(entry_row["open"]),
                    "exit_price": float(exit_row["open"]),
                    "pnl_points_raw": (float(exit_row["open"]) - float(entry_row["open"])) * direction,
                    "prev_close": prev_close,
                    "gap_ret": (day_open - prev_close) / prev_close if prev_close else np.nan,
                    "prev_cpr_width": prev_cpr_width,
                    "prev_vix": float(prev_vix["vix"].iloc[0]),
                    "prev_vix_med20": float(prev_vix["vix_med20"].iloc[0]),
                    "or_width_1h": or_width,
                    "signal_range": signal_range,
                    "proxy_close": proxy_close,
                    "proxy_vwap": proxy_vwap,
                    "proxy_vwap_dir": 0 if proxy_vwap is None else (1 if proxy_close > proxy_vwap else -1 if proxy_close < proxy_vwap else 0),
                    "proxy_cum_volume": proxy_cum_volume,
                    "event_name": EVENT_DAYS.get(session.strftime("%Y-%m-%d")),
                }
            )

    frame = pd.DataFrame(rows).sort_values(["session", "signal_bar_index"]).reset_index(drop=True)
    if frame.empty:
        return frame
    frame["cpr_med20"] = frame.groupby("signal_bar_index")["prev_cpr_width"].transform(lambda s: s.shift(1).rolling(CPR_LOOKBACK, min_periods=10).median())
    frame["cpr_narrow_flag"] = frame["prev_cpr_width"] <= frame["cpr_med20"]
    frame["or_q25"] = frame.groupby("signal_bar_index")["or_width_1h"].transform(lambda s: s.shift(1).rolling(ROLLING_LOOKBACK, min_periods=20).quantile(0.25))
    frame["or_q90"] = frame.groupby("signal_bar_index")["or_width_1h"].transform(lambda s: s.shift(1).rolling(ROLLING_LOOKBACK, min_periods=20).quantile(0.90))
    frame["proxy_cum_vol_med20"] = frame.groupby("signal_bar_index")["proxy_cum_volume"].transform(lambda s: s.shift(1).rolling(CPR_LOOKBACK, min_periods=10).median())
    frame["proxy_rvol_ratio"] = frame["proxy_cum_volume"] / frame["proxy_cum_vol_med20"].replace(0.0, np.nan)
    return frame


def candidate_pool() -> list[Candidate]:
    candidates = [
        Candidate("open_1015_thr040_base", 3, 0.0040, False, False, False, False),
        Candidate("open_1015_thr050_base", 3, 0.0050, False, False, False, False),
        Candidate("open_1115_thr050_base", 7, 0.0050, False, False, False, False),
        Candidate("open_1215_thr050_base", 11, 0.0050, False, False, False, False),
        Candidate("mid_1315_thr040_base", 15, 0.0040, False, False, False, False),
        Candidate("mid_1315_thr050_base", 15, 0.0050, False, False, False, False),
        Candidate("mid_1315_thr050_vwap", 15, 0.0050, True, False, False, False),
        Candidate("mid_1315_thr050_vwap_rvol", 15, 0.0050, True, True, False, False),
        Candidate("mid_1315_thr050_vwap_rvol_or", 15, 0.0050, True, True, True, False),
        Candidate("mid_1315_thr050_vwap_rvol_or_cpr", 15, 0.0050, True, True, True, True),
        Candidate("late_1415_thr050_base", 19, 0.0050, False, False, False, False),
    ]
    return candidates


def candidate_mask(frame: pd.DataFrame, candidate: Candidate) -> pd.Series:
    subset = frame["signal_bar_index"] == candidate.signal_bar_index
    direction = np.sign(frame["signal_ret"]).astype(int)
    mask = subset & (frame["signal_ret"].abs() >= candidate.threshold) & (direction != 0)
    if candidate.use_proxy_vwap:
        mask &= frame["proxy_vwap_dir"] == direction
    if candidate.use_proxy_rvol:
        mask &= frame["proxy_rvol_ratio"] >= RVOL_THRESHOLD
    if candidate.use_or_band:
        mask &= frame["or_width_1h"] >= frame["or_q25"]
        mask &= frame["or_width_1h"] <= frame["or_q90"]
    if candidate.use_cpr_narrow:
        mask &= frame["cpr_narrow_flag"].fillna(False)
    return mask.fillna(False)


def candidate_trade_frame(frame: pd.DataFrame, candidate: Candidate) -> tuple[pd.DataFrame, pd.Series]:
    if frame.empty:
        return pd.DataFrame(), pd.Series(dtype=float)
    mask = candidate_mask(frame, candidate)
    unique_sessions = pd.DatetimeIndex(pd.Series(frame["session"]).drop_duplicates())
    session_returns = pd.Series(0.0, index=unique_sessions, dtype=float)
    trades = frame.loc[
        mask,
        [
            "session",
            "entry_timestamp",
            "exit_timestamp",
            "entry_price",
            "exit_price",
            "direction_value",
            "event_name",
            "proxy_rvol_ratio",
            "or_width_1h",
            "prev_cpr_width",
        ],
    ].copy()
    if trades.empty:
        return trades, session_returns
    trades["direction"] = np.where(trades["direction_value"] > 0, "LONG", "SHORT")
    trades["pnl_points"] = (trades["exit_price"] - trades["entry_price"]) * trades["direction_value"]
    trades["pnl_pct"] = ((trades["exit_price"] / trades["entry_price"]) - 1.0) * trades["direction_value"]
    trades = trades.reset_index(drop=True)
    trade_sessions = pd.DatetimeIndex(trades["session"])
    session_returns.loc[trade_sessions] = trades["pnl_pct"].astype(float).values
    return trades, session_returns


def evaluate_candidate(frame: pd.DataFrame, candidate: Candidate) -> dict:
    trades, returns = candidate_trade_frame(frame, candidate)
    summary = base.summary_from_trades(trades, returns, session_count=len(frame))
    return {"summary": summary, "trades": trades, "session_returns": returns}


def expanding_walk_forward(frame: pd.DataFrame, candidates: list[Candidate]) -> dict:
    if len(frame) < MIN_TRAIN + TEST_SIZE:
        return {"folds": 0, "oos_net_points": 0.0, "oos_trade_count": 0, "pick_counts": [], "recent_picks": []}
    picks = []
    out = []
    for start in range(MIN_TRAIN, len(frame) - TEST_SIZE + 1, TEST_SIZE):
        train = frame.iloc[:start].reset_index(drop=True)
        test = frame.iloc[start : start + TEST_SIZE].reset_index(drop=True)
        best = None
        for candidate in candidates:
            metrics = evaluate_candidate(train, candidate)["summary"]
            score = (
                float(metrics["session_sharpe"]) if metrics["session_sharpe"] is not None else -1e18,
                metrics["net_points"],
                metrics["profit_factor"] or -1e18,
            )
            if metrics["trade_count"] < MIN_TRADE_COUNT:
                score = (-1e18, -1e18, -1e18)
            if best is None or score > best[0]:
                best = (score, candidate, metrics)
        test_metrics = evaluate_candidate(test, best[1])["summary"]
        picks.append({"candidate": best[1].public(), "train_summary": best[2], "test_summary": test_metrics})
        out.append(test_metrics)
    counts: dict[str, int] = {}
    for pick in picks:
        key = pick["candidate"]["name"]
        counts[key] = counts.get(key, 0) + 1
    return {
        "folds": len(picks),
        "oos_net_points": round(float(sum(item["net_points"] for item in out)), 2),
        "oos_trade_count": int(sum(item["trade_count"] for item in out)),
        "pick_counts": [{"name": name, "count": count} for name, count in sorted(counts.items(), key=lambda item: item[1], reverse=True)],
        "recent_picks": picks[-5:],
    }


def candidate_expanding_oos(frame: pd.DataFrame, candidate: Candidate) -> dict:
    if len(frame) < MIN_TRAIN + TEST_SIZE:
        empty_returns = pd.Series(dtype=float)
        empty_trades = pd.DataFrame()
        summary = base.summary_from_trades(empty_trades, empty_returns, session_count=0)
        return {"summary": summary, "trades": empty_trades, "folds": 0}
    trades_out: list[pd.DataFrame] = []
    returns_out: list[pd.Series] = []
    fold_count = 0
    for start in range(MIN_TRAIN, len(frame) - TEST_SIZE + 1, TEST_SIZE):
        test = frame.iloc[start : start + TEST_SIZE].reset_index(drop=True)
        fold = evaluate_candidate(test, candidate)
        trades_out.append(fold["trades"])
        returns_out.append(fold["session_returns"])
        fold_count += 1
    trades = pd.concat(trades_out, ignore_index=True) if trades_out else pd.DataFrame()
    session_returns = pd.concat(returns_out).groupby(level=0).sum().sort_index() if returns_out else pd.Series(dtype=float)
    summary = base.summary_from_trades(trades, session_returns, session_count=len(session_returns))
    return {"summary": summary, "trades": trades, "folds": fold_count}


def fixed_candidate_section(frame: pd.DataFrame, candidate: Candidate) -> dict:
    result = evaluate_candidate(frame, candidate)
    return {"candidate": candidate.public(), "summary": result["summary"], "trades": result["trades"]}


def event_day_section(trades: pd.DataFrame) -> list[dict]:
    if trades.empty:
        return []
    rows = []
    for _, trade in trades.iterrows():
        if not trade.get("event_name"):
            continue
        rows.append(
            {
                "session": pd.Timestamp(trade["session"]).strftime("%Y-%m-%d"),
                "event_name": trade["event_name"],
                "direction": trade["direction"],
                "entry_price": round(float(trade["entry_price"]), 2),
                "exit_price": round(float(trade["exit_price"]), 2),
                "pnl_points": round(float(trade["pnl_points"]), 2),
            }
        )
    return rows


def strict_cost_section(
    api_key: str,
    access_token: str,
    candidate_result: dict,
    *,
    lot_size: int,
) -> list[dict]:
    trades = candidate_result["trades"]
    if trades.empty:
        return []
    future = representative_future("NIFTY")
    orders, mapping = build_futures_orders(trades, future["tradingsymbol"], lot_size)
    charge_rows = fetch_charge_rows(api_key, access_token, orders)
    scenarios = []
    for slippage in (0.0, 0.1, 0.25, 0.5):
        costed = apply_costs(trades, charge_rows, mapping, lot_size=lot_size, slippage_points_per_side=slippage)
        scenarios.append(summarize_trade_costs(costed, lot_size=lot_size, slippage_points_per_side=slippage))
    return scenarios


def build_report(api_key: str, access_token: str, *, refresh_proxy: bool = False) -> dict:
    proxy = ensure_proxy_15m_cache(api_key, access_token, refresh=refresh_proxy)
    frame = build_feature_frame(proxy)
    if frame.empty:
        raise RuntimeError("Feature frame is empty.")
    holdout_sessions = sorted(frame["session"].drop_duplicates())[-HOLDOUT_SESSIONS:]
    holdout = frame[frame["session"].isin(holdout_sessions)].reset_index(drop=True)
    research = frame[~frame["session"].isin(holdout_sessions)].reset_index(drop=True)

    candidates = candidate_pool()
    fixed_sections = []
    for candidate in candidates:
        fixed = fixed_candidate_section(research.iloc[MIN_TRAIN:].reset_index(drop=True), candidate)
        expanding = candidate_expanding_oos(research, candidate)
        hold = fixed_candidate_section(holdout, candidate)
        fixed_sections.append(
            {
                "candidate": candidate.public(),
                "research_post_burnin": fixed["summary"],
                "research_expanding_oos": expanding["summary"],
                "recent_holdout": hold["summary"],
            }
        )
    ranking = sorted(
        fixed_sections,
        key=lambda item: (
            float(item["research_expanding_oos"]["session_sharpe"]) if item["research_expanding_oos"]["session_sharpe"] is not None else -1e18,
            item["research_expanding_oos"]["net_points"],
            item["research_post_burnin"]["net_points"],
        ),
        reverse=True,
    )
    candidate_map = {candidate.name: candidate for candidate in candidates}
    top_name = ranking[0]["candidate"]["name"]
    top_candidate = candidate_map[top_name]
    top_research = fixed_candidate_section(research.iloc[MIN_TRAIN:].reset_index(drop=True), top_candidate)
    top_holdout = fixed_candidate_section(holdout, top_candidate)
    lot_sizes = base.fetch_lot_sizes()
    lot_size = int(lot_sizes.get("NIFTY", 65))

    payload = {
        "methodology": {
            "signal_data": "Kite NIFTY 15m cache",
            "proxy_data": "Kite NIFTYBEES 15m cache for VWAP and volume confirmation",
            "daily_filter_source": "Kite NIFTY daily cache",
            "exit_rule": f"Force flat at {HARD_EXIT} IST using the 15m bar open at that time",
            "entry_rule": f"Never enter after {ENTRY_CUTOFF} IST",
            "oos_protocol": {
                "selection": "expanding-window walk-forward on research sample only",
                "min_train_sessions": MIN_TRAIN,
                "test_sessions_per_fold": TEST_SIZE,
                "untouched_recent_holdout_sessions": HOLDOUT_SESSIONS,
            },
            "lookahead_guard": "All dynamic filters use same-day bars up to signal time or rolling thresholds shifted by one session.",
            "futures_charges": "Kite /charges/orders on a live representative NIFTY future, using index prices as a futures proxy.",
            "option_exact_limit": "Historical exact option structures remain unavailable without archived daily option masters.",
        },
        "samples": {
            "research": {
                "start": research["session"].min().strftime("%Y-%m-%d"),
                "end": research["session"].max().strftime("%Y-%m-%d"),
                "session_count": int(research["session"].nunique()),
            },
            "holdout": {
                "start": holdout["session"].min().strftime("%Y-%m-%d"),
                "end": holdout["session"].max().strftime("%Y-%m-%d"),
                "session_count": int(holdout["session"].nunique()),
            },
        },
        "candidate_count": len(candidates),
        "fixed_candidate_table": ranking,
        "expanding_walk_forward": expanding_walk_forward(research, candidates),
        "recommended_candidate": {
            "candidate": top_candidate.public(),
            "research_post_burnin": top_research["summary"],
            "recent_holdout": top_holdout["summary"],
            "research_strict_costs": strict_cost_section(api_key, access_token, top_research, lot_size=lot_size),
            "holdout_strict_costs": strict_cost_section(api_key, access_token, top_holdout, lot_size=lot_size),
            "event_day_trades": event_day_section(pd.concat([top_research["trades"], top_holdout["trades"]], ignore_index=True)),
        },
    }
    return payload


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run NIFTY-only enhanced research on Kite data with expanding-window OOS.")
    parser.add_argument("--refresh-proxy", action="store_true", help="Refresh the NIFTYBEES proxy cache from Kite.")
    parser.add_argument("--json", action="store_true")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    load_env_files(DEFAULT_ENV_FILES)
    api_key = require_env("KITE_API_KEY")
    access_token = require_env("KITE_ACCESS_TOKEN")
    payload = build_report(api_key, access_token, refresh_proxy=args.refresh_proxy)
    REPORT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    if args.json:
        print(json.dumps(payload, indent=2))
        return
    print(f"Saved {REPORT_PATH}")


if __name__ == "__main__":
    main()
