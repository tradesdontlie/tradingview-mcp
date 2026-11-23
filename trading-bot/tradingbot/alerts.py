"""Phone alerts via Telegram. Reads the audit log, so the trading core stays untouched.
Env: TELEGRAM_TOKEN (from @BotFather) and TELEGRAM_CHAT_ID. Alerts only: it cannot trade or reset."""
import json
import time
import urllib.parse
import urllib.request

from .database import Database

WATCH = {"kill_switch_activated", "node_won", "node_lost", "loss_streak_cooldown", "guard_rearmed",
         "order_ambiguous", "orphan_position", "reconcile_failed"}


def format_event(e: dict):
    p = json.loads(e["payload"] or "{}")
    t = e["event_type"]
    if t == "kill_switch_activated":
        return f"STOPPED ({p.get('mode')}): {p.get('reason')}"
    if t == "node_won":
        return f"WIN {p.get('net', 0):+.2f}"
    if t == "node_lost":
        return f"LOSS {p.get('net', 0):+.2f}"
    if t == "loss_streak_cooldown":
        return "3 losses in a row: cooling off for a day"
    return t.replace("_", " ")


def telegram_sender(token, chat):
    def send(text):
        data = urllib.parse.urlencode({"chat_id": chat, "text": text}).encode()
        urllib.request.urlopen(f"https://api.telegram.org/bot{token}/sendMessage", data, timeout=10)
    return send


def poll_once(db, send, name, last_id):
    rows = db.conn.execute("SELECT * FROM audit WHERE event_id>? ORDER BY event_id", (last_id,)).fetchall()
    for r in rows:
        e = dict(r)
        last_id = e["event_id"]
        if e["event_type"] in WATCH:
            send(f"[{name}] {format_event(e)}")
    return last_id


def alerts_loop(db_path, send, name="bot", every=10):
    db = Database(db_path)
    row = db.conn.execute("SELECT COALESCE(MAX(event_id),0) FROM audit").fetchone()
    last = row[0]
    while True:
        try:
            last = poll_once(db, send, name, last)
        except Exception:
            pass
        time.sleep(every)
