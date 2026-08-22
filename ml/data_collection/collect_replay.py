"""
Historical OHLCV collector, driven by TradingView Replay mode over CDP.

There is no bulk historical-export API in this repo's CDP bridge — `data_get_ohlcv`
only reads whatever's in the chart's live buffered window (capped at 500 bars), and
replay only advances one bar at a time (`replay_step`). So this script:

  1. Jumps replay to a start date (`replay start -d ...`).
  2. Steps forward in batches (`replay step` x N), then reads the buffer once per
     batch (`ohlcv -n 500`) instead of once per bar — cuts CDP round trips by ~N.
  3. Merges newly-seen bars into a per-symbol/timeframe parquet file, deduped by
     bar time, flushing to disk periodically so a killed/interrupted run loses
     at most one flush interval of progress.
  4. Resumability comes from the data itself, not a separate "last position"
     tracker: each run compares the requested [start, end] window against the
     earliest/latest bar already on disk (plan_runs()) and only walks whatever
     gap is actually missing — an older gap (widening --days after already
     having some data), a newer gap (catching up to a later --end-date), both,
     or neither. This also means re-running the exact same command is always
     safe and does the right thing, including picking up mid-collection after
     a crash.

1h/4h timeframes: a few hundred bars covers 1-2 years — a full run takes minutes.
1m/5m timeframes: tens of thousands of bars for a month — budget for a run that
takes hours. Start with a short --days window and widen it once the pipeline is
verified end-to-end; widening --days later automatically triggers a backfill
walk for the newly-added older history.

Usage:
    python ml/data_collection/collect_replay.py --symbol MNQ1! --timeframe 60 --days 5
    python ml/data_collection/collect_replay.py --symbol MNQ1! --timeframe 60 --days 730  # widen later — backfills the gap
    python ml/data_collection/collect_replay.py --symbol MNQ1! --timeframe 1 --days 30 --batch-size 50
"""
import argparse
import json
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

try:
    import fcntl
except ImportError:
    fcntl = None  # POSIX-only; ml/ targets macOS (matches this repo's CDP/TradingView Desktop setup)

import pandas as pd

# All dates in this script — CLI --start-date/--end-date, "today"/"yesterday"
# defaults, and progress logging — are Eastern Time, matching TradingView's own
# session/bar-time convention and the ET anchoring already used throughout
# ml/features/ (session windows, VWAP resets, etc.), not UTC.
ET = ZoneInfo("America/New_York")

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
TV_CLI = REPO_ROOT / "src" / "cli" / "index.js"

DATA_DIR = Path.home() / "data" / "ml-raw"
CHART_LOCK_PATH = DATA_DIR / ".chart.lock"


@contextmanager
def chart_lock():
    """Exclusive lock so collect_replay.py and predict.py (or two concurrent
    invocations of either) never drive the shared TradingView Desktop chart at
    the same time. Without this, one process's symbol/timeframe switch can land
    in the middle of another process's read — confirmed the hard way: MGC1! raw
    data collected while the live prediction server was polling in the
    background has whole stretches of MNQ1! prices mixed into a gold file.
    Blocking acquire: a collection run and a live-server poll cycle both want
    the chart eventually, so whichever asked first should just make the other
    wait rather than fail outright."""
    if fcntl is None:
        yield  # no POSIX file locking available — best-effort, no-op
        return
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(CHART_LOCK_PATH, "w") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def tv(args: list[str]) -> dict:
    result = subprocess.run(
        ["node", str(TV_CLI)] + args,
        capture_output=True, text=True, cwd=REPO_ROOT,
    )
    if result.returncode != 0:
        raise RuntimeError(f"tv CLI error ({' '.join(args)}): {result.stderr.strip()}")
    return json.loads(result.stdout)


CHART_SWITCH_RETRIES = 8
CHART_SWITCH_RETRY_DELAY_S = 1.0


def switch_chart(symbol: str, timeframe: str):
    """`tv symbol`/`tv timeframe` each wait internally for the chart to look
    ready (src/wait.js's waitForChartReady) and self-report a chart_ready flag —
    but that wait can time out and return False, and its own comment says
    "caller should verify". Nothing here verified: a stale/wrong-symbol chart
    read doesn't raise an error, it silently returns another instrument's bars.
    Confirmed the hard way — MGC1! raw data collected before this fix has whole
    stretches of MNQ1! prices mixed in (~$29,000 bars sitting in a ~$4,000 gold
    file) from exactly this race. Verify actual chart state via `tv state`
    before trusting a read, not just the switch call's own self-report."""
    tv(["symbol", symbol])
    tv(["timeframe", timeframe])
    actual_symbol, actual_tf = "", ""
    for attempt in range(CHART_SWITCH_RETRIES):
        state = tv(["state"])
        actual_symbol = state.get("symbol", "")
        actual_tf = str(state.get("resolution", ""))
        if symbol.upper() in actual_symbol.upper() and actual_tf == str(timeframe):
            return
        time.sleep(CHART_SWITCH_RETRY_DELAY_S)
    raise RuntimeError(
        f"Chart never confirmed switch to {symbol}/{timeframe} after {CHART_SWITCH_RETRIES} "
        f"retries (currently showing {actual_symbol}/{actual_tf}) — refusing to read bars off "
        f"a chart that might still be on the wrong instrument."
    )


MAX_RELATIVE_JUMP = 0.05  # 5% single-bar move — implausible for real 1m/5m/60m futures data
INTERNAL_GAP_THRESHOLD_SECONDS = 3 * 86400  # 3 days — safely above any normal weekend/holiday closure


def bars_look_contaminated(bars: list[dict], reference_price: float | None = None) -> bool:
    """switch_chart()'s own verification only checks the chart's *symbol label*
    (chart.symbol()), which can update the instant you switch — while the
    underlying bar buffer (mainSeriesBars(), what `ohlcv` actually reads) can
    still be catching up to the new symbol for a moment after. So a read can
    pass switch_chart()'s check and still return a batch straddling two
    instruments. Confirmed the hard way even after that fix was live: an
    otherwise ~$4,000 gold batch with an isolated stretch of ~$29,000 (MNQ-range)
    bars in it. A >5% bar-to-bar jump is not something real 1m/5m/60m futures
    data produces — it's the signature of exactly this straddle.

    `reference_price`, when given, is compared against the *first* bar too —
    confirmed necessary separately: if the whole 500-bar buffer had already
    flipped to another instrument before this read (not mid-read), every bar
    inside it is internally consistent with the others, just wrong, so the
    bar-to-bar check alone sees nothing. Comparing against the last
    known-good price from *outside* this batch (the previous accepted batch,
    or on-disk data) catches that case."""
    closes = [b["close"] for b in bars if b.get("close")]
    if reference_price and closes:
        if abs(closes[0] - reference_price) / abs(reference_price) > MAX_RELATIVE_JUMP:
            return True
    for prev, cur in zip(closes, closes[1:]):
        if prev and abs(cur - prev) / abs(prev) > MAX_RELATIVE_JUMP:
            return True
    return False


def date_str_to_epoch(date_str: str) -> int:
    """'YYYY-MM-DD' -> unix seconds at ET midnight. `current_date` from the tv
    CLI's replay status/step/start is itself unix seconds (bar-time convention,
    not an ISO string despite the field name), so this is what end-date
    comparisons need to be done against."""
    return int(datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=ET).timestamp())


def epoch_to_date_str(epoch_seconds: int | None) -> str:
    if not epoch_seconds:
        return "?"
    return datetime.fromtimestamp(epoch_seconds, tz=ET).strftime("%Y-%m-%d")


def epoch_to_datetime_str(epoch_seconds: int | None) -> str:
    """Date-only collapses every intraday step on sub-daily timeframes (1h bars
    stepping hour to hour all print the same day) — use this for per-step
    progress lines so movement is actually visible, and epoch_to_date_str for
    end-date comparisons/checkpoints where only the day matters."""
    if not epoch_seconds:
        return "?"
    return datetime.fromtimestamp(epoch_seconds, tz=ET).strftime("%Y-%m-%d %H:%M ET")


def epoch_to_replay_datetime_str(epoch_seconds: int) -> str:
    """A minute-precise ET datetime string for `replay start -d`, not just a
    bare date. `new Date(str).getTime()` in JS treats a date-*time* string
    with no timezone suffix ("YYYY-MM-DDTHH:MM:SS") as the *browser's local
    time* rather than UTC (unlike a bare "YYYY-MM-DD", which JS treats as UTC
    midnight) — verified directly: passing a bar's exact ET timestamp this way
    landed replay within 1 minute of that bar, vs. hours off with a bare date.
    So when resuming a catchup walk from an exact last-collected-bar
    timestamp, this is what actually eliminates the re-tread almost entirely,
    not just narrows it."""
    return datetime.fromtimestamp(epoch_seconds, tz=ET).strftime("%Y-%m-%dT%H:%M:%S")


def safe_filename(symbol: str, timeframe: str) -> str:
    return symbol.replace(":", "_").replace("!", "").replace("/", "_") + f"_{timeframe}"


def parquet_path(symbol: str, timeframe: str) -> Path:
    return DATA_DIR / f"{safe_filename(symbol, timeframe)}.parquet"


def load_existing(symbol: str, timeframe: str) -> pd.DataFrame:
    p = parquet_path(symbol, timeframe)
    if p.exists():
        return pd.read_parquet(p)
    return pd.DataFrame(columns=["time", "open", "high", "low", "close", "volume"])


def flush(symbol: str, timeframe: str, existing: pd.DataFrame, new_rows: list[dict]) -> pd.DataFrame:
    if not new_rows:
        return existing
    new_df = pd.DataFrame(new_rows)
    merged = new_df if existing.empty else pd.concat([existing, new_df], ignore_index=True)
    merged = merged.drop_duplicates(subset="time", keep="last").sort_values("time").reset_index(drop=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    merged.to_parquet(parquet_path(symbol, timeframe), index=False)
    return merged


def collect(symbol: str, timeframe: str, start_date: str, end_date: str,
            batch_size: int, flush_every: int, max_batches: int, step_pause: float):
    """Acquires chart_lock() for the whole walk — replay mode owns the chart
    continuously from the first switch_chart() through the final replay stop,
    so nothing else (a concurrent collect_replay.py run, or the live server's
    predict.py polling) may touch the chart until this returns."""
    with chart_lock():
        return _collect_locked(symbol, timeframe, start_date, end_date, batch_size, flush_every, max_batches, step_pause)


def _collect_locked(symbol: str, timeframe: str, start_date: str, end_date: str,
                     batch_size: int, flush_every: int, max_batches: int, step_pause: float):
    switch_chart(symbol, timeframe)

    existing = load_existing(symbol, timeframe)
    print(f"[{symbol} {timeframe}] existing bars on disk: {len(existing)}", file=sys.stderr)

    # end_date arrives as "YYYY-MM-DD"; current_date from the tv CLI is unix
    # seconds (see date_str_to_epoch's docstring) — convert once so every
    # in-loop comparison is numeric, not a str-vs-int TypeError waiting to happen.
    end_ts = date_str_to_epoch(end_date) + 86400  # include the whole end date

    status = tv(["replay", "status"])
    if not status.get("is_replay_available"):
        raise RuntimeError(f"Replay not available for {symbol} on timeframe {timeframe}")

    started = tv(["replay", "start", "-d", start_date])
    print(f"[{symbol} {timeframe}] replay started at {epoch_to_datetime_str(started.get('current_date'))}", file=sys.stderr)

    pending_rows: list[dict] = []
    seen_times: set[int] = set(existing["time"].tolist())
    stalled_batches = 0
    last_current_date = None
    batch_idx = 0
    # Tracks the last accepted close across batches (seeded from on-disk data
    # if resuming), so bars_look_contaminated can catch a batch that's
    # internally self-consistent but wrong as a *whole* — see that function's
    # docstring for why the bar-to-bar check alone can miss this.
    last_good_close = float(existing["close"].iloc[-1]) if len(existing) else None

    try:
        while batch_idx < max_batches:
            batch_idx += 1
            for step_no in range(batch_size):
                step_result = tv(["replay", "step"])
                if step_pause:
                    time.sleep(step_pause)
                current_date = step_result.get("current_date")
                # Each step is its own subprocess + CDP round trip (~1-3s) —
                # print progress every 10 steps so a slow batch doesn't look hung.
                if (step_no + 1) % 10 == 0:
                    print(f"[{symbol} {timeframe}]   step {step_no + 1}/{batch_size} "
                          f"(batch {batch_idx}), at {epoch_to_datetime_str(current_date)}", file=sys.stderr)
                if current_date and current_date >= end_ts:
                    break

            bars = tv(["ohlcv", "-n", "500"]).get("bars", [])
            if bars_look_contaminated(bars, reference_price=last_good_close):
                print(f"[{symbol} {timeframe}] batch {batch_idx}: bars look contaminated "
                      f"(implausible jump) — re-confirming chart and retrying this read", file=sys.stderr)
                switch_chart(symbol, timeframe)
                time.sleep(2)
                bars = tv(["ohlcv", "-n", "500"]).get("bars", [])
                if bars_look_contaminated(bars, reference_price=last_good_close):
                    raise RuntimeError(
                        f"OHLCV data for {symbol}/{timeframe} still looks contaminated after a "
                        f"retry — refusing to write it. Something is switching the chart to another "
                        f"instrument faster than this can recover from (another process not going "
                        f"through chart_lock(), or someone interacting with TradingView Desktop "
                        f"directly). Stop whatever that is and re-run."
                    )
            new_count = 0
            for bar in bars:
                if bar["time"] not in seen_times:
                    seen_times.add(bar["time"])
                    pending_rows.append(bar)
                    new_count += 1
            if bars:
                last_good_close = bars[-1]["close"]

            status = tv(["replay", "status"])
            current_date = status.get("current_date")
            print(f"[{symbol} {timeframe}] batch {batch_idx}: +{new_count} new bars, "
                  f"replay date={epoch_to_datetime_str(current_date)}, pending flush={len(pending_rows)}", file=sys.stderr)

            # "0 new bars" alone doesn't mean replay is stuck — it also happens
            # while legitimately re-walking a stretch that's already on disk
            # (e.g. a resumed catchup walk starting a few hours before the last
            # collected bar, since `replay start -d` snaps to that date's UTC
            # midnight, not ET midnight — a bounded, self-correcting offset that
            # this loop should just walk through, not give up on). The real
            # signal that replay has hit a wall it can't step past (the live
            # edge, or a genuine data boundary) is current_date itself staying
            # frozen across batches — confirmed the hard way: this used to give
            # up after 150 steps of harmless re-tread, aborting collection runs
            # that had tens of thousands of genuinely new bars still ahead.
            if current_date == last_current_date:
                stalled_batches += 1
                if stalled_batches >= 3:
                    print(f"[{symbol} {timeframe}] replay date hasn't advanced for 3 batches, stopping.", file=sys.stderr)
                    break
            else:
                stalled_batches = 0
            last_current_date = current_date

            if batch_idx % flush_every == 0 and pending_rows:
                existing = flush(symbol, timeframe, existing, pending_rows)
                pending_rows = []

            if current_date and current_date >= end_ts:
                print(f"[{symbol} {timeframe}] reached end date {end_date}, stopping.", file=sys.stderr)
                break
    finally:
        if pending_rows:
            existing = flush(symbol, timeframe, existing, pending_rows)
        tv(["replay", "stop"])
        print(f"[{symbol} {timeframe}] done. total bars on disk: {len(existing)}", file=sys.stderr)

    return existing


def plan_runs(symbol: str, timeframe: str, target_start: str, target_end: str) -> list[tuple[str, str]]:
    """Decides which (start_date, end_date) walks are actually needed by
    comparing the requested [target_start, target_end] window against what's
    already on disk — not against a separately-tracked "last position"
    checkpoint, which has no way to express "also go further back in history"
    and silently ignored a widened --days once any checkpoint existed (the bug
    that motivated this).

    Replay can only step forward, so backfilling older history means starting
    a fresh walk at target_start and stepping forward until it reaches
    whatever's already the earliest bar on disk (dedup handles the overlap) —
    a separate walk from catching up to target_end.

    Also scans for gaps *inside* [existing_min, existing_max], not just at the
    two endpoints — confirmed necessary the hard way: an interrupted run (a
    crash, the machine sleeping mid-collection, anything that kills the
    process partway) can leave some data collected before the interruption and
    more collected after a later resume, with a large hole in between. Only
    checking the outer boundary is blind to that entirely — it sees *a* bar at
    the start and *a* bar at the end and calls the range complete.
    """
    existing = load_existing(symbol, timeframe)
    if existing.empty:
        return [(target_start, target_end)]

    existing = existing.sort_values("time").reset_index(drop=True)
    existing_min = epoch_to_date_str(int(existing["time"].min()))
    existing_max = epoch_to_date_str(int(existing["time"].max()))
    print(f"[{symbol} {timeframe}] on disk: {len(existing)} bars, {existing_min} -> {existing_max}", file=sys.stderr)

    runs = []
    if target_start < existing_min:
        runs.append((target_start, existing_min))

    # A gap wider than a few days is well beyond any normal weekend/holiday
    # closure for a nearly-continuous futures market — safe to treat as
    # genuinely missing data rather than a scheduled gap.
    gap_seconds = existing["time"].diff()
    for pos in gap_seconds[gap_seconds > INTERNAL_GAP_THRESHOLD_SECONDS].index:
        before, after = int(existing["time"].iloc[pos - 1]), int(existing["time"].iloc[pos])
        print(f"[{symbol} {timeframe}] internal gap: {epoch_to_datetime_str(before)} -> {epoch_to_datetime_str(after)}", file=sys.stderr)
        runs.append((epoch_to_replay_datetime_str(before), epoch_to_date_str(after)))

    if existing_max < target_end:
        # Resume from the *exact* last bar, minute-precise (see
        # epoch_to_replay_datetime_str) — a bare date here would restart
        # replay hours before the last collected bar and re-walk all of it
        # for nothing.
        catchup_start = epoch_to_replay_datetime_str(int(existing["time"].max()))
        runs.append((catchup_start, target_end))
    if not runs:
        print(f"[{symbol} {timeframe}] already covers {target_start} -> {target_end}, nothing to do.", file=sys.stderr)
    return runs


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", required=True, help="e.g. MNQ1!, MGC1!")
    parser.add_argument("--timeframe", required=True, help="tv resolution string, e.g. 1, 5, 60")
    parser.add_argument("--days", type=int, default=30, help="days of history to target, ending at --end-date")
    parser.add_argument("--start-date", help="YYYY-MM-DD, overrides --days: force a single walk from exactly this date to --end-date")
    parser.add_argument("--end-date", help="YYYY-MM-DD, default yesterday (today's still-open session is excluded by default)")
    parser.add_argument("--batch-size", type=int, default=50, help="replay steps per OHLCV read")
    parser.add_argument("--flush-every", type=int, default=5, help="batches between parquet writes")
    parser.add_argument("--max-batches", type=int, default=100000, help="safety cap on total batches")
    parser.add_argument("--step-pause", type=float, default=0.0, help="seconds to sleep after each replay step")
    args = parser.parse_args()

    # Default end date is yesterday (in ET, TradingView's own session convention —
    # not whatever timezone this machine's clock happens to be in), not today —
    # today's session is still in progress and its bars/labels would be incomplete
    # (a "timeout" label near the end of the data isn't a real timeout, it's just
    # "hasn't happened yet").
    end_date = args.end_date or (datetime.now(ET) - timedelta(days=1)).strftime("%Y-%m-%d")
    # --days counts back from end_date, not "now", so a custom --end-date still
    # yields exactly `days` days of window.
    target_start = args.start_date or (datetime.strptime(end_date, "%Y-%m-%d") - timedelta(days=args.days)).strftime("%Y-%m-%d")

    if args.start_date:
        runs = [(target_start, end_date)]
    else:
        runs = plan_runs(args.symbol, args.timeframe, target_start, end_date)

    for i, (start_date, run_end_date) in enumerate(runs):
        print(f"[{args.symbol} {args.timeframe}] === run {i + 1}/{len(runs)}: {start_date} -> {run_end_date} ===", file=sys.stderr)
        collect(
            symbol=args.symbol,
            timeframe=args.timeframe,
            start_date=start_date,
            end_date=run_end_date,
            batch_size=args.batch_size,
            flush_every=args.flush_every,
            max_batches=args.max_batches,
            step_pause=args.step_pause,
        )


if __name__ == "__main__":
    main()
