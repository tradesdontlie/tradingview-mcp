# Phase 2C.3 — Active-Market Ranking Decomposition

Status: **diagnostic only, no production pricing switch.** This phase
continues from Phase 2C.2 after IBKR became impractical for the user in
the near term (account activation requires funding). The goal is to
remove the largest non-IBKR blocker from Phase 2C.2: lack of per-candidate
ranking/P&L/component-score diagnostics.

New diagnostic script:
`scripts/phase2c3-ranking-decomposition-live.mjs`

Raw evidence:
`docs/fixtures/phase2c3-ranking-decomposition-20260902/phase2c3-ranking-decomposition-live-20260902.json`

## A — Session

Run window: **2026-09-02 19:10:20–19:11:25 UTC**, during the U.S. regular
session.

TradingView live chain/key-stats/quote collection succeeded for NVDA,
AAPL, and PANW. IBKR remained `UNAVAILABLE`, so all borrow fields remained
explicitly missing (`null` + `BORROW_DATA_UNAVAILABLE`); no fee was
fabricated.

Treasury input used the latest available Daily Treasury Bill Rates row
from **2026-09-01**, matching Phase 2C.2.

## B — Capture Improvement

Phase 2C.2 captured only aggregate ranking summaries. Phase 2C.3 now
captures, for every candidate under both scenario sets:

- local rank vs CRR shadow rank
- local score vs shadow score
- component-score deltas
- Down/Base/Up P&L for local and shadow
- per-scenario disagreement percentage and level
- local/shadow warnings
- leg-level local decomposition and CRR leg outputs
- top-5 entry/exit boundary candidates

The `shadow_snapshot_id` hygiene issue from Phase 2C.2 is fixed in this
diagnostic capture: ids are now symbol-specific:

| Symbol | Snapshot ID |
|---|---|
| NVDA | `94b3aa178ddb485e` |
| AAPL | `dbb97c0287d5ed07` |
| PANW | `c2aaa121ac64f4b3` |

## C — Coverage

| Symbol | Contracts | Candidates | IBKR | STRESS_30D top-5 | Phase 2C original 30D top-5 |
|---|---:|---:|---|---:|---:|
| NVDA | 216 | 66 | UNAVAILABLE | 5/5 | 5/5 |
| AAPL | 247 | 70 | UNAVAILABLE | 5/5 | 4/5 |
| PANW | 288 | 98 | UNAVAILABLE | 5/5 | 5/5 |

This run did **not** reproduce Phase 2C.2's AAPL `2/5` STRESS_30D
instability. AAPL still had a boundary movement under the Phase 2C
original scenario set (`4/5`), but the severe same-set instability from
the earlier run did not persist.

## D — AAPL Top-5 Boundary Decomposition

Under `PHASE2C_ORIGINAL_30D`, one candidate entered the CRR top 5 and one
left:

| Movement | Candidate | Local rank | Shadow rank |
|---|---|---:|---:|
| Left top 5 | `BULL_CALL_SPREAD::AAPL::2026-10-02::C325/C340` | 5 | 6 |
| Entered top 5 | `BULL_CALL_SPREAD::AAPL::2026-10-09::C335/C345` | 27 | 5 |

The leaving candidate moved only one rank and had identical local/shadow
scores. The actual driver was the entering `2026-10-09 C335/C345` spread:

| Metric | Local | CRR shadow | Delta |
|---|---:|---:|---:|
| Score | 56.19 | 64.86 | +8.67 |
| Base P&L | 156 | 253 | +97 |
| Upside P&L | 217 | 305 | +88 |
| Base disagreement | 31.29% | | |
| Upside disagreement | 60.69% | | |

Component-score deltas for that candidate:

| Component | Delta |
|---|---:|
| Base | +15.65 |
| Downside | 0.00 |
| Upside | +15.97 |
| Breakeven | 0.00 |
| Execution | 0.00 |

So the rank movement is not explained by execution score, spread width,
breakeven, missing data, or a scoring bug. It is explained by CRR
repricing the longer-dated vertical spread more favorably than
`LOCAL_GREEK_APPROXIMATION` in the Base/Upside scenarios. Both local legs
carried `LARGE_TIME_STEP`; the CRR legs carried the expected
`CONSTANT_CONTRACT_IV_SHIFT`.

## E — Largest AAPL Moves

The largest AAPL moves were outside the top-5 boundary but are useful
diagnostics:

| Scenario set | Candidate | Local rank | Shadow rank | Driver |
|---|---|---:|---:|---|
| STRESS_30D | `2026-10-09 C335/C340` spread | 15 | 49 | Base score −15.14 |
| STRESS_30D | `2026-10-09 C330/C340` spread | 7 | 40 | Base score −11.76 |
| STRESS_30D | `2026-10-16 C315/C320` spread | 40 | 8 | Downside/Base P&L improved |
| Original 30D | `2026-10-09 C340` long call | 14 | 55 | Base score −21.90 |
| Original 30D | `2026-10-09 C340/C345` spread | 41 | 14 | Base/Upside scores improved |
| Original 30D | `2026-10-09 C335` long call | 13 | 38 | Base score −11.66 |

The pattern is consistent: large rank moves concentrate in candidates
where `LOCAL_GREEK_APPROXIMATION` itself flags `LARGE_TIME_STEP`, and the
ranking changes come from Base/Upside scenario P&L differences rather
than from execution or data-quality components.

## F — NVDA/PANW Check

NVDA remained top-5 stable under both scenario sets. Its largest original
30D move was a `2026-10-09 C235` long call moving rank 20→61, driven by a
Base P&L delta of −193 and Base component score delta of −17.87. This is
large but outside the top 5.

PANW remained top-5 stable under both scenario sets. Its largest moves
were vertical spreads around the 2026-10-09/2026-10-16 expirations, mostly
driven by Base/Upside score improvements under CRR shadow.

## G — Interpretation

Phase 2C.3 changes the ranking-instability story:

- Phase 2C.2's aggregate data made AAPL look like a severe top-5
  instability case under `STRESS_30D`.
- Phase 2C.3, minutes later with per-candidate data, showed AAPL
  `STRESS_30D` top-5 stability (`5/5`) and only a mild original-30D
  boundary change (`4/5`).
- The boundary change is now explainable: it was a Base/Upside repricing
  effect in candidates that already had `LARGE_TIME_STEP` warnings.

This supports the hybrid-model thesis more than a blanket migration:
`LOCAL_GREEK_APPROXIMATION` is acceptable in its safe region, while CRR
adds diagnostic value exactly where local approximation warnings fire.
But the top-5 boundary can still shift when candidates cluster near the
cutoff, so production migration should not happen until the product
decision is explicit about how to handle warning-region repricing.

## H — IBKR Path

IBKR is no longer a practical immediate dependency because the user's
account cannot activate without funding. Treat IBKR as one optional
future provider, not the only path.

Next input-source work should evaluate accessible alternatives for
borrow/shortability data:

- broker/provider APIs already available to the user
- paid securities-lending or hard-to-borrow datasets
- delayed/manual hard-to-borrow flags as diagnostics only
- symbol-level proxy rules only if they are explicitly labeled
  non-authoritative and never promoted to `FULL_EXTERNAL_INPUTS`

Until a real borrow source exists, keep CRR shadow inputs at
`PARTIAL_EXTERNAL_INPUTS` and keep missing borrow explicit.

## I — Verdict

**B) CRR VALID, HYBRID PATH FAVORED, BORROW SOURCE STILL OPEN**

Phase 2C.3 closes the per-candidate evidence gap from Phase 2C.2. The
observed AAPL rank movement is explainable and localized to warning-region
Base/Upside repricing, not an unexplained ranking bug. That improves
confidence in the CRR shadow machinery, but it does not justify a full
production pricing switch while borrow inputs remain unavailable and
warning-region product semantics are unresolved.

STOP. No production pricing switch. No user-facing confidence change. No
order functionality added.
