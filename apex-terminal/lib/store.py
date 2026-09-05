#!/usr/bin/env python3
"""One fetch per symbol, shared by every panel.

The scorecard, radar, regime and backtest all want overlapping symbols. Fetching
each once — at the longest range any panel needs — keeps a full bake inside
roughly 60 outbound requests, which matters because Yahoo bans a burst.
"""
import time

from fetcher import FetchError
from sources import fetch_routed


class Store:
    def __init__(self, log=print):
        self._series = {}
        self._gaps = {}
        self._provider = {}
        self._fetched = {}
        self.log = log

    def load(self, symbol, rng="1y", years=2, max_age=900):
        if symbol in self._series or symbol in self._gaps:
            return self._series.get(symbol)
        try:
            s, provider = fetch_routed(symbol, rng=rng, years=years, max_age=max_age)
        except FetchError as exc:
            reason = "rate-limited" if "429" in str(exc) else "no-data"
            self._gaps[symbol] = reason
            self.log(f"  gap  {symbol:<10} {reason}: {exc}")
            return None
        self._series[symbol] = s
        self._provider[symbol] = provider
        self._fetched[symbol] = s.meta.get("fetched_at", time.time())
        flag = "cache" if s.meta.get("from_cache") else "live"
        self.log(f"  ok   {symbol:<10} {len(s):>4} bars via {provider} ({flag}) last={s.last}")
        return s

    def get(self, symbol, long=False):
        return self._series.get(symbol)

    def gap_reason(self, symbol):
        return self._gaps.get(symbol)

    def provider(self, symbol):
        return self._provider.get(symbol)

    def newest_at(self, provider):
        stamps = [self._fetched[s] for s, p in self._provider.items() if p == provider]
        return max(stamps) if stamps else None

    @property
    def gaps(self):
        return dict(self._gaps)

    @property
    def loaded(self):
        return sorted(self._series)
