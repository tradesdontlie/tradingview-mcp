"""Simulated broker for offline testing, with failure injection.

fail_next: "reject"   -> BrokerReject, nothing opened
           "lost_ack" -> position IS opened, but the call raises TimeoutError
           "disconnect" -> ConnectionError, nothing opened
connected=False makes every call raise ConnectionError.
"""
import random

from .models import AccountInfo, BrokerReject, ClosedTrade, Position, SymbolSpec

DEFAULT_SPECS = {
    # 1 lot EURUSD: 1 tick (0.00001) = $1  ->  a 20-pip stop risks $200 per lot
    "EURUSD": SymbolSpec("EURUSD", 0.01, 0.01, 100.0, 0.00001, 1.0, 5),
    "GBPUSD": SymbolSpec("GBPUSD", 0.01, 0.01, 100.0, 0.00001, 1.0, 5),
    "USDJPY": SymbolSpec("USDJPY", 0.01, 0.01, 100.0, 0.001, 0.68, 3),
}
START = {"EURUSD": 1.10, "GBPUSD": 1.30, "USDJPY": 150.0}


class SimBroker:
    def __init__(self, equity=10000.0, seed=1, spread_pips=1.0, sigma=0.0005,
                 commission_per_lot=7.0, t0=1_700_000_000.0):
        self.rng = random.Random(seed)
        self.specs = dict(DEFAULT_SPECS)
        self.mid = dict(START)
        self.balance = equity
        self.spread_pips, self.sigma, self.commission = spread_pips, sigma, commission_per_lot
        self.t = t0
        self._positions, self.history = {}, {}
        self._ticket = 1000
        self.fail_next = None
        self.connected = True
        self.send_calls = 0

    # ---- helpers ----
    def _guard(self):
        if not self.connected:
            raise ConnectionError("sim broker offline")

    def _half_spread(self, sym):
        spec = self.specs[sym]
        return self.spread_pips * (10 * spec.tick_size) / 2

    def now(self):
        return self.t

    # ---- market info ----
    def quote(self, sym):
        self._guard()
        h = self._half_spread(sym)
        return (self.mid[sym] - h, self.mid[sym] + h)

    def spec(self, sym):
        self._guard()
        return self.specs[sym]

    def _pnl(self, p, exit_price):
        spec = self.specs[p.symbol]
        move = (exit_price - p.open_price) if p.side == "BUY" else (p.open_price - exit_price)
        return move / spec.tick_size * spec.tick_value * p.volume - self.commission * p.volume

    def account(self):
        self._guard()
        floating = 0.0
        for p in self._positions.values():
            bid, ask = self.quote(p.symbol)
            floating += self._pnl(p, bid if p.side == "BUY" else ask)
        eq = self.balance + floating
        return AccountInfo(self.balance, eq, eq, True, True)

    # ---- trading ----
    def send_market(self, client_id, symbol, side, volume, sl, tp):
        self._guard()
        self.send_calls += 1
        mode, self.fail_next = self.fail_next, None
        if mode == "reject":
            raise BrokerReject("sim: rejected")
        if mode == "disconnect":
            raise ConnectionError("sim: connection lost during send")
        bid, ask = self.quote(symbol)
        self._ticket += 1
        pos = Position(self._ticket, client_id, symbol, side, volume,
                       ask if side == "BUY" else bid, sl, tp, self.t)
        self._positions[pos.ticket] = pos
        if mode == "lost_ack":
            raise TimeoutError("sim: order sent but acknowledgement lost")
        return pos

    def positions(self):
        self._guard()
        return list(self._positions.values())

    def find_position(self, client_id):
        return next((p for p in self.positions() if p.client_id == client_id), None)

    def closed_trade(self, client_id, ticket=None):
        self._guard()
        return self.history.get(client_id)

    def _close(self, p, price):
        pnl = self._pnl(p, price)
        self.balance += pnl
        self.history[p.client_id] = ClosedTrade(p.client_id, pnl, self.t)
        del self._positions[p.ticket]

    def close_position(self, ticket):
        self._guard()
        p = self._positions.get(ticket)
        if p:
            bid, ask = self.quote(p.symbol)
            self._close(p, bid if p.side == "BUY" else ask)

    def close_all(self):
        for t in list(self._positions):
            self.close_position(t)

    def cancel_pending(self):
        self._guard()

    # ---- time ----
    def step(self, dt=3600.0, micro=6):
        """Advance one bar. Stops/targets are checked on every micro-step."""
        for _ in range(micro):
            for sym in self.mid:
                self.mid[sym] *= 1 + self.rng.gauss(0, self.sigma / micro ** 0.5)
            for p in list(self._positions.values()):
                bid, ask = self.quote(p.symbol)
                px = bid if p.side == "BUY" else ask
                hit_sl = px <= p.sl if p.side == "BUY" else px >= p.sl
                hit_tp = px >= p.tp if p.side == "BUY" else px <= p.tp
                if hit_sl:
                    self._close(p, p.sl)
                elif hit_tp:
                    self._close(p, p.tp)
        self.t += dt
