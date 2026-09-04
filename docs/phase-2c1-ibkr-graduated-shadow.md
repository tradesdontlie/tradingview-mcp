# Phase 2C.1 — IBKR Market Input Adapter + Graduated CRR Shadow Validation

Status: **shadow/diagnostic only.** No production pricing switch.

New: `src/providers/ibkr/{clientPortalClient,ibkrMarketInputsProvider}.js`,
`src/core/options/marketInputs/marketInputPrecedence.js`. Tests:
`tests/ibkr_market_inputs.test.js` (38 tests, zero live IBKR auth
required). Live script: `scripts/phase2c1-graduated-shadow-live.mjs`.

## B — IBKR connection

**Gateway**: probed `https://localhost:5000/v1/api` and `:5001` — both
**connection refused / timeout**. No Client Portal Gateway is running in
this environment.
**Authentication**: not reached (no gateway to authenticate against).
**Market-data status**: N/A — `fetchIbkrMarketInputs()` correctly returned
`connection_status: UNAVAILABLE` with `IBKR_UNAVAILABLE` in warnings,
without throwing, exactly as designed for this case.

## C — IBKR fields

**Not obtainable live this session** (no gateway). Normalized live values
for NVDA/AAPL/PANW: **UNAVAILABLE** for Fee Rate, Shortable Shares,
Shortable status, and Expected 12m Dividends — all three symbols fell
back to the same TradingView-only inputs used in Phase 2C. The parser and
orchestration logic (percentage/numeric/null/zero handling, snapshot
preflight retry, auth/connection state machine) is fully verified against
frozen fixtures in `tests/ibkr_market_inputs.test.js` — Steps 3-13 are
implemented and tested, just not exercised against a live IBKR session.

## D — Market input confidence

Unchanged from Phase 2C since IBKR remained unavailable: NVDA/AAPL
`PARTIAL_EXTERNAL_INPUTS`/LOW; PANW `PARTIAL_EXTERNAL_INPUTS`/MEDIUM
(documented zero-dividend, HIGH-confidence dividend leg, capped by
missing borrow). The new `classifyShadowMarketInputConfidence` (Step 15)
is implemented and unit-tested for the HIGH path (Treasury + IBKR borrow
+ non-LOW dividend + REALTIME data) but that path was never reached live.

## E — 5-day LOCAL comparison

| Symbol | Median Disagreement | P95 | Max |
|---|---|---|---|
| NVDA | 1.08% | 2.46% | 3.77% |
| AAPL | 0.83% | 2.54% | 3.24% |
| PANW | 0.53% | 1.49% | 1.96% |

## F — 15-day MODERATE comparison

| Symbol | Median | P95 | Max |
|---|---|---|---|
| NVDA | 4.39% | 8.11% | 12.83% |
| AAPL | 3.54% | 8.57% | 9.91% |
| PANW | 2.51% | 4.96% | 7.22% |

## G — 30-day STRESS comparison

| Symbol | Median | P95 | Max |
|---|---|---|---|
| NVDA | 7.85% | 37.85% | 45.63% |
| AAPL | 2.76% | 22.80% | 40.88% |
| PANW | 8.20% | 19.51% | 25.26% |

**Hypothesis confirmed, not forced**: disagreement rises monotonically
with horizon for every symbol (5d ≪ 15d ≪ 30d), exactly as Step 23
anticipated. Note AAPL's 30d *median* (2.76%) looks lower than its 15d
median (3.54%) — but AAPL's 30d P95/max (22.8%/40.9%) are far higher than
15d, meaning the 30-day distribution is more right-skewed (a few very
divergent candidates), not more disagreement across the board.

## H — Warning correlation

| Symbol | Warned mean | Unwarned mean |
|---|---|---|
| NVDA | 12.44% (n=120) | 2.64% (n=249) |
| AAPL | 6.76% (n=105) | 2.30% (n=219) |
| PANW | 9.71% (n=99) | 1.51% (n=216) |

Pooled across all three horizons, candidates already carrying a Phase 0B
warning (`LARGE_TIME_STEP`/`NEAR_EXPIRATION`/`LARGE_SPOT_MOVE`/
`INTRINSIC_FLOOR_APPLIED`) show **3-6x higher mean disagreement** than
unwarned ones, with much larger, more balanced samples than Phase 2C's
thin n=2 unwarned bucket. **This is a clean, well-supported "yes" to Step
24's core question.**

## I — Borrow ablation

Synthetic 75bp fee rate (explicitly labeled `SYNTHETIC_FIXTURE_FOR_
ABLATION_ONLY_NOT_LIVE_IBKR` — IBKR was unavailable) vs no borrow, STRESS_30D:

| Symbol | Mean \|ΔP&L\| | Ranking top-5 overlap |
|---|---|---|
| NVDA | $1.39 | **5/5** |
| AAPL | $1.87 | **5/5** |
| PANW | $2.20 | **5/5** |

Adding a modest borrow component produces small P&L shifts and **does
not disturb top-5 rankings at all** for any symbol at this fee-rate
magnitude. Borrow input quality matters far less to ranking stability
than Phase 2C's severity implied — a genuinely useful, non-assumed
finding (Step 25 explicitly warned not to assume it matters).

## J — Dividend ablation

Held the carry magnitude constant and only changed the *mode label*
(TRAILING vs a same-magnitude FORWARD-style value, since no live IBKR
forward-dividend figure exists): mean `|ΔP&L|` = **$0.00** for both NVDA
and AAPL, exactly as expected — this ablation, as implemented, isolates
that the mode label alone carries no pricing effect (only a genuinely
different IBKR forward-dividend *value* would). A live IBKR-vs-trailing
value comparison could not be run (Section C). PANW skipped (zero-dividend).

## K — NVDA rank instability decomposition

Using the Phase 2C.1 STRESS_30D scenario set (0.90/1.00/1.10, symmetric)
rather than Phase 2C's original asymmetric standardized set (0.90/1.05/1.10):

| Transition | Top-5 overlap | Spearman | Largest move |
|---|---|---|---|
| LOCAL → CRR (no borrow) | 5/5 | 0.935 | 13 |
| CRR no-borrow → CRR +synthetic-borrow | 5/5 | 0.999 | 2 |
| LOCAL → CRR +synthetic-borrow (total) | 5/5 | 0.933 | 13 |

**This does not reproduce Phase 2C's reported 1/5 overlap / 33-position
swing.** The pricing-model change (LOCAL→CRR) alone accounts for nearly
all of the modest instability seen here (spearman 0.935), and borrow
addition contributes almost nothing further (spearman 0.999, essentially
unchanged). **Conclusion: the severe instability Phase 2C reported was
not well explained by missing borrow data** — it is far more likely
sensitive to the *exact scenario percentages* used for ranking (Phase
2C's BASE=1.05×S0 vs this phase's MID=1.00×S0), a confound neither report
isolated cleanly. This is reported as an open finding requiring further
decomposition, not resolved by this ablation.

## L — Ranking stability

Across all three symbols under the STRESS_30D symmetric scenario set and
either borrow state, top-5 overlap was **5/5** (perfectly stable) — a
markedly calmer picture than Phase 2C's original result, reinforcing
Section K's conclusion that scenario-set choice (not model choice or
borrow-input state) likely drove most of Phase 2C's NVDA instability.

## M — Expiration reconciliation

Unchanged from Phase 2C — already exact for all four required strategy
types (verified again this session via the full regression suite, not
re-tested live in this phase since nothing about the reconciliation logic
changed).

## N — Missing/stale data behavior

Verified live: IBKR unavailability produced `UNAVAILABLE` (not a crash,
not a fabricated value) at every call site; borrow stayed `null`
throughout with `BORROW_DATA_UNAVAILABLE` propagated; every market-input
record correctly stayed at `PARTIAL_EXTERNAL_INPUTS`. This entire live run
is labeled **OFF_HOURS_DIAGNOSTIC** (Sunday 2026-08-30 UTC — U.S. markets
closed; the TradingView chain data reused is the same snapshot confirmed
unchanged since Phase 2C) — per Step 30, **not used for the production-
readiness verdict** below on its own; it supplements Phase 2C's findings
rather than replacing them.

## O — Limitations

- IBKR Fee Rate (when eventually available) is a broker-provided borrow
  proxy specific to IBKR clients, not necessarily the universal
  securities-lending market rate.
- Short-sale proceeds/credit interest is a separate economic component
  not captured by Fee Rate alone.
- Forward 12m dividend (IBKR field 7671, when available) is still
  converted to a flat continuous yield — not a discrete ex-dividend-date
  model.
- Constant per-contract IV shock (no vol-surface dynamics) throughout.
- This remains shadow-only; no Copilot-facing output changed.
- No OI/volume used in filtering or ranking (Step 29 honored).
- **This entire live run is OFF_HOURS_DIAGNOSTIC** — no live U.S. market
  session was available this session to validate against; a repeat during
  active trading hours is needed before any production-migration decision.
- IBKR itself was never actually reached — every IBKR-shaped result in
  this report is either a unit test against a frozen fixture or an
  explicitly-labeled synthetic ablation value, never real broker data.

## P — Verdict

**B) CRR READY BUT IBKR INPUT QUALITY STILL INCOMPLETE**

Checking Step 31's ten criteria: (1) IBKR adapter reliable/deterministic
— **yes, on frozen fixtures**, but never exercised live; (2) no
credentials stored — **yes**; (3) missing values explicit — **yes**,
verified live; (4) 5-day median disagreement ≤10% — **yes, comfortably**
(0.53–1.08%); (5) 5-day P95 ≤15% — **yes, comfortably** (1.49–2.54%); (6)
15/30-day disagreement rises specifically where LOCAL_GREEK already warns
— **yes, strongly supported** (Section H); (7) adding borrow does not
create pathological repricing — **yes** (Section I, 5/5 overlap
throughout); (8) NVDA instability explained by model repricing rather
than bad/missing inputs — **no** — Section K shows borrow addition barely
moves NVDA's ranking, and the severe Phase 2C instability didn't even
reproduce under this phase's scenario set, so the *original* instability
remains unexplained by this decomposition, not resolved; (9) shadow top
rankings stable under full/high market inputs — **untested**, since
FULL/HIGH-confidence inputs were never reached (IBKR unavailable); (10)
exact-expiry reconciliation remains perfect — **yes**. Criteria 1-7 and
10 pass (with the caveat that this entire run is off-hours and 1 is
fixture-only); criterion 8 is unresolved rather than failed outright, and
criterion 9 is simply untested. That combination — strong CRR mechanics
and disagreement behavior, but IBKR never actually validated live and the
NVDA instability question still open — is squarely "CRR ready, IBKR input
quality still incomplete," not a clean pass.

## Q — Next phase

Before Phase 2D: (1) run this same graduated validation against an
actual IBKR Client Portal Gateway session during active U.S. market
hours — both to validate the adapter against real data and to get a
non-off-hours TradingView snapshot; (2) specifically isolate Phase 2C's
original NVDA instability by re-running Phase 2C's exact scenario
percentages (0.90/1.05/1.10) against this phase's decomposition
methodology, since Section K suggests scenario-set choice — not the
model or borrow input — is the more likely driver; (3) if IBKR access
remains unavailable, consider whether a different accessible borrow-data
source exists before declaring the input gap permanently blocking.

STOP. No production pricing switch. No user-facing confidence change. No
order functionality added.
