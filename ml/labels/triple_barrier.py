"""
Triple-barrier labeling: for each bar, look forward up to `horizon_bars` and
label whether price hits the take-profit level before the stop-loss level
(1 = TP first, 0 = SL first, NaN = neither hit within the horizon — a timeout,
dropped from training rather than force-labeled).

TP/SL distances are fixed price points (not exchange ticks — ml/config/symbols.json
stores ticks; ml/features/build_dataset.py's load_symbol_config() converts via each
symbol's tick_size before calling this) rather than ATR-scaled, so the same
tp_points/sl_points apply to every row.

Two labels are produced per bar — label_long (would a long entered at this bar's
close hit its TP before its SL) and label_short (mirror, for a short entry) —
since direction comes from the strategy context (e.g. a bullish low-sweep implies
checking the long label, a bearish high-sweep implies the short label), not from
the labeling function itself.

If both TP and SL are touched within the same forward bar, intrabar ordering is
unknown from OHLC alone — this labels it as SL-first (label=0), the conservative
assumption, rather than guessing optimistically.

`horizon_bars` counts *array positions*, not elapsed time — a raw data file with
gaps (a symbol whose collection was interrupted partway, or hasn't backfilled a
stretch yet) can have two adjacent rows that are actually days apart. Scanning
"the next 60 rows" across a gap like that would compare prices across a real
30-day jump as if it were 60 consecutive minutes, which isn't what the label is
supposed to mean. So the forward scan stops the moment it crosses a gap wider
than `max_gap_bars` x the data's typical spacing, and that row is left as a
timeout (NaN) rather than mislabeled — we genuinely don't know what happened
during a stretch with no data. Symptom of this before the fix existed: a small
number of labels near a coverage gap that didn't actually reflect 60 real
minutes of price action.

This is a plain nested loop (not vectorized) — O(n * horizon_bars). For a few
tens of thousands of rows with horizon_bars ~50-60 that's seconds, fine for an
offline batch step; revisit with numba/vectorization only if it becomes a
bottleneck on larger pulls.
"""
import numpy as np
import pandas as pd


def _first_touch_labels(entry: np.ndarray, highs: np.ndarray, lows: np.ndarray,
                         tp_dist: np.ndarray, sl_dist: np.ndarray, horizon: int, direction: int,
                         times: np.ndarray, max_gap_seconds: float):
    n = len(entry)
    labels = np.full(n, np.nan)
    bars_to_resolve = np.full(n, np.nan)

    for i in range(n):
        end = min(i + 1 + horizon, n)
        if end <= i + 1:
            continue
        e = entry[i]
        if direction == 1:
            tp_level = e + tp_dist[i]
            sl_level = e - sl_dist[i]
        else:
            tp_level = e - tp_dist[i]
            sl_level = e + sl_dist[i]

        for j in range(i + 1, end):
            if times[j] - times[j - 1] > max_gap_seconds:
                break  # crossed a data gap — unknown what happened, leave as timeout
            hit_tp = highs[j] >= tp_level if direction == 1 else lows[j] <= tp_level
            hit_sl = lows[j] <= sl_level if direction == 1 else highs[j] >= sl_level
            if hit_tp and hit_sl:
                labels[i] = 0  # ambiguous same-bar touch — conservative: SL first
                bars_to_resolve[i] = j - i
                break
            elif hit_tp:
                labels[i] = 1
                bars_to_resolve[i] = j - i
                break
            elif hit_sl:
                labels[i] = 0
                bars_to_resolve[i] = j - i
                break

    return labels, bars_to_resolve


def label_triple_barrier(df: pd.DataFrame, tp_points: float, sl_points: float, horizon_bars: int,
                          max_gap_bars: float = 3.0) -> pd.DataFrame:
    df = df.sort_values("time").reset_index(drop=True).copy()
    entry = df["close"].to_numpy(dtype=float)
    highs = df["high"].to_numpy(dtype=float)
    lows = df["low"].to_numpy(dtype=float)
    times = df["time"].to_numpy(dtype=float)
    tp_arr = np.full(len(df), float(tp_points))
    sl_arr = np.full(len(df), float(sl_points))

    typical_interval = np.median(np.diff(times)) if len(times) > 1 else 1.0
    max_gap_seconds = max_gap_bars * typical_interval

    label_long, bars_long = _first_touch_labels(entry, highs, lows, tp_arr, sl_arr, horizon_bars,
                                                  direction=1, times=times, max_gap_seconds=max_gap_seconds)
    label_short, bars_short = _first_touch_labels(entry, highs, lows, tp_arr, sl_arr, horizon_bars,
                                                    direction=-1, times=times, max_gap_seconds=max_gap_seconds)

    df["label_long"] = label_long
    df["label_short"] = label_short
    df["bars_to_resolve_long"] = bars_long
    df["bars_to_resolve_short"] = bars_short
    return df
