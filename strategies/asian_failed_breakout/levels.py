"""
Tracks "important levels" incrementally from 5-minute bars, causally — each
level is only ever derived from 5m bars that have already CLOSED as of the
point the engine asks for it. No merge_asof, no batch precompute over the
whole frame; this class is fed one closed 5m bar at a time during the
backtest walk specifically so there's no way for a future bar to leak into
a level (see ml/features/build_dataset.py's history for why that class of
bug is worth being paranoid about).

Levels tracked:
  pdh / pdl                 — previous COMPLETE Globex day's high/low
                               (18:00 ET rollover, matching ml/features/*)
  prev_ny_high / prev_ny_low— previous COMPLETE NY session's high/low
  swing_high / swing_low    — most recent confirmed fractal swings (lagged
                               by swing.lookback_bars_5m bars by construction)
  asian_range_high / _low   — current Asian session's range so far, only
                               exposed once enough bars have accumulated
"""
import datetime as _dt
from dataclasses import dataclass

from .config import AsianRangeConfig, SessionConfig, SwingConfig


def _parse_hm(s: str) -> int:
    h, m = s.split(":")
    return int(h) * 60 + int(m)


def _in_window(tod_min: int, start_min: int, end_min: int) -> bool:
    if start_min <= end_min:
        return start_min <= tod_min < end_min
    return tod_min >= start_min or tod_min < end_min  # wraps past midnight


def _tod_minutes(et_ts) -> int:
    return et_ts.hour * 60 + et_ts.minute


def _globex_day_id(et_ts, rollover_hour: int):
    shifted = et_ts - _dt.timedelta(hours=rollover_hour)
    return shifted.date()


@dataclass
class _SwingPoint:
    price: float
    time: int


class LevelTracker:
    def __init__(self, session_cfg: SessionConfig, swing_cfg: SwingConfig, asian_cfg: AsianRangeConfig):
        self.session_cfg = session_cfg
        self.swing_cfg = swing_cfg
        self.asian_cfg = asian_cfg

        self._asian_start_min = _parse_hm(session_cfg.asian_session_start)
        self._asian_end_min = _parse_hm(session_cfg.asian_session_end)
        self._ny_start_min = _parse_hm(session_cfg.ny_session_start)
        self._ny_end_min = _parse_hm(session_cfg.ny_session_end)
        self._rollover_hour = session_cfg.globex_day_rollover_hour

        self._globex_day = None
        self._day_high = None
        self._day_low = None
        self.pdh = None
        self.pdl = None

        self._ny_date = None
        self._in_ny_session = False
        self._ny_high = None
        self._ny_low = None
        self.prev_ny_high = None
        self.prev_ny_low = None

        self._asian_day = None
        self._asian_bar_count = 0
        self.asian_range_high = None
        self.asian_range_low = None

        self._buf: list[dict] = []  # rolling 5m bar buffer for swing confirmation
        self._recent_swing_highs: list[_SwingPoint] = []
        self._recent_swing_lows: list[_SwingPoint] = []

    def update(self, bar: dict, et_ts) -> None:
        """bar: {time, open, high, low, close}. et_ts: tz-aware ET timestamp
        of this (already-closed) 5m bar."""
        self._update_globex_day(bar, et_ts)
        self._update_ny_session(bar, et_ts)
        self._update_asian_range(bar, et_ts)
        self._update_swings(bar, et_ts)

    # -- Globex-day PDH/PDL -------------------------------------------------
    def _update_globex_day(self, bar, et_ts):
        day = _globex_day_id(et_ts, self._rollover_hour)
        if self._globex_day is None:
            self._globex_day = day
            self._day_high, self._day_low = bar["high"], bar["low"]
            return
        if day != self._globex_day:
            self.pdh, self.pdl = self._day_high, self._day_low
            self._globex_day = day
            self._day_high, self._day_low = bar["high"], bar["low"]
        else:
            self._day_high = max(self._day_high, bar["high"])
            self._day_low = min(self._day_low, bar["low"])

    # -- Previous NY session high/low ---------------------------------------
    def _update_ny_session(self, bar, et_ts):
        tod = _tod_minutes(et_ts)
        in_session = _in_window(tod, self._ny_start_min, self._ny_end_min)
        date = et_ts.date()
        if in_session:
            if not self._in_ny_session or date != self._ny_date:
                self._ny_date = date
                self._ny_high, self._ny_low = bar["high"], bar["low"]
            else:
                self._ny_high = max(self._ny_high, bar["high"])
                self._ny_low = min(self._ny_low, bar["low"])
            self._in_ny_session = True
        else:
            if self._in_ny_session:
                self.prev_ny_high, self.prev_ny_low = self._ny_high, self._ny_low
            self._in_ny_session = False

    # -- Current Asian session range -----------------------------------------
    def _update_asian_range(self, bar, et_ts):
        tod = _tod_minutes(et_ts)
        day = _globex_day_id(et_ts, self._rollover_hour)
        if day != self._asian_day:
            self._asian_day = day
            self._asian_bar_count = 0
            self.asian_range_high = None
            self.asian_range_low = None
        if _in_window(tod, self._asian_start_min, self._asian_end_min):
            self._asian_bar_count += 1
            if self.asian_range_high is None:
                self.asian_range_high, self.asian_range_low = bar["high"], bar["low"]
            else:
                self.asian_range_high = max(self.asian_range_high, bar["high"])
                self.asian_range_low = min(self.asian_range_low, bar["low"])

    # -- Swing highs/lows (fractal, lagged by lookback_bars_5m) -------------
    def _update_swings(self, bar, et_ts):
        n = self.swing_cfg.lookback_bars_5m
        self._buf.append({"high": bar["high"], "low": bar["low"], "time": bar["time"]})
        window = 2 * n + 1
        if len(self._buf) < window:
            return
        if len(self._buf) > window:
            self._buf.pop(0)
        center = self._buf[n]
        highs = [b["high"] for b in self._buf]
        lows = [b["low"] for b in self._buf]
        edge_max = max(highs[0], highs[-1])
        edge_min = min(lows[0], lows[-1])

        if center["high"] == max(highs) and center["high"] - edge_max >= self.swing_cfg.min_prominence_points:
            self._recent_swing_highs.append(_SwingPoint(center["high"], center["time"]))
            self._recent_swing_highs = self._recent_swing_highs[-self.swing_cfg.max_tracked_swings:]
        if center["low"] == min(lows) and edge_min - center["low"] >= self.swing_cfg.min_prominence_points:
            self._recent_swing_lows.append(_SwingPoint(center["low"], center["time"]))
            self._recent_swing_lows = self._recent_swing_lows[-self.swing_cfg.max_tracked_swings:]

    @property
    def swing_high(self):
        return self._recent_swing_highs[-1].price if self._recent_swing_highs else None

    @property
    def swing_low(self):
        return self._recent_swing_lows[-1].price if self._recent_swing_lows else None

    def get_levels(self, toggles) -> dict[str, float]:
        """Only levels that are both enabled AND currently known (not None)
        — e.g. pdh is None until the first full Globex day has completed,
        asian_range_high/low are None until enough bars have accumulated."""
        asian_ready = self._asian_bar_count >= self.asian_cfg.min_bars_5m_before_use
        candidates = {
            "pdh": self.pdh if toggles.pdh else None,
            "pdl": self.pdl if toggles.pdl else None,
            "prev_ny_high": self.prev_ny_high if toggles.prev_ny_high else None,
            "prev_ny_low": self.prev_ny_low if toggles.prev_ny_low else None,
            "swing_high": self.swing_high if toggles.swing_high else None,
            "swing_low": self.swing_low if toggles.swing_low else None,
            "asian_range_high": self.asian_range_high if (toggles.asian_range_high and asian_ready) else None,
            "asian_range_low": self.asian_range_low if (toggles.asian_range_low and asian_ready) else None,
        }
        return {k: v for k, v in candidates.items() if v is not None}
