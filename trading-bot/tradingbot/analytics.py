"""Performance and tree statistics straight from the database."""


def summarize(db) -> dict:
    nodes = db.nodes()
    done = [n for n in nodes if n["state"] in ("WON", "LOST")]
    wins = [n["net_pnl"] for n in done if n["state"] == "WON"]
    losses = [n["net_pnl"] for n in done if n["state"] == "LOST"]
    gross_win, gross_loss = sum(wins), -sum(losses)
    series, peak, equity, max_dd = sorted(done, key=lambda n: n["closed_ts"] or 0), 0.0, 0.0, 0.0
    for n in series:
        equity += n["net_pnl"]
        peak = max(peak, equity)
        max_dd = max(max_dd, peak - equity)
    states = {}
    for n in nodes:
        states[n["state"]] = states.get(n["state"], 0) + 1
    by_level = {}
    for n in done:
        lv = by_level.setdefault(n["level"], {"trades": 0, "net": 0.0})
        lv["trades"] += 1
        lv["net"] += n["net_pnl"]
    roots = [n for n in nodes if n["level"] == 0 and n["state"] in ("WON", "LOST")]
    return {
        "trades": len(done),
        "win_rate": len(wins) / len(done) if done else 0.0,
        "net_pnl": gross_win - gross_loss,
        "profit_factor": gross_win / gross_loss if gross_loss else float("inf"),
        "expectancy": (gross_win - gross_loss) / len(done) if done else 0.0,
        "max_drawdown": max_dd,
        "roots": len(roots),
        "trades_per_root": len(done) / len(roots) if roots else 0.0,
        "states": states,
        "by_level": by_level,
        "root_pool": float(db.kv_get("root_pool", 0.0)),
    }
