"""
Level sources: PDH/PDL (previous Globex-day high/low) plus, for whichever
target window is currently active, that window's own opening range (first
`opening_range_minutes` minutes) — the breakout reference for that
session's move.
"""
from ..asian_failed_breakout.levels import _globex_day_id, _in_window, _parse_hm


class PDHPDLTracker:
    """Same Globex-day-rollover convention as
    strategies/asian_failed_breakout/levels.py's LevelTracker, but only
    PDH/PDL — no need to pull in that class's Asian-range/swing tracking
    for a strategy that doesn't use them."""
    def __init__(self, rollover_hour: int = 18):
        self._rollover_hour = rollover_hour
        self._day = None
        self._day_high = None
        self._day_low = None
        self.pdh = None
        self.pdl = None

    def update(self, bar: dict, et_ts) -> None:
        day = _globex_day_id(et_ts, self._rollover_hour)
        if self._day is None:
            self._day = day
            self._day_high, self._day_low = bar["high"], bar["low"]
            return
        if day != self._day:
            self.pdh, self.pdl = self._day_high, self._day_low
            self._day = day
            self._day_high, self._day_low = bar["high"], bar["low"]
        else:
            self._day_high = max(self._day_high, bar["high"])
            self._day_low = min(self._day_low, bar["low"])


class WindowOpeningRangeTracker:
    """First `opening_minutes` minutes of a named session window, per
    occurrence (reset once per Globex day). Updated on 1m bars directly —
    these windows are short enough (60-90 min) that 5m granularity would be
    too coarse relative to the 15-minute opening slice itself."""
    def __init__(self, start: str, end: str, opening_minutes: int, rollover_hour: int = 18):
        self._start_min = _parse_hm(start)
        self._end_min = _parse_hm(end)
        self._opening_minutes = opening_minutes
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
        minutes_since_open = (tod - self._start_min) % 1440
        if _in_window(tod, self._start_min, self._end_min) and minutes_since_open < self._opening_minutes:
            if self.high is None:
                self.high, self.low = bar["high"], bar["low"]
            else:
                self.high = max(self.high, bar["high"])
                self.low = min(self.low, bar["low"])
