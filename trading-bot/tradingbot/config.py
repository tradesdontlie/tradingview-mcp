"""All tunable rules in one place. Confirm every value before going beyond demo."""
from dataclasses import dataclass


@dataclass
class Config:
    # --- tree rules (from the design document) ---
    max_open: int = 2                  # account-wide, not per branch
    reserve_root_slots: int = 1        # children may not take the last slot (no root starvation)
    rr: float = 3.0                    # target = rr x planned loss
    child_profit_frac: float = 1 / 3   # share of a winner's NET profit sent to children
    children_per_win: int = 2
    child_loss_frac: float = 0.5       # child planned loss = 50% of its budget
    root_pool_frac: float = 0.10       # share of a ROOT win's profit recorded in the pool
    max_depth: int = 6
    child_ttl_s: float = 3 * 24 * 3600     # unused child budgets expire
    max_hold_s: float = 48 * 3600          # time stop so a zombie trade cannot block slots

    # --- account protection ---
    root_risk_pct: float = 0.005       # planned loss of a root trade (fraction of equity)
    max_trade_risk_pct: float = 0.01   # hard cap per trade
    max_open_risk_pct: float = 0.015   # hard cap on total planned risk across open trades
    daily_loss_pct: float = 0.03       # -> PAUSE
    max_drawdown_pct: float = 0.10     # from peak equity -> FREEZE
    min_free_margin_pct: float = 0.50  # free margin must be >= this share of equity
    max_spread_frac_of_stop: float = 0.20
    signal_max_age_s: float = 300
    block_correlated: bool = True      # no two open trades pushing the same currency the same way
    send_grace_s: float = 120          # how long an unconfirmed order may stay unresolved

    db_path: str = "bot.db"
