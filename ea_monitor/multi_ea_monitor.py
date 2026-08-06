# -*- coding: utf-8 -*-
"""
multi_ea_monitor.py
Monitor tất cả EA đang chạy trên MT5 demo
- Auto-detect magic numbers từ positions/history
- Live dashboard từng EA
- Log SQLite + weekly report
- Telegram alert khi có trade hoặc DD cảnh báo

EAs đang theo dõi:
  LondonBO_USDJPY_EA  (magic: auto-detect)
  LondonBO_EA XAUUSD  (magic: auto-detect)
  BB_ShortOnly_XAUUSD (magic: 202510, đã biết)
"""
import sys, io, os, time, sqlite3
from datetime import datetime, timedelta
from collections import defaultdict
from pathlib import Path
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import MetaTrader5 as mt5

# ─── CONFIG ──────────────────────────────────────────────────────────────────
DB_PATH      = Path(__file__).parent / "multi_ea_journal.db"
TG_SCRIPT    = str(Path(__file__).parent / "telegram_notify.py")
POLL_SEC     = 15
DD_WARN_PCT  = 10.0
EQUITY_LOG_MIN = 60

# EA labels — điền magic sau khi EA trade lần đầu
# Script sẽ auto-detect và thêm vào đây
EA_LABELS = {
    202510: "BB_Short_XAUUSD",
    # 202509: "TraderXO_XAUUSD",   # uncomment nếu cần
}

# Backtest benchmark để so sánh (PF, WR từ backtest)
EA_BENCHMARK = {
    202510: {"pf": 1.649, "wr": 45.5, "name": "BB_Short_XAUUSD"},
}

# ─── DATABASE ─────────────────────────────────────────────────────────────────
def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS trades (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket      INTEGER UNIQUE,
            magic       INTEGER,
            ea_label    TEXT,
            symbol      TEXT,
            direction   TEXT,
            open_time   TEXT,
            close_time  TEXT,
            open_price  REAL,
            close_price REAL,
            lot         REAL,
            sl          REAL,
            tp          REAL,
            pnl         REAL,
            commission  REAL,
            swap        REAL,
            net_pnl     REAL,
            exit_reason TEXT,
            status      TEXT DEFAULT 'OPEN',
            created_at  TEXT DEFAULT (datetime('now'))
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS equity_log (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            ts        TEXT,
            balance   REAL,
            equity    REAL,
            drawdown  REAL,
            open_lots REAL,
            open_pnl  REAL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS weekly_reports (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            week_start TEXT,
            week_end   TEXT,
            magic      INTEGER,
            ea_label   TEXT,
            trades     INTEGER,
            wins       INTEGER,
            losses     INTEGER,
            win_rate   REAL,
            pf         REAL,
            net_pnl    REAL,
            max_dd     REAL,
            created_at TEXT DEFAULT (datetime('now'))
        )
    """)
    conn.commit()
    return conn

# ─── HELPERS ──────────────────────────────────────────────────────────────────
def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def ts_str(unix_ts):
    return datetime.fromtimestamp(unix_ts).strftime("%Y-%m-%d %H:%M:%S")

def notify(msg):
    try:
        import subprocess
        subprocess.Popen([sys.executable, TG_SCRIPT, msg, "--html"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except: pass

def get_ea_label(magic):
    return EA_LABELS.get(magic, f"EA_{magic}")

# ─── MT5 QUERIES ──────────────────────────────────────────────────────────────
def get_all_positions():
    pos = mt5.positions_get()
    return list(pos) if pos else []

def get_deals_since(from_ts):
    deals = mt5.history_deals_get(from_ts, time.time() + 60)
    return list(deals) if deals else []

def get_account():
    return mt5.account_info()

# ─── AUTO-DETECT MAGIC NUMBERS ────────────────────────────────────────────────
def discover_magic_numbers(conn, deals, positions):
    """Tìm magic numbers mới từ deals/positions, thêm vào DB và EA_LABELS."""
    known = set(EA_LABELS.keys())
    new_found = []

    for pos in positions:
        if pos.magic > 0 and pos.magic not in known:
            known.add(pos.magic)
            new_found.append((pos.magic, pos.symbol, pos.comment))

    for d in deals:
        if d.magic > 0 and d.magic not in known:
            known.add(d.magic)
            new_found.append((d.magic, d.symbol, d.comment))

    for magic, symbol, comment in new_found:
        label = f"EA_{magic}_{symbol[:3]}"
        # Try to extract name from comment
        if comment and len(comment) > 2:
            label = comment.split('|')[0].strip()[:20]
        EA_LABELS[magic] = label
        print(f"  [NEW EA DETECTED] magic={magic} -> {label} ({symbol})")
        notify(f"<b>New EA detected</b>\nMagic: <code>{magic}</code>\nLabel: {label}\nSymbol: {symbol}")

# ─── TRADE LOGGING ────────────────────────────────────────────────────────────
def log_open_position(conn, pos, known_tickets):
    if pos.ticket in known_tickets:
        return False
    direction = "LONG" if pos.type == 0 else "SHORT"
    label = get_ea_label(pos.magic)
    conn.execute("""
        INSERT OR IGNORE INTO trades
        (ticket, magic, ea_label, symbol, direction, open_time,
         open_price, lot, sl, tp, status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
    """, (pos.ticket, pos.magic, label, pos.symbol, direction,
          ts_str(pos.time), pos.price_open, pos.volume,
          pos.sl, pos.tp, "OPEN"))
    conn.commit()

    acc = get_account()
    sl_dist = abs(pos.price_open - pos.sl) if pos.sl else 0
    tp_dist = abs(pos.tp - pos.price_open) if pos.tp else 0
    rr = f"1:{tp_dist/sl_dist:.1f}" if sl_dist > 0 else "N/A"

    msg = (f"<b>[{label}] NEW {direction}</b>\n"
           f"Symbol: <code>{pos.symbol}</code>\n"
           f"Lot: <code>{pos.volume}</code>  @<code>{pos.price_open:.2f}</code>\n"
           f"SL: <code>{pos.sl:.2f}</code>  TP: <code>{pos.tp:.2f}</code>  RR: {rr}\n"
           f"Balance: <code>${acc.balance:.2f}</code>")
    notify(msg)
    print(f"  [OPEN {direction}] {label} | {pos.symbol} | lot={pos.volume} @{pos.price_open:.2f}")
    return True

def log_closed_trades(conn, open_in_db, all_deals):
    current_tickets = {p.ticket for p in get_all_positions()}
    closed_now = open_in_db - current_tickets
    if not closed_now:
        return

    for ticket in closed_now:
        matching = [d for d in all_deals if d.position_id == ticket and d.entry == 1]
        if not matching:
            continue
        deal = matching[-1]

        row = conn.execute(
            "SELECT open_price, sl, tp, lot, direction, magic, ea_label, symbol FROM trades WHERE ticket=?",
            (ticket,)
        ).fetchone()
        if not row:
            continue
        op, sl, tp, lot, direction, magic, label, symbol = row

        pnl    = deal.profit
        comm   = deal.commission
        swap   = deal.swap
        net    = pnl + comm + swap
        cp     = deal.price

        if tp and abs(cp - tp) < 1.0:
            reason = "TP"
        elif sl and abs(cp - sl) < 1.0:
            reason = "SL"
        else:
            reason = "MANUAL"

        conn.execute("""
            UPDATE trades SET
                close_time=?, close_price=?, pnl=?, commission=?,
                swap=?, net_pnl=?, exit_reason=?, status='CLOSED'
            WHERE ticket=?
        """, (ts_str(deal.time), cp, round(pnl,2), round(comm,2),
              round(swap,2), round(net,2), reason, ticket))
        conn.commit()

        sign = "+" if net >= 0 else ""
        emoji = "green" if net >= 0 else "red"
        acc = get_account()
        msg = (f"<b>[{label}] {direction} CLOSED [{reason}]</b>\n"
               f"{symbol}: <code>{op:.2f}</code> -> <code>{cp:.2f}</code>\n"
               f"PnL: <code>{sign}{net:.2f} USD</code>\n"
               f"Balance: <code>${acc.balance:.2f}</code>")
        notify(msg)
        print(f"  [CLOSED {reason}] {label} | {symbol} | {direction} "
              f"| {sign}{net:.2f}$")

# ─── EQUITY LOGGING ───────────────────────────────────────────────────────────
last_eq_log  = 0
peak_equity  = 0
dd_warned    = False

def log_equity(conn):
    global last_eq_log, peak_equity, dd_warned
    now = time.time()
    if now - last_eq_log < EQUITY_LOG_MIN * 60:
        return
    last_eq_log = now

    acc = get_account()
    if not acc: return
    positions = get_all_positions()
    open_lots = sum(p.volume for p in positions)
    open_pnl  = sum(p.profit for p in positions)

    if acc.equity > peak_equity:
        peak_equity = acc.equity
    dd = (peak_equity - acc.equity) / peak_equity * 100 if peak_equity > 0 else 0

    conn.execute("""
        INSERT INTO equity_log (ts, balance, equity, drawdown, open_lots, open_pnl)
        VALUES (?,?,?,?,?,?)
    """, (now_str(), acc.balance, acc.equity, round(dd,2), open_lots, round(open_pnl,2)))
    conn.commit()

    if dd >= DD_WARN_PCT and not dd_warned:
        dd_warned = True
        notify(f"<b>CANH BAO: Portfolio DD {dd:.1f}%</b>\n"
               f"Balance: <code>${acc.balance:.2f}</code> | Equity: <code>${acc.equity:.2f}</code>")
    elif dd < DD_WARN_PCT * 0.7:
        dd_warned = False

# ─── WEEKLY REPORT ────────────────────────────────────────────────────────────
last_report_week = None

def maybe_generate_weekly_report(conn):
    global last_report_week
    now = datetime.now()
    # Generate every Monday
    if now.weekday() != 0:
        return
    week_str = now.strftime("%Y-W%W")
    if week_str == last_report_week:
        return
    last_report_week = week_str

    week_start = (now - timedelta(days=7)).strftime("%Y-%m-%d")
    week_end   = now.strftime("%Y-%m-%d")

    rows = conn.execute("""
        SELECT magic, ea_label,
               COUNT(*) as trades,
               SUM(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END) as wins,
               SUM(CASE WHEN net_pnl <= 0 THEN 1 ELSE 0 END) as losses,
               SUM(net_pnl) as net_pnl,
               SUM(CASE WHEN net_pnl > 0 THEN net_pnl ELSE 0 END) as gross_win,
               SUM(CASE WHEN net_pnl <= 0 THEN ABS(net_pnl) ELSE 0 END) as gross_loss
        FROM trades
        WHERE status='CLOSED' AND close_time >= ?
        GROUP BY magic, ea_label
    """, (week_start,)).fetchall()

    if not rows:
        return

    report_lines = [f"<b>WEEKLY REPORT — {week_start} to {week_end}</b>\n"]
    for r in rows:
        magic, label, n, wins, losses, net, gw, gl = r
        wr  = wins/n*100 if n > 0 else 0
        pf  = gw/gl if gl > 0 else 0
        sign = "+" if net >= 0 else ""

        bench = EA_BENCHMARK.get(magic, {})
        bench_pf = bench.get("pf", 0)
        bench_wr = bench.get("wr", 0)
        pf_vs = f"(backtest {bench_pf:.2f})" if bench_pf else ""
        wr_vs = f"(backtest {bench_wr:.1f}%)" if bench_wr else ""

        report_lines.append(
            f"<b>{label}</b>\n"
            f"  Trades: {n} | WR: {wr:.1f}% {wr_vs}\n"
            f"  PF: {pf:.2f} {pf_vs}\n"
            f"  Net PnL: <code>{sign}{net:.2f} USD</code>\n"
        )
        conn.execute("""
            INSERT INTO weekly_reports
            (week_start, week_end, magic, ea_label, trades, wins, losses, win_rate, pf, net_pnl)
            VALUES (?,?,?,?,?,?,?,?,?,?)
        """, (week_start, week_end, magic, label, n, wins, losses,
              round(wr,1), round(pf,3), round(net,2)))
    conn.commit()

    full_report = "\n".join(report_lines)
    notify(full_report)
    print(f"\n[WEEKLY REPORT SENT]\n{full_report}")

# ─── DASHBOARD ────────────────────────────────────────────────────────────────
def print_dashboard(conn, positions):
    acc = get_account()
    if not acc: return

    eq  = acc.equity
    bal = acc.balance
    dd  = (peak_equity - eq) / peak_equity * 100 if peak_equity > 0 else 0
    float_pnl = sum(p.profit for p in positions)

    os.system("cls" if os.name == "nt" else "clear")
    W = 65
    print("=" * W)
    print(f"  Multi-EA Monitor  |  {now_str()}")
    print(f"  Account : {acc.login} @ {acc.server}")
    print("=" * W)
    print(f"  Balance : ${bal:.2f}")
    print(f"  Equity  : ${eq:.2f}  (float {'+' if float_pnl>=0 else ''}{float_pnl:.2f})")
    print(f"  DD/peak : {dd:.1f}%  (peak ${peak_equity:.2f})")
    print("-" * W)

    # Group positions by EA
    ea_positions = defaultdict(list)
    for p in positions:
        ea_positions[p.magic].append(p)

    print("  OPEN POSITIONS:")
    if positions:
        for magic, pos_list in ea_positions.items():
            label = get_ea_label(magic)
            for p in pos_list:
                side = "LONG " if p.type == 0 else "SHORT"
                age  = int((time.time() - p.time) / 60)
                sign = "+" if p.profit >= 0 else ""
                print(f"  [{label}] {p.symbol} {side} {p.volume}lot "
                      f"@{p.price_open:.2f} | float={sign}{p.profit:.2f}$ | {age}min")
    else:
        print("  (no open positions)")

    print("-" * W)

    # Stats per EA from DB
    print("  EA PERFORMANCE SUMMARY (all time):")
    rows = conn.execute("""
        SELECT magic, ea_label,
               COUNT(*) as n,
               SUM(CASE WHEN net_pnl>0 THEN 1 ELSE 0 END) as wins,
               SUM(net_pnl) as net,
               SUM(CASE WHEN net_pnl>0 THEN net_pnl ELSE 0 END) as gw,
               SUM(CASE WHEN net_pnl<=0 THEN ABS(net_pnl) ELSE 0 END) as gl
        FROM trades WHERE status='CLOSED'
        GROUP BY magic, ea_label
    """).fetchall()

    if rows:
        for r in rows:
            magic, label, n, wins, net, gw, gl = r
            wr = wins/n*100 if n>0 else 0
            pf = gw/gl if gl>0 else 0
            sign = "+" if net>=0 else ""
            bench = EA_BENCHMARK.get(magic, {})
            bpf = bench.get('pf', 0)
            bwr = bench.get('wr', 0)
            pf_flag = " OK" if (bpf == 0 or pf >= bpf*0.7) else " LOW"
            wr_flag = " OK" if (bwr == 0 or wr >= bwr*0.75) else " LOW"
            print(f"  {label:<22} | {n:3d} trades | WR={wr:.0f}%{wr_flag} | "
                  f"PF={pf:.2f}{pf_flag} | net={sign}{net:.0f}$")
    else:
        print("  (no closed trades yet — waiting for first signals...)")

    # Last 5 trades
    last5 = conn.execute("""
        SELECT ea_label, symbol, direction, open_price, close_price,
               net_pnl, exit_reason, close_time
        FROM trades WHERE status='CLOSED'
        ORDER BY id DESC LIMIT 5
    """).fetchall()

    if last5:
        print("-" * W)
        print("  LAST 5 TRADES:")
        for r in last5:
            label, sym, dir_, op, cp, net, reason, ct = r
            sign = "+" if (net or 0) >= 0 else ""
            ct_short = (ct or "")[:16]
            print(f"  {ct_short} [{label}] {sym} {dir_:5s} "
                  f"{op:.2f}->{cp:.2f} {sign}{net:.2f}$ [{reason}]")

    print("=" * W)
    print(f"  Polling every {POLL_SEC}s | Ctrl+C to stop | DB: {DB_PATH}")

# ─── MAIN ─────────────────────────────────────────────────────────────────────
def main():
    global peak_equity

    print("Connecting to MT5...")
    if not mt5.initialize():
        print("MT5 init failed:", mt5.last_error())
        sys.exit(1)

    acc = get_account()
    print(f"Connected: {acc.login} @ {acc.server} | ${acc.balance:.2f}")

    conn = init_db()
    peak_equity = acc.equity

    start_ts = datetime.now() - timedelta(days=30)
    notify(
        f"<b>Multi-EA Monitor started</b>\n"
        f"Account: <code>{acc.login}</code> @ {acc.server}\n"
        f"Balance: <code>${acc.balance:.2f}</code>\n"
        f"Watching: {len(EA_LABELS)} known EAs + auto-detect"
    )
    print(f"Monitoring started. Known EAs: {EA_LABELS}")
    print("Waiting for EA signals...\n")

    try:
        while True:
            positions = get_all_positions()
            all_deals = get_deals_since(start_ts.timestamp())

            # Auto-detect new EAs
            discover_magic_numbers(conn, all_deals, positions)

            # Get known tickets
            known_tickets = {r[0] for r in conn.execute("SELECT ticket FROM trades").fetchall()}
            open_in_db   = {r[0] for r in conn.execute(
                "SELECT ticket FROM trades WHERE status='OPEN'").fetchall()}

            # Log new opens
            for p in positions:
                if log_open_position(conn, p, known_tickets):
                    known_tickets.add(p.ticket)

            # Log closes
            if open_in_db:
                log_closed_trades(conn, open_in_db, all_deals)

            # Equity log
            log_equity(conn)

            # Weekly report
            maybe_generate_weekly_report(conn)

            # Dashboard
            print_dashboard(conn, positions)

            time.sleep(POLL_SEC)

    except KeyboardInterrupt:
        print("\nMonitor stopped.")
        notify("<b>Multi-EA Monitor stopped</b> (manual)")
    finally:
        conn.close()
        mt5.shutdown()

if __name__ == "__main__":
    main()
