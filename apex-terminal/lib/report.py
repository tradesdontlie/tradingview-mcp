#!/usr/bin/env python3
"""Render the baked payloads as one self-contained HTML snapshot.

The Artifact sandbox blocks every external host except Google Fonts, so the
page cannot fetch /api/* the way the terminal does. Everything is inlined at
generation time, which also makes the snapshot a durable record of one bake
rather than a live view that silently changes underneath its own timestamp.

    python3 lib/report.py [--out PATH]
"""
import argparse, datetime, html, json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = os.path.join(ROOT, "public", "api")
DEFAULT_OUT = os.path.join(ROOT, "report", "apex-readout.html")

E = html.escape


def load():
    out = {}
    for name in os.listdir(API):
        path = os.path.join(API, name)
        if os.path.isfile(path):
            with open(path, encoding="utf-8") as fh:
                out[name] = json.load(fh)
    return out


def num(value, digits=2, dash="—"):
    if value is None or isinstance(value, bool):
        return dash
    return f"{value:,.{digits}f}"


def signed(value, digits=2):
    if value is None:
        return "—"
    return f"{value:+.{digits}f}%"


def tone(value):
    if value is None:
        return "flat"
    if value > 0.005:
        return "up"
    if value < -0.005:
        return "down"
    return "flat"


def sparkline(values, width=104, height=30):
    """Area-filled sparkline with an emphasised endpoint."""
    pts = [v for v in (values or []) if isinstance(v, (int, float))]
    if len(pts) < 2:
        return '<span class="spark-empty">—</span>'
    lo, hi = min(pts), max(pts)
    span = (hi - lo) or 1.0
    step = width / (len(pts) - 1)
    xy = [(i * step, height - (v - lo) / span * (height - 4) - 2) for i, v in enumerate(pts)]
    line = " ".join(f"{x:.1f},{y:.1f}" for x, y in xy)
    area = f"0,{height} " + line + f" {width},{height}"
    rising = pts[-1] >= pts[0]
    cls = "up" if rising else "down"
    ex, ey = xy[-1]
    return (f'<svg class="spark {cls}" viewBox="0 0 {width} {height}" width="{width}" '
            f'height="{height}" aria-hidden="true">'
            f'<polygon points="{area}"/><polyline points="{line}"/>'
            f'<circle cx="{ex:.1f}" cy="{ey:.1f}" r="1.9"/></svg>')


def chip(label, kind):
    return f'<span class="chip {kind}">{E(label)}</span>'


STATUS_KIND = {"ALERT": "alert", "WATCH": "watch", "CALM": "calm",
               "WARNING": "alert", "CLEAR": "calm"}


def build(p):
    regime = p.get("regime-gauge", {})
    radar = p.get("vol-stress-radar", {})
    credit = p.get("credit-stress", {})
    scorecard = p.get("scorecard", {}).get("assets", [])
    macro = p.get("macro", {}).get("countries", {})
    smart = p.get("smart-money", {})
    analyst = p.get("analyst-research", {}).get("ratings", [])
    pulse = p.get("market-pulse", {})
    backtest = p.get("backtest", {})
    alerts = p.get("alerts", {}).get("alerts", [])
    fresh = p.get("freshness", {}).get("sources", [])
    summary = p.get("summary", {}).get("sentence", "")

    manifest = {}
    mpath = os.path.join(ROOT, "build-manifest.json")
    if os.path.isfile(mpath):
        with open(mpath, encoding="utf-8") as fh:
            manifest = json.load(fh)

    baked = manifest.get("baked_at", "")
    try:
        stamp = datetime.datetime.fromisoformat(baked).strftime("%d %B %Y · %H:%M %Z").strip()
    except ValueError:
        stamp = baked

    score = regime.get("score")
    parts = []

    # ---------------------------------------------------------- masthead
    dial = ""
    if score is not None:
        pct = max(0.0, min(100.0, score)) / 100.0
        r = 52
        circ = 3.14159265 * r
        dial = (f'<svg class="dial" viewBox="0 0 120 64" width="120" height="64" '
                f'role="img" aria-label="Regime score {score:.0f} of 100">'
                f'<path d="M 8 58 A {r} {r} 0 0 1 112 58" class="dial-track"/>'
                f'<path d="M 8 58 A {r} {r} 0 0 1 112 58" class="dial-value" '
                f'stroke-dasharray="{circ:.1f}" stroke-dashoffset="{circ * (1 - pct):.1f}"/>'
                f'</svg>')

    trend = regime.get("trend")
    delta = regime.get("scoreDelta")
    trend_txt = ""
    if trend:
        d = f" ({delta:+.1f})" if isinstance(delta, (int, float)) else ""
        trend_txt = f'<span class="trend {trend.lower()}">{E(trend)}{d}</span>'

    parts.append(f'''
<header class="masthead">
  <div class="brand">
    <span class="mark">APEX</span>
    <span class="kicker">Macro &amp; Liquidity Readout</span>
  </div>
  <div class="stamp">{E(stamp)}</div>
</header>

<section class="thesis">
  <div class="dial-wrap">
    {dial}
    <div class="dial-score">{num(score, 0)}<span>/100</span></div>
  </div>
  <div class="thesis-copy">
    <h1>{E(regime.get("label") or "Regime unavailable")} {trend_txt}</h1>
    <p class="lede">{E(summary)}</p>
    <p class="method">{E(regime.get("componentsNote") or "")}</p>
  </div>
  <dl class="thesis-stats">
    <div><dt>Trend breadth</dt><dd>{num(regime.get("breadthPct"), 0)}%</dd></div>
    <div><dt>VIX</dt><dd>{num(regime.get("vixLevel"))}</dd></div>
    <div><dt>Credit</dt><dd>{E(regime.get("creditTrend") or "—")}</dd></div>
  </dl>
</section>''')

    # ------------------------------------------------------ source lamps
    lamps = "".join(
        f'<li class="lamp {E(s.get("level", "error"))}"><span class="dot"></span>'
        f'{E(s.get("label", ""))}</li>' for s in fresh)
    parts.append(f'<ul class="lamps">{lamps}</ul>')

    # ------------------------------------------------------------ alerts
    if alerts:
        rows = "".join(
            f'<li class="{E(a.get("severity", "info"))}">'
            f'{chip("Warning" if a.get("severity") == "warning" else "Info", "alert" if a.get("severity") == "warning" else "info")}'
            f'<span>{E(a.get("message", ""))}</span></li>' for a in alerts)
        parts.append(f'<section class="block"><h2>Alerts</h2><ul class="alerts">{rows}</ul></section>')

    # ------------------------------------------------------ stress radar
    tier = radar.get("tier")
    tells = radar.get("tells", [])
    tell_rows = ""
    for t in tells:
        status = t.get("status")
        badge = (chip(status, STATUS_KIND.get(status, "calm")) if status
                 else chip(t.get("gapReason") or "no data", "gap"))
        weight = (t.get("weight") or 0) * 100
        tell_rows += f'''
      <tr>
        <td class="tell-name"><span>{E(t.get("name", ""))}</span>
            <em>{E(t.get("explanation", ""))}</em></td>
        <td class="tell-status">{badge}</td>
        <td class="tell-value">{E(str(t.get("displayValue") or "—"))}</td>
        <td class="tell-weight">
          <span class="wbar"><i style="width:{weight:.0f}%"></i></span>
          <span class="wnum">{weight:.0f}%</span>
        </td>
      </tr>'''

    parts.append(f'''
<section class="block">
  <div class="block-head">
    <h2>Volatility &amp; stress radar</h2>
    <div class="radar-score">{chip(tier or "—", STATUS_KIND.get(tier, "gap"))}
      <strong>{num(radar.get("compositeScore"), 0)}<span>/100</span></strong></div>
  </div>
  <p class="synthesis">{E(radar.get("synthesis") or "")}</p>
  <div class="scroll"><table class="tells">
    <thead><tr><th>Tell</th><th>Status</th><th class="r">Reading</th><th>Weight</th></tr></thead>
    <tbody>{tell_rows}</tbody>
  </table></div>
</section>''')

    # -------------------------------------------------------- scorecard
    cards = ""
    for a in scorecard:
        gap = a.get("gapReason")
        price = chip(gap, "gap") if (a.get("price") is None and gap) else num(a.get("price"))
        flags = ""
        for key, label in (("above50d", "50D"), ("above200d", "200D")):
            v = a.get(key)
            k = "calm" if v else ("alert" if v is False else "gap")
            flags += f'<span class="flag {k}">{label}</span>'
        cards += f'''
    <article class="asset">
      <div class="asset-top">
        <div><h3>{E(a.get("label", ""))}</h3><span class="klass">{E(a.get("assetClass", ""))}</span></div>
        <span class="delta {tone(a.get("changePct1D"))}">{signed(a.get("changePct1D"))}</span>
      </div>
      <div class="asset-mid"><span class="price">{price}</span>{sparkline(a.get("sparkline"))}</div>
      <div class="asset-windows">
        <span><em>1W</em><b class="{tone(a.get("changePct1W"))}">{signed(a.get("changePct1W"))}</b></span>
        <span><em>1M</em><b class="{tone(a.get("changePct1M"))}">{signed(a.get("changePct1M"))}</b></span>
        <span><em>3M</em><b class="{tone(a.get("changePct3M"))}">{signed(a.get("changePct3M"))}</b></span>
      </div>
      <div class="asset-flags">{flags}</div>
    </article>'''

    vix = credit.get("vix", {})
    parts.append(f'''
<section class="block">
  <div class="block-head"><h2>Cross-asset scorecard</h2>
    <span class="note">Live closes · 1D / 1W / 1M / 3M</span></div>
  <div class="assets">{cards}</div>
  <div class="credit-strip">
    <div><dt>VIX</dt><dd>{num(vix.get("price"))} <i class="{tone(vix.get("changePct"))}">{signed(vix.get("changePct"))}</i></dd></div>
    <div><dt>Credit signal</dt><dd>{E(credit.get("stressLabel") or "—")}</dd></div>
    <div><dt>HYG / LQD 1M</dt><dd class="{tone(credit.get("hygLqdRatioChangePct1M"))}">{signed(credit.get("hygLqdRatioChangePct1M"))}</dd></div>
    <div><dt>HYG / TLT 1M</dt><dd class="{tone(credit.get("hygTltRatioChangePct1M"))}">{signed(credit.get("hygTltRatioChangePct1M"))}</dd></div>
    <div><dt>LQD / TLT 1M</dt><dd class="{tone(credit.get("lqdTltRatioChangePct1M"))}">{signed(credit.get("lqdTltRatioChangePct1M"))}</dd></div>
  </div>
</section>''')

    # ------------------------------------------------------------- macro
    macro_cols = ""
    for country, rows in macro.items():
        items = ""
        for r in rows:
            val = r.get("latestValue")
            unit = "%" if r.get("unit") == "percent" else ""
            shown = "—" if val is None else f"{val:,.2f}{unit}"
            stale = ' <span class="stale" title="Series no longer published">stale</span>' if r.get("stale") else ""
            items += (f'<div><dt>{E(r.get("indicator", ""))}</dt>'
                      f'<dd>{shown}{stale}</dd></div>')
        macro_cols += f'<div class="macro-col"><h3>{E(country)}</h3><dl>{items}</dl></div>'
    parts.append(f'''
<section class="block">
  <div class="block-head"><h2>Macro snapshot</h2>
    <span class="note">FRED · OECD · Eurostat</span></div>
  <div class="macro">{macro_cols}</div>
</section>''')

    # ------------------------------------------------------ smart money
    holders = smart.get("holders", {})
    holder_rows = ""
    for ticker, rows in holders.items():
        if not rows:
            holder_rows += f'<tr><td>{E(ticker)}</td><td colspan="4">—</td></tr>'
            continue
        top = rows[0]
        crowd = (smart.get("crowding") or {}).get(ticker) or {}
        share = crowd.get("topHolderSharePct")
        badge = (f'<span class="crowd">{E(crowd.get("label") or "")}'
                 f'{f" · {share:.0f}%" if isinstance(share, (int, float)) else ""}</span>'
                 if crowd.get("label") else "")
        value = top.get("value")
        holder_rows += f'''
      <tr><td class="tk">{E(ticker)}{badge}</td>
          <td>{E(top.get("institution", ""))}</td>
          <td class="r">{num((top.get("shares") or 0) / 1e6, 0)}M</td>
          <td class="r">${num((value or 0) / 1e9, 1)}B</td>
          <td class="r {tone(top.get("qoqChangePct"))}">{signed(top.get("qoqChangePct"))}</td></tr>'''

    trade_rows = "".join(
        f'<tr><td class="mono">{E(t.get("date", ""))}</td><td>{E(t.get("politician", ""))}</td>'
        f'<td class="tk">{E(t.get("ticker", ""))}</td>'
        f'<td>{chip(t.get("type", ""), "calm" if t.get("type") == "Buy" else "watch")}</td>'
        f'<td class="r mono">{E(t.get("amount", ""))}</td></tr>'
        for t in (smart.get("trades") or [])[:12]) or \
        '<tr><td colspan="5">No transactions parsed.</td></tr>'

    analyst_rows = "".join(
        f'<tr><td class="tk">{E(a.get("ticker", ""))}</td>'
        f'<td class="r">{num(a.get("lowPriceTarget"))}</td>'
        f'<td class="r strong">{num(a.get("avgPriceTarget"))}</td>'
        f'<td class="r">{num(a.get("highPriceTarget"))}</td>'
        f'<td class="r">{a.get("numAnalysts") if a.get("numAnalysts") is not None else "—"}</td></tr>'
        for a in analyst) or '<tr><td colspan="5">—</td></tr>'

    parts.append(f'''
<section class="block">
  <div class="block-head"><h2>Smart money</h2>
    <span class="note">Nasdaq 13F · House Clerk filings</span></div>
  <div class="two-up">
    <div><h3 class="sub">Top institutional holder</h3>
      <div class="scroll"><table>
        <thead><tr><th>Ticker</th><th>Institution</th><th class="r">Shares</th><th class="r">Value</th><th class="r">QoQ</th></tr></thead>
        <tbody>{holder_rows}</tbody></table></div></div>
    <div><h3 class="sub">Recent congressional trades</h3>
      <div class="scroll"><table>
        <thead><tr><th>Traded</th><th>Member</th><th>Ticker</th><th>Type</th><th class="r">Amount</th></tr></thead>
        <tbody>{trade_rows}</tbody></table></div></div>
  </div>
  <h3 class="sub">Analyst price targets</h3>
  <div class="scroll"><table>
    <thead><tr><th>Ticker</th><th class="r">Low</th><th class="r">Consensus</th><th class="r">High</th><th class="r">Analysts</th></tr></thead>
    <tbody>{analyst_rows}</tbody></table></div>
</section>''')

    # ---------------------------------------------------------- backtest
    bt_rows = ""
    for r in backtest.get("results", []):
        if r.get("gapReason"):
            bt_rows += f'<tr><td>{E(r.get("symbol",""))}</td><td colspan="7">{chip(r["gapReason"], "gap")}</td></tr>'
            continue
        s_, b_ = r.get("strategy", {}), r.get("benchmark", {})
        bt_rows += f'''
      <tr><td class="tk">{E(r.get("symbol", ""))}</td>
          <td class="r">{signed(s_.get("cagrPct"), 1)}</td>
          <td class="r">{num(s_.get("sharpeRatio"))}</td>
          <td class="r down">{signed(s_.get("maxDrawdownPct"), 1)}</td>
          <td class="r sep">{signed(b_.get("cagrPct"), 1)}</td>
          <td class="r">{num(b_.get("sharpeRatio"))}</td>
          <td class="r down">{signed(b_.get("maxDrawdownPct"), 1)}</td>
          <td class="r">{num(r.get("strategyBenchmarkCorrelation"))}</td></tr>'''

    first = next((r for r in backtest.get("results", []) if not r.get("gapReason")), {})
    span = (f'{first.get("startDate", "")} → {first.get("endDate", "")} · '
            f'{first.get("tradingDays", 0):,} trading days') if first else ""

    parts.append(f'''
<section class="block">
  <div class="block-head"><h2>200-day trend rule</h2><span class="note">{E(span)}</span></div>
  <div class="scroll"><table class="bt">
    <thead>
      <tr><th rowspan="2">Symbol</th><th colspan="3">Strategy</th><th colspan="3" class="sep">Buy &amp; hold</th><th rowspan="2" class="r">Corr</th></tr>
      <tr><th class="r">CAGR</th><th class="r">Sharpe</th><th class="r">Max DD</th>
          <th class="r sep">CAGR</th><th class="r">Sharpe</th><th class="r">Max DD</th></tr>
    </thead>
    <tbody>{bt_rows}</tbody>
  </table></div>
  <p class="method">{E(backtest.get("disclaimer") or "")}</p>
</section>''')

    # ------------------------------------------------------ market pulse
    def movers(key, title):
        rows = "".join(
            f'<li><span class="tk">{E(m.get("symbol", ""))}</span>'
            f'<span class="mv-name">{E(m.get("name", ""))}</span>'
            f'<span class="mv-px">{num(m.get("price"))}</span>'
            f'<span class="delta {tone(m.get("changePct"))}">{signed(m.get("changePct"))}</span></li>'
            for m in (pulse.get(key) or [])[:6])
        return f'<div><h3 class="sub">{title}</h3><ul class="movers">{rows}</ul></div>'

    parts.append(f'''
<section class="block">
  <div class="block-head"><h2>Market pulse</h2>
    <span class="note">{E(pulse.get("universeNote") or "")}</span></div>
  <div class="three-up">{movers("gainers", "Gainers")}{movers("losers", "Losers")}{movers("mostActive", "Most active")}</div>
</section>''')

    # ------------------------------------------------------------ footer
    gaps = manifest.get("gaps") or {}
    gap_txt = ("Gapped: " + ", ".join(f"{k} ({v})" for k, v in gaps.items())) if gaps else "No source gaps."
    provs = ", ".join(f"{k} {v}" for k, v in (manifest.get("providers") or {}).items())
    parts.append(f'''
<footer class="foot">
  <p class="prov">Baked in {manifest.get("elapsed_seconds", "—")}s from {manifest.get("symbols_loaded", "—")} symbols
     ({E(provs)}) and {manifest.get("macro_series", "—")} macro series. {E(gap_txt)}</p>
  <p>Decision-support analytics only. Not investment advice. Regime scores, trend labels and
     radar tiers are derived heuristics, not market facts. Backtests are illustrative; past
     performance does not predict future results.</p>
</footer>''')

    return "\n".join(parts)


# Design: an instrument-panel readout rather than a trading screen.
# Palette  ground #EEF1F0 cool green-grey paper / ink #12201E green-black /
#          accent #0B6B63 petrol / calm #2F7D62 / watch #A86A0E / alert #A93A2E
# Type     Instrument Serif display, IBM Plex Sans body, IBM Plex Mono data
# Layout   masthead + single measure column; tables ruled, never boxed
CSS = """
:root{
  --ground:#EEF1F0; --surface:#FFFFFF; --surface-2:#F6F8F7;
  --ink:#12201E; --ink-soft:#566B67; --ink-faint:#8496921a;
  --rule:#D4DCDA; --rule-soft:#E4EAE9;
  --accent:#0B6B63;
  --calm:#2F7D62; --watch:#A86A0E; --alert:#A93A2E; --gap:#7C6A45;
  --calm-bg:#2F7D6214; --watch-bg:#A86A0E14; --alert-bg:#A93A2E14; --gap-bg:#7C6A4514;
  --shadow:0 1px 2px #12201E0a;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --ground:#0C1413; --surface:#141D1C; --surface-2:#101817;
    --ink:#E4EDEB; --ink-soft:#93A6A2; --ink-faint:#93A6A21a;
    --rule:#24312F; --rule-soft:#1B2625;
    --accent:#54C5B9;
    --calm:#5FC49B; --watch:#E0A945; --alert:#E4796B; --gap:#C2A97A;
    --calm-bg:#5FC49B1c; --watch-bg:#E0A9451c; --alert-bg:#E4796B1c; --gap-bg:#C2A97A1c;
    --shadow:0 1px 2px #0000004d;
  }
}
:root[data-theme="dark"]{
  --ground:#0C1413; --surface:#141D1C; --surface-2:#101817;
  --ink:#E4EDEB; --ink-soft:#93A6A2; --ink-faint:#93A6A21a;
  --rule:#24312F; --rule-soft:#1B2625;
  --accent:#54C5B9;
  --calm:#5FC49B; --watch:#E0A945; --alert:#E4796B; --gap:#C2A97A;
  --calm-bg:#5FC49B1c; --watch-bg:#E0A9451c; --alert-bg:#E4796B1c; --gap-bg:#C2A97A1c;
  --shadow:0 1px 2px #0000004d;
}

*{box-sizing:border-box}
body{
  margin:0; background:var(--ground); color:var(--ink);
  font-family:"IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  font-size:15px; line-height:1.55; -webkit-font-smoothing:antialiased;
}
.wrap{max-width:1080px; margin:0 auto; padding:40px 24px 64px; display:flex;
      flex-direction:column; gap:34px}
h1,h2,h3{text-wrap:balance; margin:0}
.r{text-align:right}
.mono,td.mono{font-family:"IBM Plex Mono",ui-monospace,monospace}
table{width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums}
th{font-size:11px; letter-spacing:.09em; text-transform:uppercase; color:var(--ink-soft);
   font-weight:600; text-align:left; padding:0 10px 7px; border-bottom:1px solid var(--rule)}
td{padding:9px 10px; border-bottom:1px solid var(--rule-soft); font-size:13.5px;
   font-variant-numeric:tabular-nums}
tbody tr:last-child td{border-bottom:none}
.scroll{overflow-x:auto}
.tk{font-family:"IBM Plex Mono",monospace; font-weight:600; letter-spacing:-.01em}
.up{color:var(--calm)} .down{color:var(--alert)} .flat{color:var(--ink-soft)}
.strong{font-weight:600}
.sep{border-left:1px solid var(--rule)}

/* masthead ------------------------------------------------------------ */
.masthead{display:flex; justify-content:space-between; align-items:baseline;
          gap:16px; flex-wrap:wrap; padding-bottom:14px; border-bottom:2px solid var(--ink)}
.brand{display:flex; align-items:baseline; gap:12px; flex-wrap:wrap}
.mark{font-family:"Instrument Serif",Georgia,serif; font-size:34px; line-height:1;
      letter-spacing:.02em}
.kicker{font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--ink-soft)}
.stamp{font-family:"IBM Plex Mono",monospace; font-size:12px; color:var(--ink-soft)}

.thesis{display:grid; grid-template-columns:auto 1fr auto; gap:28px; align-items:start}
.dial-wrap{position:relative; width:120px; text-align:center}
.dial{display:block}
.dial-track{fill:none; stroke:var(--rule); stroke-width:7; stroke-linecap:round}
.dial-value{fill:none; stroke:var(--accent); stroke-width:7; stroke-linecap:round}
.dial-score{font-family:"IBM Plex Mono",monospace; font-size:24px; font-weight:600;
            margin-top:-16px; font-variant-numeric:tabular-nums}
.dial-score span{font-size:12px; color:var(--ink-soft); font-weight:400}
.thesis-copy h1{font-family:"Instrument Serif",Georgia,serif; font-size:38px; line-height:1.08;
                font-weight:400; letter-spacing:-.01em}
.trend{font-family:"IBM Plex Sans",sans-serif; font-size:13px; letter-spacing:.02em;
       vertical-align:middle; margin-left:8px; color:var(--ink-soft)}
.trend.improving{color:var(--calm)} .trend.deteriorating{color:var(--alert)}
.lede{margin:10px 0 0; font-size:16px; max-width:62ch}
.method{margin:10px 0 0; font-size:12px; color:var(--ink-soft); max-width:70ch; line-height:1.5}
.thesis-stats{display:flex; flex-direction:column; gap:12px; margin:0;
              border-left:1px solid var(--rule); padding-left:22px; min-width:130px}
.thesis-stats dt{font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-soft)}
.thesis-stats dd{margin:1px 0 0; font-family:"IBM Plex Mono",monospace; font-size:17px;
                 font-weight:500; font-variant-numeric:tabular-nums}

/* source lamps -------------------------------------------------------- */
.lamps{display:flex; flex-wrap:wrap; gap:6px 18px; list-style:none; margin:0; padding:11px 0;
       border-top:1px solid var(--rule-soft); border-bottom:1px solid var(--rule-soft);
       font-size:11.5px; color:var(--ink-soft); letter-spacing:.03em}
.lamp{display:flex; align-items:center; gap:6px}
.lamp .dot{width:6px; height:6px; border-radius:50%; background:var(--gap)}
.lamp.live .dot{background:var(--calm)} .lamp.ok .dot{background:var(--watch)}
.lamp.stale .dot,.lamp.error .dot{background:var(--alert)}

/* blocks -------------------------------------------------------------- */
.block{display:flex; flex-direction:column; gap:14px}
.block-head{display:flex; justify-content:space-between; align-items:baseline; gap:14px;
            flex-wrap:wrap; border-bottom:1px solid var(--rule); padding-bottom:7px}
.block h2{font-family:"Instrument Serif",Georgia,serif; font-size:23px; font-weight:400;
          letter-spacing:.01em}
.note{font-size:11.5px; color:var(--ink-soft); letter-spacing:.03em}
.sub{font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-soft);
     font-weight:600; margin:4px 0 8px}
.synthesis{margin:0; font-size:15px; max-width:70ch}

.chip{display:inline-block; font-size:10.5px; font-weight:600; letter-spacing:.07em;
      text-transform:uppercase; padding:2.5px 7px; border-radius:3px; white-space:nowrap}
.chip.calm{color:var(--calm); background:var(--calm-bg)}
.chip.watch{color:var(--watch); background:var(--watch-bg)}
.chip.alert{color:var(--alert); background:var(--alert-bg)}
.chip.gap{color:var(--gap); background:var(--gap-bg)}
.chip.info{color:var(--accent); background:var(--ink-faint)}

.radar-score{display:flex; align-items:center; gap:10px}
.radar-score strong{font-family:"IBM Plex Mono",monospace; font-size:20px; font-weight:600}
.radar-score span{font-size:11px; color:var(--ink-soft); font-weight:400}
.tells .tell-name span{display:block; font-weight:500; font-size:13.5px}
.tells .tell-name em{display:block; font-style:normal; font-size:11.5px; color:var(--ink-soft);
                     margin-top:1px; max-width:52ch}
.tell-value{text-align:right; font-family:"IBM Plex Mono",monospace; font-size:15px; font-weight:500}
.tell-weight{width:104px}
.wbar{display:block; height:3px; background:var(--rule); border-radius:2px; overflow:hidden}
.wbar i{display:block; height:100%; background:var(--accent)}
.wnum{display:block; font-size:10.5px; color:var(--ink-soft); margin-top:3px;
      font-family:"IBM Plex Mono",monospace}

.alerts{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px}
.alerts li{display:flex; align-items:baseline; gap:10px; font-size:13.5px;
           background:var(--surface); border:1px solid var(--rule-soft); border-radius:4px;
           padding:9px 12px}

/* scorecard ----------------------------------------------------------- */
.assets{display:grid; grid-template-columns:repeat(auto-fill,minmax(228px,1fr)); gap:10px}
.asset{background:var(--surface); border:1px solid var(--rule-soft); border-radius:5px;
       padding:12px 13px; display:flex; flex-direction:column; gap:9px; box-shadow:var(--shadow)}
.asset-top{display:flex; justify-content:space-between; align-items:flex-start; gap:8px}
.asset h3{font-size:13.5px; font-weight:600; line-height:1.25}
.klass{font-size:10.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-soft)}
.delta{font-family:"IBM Plex Mono",monospace; font-size:12px; font-weight:600; white-space:nowrap}
.asset-mid{display:flex; justify-content:space-between; align-items:flex-end; gap:8px}
.price{font-family:"IBM Plex Mono",monospace; font-size:20px; font-weight:600;
       font-variant-numeric:tabular-nums}
.spark polyline{fill:none; stroke-width:1.4; stroke-linejoin:round; stroke-linecap:round}
.spark polygon{stroke:none; opacity:.13}
.spark.up polyline,.spark.up circle{stroke:var(--calm); fill:none} .spark.up polygon{fill:var(--calm)}
.spark.up circle{fill:var(--calm)}
.spark.down polyline{stroke:var(--alert)} .spark.down polygon{fill:var(--alert)}
.spark.down circle{fill:var(--alert)}
.spark-empty{color:var(--ink-soft); font-size:12px}
.asset-windows{display:grid; grid-template-columns:repeat(3,1fr); gap:4px;
               border-top:1px solid var(--rule-soft); padding-top:7px; text-align:center}
.asset-windows em{display:block; font-style:normal; font-size:10px; color:var(--ink-soft);
                  letter-spacing:.06em}
.asset-windows b{font-family:"IBM Plex Mono",monospace; font-size:11.5px; font-weight:500}
.asset-flags{display:flex; gap:5px}
.flag{font-size:10px; font-weight:600; letter-spacing:.05em; padding:1.5px 6px; border-radius:3px}
.flag.calm{color:var(--calm); background:var(--calm-bg)}
.flag.alert{color:var(--alert); background:var(--alert-bg)}
.flag.gap{color:var(--gap); background:var(--gap-bg)}

.credit-strip{display:flex; flex-wrap:wrap; gap:10px 34px; padding:13px 15px;
              background:var(--surface-2); border:1px solid var(--rule-soft); border-radius:5px}
.credit-strip dt{font-size:10.5px; letter-spacing:.09em; text-transform:uppercase; color:var(--ink-soft)}
.credit-strip dd{margin:2px 0 0; font-family:"IBM Plex Mono",monospace; font-size:16px; font-weight:500}
.credit-strip i{font-style:normal; font-size:12px}

/* macro, tables, movers ----------------------------------------------- */
.macro{display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:10px}
.macro-col{background:var(--surface); border:1px solid var(--rule-soft); border-radius:5px;
           padding:13px 14px; box-shadow:var(--shadow)}
.macro-col h3{font-size:13px; font-weight:600; margin-bottom:8px}
.macro-col dl{margin:0; display:flex; flex-direction:column; gap:6px}
.macro-col dl div{display:flex; justify-content:space-between; gap:10px; align-items:baseline;
                  font-size:12.5px}
.macro-col dt{color:var(--ink-soft)}
.macro-col dd{margin:0; font-family:"IBM Plex Mono",monospace; font-weight:500;
              font-variant-numeric:tabular-nums; white-space:nowrap}
.stale{font-family:"IBM Plex Sans",sans-serif; font-size:9.5px; letter-spacing:.06em;
       text-transform:uppercase; color:var(--gap); background:var(--gap-bg);
       padding:1px 4px; border-radius:2px; font-weight:600}
.crowd{display:block; font-family:"IBM Plex Sans",sans-serif; font-weight:400;
       font-size:10px; color:var(--ink-soft); letter-spacing:.03em; margin-top:1px}
.two-up{display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:10px 28px}
.three-up{display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:10px 28px}
.movers{list-style:none; margin:0; padding:0; display:flex; flex-direction:column}
.movers li{display:grid; grid-template-columns:auto 1fr auto auto; gap:9px; align-items:baseline;
           padding:6px 0; border-bottom:1px solid var(--rule-soft); font-size:12.5px}
.movers li:last-child{border-bottom:none}
.mv-name{color:var(--ink-soft); overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.mv-px{font-family:"IBM Plex Mono",monospace; font-variant-numeric:tabular-nums}
.bt th.sep,.bt td.sep{border-left:1px solid var(--rule)}

.foot{border-top:1px solid var(--rule); padding-top:16px; font-size:11.5px;
      color:var(--ink-soft); line-height:1.6; display:flex; flex-direction:column; gap:7px}
.prov{margin:0; font-family:"IBM Plex Mono",monospace; font-size:11px}
.foot p{margin:0; max-width:78ch}

@media (max-width:760px){
  .thesis{grid-template-columns:1fr; gap:18px}
  .thesis-stats{flex-direction:row; gap:24px; border-left:none; border-top:1px solid var(--rule);
                padding:14px 0 0}
  .thesis-copy h1{font-size:30px}
  .wrap{padding:26px 16px 44px}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important; transition:none!important}}
"""

FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com">'
         '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
         '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?'
         'family=Instrument+Serif:ital@0;1&'
         'family=IBM+Plex+Sans:wght@400;500;600&'
         'family=IBM+Plex+Mono:wght@400;500;600&display=swap">')


def render():
    body = build(load())
    return (f'<title>APEX Regime Readout</title>\n{FONTS}\n'
            f'<style>{CSS}</style>\n<div class="wrap">\n{body}\n</div>\n')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=DEFAULT_OUT)
    args = ap.parse_args()
    html_text = render()
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(html_text)
    os.replace(tmp, args.out)
    print(f"  ok   report -> {args.out}  ({len(html_text):,} bytes)")
    return args.out


if __name__ == "__main__":
    main()


def main_path(out=DEFAULT_OUT):
    """Render to `out` and return the path — the entry point bake.py uses."""
    html_text = render()
    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(html_text)
    os.replace(tmp, out)
    print(f"  ok   report -> {os.path.relpath(out, ROOT)}  ({len(html_text):,} bytes)")
    return out
