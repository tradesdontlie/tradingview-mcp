"""
Core state machine. Three setup families, all gated by market state (never
"isolated indicator" triggers per the brief):

  Setup A (trend-pullback continuation) — only active in
  BULLISH_DIRECTIONAL (long) / BEARISH_DIRECTIONAL (short). First EMA9 loss
  in an uptrend starts a pullback watch, NOT a short (brief section 9) —
  _PullbackCandidate only ever trades WITH the prevailing state.

  Setup B (failed-breakout reversal) — fades important levels (PDH/PDL,
  Asian/London range, swing points), direction gated by state: only fade a
  broken LOW back up while state is bullish, only fade a broken HIGH back
  down while bearish. Reuses asian_failed_breakout's proven _Candidate/State
  machinery directly rather than re-deriving the same
  break->observe->reclaim->trigger logic.

  Balance-extreme fades reuse the exact same _ReversalCandidate mechanism,
  fed the rolling balance-range high/low instead of the fixed important-
  level list, active only while raw state == BALANCE — per the brief's
  section 16, ONLY range-extreme fades are considered in BALANCE, not the
  general important-level list, so the two level sources are mutually
  exclusive per bar (never both active at once).

TRANSITION: while a Setup-B candidate is fading a level break AGAINST the
current directional state (e.g. bullish state, support just broke), the
*effective* state reported for that bar is TRANSITION — this blocks new
Setup-A pullback-continuation entries in the old direction (brief section
15's "do not chase"). If that candidate's acceptance filter fires INVALID
(the break gets accepted, i.e. the bounce/pullback-recovery attempt failed)
the transition resolves to the OPPOSITE directional state for a bounded
window, unlocking Setup-A entries in the new direction. If the candidate
instead reaches ENTRY (reclaim + EMA9 held), the transition resolves back
to the original state — the trend survived the test.
"""
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

from ..asian_failed_breakout.engine import State as RevState
from ..asian_failed_breakout.engine import _Candidate as _ReversalCandidate
from ..ny_open_strategies.common import OpenTrade, RiskParams, TradeLogRecord, force_close as _common_force_close
from ..ny_open_strategies.common import update_open_trade as _common_update_trade

SETUP_TYPES = ("TREND_PULLBACK_LONG", "TREND_PULLBACK_SHORT", "FAILED_BREAKDOWN_LONG",
               "FAILED_BREAKOUT_SHORT", "BALANCE_EXTREME_LONG", "BALANCE_EXTREME_SHORT")

_LONG_IMPORTANT_LEVELS = ("pdl", "asian_range_low", "london_range_low", "swing_low")
_SHORT_IMPORTANT_LEVELS = ("pdh", "asian_range_high", "london_range_high", "swing_high")


class PBState(str, Enum):
    IDLE = "IDLE"
    WAITING_FOR_FAILURE = "WAITING_FOR_FAILURE"


@dataclass
class FabioLogRecord:
    timestamp: int
    symbol: str
    session: str
    market_state: str
    setup_type: str
    direction: str
    price: float
    vwap: Optional[float] = None
    ema9: Optional[float] = None
    ema20: Optional[float] = None
    important_level_type: Optional[str] = None
    important_level_price: Optional[float] = None
    pullback_start: Optional[int] = None
    pullback_extreme: Optional[float] = None
    breakout_extreme: Optional[float] = None
    level_broken: Optional[int] = None
    level_reclaimed: Optional[int] = None
    ema9_trigger: Optional[int] = None
    bars_in_setup: Optional[int] = None
    entry_price: Optional[float] = None
    stop_price: Optional[float] = None
    target_price: Optional[float] = None
    risk_distance: Optional[float] = None
    optional_cvd: Optional[float] = None
    optional_absorption: Optional[float] = None
    optional_large_trade: Optional[float] = None
    optional_stacked_imbalance: Optional[float] = None
    setup_status: str = "PENDING"
    rejection_reason: Optional[str] = None
    exit_price: Optional[float] = None
    exit_timestamp: Optional[int] = None
    pnl_points: Optional[float] = None
    pnl_dollars: Optional[float] = None
    r_multiple: Optional[float] = None
    mae_points: Optional[float] = None
    mfe_points: Optional[float] = None


@dataclass
class _PullbackCandidate:
    direction: str
    state: PBState = PBState.IDLE
    start_time: Optional[int] = None
    origin_extreme: Optional[float] = None  # extreme at pullback start — anchor for max_pullback_depth_points
    extreme: Optional[float] = None
    bars_since_start: int = 0
    stall_bars: int = 0
    location_confirmed: bool = False
    location_type: Optional[str] = None
    location_price: Optional[float] = None

    def reset(self):
        self.__init__(direction=self.direction)


@dataclass
class _TrackedTrade:
    trade: OpenTrade
    record: FabioLogRecord
    mae_points: float = 0.0
    mfe_points: float = 0.0


class FabioEngine:
    def __init__(self, cfg, symbol: str, point_value: float):
        self.cfg = cfg
        self.symbol = symbol
        self.point_value = point_value
        self.pullback = {"long": _PullbackCandidate("long"), "short": _PullbackCandidate("short")}
        self.reversal = {"long": _ReversalCandidate("long"), "short": _ReversalCandidate("short")}
        rk = cfg.risk
        self.risk_params = RiskParams(stop_buffer_points=rk.stop_buffer_points, max_risk_points=rk.max_risk_points,
                                       target_r_multiple=rk.rr_ratio, partial_r_multiple=rk.partial_r_multiple,
                                       partial_fraction=rk.partial_fraction,
                                       move_stop_to_breakeven_after_partial=rk.move_stop_to_breakeven_after_partial)
        self.open_trades: list[_TrackedTrade] = []
        self._prev_close = None
        self._prev_ema9 = None
        self._micro_high_buf: list[float] = []
        self._micro_low_buf: list[float] = []
        self._last_accepted_breakout_level: Optional[float] = None
        # transition override: while set, effective state overrides the raw
        # 5m-scored state for this many more bars (brief section 14) —
        # "TRANSITION" itself is reported when a reversal candidate is
        # actively fading a break against the prevailing state.
        self._transition_state: Optional[str] = None
        self._transition_bars_left: int = 0

    # ------------------------------------------------------------------
    def effective_state(self, raw_state: str) -> str:
        long_rev, short_rev = self.reversal["long"], self.reversal["short"]
        fading_against_bull = raw_state == "BULLISH_DIRECTIONAL" and long_rev.state not in (RevState.IDLE, RevState.APPROACHING_LEVEL)
        fading_against_bear = raw_state == "BEARISH_DIRECTIONAL" and short_rev.state not in (RevState.IDLE, RevState.APPROACHING_LEVEL)
        if fading_against_bull or fading_against_bear:
            return "TRANSITION"
        if self._transition_bars_left > 0:
            return self._transition_state
        return raw_state

    def on_bar(self, bar: dict, raw_state: str, vwap: float, ema9: float, ema20: Optional[float],
               important_levels: dict, balance_range: Optional[dict], session: str,
               tradeable: bool = True) -> list[FabioLogRecord]:
        """tradeable: False during a configured session's no-trade delay
        window (or outside any enabled session) — blocks NEW setup starts
        (IDLE -> in-progress) but never interrupts a candidate or open trade
        already in flight, same convention as the other two strategy
        families."""
        records: list[FabioLogRecord] = []
        rk = self.risk_params

        self._micro_high_buf.append(bar["high"])
        self._micro_low_buf.append(bar["low"])
        lookback = self.cfg.ma9.micro_structure_lookback_bars
        self._micro_high_buf = self._micro_high_buf[-lookback:]
        self._micro_low_buf = self._micro_low_buf[-lookback:]

        if self._transition_bars_left > 0:
            self._transition_bars_left -= 1

        # --- trade management -------------------------------------------------
        still_open = []
        for t in self.open_trades:
            is_long = t.trade.direction == "long"
            adverse = (t.trade.entry_price - bar["low"]) if is_long else (bar["high"] - t.trade.entry_price)
            favorable = (bar["high"] - t.trade.entry_price) if is_long else (t.trade.entry_price - bar["low"])
            t.mae_points = max(t.mae_points, adverse)
            t.mfe_points = max(t.mfe_points, favorable)
            rec = _common_update_trade(t.trade, bar, rk, self.point_value)
            if rec is not None:
                self._finalize_trade(t, rec)  # copies exit/pnl/R plus t.mae_points/t.mfe_points onto t.record
                records.append(t.record)
            else:
                still_open.append(t)
        self.open_trades = still_open

        # --- Setup B / balance-extreme reversal candidates ---------------------
        if raw_state == "BALANCE" and balance_range:
            levels_for_reversal = {"balance_range_low": balance_range.get("low"),
                                    "balance_range_high": balance_range.get("high")}
            long_fields, short_fields = ("balance_range_low",), ("balance_range_high",)
        else:
            levels_for_reversal = important_levels
            long_fields, short_fields = _LONG_IMPORTANT_LEVELS, _SHORT_IMPORTANT_LEVELS

        for direction, fields in (("long", long_fields), ("short", short_fields)):
            allowed = (
                (raw_state == "BALANCE") or
                (direction == "long" and raw_state in ("BULLISH_DIRECTIONAL",)) or
                (direction == "short" and raw_state in ("BEARISH_DIRECTIONAL",)) or
                # a candidate already in flight keeps running even if state
                # just flipped — it's the mechanism that RESOLVES the flip
                (self.reversal[direction].state != RevState.IDLE)
            )
            rec = self._step_reversal(direction, allowed, tradeable, fields, levels_for_reversal, bar, ema9, session)
            if rec is not None:
                records.append(rec)
                if rec.setup_status == "INVALID" and rec.rejection_reason == "BREAKOUT_ACCEPTED":
                    # the break got accepted -> transition resolves to the
                    # OPPOSITE of whatever this candidate was defending
                    self._transition_state = "BEARISH_DIRECTIONAL" if direction == "long" else "BULLISH_DIRECTIONAL"
                    self._transition_bars_left = self.cfg.transition.max_bars_to_resolve

        # --- Setup A pullback continuation -------------------------------------
        # Computed AFTER the Setup-B loop above (not before it) so a level
        # break that happens on THIS bar is reflected in the TRANSITION gate
        # immediately, rather than one bar late — otherwise Setup A could
        # start a new pullback-continuation watch on the very bar structure
        # broke, exactly the "chasing" the brief's TRANSITION state exists
        # to prevent.
        state = self.effective_state(raw_state)
        for direction in ("long", "short"):
            active_state = "BULLISH_DIRECTIONAL" if direction == "long" else "BEARISH_DIRECTIONAL"
            allowed = state == active_state
            if not allowed:
                self.pullback[direction].reset()
                continue
            rec = self._step_pullback(direction, bar, ema9, ema20, vwap, important_levels, session, tradeable)
            if rec is not None:
                records.append(rec)

        self._prev_close = bar["close"]
        self._prev_ema9 = ema9
        return records

    # ------------------------------------------------------------------
    def _finalize_trade(self, t: _TrackedTrade, generic_rec) -> None:
        r = t.record
        r.exit_price = generic_rec.exit_price
        r.exit_timestamp = generic_rec.exit_time
        r.pnl_points = generic_rec.pnl_points
        r.pnl_dollars = generic_rec.pnl_dollars
        r.r_multiple = generic_rec.r_multiple
        r.setup_status = generic_rec.status
        r.mae_points = t.mae_points
        r.mfe_points = t.mfe_points

    def force_close_all(self, last_bar: dict) -> list[FabioLogRecord]:
        out = []
        for t in self.open_trades:
            generic = _common_force_close(t.trade, last_bar, self.point_value)
            self._finalize_trade(t, generic)
            out.append(t.record)
        self.open_trades = []
        return out

    def _open_trade(self, direction: str, setup_type: str, entry_price: float, stop: float, bar: dict,
                     record_kwargs: dict) -> None:
        risk_distance = abs(entry_price - stop)
        rk = self.cfg.risk
        rr = rk.rr_ratio
        is_long = direction == "long"
        partial_target = entry_price + rk.partial_r_multiple * risk_distance if is_long else \
                          entry_price - rk.partial_r_multiple * risk_distance
        final_target = entry_price + rr * risk_distance if is_long else entry_price - rr * risk_distance

        record = FabioLogRecord(symbol=self.symbol, direction=direction, setup_type=setup_type,
                                 entry_price=entry_price, stop_price=stop, target_price=final_target,
                                 risk_distance=risk_distance, setup_status="OPEN", **record_kwargs)
        # OpenTrade.record is mutated directly by the shared update_open_trade/
        # force_close in ny_open_strategies.common — it needs a real
        # TradeLogRecord (not our FabioLogRecord, different schema), used
        # only as scratch space; _finalize_trade copies the fields we care
        # about onto `record` (our actual FabioLogRecord) when the trade closes.
        placeholder = TradeLogRecord(strategy="fabio", symbol=self.symbol, direction=direction, signal_time=bar["time"])
        trade = OpenTrade(direction=direction, entry_price=entry_price, entry_time=bar["time"], stop_price=stop,
                           initial_risk=risk_distance, partial_target_price=partial_target,
                           final_target_price=final_target, record=placeholder)
        self.open_trades.append(_TrackedTrade(trade=trade, record=record))

    # ------------------------------------------------------------------
    @staticmethod
    def _is_balance_level(level_type: Optional[str]) -> bool:
        """Whether a candidate is a balance-range fade rather than an
        important-level reversal — derived from the candidate's OWN
        level_type (set once, at candidate creation) rather than recomputed
        from the current bar's raw_state. A candidate started while
        raw_state=="BALANCE" stays a balance-extreme fade for its whole
        lifetime even if raw_state later flips to directional while it's
        still in flight — otherwise it can flip labels (and, worse, leak a
        balance-range price into Setup A's prior_breakout_level filter as if
        it were a genuinely accepted important-level breakout)."""
        return level_type is not None and level_type.startswith("balance_range")

    def _step_reversal(self, direction: str, allowed: bool, tradeable: bool, level_fields: tuple, levels: dict,
                        bar: dict, ema9: float, session: str) -> Optional[FabioLogRecord]:
        c = self.reversal[direction]
        is_long = direction == "long"
        cfg = self.cfg

        if c.state == RevState.IDLE and (not allowed or not tradeable):
            return None

        if c.state == RevState.LEVEL_BROKEN:
            c.state = RevState.OBSERVING
        elif c.state == RevState.LEVEL_RECLAIMED:
            c.state = RevState.WAITING_FOR_MA9

        if c.state == RevState.IDLE:
            best_type, best_price, best_dist = None, None, None
            for name in level_fields:
                price = levels.get(name)
                if price is None:
                    continue
                dist = abs(bar["close"] - price)
                if best_dist is None or dist < best_dist:
                    best_type, best_price, best_dist = name, price, dist
            if best_type is None or best_dist > cfg.breakout.approach_tolerance_points * 4:
                return None
            c.level_type, c.level_price, c.approach_time = best_type, best_price, bar["time"]
            c.state = RevState.APPROACHING_LEVEL
            # fall through to evaluate the break on this same bar

        if c.state == RevState.APPROACHING_LEVEL:
            pen = cfg.breakout.min_penetration_points
            broken = (bar["low"] < c.level_price - pen) if is_long else (bar["high"] > c.level_price + pen)
            if broken:
                extreme = bar["low"] if is_long else bar["high"]
                c.break_price, c.break_time = bar["close"], bar["time"]
                c.break_extreme_initial = extreme
                c.sweep_extreme = extreme
                c.max_penetration = abs(c.level_price - extreme)
                c.bars_since_break = 0
                c.state = RevState.LEVEL_BROKEN
                return None
            if abs(bar["close"] - c.level_price) > cfg.breakout.approach_tolerance_points * 2:
                c.reset()
            return None

        if c.state == RevState.OBSERVING:
            c.bars_since_break += 1
            extreme_now = bar["low"] if is_long else bar["high"]
            pushed = (extreme_now < c.sweep_extreme) if is_long else (extreme_now > c.sweep_extreme)
            if pushed:
                progress = abs(c.sweep_extreme - extreme_now)
                c.sweep_extreme = extreme_now
                c.max_penetration = abs(c.level_price - c.sweep_extreme)
                c.stall_bars = 0 if progress >= cfg.breakout.min_new_extreme_progress_points else c.stall_bars + 1
            else:
                c.stall_bars += 1

            beyond = (bar["close"] < c.level_price) if is_long else (bar["close"] > c.level_price)
            if beyond:
                c.closes_beyond_level_count += 1
            distance = abs(c.level_price - bar["close"]) if beyond else 0.0
            further = abs(c.break_extreme_initial - c.sweep_extreme)
            acc = cfg.acceptance
            if (c.closes_beyond_level_count > acc.max_closes_beyond_level
                    or distance > acc.max_distance_from_level_points
                    or further > acc.max_further_penetration_points):
                rec = self._finalize_reversal(c, "INVALID", "BREAKOUT_ACCEPTED", direction, session)
                c.reset()
                return rec

            reclaimed = (bar["close"] > c.level_price) if is_long else (bar["close"] < c.level_price)
            if reclaimed:
                c.reclaim_time = bar["time"]
                c.bars_since_reclaim = 0
                c.state = RevState.LEVEL_RECLAIMED
                return None
            if c.bars_since_break >= cfg.breakout.max_bars_to_reclaim:
                rec = self._finalize_reversal(c, "EXPIRED", "SETUP_EXPIRED", direction, session)
                c.reset()
                return rec
            return None

        if c.state == RevState.WAITING_FOR_MA9:
            c.bars_since_reclaim += 1
            beyond = (bar["close"] < c.level_price) if is_long else (bar["close"] > c.level_price)
            if beyond:
                c.closes_beyond_level_count += 1
                if c.closes_beyond_level_count > cfg.acceptance.max_closes_beyond_level:
                    rec = self._finalize_reversal(c, "INVALID", "BREAKOUT_ACCEPTED", direction, session)
                    c.reset()
                    return rec

            if self._prev_close is None or self._prev_ema9 is None:
                return None
            trigger = (self._prev_close <= self._prev_ema9 and bar["close"] > ema9) if is_long else \
                      (self._prev_close >= self._prev_ema9 and bar["close"] < ema9)
            if trigger:
                is_balance = self._is_balance_level(c.level_type)
                entry_price = bar["close"]
                stop = (c.sweep_extreme - cfg.risk.stop_buffer_points) if is_long else \
                       (c.sweep_extreme + cfg.risk.stop_buffer_points)
                risk_distance = abs(entry_price - stop)
                if risk_distance <= 0 or risk_distance > cfg.risk.max_risk_points:
                    rec = self._finalize_reversal(c, "INVALID", "RISK_TOO_LARGE", direction, session)
                    c.reset()
                    return rec
                setup_type = ("BALANCE_EXTREME_LONG" if is_balance else "FAILED_BREAKDOWN_LONG") if is_long else \
                             ("BALANCE_EXTREME_SHORT" if is_balance else "FAILED_BREAKOUT_SHORT")
                self._open_trade(direction, setup_type, entry_price, stop, bar, dict(
                    timestamp=c.approach_time, session=session, market_state=("BALANCE" if is_balance else "TRANSITION"),
                    price=entry_price, important_level_type=c.level_type, important_level_price=c.level_price,
                    breakout_extreme=c.sweep_extreme, level_broken=c.break_time, level_reclaimed=c.reclaim_time,
                    ema9_trigger=bar["time"], ema9=ema9,
                    bars_in_setup=self._bars_between(c.approach_time, bar["time"]),
                ))
                if not is_balance:
                    # the level held (reclaim + EMA9 confirmed) -> the trend
                    # survived the test; clear any pending transition and
                    # remember this level as the new "prior breakout level"
                    # location filter for Setup A pullbacks.
                    self._last_accepted_breakout_level = c.level_price
                    self._transition_bars_left = 0
                c.reset()
                return None
            if c.bars_since_reclaim >= cfg.ma9.max_bars_to_trigger:
                rec = self._finalize_reversal(c, "EXPIRED", "SETUP_EXPIRED", direction, session)
                c.reset()
                return rec
            return None
        return None

    def _finalize_reversal(self, c: _ReversalCandidate, status: str, reason: str, direction: str,
                            session: str) -> FabioLogRecord:
        is_long = direction == "long"
        is_balance = self._is_balance_level(c.level_type)
        setup_type = ("BALANCE_EXTREME_LONG" if is_balance else "FAILED_BREAKDOWN_LONG") if is_long else \
                     ("BALANCE_EXTREME_SHORT" if is_balance else "FAILED_BREAKOUT_SHORT")
        return FabioLogRecord(
            timestamp=c.approach_time, symbol=self.symbol, session=session,
            market_state=("BALANCE" if is_balance else "TRANSITION"), setup_type=setup_type, direction=direction,
            price=c.level_price, important_level_type=c.level_type, important_level_price=c.level_price,
            breakout_extreme=c.sweep_extreme, level_broken=c.break_time, level_reclaimed=c.reclaim_time,
            bars_in_setup=self._bars_between(c.approach_time, c.break_time),
            setup_status=status, rejection_reason=reason,
        )

    # ------------------------------------------------------------------
    def _step_pullback(self, direction: str, bar: dict, ema9: float, ema20: Optional[float], vwap: float,
                        important_levels: dict, session: str, tradeable: bool) -> Optional[FabioLogRecord]:
        c = self.pullback[direction]
        is_long = direction == "long"
        cfg = self.cfg

        if c.state == PBState.IDLE:
            if not tradeable or self._prev_close is None or self._prev_ema9 is None:
                return None
            crossed = (self._prev_close >= self._prev_ema9 and bar["close"] < ema9) if is_long else \
                      (self._prev_close <= self._prev_ema9 and bar["close"] > ema9)
            if crossed:
                c.state = PBState.WAITING_FOR_FAILURE
                c.start_time = bar["time"]
                c.origin_extreme = c.extreme = bar["low"] if is_long else bar["high"]
                c.bars_since_start = 0
                c.location_confirmed, c.location_type, c.location_price = False, None, None
            return None

        # WAITING_FOR_FAILURE
        c.bars_since_start += 1
        extreme_now = bar["low"] if is_long else bar["high"]
        pushed = (extreme_now < c.extreme) if is_long else (extreme_now > c.extreme)
        if pushed:
            progress = abs(c.extreme - extreme_now)
            c.extreme = extreme_now
            c.stall_bars = 0 if progress >= cfg.pullback.min_new_extreme_progress_points else c.stall_bars + 1
        else:
            c.stall_bars += 1

        if not c.location_confirmed:
            loc_type, loc_price = self._check_location(c.extreme, ema9, ema20, vwap, important_levels)
            if loc_type:
                c.location_confirmed, c.location_type, c.location_price = True, loc_type, loc_price

        depth = abs(c.extreme - c.origin_extreme)
        if (c.bars_since_start >= cfg.pullback.max_bars_to_failure
                or depth > cfg.pullback.max_pullback_depth_points):
            rec = FabioLogRecord(timestamp=c.start_time, symbol=self.symbol, session=session,
                                  market_state="BULLISH_DIRECTIONAL" if is_long else "BEARISH_DIRECTIONAL",
                                  setup_type="TREND_PULLBACK_LONG" if is_long else "TREND_PULLBACK_SHORT",
                                  direction=direction, price=bar["close"], pullback_start=c.start_time,
                                  pullback_extreme=c.extreme, bars_in_setup=c.bars_since_start,
                                  setup_status="EXPIRED", rejection_reason="SETUP_EXPIRED")
            c.reset()
            return rec

        if self._prev_close is None or self._prev_ema9 is None:
            return None
        trigger = (self._prev_close <= self._prev_ema9 and bar["close"] > ema9) if is_long else \
                  (self._prev_close >= self._prev_ema9 and bar["close"] < ema9)
        if trigger and cfg.ma9.require_micro_structure_confirmation:
            # Optional confirmation per the brief section 7: current_close >
            # recent_micro_lower_high (long) / < recent_micro_higher_low
            # (short) — using bars strictly before this trigger bar so the
            # trigger bar's own high/low can't confirm itself.
            prior_highs = self._micro_high_buf[:-1]
            prior_lows = self._micro_low_buf[:-1]
            if is_long:
                trigger = bool(prior_highs) and bar["close"] > max(prior_highs)
            else:
                trigger = bool(prior_lows) and bar["close"] < min(prior_lows)
        if not trigger:
            return None

        if not c.location_confirmed:
            rec = FabioLogRecord(timestamp=c.start_time, symbol=self.symbol, session=session,
                                  market_state="BULLISH_DIRECTIONAL" if is_long else "BEARISH_DIRECTIONAL",
                                  setup_type="TREND_PULLBACK_LONG" if is_long else "TREND_PULLBACK_SHORT",
                                  direction=direction, price=bar["close"], pullback_start=c.start_time,
                                  pullback_extreme=c.extreme, bars_in_setup=c.bars_since_start,
                                  setup_status="INVALID", rejection_reason="NO_IMPORTANT_LOCATION")
            c.reset()
            return rec

        entry_price = bar["close"]
        stop = (c.extreme - cfg.risk.stop_buffer_points) if is_long else (c.extreme + cfg.risk.stop_buffer_points)
        risk_distance = abs(entry_price - stop)
        setup_type = "TREND_PULLBACK_LONG" if is_long else "TREND_PULLBACK_SHORT"
        if risk_distance <= 0 or risk_distance > cfg.risk.max_risk_points:
            rec = FabioLogRecord(timestamp=c.start_time, symbol=self.symbol, session=session,
                                  market_state="BULLISH_DIRECTIONAL" if is_long else "BEARISH_DIRECTIONAL",
                                  setup_type=setup_type, direction=direction, price=entry_price,
                                  pullback_start=c.start_time, pullback_extreme=c.extreme,
                                  important_level_type=c.location_type, important_level_price=c.location_price,
                                  stop_price=stop, risk_distance=risk_distance, bars_in_setup=c.bars_since_start,
                                  setup_status="INVALID", rejection_reason="RISK_TOO_LARGE")
            c.reset()
            return rec

        self._open_trade(direction, setup_type, entry_price, stop, bar, dict(
            timestamp=c.start_time, session=session,
            market_state="BULLISH_DIRECTIONAL" if is_long else "BEARISH_DIRECTIONAL",
            price=entry_price, important_level_type=c.location_type, important_level_price=c.location_price,
            pullback_start=c.start_time, pullback_extreme=c.extreme, ema9_trigger=bar["time"], ema9=ema9,
            vwap=vwap, ema20=ema20, bars_in_setup=c.bars_since_start,
        ))
        c.reset()
        return None

    def _check_location(self, price: float, ema9: float, ema20: Optional[float], vwap: float,
                         important_levels: Optional[dict] = None):
        tol = self.cfg.locations.location_tolerance_points
        loc = self.cfg.locations
        if loc.ema9 and abs(price - ema9) <= tol:
            return "ema9", ema9
        if loc.ema20 and ema20 is not None and abs(price - ema20) <= tol:
            return "ema20", ema20
        if loc.vwap and abs(price - vwap) <= tol:
            return "vwap", vwap
        if loc.prior_breakout_level and self._last_accepted_breakout_level is not None \
                and abs(price - self._last_accepted_breakout_level) <= tol:
            return "prior_breakout_level", self._last_accepted_breakout_level
        if loc.prior_swing and important_levels:
            # a long pullback's extreme is a low, so a nearby swing_low is
            # the relevant reference; a short pullback's extreme is a high,
            # checked against swing_high.
            for name in ("swing_low", "swing_high"):
                swing_price = important_levels.get(name)
                if swing_price is not None and abs(price - swing_price) <= tol:
                    return name, swing_price
        return None, None

    @staticmethod
    def _bars_between(t1, t2, bar_seconds: int = 60):
        if t1 is None or t2 is None:
            return None
        return int(round((t2 - t1) / bar_seconds))
