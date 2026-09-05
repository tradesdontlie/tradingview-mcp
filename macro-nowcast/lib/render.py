#!/usr/bin/env python3
"""Render one vintage as a self-contained page.

Self-contained is a requirement, not a convenience: the page has to survive
being emailed, opened from disk, or published where a strict CSP blocks every
outbound request. So there is no runtime fetch and no external asset — the
vintages are embedded as JSON and the selector switches between them in place.

The design tokens are the ones the original dashboard used, so the recreation
reads as the same instrument.
"""
import datetime, html, json

import fmt
import universe as U

CSS = """
:root{--bg:#06100e;--p:#0c1815;--p2:#10211c;--line:#293d37;--ink:#edf6f1;--muted:#829b92;
--cyan:#49d7b2;--green:#62d28b;--amber:#efba5d;--red:#f07171;--blue:#78a9ff}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(circle at 88% -8%,#173b31 0,transparent 30%),var(--bg);
color:var(--ink);font:14px/1.45 Inter,system-ui,-apple-system,sans-serif}
.shell{max-width:1450px;margin:auto;padding:20px 24px 65px}
.mono,.stamp,.tag,.triad,.meta,select{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.eyebrow{color:var(--cyan);font:700 10px ui-monospace,monospace;letter-spacing:.15em;text-transform:uppercase}
.top{display:flex;justify-content:space-between;align-items:center;gap:18px;margin-bottom:16px}
.brand{display:flex;align-items:center;gap:10px}
.logo{width:28px;height:28px;border:1px solid var(--cyan);display:grid;place-items:center;color:var(--cyan);font:700 10px ui-monospace,monospace}
.brand h1{font-size:15px;margin:2px 0}
.stamp{text-align:right;color:var(--muted);font-size:10px}
.stamp b{color:var(--ink)}
.hero{display:grid;grid-template-columns:1.5fr .65fr .58fr;border:1px solid #38574e;
background:linear-gradient(120deg,#10251f,#0a1714);box-shadow:0 20px 50px #0007}
.hero>div{padding:24px}.hero>div+div{border-left:1px solid var(--line)}
.hero h2{font-size:clamp(23px,3vw,38px);line-height:1.06;letter-spacing:-.04em;margin:8px 0 12px}
.hero p{color:#b2c6bf;margin:0;font-size:13px}
.big{font:500 44px/1 ui-monospace,monospace;margin:9px 0}
.big small{font-size:15px;color:var(--muted)}
.delta{font:700 10px ui-monospace,monospace}
.good{color:var(--green)}.bad{color:var(--red)}.warn{color:var(--amber)}.muted{color:var(--muted)}
.meter{height:4px;background:#263832;margin:11px 0}
.meter i{display:block;height:100%;background:var(--cyan)}
.filters{display:grid;grid-template-columns:1.2fr repeat(5,1fr);gap:8px;margin:16px 0;padding:11px;
border:1px solid var(--line);background:#091411}
.filter label{display:block;color:var(--muted);font:8px ui-monospace,monospace;
text-transform:uppercase;letter-spacing:.1em;margin-bottom:4px}
select{width:100%;background:var(--p2);color:var(--ink);border:1px solid var(--line);padding:6px;font-size:11px}
.head{display:flex;justify-content:space-between;align-items:end;gap:12px;margin:28px 0 11px}
.head h2{font-size:12px;letter-spacing:.14em;text-transform:uppercase;margin:0}
.head span{font:9px ui-monospace,monospace;color:var(--muted);text-align:right}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:10px}
.card{grid-column:span 4;border:1px solid var(--line);background:linear-gradient(150deg,var(--p2),var(--p));min-height:205px}
.card[open]{grid-column:span 6;border-color:#45675d}
.card.hidden{display:none}
.card summary{list-style:none;cursor:pointer;padding:15px}
.card summary::-webkit-details-marker{display:none}
.card summary:focus{outline:1px solid var(--cyan);outline-offset:-3px}
.ctop{display:flex;justify-content:space-between;align-items:start;gap:8px}
.sid{color:var(--cyan);font:700 9px ui-monospace,monospace;letter-spacing:.08em}
.tags{display:flex;gap:4px;flex-wrap:wrap}
.tag{font-size:8px;color:var(--muted);border:1px solid var(--line);padding:2px 4px;text-transform:uppercase}
.tag.verified{color:var(--green);border-color:#316848}
.tag.carry{color:var(--amber);border-color:#705b35}
.tag.stale{color:var(--red);border-color:#754040}
.card h3{font-size:13px;margin:9px 0 3px}
.status{font:600 18px/1.15 ui-monospace,monospace;letter-spacing:-.03em}
.copy{color:var(--muted);font-size:11px;margin:8px 0 12px}
.triad{display:grid;grid-template-columns:repeat(3,1fr);padding-top:9px;border-top:1px solid var(--line);
color:var(--muted);font-size:8px;gap:6px}
.triad b{display:block;color:var(--ink);font-size:10px;margin-top:2px;font-weight:600}
.detail{padding:0 15px 15px;border-top:1px solid var(--line)}
.facts{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin:13px 0}
.fact{border:1px solid var(--line);background:#0a1613;padding:8px;font-size:8px;color:var(--muted)}
.fact b{display:block;color:var(--ink);font:600 12px ui-monospace,monospace;margin-bottom:3px}
.meta{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;font-size:8px;color:var(--muted);
border-top:1px solid var(--line);padding-top:11px}
.meta b{color:var(--cyan);letter-spacing:.08em}
.meta a{color:var(--blue);text-decoration:none}
.meta a:hover{text-decoration:underline}
.empty{display:none;border:1px dashed var(--line);padding:26px;text-align:center;color:var(--muted);font-size:11px}
.empty.show{display:block}
.analytics{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.panel{border:1px solid var(--line);background:var(--p);padding:16px}
.phead{display:flex;justify-content:space-between;align-items:start;gap:10px}
.phead h3{font-size:11px;margin:0;letter-spacing:.08em;text-transform:uppercase}
.phead span{font:8px ui-monospace,monospace;color:var(--muted);text-align:right;line-height:1.5}
.score{display:grid;grid-template-columns:125px 1fr;gap:22px;align-items:center;margin-top:15px}
.donut{width:120px;height:120px;border-radius:50%;display:grid;place-items:center;position:relative}
.donut:after{content:"";position:absolute;inset:10px;background:var(--p);border-radius:50%}
.donut div{z-index:1;font:700 29px/1 ui-monospace,monospace;text-align:center}
.donut small{display:block;color:var(--muted);font-size:8px;margin-top:6px}
.contrib{display:grid;gap:6px}
.crow{display:grid;grid-template-columns:64px 1fr 52px;gap:8px;align-items:center;font:9px ui-monospace,monospace;color:var(--muted)}
.cbar{height:8px;background:#263832;position:relative}
.cbar i{display:block;height:100%;background:var(--cyan)}
.crow b{color:var(--ink);text-align:right;font-weight:600}
.quads{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
.quad{height:215px;border:1px solid var(--line);position:relative;
background:linear-gradient(90deg,transparent 49.7%,var(--line) 50%,transparent 50.3%),
linear-gradient(0deg,transparent 49.7%,var(--line) 50%,transparent 50.3%)}
.quad span{position:absolute;font:8px ui-monospace,monospace;color:var(--muted)}
.dot{position:absolute;width:11px;height:11px;border-radius:50%;background:var(--cyan);
transform:translate(-50%,-50%);box-shadow:0 0 0 3px #49d7b233}
.dot.old{background:transparent;border:1px solid var(--muted);box-shadow:none}
.legend{margin-top:10px;color:var(--muted);font:8px ui-monospace,monospace}
.legend i{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--cyan);margin:0 4px 0 10px}
.alerts{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.alert{display:flex;gap:12px;border:1px solid var(--line);border-left:3px solid var(--amber);background:var(--p);padding:13px}
.alert.high{border-left-color:var(--red)}
.alert.low{border-left-color:var(--line)}
.alert span{color:var(--muted);font:9px ui-monospace,monospace}
.alert h3{font-size:11px;margin:0 0 3px}
.alert p{font-size:10px;color:var(--muted);margin:0}
.table{width:100%;border-collapse:collapse}
.table th,.table td{padding:9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;font-size:10px}
.table th{color:var(--muted);font:8px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.1em}
.table td{color:var(--muted)}
.table td:first-child{color:var(--ink)}
.table tr:last-child td{border-bottom:0}
.cond{margin:0;padding:0;list-style:none}
.cond li{font-size:10px;padding:1px 0}
.cond li:before{content:"○ ";color:var(--muted)}
.cond li.yes:before{content:"● ";color:var(--green)}
.cond li.no:before{content:"○ ";color:var(--muted)}
.timeline{border-left:1px solid var(--line);margin-left:8px;padding-left:21px}
.event{position:relative;padding-bottom:16px}
.event:before{content:"";position:absolute;left:-26px;top:4px;width:9px;height:9px;border-radius:50%;
background:var(--p);border:1px solid var(--cyan)}
.event time{color:var(--cyan);font:8px ui-monospace,monospace;letter-spacing:.1em}
.event h3{font-size:11px;margin:3px 0 2px}
.event p{font-size:10px;color:var(--muted);margin:0}
.accord{border-top:1px solid var(--line)}
.accord details{border-bottom:1px solid var(--line)}
.accord summary{cursor:pointer;list-style:none;padding:13px 2px;font:600 10px ui-monospace,monospace;
letter-spacing:.1em;text-transform:uppercase}
.accord summary::-webkit-details-marker{display:none}
.accord summary:after{content:"+";float:right;color:var(--cyan)}
.accord details[open] summary:after{content:"−"}
.accord .body{padding:0 2px 16px;font-size:11px;color:var(--muted);line-height:1.6}
.accord .body b{color:var(--ink)}
.scroll{overflow-x:auto}
.foot{display:flex;justify-content:space-between;color:#60776f;font:8px ui-monospace,monospace;
margin-top:20px;gap:12px;flex-wrap:wrap}
a.source{color:var(--blue);text-decoration:none}
a.source:hover{text-decoration:underline}
@media(max-width:1080px){
.hero{grid-template-columns:1fr 1fr}
.hero>div:first-child{grid-column:span 2}
.hero>div:nth-child(2){border-left:0;border-top:1px solid var(--line)}
.hero>div:nth-child(3){border-top:1px solid var(--line)}
.filters{grid-template-columns:repeat(3,1fr)}
.card,.card[open]{grid-column:span 6}
.analytics,.alerts,.quads{grid-template-columns:1fr}
}
@media(max-width:680px){
.shell{padding:14px 12px 40px}
.filters{grid-template-columns:repeat(2,1fr)}
.card,.card[open]{grid-column:span 12}
.facts,.meta,.triad{grid-template-columns:repeat(2,1fr)}
.score{grid-template-columns:1fr}
}
"""

TONE_CLASS = {"good": "good", "bad": "bad", "warn": "warn", "muted": "muted"}


def esc(x):
    return html.escape(str(x), quote=True)


def _donut_colour(score):
    if score is None:
        return "var(--muted)"
    if score >= 60:
        return "var(--green)"
    if score >= 42:
        return "var(--amber)"
    return "var(--red)"


def _delta_tag(delta, digits=2, unit=""):
    if delta is None:
        return '<span class="delta muted">NEW</span>'
    cls = "good" if delta > 0 else "bad" if delta < 0 else "muted"
    return f'<span class="delta {cls}">{esc(fmt._sign(delta, digits, unit))} vs prev</span>'


def _quad(plane, title):
    """A scatter of one plane. Scores are 0-100, so they map straight to percent."""
    x, y = plane.get("x"), plane.get("y")
    dot = ""
    if None not in (x, y):
        dot = f'<i class="dot" style="left:{x:.1f}%;bottom:{y:.1f}%"></i>'
    return f"""<div>
<div class="phead"><h3>{esc(title)}</h3><span>{esc(plane['x_label'])} ×<br>{esc(plane['y_label'])}</span></div>
<div class="quad">{dot}
<span style="left:6px;top:6px">{esc(plane['y_label'])} high</span>
<span style="right:6px;bottom:6px">{esc(plane['x_label'])} high</span>
</div></div>"""


def render(vintage, vintages, manifest):
    v = vintage
    comp = v["composite"]
    stamp = datetime.datetime.fromisoformat(v["built_at"])

    # ------------------------------------------------------------------ hero
    score_txt = "n/a" if comp["score"] is None else comp["score"]
    conf_txt = "n/a" if comp["confidence"] is None else f"{comp['confidence']:.0f}"
    hero = f"""<section class="hero">
<div>
<div class="eyebrow">{esc(v['regime']['eyebrow'])}</div>
<h2>{esc(v['regime']['title'])}</h2>
<p>{esc(v['regime']['copy'])}</p>
</div>
<div>
<div class="eyebrow">Liquidity composite</div>
<div class="big">{score_txt}<small>/100</small></div>
{_delta_tag(comp.get('delta'))}
<div class="meter"><i style="width:{comp['score'] or 0}%"></i></div>
<div class="stamp" style="text-align:left">RAW {esc(comp['raw'] if comp['raw'] is not None else 'n/a')} ·
{esc(comp['weight_covered'])}% OF WEIGHT RESOLVED</div>
</div>
<div>
<div class="eyebrow">Model confidence</div>
<div class="big">{conf_txt}<small>%</small></div>
{_delta_tag(comp.get('confidence_delta'), 1, '')}
<div class="meter"><i style="width:{comp['confidence'] or 0}%"></i></div>
<div class="stamp" style="text-align:left">COVERAGE × AGREEMENT<br>ACROSS {len(comp['contributions'])} WEIGHTED PILLARS</div>
</div>
</section>"""

    # --------------------------------------------------------------- filters
    options = "".join(
        f'<option value="{esc(x["stamp"])}"{" selected" if x["stamp"] == v["stamp"] else ""}>'
        f'{esc(x["label"])}</option>' for x in vintages)
    def sel(idx, label, values):
        opts = "".join(f'<option value="{esc(o)}">{esc(o.title())}</option>' for o in values)
        return (f'<div class="filter"><label for="{idx}">{esc(label)}</label>'
                f'<select id="{idx}"><option value="all">All</option>{opts}</select></div>')
    filters = f"""<section class="filters" aria-label="Signal filters">
<div class="filter"><label for="vintage">Vintage</label><select id="vintage">{options}</select></div>
{sel('geo', 'Geography', ['US', 'Europe', 'Japan', 'China', 'Global'])}
{sel('pillar', 'Pillar', ['inflation', 'growth', 'policy', 'liquidity', 'funding', 'market'])}
{sel('direction', 'Direction', ['improving', 'deteriorating', 'mixed'])}
{sel('confidence', 'Confidence', ['high', 'medium', 'low'])}
{sel('freshness', 'Freshness', ['verified', 'carry', 'stale'])}
</section>"""

    # ------------------------------------------------------- composite panel
    rows = []
    by_id = {c["id"]: c for c in v["cards"]}
    for c in sorted(comp["contributions"], key=lambda x: -x["points"]):
        card = by_id.get(c["id"], {})
        rows.append(f'<div class="crow"><span>{esc(c["id"])}</span>'
                    f'<span class="cbar"><i style="width:{c["score"]:.0f}%;'
                    f'background:{_donut_colour(c["score"])}"></i></span>'
                    f'<b>{c["score"]:.1f}</b></div>'
                    f'<div class="crow" style="margin-top:-4px"><span></span>'
                    f'<span style="font-size:8px">{esc(card.get("title",""))} · weight {c["weight"]}%'
                    f' · contributes {c["points"]:.2f}</span><b></b></div>')
    composite_panel = f"""<article class="panel">
<div class="phead"><h3>Transparent global-liquidity composite</h3>
<span>Weighted model output<br>not an official index</span></div>
<div class="score">
<div class="donut" style="background:conic-gradient({_donut_colour(comp['raw'])} 0 {comp['score'] or 0}%,#263832 {comp['score'] or 0}%)">
<div>{score_txt}<small>/100</small></div></div>
<div class="contrib">{''.join(rows)}</div>
</div>
<div class="legend">Each pillar score is the percentile of its member series within their own
five-year history, polarity-adjusted so higher always means more liquidity.</div>
</article>"""

    geometry = f"""<article class="panel">
<div class="phead"><h3>Regime geometry</h3><span>Pillar scores, 0–100<br>centre lines at 50</span></div>
<div class="quads">{_quad(v['geometry']['cycle'], 'Cycle')}{_quad(v['geometry']['plumbing'], 'Plumbing')}</div>
<div class="legend"><i></i>This vintage · a dot in the upper right is growth with cooling prices,
or liquidity with orderly funding.</div>
</article>"""

    # ---------------------------------------------------------------- alerts
    if v["alerts"]:
        alert_html = "".join(
            f'<article class="alert {esc(a["level"])}"><span>{i + 1:02d}</span><div>'
            f'<h3>{esc(a["title"])}</h3><p>{esc(a["body"])}</p></div></article>'
            for i, a in enumerate(v["alerts"]))
    else:
        alert_html = ('<article class="alert low"><span>—</span><div><h3>No threshold fired</h3>'
                      '<p>No computed condition crossed an alert threshold in this vintage.</p></div></article>')

    # ------------------------------------------------------------- scenarios
    scen_rows = "".join(
        f'<tr><td>{esc(s["name"])}</td><td class="{TONE_CLASS.get(s["tone"], "")}">{esc(s["state"])}</td>'
        f'<td><ul class="cond">' +
        "".join(f'<li class="{"yes" if c["met"] else "no"}">{esc(c["text"])}</li>' for c in s["conditions"]) +
        "</ul></td></tr>" for s in v["scenarios"])

    # ---------------------------------------------------------------- ledger
    ledger_rows = "".join(
        f'<tr><td>{esc(r["input"])}</td><td>{esc(r["change"])}</td>'
        f'<td>{esc(r["pillar"])}</td><td>{esc(r["consequence"])}</td></tr>' for r in v["ledger"])

    # -------------------------------------------------------------- timeline
    timeline = "".join(
        f'<article class="event"><time>{esc(e["date"])} · {esc(e["fresh"].upper())}</time>'
        f'<h3>{esc(e["title"])} — {esc(e["value"])}</h3>'
        f'<p>{esc(e["pillar"])} · observation {esc(e["period"])}</p></article>'
        for e in v["timeline"])

    # ---------------------------------------------------------------- audit
    src_rows = []
    for pid, _g, _geo, _p, title, weight in U.PILLARS:
        for spec in U.INDICATORS[pid]:
            r = by_id.get(pid, {}).get("readings", {}).get(spec["key"])
            state = f'{r["fresh"]} · {r["period"]}' if r else "unresolved"
            src_rows.append(
                f'<tr><td>{esc(spec["label"])}</td><td>{esc(title)}</td>'
                f'<td><a class="source" href="{esc(spec["url"])}" rel="noopener">{esc(spec["source"])}</a></td>'
                f'<td>{esc(state)}</td></tr>')

    prov = manifest.get("providers", {})
    prov_txt = ", ".join(f"{k} {n}" for k, n in sorted(prov.items())) or "none"

    method = f"""<div class="body">
<b>Level, velocity, acceleration.</b> Level is the stock or rate as published; velocity is the
latest sequential change; acceleration is the change in that velocity. Each is computed from the
publisher's own series — no reading on this page was typed by hand.
<br><br><b>Scoring.</b> Each member series is ranked as a percentile against its own five-year
history, on the quantity named in the registry below, then flipped where a higher reading means
less liquidity. A pillar score is the mean of its members; the composite is the weight-average of
the six weighted pillars ({', '.join(f'{k} {w}%' for k, w in sorted(U.WEIGHTS.items(), key=lambda x: -x[1]))}).
A pillar that fails to resolve is dropped and the remaining weights are renormalised, so a gap
lowers confidence rather than silently scoring zero. Coverage this vintage was
<b>{esc(comp['weight_covered'])}%</b> of intended weight.
<br><br><b>Freshness.</b> <b>Verified</b> means the newest observation is new since the previous
stored vintage. <b>Carry</b> means it is still current for its publication cadence but unchanged.
<b>Stale</b> means it is older than one publication interval plus a grace period
(daily {U.CADENCE_DAYS['d']}d, weekly {U.CADENCE_DAYS['w']}d, monthly {U.CADENCE_DAYS['m']}d).
These are measured from the observation date, not asserted.
<br><br><b>Confidence.</b> Coverage — how many members resolved and are current — blended with
agreement, which is how tightly the member scores cluster. Wide disagreement inside a pillar
lowers its confidence even when every source resolved.
<br><br><b>What this is not.</b> The composite is a liquidity measure, not a summary of the whole
page: US inflation, growth and market pricing inform the regime geometry and the alerts but carry
zero weight in the score. It is a model output, not an official index, and no part of it is
investment advice.
</div>"""

    limits = f"""<div class="body">
<b>Known limits of this build, stated rather than hidden.</b>
<br><br>• <b>China credit is proxied.</b> PBoC aggregate financing and the credit impulse have no
keyless feed. This pillar reads OECD trade, prices, the composite leading indicator and the
interbank rate instead, and is labelled China credit &amp; activity for that reason.
<br>• <b>Euro-area HICP lags.</b> Eurostat's latest published annual rate at this bake was
{esc(by_id.get('EU-LIQ', {}).get('readings', {}).get('ea_hicp', {}).get('period', 'unavailable'))};
the card shows it with its real observation date rather than implying it is current.
<br>• <b>FRED's OECD mirrors are unreliable.</b> Japan M2 (MYAGM2JPM189S) stopped there in
February 2017 and China CPI (CHNCPIALLMINMEI) in April 2025, while both are still published
upstream. Japan and China therefore read from OECD directly.
<br>• <b>Percentile scores are relative, not absolute.</b> A pillar at 50 is at its own five-year
median, which is a statement about its history, not about whether that level is comfortable.
<br>• <b>Revisions are not tracked.</b> A publisher that revises an earlier observation changes the
score silently; the ledger reports it as a score move with no new observation.
</div>"""

    provenance = f"""<div class="body">
Built <b>{esc(stamp.strftime('%d %b %Y %H:%M %Z') or stamp.isoformat())}</b> in
{esc(manifest.get('elapsed_seconds', 'n/a'))}s.
Series resolved <b>{esc(manifest.get('series_ok', 0))}</b>, unresolved
<b>{esc(manifest.get('series_gap', 0))}</b>. Publishers: {esc(prov_txt)}.
Stored vintages: <b>{len(vintages)}</b>.
{('Unresolved: <b>' + esc(', '.join(manifest.get('gaps', {}).keys())) + '</b>.') if manifest.get('gaps') else ''}
<br><br>Every request is cached on disk and throttled per host, so re-running the push inside the
cache TTL costs no outbound requests. Nothing here needs an API key.
</div>"""

    payload = json.dumps({"vintages": {x["stamp"]: x for x in vintages}},
                         separators=(",", ":"))

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Macro Nowcast — {esc(stamp.strftime('%d %B %Y %H:%M'))}</title>
<style>{CSS}</style>
</head>
<body><main class="shell">
<header class="top">
<div class="brand"><div class="logo">MN</div><div>
<div class="eyebrow">Global Macro Signal Desk</div>
<h1>Macro Nowcast / Regime Monitor</h1></div></div>
<div class="stamp"><b>LIVE COMPUTED VINTAGE</b><br>
{esc(stamp.strftime('%d %b %Y · %H:%M %Z').upper())} BAKE<br>
{esc(manifest.get('series_ok', 0))} SERIES FROM {esc(len(prov))} PUBLISHERS · NO API KEY</div>
</header>
{hero}
{filters}
<div class="head"><h2>Signal matrix</h2><span id="count"></span></div>
<section class="grid" id="grid"></section>
<div class="empty" id="empty">No signals match these filters.</div>

<div class="head"><h2>Composite &amp; regime geometry</h2>
<span>Weighted from {len(comp['contributions'])} pillars · percentile-scored</span></div>
<section class="analytics">{composite_panel}{geometry}</section>

<div class="head"><h2>Inflection &amp; divergence alerts</h2>
<span>Threshold rules over computed values</span></div>
<section class="alerts">{alert_html}</section>

<div class="head"><h2>Scenario paths</h2><span>Confirmers evaluated live</span></div>
<section class="panel scroll" style="padding:4px 14px">
<table class="table"><thead><tr><th>Path</th><th>State</th><th>Conditions</th></tr></thead>
<tbody>{scen_rows}</tbody></table></section>

<div class="head"><h2>Change ledger</h2><span>Diff against the previous stored vintage</span></div>
<section class="panel scroll" style="padding:4px 14px">
<table class="table"><thead><tr><th>Input</th><th>Measured change</th><th>Pillar</th><th>Consequence</th></tr></thead>
<tbody>{ledger_rows}</tbody></table></section>

<div class="head"><h2>Observation timeline</h2><span>Newest observations across all pillars</span></div>
<section class="timeline">{timeline}</section>

<div class="head"><h2>Method, sources &amp; limits</h2><span>Expandable audit trail</span></div>
<section class="accord">
<details><summary>Methodology and scoring</summary>{method}</details>
<details><summary>Known limits</summary>{limits}</details>
<details><summary>Source registry — every series on this page</summary>
<div class="body scroll"><table class="table">
<thead><tr><th>Series</th><th>Pillar</th><th>Publisher</th><th>State</th></tr></thead>
<tbody>{''.join(src_rows)}</tbody></table></div></details>
<details><summary>Build provenance</summary>{provenance}</details>
</section>

<footer class="foot">
<span>MACRO NOWCAST · SELF-CONTAINED · NO RUNTIME API · NOT INVESTMENT ADVICE</span>
<span>{esc(v['stamp'])} · {esc(manifest.get('series_ok', 0))} SERIES</span>
</footer>
</main>
<script id="payload" type="application/json">{payload}</script>
<script>
const DATA=JSON.parse(document.getElementById('payload').textContent).vintages;
const FIELDS=['geo','pillar','direction','confidence','freshness'];
const vintage=document.getElementById('vintage');
const grid=document.getElementById('grid'), empty=document.getElementById('empty');
const esc=s=>String(s).replace(/[&<>"]/g,c=>({{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}}[c]));
function deltaTag(d){{
  if(d===null||d===undefined) return '<i class="tag">NEW</i>';
  const cls=d>0?'good':d<0?'bad':'muted';
  const sign=d>0?'+':d<0?'−':'';
  return `<i class="tag ${{cls}}">Δ ${{sign}}${{Math.abs(d).toFixed(2)}}</i>`;
}}
function render(){{
  const v=DATA[vintage.value]; if(!v) return;
  const on=FIELDS.map(f=>[f,document.getElementById(f).value]);
  const shown=v.cards.filter(c=>on.every(([f,val])=>val==='all'||String(c[f]).toLowerCase()===val.toLowerCase()));
  grid.innerHTML=shown.map(c=>`<details class="card">
<summary>
<div class="ctop"><span class="sid">${{esc(c.glyph)}} · ${{esc(c.id)}}</span>
<span class="tags"><i class="tag ${{esc(c.freshness)}}">${{esc(c.freshness)}}</i>
${{deltaTag(c.delta)}}<i class="tag">${{esc(c.confidence)}}</i></span></div>
<h3>${{esc(c.title)}}</h3>
<div class="status ${{esc(c.tone)}}">${{esc(c.status)}}</div>
<p class="copy">${{esc(c.copy)}}</p>
<div class="triad">
<div>LEVEL<b>${{esc(c.triad[0])}}</b></div>
<div>VELOCITY<b>${{esc(c.triad[1])}}</b></div>
<div>ACCELERATION<b>${{esc(c.triad[2])}}</b></div></div>
</summary>
<div class="detail">
<div class="facts">${{c.facts.map(f=>`<div class="fact"><b>${{esc(f[0])}}</b>${{esc(f[1])}}</div>`).join('')}}</div>
<div class="meta">
<div><b>OBSERVATION</b><br>${{esc(c.obs)}}</div>
<div><b>PILLAR SCORE</b><br>${{c.score===null?'n/a':c.score.toFixed(2)}} / 100${{c.weight?` · weight ${{c.weight}}%`:' · unweighted'}}</div>
<div><b>FRESHNESS</b><br>${{esc(c.freshness)}}${{c.age_days!==null?` · ${{c.age_days}}d old`:''}}</div>
<div><b>COVERAGE</b><br>${{c.members}} series resolved · ${{c.coverage}}% current</div>
<div><b>AGREEMENT</b><br>${{c.agreement===null?'n/a':c.agreement+'%'}} · confidence ${{c.confidence_value}}%</div>
<div><b>SOURCE</b><br>${{c.sources.map(s=>`<a class="source" href="${{esc(s.url)}}" rel="noopener">${{esc(s.name)}}</a>`).join('<br>')}}</div>
${{c.gaps.length?`<div><b>UNRESOLVED</b><br>${{esc(c.gaps.join(', '))}}</div>`:''}}
</div></div></details>`).join('');
  empty.classList.toggle('show',!shown.length);
  document.getElementById('count').textContent=
    `${{shown.length}} of ${{v.cards.length}} signals · ${{v.label}} · expand a card for evidence`;
}}
[vintage,...FIELDS.map(f=>document.getElementById(f))].forEach(el=>el.addEventListener('change',render));
vintage.addEventListener('change',()=>{{ if(vintage.value!==vintage.options[0].value)
  document.querySelector('.top .stamp b').textContent='STORED VINTAGE'; }});
render();
document.querySelectorAll('.accord details').forEach(d=>d.addEventListener('toggle',()=>{{
  if(d.open) document.querySelectorAll('.accord details').forEach(o=>{{if(o!==d)o.open=false}});
}}));
</script>
</body></html>"""
