#!/usr/bin/env python3
"""Contract gate.

The shapes below were read off the compiled Perplexity bundle — the components
index into these fields directly, so a missing key renders as a blank card or
throws in the browser. bake.py refuses to write anything that fails here.
"""

NUM = (int, float)


def _num(value, null_ok=True):
    if value is None:
        return null_ok
    return isinstance(value, NUM) and not isinstance(value, bool)


def _str(value, null_ok=True):
    if value is None:
        return null_ok
    return isinstance(value, str)


def validate_all(p):
    errors = []
    e = errors.append

    def need(cond, msg):
        if not cond:
            e(msg)

    # ---- regime-gauge
    r = p["regime-gauge"]
    need(_num(r["score"]), "regime-gauge.score must be number|null")
    need(r["score"] is None or 0 <= r["score"] <= 100, "regime-gauge.score out of 0-100")
    need(_str(r["label"]), "regime-gauge.label must be string|null")
    need(r["trend"] in ("Improving", "Deteriorating", "Steady", None),
         f"regime-gauge.trend invalid: {r['trend']!r}")
    need(_num(r["scoreDelta"]), "regime-gauge.scoreDelta must be number|null")
    need(isinstance(r["componentsNote"], str), "regime-gauge.componentsNote must be string")
    need(_num(r["breadthPct"]), "regime-gauge.breadthPct must be number|null")
    need(_num(r["vixLevel"]), "regime-gauge.vixLevel must be number|null")
    need(isinstance(r["updatedAt"], str), "regime-gauge.updatedAt must be an ISO string")

    # ---- scorecard
    assets = p["scorecard"]["assets"]
    need(isinstance(assets, list) and assets, "scorecard.assets must be a non-empty list")
    for a in assets:
        tag = f"scorecard[{a.get('symbol')}]"
        for k in ("symbol", "label", "assetClass"):
            need(isinstance(a.get(k), str), f"{tag}.{k} must be a string")
        for k in ("price", "changePct1D", "changePct1W", "changePct1M", "changePct3M"):
            need(_num(a.get(k)), f"{tag}.{k} must be number|null")
        need(isinstance(a.get("sparkline"), list), f"{tag}.sparkline must be a list")
        need(all(_num(x, null_ok=False) for x in a["sparkline"]),
             f"{tag}.sparkline must hold only numbers")
        for k in ("above50d", "above200d"):
            need(a.get(k) is None or isinstance(a[k], bool), f"{tag}.{k} must be bool|null")
        need(_str(a.get("gapReason")), f"{tag}.gapReason must be string|null")
        # The card shows a gap chip only when price is null AND gapReason is set;
        # a null price with no reason renders a silent blank.
        need(not (a["price"] is None and a["gapReason"] is None),
             f"{tag} has a null price with no gapReason — would render blank")

    # ---- credit-stress
    c = p["credit-stress"]
    need(isinstance(c.get("vix"), dict), "credit-stress.vix must be an object")
    need(_num(c["vix"].get("price")), "credit-stress.vix.price must be number|null")
    need(_num(c["vix"].get("changePct")), "credit-stress.vix.changePct must be number|null")
    need(c["stressLabel"] in ("Widening", "Tightening", "Stable", None),
         f"credit-stress.stressLabel invalid: {c['stressLabel']!r}")
    for k in ("hygLqdRatioChangePct1M", "hygTltRatioChangePct1M", "lqdTltRatioChangePct1M"):
        need(_num(c.get(k)), f"credit-stress.{k} must be number|null")

    # ---- vol-stress-radar
    v = p["vol-stress-radar"]
    need(isinstance(v.get("methodologyNote"), str), "radar.methodologyNote must be a string")
    need(isinstance(v.get("synthesis"), str), "radar.synthesis must be a string")
    need(_num(v.get("compositeScore")), "radar.compositeScore must be number|null")
    need(v.get("tier") in ("WARNING", "WATCH", "CLEAR", None),
         f"radar.tier invalid: {v.get('tier')!r}")
    need(isinstance(v.get("tells"), list), "radar.tells must be a list")
    for t in v["tells"]:
        tag = f"radar.tells[{t.get('id')}]"
        for k in ("id", "name", "explanation"):
            need(isinstance(t.get(k), str), f"{tag}.{k} must be a string")
        need(t.get("status") in ("ALERT", "WATCH", "CALM", None), f"{tag}.status invalid")
        need(_str(t.get("displayValue")), f"{tag}.displayValue must be string|null")
        # The row renders (weight*100).toFixed(0) unconditionally.
        need(_num(t.get("weight"), null_ok=False), f"{tag}.weight must be a number")
        need(_str(t.get("gapReason")), f"{tag}.gapReason must be string|null")
        need(not (t["gapReason"] is None and t["status"] is None),
             f"{tag} has neither a status nor a gapReason")

    # ---- macro
    countries = p["macro"]["countries"]
    need(isinstance(countries, dict) and countries, "macro.countries must be a non-empty object")
    for country, rows in countries.items():
        need(isinstance(rows, list), f"macro[{country}] must be a list")
        for row in rows:
            need(isinstance(row.get("indicator"), str), f"macro[{country}].indicator must be a string")
            need(_num(row.get("latestValue")), f"macro[{country}].latestValue must be number|null")
            need(isinstance(row.get("unit"), str), f"macro[{country}].unit must be a string")

    # ---- smart-money
    s = p["smart-money"]
    need(isinstance(s.get("holders"), dict), "smart-money.holders must be an object")
    need(isinstance(s.get("crowding"), dict), "smart-money.crowding must be an object")
    need(isinstance(s.get("trades"), list), "smart-money.trades must be a list")
    need(s.get("tradeTilt") is None or isinstance(s["tradeTilt"].get("label"), str),
         "smart-money.tradeTilt.label must be a string when tradeTilt is present")
    for ticker, rows in s["holders"].items():
        need(isinstance(rows, list), f"smart-money.holders[{ticker}] must be a list")
        for h in rows:
            need(isinstance(h.get("institution"), str),
                 f"smart-money.holders[{ticker}].institution must be a string")
            for k in ("shares", "value", "qoqChangePct"):
                need(_num(h.get(k)), f"smart-money.holders[{ticker}].{k} must be number|null")
    for ticker, cr in s["crowding"].items():
        need(isinstance(cr, dict), f"smart-money.crowding[{ticker}] must be an object")
        need(_str(cr.get("label")), f"smart-money.crowding[{ticker}].label must be string|null")
        need(_num(cr.get("topHolderSharePct")),
             f"smart-money.crowding[{ticker}].topHolderSharePct must be number|null")
    for t in s["trades"]:
        for k in ("date", "politician", "ticker", "type", "amount"):
            need(isinstance(t.get(k), str), f"smart-money.trades.{k} must be a string")
        need(t.get("type") in ("Buy", "Sell"),
             f"smart-money.trades.type invalid: {t.get('type')!r}")

    # ---- analyst-research
    for row in p["analyst-research"]["ratings"]:
        need(isinstance(row.get("ticker"), str), "analyst-research.ticker must be a string")
        for k in ("lowPriceTarget", "avgPriceTarget", "highPriceTarget"):
            need(_num(row.get(k)), f"analyst-research.{k} must be number|null")

    # ---- market-pulse
    mp = p["market-pulse"]
    for bucket in ("gainers", "losers", "mostActive"):
        need(isinstance(mp.get(bucket), list), f"market-pulse.{bucket} must be a list")
        for row in mp[bucket]:
            need(isinstance(row.get("symbol"), str), f"market-pulse.{bucket}.symbol must be a string")
            need(isinstance(row.get("name"), str), f"market-pulse.{bucket}.name must be a string")
            need(_num(row.get("price")), f"market-pulse.{bucket}.price must be number|null")
            need(_num(row.get("changePct")), f"market-pulse.{bucket}.changePct must be number|null")

    # ---- backtest
    bt = p["backtest"]
    need(isinstance(bt.get("disclaimer"), str), "backtest.disclaimer must be a string")
    need(isinstance(bt.get("results"), list), "backtest.results must be a list")
    for res in bt["results"]:
        tag = f"backtest[{res.get('symbol')}]"
        for k in ("symbol", "label", "ruleDescription"):
            need(isinstance(res.get(k), str), f"{tag}.{k} must be a string")
        need(_str(res.get("gapReason")), f"{tag}.gapReason must be string|null")
        need(isinstance(res.get("curve"), list), f"{tag}.curve must be a list")
        if res["gapReason"] is None:
            # The chart renders only when gapReason is null and curve has >1 point.
            need(len(res["curve"]) > 1, f"{tag} has no gapReason but a curve of "
                                        f"{len(res['curve'])} points")
            need(isinstance(res.get("tradingDays"), int), f"{tag}.tradingDays must be an int")
            for side in ("strategy", "benchmark"):
                stats = res.get(side) or {}
                for k in ("cumulativeReturnPct", "cagrPct", "maxDrawdownPct", "sharpeRatio"):
                    need(k in stats and _num(stats[k]), f"{tag}.{side}.{k} must be number|null")
            need(_num(res.get("strategyBenchmarkCorrelation")),
                 f"{tag}.strategyBenchmarkCorrelation must be number|null")
            for point in res["curve"]:
                need(isinstance(point.get("date"), str), f"{tag}.curve.date must be a string")
                need(_num(point.get("strategy"), null_ok=False),
                     f"{tag}.curve.strategy must be a number")
                need(_num(point.get("benchmark"), null_ok=False),
                     f"{tag}.curve.benchmark must be a number")
            st = res.get("stressTest")
            if st is not None:
                need(_num(st.get("costBps"), null_ok=False), f"{tag}.stressTest.costBps must be a number")
                for var in st.get("variants", []):
                    for k in ("id", "label", "description"):
                        need(isinstance(var.get(k), str), f"{tag}.stressTest.{k} must be a string")
                    for k in ("cagrPct", "sharpeRatio", "maxDrawdownPct"):
                        need(_num((var.get("stats") or {}).get(k)),
                             f"{tag}.stressTest.stats.{k} must be number|null")

    # ---- alerts
    for a in p["alerts"]["alerts"]:
        need(isinstance(a.get("id"), str), "alerts.id must be a string")
        need(a.get("severity") in ("warning", "info"), f"alerts.severity invalid: {a.get('severity')!r}")
        need(isinstance(a.get("message"), str), "alerts.message must be a string")
        need(isinstance(a.get("detectedAt"), str), "alerts.detectedAt must be an ISO string")
    ids = [a["id"] for a in p["alerts"]["alerts"]]
    need(len(ids) == len(set(ids)), "alerts.id values must be unique — they are React keys")

    # ---- summary
    need(isinstance(p["summary"].get("sentence"), str), "summary.sentence must be a string")

    # ---- freshness
    srcs = p["freshness"]["sources"]
    need(isinstance(srcs, list), "freshness.sources must be a list")
    for src in srcs:
        need(isinstance(src.get("id"), str), "freshness.id must be a string")
        need(isinstance(src.get("label"), str), "freshness.label must be a string")
        need(src.get("level") in ("live", "ok", "stale", "error"),
             f"freshness.level invalid: {src.get('level')!r}")
        need(_num(src.get("ageSeconds")), "freshness.ageSeconds must be number|null")
        need(isinstance(src.get("cadenceNote"), str), "freshness.cadenceNote must be a string")

    return errors
