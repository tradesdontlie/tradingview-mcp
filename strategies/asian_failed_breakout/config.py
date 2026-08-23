"""
All tunable parameters for the Asian failed-breakout strategy, grouped by
concern so setup-detection thresholds stay separate from risk management
(per the design brief) and every threshold can be swept in a later
optimization pass without touching engine code.

Defaults are order-of-magnitude reasonable for MGC1! (micro gold, tick_size
0.10, point_value $10/point — see ml/config/symbols.json) on a 1m/5m chart,
not fitted to anything. Treat them as a starting point for the backtest, not
a claim about what's optimal.
"""
from dataclasses import dataclass, field


@dataclass
class SessionConfig:
    """All times ET. Asian/NY windows can wrap past midnight (asian) or not
    (ny) — same wrap-aware convention as ml/features/session_context.py."""
    asian_session_start: str = "18:00"
    asian_session_end: str = "02:00"
    ny_session_start: str = "09:30"
    ny_session_end: str = "16:00"
    # Globex day rollover for "previous day" high/low — matches the 18:00 ET
    # convention already used throughout ml/features/*.
    globex_day_rollover_hour: int = 18
    # Setups may only be *initiated* (IDLE -> APPROACHING_LEVEL) inside the
    # Asian session window. An in-progress setup is allowed to resolve past
    # the window's end (bounded by its own max-bars timeouts below) unless
    # force_expire_at_session_end forces it closed at the boundary.
    force_expire_at_session_end: bool = True


@dataclass
class LevelToggles:
    pdh: bool = True
    pdl: bool = True
    prev_ny_high: bool = True
    prev_ny_low: bool = True
    swing_high: bool = True
    swing_low: bool = True
    asian_range_high: bool = True
    asian_range_low: bool = True


@dataclass
class SwingConfig:
    """Fractal swing detection on the 5m chart: a bar is a confirmed swing
    high once it's the max high within `lookback_bars` bars on both sides
    (confirmation therefore lags the actual peak by `lookback_bars` bars —
    unavoidable and correct, a swing isn't "significant" until price has
    moved away from it)."""
    lookback_bars_5m: int = 6
    min_prominence_points: float = 2.0
    max_tracked_swings: int = 3


@dataclass
class AsianRangeConfig:
    # Don't treat the current Asian session's own range high/low as a usable
    # level until at least this many 5m bars have closed since the session
    # opened — "once sufficiently established" from the brief, made concrete.
    min_bars_5m_before_use: int = 6


@dataclass
class ApproachConfig:
    # How close price must come to an enabled level to log APPROACHING_LEVEL
    # and lock it in as the active candidate for that side. Purely a
    # bookkeeping/logging predecessor to the break itself — a level can also
    # be broken directly on the bar that first reaches it.
    proximity_points: float = 1.5


@dataclass
class SweepConfig:
    # Minimum penetration beyond the level required to count as a real
    # break/sweep rather than a level being merely tagged.
    min_penetration_points: float = 0.3


@dataclass
class ObserveConfig:
    """Failed-breakdown/failed-breakout evidence, evaluated bar-by-bar after
    the break. Reclaim of the level (checked in the same window) is itself
    treated as the strongest possible evidence of failure and ends the
    OBSERVING state immediately — see engine.py."""
    max_bars_to_reclaim: int = 15
    # "Price stops making meaningful new lows/highs": once a bar fails to
    # extend the sweep extreme by at least min_new_extreme_progress_points
    # for this many consecutive bars, that counts as stalling.
    stall_bars_required: int = 2
    min_new_extreme_progress_points: float = 0.2
    # "Price quickly returns toward the broken level": close comes back
    # within this distance of the level (without yet fully reclaiming it).
    return_proximity_points: float = 1.0
    # Failed-breakdown evidence is satisfied by ANY of (stall detected) OR
    # (quick return detected) OR (reclaim itself) — not all required.


@dataclass
class AcceptanceConfig:
    """Positive evidence that price is ACCEPTING the break rather than
    failing it — checked every bar from LEVEL_BROKEN through LEVEL_RECLAIMED.
    Any one breach invalidates the setup outright (setup_status=INVALID),
    distinct from simply timing out (setup_status=EXPIRED)."""
    max_closes_beyond_level: int = 3
    max_distance_from_level_points: float = 3.0
    max_further_penetration_points: float = 2.0  # beyond the original sweep extreme


@dataclass
class ReclaimConfig:
    mode: str = "close"  # "close" or "wick"


@dataclass
class MA9Config:
    ema_period: int = 9
    max_bars_to_trigger: int = 15
    require_micro_structure_confirmation: bool = False
    micro_structure_lookback_bars: int = 10


@dataclass
class OrderFlowConfig:
    """No footprint/CVD/large-trade data source exists anywhere in this
    codebase yet (TradingView Desktop via CDP exposes OHLCV only — see
    ml/features/indicators.py's docstring). This layer is therefore fully
    optional and OFF by default; wire a real feed into
    engine.OrderFlowSnapshot before enabling it. It must only ever adjust a
    confidence score, never independently trigger a trade."""
    enabled: bool = False
    min_confidence_to_boost: float = 0.5


@dataclass
class RiskConfig:
    """Kept fully separate from setup-detection thresholds above, per the
    design brief, so risk can be re-tuned without touching what counts as a
    valid setup."""
    stop_buffer_points: float = 0.2
    max_risk_points: float = 6.0
    target_mode: str = "fixed_r"  # "fixed_r" or "fixed_price"
    target_r_multiple: float = 2.0
    target_price_points: float | None = None
    partial_r_multiple: float = 1.0
    partial_fraction: float = 0.5
    move_stop_to_breakeven_after_partial: bool = True
    runner_target_r_multiple: float = 3.0


@dataclass
class StrategyConfig:
    session: SessionConfig = field(default_factory=SessionConfig)
    levels: LevelToggles = field(default_factory=LevelToggles)
    swing: SwingConfig = field(default_factory=SwingConfig)
    asian_range: AsianRangeConfig = field(default_factory=AsianRangeConfig)
    approach: ApproachConfig = field(default_factory=ApproachConfig)
    sweep: SweepConfig = field(default_factory=SweepConfig)
    observe: ObserveConfig = field(default_factory=ObserveConfig)
    acceptance: AcceptanceConfig = field(default_factory=AcceptanceConfig)
    reclaim: ReclaimConfig = field(default_factory=ReclaimConfig)
    ma9: MA9Config = field(default_factory=MA9Config)
    order_flow: OrderFlowConfig = field(default_factory=OrderFlowConfig)
    risk: RiskConfig = field(default_factory=RiskConfig)
