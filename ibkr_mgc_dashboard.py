#!/usr/bin/env python3
"""
Multi-Strategy Bot Dashboard — MGC (IBKR) + ETH (Hyperliquid)
Run: python3 ibkr_mgc_dashboard.py
Open: http://localhost:8080
"""

import asyncio, json, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import aiofiles
import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
import uvicorn

# ── Config ────────────────────────────────────────────────────────────────────
BOT_DIR      = Path(__file__).parent
BOT_SCRIPT   = BOT_DIR / "ibkr_mgc_bot.py"
TRADE_LOG    = BOT_DIR / "mgc_live_trades.json"
BOT_LOG      = BOT_DIR / "ibkr_mgc_bot.log"
RUNTIME_FILE = BOT_DIR / "mgc_runtime.json"
MOUNTAIN     = ZoneInfo("America/Denver")

ETH_BOT_URL  = "https://hl-webhook-bot.fly.dev"

app = FastAPI(title="Bot Dashboard")

# ── Helpers ───────────────────────────────────────────────────────────────────

def bot_pid():
    try:
        r = subprocess.run(["pgrep","-f","ibkr_mgc_bot.py"], capture_output=True, text=True)
        pids = r.stdout.strip().split()
        return int(pids[0]) if pids else None
    except: return None

def load_runtime():
    try: return json.loads(RUNTIME_FILE.read_text()) if RUNTIME_FILE.exists() else {}
    except: return {}

def load_trades():
    try: return json.loads(TRADE_LOG.read_text()) if TRADE_LOG.exists() else []
    except: return []

def load_log_tail(n=80):
    try: return BOT_LOG.read_text().splitlines()[-n:] if BOT_LOG.exists() else []
    except: return []

def completed_trades(raw):
    """Pair ENTRY events with their EXIT events into completed trade records."""
    result = []
    pending = None
    for t in raw:
        ev = t.get("event", "")
        if ev == "ENTRY":
            pending = t
        elif ev and ev != "ENTRY":
            result.append({
                "time": t.get("time"),
                "side": pending.get("side", "") if pending else "",
                "entry_price": pending.get("price", 0) if pending else 0,
                "exit_price": t.get("price", 0),
                "pnl": t.get("pnl", 0),
                "equity": t.get("equity"),
                "event": ev,
                "qty": pending.get("qty", 1) if pending else 1,
            })
            pending = None
    return result

def calc_metrics(trades, cur_equity):
    if not trades:
        return dict(total=0, wins=0, losses=0, wr=0, pf=0, net=0,
                    equity=cur_equity, avg_win=0, avg_loss=0, max_dd=0, equity_curve=[cur_equity])
    pnls = [t["pnl"] for t in trades]
    W = [p for p in pnls if p > 0]; L = [p for p in pnls if p < 0]
    gp = sum(W); gl = abs(sum(L))
    start_eq = cur_equity - sum(pnls)
    eq = [round(start_eq, 2)]
    for p in pnls: eq.append(round(eq[-1] + p, 2))
    pk = eq[0]; dd = 0.0
    for e in eq:
        if e > pk: pk = e
        d = (pk - e) / pk * 100 if pk > 0 else 0
        if d > dd: dd = d
    return dict(total=len(pnls), wins=len(W), losses=len(L),
                wr=round(len(W)/len(pnls)*100, 1),
                pf=round(gp/gl, 3) if gl else 0,
                net=round(sum(pnls), 2), equity=round(eq[-1], 2),
                avg_win=round(sum(W)/len(W), 2) if W else 0,
                avg_loss=round(sum(L)/len(L), 2) if L else 0,
                max_dd=round(dd, 1), equity_curve=eq)

def metrics(raw_trades):
    rt = load_runtime() or {}
    trades = completed_trades(raw_trades)
    cur_eq = rt.get("equity", 5000.0)
    return calc_metrics(trades, cur_eq)

# ── MGC API ───────────────────────────────────────────────────────────────────

@app.get("/api/mgc/status")
def mgc_status():
    now = datetime.now(timezone.utc).astimezone(MOUNTAIN)
    h,m = now.hour, now.minute
    sess = (h>8 or h==8) and (h<13 or (h==13 and m<=30))
    fm = contract = "—"
    if BOT_LOG.exists():
        for ln in reversed(BOT_LOG.read_text().splitlines()):
            if "Filter mode:" in ln and fm=="—": fm=ln.split("Filter mode:")[-1].strip()
            if "MGC contract:" in ln and contract=="—": contract=ln.split("MGC contract:")[-1].split()[0]
            if fm!="—" and contract!="—": break
    rt = {}
    if RUNTIME_FILE.exists():
        try: rt=json.loads(RUNTIME_FILE.read_text())
        except: pass
    pid = bot_pid()
    return dict(running=pid is not None, pid=pid, filter_mode=fm, contract=contract,
                denver=now.strftime("%H:%M MT"), session=sess,
                equity=rt.get("equity",3500), daily_pnl=rt.get("daily_pnl",0),
                trades_today=rt.get("trades_today",0),
                active_side=rt.get("active_side",""),
                active_entry=rt.get("active_entry_price"),
                active_sl=rt.get("active_stop"), active_tp=rt.get("active_target"))

@app.get("/api/mgc/trades")
def mgc_trades():
    raw = load_trades()
    paired = completed_trades(raw)
    m = metrics(raw)
    return {"trades": list(reversed(paired[-50:])), "metrics": m}

@app.get("/api/mgc/log")
def mgc_log():
    return {"lines": load_log_tail(80)}

@app.post("/api/mgc/start")
def mgc_start(filter_mode: str = "24h Full"):
    if bot_pid(): return {"ok":False,"msg":"Already running"}
    subprocess.Popen([sys.executable, str(BOT_SCRIPT), "--filter-mode", filter_mode], cwd=str(BOT_DIR))
    time.sleep(1); return {"ok":True,"msg":f"Started [{filter_mode}]"}

@app.post("/api/mgc/stop")
def mgc_stop():
    pid=bot_pid()
    if not pid: return {"ok":False,"msg":"Not running"}
    subprocess.run(["kill", str(pid)]); time.sleep(1)
    return {"ok":True,"msg":f"Stopped PID {pid}"}

@app.post("/api/mgc/restart")
def mgc_restart(filter_mode: str = "24h Full"):
    mgc_stop(); time.sleep(2); return mgc_start(filter_mode)

@app.post("/api/mgc/close-position")
def mgc_close():
    (BOT_DIR/"mgc_control.json").write_text(json.dumps({"command":"close_position","ts":time.time()}))
    return {"ok":True,"msg":"Close command sent"}

# ── ETH API (proxy to Fly.io) ─────────────────────────────────────────────────

@app.get("/api/eth/status")
async def eth_status():
    try:
        async with httpx.AsyncClient(timeout=8) as c:
            r = await c.get(f"{ETH_BOT_URL}/health")
            return r.json()
    except Exception as e:
        return {"ok":False,"error":str(e),"equity_usd":0,"bot_enabled":False,"bot_blocked":False,"testnet":True}

@app.post("/api/eth/enable")
async def eth_enable():
    try:
        async with httpx.AsyncClient(timeout=8) as c:
            r = await c.post(f"{ETH_BOT_URL}/admin/enable", json={"secret":"ayush_supertrend_secure_9284"})
            return r.json()
    except Exception as e: return {"ok":False,"msg":str(e)}

@app.post("/api/eth/disable")
async def eth_disable():
    try:
        async with httpx.AsyncClient(timeout=8) as c:
            r = await c.post(f"{ETH_BOT_URL}/admin/disable", json={"secret":"ayush_supertrend_secure_9284"})
            return r.json()
    except Exception as e: return {"ok":False,"msg":str(e)}

@app.post("/api/eth/unblock")
async def eth_unblock():
    try:
        async with httpx.AsyncClient(timeout=8) as c:
            r = await c.post(f"{ETH_BOT_URL}/unblock", json={"secret":"ayush_supertrend_secure_9284"})
            return r.json()
    except Exception as e: return {"ok":False,"msg":str(e)}

@app.get("/api/eth/fills")
async def eth_fills(wallet: str = ""):
    if not wallet:
        return {"ok": False, "error": "no_wallet", "trades": [], "metrics": {}}
    try:
        async with httpx.AsyncClient(timeout=12) as c:
            health = (await c.get(f"{ETH_BOT_URL}/health")).json()
            hl_url = health.get("api_url", "https://api.hyperliquid-testnet.xyz")
            cur_eq = float(health.get("equity_usd", 0))
            raw = (await c.post(f"{hl_url}/info", json={"type": "userFills", "user": wallet})).json()
        if not isinstance(raw, list):
            return {"ok": False, "error": str(raw), "trades": [], "metrics": {}}
        trades, open_t = [], None
        for f in sorted(raw, key=lambda x: x["time"]):
            if f.get("coin") != "ETH":
                continue
            d = f.get("dir", ""); px = float(f.get("px", 0))
            ts = datetime.fromtimestamp(f["time"]/1000, tz=timezone.utc).isoformat()
            if "Open" in d:
                open_t = {"time": ts, "entry_price": px,
                          "side": "Long" if "Long" in d else "Short",
                          "fee": float(f.get("fee", 0))}
            elif "Close" in d and open_t:
                net = round(float(f.get("closedPnl", 0)) - float(f.get("fee", 0)) - open_t["fee"], 4)
                trades.append({"time": ts, "side": open_t["side"],
                               "entry_price": open_t["entry_price"], "exit_price": px,
                               "pnl": net, "event": d})
                open_t = None
        m = calc_metrics(trades, cur_eq)
        return {"ok": True, "trades": list(reversed(trades[-50:])), "metrics": m}
    except Exception as e:
        return {"ok": False, "error": str(e), "trades": [], "metrics": {}}

# ── WebSocket — MGC live log ───────────────────────────────────────────────────

@app.websocket("/ws/mgc-log")
async def ws_mgc_log(ws: WebSocket):
    await ws.accept()
    last = BOT_LOG.stat().st_size if BOT_LOG.exists() else 0
    try:
        while True:
            await asyncio.sleep(2)
            if not BOT_LOG.exists(): continue
            sz = BOT_LOG.stat().st_size
            if sz > last:
                async with aiofiles.open(BOT_LOG) as f: txt = await f.read()
                lines = txt.splitlines(); new = []; chars = 0
                for ln in reversed(lines):
                    chars += len(ln)
                    if chars > sz - last + 200: break
                    new.insert(0, ln)
                last = sz
                if new: await ws.send_text(json.dumps(new))
    except WebSocketDisconnect: pass

# ── Dashboard HTML ────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
def dashboard(): return HTML

HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Bot Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'SF Mono',monospace;background:#0d0d0d;color:#e0e0e0;font-size:12px}
.topbar{background:#111;border-bottom:1px solid #1e1e1e;padding:10px 16px;display:flex;align-items:center;gap:12px}
.topbar h1{font-size:14px;color:#fff;letter-spacing:1px}
.tabs{display:flex;gap:4px;margin-left:auto}
.tab{padding:5px 14px;border-radius:4px;cursor:pointer;font-size:11px;border:1px solid #2a2a2a;background:#1a1a1a;color:#888}
.tab.active{background:#3b82f6;color:#fff;border-color:#3b82f6}
.tab:hover:not(.active){background:#222;color:#ccc}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:4px}
.dot.g{background:#22c55e;box-shadow:0 0 5px #22c55e}
.dot.r{background:#ef4444;box-shadow:0 0 5px #ef4444}
.dot.y{background:#eab308}
.page{display:none;padding:10px;gap:10px}
.page.active{display:grid}
/* MGC layout */
#page-mgc{grid-template-columns:240px 1fr 320px;grid-template-rows:auto 1fr}
/* ETH layout */
#page-eth{grid-template-columns:260px 1fr 320px}
/* Both layout */
#page-both{grid-template-columns:1fr 1fr}
.card{background:#111;border:1px solid #1e1e1e;border-radius:7px;padding:12px}
.card h2{font-size:10px;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}
.row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #181818}
.row:last-child{border:none}
.lbl{color:#666;font-size:10px}.val{font-size:12px;font-weight:600}
.g{color:#22c55e}.r{color:#ef4444}.dim{color:#555}
.badge{display:inline-block;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:600}
.bg{background:#052e16;color:#22c55e;border:1px solid #16a34a}
.br{background:#2d0707;color:#ef4444;border:1px solid #dc2626}
.by{background:#1c1400;color:#eab308;border:1px solid #ca8a04}
.btn{padding:5px 10px;border:none;border-radius:4px;font-size:10px;cursor:pointer;font-family:inherit;font-weight:600}
.btn:hover{opacity:.8}
.bg2{background:#22c55e;color:#000}.br2{background:#ef4444;color:#fff}
.bb{background:#3b82f6;color:#fff}.bo{background:#f97316;color:#fff}
.bgr{background:#333;color:#ccc}.bpu{background:#a855f7;color:#fff}
.btns{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
select,input{background:#1a1a1a;color:#e0e0e0;border:1px solid #2a2a2a;border-radius:4px;padding:4px 7px;font-size:10px;font-family:inherit}
.mg{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:4px}
.mb{background:#0a0a0a;border-radius:4px;padding:7px;text-align:center}
.mv{font-size:16px;font-weight:700;margin-top:2px}
.ml{font-size:9px;color:#444;text-transform:uppercase;letter-spacing:.5px}
.log{overflow-y:auto;font-size:10px;line-height:1.7;background:#080808;border-radius:4px;padding:7px;height:100%;min-height:160px}
.ll{padding:0}.ls{color:#22c55e;font-weight:bold}.lb{color:#3b82f6;font-weight:bold}
.le{color:#ef4444}.lw{color:#eab308}.lv{color:#a78bfa}.ld{color:#444}.li{color:#666}
.ct{position:relative;height:160px}
.ap{background:#0f2518;border:1px solid #1a4731;border-radius:5px;padding:8px;margin-top:8px}
.msg{font-size:10px;color:#666;margin-top:6px;min-height:14px}
/* chart symbol bar */
.cbar{display:flex;gap:5px;align-items:center;margin-bottom:6px}
</style>
</head>
<body>
<div class="topbar">
  <span class="dot g" id="dot-mgc"></span>
  <h1>ALGO TRADING DASHBOARD</h1>
  <span id="clock" style="color:#444;font-size:11px;margin-left:8px"></span>
  <div class="tabs">
    <div class="tab active" onclick="showTab('mgc')">📊 MGC (IBKR)</div>
    <div class="tab" onclick="showTab('eth')">⚡ ETH (Hyperliquid)</div>
    <div class="tab" onclick="showTab('both')">🔀 Overview</div>
  </div>
</div>

<!-- ═══════════════ MGC PAGE ═══════════════ -->
<div id="page-mgc" class="page active" style="height:calc(100vh - 42px)">

  <!-- col 1: status + controls -->
  <div style="display:flex;flex-direction:column;gap:10px;overflow-y:auto">
    <div class="card">
      <h2>MGC Bot (IBKR Paper)</h2>
      <div class="row"><span class="lbl">Status</span><span id="m-status">—</span></div>
      <div class="row"><span class="lbl">PID</span><span class="val dim" id="m-pid">—</span></div>
      <div class="row"><span class="lbl">Contract</span><span class="val" id="m-contract">—</span></div>
      <div class="row"><span class="lbl">Filter Mode</span><span class="val" id="m-filter">—</span></div>
      <div class="row"><span class="lbl">Session</span><span id="m-session">—</span></div>
      <div class="row"><span class="lbl">Denver Time</span><span class="val" id="m-time">—</span></div>
    </div>
    <div class="card">
      <h2>Account</h2>
      <div class="row"><span class="lbl">Equity</span><span class="val g" id="m-eq">—</span></div>
      <div class="row"><span class="lbl">Daily P&L</span><span class="val" id="m-dpnl">—</span></div>
      <div class="row"><span class="lbl">Trades Today</span><span class="val" id="m-tt">—</span></div>
      <div id="m-posbox" style="display:none" class="ap">
        <div style="font-size:10px;color:#888">OPEN POSITION</div>
        <div class="val g" id="m-side" style="font-size:14px;margin-top:2px">—</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;margin-top:6px;font-size:10px">
          <div><div class="lbl">Entry</div><div id="m-entry">—</div></div>
          <div><div style="color:#ef4444">SL</div><div id="m-sl" style="color:#ef4444">—</div></div>
          <div><div style="color:#22c55e">TP</div><div id="m-tp" style="color:#22c55e">—</div></div>
        </div>
      </div>
    </div>
    <div class="card">
      <h2>Controls</h2>
      <select id="m-fm" style="width:100%;margin-bottom:6px">
        <option value="Baseline">Baseline (session+hour)</option>
        <option value="Session Only">Session Only</option>
        <option value="24h Full" selected>24h Full (no filters)</option>
      </select>
      <div class="btns">
        <button class="btn bg2" onclick="mCtrl('/api/mgc/start')">▶ Start</button>
        <button class="btn br2" onclick="mCtrl('/api/mgc/stop')">■ Stop</button>
        <button class="btn bb" onclick="mCtrl('/api/mgc/restart')">↻ Restart</button>
        <button class="btn bo" onclick="mCtrl('/api/mgc/close-position')">✕ Close</button>
      </div>
      <div class="msg" id="m-msg"></div>
    </div>
  </div>

  <!-- col 2: metrics + equity + trades + chart -->
  <div style="display:flex;flex-direction:column;gap:10px;overflow-y:auto">
    <div class="card">
      <h2>Performance</h2>
      <div class="mg">
        <div class="mb"><div class="ml">Net P&L</div><div class="mv" id="m-net">—</div></div>
        <div class="mb"><div class="ml">Win Rate</div><div class="mv" id="m-wr">—</div></div>
        <div class="mb"><div class="ml">Profit Factor</div><div class="mv" id="m-pf">—</div></div>
        <div class="mb"><div class="ml">Max DD</div><div class="mv r" id="m-dd">—</div></div>
        <div class="mb"><div class="ml">Avg Win</div><div class="mv g" id="m-aw">—</div></div>
        <div class="mb"><div class="ml">Avg Loss</div><div class="mv r" id="m-al">—</div></div>
      </div>
    </div>
    <div class="card">
      <h2>Equity Curve</h2>
      <div class="ct"><canvas id="m-chart"></canvas></div>
    </div>
    <div class="card" style="flex:1;overflow-y:auto">
      <h2>Recent Trades <span id="m-tc" class="dim"></span></h2>
      <div style="display:grid;grid-template-columns:75px 38px 58px 58px 64px 50px;gap:3px;padding:3px 0;font-size:9px;color:#444;text-transform:uppercase">
        <span>Time</span><span>Side</span><span>Entry</span><span>Exit</span><span>P&L</span><span>Result</span>
      </div>
      <div id="m-trades"></div>
    </div>
    <div class="card">
      <div class="cbar">
        <h2 style="margin:0">Chart</h2>
        <input id="m-sym" value="COMEX_MINI:MGC1!" style="flex:1">
        <select id="m-tf"><option value="1">1m</option><option value="3" selected>3m</option><option value="5">5m</option><option value="15">15m</option><option value="60">1H</option><option value="D">D</option></select>
        <button class="btn bgr" onclick="loadChart('m')">Load</button>
      </div>
      <div id="m-tv" style="height:220px;border-radius:4px;overflow:hidden;background:#0a0a0a"></div>
    </div>
  </div>

  <!-- col 3: live log -->
  <div class="card" style="display:flex;flex-direction:column;overflow:hidden">
    <h2>Live Log <span id="m-ws" class="dim" style="font-size:9px"></span></h2>
    <div class="log" id="m-log"></div>
  </div>
</div>

<!-- ═══════════════ ETH PAGE ═══════════════ -->
<div id="page-eth" class="page" style="height:calc(100vh - 42px)">

  <!-- col 1: status + controls -->
  <div style="display:flex;flex-direction:column;gap:10px;overflow-y:auto">
    <div class="card">
      <h2>ETH Supertrend (Hyperliquid)</h2>
      <div class="row"><span class="lbl">Bot Status</span><span id="e-status">—</span></div>
      <div class="row"><span class="lbl">Network</span><span class="val" id="e-net">—</span></div>
      <div class="row"><span class="lbl">Equity</span><span class="val g" id="e-eq">—</span></div>
      <div class="row"><span class="lbl">Bot Enabled</span><span id="e-enabled">—</span></div>
      <div class="row"><span class="lbl">Bot Blocked</span><span id="e-blocked">—</span></div>
      <div class="row"><span class="lbl">Block Reason</span><span class="val dim" id="e-reason">—</span></div>
      <div class="row"><span class="lbl">Instrument</span><span class="val">ETH-USD Perp</span></div>
      <div class="row"><span class="lbl">Timeframe</span><span class="val">4H Supertrend</span></div>
    </div>
    <div class="card">
      <h2>Controls</h2>
      <div class="btns">
        <button class="btn bg2" onclick="eCtrl('/api/eth/enable')">✓ Enable</button>
        <button class="btn br2" onclick="eCtrl('/api/eth/disable')">✗ Disable</button>
        <button class="btn bpu" onclick="eCtrl('/api/eth/unblock')">⟳ Unblock</button>
      </div>
      <div class="msg" id="e-msg"></div>
    </div>
    <div class="card">
      <h2>Trade History Config</h2>
      <div style="font-size:9px;color:#555;margin-bottom:6px">Hyperliquid wallet address (for fills)</div>
      <input id="e-wallet" placeholder="0x..." style="width:100%;font-size:9px" oninput="saveWallet()">
      <div style="font-size:9px;color:#444;margin-top:5px" id="e-wallet-status"></div>
    </div>
  </div>

  <!-- col 2: metrics + equity + trades -->
  <div style="display:flex;flex-direction:column;gap:10px;overflow-y:auto">
    <div class="card">
      <h2>Performance</h2>
      <div class="mg">
        <div class="mb"><div class="ml">Net P&L</div><div class="mv" id="e-net">—</div></div>
        <div class="mb"><div class="ml">Win Rate</div><div class="mv" id="e-wr">—</div></div>
        <div class="mb"><div class="ml">Profit Factor</div><div class="mv" id="e-pf">—</div></div>
        <div class="mb"><div class="ml">Max DD</div><div class="mv r" id="e-dd">—</div></div>
        <div class="mb"><div class="ml">Avg Win</div><div class="mv g" id="e-aw">—</div></div>
        <div class="mb"><div class="ml">Avg Loss</div><div class="mv r" id="e-al">—</div></div>
      </div>
    </div>
    <div class="card">
      <h2>Equity Curve</h2>
      <div class="ct"><canvas id="e-chart"></canvas></div>
    </div>
    <div class="card" style="flex:1;overflow-y:auto">
      <h2>Recent Trades <span id="e-tc" class="dim"></span></h2>
      <div style="display:grid;grid-template-columns:75px 38px 62px 62px 70px 60px;gap:3px;padding:3px 0;font-size:9px;color:#444;text-transform:uppercase">
        <span>Time</span><span>Side</span><span>Entry</span><span>Exit</span><span>P&L</span><span>Result</span>
      </div>
      <div id="e-trades"><div class="dim" style="padding:8px;font-size:10px">Set wallet address to load history</div></div>
    </div>
  </div>

  <!-- col 3: chart + info -->
  <div style="display:flex;flex-direction:column;gap:10px;overflow-y:auto">
    <div class="card">
      <div class="cbar">
        <h2 style="margin:0">Chart</h2>
        <input id="e-sym" value="COINBASE:ETHUSD" style="flex:1">
        <select id="e-tf">
          <option value="60">1H</option>
          <option value="240" selected>4H</option>
          <option value="D">1D</option>
        </select>
        <button class="btn bgr" onclick="loadChart('e')">Load</button>
      </div>
      <div id="e-tv" style="height:280px;border-radius:4px;overflow:hidden;background:#0a0a0a"></div>
    </div>
    <div class="card">
      <h2>Webhook Setup</h2>
      <div style="background:#0a0a0a;border-radius:4px;padding:8px;font-size:9px;color:#888;font-family:monospace;line-height:1.8">
        <div style="color:#555">URL:</div>
        <div style="color:#3b82f6">https://hl-webhook-bot.fly.dev/tradingview</div>
        <div style="color:#555;margin-top:6px">Payload:</div>
        <div style="color:#22c55e">{"secret":"ayush_supertrend_secure_9284",</div>
        <div style="color:#22c55e">&nbsp;"action":"entry","side":"buy",</div>
        <div style="color:#22c55e">&nbsp;"symbol":"ETH","leverage":5}</div>
      </div>
    </div>
  </div>
</div>

<!-- ═══════════════ BOTH / OVERVIEW ═══════════════ -->
<div id="page-both" class="page" style="height:calc(100vh - 42px)">
  <div class="card">
    <h2>MGC Bot — IBKR Paper</h2>
    <div class="row"><span class="lbl">Status</span><span id="b-m-status">—</span></div>
    <div class="row"><span class="lbl">Equity</span><span class="val g" id="b-m-eq">—</span></div>
    <div class="row"><span class="lbl">Filter Mode</span><span class="val" id="b-m-filter">—</span></div>
    <div class="row"><span class="lbl">Contract</span><span class="val" id="b-m-contract">—</span></div>
    <div class="row"><span class="lbl">Daily P&L</span><span class="val" id="b-m-dpnl">—</span></div>
    <div class="row"><span class="lbl">Session</span><span id="b-m-session">—</span></div>
    <div class="row"><span class="lbl">Active Position</span><span class="val" id="b-m-side">Flat</span></div>
    <div style="margin-top:10px">
      <div class="ct"><canvas id="b-m-chart"></canvas></div>
    </div>
    <div class="btns" style="margin-top:8px">
      <button class="btn bg2" onclick="mCtrl('/api/mgc/start')">▶ Start</button>
      <button class="btn br2" onclick="mCtrl('/api/mgc/stop')">■ Stop</button>
      <button class="btn bb" onclick="mCtrl('/api/mgc/restart')">↻ Restart</button>
    </div>
    <div class="msg" id="b-m-msg"></div>
  </div>
  <div class="card">
    <h2>ETH Bot — Hyperliquid</h2>
    <div class="row"><span class="lbl">Status</span><span id="b-e-status">—</span></div>
    <div class="row"><span class="lbl">Equity</span><span class="val g" id="b-e-eq">—</span></div>
    <div class="row"><span class="lbl">Network</span><span class="val" id="b-e-net">—</span></div>
    <div class="row"><span class="lbl">Bot Enabled</span><span id="b-e-enabled">—</span></div>
    <div class="row"><span class="lbl">Bot Blocked</span><span id="b-e-blocked">—</span></div>
    <div style="margin-top:10px">
      <div class="ct"><canvas id="b-e-chart"></canvas></div>
    </div>
    <div class="btns" style="margin-top:8px">
      <button class="btn bg2" onclick="eCtrl('/api/eth/enable')">✓ Enable</button>
      <button class="btn br2" onclick="eCtrl('/api/eth/disable')">✗ Disable</button>
      <button class="btn bpu" onclick="eCtrl('/api/eth/unblock')">⟳ Unblock</button>
    </div>
    <div class="msg" id="b-e-msg"></div>
  </div>
</div>

<script>
// ── Tab switching ──────────────────────────────────────────────────────────
function showTab(t){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(tb=>tb.classList.remove('active'));
  document.getElementById('page-'+t).classList.add('active');
  event.target.classList.add('active');
}

// ── Charts ─────────────────────────────────────────────────────────────────
const charts = {};
function mkChart(id, data){
  const ctx = document.getElementById(id);
  if(!ctx) return;
  if(charts[id]) charts[id].destroy();
  const c = data.length>1 && data[data.length-1]>=data[0] ? '#22c55e':'#ef4444';
  charts[id] = new Chart(ctx,{type:'line',data:{labels:data.map((_,i)=>i),datasets:[{data,borderColor:c,borderWidth:1.5,fill:true,backgroundColor:c+'15',pointRadius:0,tension:0.1}]},options:{responsive:true,maintainAspectRatio:false,animation:false,plugins:{legend:{display:false}},scales:{x:{display:false},y:{grid:{color:'#111'},ticks:{color:'#444',font:{size:9}}}}}});
}

// ── TradingView chart embed ────────────────────────────────────────────────
function loadChart(prefix){
  const sym = document.getElementById(prefix+'-sym').value.trim();
  const tf = document.getElementById(prefix+'-tf').value;
  const el = document.getElementById(prefix+'-tv');
  el.innerHTML='';
  const s=document.createElement('script');
  s.src='https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  s.async=true;
  s.innerHTML=JSON.stringify({"autosize":true,"symbol":sym,"interval":tf,"timezone":"America/Denver","theme":"dark","style":"1","locale":"en","enable_publishing":false,"hide_top_toolbar":false,"hide_legend":false,"save_image":false,"calendar":false,"support_host":"https://www.tradingview.com"});
  el.appendChild(s);
}

// ── MGC polling ─────────────────────────────────────────────────────────────
async function pollMGC(){
  try{
    const [sr,tr]=await Promise.all([fetch('/api/mgc/status'),fetch('/api/mgc/trades')]);
    const s=await sr.json(), t=await tr.json(), m=t.metrics;
    const run=s.running;
    document.getElementById('dot-mgc').className='dot '+(run?'g':'r');
    const badge=run?'<span class="badge bg">RUNNING</span>':'<span class="badge br">STOPPED</span>';
    ['m-status','b-m-status'].forEach(id=>{const e=document.getElementById(id);if(e)e.innerHTML=badge;});
    set('m-pid',s.pid||'—');
    set('m-contract',s.contract); set('b-m-contract',s.contract);
    set('m-filter',s.filter_mode); set('b-m-filter',s.filter_mode);
    set('m-time',s.denver);
    const sb=s.session?'<span class="badge bg">OPEN</span>':'<span class="badge by">CLOSED</span>';
    ['m-session','b-m-session'].forEach(id=>{const e=document.getElementById(id);if(e)e.innerHTML=sb;});
    const eq='$'+s.equity.toLocaleString('en-US',{minimumFractionDigits:2});
    set('m-eq',eq); set('b-m-eq',eq);
    const dp=(s.daily_pnl||0); const dpstr=(dp>=0?'+':'')+' $'+dp.toFixed(2);
    setC('m-dpnl',dpstr,dp>0?'val g':dp<0?'val r':'val dim');
    setC('b-m-dpnl',dpstr,dp>0?'val g':dp<0?'val r':'val dim');
    set('m-tt',s.trades_today||0);
    const hp=s.active_side&&s.active_side!='';
    const pb=document.getElementById('m-posbox');if(pb)pb.style.display=hp?'block':'none';
    if(hp){set('m-side',s.active_side.toUpperCase());set('m-entry',(s.active_entry||0).toFixed(1));set('m-sl',(s.active_sl||0).toFixed(1));set('m-tp',(s.active_tp||0).toFixed(1));}
    set('b-m-side',hp?s.active_side.toUpperCase():'Flat');
    set('m-net',(m.net>=0?'+':'')+'$'+m.net.toFixed(0),m.net>=0?'mv g':'mv r');
    set('m-wr',m.wr.toFixed(1)+'%');set('m-pf',m.pf.toFixed(3));
    set('m-dd',m.max_dd.toFixed(1)+'%');set('m-aw','+$'+m.avg_win.toFixed(2));
    set('m-al','-$'+Math.abs(m.avg_loss).toFixed(2));
    set('m-tc','('+m.total+' trades)');
    mkChart('m-chart',m.equity_curve||[]);mkChart('b-m-chart',m.equity_curve||[]);
    const th=t.trades.map(tr=>{
      const dt=new Date(tr.time||tr.exit_time||'');
      const ts=isNaN(dt)?'—':dt.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
      const pnl=tr.pnl||tr.net_pnl_usd||0; const side=(tr.side||tr.direction||'').toUpperCase();
      const en=(tr.entry_price||0).toFixed(1); const ex=(tr.exit_price||0).toFixed(1);
      const res=tr.event||tr.exit_reason||tr.result||'';
      return `<div style="display:grid;grid-template-columns:75px 38px 58px 58px 64px 50px;gap:3px;padding:3px 0;border-bottom:1px solid #141414;font-size:10px">
        <span class="dim">${ts}</span>
        <span style="color:${side=='LONG'?'#22c55e':'#ef4444'}">${side}</span>
        <span>${en}</span><span>${ex}</span>
        <span class="${pnl>=0?'g':'r'}">${pnl>=0?'+':''}$${pnl.toFixed(2)}</span>
        <span class="dim">${res}</span></div>`;}).join('');
    const tl=document.getElementById('m-trades');if(tl)tl.innerHTML=th||'<div class="dim" style="padding:8px">No trades yet</div>';
  }catch(e){}
}

// ── ETH wallet ──────────────────────────────────────────────────────────────
function saveWallet(){
  const w=document.getElementById('e-wallet')?.value.trim()||'';
  localStorage.setItem('eth_wallet',w);
  const s=document.getElementById('e-wallet-status');
  if(s)s.textContent=w?'Saved ✓':'Cleared';
}
function loadWalletInput(){
  const w=localStorage.getItem('eth_wallet')||'0xD8cb475a415cEd00aAd3F794a2451eB096735a38';
  const el=document.getElementById('e-wallet');
  if(el)el.value=w;
}

// ── ETH polling ──────────────────────────────────────────────────────────────
async function pollETH(){
  try{
    const r=await fetch('/api/eth/status'); const s=await r.json();
    const ok=s.ok;
    const badge=ok?'<span class="badge bg">ONLINE</span>':'<span class="badge br">OFFLINE</span>';
    ['e-status','b-e-status'].forEach(id=>{const e=document.getElementById(id);if(e)e.innerHTML=badge;});
    const net=s.testnet?'<span class="badge by">TESTNET</span>':'<span class="badge bg">MAINNET</span>';
    set('e-net',net); set('b-e-net',net);
    const eq='$'+(s.equity_usd||0).toFixed(2);
    set('e-eq',eq); set('b-e-eq',eq);
    const en=s.bot_enabled?'<span class="badge bg">YES</span>':'<span class="badge br">NO</span>';
    set('e-enabled',en); set('b-e-enabled',en);
    const bl=s.bot_blocked?'<span class="badge br">BLOCKED</span>':'<span class="badge bg">NO</span>';
    set('e-blocked',bl); set('b-e-blocked',bl);
    set('e-reason',s.block_reason||'—');
  }catch(e){}
  // Fetch fills if wallet configured
  const wallet=localStorage.getItem('eth_wallet')||'';
  if(!wallet) return;
  try{
    const r=await fetch('/api/eth/fills?wallet='+encodeURIComponent(wallet));
    const d=await r.json();
    if(!d.ok) return;
    const m=d.metrics;
    set('e-net',(m.net>=0?'+':'')+'$'+m.net.toFixed(2),m.net>=0?'mv g':'mv r');
    set('e-wr',m.wr.toFixed(1)+'%');
    set('e-pf',m.pf.toFixed(3));
    set('e-dd',m.max_dd.toFixed(1)+'%');
    set('e-aw','+$'+(m.avg_win||0).toFixed(2));
    set('e-al','-$'+Math.abs(m.avg_loss||0).toFixed(2));
    set('e-tc','('+m.total+' trades)');
    mkChart('e-chart',m.equity_curve||[]);
    const th=d.trades.map(tr=>{
      const dt=new Date(tr.time||'');
      const ts=isNaN(dt)?'—':dt.toLocaleString('en-US',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
      const pnl=tr.pnl||0; const side=(tr.side||'').toUpperCase();
      const en=(tr.entry_price||0).toFixed(1); const ex=(tr.exit_price||0).toFixed(1);
      const ev=(tr.event||'').replace('Close ','').replace('Open ','');
      return `<div style="display:grid;grid-template-columns:75px 38px 62px 62px 70px 60px;gap:3px;padding:3px 0;border-bottom:1px solid #141414;font-size:10px">
        <span class="dim">${ts}</span>
        <span style="color:${side==='LONG'?'#22c55e':'#ef4444'}">${side}</span>
        <span>${en}</span><span>${ex}</span>
        <span class="${pnl>=0?'g':'r'}">${pnl>=0?'+':''}$${pnl.toFixed(2)}</span>
        <span class="dim">${ev}</span></div>`;
    }).join('');
    const tl=document.getElementById('e-trades');
    if(tl)tl.innerHTML=th||'<div class="dim" style="padding:8px">No completed trades yet</div>';
  }catch(e){}
}

// ── Controls ────────────────────────────────────────────────────────────────
async function mCtrl(url){
  const fm=document.getElementById('m-fm')?.value||'24h Full';
  try{
    const r=await fetch(url+'?filter_mode='+encodeURIComponent(fm),{method:'POST'});
    const d=await r.json();
    ['m-msg','b-m-msg'].forEach(id=>{const e=document.getElementById(id);if(e)e.textContent=d.msg||'';});
    setTimeout(()=>['m-msg','b-m-msg'].forEach(id=>{const e=document.getElementById(id);if(e)e.textContent='';}),5000);
    setTimeout(pollMGC,1500);
  }catch(e){}
}
async function eCtrl(url){
  try{
    const r=await fetch(url,{method:'POST'});const d=await r.json();
    ['e-msg','b-e-msg'].forEach(id=>{const e=document.getElementById(id);if(e)e.textContent=JSON.stringify(d);});
    setTimeout(()=>['e-msg','b-e-msg'].forEach(id=>{const e=document.getElementById(id);if(e)e.textContent='';}),5000);
    setTimeout(pollETH,1000);
  }catch(e){}
}

// ── Log WebSocket ────────────────────────────────────────────────────────────
let ws=null;
function connectWS(){
  ws=new WebSocket('ws://'+location.host+'/ws/mgc-log');
  ws.onopen=()=>{const e=document.getElementById('m-ws');if(e)e.textContent='● live';};
  ws.onclose=()=>{const e=document.getElementById('m-ws');if(e)e.textContent='○ reconnecting';setTimeout(connectWS,3000);};
  ws.onmessage=e=>{
    const lines=JSON.parse(e.data); const box=document.getElementById('m-log');
    if(!box)return;
    lines.forEach(ln=>{
      const d=document.createElement('div'); d.className='ll';
      const cl=ln.includes('SIGNAL')?'ls':ln.includes('BRACKET')?'lb':ln.includes('ERROR')?'le':ln.includes('WARN')?'lw':ln.includes('SWEEP')?'lv':ln.includes('SEED')?'ld':'li';
      d.className='ll '+cl;
      d.textContent=ln.replace(/^.*?(INFO|ERROR|WARNING)\s+/,'');
      box.appendChild(d);
    });
    box.scrollTop=box.scrollHeight;
  };
}
async function loadInitLog(){
  try{const r=await fetch('/api/mgc/log');const d=await r.json();
    const box=document.getElementById('m-log');if(!box)return;
    d.lines.forEach(ln=>{const div=document.createElement('div');
      const cl=ln.includes('SIGNAL')?'ls':ln.includes('BRACKET')?'lb':ln.includes('ERROR')?'le':ln.includes('WARN')?'lw':ln.includes('SWEEP')?'lv':ln.includes('SEED')?'ld':'li';
      div.className='ll '+cl;div.textContent=ln.replace(/^.*?(INFO|ERROR|WARNING)\s+/,'');box.appendChild(div);});
    box.scrollTop=box.scrollHeight;}catch(e){}
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function set(id,val,cls){
  const e=document.getElementById(id);if(!e)return;
  if(typeof val==='string'&&val.startsWith('<'))e.innerHTML=val;
  else e.textContent=val;
  if(cls)e.className=cls;
}
function setC(id,val,cls){set(id,val,cls);}
function tick(){document.getElementById('clock').textContent=new Date().toLocaleTimeString('en-US',{hour12:false});}

// ── Init ──────────────────────────────────────────────────────────────────────
loadInitLog(); connectWS();
loadChart('m'); loadChart('e');
loadWalletInput();
pollMGC(); pollETH();
setInterval(pollMGC,6000); setInterval(pollETH,30000); setInterval(tick,1000);
tick();
</script>
</body>
</html>"""

if __name__ == "__main__":
    print("Dashboard → http://localhost:8080")
    uvicorn.run(app, host="0.0.0.0", port=8080, log_level="warning")
