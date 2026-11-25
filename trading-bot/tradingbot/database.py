"""SQLite persistence: tree nodes, risk decisions, audit log, key-value state."""
import json
import sqlite3
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS nodes(
  node_id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER, root_id INTEGER, level INTEGER NOT NULL,
  state TEXT NOT NULL,
  budget REAL NOT NULL, planned_loss REAL NOT NULL,
  symbol TEXT, side TEXT, client_id TEXT, ticket INTEGER, attempts INTEGER DEFAULT 0,
  volume REAL, entry REAL, sl REAL, tp REAL, risk_amount REAL, net_pnl REAL,
  signal_id TEXT,
  created_ts REAL, sent_ts REAL, opened_ts REAL, closed_ts REAL, expires_ts REAL
);
CREATE TABLE IF NOT EXISTS risk_decisions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, node_id INTEGER, approved INTEGER,
  reason TEXT, risk_amount REAL, volume REAL);
CREATE TABLE IF NOT EXISTS audit(
  event_id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, actor TEXT, event_type TEXT,
  payload TEXT, correlation_id TEXT);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS snapshots(ts REAL, balance REAL, equity REAL, margin_free REAL);
"""

NODE_COLS = {
    "parent_id", "root_id", "level", "state", "budget", "planned_loss", "symbol", "side",
    "client_id", "ticket", "attempts", "volume", "entry", "sl", "tp", "risk_amount",
    "net_pnl", "created_ts", "sent_ts", "opened_ts", "closed_ts", "expires_ts", "signal_id",
}


class Database:
    def __init__(self, path: str = ":memory:"):
        self.conn = sqlite3.connect(path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript(SCHEMA)
        columns = {r[1] for r in self.conn.execute("PRAGMA table_info(nodes)")}
        if "signal_id" not in columns:
            self.conn.execute("ALTER TABLE nodes ADD COLUMN signal_id TEXT")
        self.conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_signal_id "
            "ON nodes(signal_id) WHERE signal_id IS NOT NULL"
        )
        self.conn.commit()
        self.clock = time.time       # replaced by the broker clock in simulations

    # ---- nodes ----
    @staticmethod
    def _check(cols):
        bad = set(cols) - NODE_COLS
        if bad:
            raise ValueError(f"unknown node columns: {bad}")

    def add_node(self, **f) -> int:
        self._check(f)
        cols = list(f)
        cur = self.conn.execute(
            f"INSERT INTO nodes({','.join(cols)}) VALUES({','.join('?' * len(cols))})",
            [f[c] for c in cols])
        nid = cur.lastrowid
        if f.get("root_id") is None:
            self.conn.execute("UPDATE nodes SET root_id=? WHERE node_id=?", (nid, nid))
        self.conn.commit()
        return nid

    def add_root_once(self, signal_id, **fields):
        """Create a root once per signal; return None when it was already recorded."""
        if not signal_id:
            return self.add_node(**fields)
        fields["signal_id"] = signal_id
        try:
            return self.add_node(**fields)
        except sqlite3.IntegrityError:
            row = self.conn.execute(
                "SELECT node_id FROM nodes WHERE signal_id=?", (signal_id,)
            ).fetchone()
            if row is not None:
                return None
            raise

    def update_node(self, node_id: int, **f) -> None:
        self._check(f)
        sets = ",".join(f"{c}=?" for c in f)
        self.conn.execute(f"UPDATE nodes SET {sets} WHERE node_id=?", [*f.values(), node_id])
        self.conn.commit()

    def node(self, node_id: int):
        row = self.conn.execute("SELECT * FROM nodes WHERE node_id=?", (node_id,)).fetchone()
        return dict(row) if row else None

    def nodes(self, *states):
        if states:
            q = f"SELECT * FROM nodes WHERE state IN ({','.join('?' * len(states))}) ORDER BY node_id"
            rows = self.conn.execute(q, states).fetchall()
        else:
            rows = self.conn.execute("SELECT * FROM nodes ORDER BY node_id").fetchall()
        return [dict(r) for r in rows]

    def children_of(self, node_id: int):
        rows = self.conn.execute("SELECT * FROM nodes WHERE parent_id=? ORDER BY node_id",
                                 (node_id,)).fetchall()
        return [dict(r) for r in rows]

    # ---- key-value ----
    def kv_get(self, k, default=None):
        row = self.conn.execute("SELECT v FROM kv WHERE k=?", (k,)).fetchone()
        return row["v"] if row else default

    def kv_set(self, k, v) -> None:
        self.conn.execute("INSERT INTO kv(k, v) VALUES(?, ?) "
                          "ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, str(v)))
        self.conn.commit()

    # ---- logs ----
    def audit(self, actor, event_type, payload=None, correlation_id=None) -> None:
        self.conn.execute(
            "INSERT INTO audit(ts, actor, event_type, payload, correlation_id) VALUES(?,?,?,?,?)",
            (self.clock(), actor, event_type, json.dumps(payload or {}, default=str), correlation_id))
        self.conn.commit()

    def decision(self, node_id, approved, reason, risk_amount, volume) -> None:
        self.conn.execute(
            "INSERT INTO risk_decisions(ts, node_id, approved, reason, risk_amount, volume) "
            "VALUES(?,?,?,?,?,?)",
            (self.clock(), node_id, int(approved), reason, risk_amount, volume))
        self.conn.commit()

    def snapshot(self, balance, equity, margin_free) -> None:
        self.conn.execute("INSERT INTO snapshots VALUES(?,?,?,?)",
                          (self.clock(), balance, equity, margin_free))
        self.conn.commit()

    def audit_events(self, event_type=None):
        if event_type:
            rows = self.conn.execute("SELECT * FROM audit WHERE event_type=? ORDER BY event_id",
                                     (event_type,)).fetchall()
        else:
            rows = self.conn.execute("SELECT * FROM audit ORDER BY event_id").fetchall()
        return [dict(r) for r in rows]

    def close(self):
        """Close the SQLite connection when the engine shuts down."""
        self.conn.close()
