"""MetaTrader 5 broker adapter (Windows only).

STATUS: written against the official MetaTrader5 Python API but NOT yet run against a
live terminal. Validate on a DEMO account with check_mt5.py before trusting it.
It refuses to connect to a real-money account unless require_demo=False.
"""
import time
from datetime import datetime, timedelta, timezone

from .models import AccountInfo, BrokerReject, ClosedTrade, Position, SymbolSpec

MAGIC = 515151


class MT5Broker:
    def __init__(self, require_demo: bool = True):
        import MetaTrader5 as mt5            # imported here so other OSes can run the simulator
        self.mt5 = mt5
        if not mt5.initialize():
            raise ConnectionError(f"MT5 initialize failed: {mt5.last_error()}")
        info = mt5.account_info()
        if info is None:
            raise ConnectionError("MT5 is not logged in to an account")
        if require_demo and info.trade_mode != mt5.ACCOUNT_TRADE_MODE_DEMO:
            mt5.shutdown()
            raise SystemExit("Refusing to run: this is not a DEMO account.")

    def shutdown(self):
        """Release the MetaTrader 5 terminal connection."""
        self.mt5.shutdown()

    def now(self) -> float:
        return time.time()

    # ---- info ----
    def account(self) -> AccountInfo:
        m = self.mt5
        a = m.account_info()
        if a is None:
            raise ConnectionError(f"account_info failed: {m.last_error()}")
        return AccountInfo(a.balance, a.equity, a.margin_free,
                           a.trade_mode == m.ACCOUNT_TRADE_MODE_DEMO,
                           a.margin_mode == m.ACCOUNT_MARGIN_MODE_RETAIL_HEDGING,
                           getattr(a, "currency", "UNKNOWN"))

    def spec(self, symbol: str) -> SymbolSpec:
        m = self.mt5
        m.symbol_select(symbol, True)
        i = m.symbol_info(symbol)
        if i is None:
            raise ConnectionError(f"symbol_info failed for {symbol}: {m.last_error()}")
        tick_value = i.trade_tick_value_loss or i.trade_tick_value   # loss side is what risk needs
        return SymbolSpec(symbol, i.volume_min, i.volume_step, i.volume_max,
                          i.trade_tick_size, tick_value, i.digits, i.trade_stops_level * i.point)

    def quote(self, symbol: str):
        t = self.mt5.symbol_info_tick(symbol)
        if t is None:
            raise ConnectionError(f"no tick for {symbol}: {self.mt5.last_error()}")
        return (t.bid, t.ask)

    def candles(self, symbol: str, n: int, tf: str = "H1"):
        """Last n COMPLETED H1 candles (the still-forming bar is dropped). Times are broker
        server time; the checklist's session rules assume UTC, so check your broker's offset."""
        import pandas as pd
        frame = {"M1": self.mt5.TIMEFRAME_M1, "M5": self.mt5.TIMEFRAME_M5, "M15": self.mt5.TIMEFRAME_M15,
                 "H1": self.mt5.TIMEFRAME_H1}[tf]
        rates = self.mt5.copy_rates_from_pos(symbol, frame, 0, n + 1)
        if rates is None or len(rates) < 2:
            raise ConnectionError(f"copy_rates failed for {symbol}: {self.mt5.last_error()}")
        df = pd.DataFrame(rates)
        df.index = pd.to_datetime(df.pop("time"), unit="s")
        return df[["open", "high", "low", "close"]].iloc[:-1]

    # ---- positions ----
    def _to_position(self, p) -> Position:
        side = "BUY" if p.type == self.mt5.POSITION_TYPE_BUY else "SELL"
        return Position(p.ticket, p.comment if p.magic == MAGIC else "", p.symbol, side,
                        p.volume, p.price_open, p.sl, p.tp, float(p.time))

    def positions(self):
        res = self.mt5.positions_get()
        if res is None:
            if self.mt5.last_error()[0] != 1:     # 1 = RES_S_OK: "no positions" is not an error
                raise ConnectionError(f"positions_get failed: {self.mt5.last_error()}")
            return []
        return [self._to_position(p) for p in res]

    def find_position(self, client_id: str):
        return next((p for p in self.positions() if p.client_id == client_id), None)

    # ---- orders ----
    def _filling(self, symbol):
        m = self.mt5
        mode = m.symbol_info(symbol).filling_mode
        if mode & 2:
            return m.ORDER_FILLING_IOC
        if mode & 1:
            return m.ORDER_FILLING_FOK
        return m.ORDER_FILLING_RETURN

    def send_market(self, client_id, symbol, side, volume, sl, tp) -> Position:
        m = self.mt5
        bid, ask = self.quote(symbol)
        req = {
            "action": m.TRADE_ACTION_DEAL, "symbol": symbol, "volume": volume,
            "type": m.ORDER_TYPE_BUY if side == "BUY" else m.ORDER_TYPE_SELL,
            "price": ask if side == "BUY" else bid, "sl": sl, "tp": tp,
            "deviation": 20, "magic": MAGIC, "comment": client_id[:31],
            "type_time": m.ORDER_TIME_GTC, "type_filling": self._filling(symbol),
        }
        res = m.order_send(req)
        if res is None:                                   # outcome unknown -> engine reconciles
            raise ConnectionError(f"order_send returned None: {m.last_error()}")
        if res.retcode != m.TRADE_RETCODE_DONE:           # definite refusal
            raise BrokerReject(f"{res.retcode} {res.comment}")
        return Position(res.order, client_id, symbol, side, volume, res.price, sl, tp, time.time())

    def close_position(self, ticket: int) -> None:
        m = self.mt5
        found = m.positions_get(ticket=ticket)
        if not found:
            return
        p = found[0]
        bid, ask = self.quote(p.symbol)
        buy = p.type == m.POSITION_TYPE_BUY
        res = m.order_send({
            "action": m.TRADE_ACTION_DEAL, "symbol": p.symbol, "volume": p.volume,
            "type": m.ORDER_TYPE_SELL if buy else m.ORDER_TYPE_BUY, "position": ticket,
            "price": bid if buy else ask, "deviation": 20, "magic": MAGIC,
            "comment": "tm-close", "type_time": m.ORDER_TIME_GTC,
            "type_filling": self._filling(p.symbol)})
        if res is None or res.retcode != m.TRADE_RETCODE_DONE:
            raise ConnectionError(f"close failed: {res and (res.retcode, res.comment)}")

    def close_all(self) -> None:
        for p in self.positions():
            if p.client_id:
                self.close_position(p.ticket)

    def cancel_pending(self) -> None:
        m = self.mt5
        for o in (m.orders_get() or []):
            if o.magic == MAGIC:
                m.order_send({"action": m.TRADE_ACTION_REMOVE, "order": o.ticket})

    # ---- history ----
    def closed_trade(self, client_id: str, ticket=None):
        """Net result (profit + commission + swap + fees) once the position has fully closed."""
        m = self.mt5
        pid = ticket
        if pid is None:                                    # fallback: find the entry deal by comment
            now = datetime.now(timezone.utc)
            deals = m.history_deals_get(now - timedelta(days=30), now + timedelta(days=2)) or []
            entry = next((d for d in deals if d.magic == MAGIC and d.comment == client_id
                          and d.entry == m.DEAL_ENTRY_IN), None)
            if entry is None:
                return None
            pid = entry.position_id
        deals = m.history_deals_get(position=pid) or []
        if not any(d.entry == m.DEAL_ENTRY_OUT for d in deals):
            return None
        net = sum(d.profit + d.commission + d.swap + d.fee for d in deals)
        return ClosedTrade(client_id, net, max(d.time for d in deals))
