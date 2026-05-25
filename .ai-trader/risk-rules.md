# Risk Rules

## Hard Risk Limits

These are not guidelines. Any violation is a hard reject — do not take the trade.

| Rule | Limit |
|------|-------|
| Live trading | Disabled — v0.1 is manual execution only |
| Max trades per day | 3 |
| Max daily loss | 2R (or user-defined dollar cap, whichever is lower) |
| Minimum reward:risk to TP1 | 1.5R |
| Signal expiry | 3 candles after entry trigger — reject if not filled |
| Averaging down | Never |
| Stop not defined | Reject |
| Target not defined | Reject |
| Duplicate active signal | Reject (same direction, same setup still open) |

---

## Stop Placement

- Stop must be at a structural level: below sweep low (LONG) or above sweep high (SHORT).
- Stop that requires arbitrary placement → REJECT.
- Stop too wide (exceeds max tick limit for symbol) → REJECT.
- Stop must be defined before the signal is issued — never estimated after entry.
- Never move stop against the trade before TP1 is reached.

## Target Selection

- TP1 and TP2 must be at real market structure: next session extreme, FVG fill, VWAP, HTF level.
- Calculate R after TP is identified — never work backwards from a desired R number.
- TP1 must yield at least 1.5R. If it does not → REJECT.
- TP2 is optional — only added when structure permits a runner beyond TP1.
- Do not invent a target beyond visible structure.

---

## Rejection Trigger Table

Every condition below is a hard REJECT. Log the rejection reason every time.

| Trigger | Reject reason |
|---------|---------------|
| 4H bias directly opposes 1H bias | HTF conflict — no directional permission on either side |
| 4H, 1H, and 15m all disagree | No MTF alignment — cannot determine valid direction |
| HTF conflict present and setup grade is below A+ | Insufficient conviction to override conflict |
| Sweep of session level did not occur | Entry precondition not met — still in WAIT |
| Sweep occurred but reclaim did not happen | Reversal failed — do not chase |
| Reclaim took more than 5 candles | Reclaim window expired — setup stale |
| No 5m MSS or CHoCH confirmed after reclaim | Execution precondition not met |
| Displacement candle is absent | No impulsive confirmation move |
| Displacement candle has below-average volume | Weak move — may be a trap or noise |
| Stop placement is ambiguous or arbitrary | Risk cannot be defined — no trade |
| Stop exceeds max tick width for symbol | Structural risk too large per position |
| Reward:risk to TP1 is below 1.5R | Setup does not meet minimum expectancy threshold |
| An identical direction signal is already active | Duplicate — do not stack positions |
| More than 3 candles have passed since entry trigger | Signal expired — do not late-enter a stale setup |
| News lockout window is active | Major economic release imminent or very recent |
| Spread is abnormally wide | Illiquid conditions — execution slippage risk unacceptable |
| Third trade of the day and setup is grade B or lower | Daily trade budget limits lower-conviction entries |
| Consecutive failed setups in same session without structural reset | Session is broken — no further attempts until reset |
| Chart scale is distorted or price data appears stale | Data integrity unknown — pause until verified |

---

## Orderflow Conflict

- Orderflow opposing setup direction: lower confidence by one grade (A → B), do not auto-reject.
- Extreme orderflow divergence (heavy absorption against direction): downgrade to WAIT.
- Never upgrade confidence grade based on orderflow alone.
- Delta approximation from tick-rule is not true bid/ask data — weight it as supporting context only.

---

## Position Sizing

- Not handled by this layer — the signal outputs levels only.
- User applies their own sizing per signal confidence.
- Suggested approach: smaller size on grade B, standard size on A/A+, no live size on C or Reject.

---

## No-Trade Windows

- Within 5 minutes before any major economic release (NFP, CPI, FOMC, GDP, PCE, PPI, Jobless Claims, ISM, PMI, FOMC Minutes, Fed Chair Speech)
- Within 2 minutes after any major release
- Spread abnormally wide (illiquid session for micro contracts)
- Consecutive failed setups in same session without a visible structural reset on 15m or higher
- After max daily loss is reached — no further signals that day
- After max daily trade count (3) is reached — no further signals that day
