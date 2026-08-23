"""
Important-location tracker: PDH/PDL, current Asian range, current London
range, and confirmed swing highs/lows — all fed 5m bars incrementally and
causal (a location is only visible once the 5m bar that updates it has
actually closed).

Reuses strategies/asian_failed_breakout/levels.py's LevelTracker directly
for PDH/PDL, Asian range, and swing points (same PDH/PDL/Asian-range/swing
concepts, no reason to duplicate them) and adds a small London-range
tracker alongside it, using the same wrap-aware window/Globex-day utilities.
"""
from dataclasses import dataclass

from ..asian_failed_breakout.config import AsianRangeConfig, SessionConfig as AsianSessionConfig, SwingConfig
from ..asian_failed_breakout.levels import LevelTracker as _AsianStyleLevelTracker
from ..asian_failed_breakout.levels import _globex_day_id, _in_window, _parse_hm


class LocationTracker:
    def __init__(self, cfg):
        s = cfg.sessions
        asian_session_cfg = AsianSessionConfig(
            asian_session_start=s.asia_start, asian_session_end=s.asia_end,
            globex_day_rollover_hour=s.globex_day_rollover_hour,
        )
        self._base = _AsianStyleLevelTracker(asian_session_cfg, cfg.swing, AsianRangeConfig(min_bars_5m_before_use=1))

        self._london_start_min = _parse_hm(s.london_start)
        self._london_end_min = _parse_hm(s.london_end)
        self._rollover_hour = s.globex_day_rollover_hour
        self._london_day = None
        self.london_range_high = None
        self.london_range_low = None

    def update(self, bar: dict, et_ts) -> None:
        self._base.update(bar, et_ts)

        day = _globex_day_id(et_ts, self._rollover_hour)
        if day != self._london_day:
            self._london_day = day
            self.london_range_high = None
            self.london_range_low = None
        tod = et_ts.hour * 60 + et_ts.minute
        if _in_window(tod, self._london_start_min, self._london_end_min):
            if self.london_range_high is None:
                self.london_range_high, self.london_range_low = bar["high"], bar["low"]
            else:
                self.london_range_high = max(self.london_range_high, bar["high"])
                self.london_range_low = min(self.london_range_low, bar["low"])

    @property
    def pdh(self):
        return self._base.pdh

    @property
    def pdl(self):
        return self._base.pdl

    @property
    def asian_range_high(self):
        return self._base.asian_range_high

    @property
    def asian_range_low(self):
        return self._base.asian_range_low

    @property
    def swing_high(self):
        return self._base.swing_high

    @property
    def swing_low(self):
        return self._base.swing_low

    def get_levels(self, toggles) -> dict:
        candidates = {
            "pdh": self.pdh if toggles.pdh else None,
            "pdl": self.pdl if toggles.pdl else None,
            "asian_range_high": self.asian_range_high if toggles.asian_range_high else None,
            "asian_range_low": self.asian_range_low if toggles.asian_range_low else None,
            "london_range_high": self.london_range_high if toggles.london_range_high else None,
            "london_range_low": self.london_range_low if toggles.london_range_low else None,
            "swing_high": self.swing_high if toggles.swing_high else None,
            "swing_low": self.swing_low if toggles.swing_low else None,
        }
        return {k: v for k, v in candidates.items() if v is not None}
