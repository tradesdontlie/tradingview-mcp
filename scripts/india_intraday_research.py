#!/usr/bin/env python3

import argparse
import io
import json
import math
import pickle
from dataclasses import asdict, dataclass
from itertools import combinations
from pathlib import Path

import numpy as np
import pandas as pd
import requests
import yfinance as yf
from scipy import stats

NSE_LOT_SIZE_URL = "https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv"
NSE_HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Referer": "https://www.nseindia.com/",
}

LONG_HISTORY_INTERVAL = "60m"
LONG_HISTORY_PERIOD = "730d"
RECENT_INTERVAL = "15m"
RECENT_PERIOD = "60d"
TRAIN_SESSIONS = 80
TEST_SESSIONS = 20
MIN_TRADE_COUNT = 10
WHITE_BOOTSTRAP_ITERS = 300
BOOTSTRAP_ITERS = 500
BOOTSTRAP_BLOCK = 10
CSCV_SLICES = 8

SYMBOLS = {
    "NIFTY": {
        "yahoo": "^NSEI",
        "groww": "NSE-NIFTY",
        "nse_symbol": "NIFTY",
        "fallback_lot_size": 65,
    },
    "BANKNIFTY": {
        "yahoo": "^NSEBANK",
        "groww": "NSE-BANKNIFTY",
        "nse_symbol": "BANKNIFTY",
        "fallback_lot_size": 30,
    },
}

THRESHOLDS = (0.0015, 0.0020, 0.0025, 0.0030, 0.0035, 0.0040)
REGIMES = ("none", "trend", "high_vix", "trend_and_high_vix")
FAMILIES = ("open_cont", "open_revert", "mid_cont", "mid_revert")
GAP_OPTIONS = (False, True)
RSI_OPTIONS = (False, True)
SLOPE_OPTIONS = (False, True)

LOCAL_INTRADAY_INTERVALS = {
    "60m": "1hour",
    "1hour": "1hour",
    "15m": "15minute",
}


@dataclass(frozen=True)
class CandidateSpec:
    family: str
    threshold: float
    regime: str
    gap_align: bool
    rsi_confirm: bool
    slope_align: bool

    def label(self) -> str:
        return (
            f"{self.family}|thr={self.threshold:.4f}|reg={self.regime}|"
            f"gap={int(self.gap_align)}|rsi={int(self.rsi_confirm)}|slope={int(self.slope_align)}"
        )

    def to_public_dict(self) -> dict:
        payload = asdict(self)
        payload["threshold_pct"] = round(self.threshold * 100.0, 3)
        payload.pop("threshold")
        return payload


def rsi(series: pd.Series, lookback: int = 14) -> pd.Series:
    delta = series.diff()
    up = delta.clip(lower=0.0)
    down = -delta.clip(upper=0.0)
    avg_up = up.ewm(alpha=1 / lookback, adjust=False, min_periods=lookback).mean()
    avg_down = down.ewm(alpha=1 / lookback, adjust=False, min_periods=lookback).mean()
    rs = avg_up / avg_down.replace(0.0, np.nan)
    return 100.0 - (100.0 / (1.0 + rs))


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
        lot_sizes = {}
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
                lot_sizes[symbol] = values[0]
        return lot_sizes
    except Exception:
        return {}


def local_symbol_name(symbol: str) -> str | None:
    for symbol_name, config in SYMBOLS.items():
        if symbol in {config["yahoo"], config["groww"], config["nse_symbol"], symbol_name}:
            return symbol_name
    return None


def filter_period(frame: pd.DataFrame, period: str) -> pd.DataFrame:
    period = str(period).strip().lower()
    if period in {"all", "max", "full"}:
        return frame
    if not period.endswith("d"):
        return frame
    try:
        days = int(period[:-1])
    except ValueError:
        return frame
    if frame.empty:
        return frame
    max_index = pd.Timestamp(frame.index.max())
    cutoff = max_index - pd.Timedelta(days=days)
    return frame[frame.index >= cutoff].copy()


def load_intraday(symbol: str, period: str, interval: str) -> pd.DataFrame:
    symbol_name = local_symbol_name(symbol)
    local_interval = LOCAL_INTRADAY_INTERVALS.get(interval)
    if symbol_name and local_interval:
        for provider in ("kite", "groww"):
            path = Path(f"market/raw/{provider}/{symbol_name}_{local_interval}.parquet")
            if path.exists():
                data = pd.read_parquet(path)
                if not data.empty:
                    data.columns = [str(column).lower() for column in data.columns]
                    data["timestamp"] = pd.to_datetime(data["timestamp"])
                    if getattr(data["timestamp"].dt, "tz", None) is None:
                        data["timestamp"] = data["timestamp"].dt.tz_localize("Asia/Kolkata")
                    else:
                        data["timestamp"] = data["timestamp"].dt.tz_convert("Asia/Kolkata")
                    data = data.set_index("timestamp")[["open", "high", "low", "close"]].dropna().copy()
                    data = filter_period(data, period)
                    data["session"] = data.index.date
                    return data

    data = yf.download(symbol, period=period, interval=interval, progress=False, auto_adjust=False)
    if data.empty:
        raise RuntimeError(f"No intraday bars returned for {symbol}")
    if isinstance(data.columns, pd.MultiIndex):
        data.columns = [column[0].lower() for column in data.columns]
    else:
        data.columns = [column.lower() for column in data.columns]
    data = data[["open", "high", "low", "close"]].dropna().copy()
    data.index = data.index.tz_convert("Asia/Kolkata")
    data["session"] = data.index.date
    return data


def load_daily(symbol_name: str, symbol: str) -> tuple[pd.DataFrame, str]:
    frame = None
    source = None
    for provider, provider_source in (("kite", "local_kite_daily_cache"), ("groww", "local_groww_yfinance_daily_cache")):
        path = Path(f"market/raw/{provider}/{symbol_name}_daily.parquet")
        if path.exists():
            data = pd.read_parquet(path)
            dates = pd.DatetimeIndex(pd.to_datetime(data["date"]))
            if dates.tz is not None:
                dates = dates.tz_localize(None)
            frame = pd.DataFrame(
                {
                    "close": pd.Series(data["close"].astype(float).values, index=dates),
                }
            )
            source = provider_source
            break
    if frame is None:
        data = yf.download(symbol, period="10y", interval="1d", progress=False, auto_adjust=False)
        if data.empty:
            raise RuntimeError(f"No daily bars returned for {symbol}")
        if isinstance(data.columns, pd.MultiIndex):
            data.columns = [column[0].lower() for column in data.columns]
        else:
            data.columns = [column.lower() for column in data.columns]
        frame = pd.DataFrame({"close": data["close"].dropna()})
        if getattr(frame.index, "tz", None):
            frame.index = frame.index.tz_localize(None)
        source = "yfinance_daily"

    frame["ema20"] = frame["close"].ewm(span=20, adjust=False).mean()
    frame["ema20_slope"] = frame["ema20"].diff()
    frame["rsi14"] = rsi(frame["close"], 14)
    return frame, source


def load_vix() -> pd.DataFrame:
    path = Path("market/raw/yfinance/_idx_INDIAVIX.pkl")
    with path.open("rb") as handle:
        data = pickle.load(handle)
    frame = data[["Close"]].rename(columns={"Close": "vix"}).copy()
    frame.index = pd.to_datetime(frame.index)
    frame["vix_med20"] = frame["vix"].rolling(20).median()
    return frame


def sign_value(value: float) -> int:
    if pd.isna(value) or value == 0:
        return 0
    return 1 if value > 0 else -1


def prepare_long_history(symbol: str, daily: pd.DataFrame, vix: pd.DataFrame) -> pd.DataFrame:
    intraday = load_intraday(symbol, period="all", interval=LONG_HISTORY_INTERVAL)

    counts = intraday.groupby("session").size()
    good_sessions = counts[counts == 7].index
    intraday = intraday[intraday["session"].isin(good_sessions)].copy()

    rows = []
    for session, day in intraday.groupby("session"):
        ordered = day.sort_index().reset_index(drop=False)
        prev_daily = daily[daily.index < pd.Timestamp(session)].tail(1)
        prev_vix = vix[vix.index < pd.Timestamp(session)].tail(1)
        if prev_daily.empty or prev_vix.empty:
            continue

        prev_close = float(prev_daily["close"].iloc[0])
        prev_ema20 = float(prev_daily["ema20"].iloc[0])
        prev_ema20_slope = float(prev_daily["ema20_slope"].iloc[0])
        prev_rsi14 = float(prev_daily["rsi14"].iloc[0])
        prev_vix_level = float(prev_vix["vix"].iloc[0])
        prev_vix_med20 = float(prev_vix["vix_med20"].iloc[0])

        rows.append(
            {
                "session": pd.Timestamp(session),
                "trend_state": sign_value(prev_close - prev_ema20),
                "ema_slope_state": sign_value(prev_ema20_slope),
                "prev_rsi14": prev_rsi14,
                "vix_high": 1 if prev_vix_level > prev_vix_med20 else 0,
                "vix_level": prev_vix_level,
                "open1_ret": (float(ordered.loc[0, "close"]) - float(ordered.loc[0, "open"])) / float(ordered.loc[0, "open"]),
                "mid4_ret": (float(ordered.loc[3, "close"]) - float(ordered.loc[0, "open"])) / float(ordered.loc[0, "open"]),
                "gap_ret": (float(ordered.loc[0, "open"]) - prev_close) / prev_close,
                "entry_open_hour": float(ordered.loc[1, "open"]),
                "entry_midday": float(ordered.loc[4, "open"]),
                "close_eod": float(ordered.loc[6, "close"]),
                "weekday": pd.Timestamp(session).day_name(),
                "year": int(pd.Timestamp(session).year),
            }
        )
    return pd.DataFrame(rows).sort_values("session").reset_index(drop=True)


def prepare_recent_validation(symbol: str, daily: pd.DataFrame, vix: pd.DataFrame) -> pd.DataFrame:
    intraday = load_intraday(symbol, period=RECENT_PERIOD, interval=RECENT_INTERVAL)

    counts = intraday.groupby("session").size()
    good_sessions = counts[counts >= 25].index
    intraday = intraday[intraday["session"].isin(good_sessions)].copy()

    rows = []
    for session, day in intraday.groupby("session"):
        ordered = day.sort_index().reset_index(drop=False)
        prev_daily = daily[daily.index < pd.Timestamp(session)].tail(1)
        prev_vix = vix[vix.index < pd.Timestamp(session)].tail(1)
        if prev_daily.empty or prev_vix.empty:
            continue

        prev_close = float(prev_daily["close"].iloc[0])
        prev_ema20 = float(prev_daily["ema20"].iloc[0])
        prev_ema20_slope = float(prev_daily["ema20_slope"].iloc[0])
        prev_rsi14 = float(prev_daily["rsi14"].iloc[0])
        prev_vix_level = float(prev_vix["vix"].iloc[0])
        prev_vix_med20 = float(prev_vix["vix_med20"].iloc[0])

        rows.append(
            {
                "session": pd.Timestamp(session),
                "trend_state": sign_value(prev_close - prev_ema20),
                "ema_slope_state": sign_value(prev_ema20_slope),
                "prev_rsi14": prev_rsi14,
                "vix_high": 1 if prev_vix_level > prev_vix_med20 else 0,
                "vix_level": prev_vix_level,
                "open1_ret": (float(ordered.loc[3, "close"]) - float(ordered.loc[0, "open"])) / float(ordered.loc[0, "open"]),
                "mid4_ret": (float(ordered.loc[15, "close"]) - float(ordered.loc[0, "open"])) / float(ordered.loc[0, "open"]),
                "gap_ret": (float(ordered.loc[0, "open"]) - prev_close) / prev_close,
                "entry_open_hour": float(ordered.loc[4, "open"]),
                "entry_midday": float(ordered.loc[16, "open"]),
                "close_eod": float(ordered.iloc[-1]["close"]),
                "weekday": pd.Timestamp(session).day_name(),
                "year": int(pd.Timestamp(session).year),
            }
        )
    return pd.DataFrame(rows).sort_values("session").reset_index(drop=True)


def candidate_specs():
    for family in FAMILIES:
        for threshold in THRESHOLDS:
            for regime in REGIMES:
                for gap_align in GAP_OPTIONS:
                    for rsi_confirm in RSI_OPTIONS:
                        for slope_align in SLOPE_OPTIONS:
                            yield CandidateSpec(
                                family=family,
                                threshold=threshold,
                                regime=regime,
                                gap_align=gap_align,
                                rsi_confirm=rsi_confirm,
                                slope_align=slope_align,
                            )


def candidate_signal_mask(frame: pd.DataFrame, spec: CandidateSpec) -> tuple[pd.Series, pd.Series, str]:
    signal_col = "open1_ret" if spec.family.startswith("open") else "mid4_ret"
    entry_col = "entry_open_hour" if spec.family.startswith("open") else "entry_midday"
    direction = np.sign(frame[signal_col]).astype(int)
    if spec.family.endswith("revert"):
        direction = -direction

    mask = frame[signal_col].abs() >= spec.threshold
    if spec.regime in ("trend", "trend_and_high_vix"):
        mask &= frame["trend_state"] == direction
    if spec.regime in ("high_vix", "trend_and_high_vix"):
        mask &= frame["vix_high"] == 1
    if spec.gap_align:
        mask &= np.sign(frame["gap_ret"]) == direction
    if spec.rsi_confirm:
        rsi_long = frame["prev_rsi14"] >= 55.0
        rsi_short = frame["prev_rsi14"] <= 45.0
        mask &= ((direction > 0) & rsi_long) | ((direction < 0) & rsi_short)
    if spec.slope_align:
        mask &= frame["ema_slope_state"] == direction
    return mask.fillna(False), direction, entry_col


def candidate_trade_frame(frame: pd.DataFrame, spec: CandidateSpec) -> tuple[pd.DataFrame, pd.Series]:
    if frame.empty:
        return pd.DataFrame(), pd.Series(dtype=float)

    mask, direction, entry_col = candidate_signal_mask(frame, spec)
    session_returns = pd.Series(0.0, index=pd.DatetimeIndex(frame["session"]), dtype=float)
    trades = frame.loc[mask, ["session", entry_col, "close_eod", "weekday", "year", "vix_high", "vix_level"]].copy()
    if trades.empty:
        return trades, session_returns

    directions = pd.Series(direction[mask], index=trades.index).astype(int)
    trades["direction_value"] = directions
    trades["direction"] = np.where(trades["direction_value"] > 0, "LONG", "SHORT")
    trades["entry_price"] = trades[entry_col].astype(float)
    trades["exit_price"] = trades["close_eod"].astype(float)
    trades["pnl_points"] = (trades["exit_price"] - trades["entry_price"]) * trades["direction_value"]
    trades["pnl_pct"] = ((trades["exit_price"] / trades["entry_price"]) - 1.0) * trades["direction_value"]
    trades = trades.drop(columns=[entry_col, "close_eod"]).reset_index(drop=True)
    session_returns.loc[pd.DatetimeIndex(trades["session"])] = trades["pnl_pct"].astype(float).values
    return trades, session_returns


def max_drawdown(returns: pd.Series) -> float:
    series = pd.Series(returns).fillna(0.0).astype(float)
    if series.empty:
        return float("nan")
    equity = (1.0 + series).cumprod()
    drawdown = equity / equity.cummax() - 1.0
    return float(drawdown.min())


def annualized_sharpe(returns: pd.Series) -> float:
    series = pd.Series(returns).fillna(0.0).astype(float)
    stdev = float(series.std())
    if series.empty or stdev <= 0.0:
        return float("nan")
    return float(series.mean() / stdev * np.sqrt(252.0))


def annualized_sortino(returns: pd.Series) -> float:
    series = pd.Series(returns).fillna(0.0).astype(float)
    downside = series[series < 0.0]
    downside_stdev = float(downside.std())
    if series.empty or downside.empty or downside_stdev <= 0.0:
        return float("nan")
    return float(series.mean() / downside_stdev * np.sqrt(252.0))


def annualized_return(returns: pd.Series) -> float:
    series = pd.Series(returns).fillna(0.0).astype(float)
    if series.empty:
        return float("nan")
    return float(series.mean() * 252.0)


def cagr(returns: pd.Series) -> float:
    series = pd.Series(returns).fillna(0.0).astype(float)
    if series.empty:
        return float("nan")
    equity = (1.0 + series).cumprod()
    years = len(series) / 252.0
    if years <= 0.0 or equity.iloc[-1] <= 0.0:
        return float("nan")
    return float(equity.iloc[-1] ** (1.0 / years) - 1.0)


def calmar_ratio(returns: pd.Series) -> float:
    drawdown = abs(float(max_drawdown(returns)))
    growth = float(cagr(returns))
    if drawdown <= 0.0 or math.isnan(drawdown) or math.isnan(growth):
        return float("nan")
    return float(growth / drawdown)


def recovery_factor(returns: pd.Series) -> float:
    drawdown = abs(float(max_drawdown(returns)))
    equity = (1.0 + pd.Series(returns).fillna(0.0).astype(float)).cumprod()
    if equity.empty or drawdown <= 0.0:
        return float("nan")
    net = float(equity.iloc[-1] - 1.0)
    return float(net / drawdown)


def payoff_ratio(pnl: pd.Series) -> float:
    wins = pnl[pnl > 0.0]
    losses = -pnl[pnl < 0.0]
    if wins.empty or losses.empty or float(losses.mean()) <= 0.0:
        return float("nan")
    return float(wins.mean() / losses.mean())


def max_consecutive_streak(pnl: pd.Series, *, positive: bool) -> int:
    best = 0
    current = 0
    for value in pd.Series(pnl).fillna(0.0).astype(float):
        condition = value > 0.0 if positive else value < 0.0
        if condition:
            current += 1
            best = max(best, current)
        else:
            current = 0
    return int(best)


def monthly_hit_rate(session_returns: pd.Series) -> dict:
    series = pd.Series(session_returns)
    if series.empty:
        return {"positive_month_ratio": None, "best_month_pct": None, "worst_month_pct": None}
    monthly = series.groupby(series.index.to_period("M")).sum()
    if monthly.empty:
        return {"positive_month_ratio": None, "best_month_pct": None, "worst_month_pct": None}
    return {
        "positive_month_ratio": round(float((monthly > 0.0).mean() * 100.0), 2),
        "best_month_pct": round(float(monthly.max() * 100.0), 3),
        "worst_month_pct": round(float(monthly.min() * 100.0), 3),
    }


def var_cvar(session_returns: pd.Series, alpha: float = 0.95) -> dict:
    series = pd.Series(session_returns).fillna(0.0).astype(float)
    if series.empty:
        return {"var_pct": None, "cvar_pct": None}
    cutoff = float(np.quantile(series, 1.0 - alpha))
    tail = series[series <= cutoff]
    return {
        "var_pct": round(float(cutoff * 100.0), 3),
        "cvar_pct": round(float(tail.mean() * 100.0), 3) if not tail.empty else None,
    }


def summary_from_trades(trades: pd.DataFrame, session_returns: pd.Series, session_count: int) -> dict:
    pnl = trades["pnl_points"].astype(float) if not trades.empty else pd.Series(dtype=float)
    wins = float(pnl[pnl > 0].sum())
    losses = float(-pnl[pnl < 0].sum())
    trade_count = int(len(trades))
    avg_win = float(pnl[pnl > 0].mean()) if (pnl > 0).any() else float("nan")
    avg_loss = float((-pnl[pnl < 0]).mean()) if (pnl < 0).any() else float("nan")
    monthly = monthly_hit_rate(session_returns)
    tail_risk = var_cvar(session_returns)
    summary = {
        "trade_count": trade_count,
        "session_count": int(session_count),
        "exposure_pct": round(float(trade_count / session_count * 100.0), 2) if session_count else 0.0,
        "net_points": round(float(pnl.sum()), 2) if trade_count else 0.0,
        "avg_points": round(float(pnl.mean()), 2) if trade_count else 0.0,
        "net_pct": round(float(session_returns.sum() * 100.0), 3),
        "avg_trade_pct": round(float(trades["pnl_pct"].mean() * 100.0), 3) if trade_count else 0.0,
        "annualized_return_pct": round(float(annualized_return(session_returns) * 100.0), 2) if session_count else None,
        "cagr_pct": round(float(cagr(session_returns) * 100.0), 2) if session_count else None,
        "session_sharpe": round(float(annualized_sharpe(session_returns)), 3) if session_count else None,
        "session_sortino": round(float(annualized_sortino(session_returns)), 3) if session_count else None,
        "calmar_ratio": round(float(calmar_ratio(session_returns)), 3) if session_count else None,
        "recovery_factor": round(float(recovery_factor(session_returns)), 3) if session_count else None,
        "profit_factor": round(float(wins / losses), 3) if losses > 0 else None,
        "win_rate": round(float((pnl > 0).mean() * 100.0), 2) if trade_count else 0.0,
        "max_drawdown_pct": round(float(max_drawdown(session_returns) * 100.0), 2) if session_count else None,
        "expectancy_points": round(float(pnl.mean()), 2) if trade_count else 0.0,
        "avg_win_points": round(avg_win, 2) if not math.isnan(avg_win) else None,
        "avg_loss_points": round(avg_loss, 2) if not math.isnan(avg_loss) else None,
        "payoff_ratio": round(float(payoff_ratio(pnl)), 3) if trade_count else None,
        "best_trade_points": round(float(pnl.max()), 2) if trade_count else None,
        "worst_trade_points": round(float(pnl.min()), 2) if trade_count else None,
        "max_consecutive_wins": max_consecutive_streak(pnl, positive=True) if trade_count else 0,
        "max_consecutive_losses": max_consecutive_streak(pnl, positive=False) if trade_count else 0,
        "positive_month_ratio": monthly["positive_month_ratio"],
        "best_month_pct": monthly["best_month_pct"],
        "worst_month_pct": monthly["worst_month_pct"],
        "daily_var_95_pct": tail_risk["var_pct"],
        "daily_cvar_95_pct": tail_risk["cvar_pct"],
    }
    return summary


def evaluate_candidate(frame: pd.DataFrame, spec: CandidateSpec) -> dict:
    trades, session_returns = candidate_trade_frame(frame, spec)
    return {
        "summary": summary_from_trades(trades, session_returns, session_count=len(frame)),
        "trades": trades,
        "session_returns": session_returns,
    }


def chunk_ranges(length: int, chunk_size: int):
    for start in range(0, length, chunk_size):
        stop = min(start + chunk_size, length)
        yield start, stop


def fixed_oos_breakdown(frame: pd.DataFrame, spec: CandidateSpec) -> dict:
    if len(frame) <= TRAIN_SESSIONS:
        empty = pd.Series(dtype=float)
        return {
            "summary": summary_from_trades(pd.DataFrame(), empty, session_count=0),
            "blocks": [],
            "session_returns": empty,
            "trades": pd.DataFrame(),
        }

    oos = frame.iloc[TRAIN_SESSIONS:].reset_index(drop=True)
    result = evaluate_candidate(oos, spec)
    blocks = []
    positive_blocks = 0
    nonzero_blocks = 0
    for start, stop in chunk_ranges(len(oos), TEST_SESSIONS):
        block = oos.iloc[start:stop].reset_index(drop=True)
        block_result = evaluate_candidate(block, spec)
        block_summary = block_result["summary"]
        blocks.append(
            {
                "start": block["session"].iloc[0].strftime("%Y-%m-%d"),
                "end": block["session"].iloc[-1].strftime("%Y-%m-%d"),
                **block_summary,
            }
        )
        if block_summary["trade_count"] > 0:
            nonzero_blocks += 1
            if block_summary["net_points"] > 0:
                positive_blocks += 1

    result["summary"]["block_count"] = len(blocks)
    result["summary"]["positive_block_ratio"] = round(float(positive_blocks / nonzero_blocks), 3) if nonzero_blocks else 0.0
    result["blocks"] = blocks
    return result


def adaptive_walk_forward(frame: pd.DataFrame, specs: list[CandidateSpec]) -> dict:
    picks = []
    out_of_sample_points = []
    if len(frame) < TRAIN_SESSIONS + TEST_SESSIONS:
        return {"folds": 0, "oos_net_points": 0.0, "oos_trade_count": 0, "pick_counts": [], "recent_picks": []}

    for start in range(TRAIN_SESSIONS, len(frame) - TEST_SESSIONS + 1, TEST_SESSIONS):
        train = frame.iloc[start - TRAIN_SESSIONS : start].reset_index(drop=True)
        test = frame.iloc[start : start + TEST_SESSIONS].reset_index(drop=True)
        best = None
        for spec in specs:
            metrics = evaluate_candidate(train, spec)["summary"]
            score = (
                float(metrics["session_sharpe"]) if metrics["session_sharpe"] is not None else -1e18,
                metrics["net_points"],
                metrics["profit_factor"] or -1e18,
            )
            if metrics["trade_count"] < MIN_TRADE_COUNT:
                score = (-1e18, -1e18, -1e18)
            if best is None or score > best[0]:
                best = (score, spec, metrics)

        test_metrics = evaluate_candidate(test, best[1])["summary"]
        picks.append(
            {
                **best[1].to_public_dict(),
                "train_summary": best[2],
                "test_summary": test_metrics,
            }
        )
        out_of_sample_points.append(test_metrics)

    counts = {}
    for pick in picks:
        key = (
            pick["family"],
            pick["threshold_pct"],
            pick["regime"],
            pick["gap_align"],
            pick["rsi_confirm"],
            pick["slope_align"],
        )
        counts[key] = counts.get(key, 0) + 1

    return {
        "folds": len(picks),
        "oos_net_points": round(sum(item["net_points"] for item in out_of_sample_points), 2),
        "oos_trade_count": int(sum(item["trade_count"] for item in out_of_sample_points)),
        "pick_counts": [
            {
                "family": family,
                "threshold_pct": threshold_pct,
                "regime": regime,
                "gap_align": gap_align,
                "rsi_confirm": rsi_confirm,
                "slope_align": slope_align,
                "count": count,
            }
            for (family, threshold_pct, regime, gap_align, rsi_confirm, slope_align), count in sorted(
                counts.items(), key=lambda item: item[1], reverse=True
            )[:10]
        ],
        "recent_picks": picks[-5:],
    }


def nw_lags(length: int) -> int:
    return max(int(np.floor(4.0 * (length / 100.0) ** (2.0 / 9.0))), 1)


def hac_mean_test(returns: pd.Series) -> dict:
    series = pd.Series(returns).fillna(0.0).astype(float)
    n = len(series)
    if n < 5:
        return {"mean_pct": 0.0, "t_stat": None, "p_value": None, "lags": 0}

    centered = series - series.mean()
    lags = min(nw_lags(n), n - 1)
    gamma0 = float(np.dot(centered, centered) / n)
    variance = gamma0
    for lag in range(1, lags + 1):
        weight = 1.0 - lag / (lags + 1.0)
        cov = float(np.dot(centered[lag:], centered[:-lag]) / n)
        variance += 2.0 * weight * cov
    variance_mean = variance / n
    if variance_mean <= 0.0:
        return {"mean_pct": round(float(series.mean() * 100.0), 4), "t_stat": None, "p_value": None, "lags": lags}
    t_stat = float(series.mean() / np.sqrt(variance_mean))
    p_value = float(2.0 * stats.norm.sf(abs(t_stat)))
    return {
        "mean_pct": round(float(series.mean() * 100.0), 4),
        "t_stat": round(t_stat, 3),
        "p_value": round(p_value, 4),
        "lags": lags,
    }


def bootstrap_indices(length: int, block: int, rng: np.random.Generator) -> np.ndarray:
    if length == 0:
        return np.array([], dtype=int)
    if block <= 1:
        return rng.integers(0, length, size=length)
    indices = []
    while len(indices) < length:
        start = int(rng.integers(0, length))
        indices.extend((start + offset) % length for offset in range(block))
    return np.asarray(indices[:length], dtype=int)


def bootstrap_ci(returns: pd.Series, iterations: int, block: int, seed: int) -> dict:
    series = pd.Series(returns).fillna(0.0).astype(float)
    if series.empty:
        return {
            "mean_return_pct": {"point": 0.0, "p05": 0.0, "p50": 0.0, "p95": 0.0, "prob_le_zero": 1.0},
            "sharpe": {"point": None, "p05": None, "p50": None, "p95": None, "prob_le_zero": None},
        }

    rng = np.random.default_rng(seed)
    values = series.to_numpy(dtype=float)
    mean_samples = []
    sharpe_samples = []
    for _ in range(iterations):
        idx = bootstrap_indices(len(values), block=block, rng=rng)
        sample = pd.Series(values[idx], dtype=float)
        mean_samples.append(float(sample.mean() * 100.0))
        sharpe_samples.append(float(annualized_sharpe(sample)))

    mean_arr = np.asarray(mean_samples, dtype=float)
    sharpe_arr = np.asarray(sharpe_samples, dtype=float)
    point_mean = float(series.mean() * 100.0)
    point_sharpe = float(annualized_sharpe(series))

    def pack(arr: np.ndarray, point: float) -> dict:
        valid = arr[np.isfinite(arr)]
        if valid.size == 0:
            return {"point": None, "p05": None, "p50": None, "p95": None, "prob_le_zero": None}
        return {
            "point": round(point, 4),
            "p05": round(float(np.nanpercentile(valid, 5)), 4),
            "p50": round(float(np.nanpercentile(valid, 50)), 4),
            "p95": round(float(np.nanpercentile(valid, 95)), 4),
            "prob_le_zero": round(float(np.mean(valid <= 0.0)), 4),
        }

    return {
        "mean_return_pct": pack(mean_arr, point_mean),
        "sharpe": pack(sharpe_arr, point_sharpe),
    }


def white_reality_check(return_matrix: pd.DataFrame, iterations: int, block: int, seed: int) -> dict:
    frame = return_matrix.fillna(0.0).astype(float)
    if frame.empty or frame.shape[1] == 0:
        return {"model_count": 0, "best_label": None, "best_mean_pct": 0.0, "observed_stat": 0.0, "p_value": None}

    values = frame.to_numpy(dtype=float)
    length = values.shape[0]
    means = values.mean(axis=0)
    observed = float(np.sqrt(length) * means.max())
    centered = values - means
    rng = np.random.default_rng(seed)
    boot_stats = []
    for _ in range(iterations):
        idx = bootstrap_indices(length, block=block, rng=rng)
        sample = centered[idx, :]
        boot_stats.append(float(np.sqrt(length) * sample.mean(axis=0).max()))
    boot = np.asarray(boot_stats, dtype=float)
    best_idx = int(np.argmax(means))
    return {
        "model_count": int(frame.shape[1]),
        "best_label": str(frame.columns[best_idx]),
        "best_mean_pct": round(float(means[best_idx] * 100.0), 4),
        "observed_stat": round(observed, 4),
        "p_value": round(float(np.mean(boot >= observed)), 4),
    }


def cscv_pbo(return_matrix: pd.DataFrame, slices: int) -> dict:
    frame = return_matrix.fillna(0.0).astype(float)
    if frame.empty or frame.shape[1] < 2 or len(frame) < slices:
        return {"slice_count": slices, "split_count": 0, "pbo": None, "median_oos_percentile": None}

    indices = np.array_split(np.arange(len(frame)), slices)
    if any(len(chunk) == 0 for chunk in indices):
        return {"slice_count": slices, "split_count": 0, "pbo": None, "median_oos_percentile": None}

    split_results = []
    for combo in combinations(range(slices), slices // 2):
        if 0 not in combo:
            continue
        train_idx = np.concatenate([indices[idx] for idx in combo])
        test_idx = np.concatenate([indices[idx] for idx in range(slices) if idx not in combo])
        train_scores = frame.iloc[train_idx].apply(annualized_sharpe, axis=0)
        test_scores = frame.iloc[test_idx].apply(annualized_sharpe, axis=0)
        train_scores = train_scores.replace([np.inf, -np.inf], np.nan).fillna(-1e18)
        test_scores = test_scores.replace([np.inf, -np.inf], np.nan).fillna(-1e18)
        best_label = str(train_scores.idxmax())
        oos_rank = float(stats.rankdata(test_scores.values, method="average")[frame.columns.get_loc(best_label)])
        percentile = oos_rank / (len(test_scores) + 1.0)
        split_results.append(
            {
                "best_label": best_label,
                "train_sharpe": round(float(train_scores[best_label]), 3),
                "test_sharpe": round(float(test_scores[best_label]), 3),
                "oos_percentile": round(percentile, 4),
            }
        )

    if not split_results:
        return {"slice_count": slices, "split_count": 0, "pbo": None, "median_oos_percentile": None}

    percentiles = np.asarray([row["oos_percentile"] for row in split_results], dtype=float)
    return {
        "slice_count": slices,
        "split_count": len(split_results),
        "pbo": round(float(np.mean(percentiles <= 0.5)), 4),
        "median_oos_percentile": round(float(np.median(percentiles)), 4),
        "recent_splits": split_results[-5:],
    }


def year_breakdown(trades: pd.DataFrame) -> list[dict]:
    if trades.empty:
        return []
    rows = []
    for year, block in trades.groupby("year"):
        pnl = block["pnl_points"].astype(float)
        wins = float(pnl[pnl > 0].sum())
        losses = float(-pnl[pnl < 0].sum())
        rows.append(
            {
                "year": int(year),
                "trade_count": int(len(block)),
                "net_points": round(float(pnl.sum()), 2),
                "avg_points": round(float(pnl.mean()), 2),
                "win_rate": round(float((pnl > 0).mean() * 100.0), 2),
                "profit_factor": round(float(wins / losses), 3) if losses > 0 else None,
            }
        )
    return rows


def weekday_breakdown(trades: pd.DataFrame) -> list[dict]:
    if trades.empty:
        return []
    order = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
    rows = []
    for weekday in order:
        block = trades[trades["weekday"] == weekday]
        if block.empty:
            continue
        pnl = block["pnl_points"].astype(float)
        rows.append(
            {
                "weekday": weekday,
                "trade_count": int(len(block)),
                "net_points": round(float(pnl.sum()), 2),
                "avg_points": round(float(pnl.mean()), 2),
                "win_rate": round(float((pnl > 0).mean() * 100.0), 2),
            }
        )
    return rows


def vix_breakdown(trades: pd.DataFrame) -> list[dict]:
    if trades.empty:
        return []
    rows = []
    for label, block in (("low_vix", trades[trades["vix_high"] == 0]), ("high_vix", trades[trades["vix_high"] == 1])):
        if block.empty:
            continue
        pnl = block["pnl_points"].astype(float)
        rows.append(
            {
                "bucket": label,
                "trade_count": int(len(block)),
                "net_points": round(float(pnl.sum()), 2),
                "avg_points": round(float(pnl.mean()), 2),
                "win_rate": round(float((pnl > 0).mean() * 100.0), 2),
            }
        )
    return rows


def neighborhood_summary(candidate_rows: list[dict], spec: CandidateSpec) -> dict:
    selected_threshold_index = THRESHOLDS.index(spec.threshold)
    threshold_neighbors = set(THRESHOLDS[max(0, selected_threshold_index - 1) : min(len(THRESHOLDS), selected_threshold_index + 2)])
    neighbors = [
        row
        for row in candidate_rows
        if row["spec"].family == spec.family
        and row["spec"].regime == spec.regime
        and row["spec"].gap_align == spec.gap_align
        and row["spec"].rsi_confirm == spec.rsi_confirm
        and row["spec"].slope_align == spec.slope_align
        and row["spec"].threshold in threshold_neighbors
    ]
    if not neighbors:
        return {"neighbor_count": 0, "positive_fixed_oos_share": None, "median_fixed_oos_net_points": None}

    fixed_nets = np.asarray([row["fixed_oos_summary"]["net_points"] for row in neighbors], dtype=float)
    return {
        "neighbor_count": len(neighbors),
        "positive_fixed_oos_share": round(float(np.mean(fixed_nets > 0.0)), 3),
        "median_fixed_oos_net_points": round(float(np.median(fixed_nets)), 2),
    }


def assess_deployment(candidate: dict | None, recent_validation: dict | None, white_check: dict, pbo: dict) -> dict:
    if candidate is None:
        return {"status": "reject", "reasons": ["no_candidate_selected"]}

    fixed = candidate["fixed_oos_summary"]
    hac = candidate["hac_mean_test"]
    recent_summary = recent_validation["summary"] if recent_validation else None

    reasons = []
    if fixed["session_sharpe"] is None or fixed["session_sharpe"] < 1.0:
        reasons.append("fixed_oos_sharpe_below_1")
    if fixed["positive_block_ratio"] < 0.55:
        reasons.append("too_few_positive_blocks")
    if hac["p_value"] is None or hac["p_value"] > 0.05:
        reasons.append("hac_mean_not_significant")
    if pbo.get("pbo") is None or pbo["pbo"] > 0.30:
        reasons.append("high_probability_of_backtest_overfitting")
    if recent_summary is None or recent_summary["net_points"] <= 0.0 or (recent_summary["session_sharpe"] or 0.0) < 0.75:
        reasons.append("recent_holdout_not_strong_enough")
    if white_check.get("p_value") is None or white_check["p_value"] > 0.10:
        reasons.append("fails_white_reality_check")

    if not reasons:
        status = "candidate_for_small_size"
    elif reasons == ["fails_white_reality_check"]:
        status = "paper_trade_only"
    else:
        status = "reject_for_now"
    return {"status": status, "reasons": reasons}


def cost_sensitivity(trades: pd.DataFrame, lot_size: int) -> list[dict]:
    point_pnl = trades["pnl_points"].astype(float).tolist() if not trades.empty else []
    table = []
    for round_trip_cost in (0, 1, 2, 3, 5, 8, 10):
        net_points = sum(point - round_trip_cost for point in point_pnl)
        table.append(
            {
                "round_trip_cost_points": round_trip_cost,
                "net_points": round(net_points, 2),
                "net_inr_one_lot": round(net_points * lot_size, 2),
            }
        )
    return table


def make_json_safe(value):
    if isinstance(value, dict):
        return {key: make_json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [make_json_safe(item) for item in value]
    if isinstance(value, pd.DataFrame):
        return make_json_safe(value.to_dict(orient="records"))
    if isinstance(value, pd.Series):
        return make_json_safe(value.tolist())
    if isinstance(value, pd.Timestamp):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, (np.floating, float)):
        if math.isnan(value) or math.isinf(value):
            return None
        return float(value)
    if isinstance(value, (np.integer, int)):
        return int(value)
    if isinstance(value, CandidateSpec):
        return value.to_public_dict()
    return value


def build_report(symbol_name: str, lot_size: int, vix: pd.DataFrame) -> dict:
    yahoo_symbol = SYMBOLS[symbol_name]["yahoo"]
    daily, daily_source = load_daily(symbol_name, yahoo_symbol)
    recent = prepare_recent_validation(yahoo_symbol, daily=daily, vix=vix)
    long_history = prepare_long_history(yahoo_symbol, daily=daily, vix=vix)

    holdout_start = pd.Timestamp(recent["session"].min()) if not recent.empty else None
    if holdout_start is not None:
        research = long_history[long_history["session"] < holdout_start].reset_index(drop=True)
    else:
        research = long_history.copy()
    if len(research) <= TRAIN_SESSIONS + TEST_SESSIONS:
        research = long_history.copy()
        holdout_start = None

    specs = list(candidate_specs())
    candidate_rows = []
    oos_matrix = {}
    pseudo_oos = research.iloc[TRAIN_SESSIONS:].reset_index(drop=True) if len(research) > TRAIN_SESSIONS else research.iloc[0:0].copy()

    for spec in specs:
        full_result = evaluate_candidate(research, spec)
        fixed_result = fixed_oos_breakdown(research, spec)
        public = spec.to_public_dict()
        row = {
            "spec": spec,
            "label": spec.label(),
            "public": public,
            "full_sample_summary": full_result["summary"],
            "fixed_oos_summary": fixed_result["summary"],
            "full_sample_trades": full_result["trades"],
            "fixed_oos_trades": fixed_result["trades"],
            "fixed_oos_blocks": fixed_result["blocks"],
            "fixed_oos_returns": fixed_result["session_returns"],
        }
        candidate_rows.append(row)
        if len(pseudo_oos) > 0:
            oos_matrix[spec.label()] = fixed_result["session_returns"].reindex(pd.DatetimeIndex(pseudo_oos["session"])).fillna(0.0)

    eligible = [
        row
        for row in candidate_rows
        if row["fixed_oos_summary"]["trade_count"] >= MIN_TRADE_COUNT
    ]
    ranking_pool = eligible if eligible else candidate_rows
    ranking = sorted(
        ranking_pool,
        key=lambda row: (
            float(row["fixed_oos_summary"]["session_sharpe"]) if row["fixed_oos_summary"]["session_sharpe"] is not None else -1e18,
            row["fixed_oos_summary"]["net_points"],
            row["fixed_oos_summary"]["positive_block_ratio"],
            row["full_sample_summary"]["net_points"],
        ),
        reverse=True,
    )

    top_candidates = []
    for row in ranking[:10]:
        top_candidates.append(
            {
                **row["public"],
                "full_sample_summary": row["full_sample_summary"],
                "fixed_oos_summary": row["fixed_oos_summary"],
            }
        )

    adaptive = adaptive_walk_forward(research, specs)
    oos_matrix_frame = pd.DataFrame(oos_matrix).fillna(0.0) if oos_matrix else pd.DataFrame()
    white_check = white_reality_check(oos_matrix_frame, iterations=WHITE_BOOTSTRAP_ITERS, block=BOOTSTRAP_BLOCK, seed=11)
    pbo = cscv_pbo(oos_matrix_frame, slices=CSCV_SLICES)

    recommended = ranking[0] if ranking else None
    recent_validation = None
    recommendation_diagnostics = None
    if recommended is not None:
        holdout_result = evaluate_candidate(recent, recommended["spec"])
        recent_summary = holdout_result["summary"]
        recent_summary["net_inr_one_lot"] = round(float(recent_summary["net_points"] * lot_size), 2)
        recent_validation = {
            **recommended["public"],
            "summary": recent_summary,
            "trades": [
                {
                    "session": trade["session"].strftime("%Y-%m-%d"),
                    "direction": trade["direction"],
                    "entry_price": round(float(trade["entry_price"]), 2),
                    "exit_price": round(float(trade["exit_price"]), 2),
                    "pnl_points": round(float(trade["pnl_points"]), 2),
                    "pnl_inr_one_lot": round(float(trade["pnl_points"] * lot_size), 2),
                }
                for _, trade in holdout_result["trades"].iterrows()
            ],
        }
        recommendation_diagnostics = {
            **recommended["public"],
            "full_sample_summary": recommended["full_sample_summary"],
            "fixed_oos_summary": recommended["fixed_oos_summary"],
            "hac_mean_test": hac_mean_test(recommended["fixed_oos_returns"]),
            "bootstrap_ci": bootstrap_ci(recommended["fixed_oos_returns"], iterations=BOOTSTRAP_ITERS, block=BOOTSTRAP_BLOCK, seed=17),
            "year_breakdown": year_breakdown(recommended["fixed_oos_trades"]),
            "weekday_breakdown": weekday_breakdown(recommended["fixed_oos_trades"]),
            "vix_breakdown": vix_breakdown(recommended["fixed_oos_trades"]),
            "neighborhood": neighborhood_summary(candidate_rows, recommended["spec"]),
            "fixed_oos_block_samples": recommended["fixed_oos_blocks"][:8],
        }
        recommendation_diagnostics["deployment_assessment"] = assess_deployment(
            recommendation_diagnostics,
            recent_validation,
            white_check,
            pbo,
        )

    return {
        "symbol": symbol_name,
        "yahoo_symbol": yahoo_symbol,
        "daily_source": daily_source,
        "lot_size": lot_size,
        "candidate_count": len(specs),
        "research_sample": {
            "session_count": int(len(research)),
            "start": research["session"].min().strftime("%Y-%m-%d") if not research.empty else None,
            "end": research["session"].max().strftime("%Y-%m-%d") if not research.empty else None,
        },
        "pseudo_oos_sample": {
            "session_count": int(len(pseudo_oos)),
            "start": pseudo_oos["session"].min().strftime("%Y-%m-%d") if not pseudo_oos.empty else None,
            "end": pseudo_oos["session"].max().strftime("%Y-%m-%d") if not pseudo_oos.empty else None,
        },
        "recent_holdout_15m_sample": {
            "session_count": int(len(recent)),
            "start": recent["session"].min().strftime("%Y-%m-%d") if not recent.empty else None,
            "end": recent["session"].max().strftime("%Y-%m-%d") if not recent.empty else None,
            "overlap_removed_from_search_start": holdout_start.strftime("%Y-%m-%d") if holdout_start is not None else None,
        },
        "fixed_oos_top_candidates": top_candidates,
        "adaptive_walk_forward": adaptive,
        "search_diagnostics": {
            "white_reality_check": white_check,
            "cscv_pbo": pbo,
        },
        "recommended_candidate": recommendation_diagnostics,
        "recent_validation_15m": recent_validation,
        "cost_sensitivity_15m": cost_sensitivity(pd.DataFrame(recent_validation["trades"]) if recent_validation else pd.DataFrame(), lot_size=lot_size),
    }


def build_parser():
    parser = argparse.ArgumentParser(description="Research intraday India index strategies with stronger robustness tests.")
    parser.add_argument(
        "--symbols",
        nargs="+",
        default=["NIFTY", "BANKNIFTY"],
        choices=sorted(SYMBOLS.keys()),
        help="Symbols to evaluate.",
    )
    parser.add_argument("--json", action="store_true", help="Emit raw JSON.")
    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()

    lot_sizes = fetch_lot_sizes()
    vix = load_vix()
    reports = []
    for symbol_name in args.symbols:
        lot_size = lot_sizes.get(SYMBOLS[symbol_name]["nse_symbol"], SYMBOLS[symbol_name]["fallback_lot_size"])
        reports.append(build_report(symbol_name, lot_size=lot_size, vix=vix))

    payload = {
        "assumptions": {
            "search_source": "Local Groww 1hour cache when available, otherwise Yahoo Finance 60m bars",
            "holdout_source": "Local Groww 15m cache when available, otherwise Yahoo Finance 15m bars",
            "daily_filter_source": "Local NIFTY/BANKNIFTY daily cache when available, otherwise Yahoo Finance daily bars",
            "macro_filter_source": "local India VIX daily cache",
            "lot_size_source": NSE_LOT_SIZE_URL,
            "candidate_grid": {
                "families": list(FAMILIES),
                "thresholds_pct": [round(item * 100.0, 3) for item in THRESHOLDS],
                "regimes": list(REGIMES),
                "gap_align_options": list(GAP_OPTIONS),
                "rsi_confirm_options": list(RSI_OPTIONS),
                "slope_align_options": list(SLOPE_OPTIONS),
            },
            "search_tests": [
                "fixed pseudo-OOS ranking after initial burn-in",
                "adaptive rolling walk-forward re-selection",
                "White-style reality check bootstrap",
                "CSCV probability of backtest overfitting",
                "Newey-West style HAC mean test",
                "moving block bootstrap confidence intervals",
            ],
            "transaction_costs_included": False,
        },
        "reports": reports,
    }
    payload = make_json_safe(payload)

    if args.json:
        print(json.dumps(payload, indent=2))
        return

    print("India intraday research")
    print("Search: 60m bars with recent 15m window excluded from tuning")
    print("Validation: 15m recent holdout plus overfitting diagnostics across the full candidate grid")
    print()

    for report in payload["reports"]:
        print(f"{report['symbol']} ({report['yahoo_symbol']})")
        top = report["fixed_oos_top_candidates"][0] if report["fixed_oos_top_candidates"] else None
        white_check = report["search_diagnostics"]["white_reality_check"]
        pbo = report["search_diagnostics"]["cscv_pbo"]
        recent = report["recent_validation_15m"]["summary"] if report["recent_validation_15m"] else None
        assessment = report["recommended_candidate"]["deployment_assessment"] if report["recommended_candidate"] else None
        if top:
            print(
                f"  best fixed pseudo-OOS candidate: {top['family']} | threshold {top['threshold_pct']}% | "
                f"regime {top['regime']} | gap {top['gap_align']} | rsi {top['rsi_confirm']} | slope {top['slope_align']}"
            )
            print(
                f"  fixed pseudo-OOS: {top['fixed_oos_summary']['trade_count']} trades | "
                f"net {top['fixed_oos_summary']['net_points']} pts | Sharpe {top['fixed_oos_summary']['session_sharpe']} | "
                f"positive block ratio {top['fixed_oos_summary']['positive_block_ratio']}"
            )
        print(
            f"  adaptive walk-forward: {report['adaptive_walk_forward']['folds']} folds | "
            f"{report['adaptive_walk_forward']['oos_trade_count']} trades | net {report['adaptive_walk_forward']['oos_net_points']} pts"
        )
        print(
            f"  search diagnostics: White RC p {white_check['p_value']} | "
            f"CSCV PBO {pbo['pbo']} | candidate count {report['candidate_count']}"
        )
        if assessment:
            print(f"  deployment assessment: {assessment['status']} | reasons {', '.join(assessment['reasons']) or 'none'}")
        if recent:
            print(
                f"  recent 15m holdout: {recent['trade_count']} trades | net {recent['net_points']} pts | "
                f"one-lot gross Rs {recent['net_inr_one_lot']}"
            )
        else:
            print("  recent 15m holdout: no valid trades")
        print()


if __name__ == "__main__":
    main()
