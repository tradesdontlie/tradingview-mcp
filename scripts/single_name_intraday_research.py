#!/usr/bin/env python3

import argparse
import json
import math
from dataclasses import asdict, dataclass
from itertools import combinations

import numpy as np
import pandas as pd
import yfinance as yf
from scipy import stats

LONG_HISTORY_INTERVAL = "60m"
LONG_HISTORY_PERIOD = "730d"
RECENT_INTERVAL = "15m"
RECENT_PERIOD = "60d"
TRAIN_SESSIONS = 80
TEST_SESSIONS = 20
MIN_TRADE_COUNT = 10
BOOTSTRAP_BLOCK = 10
WHITE_BOOTSTRAP_ITERS = 300
CSCV_SLICES = 8

SYMBOLS = {
    "HDFCBANK": {
        "yahoo": "HDFCBANK.NS",
        "benchmark": "^NSEBANK",
    },
    "BAJFINANCE": {
        "yahoo": "BAJFINANCE.NS",
        "benchmark": "^NSEBANK",
    },
}

THRESHOLDS = (0.0020, 0.0025, 0.0030, 0.0035, 0.0040, 0.0050)
BOOL_OPTIONS = (False, True)


@dataclass(frozen=True)
class CandidateSpec:
    threshold: float
    gap_align: bool
    trend_confirm: bool
    benchmark_align: bool
    leader_confirm: bool
    volume_surge: bool

    def label(self) -> str:
        return (
            f"thr={self.threshold:.4f}|gap={int(self.gap_align)}|trend={int(self.trend_confirm)}|"
            f"bench={int(self.benchmark_align)}|leader={int(self.leader_confirm)}|vol={int(self.volume_surge)}"
        )

    def to_public_dict(self) -> dict:
        payload = asdict(self)
        payload["threshold_pct"] = round(payload.pop("threshold") * 100.0, 3)
        return payload


def rsi(series: pd.Series, lookback: int = 14) -> pd.Series:
    delta = series.diff()
    up = delta.clip(lower=0.0)
    down = -delta.clip(upper=0.0)
    avg_up = up.ewm(alpha=1 / lookback, adjust=False, min_periods=lookback).mean()
    avg_down = down.ewm(alpha=1 / lookback, adjust=False, min_periods=lookback).mean()
    rs = avg_up / avg_down.replace(0.0, np.nan)
    return 100.0 - (100.0 / (1.0 + rs))


def load_intraday(symbol: str, period: str, interval: str) -> pd.DataFrame:
    data = yf.download(symbol, period=period, interval=interval, progress=False, auto_adjust=False)
    if data.empty:
        raise RuntimeError(f"No intraday bars returned for {symbol}")
    if isinstance(data.columns, pd.MultiIndex):
        data.columns = [column[0].lower() for column in data.columns]
    else:
        data.columns = [column.lower() for column in data.columns]
    cols = ["open", "high", "low", "close", "volume"]
    data = data[cols].dropna(subset=["open", "high", "low", "close"]).copy()
    data.index = data.index.tz_convert("Asia/Kolkata")
    data["session"] = data.index.date
    return data


def load_daily(symbol: str) -> pd.DataFrame:
    data = yf.download(symbol, period="5y", interval="1d", progress=False, auto_adjust=False)
    if data.empty:
        raise RuntimeError(f"No daily bars returned for {symbol}")
    if isinstance(data.columns, pd.MultiIndex):
        data.columns = [column[0].lower() for column in data.columns]
    else:
        data.columns = [column.lower() for column in data.columns]
    frame = pd.DataFrame({"close": data["close"].dropna()})
    if getattr(frame.index, "tz", None):
        frame.index = frame.index.tz_localize(None)
    frame["ema20"] = frame["close"].ewm(span=20, adjust=False).mean()
    frame["rsi14"] = rsi(frame["close"], 14)
    return frame


def sign_value(value: float) -> int:
    if pd.isna(value) or value == 0.0:
        return 0
    return 1 if value > 0 else -1


def session_frame(symbol: str, benchmark_symbol: str, period: str, interval: str) -> pd.DataFrame:
    stock = load_intraday(symbol, period=period, interval=interval)
    benchmark = load_intraday(benchmark_symbol, period=period, interval=interval)
    stock_daily = load_daily(symbol)

    if interval == "60m":
        min_bars = 7
        signal_bar = 3
        entry_bar = 4
    else:
        min_bars = 25
        signal_bar = 15
        entry_bar = 16

    stock_counts = stock.groupby("session").size()
    bench_counts = benchmark.groupby("session").size()
    good_sessions = sorted(set(stock_counts[stock_counts >= min_bars].index) & set(bench_counts[bench_counts >= min_bars].index))
    stock = stock[stock["session"].isin(good_sessions)].copy()
    benchmark = benchmark[benchmark["session"].isin(good_sessions)].copy()

    rows = []
    first_window_volumes = []
    for session in good_sessions:
        day = stock[stock["session"] == session].sort_index().reset_index(drop=True)
        bench_day = benchmark[benchmark["session"] == session].sort_index().reset_index(drop=True)
        prev_daily = stock_daily[stock_daily.index < pd.Timestamp(session)].tail(1)
        if prev_daily.empty or len(day) <= entry_bar or len(bench_day) <= signal_bar:
            continue

        prev_close = float(prev_daily["close"].iloc[0])
        prev_ema20 = float(prev_daily["ema20"].iloc[0])
        first_window_vol = float(day.loc[:signal_bar, "volume"].sum())
        first_window_volumes.append(first_window_vol)
        vol_med20 = float(np.median(first_window_volumes[-20:])) if first_window_volumes else np.nan
        rows.append(
            {
                "session": pd.Timestamp(session),
                "trend_state": sign_value(prev_close - prev_ema20),
                "prev_rsi14": float(prev_daily["rsi14"].iloc[0]),
                "signal_ret": (float(day.loc[signal_bar, "close"]) - float(day.loc[0, "open"])) / float(day.loc[0, "open"]),
                "benchmark_signal_ret": (float(bench_day.loc[signal_bar, "close"]) - float(bench_day.loc[0, "open"])) / float(bench_day.loc[0, "open"]),
                "gap_ret": (float(day.loc[0, "open"]) - prev_close) / prev_close,
                "entry_price": float(day.loc[entry_bar, "open"]),
                "close_eod": float(day.iloc[-1]["close"]),
                "first_window_volume": first_window_vol,
                "first_window_vol_med20": vol_med20,
                "year": int(pd.Timestamp(session).year),
            }
        )

    return pd.DataFrame(rows).sort_values("session").reset_index(drop=True)


def candidate_specs():
    for threshold in THRESHOLDS:
        for gap_align in BOOL_OPTIONS:
            for trend_confirm in BOOL_OPTIONS:
                for benchmark_align in BOOL_OPTIONS:
                    for leader_confirm in BOOL_OPTIONS:
                        for volume_surge in BOOL_OPTIONS:
                            yield CandidateSpec(
                                threshold=threshold,
                                gap_align=gap_align,
                                trend_confirm=trend_confirm,
                                benchmark_align=benchmark_align,
                                leader_confirm=leader_confirm,
                                volume_surge=volume_surge,
                            )


def candidate_trade_frame(frame: pd.DataFrame, spec: CandidateSpec) -> tuple[pd.DataFrame, pd.Series]:
    if frame.empty:
        return pd.DataFrame(), pd.Series(dtype=float)

    direction = np.sign(frame["signal_ret"]).astype(int)
    benchmark_dir = np.sign(frame["benchmark_signal_ret"]).astype(int)
    mask = frame["signal_ret"].abs() >= spec.threshold
    if spec.gap_align:
        mask &= np.sign(frame["gap_ret"]) == direction
    if spec.trend_confirm:
        mask &= frame["trend_state"] == direction
    if spec.benchmark_align:
        mask &= benchmark_dir == direction
    if spec.leader_confirm:
        mask &= benchmark_dir == direction
        mask &= frame["signal_ret"].abs() > frame["benchmark_signal_ret"].abs()
    if spec.volume_surge:
        mask &= frame["first_window_volume"] > frame["first_window_vol_med20"]

    session_returns = pd.Series(0.0, index=pd.DatetimeIndex(frame["session"]), dtype=float)
    trades = frame.loc[mask, ["session", "entry_price", "close_eod", "year"]].copy()
    if trades.empty:
        return trades, session_returns

    directions = pd.Series(direction[mask], index=trades.index).astype(int)
    trades["direction_value"] = directions
    trades["direction"] = np.where(trades["direction_value"] > 0, "LONG", "SHORT")
    trades["exit_price"] = trades["close_eod"].astype(float)
    trades["pnl_points"] = (trades["exit_price"] - trades["entry_price"]) * trades["direction_value"]
    trades["pnl_pct"] = ((trades["exit_price"] / trades["entry_price"]) - 1.0) * trades["direction_value"]
    trades = trades.drop(columns=["close_eod"]).reset_index(drop=True)
    session_returns.loc[pd.DatetimeIndex(trades["session"])] = trades["pnl_pct"].astype(float).values
    return trades, session_returns


def annualized_sharpe(returns: pd.Series) -> float:
    series = pd.Series(returns).fillna(0.0).astype(float)
    stdev = float(series.std())
    if series.empty or stdev <= 0.0:
        return float("nan")
    return float(series.mean() / stdev * np.sqrt(252.0))


def max_drawdown(returns: pd.Series) -> float:
    series = pd.Series(returns).fillna(0.0).astype(float)
    if series.empty:
        return float("nan")
    equity = (1.0 + series).cumprod()
    return float((equity / equity.cummax() - 1.0).min())


def summary_from_trades(trades: pd.DataFrame, session_returns: pd.Series, session_count: int) -> dict:
    pnl = trades["pnl_points"].astype(float) if not trades.empty else pd.Series(dtype=float)
    wins = float(pnl[pnl > 0].sum())
    losses = float(-pnl[pnl < 0].sum())
    trade_count = int(len(trades))
    return {
        "trade_count": trade_count,
        "session_count": int(session_count),
        "exposure_pct": round(float(trade_count / session_count * 100.0), 2) if session_count else 0.0,
        "net_points": round(float(pnl.sum()), 2) if trade_count else 0.0,
        "avg_points": round(float(pnl.mean()), 2) if trade_count else 0.0,
        "win_rate": round(float((pnl > 0).mean() * 100.0), 2) if trade_count else 0.0,
        "profit_factor": round(float(wins / losses), 3) if losses > 0 else None,
        "session_sharpe": round(float(annualized_sharpe(session_returns)), 3) if session_count else None,
        "max_drawdown_pct": round(float(max_drawdown(session_returns) * 100.0), 2) if session_count else None,
    }


def evaluate_candidate(frame: pd.DataFrame, spec: CandidateSpec) -> dict:
    trades, session_returns = candidate_trade_frame(frame, spec)
    return {
        "summary": summary_from_trades(trades, session_returns, session_count=len(frame)),
        "trades": trades,
        "session_returns": session_returns,
    }


def chunk_ranges(length: int, chunk_size: int):
    for start in range(0, length, chunk_size):
        yield start, min(start + chunk_size, length)


def fixed_oos_breakdown(frame: pd.DataFrame, spec: CandidateSpec) -> dict:
    if len(frame) <= TRAIN_SESSIONS:
        empty = pd.Series(dtype=float)
        return {"summary": summary_from_trades(pd.DataFrame(), empty, 0), "session_returns": empty, "blocks": []}

    oos = frame.iloc[TRAIN_SESSIONS:].reset_index(drop=True)
    result = evaluate_candidate(oos, spec)
    blocks = []
    positive_blocks = 0
    nonzero_blocks = 0
    for start, stop in chunk_ranges(len(oos), TEST_SESSIONS):
        block = oos.iloc[start:stop].reset_index(drop=True)
        metrics = evaluate_candidate(block, spec)["summary"]
        blocks.append(
            {
                "start": block["session"].iloc[0].strftime("%Y-%m-%d"),
                "end": block["session"].iloc[-1].strftime("%Y-%m-%d"),
                **metrics,
            }
        )
        if metrics["trade_count"] > 0:
            nonzero_blocks += 1
            if metrics["net_points"] > 0:
                positive_blocks += 1
    result["summary"]["positive_block_ratio"] = round(float(positive_blocks / nonzero_blocks), 3) if nonzero_blocks else 0.0
    result["summary"]["block_count"] = len(blocks)
    result["blocks"] = blocks
    return result


def bootstrap_indices(length: int, block: int, rng: np.random.Generator) -> np.ndarray:
    if length == 0:
        return np.array([], dtype=int)
    indices = []
    while len(indices) < length:
        start = int(rng.integers(0, length))
        indices.extend((start + offset) % length for offset in range(block))
    return np.asarray(indices[:length], dtype=int)


def white_reality_check(return_matrix: pd.DataFrame) -> dict:
    frame = return_matrix.fillna(0.0).astype(float)
    if frame.empty:
        return {"p_value": None, "best_label": None}
    values = frame.to_numpy(dtype=float)
    length = values.shape[0]
    means = values.mean(axis=0)
    observed = float(np.sqrt(length) * means.max())
    centered = values - means
    rng = np.random.default_rng(7)
    boot_stats = []
    for _ in range(WHITE_BOOTSTRAP_ITERS):
        idx = bootstrap_indices(length, BOOTSTRAP_BLOCK, rng)
        sample = centered[idx, :]
        boot_stats.append(float(np.sqrt(length) * sample.mean(axis=0).max()))
    best_idx = int(np.argmax(means))
    return {
        "p_value": round(float(np.mean(np.asarray(boot_stats) >= observed)), 4),
        "best_label": str(frame.columns[best_idx]),
    }


def cscv_pbo(return_matrix: pd.DataFrame) -> dict:
    frame = return_matrix.fillna(0.0).astype(float)
    if frame.empty or frame.shape[1] < 2 or len(frame) < CSCV_SLICES:
        return {"pbo": None, "split_count": 0}
    slices = np.array_split(np.arange(len(frame)), CSCV_SLICES)
    split_results = []
    for combo in combinations(range(CSCV_SLICES), CSCV_SLICES // 2):
        if 0 not in combo:
            continue
        train_idx = np.concatenate([slices[idx] for idx in combo])
        test_idx = np.concatenate([slices[idx] for idx in range(CSCV_SLICES) if idx not in combo])
        train_scores = frame.iloc[train_idx].apply(annualized_sharpe, axis=0).replace([np.inf, -np.inf], np.nan).fillna(-1e18)
        test_scores = frame.iloc[test_idx].apply(annualized_sharpe, axis=0).replace([np.inf, -np.inf], np.nan).fillna(-1e18)
        best_label = str(train_scores.idxmax())
        oos_rank = float(stats.rankdata(test_scores.values, method="average")[frame.columns.get_loc(best_label)])
        split_results.append(oos_rank / (len(test_scores) + 1.0))
    if not split_results:
        return {"pbo": None, "split_count": 0}
    arr = np.asarray(split_results, dtype=float)
    return {"pbo": round(float(np.mean(arr <= 0.5)), 4), "split_count": int(len(arr))}


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


def assess_deployment(candidate: dict, recent_summary: dict, white_check: dict, pbo: dict) -> dict:
    reasons = []
    fixed = candidate["fixed_oos_summary"]
    if fixed["session_sharpe"] is None or fixed["session_sharpe"] < 1.0:
        reasons.append("fixed_oos_sharpe_below_1")
    if fixed["positive_block_ratio"] < 0.55:
        reasons.append("too_few_positive_blocks")
    if recent_summary["net_points"] <= 0.0 or (recent_summary["session_sharpe"] or 0.0) < 0.75:
        reasons.append("recent_holdout_not_strong_enough")
    if white_check["p_value"] is None or white_check["p_value"] > 0.10:
        reasons.append("fails_white_reality_check")
    if pbo["pbo"] is None or pbo["pbo"] > 0.30:
        reasons.append("high_probability_of_backtest_overfitting")
    if not reasons:
        status = "candidate_for_small_size"
    elif reasons == ["fails_white_reality_check"]:
        status = "paper_trade_only"
    else:
        status = "reject_for_now"
    return {"status": status, "reasons": reasons}


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
    if isinstance(value, CandidateSpec):
        return value.to_public_dict()
    if isinstance(value, (float, np.floating)):
        if math.isnan(value) or math.isinf(value):
            return None
        return float(value)
    if isinstance(value, (int, np.integer)):
        return int(value)
    return value


def build_report(symbol_name: str) -> dict:
    config = SYMBOLS[symbol_name]
    long_history = session_frame(config["yahoo"], config["benchmark"], LONG_HISTORY_PERIOD, LONG_HISTORY_INTERVAL)
    recent = session_frame(config["yahoo"], config["benchmark"], RECENT_PERIOD, RECENT_INTERVAL)

    holdout_start = pd.Timestamp(recent["session"].min()) if not recent.empty else None
    research = long_history[long_history["session"] < holdout_start].reset_index(drop=True) if holdout_start is not None else long_history.copy()
    if len(research) <= TRAIN_SESSIONS + TEST_SESSIONS:
        research = long_history.copy()

    specs = list(candidate_specs())
    candidate_rows = []
    pseudo_oos = research.iloc[TRAIN_SESSIONS:].reset_index(drop=True) if len(research) > TRAIN_SESSIONS else research.iloc[0:0].copy()
    oos_matrix = {}
    for spec in specs:
        full_result = evaluate_candidate(research, spec)
        fixed_result = fixed_oos_breakdown(research, spec)
        row = {
            "spec": spec,
            "public": spec.to_public_dict(),
            "full_sample_summary": full_result["summary"],
            "fixed_oos_summary": fixed_result["summary"],
            "fixed_oos_returns": fixed_result["session_returns"],
            "fixed_oos_trades": evaluate_candidate(research.iloc[TRAIN_SESSIONS:].reset_index(drop=True), spec)["trades"] if len(research) > TRAIN_SESSIONS else pd.DataFrame(),
        }
        candidate_rows.append(row)
        if len(pseudo_oos) > 0:
            oos_matrix[spec.label()] = fixed_result["session_returns"].reindex(pd.DatetimeIndex(pseudo_oos["session"])).fillna(0.0)

    ranking_pool = [row for row in candidate_rows if row["fixed_oos_summary"]["trade_count"] >= MIN_TRADE_COUNT] or candidate_rows
    ranking = sorted(
        ranking_pool,
        key=lambda row: (
            float(row["fixed_oos_summary"]["session_sharpe"]) if row["fixed_oos_summary"]["session_sharpe"] is not None else -1e18,
            row["fixed_oos_summary"]["net_points"],
            row["fixed_oos_summary"]["positive_block_ratio"],
        ),
        reverse=True,
    )
    top_candidates = [
        {
            **row["public"],
            "full_sample_summary": row["full_sample_summary"],
            "fixed_oos_summary": row["fixed_oos_summary"],
        }
        for row in ranking[:8]
    ]

    white_check = white_reality_check(pd.DataFrame(oos_matrix))
    pbo = cscv_pbo(pd.DataFrame(oos_matrix))

    recommended = ranking[0]
    recent_result = evaluate_candidate(recent, recommended["spec"])
    recent_summary = recent_result["summary"]
    recommendation = {
        **recommended["public"],
        "full_sample_summary": recommended["full_sample_summary"],
        "fixed_oos_summary": recommended["fixed_oos_summary"],
        "year_breakdown": year_breakdown(recommended["fixed_oos_trades"]),
        "deployment_assessment": assess_deployment(
            {
                "fixed_oos_summary": recommended["fixed_oos_summary"],
            },
            recent_summary,
            white_check,
            pbo,
        ),
    }

    return {
        "symbol": symbol_name,
        "yahoo_symbol": config["yahoo"],
        "benchmark_symbol": config["benchmark"],
        "research_sample": {
            "session_count": int(len(research)),
            "start": research["session"].min().strftime("%Y-%m-%d") if not research.empty else None,
            "end": research["session"].max().strftime("%Y-%m-%d") if not research.empty else None,
        },
        "recent_holdout_15m_sample": {
            "session_count": int(len(recent)),
            "start": recent["session"].min().strftime("%Y-%m-%d") if not recent.empty else None,
            "end": recent["session"].max().strftime("%Y-%m-%d") if not recent.empty else None,
        },
        "candidate_count": len(specs),
        "fixed_oos_top_candidates": top_candidates,
        "search_diagnostics": {
            "white_reality_check": white_check,
            "cscv_pbo": pbo,
        },
        "recommended_candidate": recommendation,
        "recent_validation_15m": {
            **recommended["public"],
            "summary": recent_summary,
            "trades": [
                {
                    "session": trade["session"].strftime("%Y-%m-%d"),
                    "direction": trade["direction"],
                    "entry_price": round(float(trade["entry_price"]), 2),
                    "exit_price": round(float(trade["exit_price"]), 2),
                    "pnl_points": round(float(trade["pnl_points"]), 2),
                }
                for _, trade in recent_result["trades"].iterrows()
            ],
        },
    }


def build_parser():
    parser = argparse.ArgumentParser(description="Research single-name intraday continuation on Indian financial stocks.")
    parser.add_argument("--symbols", nargs="+", default=list(SYMBOLS.keys()), choices=sorted(SYMBOLS.keys()))
    parser.add_argument("--json", action="store_true")
    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    reports = [build_report(symbol_name) for symbol_name in args.symbols]
    payload = make_json_safe(
        {
            "assumptions": {
                "strategy_family": "midday continuation on the underlying, not option prices",
                "single_name_tells_tested": [
                    "overnight gap alignment",
                    "daily trend confirmation",
                    "same-day Bank Nifty direction confirmation",
                    "single-name leadership vs Bank Nifty over the signal window",
                    "early volume surge vs 20-session median",
                ],
                "options_note": "Yahoo returned no Indian option chain history for these names, so this is an underlying-trigger study only.",
            },
            "reports": reports,
        }
    )
    if args.json:
        print(json.dumps(payload, indent=2))
        return

    print("Single-name intraday research")
    print("Strategy family: midday continuation with stock-specific confirmation tells")
    print()
    for report in payload["reports"]:
        top = report["fixed_oos_top_candidates"][0]
        recent = report["recent_validation_15m"]["summary"]
        print(f"{report['symbol']} ({report['yahoo_symbol']})")
        print(
            f"  top candidate: threshold {top['threshold_pct']}% | gap {top['gap_align']} | trend {top['trend_confirm']} | "
            f"bench {top['benchmark_align']} | leader {top['leader_confirm']} | vol {top['volume_surge']}"
        )
        print(
            f"  fixed pseudo-OOS: {top['fixed_oos_summary']['trade_count']} trades | net {top['fixed_oos_summary']['net_points']} pts | "
            f"Sharpe {top['fixed_oos_summary']['session_sharpe']}"
        )
        print(
            f"  recent 15m holdout: {recent['trade_count']} trades | net {recent['net_points']} pts | "
            f"Sharpe {recent['session_sharpe']}"
        )
        print(f"  deployment assessment: {report['recommended_candidate']['deployment_assessment']}")
        print()


if __name__ == "__main__":
    main()
