"""Cost model and affordability: can this account trade this symbol at all, and what does a trade cost?

A $10 account is limited by the broker's minimum lot. The rule from the blueprint: if the smallest
permitted trade risks more than the risk budget, the correct action is NO TRADE. All amounts are in
ACCOUNT currency, so cent accounts (balance in cents) work unchanged.
"""


def extra_cost_price(spec, cfg) -> float:
    """Commission and slippage expressed in PRICE units, to add to the spread."""
    comm = 0.0
    if cfg.commission_per_lot and spec.tick_value > 0:
        comm = cfg.commission_per_lot / (spec.tick_value / spec.tick_size)   # price move worth 1 lot's commission
    return comm + cfg.slippage_price


def affordability(spec, equity: float, cfg, stop_distance: float, spread: float = 0.0) -> dict:
    per_lot = stop_distance / spec.tick_size * spec.tick_value             # loss per 1.0 lot at this stop
    min_risk = spec.volume_min * per_lot                                   # loss at the smallest allowed trade
    pct = min(cfg.root_risk_pct, cfg.max_trade_risk_pct)
    budget = pct * equity
    return {"min_risk": min_risk, "budget": budget, "ok": min_risk <= budget,
            "needs_equity": min_risk / pct if pct else float("inf"),
            "cost_r": (spread + extra_cost_price(spec, cfg)) / stop_distance if stop_distance else float("inf")}
