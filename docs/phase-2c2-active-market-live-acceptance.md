# Phase 2C.2 — Active-Market CRR Live Acceptance Test

Status: **diagnostic only, no production pricing switch.** Live data
collection and shadow comparison were run by a separate agent (Codex,
per the user) during an active U.S. market session; this document folds
that result into the Phase 2C.2 report format and evaluates it against
the pre-registered Step 23 pass conditions. No code in this repository
was changed to produce this report — evidence copied verbatim into
`docs/fixtures/phase2c2-live-acceptance-20260902/` (summary `.md` and raw
`.json`, as collected).

## A — Session status

- **Active US market:** YES — run window 2026-09-02 18:00:38–18:01:46 UTC
  (~14:00–14:01 ET), a regular Wednesday trading session.
- **TradingView live:** PASS — connected; live quote, key-stats, and
  option-chain snapshots returned for all three symbols, chain
  completeness `COMPLETE` throughout.
- **IBKR gateway:** UNAVAILABLE — port 5000 occupied by a non-IBKR
  process; port 5001 unreachable; no IBKR/TWS/Client Portal install
  detected locally.
- **IBKR authentication:** not reached (no gateway to authenticate
  against).
- **IBKR market data:** UNKNOWN/unavailable for all three symbols —
  `fee_rate: null`, `expected_12m_dividend_per_share: null`,
  `market_data_availability: "UNKNOWN"`, `warnings: ["IBKR_UNAVAILABLE"]`
  — handled explicitly, not fabricated, consistent with the adapter's
  designed UNAVAILABLE path (Phase 2C.1).

## B — Live market inputs

| Symbol | Spot | Contracts | Candidates | Mode / Confidence | Dividend | Borrow |
|---|---:|---:|---:|---|---|---|
| NVDA | 224.655 | 218 | 66 | PARTIAL_EXTERNAL_INPUTS / LOW | TRAILING 0.1268% | UNAVAILABLE |
| AAPL | 325.83 | 244 | 66 | PARTIAL_EXTERNAL_INPUTS / LOW | TRAILING 0.3345% | UNAVAILABLE |
| PANW | 322.67 | 289 | 102 | PARTIAL_EXTERNAL_INPUTS / MEDIUM | ZERO_DIVIDEND_CONFIRMED | UNAVAILABLE |

Treasury: 2026-09-01 observation date (latest published row available at
run time), coupon-equivalent bill rates 3.75%–4.18% across the 4wk–52wk
ladder — same validated source/conversion as all prior phases.

**Data-quality note (not a pricing defect):** the raw JSON's
`shadow_snapshot_id` is identical (`c2c7b2651085a6d2`) across all three
symbols. `buildShadowSnapshotId` (Phase 2C.1) hashes whatever object it's
given — this indicates Codex's collection script likely passed a
symbol-independent object (e.g. run timestamp + Treasury data only) into
it rather than per-symbol normalized inputs, not a bug in the hashing
function itself. Doesn't affect any of the pricing/ranking numbers below,
but the id can't be used to distinguish these three runs from each other.

## C — 5-day results

| Symbol | Median | P75 | P95 | Max | PASS (≤10% / ≤15%) |
|---|---:|---:|---:|---:|---|
| NVDA | 2.03% | 2.79% | 4.00% | 5.37% | **PASS** |
| AAPL | 1.95% | 2.82% | 4.17% | 5.45% | **PASS** |
| PANW | 0.76% | 1.18% | 2.12% | 3.24% | **PASS** |

All three comfortably clear the frozen thresholds (median ≤10%, P95
≤15%) — consistent with, and even slightly better than, Phase 2C.1's
off-hours diagnostic numbers.

## D — 15-day results

| Symbol | Median | P75 | P95 | Max |
|---|---:|---:|---:|---:|
| NVDA | 4.48% | 7.88% | 13.41% | 18.24% |
| AAPL | 4.07% | 8.55% | 13.94% | 15.56% |
| PANW | 3.83% | 5.71% | 10.10% | 16.67% |

## E — 30-day results

| Symbol | Median | P75 | P95 | Max |
|---|---:|---:|---:|---:|
| NVDA (STRESS_30D symmetric) | 1.92% | 9.29% | 35.28% | 61.57% |
| NVDA (PHASE2C_ORIGINAL 30D) | 1.76% | 12.78% | 35.28% | 61.57% |
| AAPL (STRESS_30D) | 0.88% | 7.32% | 31.34% | 71.51% |
| AAPL (PHASE2C_ORIGINAL 30D) | 0.96% | 9.63% | 38.25% | 71.51% |
| PANW (STRESS_30D) | 1.58% | 12.69% | 28.33% | 45.51% |
| PANW (PHASE2C_ORIGINAL 30D) | 1.38% | 13.94% | 30.49% | 45.51% |

30-day medians stay low but the P95/max tails are large (up to 71.5% for
AAPL) — the same right-skewed pattern seen in every prior phase: most
candidates track closely, a minority (near-expiry, far-OTM, or
large-time-step cases) diverge sharply.

## F — Warning correlation

| Symbol | Warned mean | Unwarned mean | Ratio |
|---|---:|---:|---:|
| NVDA | 12.38% (n=280) | 2.48% (n=512) | 5.0x |
| AAPL | 9.56% (n=314) | 2.55% (n=478) | 3.8x |
| PANW | 12.60% (n=366) | 1.73% (n=858) | 7.3x |

**Clean pass, large samples.** Candidates already flagged by
`LOCAL_GREEK_APPROXIMATION` (`LARGE_TIME_STEP`/`NEAR_EXPIRATION`/
`LARGE_SPOT_MOVE`/`INTRINSIC_FLOOR_APPLIED`) show 3.8–7.3x higher
disagreement than unwarned ones, pooled across all three horizons. This
is the strongest, largest-sample confirmation of this relationship
across every phase so far.

**Gap:** the collected data pools warned/unwarned across all three
horizons together rather than breaking it out per-horizon (Step 13
wanted 5-day-only, no-warning median/P95 specifically). That finer cut
can't be reconstructed from the JSON as collected — flagged as an
incomplete capture, not a contradicting result.

## G — Original Phase 2C NVDA reproduction

**Original (Phase 2C) expected:** top-5 overlap 1/5, largest movement 33
ranks.
**Current observed (PHASE2C_ORIGINAL_30D, exact 0.90/1.05/1.10 set):**
**top-5 overlap 5/5**, largest move 44 ranks (`LONG_CALL::NVDA::2026-10-09::
C235.0`, rank 17→61 — outside the top 5, so it doesn't affect overlap).

**Phase 2C's original NVDA instability did not reproduce**, even using
the exact original thesis-shifted scenario set. Combined with Phase
2C.1's earlier finding (also non-reproducing, under the symmetric set),
NVDA now looks stable under both scenario definitions on two separate
occasions. The specific instability Phase 2C reported appears to have
been either session-specific (different live contracts/spreads that day)
or otherwise not a persistent property of NVDA — it is not explained by
scenario-set choice alone, since neither set reproduces it today.

## H — NVDA root-cause decomposition

**Not fully computable from the collected data.** Codex's JSON records
only the aggregate ranking summary (`top5_overlap`, one `largestMove`
entry) per scenario set — it does not retain per-candidate Base/Downside/
Upside P&L, breakeven, or warning-state detail needed to decompose *why*
a given candidate's rank moved (Step 9's explicit requirement). This
section cannot respond to Step 9 beyond what's in Section G above without
either re-deriving it from raw candidate data (not present in this
capture) or rerunning the comparison with per-candidate diagnostics
captured. Recommended as the top priority for the next run (Section Q).

## I — Symmetric vs thesis-shifted ranking

| Symbol | STRESS_30D (symmetric 0.90/1.00/1.10) | PHASE2C_ORIGINAL_30D (0.90/1.05/1.10) |
|---|---:|---:|
| NVDA | 5/5 | 5/5 |
| AAPL | **2/5** | 5/5 |
| PANW | 4/5 | 5/5 |

**This reverses Phase 2C.1's finding.** In Phase 2C.1 (off-hours,
different session), NVDA was the unstable symbol and only under the
thesis-shifted set. Today, live, NVDA is stable under *both* sets, while
**AAPL is unstable specifically under the symmetric STRESS_30D set**
(2/5) and stable under the thesis-shifted original set (5/5) — the
opposite pairing of symbol-to-scenario-sensitivity from what Phase 2C.1
suggested.

**Conclusion:** the evidence across three sessions (Phase 2C, 2C.1,
2C.2) does **not** support a stable classification of
`RANKING_SENSITIVE_TO_BASE_SCENARIO` tied to a specific symbol or a
specific scenario set. Instability appears to depend on which specific
candidates happen to sit near rank-5 boundary on a given day's live chain
(price/spread/strike distribution), not on a fixed symbol or scenario
property. This is a materially different, more cautious conclusion than
Phase 2C.1's "strongly suggests scenario-dependent, not model-broken" —
today's data shows the *same* symbol (NVDA) stable under a scenario set
that was previously implicated, while a *different* symbol (AAPL) now
shows the instability under the *other* set.

## J — Base-scenario score sensitivity

**Not computable from the collected data** — same gap as Section H;
`RANKING_MODEL_V1`'s component-score breakdown per candidate was not
captured in this run's JSON.

## K — Borrow materiality

**Not measured live** (IBKR unavailable — Step 3/16's live-fee-rate path
was never reached). No borrow ablation was rerun in this live session;
Phase 2C.1's off-hours **BORROW_STRESS_DIAGNOSTIC** finding (synthetic
75bp fee, 5/5 top-5 overlap, ~$1.4–2.2 mean P&L impact) is the most
recent evidence available, and it remains an off-hours diagnostic, not
live evidence, per Step 16's own labeling rule.

## L — Dividend materiality

**UNTESTED** — IBKR's forward-12m dividend field was unavailable, so no
live TradingView-trailing-yield-vs-IBKR-forward comparison could be run
this session (per Step 17's explicit fallback: state UNTESTED when
unavailable, don't assume).

## M — Hybrid model evidence

**HYBRID_MODEL_SUPPORTED_BY_EVIDENCE: YES** (directionally) — Sections
C/F together show LOCAL_GREEK_APPROXIMATION staying tight and low-
disagreement specifically in unwarned/local scenarios (5-day: 0.76–2.03%
median, 2.12–4.17% P95; unwarned pooled: 1.73–2.55% mean) while CRR
diverges specifically where warnings already fire (9.56–12.6% mean,
3.8–7.3x higher). This is genuine research evidence *for* the idea that
local-Greek is adequate in its safe region and a full repricer adds value
specifically in the regions it already flags itself as unreliable — but
per Step 15, no hybrid model is implemented; this is evidence, not an
implementation.

## N — Market input completeness

`PARTIAL_EXTERNAL_INPUTS` throughout, `LOW` confidence for NVDA/AAPL
(trailing-yield dividend), `MEDIUM` for PANW (documented zero-dividend).
No FULL_EXTERNAL_INPUTS or HIGH-confidence live result has yet been
observed in any phase — IBKR has never actually connected. Missing
borrow stayed explicit (`null` + `BORROW_DATA_UNAVAILABLE`) throughout;
never silently zeroed.

## O — Migration decision matrix

| Factor | Assessment |
|---|---|
| A) CRR numerical validity | Sound — no anomaly in the pricing math itself; only the shadow-snapshot-id hygiene issue (Section B), unrelated to pricing correctness |
| B) 5-day/local pricing agreement | **Pass** — all three symbols comfortably inside both thresholds |
| C) Warning-region divergence behavior | **Pass** — strong, large-sample, consistent across symbols |
| D) Ranking stability | **Fail this session for AAPL** (2/5 under STRESS_30D) — and the pattern of *which* symbol/scenario combination is unstable has now flipped twice across three sessions |
| E) Market-input completeness | Incomplete — PARTIAL_EXTERNAL_INPUTS only, IBKR never reached in any phase to date |
| F) Borrow materiality | Not measured live this session; prior off-hours diagnostic suggested immateriality but that evidence is now two phases old and not re-confirmed live |
| G) Dividend materiality | Untested |
| H) Exact-expiry reconciliation | Not re-verified in this live run specifically; continues to pass in the unit-test regression suite (unchanged since Phase 2C) |

## P — Verdict

**B) CRR VALID BUT MORE LIVE EVIDENCE REQUIRED**

Checking Step 23's nine conditions: 1 (active-market data), 2 (5-day
median), 3 (5-day P95), 4 (warning correlation), 7 (missing inputs
explicit), and 9 (no CRR numerical anomaly) all **pass**, several with
strong evidence. But condition 5 — "no unexplained pathological ranking
instability" — **fails**: AAPL's 2/5 top-5 overlap under STRESS_30D is a
real, unexplained instability (Section H/J's root-cause data wasn't
captured), and Section I shows the instability pattern itself is not
even consistent across sessions, which is a more concerning signal than
a single reproducible bad case would be. Condition 6 (exact-expiry
reconciliation) wasn't independently re-verified live this session.
Condition 8 (borrow sensitivity — live-measured or robustly demonstrated
immaterial) isn't satisfied by *this* session's evidence, only by an
older off-hours diagnostic. Three of nine conditions unmet or unverified
is not a migration-ready bar, but the core CRR mechanics and the
warning-correlation/5-day-agreement evidence keep strengthening across
every session — this is squarely "valid, needs more evidence," not "do
not migrate."

## Q — Next phase

1. **Capture per-candidate diagnostics** (Base/Downside/Upside P&L,
   breakeven, warning state, component scores) in the next live run so
   Steps 9 and 11 (the actual root-cause decomposition) can finally be
   answered — this is the single biggest gap blocking a real verdict on
   condition 5.
2. Get the IBKR Client Portal Gateway running and authenticated
   (user's stated next step) to finally test the FULL_EXTERNAL_INPUTS /
   HIGH-confidence regime (conditions 5/8/9's live-input half) that no
   phase has reached yet.
3. Re-verify exact-expiry reconciliation explicitly within a live
   session's data (not just the standing unit tests) for condition 6.
4. Run at least one more live session specifically to see whether the
   symbol/scenario-set instability pairing shifts a *third* time —
   Section I's finding (it flipped between Phase 2C.1 and 2C.2) needs a
   tie-breaker before drawing any conclusion about what actually drives
   it.

**No code changes were made in this session.** No branch would have been
required by Step 0's rule (no defect found) except that writing this
report itself is a repository change under normal project practice —
committed on `phase-2c2-active-market-acceptance`. Production pricing,
ranking weights, and confidence thresholds remain untouched.

STOP.
