#!/usr/bin/env python3
# Python 3.10+ removed implicit event loop creation — patch before ib_insync loads
import asyncio
try:
    asyncio.get_event_loop()
except RuntimeError:
    asyncio.set_event_loop(asyncio.new_event_loop())

"""
MGC Turtle Soup V2 — IBKR Live Bot
Runs the V2 strategy engine against live Interactive Brokers data.

Usage:
    python3 ibkr_mgc_bot.py              # paper account (default)
    python3 ibkr_mgc_bot.py --live       # live account  ← CAREFUL
    python3 ibkr_mgc_bot.py --host 127.0.0.1 --port 7497

TWS ports:
    7497 = TWS paper trading
    7496 = TWS live trading
    4002 = IB Gateway paper
    4001 = IB Gateway live
"""

import argparse
import json
import logging
import math
import sys
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from ib_insync import (
    IB, Contract, LimitOrder, MarketOrder, StopOrder,
    util, Trade, BarData, RealTimeBar,
)

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("ibkr_mgc_bot.log"),
    ],
)
log = logging.getLogger("mgc_bot")

MOUNTAIN = ZoneInfo("America/Denver")

# ── Strategy parameters — 10m chart, synced to TradingView inputs 2026-06-10 ──
MSS_OFFSET      = 6
BAR_LENGTH      = 5      # warmup buffer only (no HTF aggregation on 10m)
ATR_LEN         = 2
TREND_EMA_LEN   = 50
LONG_RR         = 1.6
SHORT_RR        = 1.8
LONG_SL_ATR     = 5.3
SHORT_SL_ATR    = 7.2
RISK_PCT        = 0.025
MAX_CONTRACTS   = 7
MGC_INIT_MARGIN = 4200  # per contract initial margin (COMEX) — conservative buffer above ~$4,075
LONG_MAX_HOLD   = 33
SHORT_MAX_HOLD  = 42
MIN_DISP_ATR    = 0.65
MIN_ATR_POINTS  = 4.18
LONG_HOURS      = {8, 10, 11}
SHORT_HOURS     = {8, 9, 12}

# Filter mode — set via --filter-mode CLI arg
# "Baseline"     : session 0800-1330 MT + side-hour filter (default, best PF)
# "Session Only" : session 0800-1330 MT, any hour within session (+27% trades, lower PF)
# "24h Full"     : no session, no hour filter, trade 24h (+3.7x trades, highest DD)
FILTER_MODE     = "Baseline"   # overridden by parse_args()

# Account
POINT_VALUE     = 10.0
TICK_SIZE       = 0.10
COMMISSION      = 1.20
SLIP_TICKS      = 2

# Daily safety limits
MAX_DAILY_LOSS_USD  = 500.0   # bot pauses if daily loss exceeds this
MAX_TRADES_PER_DAY  = 10


# ── Contract ──────────────────────────────────────────────────────────────────

DELIVERY_BUFFER_DAYS = 25  # skip contracts expiring within this many days

def get_mgc_contract(ib: IB) -> Contract:
    """Resolve the nearest MGC contract outside IBKR's delivery restriction window."""
    from datetime import datetime, timedelta
    c = Contract(symbol="MGC", secType="FUT", exchange="COMEX", currency="USD")
    details = ib.reqContractDetails(c)
    if not details:
        raise RuntimeError("No MGC contract details returned — is TWS connected?")
    details.sort(key=lambda d: d.contract.lastTradeDateOrContractMonth)
    today = datetime.now()
    cutoff = today + timedelta(days=DELIVERY_BUFFER_DAYS)
    # Pick the first contract that expires after the delivery buffer
    tradeable = [d for d in details
                 if datetime.strptime(d.contract.lastTradeDateOrContractMonth, "%Y%m%d") > cutoff]
    if not tradeable:
        log.warning("No contracts outside delivery window — using nearest available")
        tradeable = details
    front = tradeable[0].contract
    log.info(f"MGC contract: {front.localSymbol}  expiry={front.lastTradeDateOrContractMonth}"
             f"  (skipped {len(details)-len(tradeable)} near-expiry contracts)")
    return front


# ── Indicator helpers ─────────────────────────────────────────────────────────

def _wilder_atr(highs, lows, closes, n=ATR_LEN):
    if len(closes) < n + 1:
        return float("nan")
    trs = []
    for i in range(1, len(closes)):
        h, l, pc = highs[i], lows[i], closes[i - 1]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    alpha = 1.0 / n
    atr = trs[0]
    for tr in trs[1:]:
        atr = alpha * tr + (1 - alpha) * atr
    return atr


def _ema(values, span):
    alpha = 2.0 / (span + 1)
    e = values[0]
    for v in values[1:]:
        e = alpha * v + (1 - alpha) * e
    return e


# ── State machine dataclasses ─────────────────────────────────────────────────

@dataclass
class BarWindow:
    """Rolling window of OHLCV bars for indicator calculation."""
    maxlen: int
    opens:   deque = field(default_factory=deque)
    highs:   deque = field(default_factory=deque)
    lows:    deque = field(default_factory=deque)
    closes:  deque = field(default_factory=deque)
    times:   deque = field(default_factory=deque)

    def __post_init__(self):
        for attr in ("opens", "highs", "lows", "closes", "times"):
            setattr(self, attr, deque(maxlen=self.maxlen))

    def push(self, o, h, l, c, t):
        self.opens.append(o); self.highs.append(h)
        self.lows.append(l);  self.closes.append(c)
        self.times.append(t)

    def full(self):
        return len(self.closes) == self.maxlen

    @property
    def last_close(self): return self.closes[-1] if self.closes else float("nan")
    @property
    def last_high(self): return self.highs[-1] if self.highs else float("nan")
    @property
    def last_low(self): return self.lows[-1] if self.lows else float("nan")


@dataclass
class BotState:
    # Pending signal state machine
    pending_state:      str   = "idle"
    pending_entry_type: str   = ""
    pending_break_bar:  int   = -1
    pending_start_bar:  int   = -1
    pending_high:       float = float("nan")
    pending_low:        float = float("nan")

    # Active position tracking
    active_side:        str   = ""
    active_entry_price: float = float("nan")
    active_stop:        float = float("nan")
    active_target:      float = float("nan")
    active_entry_bar:   int   = -1
    active_qty:         int   = 0
    last_exit_bar:      int   = -100_000

    # IBKR order IDs
    entry_order_id:     int   = -1
    sl_order_id:        int   = -1
    tp_order_id:        int   = -1

    # Performance tracking
    bar_index:          int   = 0
    daily_pnl:          float = 0.0
    trades_today:       int   = 0
    today_date:         str   = ""
    equity:             float = 0.0   # updated from IBKR account

    def reset_pending(self):
        self.pending_state      = "idle"
        self.pending_entry_type = ""
        self.pending_break_bar  = -1
        self.pending_start_bar  = -1
        self.pending_high       = float("nan")
        self.pending_low        = float("nan")

    needs_protective_orders: bool = False   # set when adopted position has no bracket

    def reset_active(self):
        self.active_side              = ""
        self.active_entry_price       = float("nan")
        self.active_stop              = float("nan")
        self.active_target            = float("nan")
        self.active_entry_bar         = -1
        self.active_qty               = 0
        self.entry_order_id           = -1
        self.sl_order_id              = -1
        self.tp_order_id              = -1
        self.needs_protective_orders  = False


# ── Main bot class ────────────────────────────────────────────────────────────

class MGCBot:
    def __init__(self, ib: IB, contract: Contract, paper: bool = True):
        self.ib       = ib
        self.contract = contract
        self.paper    = paper
        self.state    = BotState()

        # Bar windows — need enough history for indicators
        warmup = max(MSS_OFFSET, BAR_LENGTH, ATR_LEN) + 5
        self.bars_3m  = BarWindow(maxlen=warmup + 10)
        self.bars_15m = BarWindow(maxlen=TREND_EMA_LEN + 5)

        # Partial 3m aggregation from 1m IBKR bars (if needed)
        self._partial_3m: list = []

        self._trade_log: list[dict] = []
        self._log_path = Path("mgc_live_trades.json")
        self._seeding = True   # True during historical seed — no real orders
        self._equity_fetched = False  # accountValues() called at most once per bot instance
        self._last_processed_ts: datetime = datetime.fromtimestamp(0, tz=timezone.utc)
        self._last_poll_time: float = 0.0

    # ── IBKR account equity ───────────────────────────────────────────────────

    def _refresh_equity(self):
        # Use portfolio() — no reqAccountSummary subscription, avoids Error 322 on reconnects
        try:
            portfolio = self.ib.portfolio()
            if portfolio:
                # Sum market value of all positions as proxy for equity change
                pass
            # Preferred: pull from managed accounts summary via wrapper
            wrapper = self.ib.wrapper
            if hasattr(wrapper, 'acctValue') and wrapper.acctValue:
                val = wrapper.acctValue.get("NetLiquidation-USD")
                if val:
                    self.state.equity = float(val)
                    log.debug(f"Equity: ${self.state.equity:,.2f}")
                    return
            # Fallback: accountValues — call at most ONCE per bot lifetime to avoid Error 322
            if self.state.equity == 0.0 and not self._equity_fetched:
                self._equity_fetched = True
                acct = [v for v in self.ib.accountValues()
                        if v.tag == "NetLiquidation" and v.currency == "USD"]
                if acct:
                    self.state.equity = float(acct[0].value)
                    log.info(f"Equity (initial fetch): ${self.state.equity:,.2f}")
        except Exception as e:
            log.warning(f"Equity refresh skipped: {e} — using cached ${self.state.equity:,.2f}")

    # ── Indicator computation ─────────────────────────────────────────────────

    def _compute_3m_indicators(self):
        """Compute all 3m-bar indicators from current bar window."""
        h = list(self.bars_3m.highs)
        l = list(self.bars_3m.lows)
        c = list(self.bars_3m.closes)
        o = list(self.bars_3m.opens)

        if len(c) < MSS_OFFSET + 2:
            return None

        atr = _wilder_atr(h, l, c)
        if math.isnan(atr) or atr < MIN_ATR_POINTS:
            return None

        high_mss      = max(h[-MSS_OFFSET:])
        low_mss       = min(l[-MSS_OFFSET:])
        high_mss_prev = max(h[-MSS_OFFSET - 1:-1])
        low_mss_prev  = min(l[-MSS_OFFSET - 1:-1])

        prev_high_htf = max(h[-BAR_LENGTH - 1:-1])
        prev_low_htf  = min(l[-BAR_LENGTH - 1:-1])

        body_atr = abs(c[-1] - o[-1]) / atr if atr > 0 else 0.0

        return dict(
            atr=atr,
            high_mss=high_mss,
            low_mss=low_mss,
            high_mss_prev=high_mss_prev,
            low_mss_prev=low_mss_prev,
            prev_high_htf=prev_high_htf,
            prev_low_htf=prev_low_htf,
            body_atr=body_atr,
            h=h[-1], l=l[-1], c=c[-1], o=o[-1],
        )

    def _htf_trend_ok(self):
        """Short trend filter: 15m close[1] < 15m EMA(50)[1]."""
        closes = list(self.bars_15m.closes)
        if len(closes) < TREND_EMA_LEN + 1:
            return False   # not enough data → block shorts until warm
        # Use closes shifted by 1 (previous completed 15m bar)
        htf_close_prev = closes[-2]
        ema_prev       = _ema(closes[:-1], TREND_EMA_LEN)
        return htf_close_prev < ema_prev

    def _session_ok(self, ts: datetime) -> bool:
        if FILTER_MODE == "24h Full":
            return True
        mt = ts.astimezone(MOUNTAIN)
        h, m = mt.hour, mt.minute
        after_open   = (h > 8) or (h == 8 and m >= 0)
        before_close = (h < 13) or (h == 13 and m <= 30)
        return after_open and before_close

    def _hour_ok(self, mt_hour: int, side: str) -> bool:
        if FILTER_MODE in ("Session Only", "24h Full"):
            return True
        if side == "Long":
            return mt_hour in LONG_HOURS
        return mt_hour in SHORT_HOURS

    def _entry_quality_ok(self, ind: dict) -> bool:
        return ind["body_atr"] >= MIN_DISP_ATR and ind["atr"] >= MIN_ATR_POINTS

    def _calc_qty(self, entry: float, stop: float) -> int:
        sl_dist  = abs(entry - stop)
        rpu      = sl_dist * POINT_VALUE
        if rpu <= 0:
            return 1
        cash_risk    = self.state.equity * RISK_PCT
        raw_qty      = cash_risk / rpu
        # Cap by available margin so we never exceed account capacity
        max_by_margin = max(1, int(self.state.equity / MGC_INIT_MARGIN))
        return int(min(MAX_CONTRACTS, max_by_margin, max(1, math.floor(raw_qty))))

    # ── Daily reset ───────────────────────────────────────────────────────────

    def _check_daily_reset(self, ts: datetime):
        today = ts.astimezone(MOUNTAIN).strftime("%Y-%m-%d")
        if today != self.state.today_date:
            if self.state.today_date:
                log.info(f"Day change → {today}  |  yesterday P&L: ${self.state.daily_pnl:+,.2f}  trades: {self.state.trades_today}")
            self.state.today_date   = today
            self.state.daily_pnl    = 0.0
            self.state.trades_today = 0

    def _daily_limits_ok(self) -> bool:
        if self.state.daily_pnl <= -MAX_DAILY_LOSS_USD:
            log.warning(f"Daily loss limit hit (${self.state.daily_pnl:,.2f}) — pausing bot today")
            return False
        if self.state.trades_today >= MAX_TRADES_PER_DAY:
            log.warning(f"Max trades/day ({MAX_TRADES_PER_DAY}) reached — pausing")
            return False
        return True

    # ── Order execution ───────────────────────────────────────────────────────

    def _place_bracket(self, side: str, qty: int,
                       entry_price: float, sl_price: float, tp_price: float) -> bool:
        """Place entry limit + OCA stop + OCA limit (bracket). Returns False if rejected."""
        action     = "BUY"  if side == "Long" else "SELL"
        sl_action  = "SELL" if side == "Long" else "BUY"
        tp_action  = "SELL" if side == "Long" else "BUY"

        oca_group = f"MGC_{side}_{int(time.time())}"

        # Entry as limit at the MSS level
        entry_order = LimitOrder(action, qty, round(entry_price, 1))
        entry_order.tif = "GTC"
        entry_order.transmit = False

        # Stop loss
        sl_order = StopOrder(sl_action, qty, round(sl_price, 1))
        sl_order.tif        = "GTC"
        sl_order.ocaGroup   = oca_group
        sl_order.ocaType    = 1   # cancel with block
        sl_order.transmit   = False

        # Take profit
        tp_order = LimitOrder(tp_action, qty, round(tp_price, 1))
        tp_order.tif        = "GTC"
        tp_order.ocaGroup   = oca_group
        tp_order.ocaType    = 1
        tp_order.transmit   = True   # transmits the whole group

        entry_trade = self.ib.placeOrder(self.contract, entry_order)
        sl_trade    = self.ib.placeOrder(self.contract, sl_order)
        tp_trade    = self.ib.placeOrder(self.contract, tp_order)

        self.state.entry_order_id = entry_trade.order.orderId
        self.state.sl_order_id    = sl_trade.order.orderId
        self.state.tp_order_id    = tp_trade.order.orderId

        log.info(
            f"BRACKET {side} {qty}x MGC | "
            f"Entry={entry_price:.1f}  SL={sl_price:.1f}  TP={tp_price:.1f} | "
            f"Orders: entry={self.state.entry_order_id} "
            f"sl={self.state.sl_order_id} tp={self.state.tp_order_id}"
        )

        # Rollback: if any order is rejected within 2s, cancel the whole bracket
        self.ib.sleep(2)
        rejected = [t for t in [entry_trade, sl_trade, tp_trade]
                    if t.orderStatus.status in ("Inactive", "Cancelled", "ApiCancelled")]
        if rejected:
            log.error(f"Bracket rejected — cancelling all {len(rejected)} orders")
            self._cancel_open_orders()
            self.state.reset_pending()
            self.state.active_side = ""
            return False
        return True

    def _cancel_open_orders(self):
        """Cancel any open entry/sl/tp orders for this bot."""
        for oid in [self.state.entry_order_id,
                    self.state.sl_order_id,
                    self.state.tp_order_id]:
            if oid > 0:
                try:
                    order = next((t.order for t in self.ib.openTrades()
                                  if t.order.orderId == oid), None)
                    if order:
                        self.ib.cancelOrder(order)
                        log.info(f"Cancelled order {oid}")
                except Exception as e:
                    log.warning(f"Cancel order {oid} failed: {e}")

    def _close_position_market(self, side: str, qty: int, reason: str):
        """Market-close an open position (time stop)."""
        action = "SELL" if side == "Long" else "BUY"
        mo     = MarketOrder(action, qty)
        mo.tif = "GTC"
        self._cancel_open_orders()
        trade = self.ib.placeOrder(self.contract, mo)
        log.info(f"MARKET CLOSE {side} {qty}x — {reason}  orderId={trade.order.orderId}")

    # ── Core strategy logic — called on each confirmed 3m bar ─────────────────

    def on_bar(self, bar_time: datetime, o: float, h: float, l: float, c: float):
        """Process one confirmed 10-minute bar through the V2 state machine."""
        s = self.state
        s.bar_index += 1

        self._check_daily_reset(bar_time)
        self._refresh_equity()

        # Push bar into both windows (same 10m bars — no HTF aggregation)
        self.bars_3m.push(o, h, l, c, bar_time)
        self.bars_15m.push(o, h, l, c, bar_time)

        mt = bar_time.astimezone(MOUNTAIN)

        if not self.bars_3m.full():
            return

        ind = self._compute_3m_indicators()

        # Place protective bracket for adopted position — do this even if strategy
        # ATR filter rejects the bar (ind may be None here; method handles that case)
        if not self._seeding and s.needs_protective_orders:
            self._place_protective_orders(ind)

        if ind is None:
            return

        mt_hour  = mt.hour
        sess_ok  = self._session_ok(bar_time)
        can_re   = (s.bar_index - s.last_exit_bar) > 0
        eq_ok    = self._entry_quality_ok(ind)
        short_trend = self._htf_trend_ok()
        long_trend  = True   # requireLongTrendFilter = false

        # ── Check if position was closed externally (IBKR filled SL/TP) ──────
        if s.active_side != "":
            # Skip close-check if entry order is still pending (unfilled limit)
            entry_pending = any(
                t.order.orderId == s.entry_order_id
                and t.orderStatus.status not in ("Inactive", "Cancelled", "ApiCancelled", "Filled")
                for t in self.ib.openTrades()
            )
            if not entry_pending:
                pos = self._get_ibkr_position()
                if pos == 0 and s.active_side != "":
                    pnl = self._estimate_pnl(ind["c"])
                    s.daily_pnl    += pnl
                    s.trades_today += 1
                    log.info(
                        f"Position closed by IBKR  side={s.active_side}  "
                        f"estimated_pnl=${pnl:+,.2f}  daily_pnl=${s.daily_pnl:+,.2f}"
                    )
                    self._log_trade("IBKR_CLOSE", bar_time, ind["c"], pnl)
                    s.last_exit_bar = s.bar_index
                    s.reset_active()
                    s.reset_pending()

        # ── Time stop check ───────────────────────────────────────────────────
        if s.active_side != "":
            hold = s.bar_index - s.active_entry_bar
            max_hold = LONG_MAX_HOLD if s.active_side == "Long" else SHORT_MAX_HOLD
            if hold >= max_hold:
                if self._seeding:
                    # During historical seed, just roll the entry bar forward so
                    # the hold counter never fires a real close.
                    s.active_entry_bar = s.bar_index
                else:
                    pnl = self._estimate_pnl(ind["c"])
                    s.daily_pnl    += pnl
                    s.trades_today += 1
                    log.info(
                        f"TIME STOP  side={s.active_side}  hold={hold}bars  "
                        f"close={ind['c']:.1f}  estimated_pnl=${pnl:+,.2f}"
                    )
                    self._cancel_open_orders()   # cancel bracket before market close
                    self._close_position_market(s.active_side, s.active_qty, "Time Exit")
                    self._log_trade("TIME_EXIT", bar_time, ind["c"], pnl)
                    s.last_exit_bar = s.bar_index
                    s.reset_active()
                    s.reset_pending()
                    return

        # ── Daily limits ──────────────────────────────────────────────────────
        if s.active_side == "" and not self._daily_limits_ok():
            return

        # ── State machine ─────────────────────────────────────────────────────
        # Guard: never enter a new bracket if an IBKR position is already open
        if s.active_side == "" and self._get_ibkr_position() != 0:
            log.warning("Skipping new signal — IBKR position already open (stale state)")
            return

        if s.active_side == "" and can_re:

            # Idle → waiting_break
            if s.pending_state == "idle":
                s.pending_state     = "waiting_break"
                s.pending_start_bar = s.bar_index
                s.pending_high      = ind["prev_high_htf"]
                s.pending_low       = ind["prev_low_htf"]
                log.debug(f"New cycle  ref_high={s.pending_high:.1f}  ref_low={s.pending_low:.1f}")

            # Waiting for sweep
            elif s.pending_state == "waiting_break" and s.bar_index > s.pending_start_bar:
                if ind["l"] < s.pending_low:
                    s.pending_state      = "waiting_execution"
                    s.pending_entry_type = "Long"
                    s.pending_break_bar  = s.bar_index
                    log.info(f"SWEEP Long  low={ind['l']:.1f} < ref={s.pending_low:.1f}  bar={s.bar_index}")
                elif ind["h"] > s.pending_high:
                    s.pending_state      = "waiting_execution"
                    s.pending_entry_type = "Short"
                    s.pending_break_bar  = s.bar_index
                    log.info(f"SWEEP Short  high={ind['h']:.1f} > ref={s.pending_high:.1f}  bar={s.bar_index}")

            # Waiting for MSS entry trigger
            elif (s.pending_state == "waiting_execution"
                  and s.bar_index > s.pending_break_bar
                  and sess_ok and eq_ok):

                if s.pending_entry_type == "Long" and long_trend and self._hour_ok(mt_hour, "Long"):
                    ll = ind["high_mss_prev"]
                    if ind["h"] > ll and ind["c"] > ind["o"]:
                        sl    = ind["low_mss_prev"] - ind["atr"] * LONG_SL_ATR
                        sd    = abs(ll - sl)
                        tp    = ll + sd * LONG_RR
                        qty   = self._calc_qty(ll, sl)
                        ep    = ll + SLIP_TICKS * TICK_SIZE

                        log.info(
                            f"SIGNAL Long  entry={ep:.1f}  SL={sl:.1f}  TP={tp:.1f}  "
                            f"qty={qty}  bar={s.bar_index}  {bar_time.strftime('%H:%M')} MT"
                        )
                        if not self._seeding:
                            if self._place_bracket("Long", qty, ep, sl, tp):
                                s.active_side        = "Long"
                                s.active_entry_price = ep
                                s.active_stop        = sl
                                s.active_target      = tp
                                s.active_entry_bar   = s.bar_index
                                s.active_qty         = qty
                                self._log_trade("ENTRY", bar_time, ep, 0.0,
                                                side="Long", sl=sl, tp=tp, qty=qty)
                        else:
                            log.info(f"SEED Long (no order): entry={ep:.1f} SL={sl:.1f} TP={tp:.1f} qty={qty}")

                    s.reset_pending()

                elif s.pending_entry_type == "Short" and short_trend and self._hour_ok(mt_hour, "Short"):
                    sl2 = ind["low_mss_prev"]
                    if ind["l"] < sl2 and ind["c"] < ind["o"]:
                        ss  = ind["high_mss_prev"] + ind["atr"] * SHORT_SL_ATR
                        sd  = abs(sl2 - ss)
                        st  = sl2 - sd * SHORT_RR
                        qty = self._calc_qty(sl2, ss)
                        ep  = sl2 - SLIP_TICKS * TICK_SIZE

                        log.info(
                            f"SIGNAL Short  entry={ep:.1f}  SL={ss:.1f}  TP={st:.1f}  "
                            f"qty={qty}  bar={s.bar_index}  {bar_time.strftime('%H:%M')} MT"
                        )
                        if not self._seeding:
                            if self._place_bracket("Short", qty, ep, ss, st):
                                s.active_side        = "Short"
                                s.active_entry_price = ep
                                s.active_stop        = ss
                                s.active_target      = st
                                s.active_entry_bar   = s.bar_index
                                s.active_qty         = qty
                                self._log_trade("ENTRY", bar_time, ep, 0.0,
                                                side="Short", sl=ss, tp=st, qty=qty)
                        else:
                            log.info(f"SEED Short (no order): entry={ep:.1f} SL={ss:.1f} TP={st:.1f} qty={qty}")

                    s.reset_pending()

    def _get_ibkr_position(self) -> int:
        """Return current net position in MGC (positive=long, negative=short, 0=flat)."""
        for pos in self.ib.positions():
            if (pos.contract.symbol == "MGC"
                    and pos.contract.secType == "FUT"):
                return int(pos.position)
        return 0

    def _adopt_orphaned_position(self):
        """Adopt an IBKR position the bot has no record of (e.g. after a service restart)."""
        s = self.state
        if s.active_side != "":
            return  # already tracking — nothing to do

        ibkr_pos = self._get_ibkr_position()
        if ibkr_pos == 0:
            return  # flat, nothing to adopt

        side = "Long" if ibkr_pos > 0 else "Short"
        qty  = abs(ibkr_pos)

        # Entry price from portfolio average cost.
        # IBKR reports averageCost as price * multiplier for futures — divide back to price.
        entry_price = float("nan")
        for item in self.ib.portfolio():
            if item.contract.symbol == "MGC" and item.contract.secType == "FUT":
                mult = float(item.contract.multiplier) if item.contract.multiplier else 10.0
                entry_price = item.averageCost / mult
                break

        # Reconstruct SL/TP from any open bracket orders on this contract
        sl_id, tp_id = -1, -1
        sl_price, tp_price = float("nan"), float("nan")
        for trade in self.ib.openTrades():
            if trade.contract.symbol != "MGC":
                continue
            ot = trade.order.orderType
            if ot == "STP":
                sl_id    = trade.order.orderId
                sl_price = trade.order.auxPrice
            elif ot == "LMT":
                tp_id    = trade.order.orderId
                tp_price = trade.order.lmtPrice

        s.active_side        = side
        s.active_qty         = qty
        s.active_entry_price = entry_price
        s.active_stop        = sl_price
        s.active_target      = tp_price
        s.active_entry_bar   = s.bar_index
        s.sl_order_id        = sl_id
        s.tp_order_id        = tp_id

        if sl_id == -1:
            s.needs_protective_orders = True

        log.info(
            f"Adopted orphaned {side} x{qty} @ {entry_price:.1f}  "
            f"SL={sl_price:.1f}  TP={tp_price:.1f}  "
            f"(sl_id={sl_id}  tp_id={tp_id})"
            + ("  → will place protective bracket on first live bar" if sl_id == -1 else "")
        )

    def _place_protective_orders(self, ind):
        """Place SL + TP OCA bracket for an adopted position that had no open orders."""
        s = self.state
        if not s.active_side or not s.needs_protective_orders:
            return

        # Use strategy-computed ATR when available; otherwise compute raw ATR from bars
        if ind is not None:
            atr = ind["atr"]
        else:
            h = list(self.bars_3m.highs)
            l = list(self.bars_3m.lows)
            c = list(self.bars_3m.closes)
            if len(c) < 5:
                log.warning("Protective bracket deferred — not enough bars yet")
                return
            atr = max(_wilder_atr(h, l, c), 3.0)   # floor at 3 points

        ep  = s.active_entry_price

        if s.active_side == "Short":
            sl_price  = round(ep + atr * SHORT_SL_ATR, 1)
            tp_price  = round(ep - abs(ep - sl_price) * SHORT_RR, 1)
            sl_action = "BUY"
            tp_action = "BUY"
        else:
            sl_price  = round(ep - atr * LONG_SL_ATR, 1)
            tp_price  = round(ep + abs(ep - sl_price) * LONG_RR, 1)
            sl_action = "SELL"
            tp_action = "SELL"

        qty       = s.active_qty
        oca_group = f"MGC_Adopted_{int(time.time())}"

        sl_order          = StopOrder(sl_action, qty, sl_price)
        sl_order.tif      = "GTC"
        sl_order.ocaGroup = oca_group
        sl_order.ocaType  = 1
        sl_order.transmit = False

        tp_order          = LimitOrder(tp_action, qty, tp_price)
        tp_order.tif      = "GTC"
        tp_order.ocaGroup = oca_group
        tp_order.ocaType  = 1
        tp_order.transmit = True

        sl_trade = self.ib.placeOrder(self.contract, sl_order)
        tp_trade = self.ib.placeOrder(self.contract, tp_order)

        self.ib.sleep(2)
        rejected = [t for t in [sl_trade, tp_trade]
                    if t.orderStatus.status in ("Inactive", "Cancelled", "ApiCancelled")]
        if rejected:
            log.error(f"Protective bracket rejected — will retry next bar")
            return

        s.sl_order_id            = sl_trade.order.orderId
        s.tp_order_id            = tp_trade.order.orderId
        s.active_stop            = sl_price
        s.active_target          = tp_price
        s.needs_protective_orders = False

        log.info(
            f"Protective bracket placed for adopted {s.active_side} x{qty} @ {ep:.1f}  "
            f"SL={sl_price:.1f}  TP={tp_price:.1f}  atr={atr:.2f}  "
            f"(sl_id={s.sl_order_id}  tp_id={s.tp_order_id})"
        )

    def _estimate_pnl(self, exit_price: float) -> float:
        s = self.state
        if s.active_side == "Long":
            gross = (exit_price - s.active_entry_price) * POINT_VALUE * s.active_qty
        else:
            gross = (s.active_entry_price - exit_price) * POINT_VALUE * s.active_qty
        return gross - COMMISSION * s.active_qty * 2

    def _log_trade(self, event: str, ts: datetime, price: float, pnl: float, **kwargs):
        record = dict(event=event, time=ts.isoformat(), price=price,
                      pnl=pnl, equity=self.state.equity, **kwargs)
        self._trade_log.append(record)
        self._log_path.write_text(json.dumps(self._trade_log, indent=2))

    def _write_runtime(self):
        """Write live state for the dashboard to read."""
        s = self.state
        # Pull account data from IBKR portfolio
        realized_pnl = 0.0
        unrealized_pnl = 0.0
        account_id = ""
        mkt_price = None
        try:
            items = self.ib.portfolio()
            for item in items:
                realized_pnl   += item.realizedPNL or 0.0
                unrealized_pnl += item.unrealizedPNL or 0.0
                account_id      = item.account or account_id
                if item.contract.symbol == "MGC":
                    mkt_price = round(item.marketPrice, 2) if item.marketPrice else None
        except Exception:
            pass
        runtime = dict(
            equity=round(s.equity, 2),
            realized_pnl=round(realized_pnl, 2),
            unrealized_pnl=round(unrealized_pnl, 2),
            account=account_id,
            mkt_price=mkt_price,
            active_side=s.active_side,
            active_entry_price=round(s.active_entry_price, 2) if s.active_side else None,
            active_stop=round(s.active_stop, 2) if s.active_side else None,
            active_target=round(s.active_target, 2) if s.active_side else None,
            daily_pnl=round(s.daily_pnl, 2),
            trades_today=s.trades_today,
            bar_index=s.bar_index,
            filter_mode=FILTER_MODE,
            ts=datetime.now(timezone.utc).isoformat(),
        )
        try:
            Path("mgc_runtime.json").write_text(json.dumps(runtime))
        except Exception:
            pass

    # ── Bar polling fallback (when updateEvent stream isn't delivering) ────────

    def _poll_latest_bars(self):
        """Fetch the last 30 minutes of bars and process any not yet seen."""
        try:
            bars = self.ib.reqHistoricalData(
                self.contract,
                endDateTime="",
                durationStr="3600 S",
                barSizeSetting="10 mins",
                whatToShow="TRADES",
                useRTH=False,
                keepUpToDate=False,
            )
            # Process all completed bars (skip last — may still be in progress)
            for bar in bars[:-1]:
                ts = pd.Timestamp(bar.date).to_pydatetime()
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
                if ts > self._last_processed_ts:
                    log.info(f"POLL Bar {ts}  O={bar.open} H={bar.high} L={bar.low} C={bar.close}")
                    self._last_processed_ts = ts
                    self._last_bar_time = time.time()
                    self.on_bar(ts, bar.open, bar.high, bar.low, bar.close)
                    self._write_runtime()
        except Exception as e:
            log.warning(f"Bar poll failed: {e}")

    # ── Bar feed wiring ───────────────────────────────────────────────────────

    def _subscribe_bars(self):
        """Request historical + live 10m bars. Returns the bar list object."""
        bars = self.ib.reqHistoricalData(
            self.contract,
            endDateTime="",
            durationStr="2 D",
            barSizeSetting="10 mins",
            whatToShow="TRADES",
            useRTH=False,
            keepUpToDate=True,
        )
        if self._seeding:
            log.info(f"Seeding {len(bars)} historical 10m bars …")
            for bar in bars[:-1]:
                ts = pd.Timestamp(bar.date).to_pydatetime()
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
                self._last_processed_ts = ts
                self.on_bar(ts, bar.open, bar.high, bar.low, bar.close)
            self._seeding = False
            log.info("Historical seed done — live mode active")
        else:
            log.info(f"Bar feed resubscribed ({len(bars)} bars, no re-seed)")

        def on_bar_update(bars, has_new_bar):
            if has_new_bar and len(bars) >= 2:
                bar = bars[-2]
                ts  = pd.Timestamp(bar.date).to_pydatetime()
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
                if ts <= self._last_processed_ts:
                    return  # already processed by poll
                log.info(f"Bar {ts}  O={bar.open} H={bar.high} L={bar.low} C={bar.close}")
                self._last_processed_ts = ts
                self._last_bar_time = time.time()
                self.on_bar(ts, bar.open, bar.high, bar.low, bar.close)
                self._write_runtime()

        bars.updateEvent += on_bar_update
        return bars

    def run(self):
        self._refresh_equity()
        log.info(f"Starting MGC bot  paper={self.paper}  contract={self.contract.localSymbol}  equity=${self.state.equity:,.2f}")
        self._adopt_orphaned_position()
        self._active_bars = self._subscribe_bars()
        self._feed_dead = False
        self._last_bar_time = time.time()
        BAR_TIMEOUT = 1200  # resubscribe if no bar in 20 min (2× the 10m bar interval)

        def on_error(reqId, errorCode, errorString, contract):
            if errorCode == 10182:
                log.warning("Bar feed lost (10182) — will resubscribe …")
                self._feed_dead = True
            elif errorCode not in (2104, 2106, 2158, 2103, 2105, 2157, 1100, 1102):
                log.warning(f"IBKR error {errorCode} (req {reqId}): {errorString}")

        self.ib.errorEvent += on_error

        POLL_INTERVAL = 600  # poll every 10 minutes when stream is silent
        log.info("Bot running — Ctrl+C to stop")
        try:
            while True:
                self.ib.sleep(10)

                # Polling fallback: fetch bars manually when updateEvent isn't delivering
                if (time.time() - self._last_poll_time) > POLL_INTERVAL and self.ib.isConnected():
                    self._last_poll_time = time.time()
                    self._poll_latest_bars()

                # Heartbeat: resubscribe if no bar received in BAR_TIMEOUT seconds
                feed_stale = (time.time() - self._last_bar_time) > BAR_TIMEOUT
                if (self._feed_dead or feed_stale) and self.ib.isConnected():
                    reason = "10182 error" if self._feed_dead else f"no bar for {BAR_TIMEOUT//60}min"
                    log.warning(f"Bar feed stale ({reason}) — resubscribing in 15s …")
                    time.sleep(15)
                    try:
                        self._seeding = False
                        self._active_bars = self._subscribe_bars()
                        self._feed_dead = False
                        self._last_bar_time = time.time()
                        log.info("Bar feed restored ✓")
                    except Exception as e:
                        log.error(f"Resubscribe failed: {e} — will retry next cycle")
        except KeyboardInterrupt:
            log.info("Shutting down …")
            self._cancel_open_orders()


# ── CLI ───────────────────────────────────────────────────────────────────────

RECONNECT_DELAY = 60   # seconds to wait before reconnect attempt

def parse_args():
    p = argparse.ArgumentParser(description="MGC Turtle Soup V2 — IBKR Bot")
    p.add_argument("--host",   default="127.0.0.1")
    p.add_argument("--port",   type=int, default=7497,
                   help="7497=TWS paper, 7496=TWS live, 4002=Gateway paper, 4001=Gateway live")
    p.add_argument("--client", type=int, default=1)
    p.add_argument("--live",   action="store_true",
                   help="Connect to LIVE account (default: paper)")
    p.add_argument("--filter-mode", default="Baseline",
                   choices=["Baseline", "Session Only", "24h Full"],
                   help=(
                       "Baseline    = session 0800-1330 MT + hour filter  [PF 1.53, DD 16%%]\n"
                       "Session Only= session 0800-1330 MT, any hour      [PF 1.30, DD 23%%]\n"
                       "24h Full    = no session/hour filters, trade 24h  [PF 1.20, DD 52%%]"
                   ))
    return p.parse_args()


def main():
    args = parse_args()
    paper = not args.live

    if not paper:
        confirm = input("⚠  LIVE account mode. Type YES to continue: ")
        if confirm.strip() != "YES":
            print("Aborted.")
            return

    global FILTER_MODE
    FILTER_MODE = args.filter_mode
    log.info(f"Filter mode: {FILTER_MODE}")

    # Preserve strategy state across reconnects
    saved_state: BotState | None = None

    while True:
        ib = IB()
        try:
            log.info(f"Connecting to IBKR  {args.host}:{args.port}  clientId={args.client}")
            ib.connect(args.host, args.port, clientId=args.client)

            contract = get_mgc_contract(ib)
            bot = MGCBot(ib, contract, paper=paper)

            # Restore state after reconnect so bar_index / daily P&L persist
            if saved_state is not None:
                log.info("Restoring strategy state after reconnect …")
                bot.state = saved_state

            bot.run()

        except KeyboardInterrupt:
            log.info("Keyboard interrupt — shutting down permanently")
            break

        except Exception as e:
            saved_state = bot.state if 'bot' in dir() else None
            log.error(f"Bot error: {e} — reconnecting in {RECONNECT_DELAY}s")
            try:
                ib.disconnect()
            except Exception:
                pass
            time.sleep(RECONNECT_DELAY)
            log.info("Attempting reconnect …")
            continue

        finally:
            try:
                ib.disconnect()
            except Exception:
                pass
            log.info("Disconnected from IBKR")
        break   # clean exit (KeyboardInterrupt path)


if __name__ == "__main__":
    main()
