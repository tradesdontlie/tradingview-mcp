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

    # ---- advancements (all OFF by default so the original behaviour is untouched) ----
    checklist_enabled: bool = False        # pre-trade checklist gate
    equity_guard_enabled: bool = False     # profit lock + drawdown ladder + loss-streak cooldown
    journal_enabled: bool = False          # record every trade, learn from outcomes
    multi_slot_enabled: bool = False       # extra slots for proven high-confidence trades
    one_open_per_tree: bool = False        # never two open trades from the same tree
    max_open_high_conf: int = 4            # hard cap even for high-confidence trades
    extra_slot_min_prob: float = 0.80      # journal-proven win probability needed (lower bound)
    extra_slot_min_trades: int = 30        # journal sample needed before that probability counts
    child_min_win_r: float = 0.0           # a parent must win >= this many R before it spawns children

    # checklist thresholds
    ck_max_dist_atr: float = 2.0           # not chasing: price within N ATR of its 20-bar average
    ck_vol_lo: float = 0.6                 # ATR vs its 100-bar median
    ck_vol_hi: float = 1.8
    ck_spread_frac: float = 0.15           # spread <= 15% of the stop
    ck_room_r: float = 2.0                 # clear space to the opposing swing, in R
    ck_stop_atr_lo: float = 1.0
    ck_stop_atr_hi: float = 2.5

    # equity guard
    lock_activate: float = 0.03            # profit lock arms once equity is +3% above its start
    lock_frac: float = 0.5                 # ...and then protects 50% of the gains
    dd_ladder: tuple = ((0.01, 0.75), (0.02, 0.50), (0.03, 0.25))   # (drawdown, risk multiplier)
    lockout_dd: float = 0.05               # drawdown from peak that pauses trading
    streak_n: int = 3                      # consecutive losses that trigger a cooldown
    streak_cooldown_s: float = 24 * 3600

    # journal learning
    gate_min_n: int = 25                   # trades needed before a bucket can be blocked
    breakeven_cost_r: float = 0.10         # assumed cost per trade, in R

    @classmethod
    def improved(cls, **kw):
        """Preset with all advancements on."""
        base = dict(checklist_enabled=True, equity_guard_enabled=True, journal_enabled=True,
                    multi_slot_enabled=True, one_open_per_tree=True, child_min_win_r=1.0)
        base.update(kw)
        return cls(**base)
