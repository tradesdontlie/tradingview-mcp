"""Market-flow features, computed once per bar from candles. Every column uses only data that
was known at that bar's close (no look-ahead; tests/test_advanced.py proves it).

Concepts (hypotheses to be tested by the journal, not proven edges):
  htf        higher-timeframe (4h) trend: +1 up, -1 down, 0 none
  bos_*      break of structure: close beyond the last confirmed swing high/low (last 20 bars)
  zone       +1 premium (above 50% of the swing range), -1 discount
  sweep_*    liquidity grab: wick through the recent extreme, close back inside (last 3 bars)
  ob_*_tap   order block: price returns into the last opposite candle before a structure break
             and closes with a rejection candle
  orb_*      breakout of the London opening range (first 1h bar, 07:00 UTC)
  reject_*   rejection candle: long wick (>= 50% of range) and a close in the trade direction
"""
import time
import numpy as np
import pandas as pd

K = 3          # swing confirmation: a pivot is confirmed K bars after it forms
OHLC = {"open": "first", "high": "max", "low": "min", "close": "last"}


def session_name(hour: int) -> str:
    if hour < 7:
        return "asian"
    if hour < 12:
        return "london"
    if hour < 16:
        return "overlap"
    if hour < 21:
        return "ny"
    return "off"



def directional_room_levels(
    close, confirmed_high, confirmed_low, lookback=100, confirmation_lag=3
):
    """Return nearest active confirmed resistance and support levels."""
    close = np.asarray(close, dtype=float)
    highs = np.asarray(confirmed_high, dtype=float)
    lows = np.asarray(confirmed_low, dtype=float)

    if close.ndim != 1 or highs.ndim != 1 or lows.ndim != 1:
        raise ValueError("Room inputs must be one-dimensional")
    if not (len(close) == len(highs) == len(lows)):
        raise ValueError("Room inputs must have equal lengths")
    if not isinstance(lookback, (int, np.integer)) or lookback < 1:
        raise ValueError("lookback must be a positive integer")
    if not isinstance(confirmation_lag, (int, np.integer)) or confirmation_lag < 1:
        raise ValueError("confirmation_lag must be a positive integer")

    room_high = np.full(len(close), np.nan)
    room_low = np.full(len(close), np.nan)
    active_highs = []
    active_lows = []

    for i, price in enumerate(close):
        if not np.isfinite(price):
            continue

        start = max(0, i - lookback + 1)
        active_highs = [
            (level, index) for level, index in active_highs
            if index >= start and price <= level
        ]
        active_lows = [
            (level, index) for level, index in active_lows
            if index >= start and price >= level
        ]

        confirm_start = max(0, i - confirmation_lag + 1)
        recent_closes = close[confirm_start:i + 1]
        recent_closes = recent_closes[np.isfinite(recent_closes)]

        high = highs[i]
        if np.isfinite(high) and not np.any(recent_closes > high):
            active_highs.append((high, i))

        low = lows[i]
        if np.isfinite(low) and not np.any(recent_closes < low):
            active_lows.append((low, i))

        eligible_highs = [level for level, _ in active_highs if level > price]
        eligible_lows = [level for level, _ in active_lows if level < price]

        if eligible_highs:
            room_high[i] = min(eligible_highs)
        if eligible_lows:
            room_low[i] = max(eligible_lows)

    return room_high, room_low


def build_context(df: pd.DataFrame, htf: str = "4h") -> pd.DataFrame:
    o, h, l, c = df["open"], df["high"], df["low"], df["close"]
    ctx = pd.DataFrame({"open": o, "high": h, "low": l, "close": c}, index=df.index)

    pc = c.shift(1)
    tr = pd.concat([h - l, (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)
    atr = tr.ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
    ctx["atr"] = atr
    ctx["atr_ratio"] = atr / atr.rolling(100).median()
    ctx["dist_ma"] = (c - c.rolling(20).mean()) / atr
    ctx["low5"], ctx["high5"] = l.rolling(5).min(), h.rolling(5).max()
    ema20 = c.ewm(span=20, adjust=False).mean()
    ctx["near_ema"] = ((c - ema20).abs() / atr) <= 0.5               # pulled back to the 20 EMA
    ctx["er"] = (c - c.shift(30)).abs() / c.diff().abs().rolling(30).sum()   # efficiency ratio: 1 = straight line

    # Direction of this timeframe itself, using only its completed candles.
    own_sma = c.rolling(50).mean()
    own_up = (c > own_sma) & (own_sma > own_sma.shift(10))
    own_dn = (c < own_sma) & (own_sma < own_sma.shift(10))
    ctx["direction"] = np.where(own_up, 1, np.where(own_dn, -1, 0))
    ctx.loc[own_sma.isna() | own_sma.shift(10).isna(), "direction"] = 0
    ctx["direction"] = ctx["direction"].astype(int)

    # Higher-timeframe trend. shift(1): only COMPLETED higher-timeframe bars are visible.
    h4 = df.resample(htf).agg(OHLC).dropna()
    sma = h4["close"].rolling(50).mean()
    up = (h4["close"] > sma) & (sma > sma.shift(10))
    dn = (h4["close"] < sma) & (sma < sma.shift(10))
    t4 = pd.Series(np.where(up, 1, np.where(dn, -1, 0)), index=h4.index)
    t4 = t4.where(sma.notna() & sma.shift(10).notna()).shift(1)
    ctx["htf"] = t4.reindex(df.index, method="ffill").fillna(0).astype(int)

    # swings, structure, premium/discount
    pivot_hi = h == h.rolling(2 * K + 1, center=True).max()
    pivot_lo = l == l.rolling(2 * K + 1, center=True).min()
    # Raw confirmed pivot events preserve the historical levels for room checks.
    confirmed_high = h.where(pivot_hi).shift(K)
    confirmed_low = l.where(pivot_lo).shift(K)

    # Forward-filled latest pivots remain dedicated to structure calculations.
    sh = confirmed_high.ffill()
    sl = confirmed_low.ffill()
    ctx["swing_high"], ctx["swing_low"] = sh, sl

    room_high, room_low = directional_room_levels(
        c, confirmed_high, confirmed_low
    )
    ctx["room_high"], ctx["room_low"] = room_high, room_low
    bos_up = (c > sh.shift(1)) & (pc <= sh.shift(1))
    bos_dn = (c < sl.shift(1)) & (pc >= sl.shift(1))
    ctx["bos_up_recent"] = bos_up.rolling(20).max().fillna(0).astype(bool)
    ctx["bos_dn_recent"] = bos_dn.rolling(20).max().fillna(0).astype(bool)
    mid = (sh + sl) / 2
    ctx["zone"] = np.where((sh > sl) & (c > mid), 1, np.where((sh > sl) & (c <= mid), -1, 0))

    # liquidity sweeps
    pmin, pmax = l.rolling(20).min().shift(1), h.rolling(20).max().shift(1)
    ctx["sweep_low_recent"] = ((l < pmin) & (c > pmin)).rolling(3).max().fillna(0).astype(bool)
    ctx["sweep_high_recent"] = ((h > pmax) & (c < pmax)).rolling(3).max().fillna(0).astype(bool)

    # rejection candles
    rng = (h - l).replace(0, np.nan)
    ctx["reject_buy"] = (((np.minimum(o, c) - l) / rng) >= 0.5) & (c > o)
    ctx["reject_sell"] = (((h - np.maximum(o, c)) / rng) >= 0.5) & (c < o)

    # order blocks (small loop; causal)
    n = len(df)
    ob_buy, ob_sell = np.zeros(n, bool), np.zeros(n, bool)
    ov, hv, lv, cv = o.values, h.values, l.values, c.values
    bu, bd = bos_up.values, bos_dn.values
    bz = sz = None                                    # [zone_low, zone_high, bar_of_break]
    for t in range(n):
        if bu[t]:
            bz, sz = None, None
            for i in range(t - 1, max(t - 11, -1), -1):
                if cv[i] < ov[i]:
                    bz = [lv[i], hv[i], t]
                    break
        if bd[t]:
            bz, sz = None, None
            for i in range(t - 1, max(t - 11, -1), -1):
                if cv[i] > ov[i]:
                    sz = [lv[i], hv[i], t]
                    break
        if bz and t > bz[2] and t - bz[2] <= 60 and lv[t] <= bz[1] and cv[t] >= max(ov[t], bz[0]):
            ob_buy[t] = True
        if sz and t > sz[2] and t - sz[2] <= 60 and hv[t] >= sz[0] and cv[t] <= min(ov[t], sz[1]):
            ob_sell[t] = True
    ctx["ob_buy_tap"], ctx["ob_sell_tap"] = ob_buy, ob_sell

    # London opening range (first 1h bar), usable from 08:00 to 15:59 UTC
    hour = df.index.hour
    day = df.index.normalize()
    mod = hour * 60 + df.index.minute
    gaps = np.diff(df.index.values).astype("timedelta64[s]").astype(float)
    or_len = 60 if (len(gaps) == 0 or np.median(gaps) >= 3600) else 30     # opening range: 1h bar, or 30 min
    in_or = (mod >= 420) & (mod < 420 + or_len)
    or_hi = h.where(in_or).groupby(day).transform("max")
    or_lo = l.where(in_or).groupby(day).transform("min")
    valid = (mod >= 420 + or_len) & (mod < 960)
    ctx["orb_up"] = valid & (c > or_hi) & (pc <= or_hi)
    ctx["orb_dn"] = valid & (c < or_lo) & (pc >= or_lo)

    ctx["hour"], ctx["dow"] = hour, df.index.day_of_week
    ctx["ts"] = ((df.index - pd.Timestamp("1970-01-01")) // pd.Timedelta("1s")).values
    return ctx


class ContextCache:
    """Reuse completed-bar context and back off when candle updates are delayed."""

    TF_SECONDS = {"M1": 60, "M5": 300, "M15": 900, "H1": 3600}
    MAX_RETRY_SECONDS = 300

    def __init__(self, bars: int = 450, tf: str = "H1", htf: str = "4h",
                 retry_seconds: float = 15):
        self.bars, self.tf, self.htf = bars, tf, htf
        self.retry_seconds = retry_seconds
        self._store = {}
        self._cycle_store = {}
        self._next_refresh = {}
        self._retry_attempts = {}

    def begin_cycle(self):
        """Start a fresh analysis cycle; each symbol may be checked once."""
        self._cycle_store = {}

    def _schedule_retry(self, symbol, now):
        attempt = self._retry_attempts.get(symbol, 0)
        delay = min(
            self.retry_seconds * (2 ** attempt),
            self.MAX_RETRY_SECONDS,
        )
        self._retry_attempts[symbol] = attempt + 1
        self._next_refresh[symbol] = now + delay

    def get(self, broker, symbol):
        if symbol in self._cycle_store:
            return self._cycle_store[symbol]

        now = broker.now()
        hit = self._store.get(symbol)
        next_refresh = self._next_refresh.get(symbol)

        if next_refresh is not None and now < next_refresh:
            result = hit[1] if hit else None
            self._cycle_store[symbol] = result
            return result

        df = broker.candles(symbol, self.bars, self.tf)
        if df is None or len(df) < 260:
            result = hit[1] if hit else None
            self._schedule_retry(symbol, now)
            self._cycle_store[symbol] = result
            return result

        key = df.index[-1]
        if hit and hit[0] == key:
            ctx = hit[1]
            self._schedule_retry(symbol, now)
        else:
            ctx = build_context(df, self.htf)
            self._store[symbol] = (key, ctx)
            self._retry_attempts.pop(symbol, None)
            bar_seconds = self.TF_SECONDS.get(self.tf, 3600)
            key_seconds = int(key.value // 1_000_000_000)
            self._next_refresh[symbol] = key_seconds + (2 * bar_seconds)

        self._cycle_store[symbol] = ctx
        return ctx


class MultiTimeframeContextCache:
    """Maintain independent completed-candle contexts for M1/M5/M15/H1."""

    TIMEFRAMES = {
        "M1": ("5min",),
        "M5": ("15min",),
        "M15": ("1h",),
        "H1": ("4h",),
    }

    def __init__(self, bars: int = 450, retry_seconds: float = 15):
        self.caches = {
            tf: ContextCache(
                bars=bars,
                tf=tf,
                htf=htf,
                retry_seconds=retry_seconds,
            )
            for tf, (htf,) in self.TIMEFRAMES.items()
        }

    def begin_cycle(self):
        for cache in self.caches.values():
            cache.begin_cycle()

    def get(self, broker, symbol):
        now = broker.now()
        contexts = {}
        for tf, cache in self.caches.items():
            context = cache.get(broker, symbol)
            if context is None or context.empty:
                return None

            bar_seconds = ContextCache.TF_SECONDS[tf]
            latest_open = int(context.index[-1].timestamp())
            age = now - (latest_open + bar_seconds)
            if age < -bar_seconds or age > 2 * bar_seconds:
                return None

            contexts[tf] = context
        return contexts
