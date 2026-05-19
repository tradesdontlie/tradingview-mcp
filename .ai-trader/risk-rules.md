# Risk Rules

## Stop Placement
- Stop must be placed at a logical structural level (beyond wick, outside FVG, below/above OR level).
- Reject any trade where stop placement is ambiguous or arbitrary.

## Target Selection
- Pick TP from real market structure first (next S/R, session extreme, FVG, VWAP).
- Calculate R after TP is identified — not before.
- TP1 must yield at least 1.2R minimum to be executable.
- Prefer setups with TP1 at 1.5R–2R+.
- TP2 is optional — used when structure permits a runner.

## Trade Rejection Criteria
- Stop unclear or requires arbitrary placement → REJECT
- Price in chop / consolidation with no clean directional bias → WAIT
- Major news spike in progress or imminent → WAIT
- Chart scale distorted → pause until fixed
- Calculated R to TP1 < 1.2 → REJECT (note it, do not force)

## Orderflow Conflict
- Orderflow opposing setup direction: lower confidence rating, do not auto-reject.
- Extreme orderflow divergence (e.g., heavy absorption against direction): downgrade to WAIT.

## Position Sizing
- Not handled here — this layer outputs levels only.
- User applies their own sizing per signal confidence.

## No-Trade Conditions
- Within 5 min of major economic release (NFP, CPI, FOMC, etc.)
- Spread abnormally wide (illiquid session for micro contracts)
- Consecutive failed setups in same session without structural reset
