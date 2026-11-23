"""The pre-trade checklist. A trade needs EVERY item to pass. One function, used by the live
bot, the scanner and the backtest, so they can never disagree.

MARKET      1 trend        4h trend agrees with the trade
            2 structure    a break of structure happened in the trade direction (last 20 bars)
            3 location     buy in the discount half / sell in the premium half of the swing range
            4 trigger      a liquidity sweep, order-block tap, opening-range break or rejection candle
            5 room         at least 2R of clear space to the opposing swing
CONDITIONS  6 not chasing  price within 2 ATR of its 20-bar average
            7 volatility   ATR between 0.6x and 1.8x of its 100-bar median
            8 session      London / overlap / New York only; no late Friday
            9 spread+stop  spread <= 15% of the stop; stop between 1 and 2.5 ATR
OPTIONAL    regime      (scalp profile) trend setups only in a TREND regime; sweeps in TREND or RANGE
            news        no entries inside configured high-impact-news windows
ACCOUNT     10 risk gates  kill switch, caps, cooldown, one trade per tree (risk manager)
            11 journal     this setup/session/pair is not proven to lose (journal)
"""
import math
from dataclasses import dataclass, field
from functools import lru_cache

import pandas as pd

from .market_context import session_name

LIQUID = {"london", "overlap", "ny"}


@dataclass
class ChecklistResult:
    side: str
    checks: list = field(default_factory=list)      # [(name, ok, detail)]
    trigger: str = ""
    stop: float = 0.0

    @property
    def failed(self):
        return [n for n, ok, _ in self.checks if not ok]

    @property
    def passed(self):
        return not self.failed

    def add(self, name, ok, detail=""):
        self.checks.append((name, bool(ok), detail))


@lru_cache(maxsize=256)
def _window(spec: str):
    """'2026-11-20 13:25-13:45' (UTC) -> (start_epoch, end_epoch)."""
    day, rng = spec.split(" ")
    a, b = rng.split("-")
    base, epoch = pd.Timestamp(day), pd.Timestamp("1970-01-01")
    t0 = base + pd.Timedelta(hours=int(a[:2]), minutes=int(a[3:5]))
    t1 = base + pd.Timedelta(hours=int(b[:2]), minutes=int(b[3:5]))
    return (t0 - epoch) // pd.Timedelta("1s"), (t1 - epoch) // pd.Timedelta("1s")


def in_blackout(ts, windows) -> bool:
    return any(lo <= ts <= hi for lo, hi in (_window(w) for w in windows))


def regime_of(row, cfg) -> str:
    er = row.get("er")
    if er is None or (isinstance(er, float) and math.isnan(er)):
        return "mixed"
    if er >= cfg.ck_er_trend and row["htf"] != 0:
        return "trend"
    return "range" if er <= cfg.ck_er_range else "mixed"


def market_checks(row, side: str, spread: float, cfg) -> ChecklistResult:
    """`spread` is the TOTAL round-trip cost in price units: spread + commission + slippage allowance."""
    s = 1 if side == "BUY" else -1
    res = ChecklistResult(side)
    need = ("atr", "atr_ratio", "dist_ma", "low5", "high5", "swing_high", "swing_low")
    if any(row[k] is None or (isinstance(row[k], float) and math.isnan(row[k])) for k in need):
        res.add("data", False, "not enough history")
        return res
    atr, close = row["atr"], row["close"]
    raw = (close - row["low5"]) if s == 1 else (row["high5"] - close)
    stop = min(max(raw + 0.2 * atr, cfg.ck_stop_atr_lo * atr), cfg.ck_stop_atr_hi * atr)
    res.stop = stop

    triggers = [("sweep", row["sweep_low_recent"] if s == 1 else row["sweep_high_recent"]),
                ("ob", row["ob_buy_tap"] if s == 1 else row["ob_sell_tap"]),
                ("orb", row["orb_up"] if s == 1 else row["orb_dn"]),
                ("pullback", (row["reject_buy"] if s == 1 else row["reject_sell"]) and bool(row.get("near_ema", False))),
                ("rejection", row["reject_buy"] if s == 1 else row["reject_sell"])]
    res.trigger = next((n for n, v in triggers if v), "")
    regime = regime_of(row, cfg)
    # blueprint setup B: a sweep-and-reclaim inside a RANGE needs no trend or structure break
    range_sweep = cfg.regime_gating and res.trigger == "sweep" and regime == "range" and row["htf"] == 0

    res.add("trend", row["htf"] == s or range_sweep, f"trend {row['htf']}, regime {regime}")
    res.add("structure", bool(row["bos_up_recent"] if s == 1 else row["bos_dn_recent"]) or range_sweep, "break of structure")
    res.add("location", row["zone"] == -s, f"zone {row['zone']} (want {-s}: buy discount / sell premium)")
    res.add("trigger", bool(res.trigger), res.trigger or "none")

    opp = (row["swing_high"] - close) if s == 1 else (close - row["swing_low"])
    res.add("room", opp <= 0 or opp >= cfg.ck_room_r * stop, f"{opp / stop:.1f}R to opposing swing")
    d = row["dist_ma"]
    res.add("not_chasing", (d <= cfg.ck_max_dist_atr) if s == 1 else (d >= -cfg.ck_max_dist_atr),
            f"{d:.1f} ATR from average")
    res.add("volatility", cfg.ck_vol_lo <= row["atr_ratio"] <= cfg.ck_vol_hi, f"ATR ratio {row['atr_ratio']:.2f}")
    sess = session_name(int(row["hour"]))
    res.add("session", sess in LIQUID and not (int(row["dow"]) == 4 and int(row["hour"]) >= 18), sess)
    res.add("spread_stop", spread <= cfg.ck_spread_frac * stop, f"all-in cost {spread / stop:.0%} of stop")
    if cfg.regime_gating:
        ok = (regime == "trend") if res.trigger in ("pullback", "orb", "ob", "rejection") else regime in ("trend", "range")
        res.add("regime", ok or not res.trigger, regime)
    if cfg.news_blackouts and row.get("ts") is not None:
        res.add("news", not in_blackout(row["ts"], cfg.news_blackouts), "news window")
    return res
