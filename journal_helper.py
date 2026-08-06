#!/usr/bin/env python3
"""
journal_helper.py -- VN Trading Journal CLI
Run: py journal_helper.py [command] [args]

Commands:
  --new-trade      Them lenh moi (interactive)
  --close TRADE_ID Dong lenh
  --open           Xem lenh dang mo
  --week           Tong ket tuan nay
  --month          Tong ket thang nay
  --stats          Stats tong hop
  --scan-save      Luu ket qua scan cuoi cung vao DB
  --capital        Xem / cap nhat von
  --init           Khoi tao DB (chay lan dau)
"""

import sqlite3
import sys
import os
import json
import argparse
from datetime import datetime, date, timedelta
from pathlib import Path

# -------------------------------------------------------------------
DB_PATH = Path(__file__).parent / "journal.db"
SQL_PATH = Path(__file__).parent / "journal_setup.sql"
CAPITAL_DEFAULT = 60_000_000
COMMISSION_RATE = 0.003   # 0.3% round-trip

# -------------------------------------------------------------------
def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

def init_db():
    if not SQL_PATH.exists():
        print("ERROR: journal_setup.sql not found at", SQL_PATH)
        sys.exit(1)
    conn = connect()
    with open(SQL_PATH, 'r', encoding='utf-8') as f:
        conn.executescript(f.read())
    conn.commit()
    conn.close()
    print("OK  DB initialized at", DB_PATH)

# -------------------------------------------------------------------
# HELPERS
# -------------------------------------------------------------------
def fmt_vnd(n):
    if n is None: return "---"
    if abs(n) >= 1_000_000: return f"{n/1_000_000:+.2f}M"
    if abs(n) >= 1_000:     return f"{n/1_000:+.0f}K"
    return f"{n:+.0f}"

def fmt_r(n):
    if n is None: return "---"
    return f"{n:+.2f}R"

def fmt_pct(n):
    if n is None: return "---"
    return f"{n:+.1f}%"

def today_str():
    return date.today().isoformat()

def week_bounds():
    today = date.today()
    start = today - timedelta(days=today.weekday())  # Monday
    end   = start + timedelta(days=4)                # Friday
    return start.isoformat(), end.isoformat()

def month_bounds():
    today = date.today()
    start = today.replace(day=1)
    return start.isoformat(), today.isoformat()

def calc_rr(entry, sl, tp1):
    try:
        risk   = abs(entry - sl)
        reward = abs(tp1 - entry)
        return round(reward / risk, 2) if risk > 0 else None
    except:
        return None

def calc_commission(entry, exit_p, qty):
    buy_comm  = entry * qty * COMMISSION_RATE / 2
    sell_comm = exit_p * qty * COMMISSION_RATE / 2
    return round(buy_comm + sell_comm, 0)

def calc_pnl(entry, exit_p, qty, sl):
    gross = (exit_p - entry) * qty
    comm  = calc_commission(entry, exit_p, qty)
    net   = gross - comm
    pct   = (exit_p - entry) / entry * 100
    risk  = abs(entry - sl) * qty
    r     = net / risk if risk > 0 else 0
    return round(net, 0), round(pct, 2), round(r, 2)

# -------------------------------------------------------------------
# COMMANDS
# -------------------------------------------------------------------
def cmd_open():
    """Hien thi lenh dang mo"""
    conn = connect()
    rows = conn.execute("""
        SELECT ticker, strategy, entry_date, entry_price, sl_price, tp1_price,
               qty, risk_pct, rr, conf_score, notes
        FROM v_open_positions
    """).fetchall()
    conn.close()

    if not rows:
        print("\n  Khong co lenh nao dang mo.\n")
        return

    print()
    print("=" * 72)
    print("  OPEN POSITIONS")
    print("=" * 72)
    print(f"  {'MA':<6} {'STRAT':<8} {'ENTRY_DATE':<12} {'ENTRY':>8} {'SL':>8} {'TP1':>8} {'QTY':>7} {'R%':>4} {'RR':>5} {'CONF':>5}")
    print("  " + "-" * 68)
    for r in rows:
        print(f"  {r['ticker']:<6} {r['strategy']:<8} {r['entry_date'] or '':<12} "
              f"{int(r['entry_price']):>8,} {int(r['sl_price']):>8,} "
              f"{int(r['tp1_price']) if r['tp1_price'] else '---':>8} "
              f"{r['qty'] or 0:>7,} {r['risk_pct'] or 1:>4.0f}% {r['rr'] or 0:>5.1f} "
              f"{r['conf_score'] or 0:>5}")
    print()

def cmd_new_trade():
    """Them lenh moi (interactive)"""
    print("\n[ Them lenh moi ]")
    print("(Enter de bo qua truong khong bat buoc)\n")

    def ask(prompt, required=True, typ=str, default=None):
        while True:
            val = input(f"  {prompt}: ").strip()
            if not val:
                if default is not None: return default
                if not required: return None
                print("    * Truong bat buoc")
                continue
            try:
                return typ(val)
            except:
                print(f"    * Gia tri khong hop le (can {typ.__name__})")

    ticker   = ask("Ticker (VD: ACB, FTS)").upper()
    strategy = ask("Chien luoc [PP_PRO/SWEEP/BOTH]", default="PP_PRO").upper()
    sig_date = ask(f"Ngay tin hieu (YYYY-MM-DD) [{today_str()}]", required=False, default=today_str())
    entry_d  = ask(f"Ngay vao lenh (YYYY-MM-DD) [{today_str()}]", required=False, default=today_str())
    entry_p  = ask("Gia vao (VND)", typ=float)
    sl_p     = ask("Stop Loss (VND)", typ=float)
    tp1_p    = ask("TP1 (VND, Enter bo qua)", required=False, typ=float)
    tp2_p    = ask("TP2 (VND, Enter bo qua)", required=False, typ=float)
    risk_pct = ask("Risk % [1 hoac 2]", default=1.0, typ=float)
    capital  = 60_000_000
    risk_amt = capital * risk_pct / 100
    entry_sl = abs(entry_p - sl_p)
    qty_calc = int(risk_amt / entry_sl) if entry_sl > 0 else 0
    qty      = ask(f"So luong cp (tinh duoc ~{qty_calc:,})", required=False, typ=int, default=qty_calc)
    conf     = ask("Conf score (0-100, Enter bo qua)", required=False, typ=int)
    cumd     = ask("Cum Delta (Enter bo qua)", required=False, typ=float)
    buy_pct  = ask("Buy% (Enter bo qua)", required=False, typ=int)
    notes    = ask("Ghi chu (Enter bo qua)", required=False)

    rr   = calc_rr(entry_p, sl_p, tp1_p) if tp1_p else None
    risk_amt_calc = round(entry_sl * qty, 0)

    conn = connect()
    cur = conn.execute("""
        INSERT INTO trades
          (ticker, strategy, signal_date, entry_date, entry_price, sl_price,
           tp1_price, tp2_price, qty, risk_pct, risk_amount, rr,
           conf_score, cum_delta, buy_pct, notes, status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'OPEN')
    """, (ticker, strategy, sig_date, entry_d, entry_p, sl_p,
          tp1_p, tp2_p, qty, risk_pct, risk_amt_calc, rr,
          conf, cumd, buy_pct, notes))
    trade_id = cur.lastrowid
    conn.commit()
    conn.close()

    print(f"\n  OK  Lenh #{trade_id} da luu")
    print(f"      {ticker} | Entry: {int(entry_p):,} | SL: {int(sl_p):,} | QTY: {qty:,}")
    if rr: print(f"      R:R = 1:{rr}")
    print(f"      Risk: {fmt_vnd(risk_amt_calc)} ({risk_pct}%)\n")

def cmd_close(trade_id):
    """Dong lenh theo ID"""
    conn = connect()
    trade = conn.execute("SELECT * FROM trades WHERE id=? AND status='OPEN'", (trade_id,)).fetchone()
    if not trade:
        print(f"  Khong tim thay lenh OPEN voi ID={trade_id}")
        conn.close()
        return

    print(f"\n[ Dong lenh #{trade_id}: {trade['ticker']} ]")
    print(f"  Entry: {int(trade['entry_price']):,} | SL: {int(trade['sl_price']):,} | QTY: {trade['qty']:,}\n")

    def ask(prompt, required=True, typ=str, default=None):
        while True:
            val = input(f"  {prompt}: ").strip()
            if not val:
                if default is not None: return default
                if not required: return None
                print("    * Truong bat buoc")
                continue
            try:
                return typ(val)
            except:
                print(f"    * Gia tri khong hop le")

    exit_p   = ask("Gia thoat (VND)", typ=float)
    exit_d   = ask(f"Ngay thoat [{today_str()}]", required=False, default=today_str())
    reason   = ask("Ly do thoat [SL/TP1/TP2/TRAIL/MANUAL/HOLD30/HOLD20]", default="MANUAL").upper()
    notes    = ask("Ghi chu them (Enter bo qua)", required=False)

    entry_d  = trade['entry_date'] or trade['signal_date']
    try:
        d1 = datetime.strptime(entry_d, "%Y-%m-%d")
        d2 = datetime.strptime(exit_d, "%Y-%m-%d")
        hold_days = (d2 - d1).days
    except:
        hold_days = None

    pnl_vnd, pnl_pct, pnl_r = calc_pnl(
        trade['entry_price'], exit_p, trade['qty'] or 0, trade['sl_price']
    )

    existing_notes = trade['notes'] or ''
    merged_notes   = (existing_notes + ' | ' + notes) if notes and existing_notes else (notes or existing_notes)

    conn.execute("""
        UPDATE trades
        SET exit_date=?, exit_price=?, exit_reason=?, hold_days=?,
            pnl_vnd=?, pnl_pct=?, pnl_r=?, status='CLOSED',
            notes=?, updated_at=datetime('now')
        WHERE id=?
    """, (exit_d, exit_p, reason, hold_days, pnl_vnd, pnl_pct, pnl_r, merged_notes, trade_id))
    conn.commit()
    conn.close()

    result = "LOI" if pnl_vnd > 0 else "LO"
    print(f"\n  OK  Dong lenh #{trade_id} — {result}")
    print(f"      {trade['ticker']} | Entry: {int(trade['entry_price']):,} -> Exit: {int(exit_p):,}")
    print(f"      P&L: {fmt_vnd(pnl_vnd)} ({fmt_pct(pnl_pct)}) | {fmt_r(pnl_r)}")
    print(f"      Hold: {hold_days or '?'} phien | Ly do: {reason}\n")

def cmd_week():
    """Tong ket tuan"""
    start, end = week_bounds()
    conn = connect()
    trades = conn.execute("""
        SELECT * FROM trades
        WHERE exit_date BETWEEN ? AND ? AND status='CLOSED'
        ORDER BY exit_date
    """, (start, end)).fetchall()
    conn.close()

    print()
    print("=" * 72)
    print(f"  TUAN {start} -> {end}")
    print("=" * 72)

    if not trades:
        print("  Khong co lenh dong trong tuan nay.\n")
        return

    wins = [t for t in trades if (t['pnl_r'] or 0) > 0]
    losses = [t for t in trades if (t['pnl_r'] or 0) <= 0]
    total_r   = sum(t['pnl_r'] or 0 for t in trades)
    total_pnl = sum(t['pnl_vnd'] or 0 for t in trades)
    wr = len(wins) / len(trades) * 100 if trades else 0

    print(f"  Tong lenh: {len(trades)} | Win: {len(wins)} | Loss: {len(losses)} | WR: {wr:.0f}%")
    print(f"  Tong R: {fmt_r(total_r)} | Tong P&L: {fmt_vnd(total_pnl)}")
    print()
    print(f"  {'#':<4} {'MA':<6} {'STRAT':<8} {'ENTRY':>8} {'EXIT':>8} {'HOLD':>5} {'P&L':>10} {'R':>7} {'LY DO':<10}")
    print("  " + "-" * 68)
    for t in trades:
        print(f"  {t['id']:<4} {t['ticker']:<6} {t['strategy']:<8} "
              f"{int(t['entry_price'] or 0):>8,} {int(t['exit_price'] or 0):>8,} "
              f"{t['hold_days'] or 0:>5} {fmt_vnd(t['pnl_vnd']):>10} "
              f"{fmt_r(t['pnl_r']):>7} {t['exit_reason'] or '':10}")

    # By strategy
    strats = {}
    for t in trades:
        s = t['strategy']
        if s not in strats: strats[s] = []
        strats[s].append(t)
    if len(strats) > 1:
        print()
        print("  --- Theo chien luoc ---")
        for s, ts in strats.items():
            wr_s = sum(1 for t in ts if (t['pnl_r'] or 0) > 0) / len(ts) * 100
            r_s  = sum(t['pnl_r'] or 0 for t in ts)
            print(f"  {s:<10}: {len(ts)} lenh | WR {wr_s:.0f}% | {fmt_r(r_s)}")
    print()

def cmd_month():
    """Tong ket thang"""
    start, end = month_bounds()
    conn = connect()
    trades = conn.execute("""
        SELECT * FROM trades
        WHERE exit_date BETWEEN ? AND ? AND status='CLOSED'
        ORDER BY exit_date
    """, (start, end)).fetchall()
    conn.close()

    print()
    print("=" * 72)
    print(f"  THANG {start[:7]}")
    print("=" * 72)

    if not trades:
        print("  Khong co lenh dong trong thang nay.\n")
        return

    wins      = [t for t in trades if (t['pnl_r'] or 0) > 0]
    total_r   = sum(t['pnl_r'] or 0 for t in trades)
    total_pnl = sum(t['pnl_vnd'] or 0 for t in trades)
    wr = len(wins) / len(trades) * 100 if trades else 0

    # Group by week
    by_week = {}
    for t in trades:
        try:
            d = datetime.strptime(t['exit_date'], "%Y-%m-%d")
            week_start = (d - timedelta(days=d.weekday())).strftime("%Y-%m-%d")
        except:
            week_start = "unknown"
        if week_start not in by_week: by_week[week_start] = []
        by_week[week_start].append(t)

    print(f"  Tong lenh: {len(trades)} | Win: {len(wins)} | WR: {wr:.0f}%")
    print(f"  Tong R: {fmt_r(total_r)} | Net P&L: {fmt_vnd(total_pnl)}")
    print()

    for wk in sorted(by_week):
        ts = by_week[wk]
        wr_w = sum(1 for t in ts if (t['pnl_r'] or 0) > 0) / len(ts) * 100 if ts else 0
        r_w  = sum(t['pnl_r'] or 0 for t in ts)
        pnl_w = sum(t['pnl_vnd'] or 0 for t in ts)
        print(f"  Tuan {wk}: {len(ts)} lenh | WR {wr_w:.0f}% | {fmt_r(r_w)} | {fmt_vnd(pnl_w)}")
        for t in ts:
            sign = "+" if (t['pnl_r'] or 0) > 0 else "-"
            print(f"    {sign} {t['ticker']:<6} {t['strategy']:<8} {fmt_r(t['pnl_r'])} {fmt_vnd(t['pnl_vnd'])}")
    print()

def cmd_stats():
    """Stats tong hop"""
    conn = connect()

    # Overall
    total = conn.execute("SELECT COUNT(*) as n FROM trades WHERE status='CLOSED'").fetchone()['n']
    if total == 0:
        print("\n  Chua co du lieu (chua co lenh dong nao).\n")
        conn.close()
        return

    overall = conn.execute("""
        SELECT
          COUNT(*) as n,
          SUM(CASE WHEN pnl_r > 0 THEN 1 ELSE 0 END) as wins,
          ROUND(AVG(pnl_r), 2) as avg_r,
          ROUND(SUM(pnl_r), 2) as total_r,
          ROUND(SUM(pnl_vnd)/1000.0, 0) as net_k,
          ROUND(AVG(hold_days), 1) as avg_hold,
          MAX(pnl_r) as best_r,
          MIN(pnl_r) as worst_r
        FROM trades WHERE status='CLOSED'
    """).fetchone()

    wr = overall['wins'] / overall['n'] * 100

    print()
    print("=" * 60)
    print("  STATS TONG HOP")
    print("=" * 60)
    print(f"  Tong lenh    : {overall['n']:>4}  |  Win: {overall['wins']}  |  WR: {wr:.0f}%")
    print(f"  Avg R/lenh   : {fmt_r(overall['avg_r'])}")
    print(f"  Total R      : {fmt_r(overall['total_r'])}")
    print(f"  Net P&L      : {overall['net_k'] or 0:+,.0f}K VND")
    print(f"  Best trade   : {fmt_r(overall['best_r'])}")
    print(f"  Worst trade  : {fmt_r(overall['worst_r'])}")
    print(f"  Avg hold     : {overall['avg_hold'] or 0:.1f} phien")

    # By strategy
    strats = conn.execute("SELECT * FROM v_strategy_stats").fetchall()
    if strats:
        print()
        print("  --- Theo chien luoc ---")
        for s in strats:
            print(f"  {s['strategy']:<10}: {s['total_trades']} lenh | WR {s['win_rate_pct']:.0f}% | "
                  f"AvgR {fmt_r(s['avg_r'])} | TotalR {fmt_r(s['total_r'])} | {s['net_pnl_k']:+,.0f}K VND")

    # By ticker (top 8)
    tickers = conn.execute("SELECT * FROM v_ticker_stats LIMIT 8").fetchall()
    if tickers:
        print()
        print("  --- Top ticker ---")
        for t in tickers:
            print(f"  {t['ticker']:<6}: {t['total_trades']} lenh | WR {t['win_rate_pct']:.0f}% | "
                  f"TotalR {fmt_r(t['total_r'])} | {t['net_pnl_k']:+,.0f}K VND")

    conn.close()
    print()

def cmd_capital():
    """Hien thi / cap nhat von"""
    conn = connect()
    rows = conn.execute("""
        SELECT * FROM capital_log ORDER BY log_date DESC LIMIT 10
    """).fetchall()

    print()
    print("=" * 60)
    print("  CAPITAL LOG")
    print("=" * 60)
    if rows:
        print(f"  {'Ngay':<12} {'Von (VND)':>14} {'Cash':>14} {'P&L luy ke':>12}")
        print("  " + "-" * 56)
        for r in rows:
            print(f"  {r['log_date']:<12} {r['capital_vnd']:>14,.0f} "
                  f"{r['cash_vnd'] or 0:>14,.0f} "
                  f"{fmt_vnd(r['cumulative_pnl']):>12}")

    add = input("\n  Cap nhat von hom nay? (Enter=bo qua, nhap von moi): ").strip()
    if add:
        try:
            new_cap = float(add.replace(',', ''))
            conn.execute("""
                INSERT OR REPLACE INTO capital_log (log_date, capital_vnd, notes)
                VALUES (?, ?, 'manual update')
            """, (today_str(), new_cap))
            conn.commit()
            print(f"  OK  Von cap nhat: {new_cap:,.0f} VND")
        except:
            print("  Gia tri khong hop le")
    conn.close()
    print()

def cmd_save_scan(scan_date=None, source_file=None):
    """
    Luu ket qua scan gan nhat vao DB.
    Goi sau khi chay node scan_live.mjs hoac py scan_run.py
    """
    scan_date = scan_date or today_str()

    # Simple: ask user to paste summary line
    print(f"\n[ Luu ket qua scan ngay {scan_date} ]")
    print("  Nhap tung dong: TICKER SIGNAL SCORE CONF CUMD BUYPCT")
    print("  VD: ACB BUY 86 70 44100000 57")
    print("  (Enter trong de ket thuc)\n")

    conn = connect()
    count = 0
    while True:
        line = input("  > ").strip()
        if not line:
            break
        parts = line.upper().split()
        if len(parts) < 2:
            continue
        try:
            ticker  = parts[0]
            signal  = parts[1]
            score   = int(parts[2]) if len(parts) > 2 else None
            conf    = int(parts[3]) if len(parts) > 3 else None
            cumd    = float(parts[4]) if len(parts) > 4 else None
            buy_pct = int(parts[5]) if len(parts) > 5 else None
            conn.execute("""
                INSERT OR REPLACE INTO scan_results
                  (scan_date, ticker, signal, score_pct, conf_score, cum_delta, buy_pct)
                VALUES (?,?,?,?,?,?,?)
            """, (scan_date, ticker, signal, score, conf, cumd, buy_pct))
            count += 1
        except Exception as e:
            print(f"  Loi: {e}")

    conn.commit()
    conn.close()
    print(f"\n  OK  Da luu {count} ket qua scan cho ngay {scan_date}\n")

# -------------------------------------------------------------------
# MAIN
# -------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        prog="py journal_helper.py",
        description="VN Trading Journal CLI"
    )
    parser.add_argument("--init",       action="store_true",  help="Khoi tao DB")
    parser.add_argument("--open",       action="store_true",  help="Xem lenh dang mo")
    parser.add_argument("--new-trade",  action="store_true",  help="Them lenh moi")
    parser.add_argument("--close",      type=int, metavar="ID", help="Dong lenh theo ID")
    parser.add_argument("--week",       action="store_true",  help="Tong ket tuan")
    parser.add_argument("--month",      action="store_true",  help="Tong ket thang")
    parser.add_argument("--stats",      action="store_true",  help="Stats tong hop")
    parser.add_argument("--capital",    action="store_true",  help="Xem/cap nhat von")
    parser.add_argument("--scan-save",  action="store_true",  help="Luu ket qua scan")

    if len(sys.argv) == 1:
        # No args: show open positions as default
        if not DB_PATH.exists():
            print("\n  DB chua ton tai. Chay: py journal_helper.py --init\n")
            return
        cmd_open()
        print("  Dung --help xem cac lenh khac\n")
        return

    args = parser.parse_args()

    if args.init:
        init_db(); return

    if not DB_PATH.exists():
        print("\n  DB chua ton tai. Chay truoc: py journal_helper.py --init\n")
        sys.exit(1)

    if args.open:      cmd_open()
    elif args.new_trade: cmd_new_trade()
    elif args.close:   cmd_close(args.close)
    elif args.week:    cmd_week()
    elif args.month:   cmd_month()
    elif args.stats:   cmd_stats()
    elif args.capital: cmd_capital()
    elif args.scan_save: cmd_save_scan()
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
