"""Scanner: proposes candidate trades by running the checklist's market items on both sides."""
from .checklist import market_checks, multi_timeframe_checks
from .costs import extra_cost_price
from .models import Signal


class ScannerStrategy:
    def __init__(self, cfg, symbols, cache):
        self.cfg, self.symbols, self.cache, self.last_bar = cfg, symbols, cache, {}

    def __call__(self, now, broker):
        out = []
        for sym in self.symbols:
            ctx = self.cache.get(broker, sym)
            if ctx is None:
                continue
            entry_ctx = ctx["M1"] if isinstance(ctx, dict) else ctx
            bar_key = entry_ctx.index[-1]
            if self.last_bar.get(sym) == bar_key:
                continue
            self.last_bar[sym] = bar_key
            bid, ask = broker.quote(sym)
            cost = ask - bid + extra_cost_price(broker.spec(sym), self.cfg)
            for side in ("BUY", "SELL"):
                if isinstance(ctx, dict):
                    _, res = multi_timeframe_checks(ctx, side, cost, self.cfg)
                else:
                    row = ctx.iloc[-1].to_dict()
                    res = market_checks(row, side, cost, self.cfg)
                if res.passed:
                    bar_stamp = (
                        int(bar_key.timestamp())
                        if callable(getattr(bar_key, "timestamp", None))
                        else str(bar_key)
                    )
                    signal_id = f"{sym}:{side}:{res.trigger}:{bar_stamp}"
                    out.append(Signal(
                        sym, side, res.stop, now, res.trigger, res.quality_score,
                        signal_id=signal_id,
                    ))
        return out
