"""
All tunable parameters, grouped by concern. Defaults are order-of-magnitude
reasonable starting points, not fitted values — same convention as every
other strategy built this session.
"""
from dataclasses import dataclass, field


@dataclass
class SessionWindows:
    """All times ET. New CANDIDATES may only start inside these windows —
    an already-open trade is allowed to keep trailing past the window's end,
    since a real trend doesn't stop just because the window that spotted it
    closed."""
    asian_open_start: str = "20:00"
    asian_open_end: str = "21:00"
    premarket_handoff_start: str = "08:00"
    premarket_handoff_end: str = "09:30"
    ny_open_start: str = "09:30"
    ny_open_end: str = "10:30"
    opening_range_minutes: int = 15  # each window's own first-N-minutes range, used as one level source
    globex_day_rollover_hour: int = 18


@dataclass
class SessionToggles:
    asian_open_enabled: bool = True
    premarket_handoff_enabled: bool = True
    ny_open_enabled: bool = True


@dataclass
class BreakoutConfig:
    min_penetration_points: float = 0.3
    max_bars_to_acceptance: int = 20
    # Acceptance = the same kind of evidence the reversal strategies use to
    # REJECT a fade, used here as the entry trigger instead: enough closes
    # beyond the level, or enough distance travelled, without a reclaim.
    min_closes_beyond: int = 3
    min_acceptance_distance_points: float = 1.0
    require_ema9_alignment: bool = True


@dataclass
class TrailingStopConfig:
    atr_period: int = 14
    initial_stop_buffer_points: float = 0.2
    trail_atr_multiplier: float = 2.0
    # Don't start trailing immediately — an initial stop just beyond the
    # broken level stays in force until the trade is this many R favorable,
    # so a trend that's barely gotten going doesn't get stopped by a normal
    # pullback before it's proven anything.
    activate_trail_after_r: float = 1.0


@dataclass
class RiskConfig:
    max_risk_points: float = 10.0


@dataclass
class TrendBreakoutConfig:
    sessions: SessionWindows = field(default_factory=SessionWindows)
    session_toggles: SessionToggles = field(default_factory=SessionToggles)
    breakout: BreakoutConfig = field(default_factory=BreakoutConfig)
    trailing: TrailingStopConfig = field(default_factory=TrailingStopConfig)
    risk: RiskConfig = field(default_factory=RiskConfig)
