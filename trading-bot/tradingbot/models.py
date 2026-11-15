"""Shared data types."""
from dataclasses import dataclass
from enum import Enum


class Mode(str, Enum):
    NONE = "NONE"
    PAUSE = "PAUSE"          # no new entries; existing positions + stops stay
    FREEZE = "FREEZE"        # no new entries, pending entries cancelled, stops stay
    LIQUIDATE = "LIQUIDATE"  # close everything


SEVERITY = {Mode.NONE: 0, Mode.PAUSE: 1, Mode.FREEZE: 2, Mode.LIQUIDATE: 3}


class BrokerReject(Exception):
    """The broker DEFINITELY refused the order (nothing was opened)."""


@dataclass(frozen=True)
class SymbolSpec:
    symbol: str
    volume_min: float
    volume_step: float
    volume_max: float
    tick_size: float
    tick_value: float          # account-currency P&L per tick per 1.0 lot
    digits: int
    min_stop_distance: float = 0.0


@dataclass(frozen=True)
class AccountInfo:
    balance: float
    equity: float
    margin_free: float
    is_demo: bool
    hedging: bool


@dataclass(frozen=True)
class Signal:
    symbol: str
    side: str                  # "BUY" or "SELL"
    stop_distance: float       # price units between entry and stop
    created_at: float          # unix seconds
    strategy: str = "placeholder-v0"


@dataclass(frozen=True)
class Position:
    ticket: int
    client_id: str
    symbol: str
    side: str
    volume: float
    open_price: float
    sl: float
    tp: float
    open_time: float


@dataclass(frozen=True)
class ClosedTrade:
    client_id: str
    net_pnl: float             # after commission, swap and fees
    close_time: float
