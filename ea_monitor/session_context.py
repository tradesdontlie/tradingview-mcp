#!/usr/bin/env python3
"""
session_context.py — SessionStart hook
Inject recent trade context into Claude's context window at session start.

Output: JSON with hookSpecificOutput.additionalContext
"""
import json
import sqlite3
import os
import sys

DB_PATH = r"C:\Users\ADMIN\tradingview-mcp\journal.db"


def query_safe(cur, sql, params=()):
    """Execute query, return empty list on error (e.g. missing column)."""
    try:
        cur.execute(sql, params)
        return cur.fetchall()
    except Exception:
        return []


def get_context():
    lines = []

    if not os.path.exists(DB_PATH):
        return None  # No DB yet — don't inject anything

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # ── Manual VN Stock trades ────────────────────────────────────────────────
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='trades'")
    has_trades = cur.fetchone() is not None

    if has_trades:
        # Open positions
        open_rows = query_safe(cur, """
            SELECT ticker, direction, strategy, entry_price, sl_price, tp1_price,
                   entry_date, rr
            FROM trades WHERE status='OPEN' ORDER BY entry_date DESC
        """)

        if open_rows:
            lines.append(f"=== LỆNH ĐANG MỞ ({len(open_rows)}) ===")
            for t in open_rows:
                lines.append(
                    f"  {t['ticker']} {t['direction']} | Entry: {t['entry_price']:,}"
                    f" | SL: {t['sl_price']:,} | TP: {t['tp1_price']:,}"
                    f" | RR: {t['rr']:.1f} | {t['strategy']} | {t['entry_date']}"
                )

        # Recent closed trades (last 10) — try with market_regime, fallback without
        recent = query_safe(cur, """
            SELECT ticker, direction, strategy, pnl_vnd, pnl_r,
                   exit_reason, exit_date, market_regime
            FROM trades WHERE status='CLOSED'
            ORDER BY exit_date DESC LIMIT 10
        """)
        if not recent:
            # Fallback if market_regime column doesn't exist yet
            recent = query_safe(cur, """
                SELECT ticker, direction, strategy, pnl_vnd, pnl_r,
                       exit_reason, exit_date, NULL as market_regime
                FROM trades WHERE status='CLOSED'
                ORDER BY exit_date DESC LIMIT 10
            """)

        if recent:
            wins = sum(1 for t in recent if (t['pnl_vnd'] or 0) > 0)
            total_pnl = sum(t['pnl_vnd'] or 0 for t in recent)
            lines.append(f"\n=== 10 LỆNH GẦN NHẤT (VN Stocks) ===")
            lines.append(
                f"  Win rate: {wins}/{len(recent)} = {wins/len(recent)*100:.0f}%"
                f" | Tổng P&L: {total_pnl/1_000_000:.1f}M VND"
            )
            for t in recent:
                sign = "+" if (t['pnl_vnd'] or 0) > 0 else "-"
                regime = f" [{t['market_regime']}]" if t['market_regime'] else ""
                lines.append(
                    f"  [{sign}] {t['ticker']} {t['direction']} {t['strategy']}"
                    f" | R={t['pnl_r'] or 0:.1f} | {t['exit_reason']} | {t['exit_date']}{regime}"
                )

        # This month stats
        month = query_safe(cur, """
            SELECT COUNT(*) as n,
                   SUM(CASE WHEN pnl_vnd > 0 THEN 1 ELSE 0 END) as wins,
                   ROUND(SUM(pnl_vnd) / 1000000.0, 1) as total_m,
                   ROUND(AVG(pnl_r), 2) as avg_r
            FROM trades
            WHERE status='CLOSED'
              AND strftime('%Y-%m', exit_date) = strftime('%Y-%m', 'now')
        """)
        if month and month[0]['n'] and month[0]['n'] > 0:
            m = month[0]
            lines.append(f"\n=== THÁNG NÀY (VN Stocks) ===")
            lines.append(
                f"  {m['n']} lệnh | WR: {m['wins']}/{m['n']}"
                f" | P&L: {m['total_m']}M VND | Avg R: {m['avg_r']}"
            )

        # Regime breakdown (if column exists)
        regime_rows = query_safe(cur, """
            SELECT market_regime,
                   COUNT(*) as n,
                   SUM(CASE WHEN pnl_vnd > 0 THEN 1 ELSE 0 END) as wins,
                   ROUND(AVG(pnl_r), 2) as avg_r
            FROM trades
            WHERE status='CLOSED' AND market_regime IS NOT NULL AND market_regime != ''
            GROUP BY market_regime ORDER BY n DESC
        """)
        if regime_rows and len(regime_rows) > 1:
            lines.append(f"\n=== WIN RATE THEO REGIME ===")
            for r in regime_rows:
                wr = r['wins'] / r['n'] * 100 if r['n'] else 0
                lines.append(
                    f"  {r['market_regime']:12s}: {r['wins']}/{r['n']} = {wr:.0f}% WR | Avg R={r['avg_r']}"
                )

    # ── EA Forex trades ───────────────────────────────────────────────────────
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='ea_trades'")
    has_ea = cur.fetchone() is not None

    if has_ea:
        ea_month = query_safe(cur, """
            SELECT COUNT(*) as n,
                   SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
                   ROUND(SUM(pnl_usd), 2) as total_usd,
                   ROUND(AVG(pnl_r), 2) as avg_r
            FROM ea_trades
            WHERE status='CLOSED'
              AND strftime('%Y-%m', close_time) = strftime('%Y-%m', 'now')
        """)
        if ea_month and ea_month[0]['n'] and ea_month[0]['n'] > 0:
            m = ea_month[0]
            lines.append(f"\n=== EA THÁNG NÀY (Forex) ===")
            lines.append(
                f"  {m['n']} lệnh | WR: {m['wins']}/{m['n']}"
                f" | P&L: ${m['total_usd']} | Avg R: {m['avg_r']}"
            )

        # EA recent 5 trades
        ea_recent = query_safe(cur, """
            SELECT symbol, direction, pnl_usd, pnl_r, exit_reason, close_time
            FROM ea_trades WHERE status='CLOSED'
            ORDER BY close_time DESC LIMIT 5
        """)
        if ea_recent:
            lines.append(f"\n=== 5 LỆNH EA GẦN NHẤT ===")
            for t in ea_recent:
                sign = "+" if (t['pnl_usd'] or 0) > 0 else "-"
                lines.append(
                    f"  [{sign}] {t['symbol']} {t['direction']}"
                    f" | ${t['pnl_usd']:.2f} | R={t['pnl_r'] or 0:.1f}"
                    f" | {t['exit_reason']} | {t['close_time']}"
                )

    conn.close()
    return "\n".join(lines) if lines else None


if __name__ == "__main__":
    context = get_context()
    if context:
        output = {
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": context
            }
        }
    else:
        # No data yet — output empty (don't inject noise)
        output = {}
    # UTF-8 safe output
    sys.stdout.buffer.write(json.dumps(output, ensure_ascii=False).encode("utf-8"))
    sys.stdout.buffer.write(b"\n")
