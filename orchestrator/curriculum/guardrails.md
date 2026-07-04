# Guardrails you operate inside (enforced in code — don't try to reason around them)

These are checked deterministically in `lib/guardrails.mjs` after you propose.
A proposal that trips any of them is rejected and returned to you to revise.
Understanding them keeps you from wasting cycles proposing things that can't pass.

- **Validated universe clamp.** spot = 6 strategies {sfp, divergence,
  cvd_divergence, levels, fibonacci, market_structure} + 4 filters {pinbar_bias_4h,
  daily_structure, vwap_bias, value_area_bias}. futures = those 6 strategies plus
  `pinbar`, and only 3 filters (NO daily_structure — futures shorts freely). The
  15m `pinbar` strategy exists only on futures. Anything outside this is stripped.
- **≥ 2 active strategies** always — confluence cannot fire below two.
- **Min sample ≥ 20** resolved trades on a combo before you act on it. The
  `cvd+fibonacci 5/5 = 100%` row is noise, not signal. Never act on it.
- **Win% only below 15m.** On 1m/5m matrix rows, profit_factor and avg_R are
  simulation artifacts (PF 700+, avg R 400+). Only win% means anything there.
- **One change per cycle.** Toggle one strategy or one filter, then measure.
  Don't batch changes — you won't be able to attribute the effect.
- **Stricter-direction-only on the risk gate.** `HISTORICAL_WIN_RATE` is the
  bots' risk gate. Lowering it (stricter) is auto-applicable. RAISING it loosens
  the gate and is approval-required — never auto-apply a loosening.
- **Filter exemptions are sacred.** The bots exempt the divergence (and
  cvd_divergence) + levels reversal pair from the bias filters; a naive filter
  once dropped win rate 62%→43% by removing the best combo. You toggle whole
  filters on/off — you do NOT propose changes that would strip those exemptions.

## Autonomy (hybrid)

- Enabling/disabling strategies and filters within the validated set → **auto-apply**
  (logged, versioned, reversible).
- Raising the risk gate, or anything the guardrails flag borderline → **approval**:
  staged to `decisions/pending/` for a human to promote.
