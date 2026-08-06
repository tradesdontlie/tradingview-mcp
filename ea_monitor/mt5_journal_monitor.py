#!/usr/bin/env python3
"""
mt5_journal_monitor.py
Poll MT5 positions & deal history → sync to multi_ea_journal.db

Usage:
  python mt5_journal_monitor.py            # run forever, poll every 30s
  python mt5_journal_monitor.py --once     # single sync then exit
  python mt5_journal_monitor.py --interval 60
"""

import MetaTrader5 as mt5
import sqlite3
import time
import argparse
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ICMarkets server is GMT+3; MT5 p.time is server epoch not UTC
# fromtimestamp() adds local VN offset (GMT+7) → result is 3h ahead
# Subtract 3h to get correct VN time
_SERVER_OFFSET_H = 3

DB_PATH     = Path(__file__).parent / "multi_ea_journal.db"
HISTORY_DAYS = 30   # how far back to pull deals on startup

MAGIC_MAP = {
    20260530: "LondonBO_XAUUSD",
    20260601: "LondonBO_USDJPY",
    20260602: "LondonBO_EURUSD",
    20260603: "NY_Open_EURUSD",
    202510:   "BB_ShortOnly_XAUUSD",
}


# ─── DB helpers ─────────────────────────────────────────────────────────────

def db_connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def ea_label(magic: int, comment: str = "") -> str:
    if magic in MAGIC_MAP:
        return MAGIC_MAP[magic]
    if comment:
        return comment.split("|")[0].strip()[:30]
    return f"EA_{magic}"


# ─── Sync open positions ─────────────────────────────────────────────────────

def sync_open_positions(conn):
    positions = mt5.positions_get()
    if positions is None:
        return

    known_tickets = set()

    for p in positions:
        label = ea_label(p.magic, p.comment)
        direction = "BUY" if p.type == mt5.POSITION_TYPE_BUY else "SELL"
        open_time = (datetime.fromtimestamp(p.time) - timedelta(hours=_SERVER_OFFSET_H)).strftime("%Y-%m-%d %H:%M:%S")

        conn.execute("""
            INSERT INTO trades
              (ticket, magic, ea_label, symbol, direction,
               open_time, open_price, lot, sl, tp,
               pnl, commission, swap, net_pnl, status)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'OPEN')
            ON CONFLICT(ticket) DO UPDATE SET
              pnl        = excluded.pnl,
              net_pnl    = excluded.net_pnl,
              sl         = excluded.sl,
              tp         = excluded.tp,
              status     = 'OPEN'
        """, (
            p.ticket, p.magic, label, p.symbol, direction,
            open_time, p.price_open, p.volume, p.sl, p.tp,
            p.profit, 0.0, p.swap, p.profit + p.swap,
        ))
        known_tickets.add(p.ticket)

    conn.commit()
    return known_tickets


# ─── Sync closed deals ───────────────────────────────────────────────────────

def sync_closed_deals(conn, from_date: datetime):
    """
    Pull deal history and build closed trade records.
    Each position generates 2 deals: DEAL_ENTRY_IN + DEAL_ENTRY_OUT.
    We group by position_id and merge them.
    """
    deals = mt5.history_deals_get(from_date, datetime.now())
    if not deals:
        return 0

    # Group by position_id
    by_pos: dict[int, list] = {}
    for d in deals:
        if d.position_id not in by_pos:
            by_pos[d.position_id] = []
        by_pos[d.position_id].append(d)

    inserted = 0
    for pos_id, deal_list in by_pos.items():
        # Skip non-trade deals (deposits, withdrawals, corrections)
        if pos_id == 0:
            continue

        entry_deals = [d for d in deal_list if d.entry == mt5.DEAL_ENTRY_IN]
        exit_deals  = [d for d in deal_list if d.entry == mt5.DEAL_ENTRY_OUT]

        if not entry_deals:
            continue

        entry = entry_deals[0]
        label = ea_label(entry.magic, entry.comment)
        direction = "BUY" if entry.type == mt5.DEAL_TYPE_BUY else "SELL"
        open_time = (datetime.fromtimestamp(entry.time) - timedelta(hours=_SERVER_OFFSET_H)).strftime("%Y-%m-%d %H:%M:%S")

        if exit_deals:
            ex = exit_deals[0]
            close_time  = (datetime.fromtimestamp(ex.time) - timedelta(hours=_SERVER_OFFSET_H)).strftime("%Y-%m-%d %H:%M:%S")
            close_price = ex.price
            commission  = entry.commission + ex.commission
            swap        = ex.swap
            pnl         = ex.profit
            net_pnl     = pnl + commission + swap

            # Exit reason: check comment or SL/TP proximity
            exit_reason = _exit_reason(ex.comment)

            conn.execute("""
                INSERT INTO trades
                  (ticket, magic, ea_label, symbol, direction,
                   open_time, close_time, open_price, close_price,
                   lot, sl, tp, pnl, commission, swap, net_pnl,
                   exit_reason, status)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'CLOSED')
                ON CONFLICT(ticket) DO UPDATE SET
                  close_time  = excluded.close_time,
                  close_price = excluded.close_price,
                  pnl         = excluded.pnl,
                  commission  = excluded.commission,
                  swap        = excluded.swap,
                  net_pnl     = excluded.net_pnl,
                  exit_reason = excluded.exit_reason,
                  status      = 'CLOSED'
            """, (
                pos_id, entry.magic, label, entry.symbol, direction,
                open_time, close_time, entry.price, close_price,
                entry.volume, 0.0, 0.0, pnl, commission, swap, net_pnl,
                exit_reason,
            ))
        else:
            # Only entry deal found → still open (handled by sync_open_positions)
            conn.execute("""
                INSERT OR IGNORE INTO trades
                  (ticket, magic, ea_label, symbol, direction,
                   open_time, open_price, lot, status)
                VALUES (?,?,?,?,?,?,?,?,'OPEN')
            """, (
                pos_id, entry.magic, label, entry.symbol, direction,
                open_time, entry.price, entry.volume,
            ))

        inserted += 1

    conn.commit()
    return inserted


def _exit_reason(comment: str) -> str:
    c = (comment or "").lower()
    if "sl"  in c: return "SL"
    if "tp"  in c: return "TP"
    if "so"  in c: return "STOP_OUT"
    return "MANUAL" if comment else "UNKNOWN"


# ─── Equity log ─────────────────────────────────────────────────────────────

def log_equity(conn):
    info   = mt5.account_info()
    if not info:
        return
    pos    = mt5.positions_get() or []
    lots   = sum(p.volume for p in pos)
    pnl    = sum(p.profit for p in pos)
    dd     = (info.balance - info.equity) / info.balance * 100 if info.balance else 0
    ts     = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    conn.execute("""
        INSERT INTO equity_log (ts, balance, equity, drawdown, open_lots, open_pnl)
        VALUES (?,?,?,?,?,?)
    """, (ts, info.balance, info.equity, dd, lots, pnl))
    conn.commit()


# ─── Main loop ───────────────────────────────────────────────────────────────

def run(interval: int, once: bool):
    if not mt5.initialize():
        print(f"[ERROR] MT5 initialize failed: {mt5.last_error()}")
        sys.exit(1)

    info = mt5.account_info()
    print(f"[OK] Connected: {info.login} @ {info.server} | Balance: {info.balance:.2f}")
    print(f"[DB] {DB_PATH}")

    from_date = datetime.now() - timedelta(days=HISTORY_DAYS)

    try:
        while True:
            conn = db_connect()
            try:
                open_tickets = sync_open_positions(conn)
                n_deals      = sync_closed_deals(conn, from_date)
                log_equity(conn)

                open_count = len(open_tickets) if open_tickets else 0
                ts = datetime.now().strftime("%H:%M:%S")
                print(f"[{ts}] open={open_count}  deals_synced={n_deals}")

            except Exception as e:
                print(f"[WARN] Sync error: {e}")
            finally:
                conn.close()

            if once:
                break

            time.sleep(interval)

    except KeyboardInterrupt:
        print("\n[STOP] Interrupted by user")
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="MT5 → SQLite journal monitor")
    parser.add_argument("--once",     action="store_true", help="Sync once and exit")
    parser.add_argument("--interval", type=int, default=30, help="Poll interval seconds (default 30)")
    args = parser.parse_args()

    run(args.interval, args.once)
