"""Simulated broker for offline testing, with failure injection.

fail_next: "reject"   -> BrokerReject, nothing opened
           "lost_ack" -> position IS opened, but the call raises TimeoutError
           "disconnect" -> ConnectionError, nothing opened
connected=False makes every call raise ConnectionError.
"""
import random

import pandas as pd

from .models import AccountInfo, BrokerReject, ClosedTrade, Position, SymbolSpec

DEFAULT_SPECS = {
    # 1 lot EURUSD: 1 tick (0.00001) = $1  ->  a 20-pip stop risks $200 per lot
    "EURUSD": SymbolSpec("EURUSD", 0.01, 0.01, 100.0, 0.00001, 1.0, 5),
    "GBPUSD": SymbolSpec("GBPUSD", 0.01, 0.01, 100.0, 0.00001, 1.0, 5),
    "USDJPY": SymbolSpec("USDJPY", 0.01, 0.01, 100.0, 0.001, 0.68, 3),

    # Approximate USD-account tick values for simulation only.
    # Live MT5 trading always obtains contract values from the broker.
    "AUDUSD": SymbolSpec("AUDUSD", 0.01, 0.01, 100.0, 0.00001, 1.00, 5),
    "NZDUSD": SymbolSpec("NZDUSD", 0.01, 0.01, 100.0, 0.00001, 1.00, 5),
    "USDCAD": SymbolSpec("USDCAD", 0.01, 0.01, 100.0, 0.00001, 0.74, 5),
    "USDCHF": SymbolSpec("USDCHF", 0.01, 0.01, 100.0, 0.00001, 1.10, 5),
    "EURGBP": SymbolSpec("EURGBP", 0.01, 0.01, 100.0, 0.00001, 1.25, 5),
    "EURJPY": SymbolSpec("EURJPY", 0.01, 0.01, 100.0, 0.001, 0.68, 3),
    "GBPJPY": SymbolSpec("GBPJPY", 0.01, 0.01, 100.0, 0.001, 0.68, 3),
    "EURCHF": SymbolSpec("EURCHF", 0.01, 0.01, 100.0, 0.00001, 1.10, 5),

    # SIMULATION ASSUMPTION ONLY: illustrative 100 oz XAUUSD contract.
    # $0.01 tick = $1.00 per 1.0 lot. Live MT5 always uses broker specifications.
    "XAUUSD": SymbolSpec("XAUUSD", 0.01, 0.01, 100.0, 0.01, 1.0, 2),
}

START = {
    "EURUSD": 1.10,
    "GBPUSD": 1.30,
    "USDJPY": 150.0,
    "AUDUSD": 0.66,
    "NZDUSD": 0.60,
    "USDCAD": 1.35,
    "USDCHF": 0.90,
    "EURGBP": 0.85,
    "EURJPY": 165.0,
    "GBPJPY": 190.0,
    "EURCHF": 0.95,
    "XAUUSD": 2000.0,
}


class SimBroker:
    def __init__(self, equity=10000.0, seed=1, spread_pips=1.0, sigma=0.0005,
                 commission_per_lot=7.0, t0=1_700_000_000.0, trend=0.0, bar_minutes=60,
                 specs=None, start_prices=None, spread_prices=None, sigma_by_symbol=None):
        self.rng = random.Random(seed)
        self.specs = dict(DEFAULT_SPECS)
        if specs:
            self.specs.update(specs)
        self.mid = dict(START)
        if start_prices:
            self.mid.update(start_prices)
        missing_prices = set(self.specs) - set(self.mid)
        if missing_prices:
            raise ValueError("Missing simulator start prices: " + ", ".join(sorted(missing_prices)))
        self.balance = equity
        self.spread_pips, self.sigma, self.commission = spread_pips, sigma, commission_per_lot
        # Explicit price-unit spreads and fractional-return volatility per instrument.
        # Gold defaults are illustrative; calibrate from the target broker's history.
        self.spread_prices = {"XAUUSD": 0.30}
        self.spread_prices.update(spread_prices or {})
        self.sigma_by_symbol = {"XAUUSD": 0.0012}
        self.sigma_by_symbol.update(sigma_by_symbol or {})
        self.t = t0
        self._positions, self.history = {}, {}
        self._ticket = 1000
        self.fail_next = None
        self.connected = True
        self.send_calls = 0
        self.bar_minutes = bar_minutes           # 60 = hourly bars (default), 5 = M5 bars
        self.trend = trend                       # >0 adds slow persistent drifts (trending market)
        self._drift = {k: 0.0 for k in self.mid}
        self.bars = {k: [] for k in self.mid}    # completed hourly candles (mid prices)

    # ---- helpers ----
    def _guard(self):
        if not self.connected:
            raise ConnectionError("sim broker offline")

    def _half_spread(self, sym):
        if sym in self.spread_prices:
            return self.spread_prices[sym] / 2
        spec = self.specs[sym]
        return self.spread_pips * (10 * spec.tick_size) / 2

    def shutdown(self):
        """Disconnect the simulator without liquidating open positions."""
        self.connected = False

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

    def floating_net_pnl(self, position):
        """Net P&L at the executable close price, including commission."""
        self._guard()
        bid, ask = self.quote(position.symbol)
        exit_price = bid if position.side == "BUY" else ask
        return self._pnl(position, exit_price)

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
    def step(self, dt=None, micro=6):
        """Advance one bar. Stops/targets are checked on every micro-step."""
        f = self.bar_minutes / 60.0
        dt = dt or self.bar_minutes * 60.0
        if self.trend > 0:
            for sym in self.mid:
                self._drift[sym] = 0.998 ** f * self._drift[sym] + self.rng.gauss(0, self.trend * f ** 0.5)
        opens = dict(self.mid)
        hi, lo = dict(self.mid), dict(self.mid)
        for _ in range(micro):
            for sym in self.mid:
                symbol_sigma = self.sigma_by_symbol.get(sym, self.sigma)
                self.mid[sym] *= 1 + self.rng.gauss(0, symbol_sigma * f ** 0.5 / micro ** 0.5) + self._drift[sym] * f / micro
                hi[sym], lo[sym] = max(hi[sym], self.mid[sym]), min(lo[sym], self.mid[sym])
            for p in list(self._positions.values()):
                bid, ask = self.quote(p.symbol)
                px = bid if p.side == "BUY" else ask
                hit_sl = px <= p.sl if p.side == "BUY" else px >= p.sl
                hit_tp = px >= p.tp if p.side == "BUY" else px <= p.tp
                if hit_sl:
                    self._close(p, p.sl)
                elif hit_tp:
                    self._close(p, p.tp)
        for sym in self.mid:
            self.bars[sym].append((self.t, opens[sym], hi[sym], lo[sym], self.mid[sym]))
        self.t += dt

    def warmup(self, bars=800):
        """Generate price history before trading starts (no positions exist yet)."""
        for _ in range(bars):
            self.step()

    def candles(self, symbol, n, tf="H1"):
        """Return completed candles; M1 simulations can be aggregated to higher TFs."""
        self._guard()
        rows = self.bars[symbol]
        df = pd.DataFrame(rows, columns=["time", "open", "high", "low", "close"])
        df.index = pd.to_datetime(df.pop("time"), unit="s")

        # Existing simulations retain their native-bar behaviour.
        if self.bar_minutes != 1 or tf == "M1":
            return df.tail(n)

        minutes = {"M1": 1, "M5": 5, "M15": 15, "H1": 60}.get(tf)
        if minutes is None:
            raise ValueError(f"Unsupported timeframe: {tf}")

        if minutes == 1:
            return df.tail(n)

        # Aggregate bars using their epoch-aligned opening times.
        grouped = df.groupby(df.index.floor(f"{minutes}min")).agg({
            "open": "first",
            "high": "max",
            "low": "min",
            "close": "last",
        })

        # Never expose a higher-timeframe candle before it has fully closed.
        completed_at = pd.to_datetime(self.t, unit="s")
        grouped = grouped.loc[
            grouped.index + pd.Timedelta(minutes=minutes) <= completed_at
        ]
        return grouped.tail(n)
