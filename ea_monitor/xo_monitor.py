# -*- coding: utf-8 -*-
"""
xo_monitor.py — TraderXO EA Monitor
- Poll MT5 moi 10s: detect open/closed trades (magic 202509)
- Log vao journal.db (table ea_trades, ea_equity_log)
- Telegram notify khi co trade moi / dong lenh / DD canh bao
- Live dashboard tren terminal
"""
import sys, io, os, time, sqlite3, subprocess
from datetime import datetime, timezone
from pathlib import Path
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import MetaTrader5 as mt5

# ─── CONFIG ──────────────────────────────────────────────────────────────────
MAGIC        = 202509
SYMBOL       = "XAUUSD"
DB_PATH      = Path(__file__).parent / "multi_ea_journal.db"
TG_SCRIPT    = str(Path(__file__).parent / "telegram_notify.py")
POLL_SEC     = 10       # check interval
DD_WARN_PCT  = 10.0     # Telegram alert khi DD vuot nguong
EQUITY_LOG_MIN = 60     # log equity moi N phut

# ─── DATABASE SETUP ───────────────────────────────────────────────────────────
def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ea_trades (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket        INTEGER UNIQUE,
            symbol        TEXT,
            direction     TEXT,          -- LONG / SHORT
            open_time     TEXT,
            close_time    TEXT,
            open_price    REAL,
            close_price   REAL,
            lot           REAL,
            sl_price      REAL,
            tp_price      REAL,
            atr_at_entry  REAL,
            pnl_usd       REAL,
            pnl_r         REAL,         -- P&L in R units
            exit_reason   TEXT,         -- TP / SL / MANUAL
            status        TEXT DEFAULT 'OPEN',
            created_at    TEXT DEFAULT (datetime('now'))
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ea_equity_log (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            ts         TEXT,
            balance    REAL,
            equity     REAL,
            drawdown   REAL,
            open_lots  REAL,
            logged_at  TEXT DEFAULT (datetime('now'))
        )
    """)
    conn.commit()
    conn.close()

# ─── TELEGRAM ─────────────────────────────────────────────────────────────────
def notify(msg: str):
    try:
        subprocess.Popen(
            [sys.executable, TG_SCRIPT, msg, "--html"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
    except Exception as e:
        print(f"  [TG error] {e}")

# ─── HELPERS ─────────────────────────────────────────────────────────────────
def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def ts_from_mt5(unix_ts):
    return datetime.fromtimestamp(unix_ts).strftime("%Y-%m-%d %H:%M:%S")

def get_known_tickets(conn):
    cur = conn.execute("SELECT ticket FROM ea_trades")
    return {r[0] for r in cur.fetchall()}

def get_open_tickets(conn):
    cur = conn.execute("SELECT ticket FROM ea_trades WHERE status='OPEN'")
    return {r[0] for r in cur.fetchall()}

# ─── MT5 DATA ─────────────────────────────────────────────────────────────────
def get_positions():
    pos = mt5.positions_get(symbol=SYMBOL)
    if pos is None: return []
    return [p for p in pos if p.magic == MAGIC]

def get_recent_deals(from_ts):
    """Lay tat ca deals tu thoi diem from_ts, filter theo magic."""
    deals = mt5.history_deals_get(from_ts, time.time() + 60)
    if deals is None: return []
    return [d for d in deals if d.magic == MAGIC and d.symbol == SYMBOL]

def account():
    return mt5.account_info()

# ─── OPEN TRADE LOGGING ───────────────────────────────────────────────────────
def log_open(conn, pos, known):
    if pos.ticket in known:
        return False

    direction = "LONG" if pos.type == 0 else "SHORT"
    conn.execute("""
        INSERT OR IGNORE INTO ea_trades
        (ticket, symbol, direction, open_time, open_price, lot, sl_price, tp_price, status)
        VALUES (?,?,?,?,?,?,?,?,?)
    """, (pos.ticket, pos.symbol, direction,
          ts_from_mt5(pos.time), pos.price_open,
          pos.volume, pos.sl, pos.tp, "OPEN"))
    conn.commit()

    sl_dist = abs(pos.price_open - pos.sl) if pos.sl else 0
    tp_dist = abs(pos.tp - pos.price_open) if pos.tp else 0
    acc     = account()

    msg = (
        f"<b>XAUUSD NEW {direction}</b>\n"
        f"Lot: <code>{pos.volume:.2f}</code>  @<code>{pos.price_open:.2f}</code>\n"
        f"SL: <code>{pos.sl:.2f}</code> ({sl_dist:.2f} pts)\n"
        f"TP: <code>{pos.tp:.2f}</code> ({tp_dist:.2f} pts)\n"
        f"RR: 1:{tp_dist/sl_dist:.1f}\n"
        f"Balance: <code>${acc.balance:.2f}</code>"
    )
    notify(msg)
    print(f"  [NEW {direction}] #{pos.ticket} lot={pos.volume} @{pos.price_open:.2f} "
          f"SL={pos.sl:.2f} TP={pos.tp:.2f}")
    return True

# ─── CLOSE TRADE LOGGING ──────────────────────────────────────────────────────
def check_closed(conn, open_tickets, all_deals):
    """Tim cac ticket da dong: co trong open_tickets nhung khong con trong positions."""
    current_pos_tickets = {p.ticket for p in get_positions()}
    closed_now = open_tickets - current_pos_tickets

    for ticket in closed_now:
        # Tim deal dong khop voi ticket nay
        matching = [d for d in all_deals if d.position_id == ticket and d.entry == 1]
        if not matching:
            continue
        deal = matching[-1]

        pnl = deal.profit + deal.commission + deal.swap

        # Lay thong tin entry tu DB
        cur = conn.execute(
            "SELECT open_price, sl_price, tp_price, lot, direction FROM ea_trades WHERE ticket=?",
            (ticket,)
        )
        row = cur.fetchone()
        if not row: continue
        open_price, sl, tp, lot, direction = row

        # Tinh exit reason
        close_price = deal.price
        sl_dist = abs(open_price - sl) if sl else 0
        pnl_r = (pnl / (sl_dist * lot * 100)) if sl_dist > 0 else 0

        if tp and abs(close_price - tp) < 0.5:
            reason = "TP"
        elif sl and abs(close_price - sl) < 0.5:
            reason = "SL"
        else:
            reason = "MANUAL"

        conn.execute("""
            UPDATE ea_trades
            SET close_time=?, close_price=?, pnl_usd=?, pnl_r=?, exit_reason=?, status='CLOSED'
            WHERE ticket=?
        """, (ts_from_mt5(deal.time), close_price,
              round(pnl, 2), round(pnl_r, 2), reason, ticket))
        conn.commit()

        sign  = "+" if pnl >= 0 else ""
        emoji = "GREEN" if pnl >= 0 else "RED"
        acc   = account()
        msg = (
            f"<b>XAUUSD {direction} CLOSED [{reason}]</b>\n"
            f"@<code>{open_price:.2f}</code> -> <code>{close_price:.2f}</code>\n"
            f"PnL: <code>{sign}{pnl:.2f} USD</code> ({sign}{pnl_r:.2f}R)\n"
            f"Balance: <code>${acc.balance:.2f}</code>"
        )
        notify(msg)
        print(f"  [CLOSED {reason}] #{ticket} {direction} pnl={sign}{pnl:.2f}$ ({sign}{pnl_r:.2f}R)")

# ─── EQUITY LOGGING ───────────────────────────────────────────────────────────
last_eq_log = 0
peak_equity = 0
dd_warned   = False

def log_equity(conn):
    global last_eq_log, peak_equity, dd_warned
    now = time.time()
    if now - last_eq_log < EQUITY_LOG_MIN * 60:
        return
    last_eq_log = now

    acc  = account()
    if acc is None: return
    bal  = acc.balance
    eq   = acc.equity
    pos  = get_positions()
    lots = sum(p.volume for p in pos)

    if eq > peak_equity:
        peak_equity = eq
    dd = (peak_equity - eq) / peak_equity * 100 if peak_equity > 0 else 0

    conn.execute("""
        INSERT INTO ea_equity_log (ts, balance, equity, drawdown, open_lots)
        VALUES (?,?,?,?,?)
    """, (now_str(), bal, eq, round(dd, 2), lots))
    conn.commit()

    # DD warning
    if dd >= DD_WARN_PCT and not dd_warned:
        dd_warned = True
        notify(
            f"<b>CANH BAO: XAUUSD Drawdown {dd:.1f}%</b>\n"
            f"Balance: <code>${bal:.2f}</code> | Equity: <code>${eq:.2f}</code>\n"
            f"Peak: <code>${peak_equity:.2f}</code>\n"
            f"Kiem tra EA ngay!"
        )
    elif dd < DD_WARN_PCT * 0.7:
        dd_warned = False  # reset sau khi phuc hoi

# ─── DASHBOARD ────────────────────────────────────────────────────────────────
def print_dashboard(positions):
    acc = account()
    if not acc: return

    bal = acc.balance; eq = acc.equity
    dd  = (peak_equity - eq) / peak_equity * 100 if peak_equity > 0 else 0
    floating = sum(p.profit for p in positions)

    os.system("cls" if os.name == "nt" else "clear")
    print("=" * 58)
    print("  TraderXO XAUUSD Monitor  |  " + now_str())
    print("=" * 58)
    print(f"  Account  : {acc.login} ({acc.server})")
    print(f"  Balance  : ${bal:.2f}")
    print(f"  Equity   : ${eq:.2f}  (float {'+' if floating>=0 else ''}{floating:.2f})")
    print(f"  DD/peak  : {dd:.1f}%  (peak ${peak_equity:.2f})")
    print("-" * 58)

    if positions:
        print(f"  OPEN POSITIONS ({len(positions)})")
        for p in positions:
            side = "LONG" if p.type == 0 else "SHORT"
            age  = int((time.time() - p.time) / 60)
            sign = "+" if p.profit >= 0 else ""
            print(f"  #{p.ticket} {side} {p.volume}lot  "
                  f"@{p.price_open:.2f}  SL={p.sl:.2f}  TP={p.tp:.2f}")
            print(f"    Float={sign}{p.profit:.2f}$  Age={age}min")
    else:
        print("  No open positions — watching for signal...")

    print("-" * 58)

    # Recent closed trades from DB
    conn = sqlite3.connect(DB_PATH)
    cur = conn.execute("""
        SELECT direction, open_price, close_price, pnl_usd, pnl_r, exit_reason, close_time
        FROM ea_trades WHERE status='CLOSED'
        ORDER BY id DESC LIMIT 5
    """)
    rows = cur.fetchall()
    conn.close()

    if rows:
        print("  LAST 5 TRADES")
        for r in rows:
            d, op, cp, pnl, pnl_r, reason, ct = r
            sign = "+" if (pnl or 0) >= 0 else ""
            print(f"  {(ct or '')[:16]}  {d:5s}  {op:.2f}->{cp:.2f}  "
                  f"{sign}{pnl:.2f}$ ({sign}{pnl_r:.2f}R) [{reason}]")

    print("=" * 58)
    print(f"  Polling every {POLL_SEC}s | Ctrl+C to stop")

# ─── MAIN LOOP ────────────────────────────────────────────────────────────────
def main():
    global peak_equity

    print("Connecting to MT5...")
    if not mt5.initialize():
        print("MT5 init failed:", mt5.last_error())
        sys.exit(1)

    acc = account()
    print(f"Connected: {acc.login} @ {acc.server} | ${acc.balance:.2f} {acc.currency}")

    init_db()
    print("DB initialized:", DB_PATH)

    peak_equity = acc.equity
    start_ts    = time.time() - 86400  # lay deals 24h truoc de bat cac lenh cu

    notify(
        f"<b>TraderXO Monitor started</b>\n"
        f"Account: <code>{acc.login}</code> @ {acc.server}\n"
        f"Balance: <code>${acc.balance:.2f}</code>"
    )
    print("Telegram notified. Starting monitor loop...\n")

    conn = sqlite3.connect(DB_PATH)

    try:
        while True:
            positions  = get_positions()
            all_deals  = get_recent_deals(start_ts)
            known      = get_known_tickets(conn)
            open_in_db = get_open_tickets(conn)

            # Log new open positions
            for p in positions:
                log_open(conn, p, known)
                known.add(p.ticket)

            # Log closed trades
            if open_in_db:
                check_closed(conn, open_in_db, all_deals)

            # Log equity periodically
            log_equity(conn)

            # Refresh dashboard
            print_dashboard(positions)

            time.sleep(POLL_SEC)

    except KeyboardInterrupt:
        print("\nMonitor stopped.")
        notify("<b>TraderXO Monitor stopped</b> (manual)")
    finally:
        conn.close()
        mt5.shutdown()

if __name__ == "__main__":
    main()
