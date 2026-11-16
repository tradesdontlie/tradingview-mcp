"""Scanner: proposes candidate trades by running the checklist's market items on both sides."""
from .checklist import market_checks
from .models import Signal


class ScannerStrategy:
    def __init__(self, cfg, symbols, cache):
        self.cfg, self.symbols, self.cache, self.last_bar = cfg, symbols, cache, {}

    def __call__(self, now, broker):
        out = []
        for sym in self.symbols:
            ctx = self.cache.get(broker, sym)
            if ctx is None or self.last_bar.get(sym) == ctx.index[-1]:
                continue                                  # one look per symbol per bar
            self.last_bar[sym] = ctx.index[-1]
            row = ctx.iloc[-1].to_dict()
            bid, ask = broker.quote(sym)
            for side in ("BUY", "SELL"):
                res = market_checks(row, side, ask - bid, self.cfg)
                if res.passed:
                    out.append(Signal(sym, side, res.stop, now, res.trigger))
        return out
