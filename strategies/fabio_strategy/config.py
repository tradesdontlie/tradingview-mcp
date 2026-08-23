"""
All tunable parameters, grouped by concern (per the brief's "keep risk
management separate from setup detection"). Every threshold here is a
starting point, not a fitted value — same convention as the other two
strategy families built this session.
"""
from dataclasses import dataclass, field


@dataclass
class SessionWindows:
    """All times ET. Asia wraps past midnight. ny_open_min_delay_minutes is
    the configurable "minimum delay after cash open before trading" from
    the brief's session-logic section."""
    asia_start: str = "18:00"
    asia_end: str = "02:00"
    london_start: str = "03:00"
    london_end: str = "08:00"
    ny_premarket_start: str = "04:00"
    ny_premarket_end: str = "09:29"
    ny_open_start: str = "09:30"
    ny_open_end: str = "11:30"
    ny_pm_start: str = "11:30"
    ny_pm_end: str = "16:00"
    ny_open_min_delay_minutes: int = 15
    globex_day_rollover_hour: int = 18


@dataclass
class SessionToggles:
    asia_enabled: bool = True
    london_enabled: bool = True
    ny_premarket_enabled: bool = True
    ny_open_enabled: bool = True
    ny_pm_enabled: bool = True


@dataclass
class MarketStateConfig:
    """5m-bar scoring model. Each of the 4 components is a simple boolean;
    bull_score/bear_score count how many hold. Reaching the threshold (out
    of 4) classifies the bar as directional; otherwise BALANCE. Not
    requiring textbook HH-HL/LH-LL structure per the brief — this scoring
    model works even when swing structure hasn't cleanly formed yet
    (pre-market, Asian session)."""
    ema9_slope_lookback_bars: int = 10
    return_lookback_bars: int = 10
    impulse_lookback_bars: int = 20
    directional_score_threshold: int = 3  # out of 4


@dataclass
class SwingConfig:
    lookback_bars_5m: int = 6
    min_prominence_points: float = 2.0
    max_tracked_swings: int = 3


@dataclass
class LocationToggles:
    """Which location filters count as valid "the pullback failed near a
    meaningful place" evidence for Setup A (trend-pullback continuation).
    hvn_volume_area stays permanently off — this repo has no volume-profile
    computation to back it; the toggle exists so the field is present when
    that's built, not to fake a value now."""
    ema9: bool = True
    ema20: bool = True
    vwap: bool = True
    prior_breakout_level: bool = True
    prior_swing: bool = True
    hvn_volume_area: bool = False
    location_tolerance_points: float = 1.0


@dataclass
class ImportantLevelToggles:
    """Locations Setup B (failed-breakout reversal) and the balance-extreme
    setup are allowed to fade. "Prior session high/low" per the brief is
    implemented concretely as PDH/PDL plus the named Asian/London ranges,
    not a generic catch-all."""
    pdh: bool = True
    pdl: bool = True
    asian_range_high: bool = True
    asian_range_low: bool = True
    london_range_high: bool = True
    london_range_low: bool = True
    swing_high: bool = True
    swing_low: bool = True


@dataclass
class PullbackConfig:
    max_bars_to_failure: int = 15
    stall_bars_required: int = 2
    min_new_extreme_progress_points: float = 0.2
    max_bars_to_ema9_trigger: int = 15
    max_pullback_depth_points: float = 999.0  # a pullback that travels this far without failing is abandoned, not chased


@dataclass
class BreakoutConfig:
    min_penetration_points: float = 0.3
    max_bars_to_reclaim: int = 15
    stall_bars_required: int = 2
    min_new_extreme_progress_points: float = 0.2
    # Separate from locations.location_tolerance_points (which governs Setup
    # A's EMA9/EMA20/VWAP pullback-location check) — important levels like
    # PDH/PDL sit at very different scales than an EMA touch, so sharing one
    # tolerance would force both to trade off against each other.
    approach_tolerance_points: float = 1.0


@dataclass
class AcceptanceConfig:
    """Mandatory per the brief — the breakout-acceptance filter, same shape
    as strategies/asian_failed_breakout's, reused here for both Setup B and
    the transition-resolution logic (a breakdown being "accepted" IS the
    bounce-failure event that confirms a new bearish direction)."""
    max_closes_beyond_level: int = 3
    max_distance_from_level_points: float = 3.0
    max_further_penetration_points: float = 2.0


@dataclass
class TransitionConfig:
    """Governs how long the strategy waits for a bounce/pullback to resolve
    (fail or hold) after a level breaks against the prevailing state before
    giving up and reverting to normal state scoring — prevents an
    unresolved transition from permanently locking out new setups."""
    max_bars_to_resolve: int = 40


@dataclass
class BalanceConfig:
    range_lookback_bars_5m: int = 24  # ~2h on 5m — rolling window defining "the balance range" while state==BALANCE
    min_range_points: float = 2.0
    target_mode: str = "midpoint"  # "midpoint" or "opposite_extreme"


@dataclass
class MA9Config:
    ema_period: int = 9
    require_micro_structure_confirmation: bool = False
    micro_structure_lookback_bars: int = 10
    # Setup B's own reclaim -> EMA9-trigger timeout — was previously
    # borrowing PullbackConfig.max_bars_to_ema9_trigger (Setup A's field),
    # which meant tuning one setup's timeout silently changed the other's.
    max_bars_to_trigger: int = 15


@dataclass
class OrderFlowConfig:
    """No footprint/CVD/large-trade/ATAS feed exists in this codebase (see
    the sweep strategies' identical note) — optional, off by default, and
    can only ever adjust a confidence score, never independently trigger."""
    enabled: bool = False


@dataclass
class RiskConfig:
    stop_buffer_points: float = 0.2
    max_risk_points: float = 10.0
    rr_ratio: float = 2.0  # 1:2 RR, per the explicit instruction this strategy was requested under
    partial_r_multiple: float = 1.0
    partial_fraction: float = 0.5
    move_stop_to_breakeven_after_partial: bool = True


@dataclass
class FabioConfig:
    sessions: SessionWindows = field(default_factory=SessionWindows)
    session_toggles: SessionToggles = field(default_factory=SessionToggles)
    market_state: MarketStateConfig = field(default_factory=MarketStateConfig)
    swing: SwingConfig = field(default_factory=SwingConfig)
    locations: LocationToggles = field(default_factory=LocationToggles)
    important_levels: ImportantLevelToggles = field(default_factory=ImportantLevelToggles)
    pullback: PullbackConfig = field(default_factory=PullbackConfig)
    breakout: BreakoutConfig = field(default_factory=BreakoutConfig)
    acceptance: AcceptanceConfig = field(default_factory=AcceptanceConfig)
    transition: TransitionConfig = field(default_factory=TransitionConfig)
    balance: BalanceConfig = field(default_factory=BalanceConfig)
    ma9: MA9Config = field(default_factory=MA9Config)
    order_flow: OrderFlowConfig = field(default_factory=OrderFlowConfig)
    risk: RiskConfig = field(default_factory=RiskConfig)
