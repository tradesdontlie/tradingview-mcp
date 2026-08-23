"""
The state machine itself. One StrategyEngine tracks two independent
SetupCandidate trackers (long and short) plus a list of OpenTrade objects for
setups that have already triggered — direction is not mutually exclusive,
since "approaching an important low" and "approaching an important high" are
genuinely independent things that can both be true at once (e.g. price
chopping inside a range with both edges nearby).

Design principle from the brief: a level being broken is not itself a
signal. Nothing here fires an entry until BOTH the level has been reclaimed
AND the 1m EMA9 has been reclaimed/lost afterward. Order flow (engine
accepts an OrderFlowSnapshot per bar if the caller has one) can only ever
raise or lower a confidence score attached to the log record — it never
gates state transitions on its own, per the design brief's explicit "MUST
NOT be mandatory."
"""
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

from .config import StrategyConfig


class State(str, Enum):
    IDLE = "IDLE"
    APPROACHING_LEVEL = "APPROACHING_LEVEL"
    LEVEL_BROKEN = "LEVEL_BROKEN"
    OBSERVING = "OBSERVING"
    LEVEL_RECLAIMED = "LEVEL_RECLAIMED"
    WAITING_FOR_MA9 = "WAITING_FOR_MA9"
    ENTRY_TRIGGERED = "ENTRY_TRIGGERED"
    INVALID = "INVALID"
    EXPIRED = "EXPIRED"

_LONG_LEVEL_FIELDS = ("pdl", "prev_ny_low", "swing_low", "asian_range_low")
_SHORT_LEVEL_FIELDS = ("pdh", "prev_ny_high", "swing_high", "asian_range_high")


@dataclass
class OrderFlowSnapshot:
    """No real feed exists yet (see config.OrderFlowConfig's docstring) — all
    fields are Optional and default to unset. confidence_score() returns a
    neutral 0.5 (no adjustment) whenever the relevant inputs are missing,
    rather than fabricating a directional read from absent data."""
    bid_ask_footprint: Optional[float] = None
    cvd_delta: Optional[float] = None
    absorption_detected: Optional[bool] = None
    large_trade_bias: Optional[float] = None
    stacked_imbalance: Optional[bool] = None

    def confidence_score(self, direction: str) -> float:
        # Priority per the design brief: Price Response > Absorption > CVD >
        # Large Trades > Stacked Imbalance. Price response is already what
        # the state machine itself measures (reclaim + MA9), so this score
        # only layers the remaining four, highest-priority-available wins.
        if self.absorption_detected is not None:
            return 0.8 if self.absorption_detected else 0.3
        if self.cvd_delta is not None:
            favorable = (self.cvd_delta < 0) if direction == "long" else (self.cvd_delta > 0)
            return 0.7 if favorable else 0.35
        if self.large_trade_bias is not None:
            favorable = (self.large_trade_bias > 0) if direction == "long" else (self.large_trade_bias < 0)
            return 0.65 if favorable else 0.4
        if self.stacked_imbalance is not None:
            return 0.6 if self.stacked_imbalance else 0.45
        return 0.5


@dataclass
class SetupLogRecord:
    timestamp: int
    symbol: str
    session: str
    direction: str
    important_level_type: str
    important_level_price: float
    break_price: Optional[float] = None
    maximum_penetration: Optional[float] = None
    break_timestamp: Optional[int] = None
    reclaim_timestamp: Optional[int] = None
    ema9_trigger_timestamp: Optional[int] = None
    entry_price: Optional[float] = None
    sweep_extreme: Optional[float] = None
    stop_price: Optional[float] = None
    risk_distance: Optional[float] = None
    bars_between_break_and_reclaim: Optional[int] = None
    bars_between_reclaim_and_entry: Optional[int] = None
    order_flow_confirmation: Optional[float] = None
    setup_status: str = "PENDING"
    invalid_reason: Optional[str] = None
    exit_price: Optional[float] = None
    exit_timestamp: Optional[int] = None
    pnl_points: Optional[float] = None
    pnl_dollars: Optional[float] = None
    r_multiple: Optional[float] = None


@dataclass
class _Candidate:
    direction: str
    state: State = State.IDLE
    level_type: Optional[str] = None
    level_price: Optional[float] = None
    approach_time: Optional[int] = None
    break_price: Optional[float] = None
    break_time: Optional[int] = None
    break_extreme_initial: Optional[float] = None
    sweep_extreme: Optional[float] = None
    max_penetration: float = 0.0
    bars_since_break: int = 0
    bars_since_reclaim: int = 0
    closes_beyond_level_count: int = 0
    stall_bars: int = 0
    reclaim_time: Optional[int] = None

    def reset(self):
        self.__init__(direction=self.direction)


@dataclass
class OpenTrade:
    direction: str
    entry_price: float
    entry_time: int
    stop_price: float
    initial_risk: float
    partial_target_price: float
    final_target_price: float
    setup_record: SetupLogRecord
    partial_taken: bool = False
    remaining_fraction: float = 1.0
    realized_pnl_points: float = 0.0


class StrategyEngine:
    """Generic sweep/failed-breakout state machine — not actually tied to
    the Asian session. Which level names it looks for on the long vs. short
    side is injectable (default: the Asian strategy's own PDL/prev-NY-low/
    swing-low/asian-range-low set) so a different session's level tracker
    (e.g. the NY-session one, using opening-range levels instead) can reuse
    this exact engine rather than duplicating the whole state machine."""
    def __init__(self, cfg: StrategyConfig, symbol: str, point_value: float,
                 long_level_fields: tuple = _LONG_LEVEL_FIELDS, short_level_fields: tuple = _SHORT_LEVEL_FIELDS,
                 session_label: str = "asian"):
        self.cfg = cfg
        self.symbol = symbol
        self.point_value = point_value
        self.long_level_fields = long_level_fields
        self.short_level_fields = short_level_fields
        self.session_label = session_label
        self.candidates = {"long": _Candidate("long"), "short": _Candidate("short")}
        self.open_trades: list[OpenTrade] = []
        self._prev_close = None
        self._prev_ema9 = None
        self._micro_high_buf: list[float] = []
        self._micro_low_buf: list[float] = []

    def on_bar(self, bar: dict, ema9: float, levels: dict, in_active_session: bool,
               order_flow: Optional[OrderFlowSnapshot] = None) -> list[SetupLogRecord]:
        """bar: {time, open, high, low, close}. Returns any log records
        (rejected setups and/or completed trades) finalized on this bar."""
        records: list[SetupLogRecord] = []

        self._micro_high_buf.append(bar["high"])
        self._micro_low_buf.append(bar["low"])
        lookback = self.cfg.ma9.micro_structure_lookback_bars
        self._micro_high_buf = self._micro_high_buf[-lookback:]
        self._micro_low_buf = self._micro_low_buf[-lookback:]

        # trade management first — an open trade's exit doesn't depend on
        # the setup-detection state machine at all past entry
        still_open = []
        for trade in self.open_trades:
            rec = self._update_trade(trade, bar)
            if rec is not None:
                records.append(rec)
            else:
                still_open.append(trade)
        self.open_trades = still_open

        for direction in ("long", "short"):
            rec = self._step(direction, bar, ema9, levels, in_active_session, order_flow)
            if rec is not None:
                records.append(rec)

        self._prev_close = bar["close"]
        self._prev_ema9 = ema9
        return records

    # ------------------------------------------------------------------
    def _level_fields(self, direction: str):
        return self.long_level_fields if direction == "long" else self.short_level_fields

    def _step(self, direction: str, bar: dict, ema9: float, levels: dict,
              in_active_session: bool, order_flow: Optional[OrderFlowSnapshot]) -> Optional[SetupLogRecord]:
        c = self.candidates[direction]
        is_long = direction == "long"

        if (self.cfg.session.force_expire_at_session_end and not in_active_session
                and c.state not in (State.IDLE, State.ENTRY_TRIGGERED)):
            rec = self._finalize(c, State.EXPIRED, "SETUP_EXPIRED")
            c.reset()
            return rec

        if c.state == State.LEVEL_BROKEN:
            c.state = State.OBSERVING
        elif c.state == State.LEVEL_RECLAIMED:
            c.state = State.WAITING_FOR_MA9

        if c.state == State.IDLE:
            if not in_active_session:
                return None  # setups may only be initiated inside the Asian session window
            return self._try_start(c, direction, is_long, bar, levels)

        if c.state == State.APPROACHING_LEVEL:
            return self._check_approach(c, is_long, bar)

        if c.state == State.OBSERVING:
            return self._check_observing(c, is_long, bar)

        if c.state == State.WAITING_FOR_MA9:
            return self._check_ma9(c, direction, is_long, bar, ema9, order_flow)

        return None

    def _try_start(self, c: _Candidate, direction: str, is_long: bool, bar: dict, levels: dict):
        best_type, best_price, best_dist = None, None, None
        for name in self._level_fields(direction):
            price = levels.get(name)
            if price is None:
                continue
            dist = (bar["close"] - price) if is_long else (price - bar["close"])
            dist = abs(dist)
            if best_dist is None or dist < best_dist:
                best_type, best_price, best_dist = name, price, dist

        if best_type is None or best_dist > self.cfg.approach.proximity_points * 4:
            return None  # nothing nearby worth tracking yet

        c.level_type, c.level_price, c.approach_time = best_type, best_price, bar["time"]
        c.state = State.APPROACHING_LEVEL
        return self._check_approach(c, is_long, bar)

    def _check_approach(self, c: _Candidate, is_long: bool, bar: dict):
        pen = self.cfg.sweep.min_penetration_points
        broken = (bar["low"] < c.level_price - pen) if is_long else (bar["high"] > c.level_price + pen)
        if broken:
            extreme = bar["low"] if is_long else bar["high"]
            c.break_price = bar["close"]
            c.break_time = bar["time"]
            c.break_extreme_initial = extreme
            c.sweep_extreme = extreme
            c.max_penetration = abs(c.level_price - extreme)
            c.bars_since_break = 0
            c.state = State.LEVEL_BROKEN
            return None

        dist = abs(bar["close"] - c.level_price)
        if dist > self.cfg.approach.proximity_points * 2:
            c.reset()  # drifted away without breaking — give up on this candidate
        return None

    def _check_observing(self, c: _Candidate, is_long: bool, bar: dict):
        c.bars_since_break += 1
        obs = self.cfg.observe

        extreme_now = bar["low"] if is_long else bar["high"]
        pushed_further = (extreme_now < c.sweep_extreme) if is_long else (extreme_now > c.sweep_extreme)
        if pushed_further:
            progress = abs(c.sweep_extreme - extreme_now)
            c.sweep_extreme = extreme_now
            c.max_penetration = abs(c.level_price - c.sweep_extreme)
            c.stall_bars = 0 if progress >= obs.min_new_extreme_progress_points else c.stall_bars + 1
        else:
            c.stall_bars += 1

        if (is_long and bar["close"] < c.level_price) or (not is_long and bar["close"] > c.level_price):
            c.closes_beyond_level_count += 1

        acc = self.cfg.acceptance
        distance_from_level = abs(c.level_price - bar["close"]) if (
            (is_long and bar["close"] < c.level_price) or (not is_long and bar["close"] > c.level_price)
        ) else 0.0
        further_penetration = abs(c.break_extreme_initial - c.sweep_extreme)

        if (c.closes_beyond_level_count > acc.max_closes_beyond_level
                or distance_from_level > acc.max_distance_from_level_points
                or further_penetration > acc.max_further_penetration_points):
            reason = "INVALID_ACCEPTANCE_BELOW_LEVEL" if is_long else "INVALID_ACCEPTANCE_ABOVE_LEVEL"
            rec = self._finalize(c, State.INVALID, reason)
            c.reset()
            return rec

        if self.cfg.reclaim.mode == "close":
            reclaimed = (bar["close"] > c.level_price) if is_long else (bar["close"] < c.level_price)
        else:  # wick
            reclaimed = (bar["high"] > c.level_price) if is_long else (bar["low"] < c.level_price)

        if reclaimed:
            c.reclaim_time = bar["time"]
            c.bars_since_reclaim = 0
            c.state = State.LEVEL_RECLAIMED
            return None

        if c.bars_since_break >= obs.max_bars_to_reclaim:
            rec = self._finalize(c, State.EXPIRED, "NO_LEVEL_RECLAIM")
            c.reset()
            return rec
        return None

    def _check_ma9(self, c: _Candidate, direction: str, is_long: bool, bar: dict, ema9: float,
                    order_flow: Optional[OrderFlowSnapshot]):
        c.bars_since_reclaim += 1

        if (is_long and bar["close"] < c.level_price) or (not is_long and bar["close"] > c.level_price):
            c.closes_beyond_level_count += 1
            if c.closes_beyond_level_count > self.cfg.acceptance.max_closes_beyond_level:
                reason = "INVALID_ACCEPTANCE_BELOW_LEVEL" if is_long else "INVALID_ACCEPTANCE_ABOVE_LEVEL"
                rec = self._finalize(c, State.INVALID, reason)
                c.reset()
                return rec

        if self._prev_close is None or self._prev_ema9 is None:
            return None

        if is_long:
            ma9_condition = self._prev_close <= self._prev_ema9 and bar["close"] > ema9
        else:
            ma9_condition = self._prev_close >= self._prev_ema9 and bar["close"] < ema9

        if ma9_condition and self.cfg.ma9.require_micro_structure_confirmation:
            prior_highs = self._micro_high_buf[:-1]  # exclude current bar itself
            prior_lows = self._micro_low_buf[:-1]
            if is_long:
                recent_lower_high = max(prior_highs) if prior_highs else bar["close"]
                ma9_condition = bar["close"] > recent_lower_high
            else:
                recent_higher_low = min(prior_lows) if prior_lows else bar["close"]
                ma9_condition = bar["close"] < recent_higher_low

        if ma9_condition:
            entry_price = bar["close"]
            stop = (c.sweep_extreme - self.cfg.risk.stop_buffer_points) if is_long else \
                   (c.sweep_extreme + self.cfg.risk.stop_buffer_points)
            risk_distance = abs(entry_price - stop)

            if risk_distance <= 0 or risk_distance > self.cfg.risk.max_risk_points:
                rec = self._finalize(c, State.INVALID, "RISK_TOO_LARGE")
                rec.ema9_trigger_timestamp = bar["time"]
                rec.stop_price = stop
                rec.risk_distance = risk_distance
                c.reset()
                return rec

            rk = self.cfg.risk
            if rk.target_mode == "fixed_price" and rk.target_price_points is not None:
                final_target = entry_price + rk.target_price_points if is_long else entry_price - rk.target_price_points
            else:
                final_target = entry_price + rk.target_r_multiple * risk_distance if is_long else \
                                entry_price - rk.target_r_multiple * risk_distance
            partial_target = entry_price + rk.partial_r_multiple * risk_distance if is_long else \
                              entry_price - rk.partial_r_multiple * risk_distance

            record = SetupLogRecord(
                timestamp=c.approach_time, symbol=self.symbol, session=self.session_label,
                direction=direction, important_level_type=c.level_type, important_level_price=c.level_price,
                break_price=c.break_price, maximum_penetration=c.max_penetration,
                break_timestamp=c.break_time, reclaim_timestamp=c.reclaim_time,
                ema9_trigger_timestamp=bar["time"], entry_price=entry_price, sweep_extreme=c.sweep_extreme,
                stop_price=stop, risk_distance=risk_distance,
                bars_between_break_and_reclaim=self._bars_between(c.break_time, c.reclaim_time),
                bars_between_reclaim_and_entry=c.bars_since_reclaim,
                order_flow_confirmation=(order_flow.confidence_score(direction) if
                                          (self.cfg.order_flow.enabled and order_flow) else None),
                setup_status="OPEN",
            )
            self.open_trades.append(OpenTrade(
                direction=direction, entry_price=entry_price, entry_time=bar["time"], stop_price=stop,
                initial_risk=risk_distance, partial_target_price=partial_target, final_target_price=final_target,
                setup_record=record,
            ))
            c.reset()
            return None

        if c.bars_since_reclaim >= self.cfg.ma9.max_bars_to_trigger:
            rec = self._finalize(c, State.EXPIRED, "NO_MA9_CONFIRMATION")
            c.reset()
            return rec
        return None

    def _finalize(self, c: _Candidate, status: State, reason: str) -> SetupLogRecord:
        return SetupLogRecord(
            timestamp=c.approach_time, symbol=self.symbol, session=self.session_label,
            direction=c.direction, important_level_type=c.level_type or "", important_level_price=c.level_price or 0.0,
            break_price=c.break_price, maximum_penetration=c.max_penetration or None,
            break_timestamp=c.break_time, reclaim_timestamp=c.reclaim_time,
            sweep_extreme=c.sweep_extreme,
            bars_between_break_and_reclaim=self._bars_between(c.break_time, c.reclaim_time),
            setup_status=status.value, invalid_reason=reason,
        )

    @staticmethod
    def _bars_between(t1, t2, bar_seconds: int = 60):
        if t1 is None or t2 is None:
            return None
        return int(round((t2 - t1) / bar_seconds))

    # ------------------------------------------------------------------
    def _update_trade(self, trade: OpenTrade, bar: dict) -> Optional[SetupLogRecord]:
        is_long = trade.direction == "long"
        rk = self.cfg.risk

        def close_remaining(price, ts):
            total_pnl_points = self._blended_pnl(trade, price)
            rec = trade.setup_record
            rec.exit_price = price
            rec.exit_timestamp = ts
            rec.pnl_points = total_pnl_points
            rec.pnl_dollars = total_pnl_points * self.point_value
            rec.r_multiple = total_pnl_points / trade.initial_risk if trade.initial_risk else None
            rec.setup_status = "FILLED"
            return rec

        if not trade.partial_taken:
            stop_hit = bar["low"] <= trade.stop_price if is_long else bar["high"] >= trade.stop_price
            target_hit = bar["high"] >= trade.partial_target_price if is_long else bar["low"] <= trade.partial_target_price
            if stop_hit and target_hit:
                # same-bar ambiguity — conservative, assume stop first (same
                # convention as ml/labels/triple_barrier.py)
                return close_remaining(trade.stop_price, bar["time"])
            if stop_hit:
                return close_remaining(trade.stop_price, bar["time"])
            if target_hit:
                trade.partial_taken = True
                trade.remaining_fraction = 1.0 - rk.partial_fraction
                trade.realized_pnl_points = rk.partial_fraction * abs(trade.partial_target_price - trade.entry_price)
                if rk.move_stop_to_breakeven_after_partial:
                    trade.stop_price = trade.entry_price
                return None
        else:
            stop_hit = bar["low"] <= trade.stop_price if is_long else bar["high"] >= trade.stop_price
            target_hit = bar["high"] >= trade.final_target_price if is_long else bar["low"] <= trade.final_target_price
            if stop_hit and target_hit:
                return close_remaining(trade.stop_price, bar["time"])
            if stop_hit:
                return close_remaining(trade.stop_price, bar["time"])
            if target_hit:
                return close_remaining(trade.final_target_price, bar["time"])
        return None

    @staticmethod
    def _blended_pnl(trade: OpenTrade, final_price: float) -> float:
        """Per-unit points PnL. Before a partial: just entry-to-exit
        distance. After a partial: the already-locked-in partial leg
        (realized_pnl_points, fraction-weighted at the time it was taken)
        plus the remaining fraction's own entry-to-final-exit distance."""
        is_long = trade.direction == "long"
        full_leg = (final_price - trade.entry_price) if is_long else (trade.entry_price - final_price)
        if not trade.partial_taken:
            return full_leg
        return trade.realized_pnl_points + trade.remaining_fraction * full_leg

    def force_close_all(self, last_bar: dict) -> list[SetupLogRecord]:
        """Mark-to-market any still-open trades at the end of the backtest
        window — otherwise they'd silently vanish from the log."""
        records = []
        for trade in self.open_trades:
            price = last_bar["close"]
            total_pnl_points = self._blended_pnl(trade, price)
            rec = trade.setup_record
            rec.exit_price = price
            rec.exit_timestamp = last_bar["time"]
            rec.pnl_points = total_pnl_points
            rec.pnl_dollars = total_pnl_points * self.point_value
            rec.r_multiple = total_pnl_points / trade.initial_risk if trade.initial_risk else None
            rec.setup_status = "OPEN_AT_BACKTEST_END"
            records.append(rec)
        self.open_trades = []
        return records
