"""Trade journal: every trade is recorded with WHY it was taken and WHY it ended, then the
history feeds back into the next decision.

Learning is deliberately simple and guarded against fooling itself:
  * outcomes are measured in R (profit divided by planned risk), after costs
  * a bucket (setup / session / pair / tree level) is only judged after `gate_min_n` trades
  * it is blocked only if even the OPTIMISTIC end of its 95% win-rate interval is below
    break-even; it is only trusted for extra slots if the PESSIMISTIC end clears the bar
"""
import json

from .stats import breakeven_win_rate, wilson

SCHEMA = """
CREATE TABLE IF NOT EXISTS journal(
  node_id INTEGER PRIMARY KEY, ts_open REAL, ts_close REAL, symbol TEXT, side TEXT,
  level INTEGER, root_id INTEGER, setup TEXT, session TEXT,
  features TEXT, checks TEXT, est_prob REAL, high_conf INTEGER,
  risk_amount REAL, rr REAL, net_pnl REAL, r_multiple REAL, exit_reason TEXT,
  tags TEXT, lesson TEXT);
"""


def _summ(rows):
    n = len(rows)
    if not n:
        return {"n": 0}
    rs = [r["r_multiple"] for r in rows]
    wins = [x for x in rs if x > 0]
    losses = [-x for x in rs if x <= 0]
    lo, hi = wilson(len(wins), n)
    return {"n": n, "win_rate": len(wins) / n, "win_lo": lo, "win_hi": hi,
            "avg_r": sum(rs) / n, "total_r": sum(rs),
            "profit_factor": (sum(wins) / sum(losses)) if losses and sum(losses) > 0 else float("inf")}


class Journal:
    def __init__(self, db, cfg=None):
        self.db, self.cfg = db, cfg
        db.conn.executescript(SCHEMA)

    # ---------- recording ----------
    def record_entry(self, node_id, now, sig, level, root_id, setup, row, result, est_prob,
                     high_conf, risk_amount, rr, spread):
        feats = {"htf": int(row["htf"]), "zone": int(row["zone"]), "atr_ratio": round(float(row["atr_ratio"]), 2),
                 "dist_ma": round(float(row["dist_ma"]), 2), "stop_atr": round(result.stop / row["atr"], 2),
                 "spread_frac": round(spread / result.stop, 3)}
        from .market_context import session_name
        sess = session_name(int(row["hour"]))
        self.db.conn.execute(
            "INSERT OR REPLACE INTO journal(node_id, ts_open, symbol, side, level, root_id, setup, session,"
            " features, checks, est_prob, high_conf, risk_amount, rr) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (node_id, now, sig.symbol, sig.side, level, root_id, setup, sess, json.dumps(feats),
             json.dumps([(n, ok) for n, ok, _ in result.checks]), est_prob, int(high_conf), risk_amount, rr))
        self.db.conn.commit()

    def record_exit(self, node_id, now, net_pnl):
        row = self.db.conn.execute("SELECT * FROM journal WHERE node_id=?", (node_id,)).fetchone()
        if row is None:
            return
        r = net_pnl / row["risk_amount"] if row["risk_amount"] else 0.0
        reason = "TP" if r >= 0.8 * row["rr"] else "SL" if r <= -0.8 else "TIME/OTHER"
        feats = json.loads(row["features"])
        tags = self._tags(row, feats, reason)
        lesson = self._lesson(row, feats, r, reason)
        self.db.conn.execute("UPDATE journal SET ts_close=?, net_pnl=?, r_multiple=?, exit_reason=?, tags=?,"
                             " lesson=? WHERE node_id=?", (now, net_pnl, r, reason, json.dumps(tags), lesson, node_id))
        self.db.conn.commit()

    @staticmethod
    def _tags(row, f, reason):
        t = [f"setup:{row['setup']}", f"session:{row['session']}", f"pair:{row['symbol']}",
             f"level:{row['level']}", f"exit:{reason}"]
        t.append("vol:low" if f["atr_ratio"] < 0.8 else "vol:high" if f["atr_ratio"] > 1.4 else "vol:normal")
        t.append("entry:extended" if abs(f["dist_ma"]) > 1.2 else "entry:near_average")
        t.append("spread:wide" if f["spread_frac"] > 0.10 else "spread:tight")
        t.append("stop:tight" if f["stop_atr"] < 1.3 else "stop:wide" if f["stop_atr"] > 2.0 else "stop:normal")
        return t

    @staticmethod
    def _lesson(row, f, r, reason):
        verdict = "WIN" if r > 0 else "LOSS"
        why = []
        if f["dist_ma"] and abs(f["dist_ma"]) > 1.2:
            why.append(f"entered {abs(f['dist_ma']):.1f} ATR from the average")
        if f["atr_ratio"] > 1.4:
            why.append("volatility was elevated")
        if f["atr_ratio"] < 0.8:
            why.append("volatility was subdued")
        if f["spread_frac"] > 0.10:
            why.append(f"spread took {f['spread_frac']:.0%} of the stop")
        if reason == "TIME/OTHER":
            why.append("neither stop nor target hit before the time limit")
        return (f"{verdict} {r:+.2f}R {row['symbol']} {row['side']} L{row['level']} [{row['setup']}, "
                f"{row['session']}] " + ("; ".join(why) if why else "no warning flags at entry"))

    # ---------- reading ----------
    def closed(self):
        rows = self.db.conn.execute("SELECT * FROM journal WHERE r_multiple IS NOT NULL ORDER BY ts_close").fetchall()
        return [dict(r) for r in rows]

    def _by_tag(self, rows):
        out = {}
        for r in rows:
            for tag in json.loads(r["tags"]):
                out.setdefault(tag, []).append(r)
        return out

    def analyze(self, min_n=10):
        rows = self.closed()
        by_tag = {t: _summ(v) for t, v in self._by_tag(rows).items() if len(v) >= min_n}
        rr = (rows[-1]["rr"] if rows else 3.0)
        be = breakeven_win_rate(rr, getattr(self.cfg, "breakeven_cost_r", 0.1) if self.cfg else 0.1)
        return {"overall": _summ(rows), "breakeven_win_rate": be, "by_tag": by_tag,
                "recent_lessons": [r["lesson"] for r in rows[-8:]],
                "open_unrecorded": self.db.conn.execute(
                    "SELECT COUNT(*) FROM journal WHERE r_multiple IS NULL").fetchone()[0]}

    def blocked_buckets(self):
        """Buckets with enough history whose best-case win rate is still below break-even."""
        cfg_n = getattr(self.cfg, "gate_min_n", 25) if self.cfg else 25
        cost = getattr(self.cfg, "breakeven_cost_r", 0.1) if self.cfg else 0.1
        rows = self.closed()
        if not rows:
            return set()
        be = breakeven_win_rate(rows[-1]["rr"], cost)
        blocked = set()
        for tag, v in self._by_tag(rows).items():
            if tag.split(":")[0] in ("setup", "session", "pair") and len(v) >= cfg_n:
                wins = sum(1 for r in v if r["r_multiple"] > 0)
                if wilson(wins, len(v))[1] < be:
                    blocked.add(tag)
        return blocked

    def win_prob_lcb(self, setup, min_n):
        """Pessimistic (95%) win probability for a setup, or None if too little evidence."""
        v = [r for r in self.closed() if r["setup"] == setup]
        if len(v) < min_n:
            return None
        return wilson(sum(1 for r in v if r["r_multiple"] > 0), len(v))[0]
