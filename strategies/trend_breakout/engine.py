"""
Core state machine. One candidate per direction:

  IDLE -> APPROACHING -> WATCHING_ACCEPTANCE -> (ENTRY -> IN_POSITION) | INVALID | EXPIRED

Long = breaking ABOVE a resistance level (PDH or the active window's opening
range high) and continuing; short = breaking BELOW a support level (PDL or
opening range low) and continuing. A level break alone is never a signal —
WATCHING_ACCEPTANCE requires the same kind of evidence the reversal
strategies elsewhere in strategies/ use to REJECT a fade (sustained closes
beyond the level, real distance travelled, no reclaim) before it counts as
a real trend, not a fake-out.

Once IN_POSITION, there is no fixed target — only an initial stop (just
beyond the broken level) that switches to an ATR-based trailing stop once
the trade is favorable enough to have proven itself. This is deliberate:
the whole point of this strategy is to not cap a genuinely large move at a
small fixed multiple.
"""
from dataclasses import dataclass
from enum import Enum
from typing import Optional


class State(str, Enum):
    IDLE = "IDLE"
    APPROACHING = "APPROACHING"
    BROKEN = "BROKEN"
    WATCHING_ACCEPTANCE = "WATCHING_ACCEPTANCE"


_LONG_LEVEL_FIELDS = ("pdh", "opening_range_high")
_SHORT_LEVEL_FIELDS = ("pdl", "opening_range_low")


@dataclass
class TrendBreakoutRecord:
    timestamp: int
    symbol: str
    session: str
    direction: str
    level_type: str
    level_price: float
    break_price: Optional[float] = None
    break_timestamp: Optional[int] = None
    bars_to_acceptance: Optional[int] = None
    entry_price: Optional[float] = None
    entry_timestamp: Optional[int] = None
    initial_stop: Optional[float] = None
    risk_distance: Optional[float] = None
    setup_status: str = "PENDING"
    rejection_reason: Optional[str] = None
    exit_price: Optional[float] = None
    exit_timestamp: Optional[int] = None
    bars_held: Optional[int] = None
    pnl_points: Optional[float] = None
    pnl_dollars: Optional[float] = None
    r_multiple: Optional[float] = None
    mae_points: Optional[float] = None
    mfe_points: Optional[float] = None


@dataclass
class _Candidate:
    direction: str
    state: State = State.IDLE
    level_type: Optional[str] = None
    level_price: Optional[float] = None
    approach_time: Optional[int] = None
    break_price: Optional[float] = None
    break_time: Optional[int] = None
    bars_since_break: int = 0
    closes_beyond_count: int = 0
    max_distance: float = 0.0

    def reset(self):
        self.__init__(direction=self.direction)


@dataclass
class _OpenTrade:
    direction: str
    entry_price: float
    entry_time: int
    initial_stop: float
    current_stop: float
    initial_risk: float
    record: TrendBreakoutRecord
    trail_active: bool = False
    extreme_since_entry: float = 0.0
    mae_points: float = 0.0
    mfe_points: float = 0.0


class TrendBreakoutEngine:
    def __init__(self, cfg, symbol: str, point_value: float):
        self.cfg = cfg
        self.symbol = symbol
        self.point_value = point_value
        self.candidates = {"long": _Candidate("long"), "short": _Candidate("short")}
        self.open_trades: list[_OpenTrade] = []
        self._prev_close = None
        self._prev_ema9 = None

    def on_bar(self, bar: dict, ema9: float, atr: Optional[float], levels: dict, session: str,
               tradeable: bool) -> list[TrendBreakoutRecord]:
        records: list[TrendBreakoutRecord] = []

        still_open = []
        for t in self.open_trades:
            rec = self._update_trade(t, bar, atr)
            if rec is not None:
                records.append(rec)
            else:
                still_open.append(t)
        self.open_trades = still_open

        for direction, fields in (("long", _LONG_LEVEL_FIELDS), ("short", _SHORT_LEVEL_FIELDS)):
            rec = self._step(direction, fields, levels, bar, ema9, session, tradeable)
            if rec is not None:
                records.append(rec)

        self._prev_close = bar["close"]
        self._prev_ema9 = ema9
        return records

    # ------------------------------------------------------------------
    def _step(self, direction: str, level_fields: tuple, levels: dict, bar: dict, ema9: float,
              session: str, tradeable: bool) -> Optional[TrendBreakoutRecord]:
        c = self.candidates[direction]
        is_long = direction == "long"
        cfg = self.cfg

        if c.state == State.IDLE and not tradeable:
            return None

        if c.state == State.BROKEN:
            c.state = State.WATCHING_ACCEPTANCE

        if c.state == State.IDLE:
            best_type, best_price, best_dist = None, None, None
            for name in level_fields:
                price = levels.get(name)
                if price is None:
                    continue
                dist = abs(bar["close"] - price)
                if best_dist is None or dist < best_dist:
                    best_type, best_price, best_dist = name, price, dist
            if best_type is None or best_dist > cfg.breakout.min_acceptance_distance_points * 8:
                return None
            c.level_type, c.level_price, c.approach_time = best_type, best_price, bar["time"]
            c.state = State.APPROACHING
            # fall through to check the break on this same bar

        if c.state == State.APPROACHING:
            pen = cfg.breakout.min_penetration_points
            broken = (bar["high"] > c.level_price + pen) if is_long else (bar["low"] < c.level_price - pen)
            if broken:
                c.break_price, c.break_time = bar["close"], bar["time"]
                c.bars_since_break = 0
                c.closes_beyond_count = 0
                c.max_distance = 0.0
                c.state = State.BROKEN
                return None
            if abs(bar["close"] - c.level_price) > cfg.breakout.min_acceptance_distance_points * 4:
                c.reset()  # drifted away without breaking — not this level's moment
            return None

        if c.state == State.WATCHING_ACCEPTANCE:
            c.bars_since_break += 1
            beyond = (bar["close"] > c.level_price) if is_long else (bar["close"] < c.level_price)
            if beyond:
                c.closes_beyond_count += 1
                dist = abs(bar["close"] - c.level_price)
                c.max_distance = max(c.max_distance, dist)

            reclaimed = (bar["close"] < c.level_price) if is_long else (bar["close"] > c.level_price)
            if reclaimed:
                # failed breakout — price came right back through the level,
                # this was a fake-out, not a real trend. Same evidence the
                # reversal strategies would treat as "reclaim" (their
                # SUCCESS case) is this strategy's failure case.
                rec = self._finalize(c, "INVALID", "FAILED_BREAKOUT_RECLAIMED", direction, session)
                c.reset()
                return rec

            accepted = (c.closes_beyond_count >= cfg.breakout.min_closes_beyond
                        or c.max_distance >= cfg.breakout.min_acceptance_distance_points)
            if accepted:
                if cfg.breakout.require_ema9_alignment:
                    aligned = (bar["close"] > ema9) if is_long else (bar["close"] < ema9)
                    if not aligned:
                        accepted = False

            if accepted:
                entry_price = bar["close"]
                initial_stop = (c.level_price - cfg.trailing.initial_stop_buffer_points) if is_long else \
                                (c.level_price + cfg.trailing.initial_stop_buffer_points)
                risk_distance = abs(entry_price - initial_stop)
                if risk_distance <= 0 or risk_distance > cfg.risk.max_risk_points:
                    rec = self._finalize(c, "INVALID", "RISK_TOO_LARGE", direction, session)
                    c.reset()
                    return rec

                record = TrendBreakoutRecord(
                    timestamp=c.approach_time, symbol=self.symbol, session=session, direction=direction,
                    level_type=c.level_type, level_price=c.level_price, break_price=c.break_price,
                    break_timestamp=c.break_time, bars_to_acceptance=c.bars_since_break,
                    entry_price=entry_price, entry_timestamp=bar["time"], initial_stop=initial_stop,
                    risk_distance=risk_distance, setup_status="OPEN",
                )
                self.open_trades.append(_OpenTrade(
                    direction=direction, entry_price=entry_price, entry_time=bar["time"],
                    initial_stop=initial_stop, current_stop=initial_stop, initial_risk=risk_distance,
                    record=record, extreme_since_entry=entry_price,
                ))
                c.reset()
                return None

            if c.bars_since_break >= cfg.breakout.max_bars_to_acceptance:
                rec = self._finalize(c, "EXPIRED", "SETUP_EXPIRED", direction, session)
                c.reset()
                return rec
            return None
        return None

    def _finalize(self, c: _Candidate, status: str, reason: str, direction: str, session: str) -> TrendBreakoutRecord:
        return TrendBreakoutRecord(
            timestamp=c.approach_time, symbol=self.symbol, session=session, direction=direction,
            level_type=c.level_type, level_price=c.level_price, break_price=c.break_price,
            break_timestamp=c.break_time, bars_to_acceptance=c.bars_since_break,
            setup_status=status, rejection_reason=reason,
        )

    # ------------------------------------------------------------------
    def _update_trade(self, t: _OpenTrade, bar: dict, atr: Optional[float]) -> Optional[TrendBreakoutRecord]:
        is_long = t.direction == "long"
        cfg = self.cfg

        adverse = (t.entry_price - bar["low"]) if is_long else (bar["high"] - t.entry_price)
        favorable = (bar["high"] - t.entry_price) if is_long else (t.entry_price - bar["low"])
        t.mae_points = max(t.mae_points, adverse)
        t.mfe_points = max(t.mfe_points, favorable)

        t.extreme_since_entry = max(t.extreme_since_entry, bar["high"]) if is_long else \
                                 min(t.extreme_since_entry, bar["low"])

        favorable_r = ((t.extreme_since_entry - t.entry_price) / t.initial_risk) if is_long else \
                      ((t.entry_price - t.extreme_since_entry) / t.initial_risk)
        if not t.trail_active and favorable_r >= cfg.trailing.activate_trail_after_r:
            t.trail_active = True

        if t.trail_active and atr is not None and atr > 0:
            candidate_stop = t.extreme_since_entry - cfg.trailing.trail_atr_multiplier * atr if is_long else \
                              t.extreme_since_entry + cfg.trailing.trail_atr_multiplier * atr
            t.current_stop = max(t.current_stop, candidate_stop) if is_long else min(t.current_stop, candidate_stop)

        stop_hit = bar["low"] <= t.current_stop if is_long else bar["high"] >= t.current_stop
        if not stop_hit:
            return None

        exit_price = t.current_stop
        pnl_points = (exit_price - t.entry_price) if is_long else (t.entry_price - exit_price)
        rec = t.record
        rec.exit_price = exit_price
        rec.exit_timestamp = bar["time"]
        rec.pnl_points = pnl_points
        rec.pnl_dollars = pnl_points * self.point_value
        rec.r_multiple = pnl_points / t.initial_risk if t.initial_risk else None
        rec.bars_held = self._bars_between(t.entry_time, bar["time"])
        rec.setup_status = "FILLED"
        rec.mae_points = t.mae_points
        rec.mfe_points = t.mfe_points
        return rec

    def force_close_all(self, last_bar: dict) -> list[TrendBreakoutRecord]:
        out = []
        for t in self.open_trades:
            is_long = t.direction == "long"
            price = last_bar["close"]
            pnl_points = (price - t.entry_price) if is_long else (t.entry_price - price)
            rec = t.record
            rec.exit_price = price
            rec.exit_timestamp = last_bar["time"]
            rec.pnl_points = pnl_points
            rec.pnl_dollars = pnl_points * self.point_value
            rec.r_multiple = pnl_points / t.initial_risk if t.initial_risk else None
            rec.bars_held = self._bars_between(t.entry_time, last_bar["time"])
            rec.setup_status = "OPEN_AT_BACKTEST_END"
            rec.mae_points = t.mae_points
            rec.mfe_points = t.mfe_points
            out.append(rec)
        self.open_trades = []
        return out

    @staticmethod
    def _bars_between(t1, t2, bar_seconds: int = 60):
        if t1 is None or t2 is None:
            return None
        return int(round((t2 - t1) / bar_seconds))
