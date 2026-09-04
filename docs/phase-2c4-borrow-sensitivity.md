# Phase 2C.4 — Active-Market Synthetic Borrow Sensitivity

Status: **diagnostic only, no production pricing switch.** This phase
continues after IBKR became impractical as an immediate dependency because
account activation requires funding. Synthetic fee rates are used only to
bound materiality; they are **not** live borrow data and do not satisfy
`FULL_EXTERNAL_INPUTS`.

New diagnostic script:
`scripts/phase2c4-borrow-sensitivity-live.mjs`

Raw evidence:
`docs/fixtures/phase2c4-borrow-sensitivity-20260902/phase2c4-borrow-sensitivity-live-20260902.json`

## A — Question

If real borrow data remains unavailable, how dangerous is that missing
input for CRR shadow rankings on the live chain?

This run compares CRR shadow rankings with no borrow fee against the same
CRR shadow pipeline using synthetic borrow fees:

| Tier | Fee rate |
|---|---:|
| 25BP | 0.25% |
| 75BP | 0.75% |
| 250BP | 2.50% |
| 1000BP | 10.00% |

## B — Session

Run window: **2026-09-02 19:22:36–19:23:46 UTC**, during the U.S. regular
session.

TradingView live chain/key-stats/quote collection succeeded. Treasury
input used the latest available 2026-09-01 Daily Treasury Bill Rates row.
IBKR was intentionally not required for this diagnostic.

## C — Coverage

| Symbol | Contracts | Candidates |
|---|---:|---:|
| NVDA | 217 | 66 |
| AAPL | 245 | 70 |
| PANW | 292 | 102 |

## D — STRESS_30D Results

Top-5 overlap compares no-borrow CRR shadow ranking vs synthetic-borrow
CRR shadow ranking.

| Symbol | Fee | Top-5 overlap | Mean abs P&L delta | Max abs P&L delta | Largest rank move |
|---|---:|---:|---:|---:|---:|
| NVDA | 25bp | 5/5 | 0.28 | 3 | 1 |
| NVDA | 75bp | 5/5 | 0.76 | 7 | 2 |
| NVDA | 250bp | 5/5 | 2.62 | 24 | 2 |
| NVDA | 1000bp | 5/5 | 8.20 | 63 | 5 |
| AAPL | 25bp | 5/5 | 0.40 | 4 | 1 |
| AAPL | 75bp | 5/5 | 0.97 | 10 | 2 |
| AAPL | 250bp | 5/5 | 3.36 | 34 | 4 |
| AAPL | 1000bp | 5/5 | 9.99 | 88 | 8 |
| PANW | 25bp | 5/5 | 0.35 | 3 | 1 |
| PANW | 75bp | 5/5 | 0.93 | 10 | 2 |
| PANW | 250bp | 4/5 | 2.93 | 33 | 2 |
| PANW | 1000bp | 4/5 | 9.57 | 94 | 4 |

## E — Phase 2C Original 30D Results

| Symbol | Fee | Top-5 overlap | Mean abs P&L delta | Max abs P&L delta | Largest rank move |
|---|---:|---:|---:|---:|---:|
| NVDA | 25bp | 5/5 | 0.34 | 3 | 2 |
| NVDA | 75bp | 5/5 | 0.90 | 7 | 2 |
| NVDA | 250bp | 5/5 | 2.98 | 24 | 4 |
| NVDA | 1000bp | 5/5 | 8.68 | 63 | 7 |
| AAPL | 25bp | 5/5 | 0.45 | 4 | 0 |
| AAPL | 75bp | 5/5 | 1.16 | 10 | 1 |
| AAPL | 250bp | 5/5 | 3.86 | 34 | 5 |
| AAPL | 1000bp | 5/5 | 10.62 | 88 | 9 |
| PANW | 25bp | 5/5 | 0.36 | 3 | 1 |
| PANW | 75bp | 5/5 | 1.06 | 10 | 2 |
| PANW | 250bp | 5/5 | 3.28 | 33 | 3 |
| PANW | 1000bp | 5/5 | 10.37 | 94 | 6 |

## F — Interpretation

The missing-borrow risk is bounded and smaller than the model-selection
effect seen in Phase 2C.2/2C.3:

- At 25bp and 75bp, all symbols and both scenario sets retained 5/5
  top-5 overlap.
- At 250bp, only PANW under symmetric `STRESS_30D` moved to 4/5 top-5
  overlap; original 30D remained 5/5.
- Even at a deliberately harsh 1000bp synthetic fee, NVDA and AAPL stayed
  5/5 under both scenario sets, and PANW only fell to 4/5 under
  symmetric `STRESS_30D`.
- Mean absolute strategy P&L deltas remained single-digit dollars even
  at 1000bp across these candidate sets.

This does not prove borrow is immaterial for every future symbol. It does
show that, for the current live NVDA/AAPL/PANW chains, missing borrow is
not the primary explanation for the top-5 ranking instability observed
across Phase 2C.2/2C.3.

## G — Product Implication

IBKR should no longer block the next research step. The safer path is:

1. keep borrow unavailable as explicit `null`
2. keep CRR shadow at `PARTIAL_EXTERNAL_INPUTS`
3. continue using synthetic borrow grids only as diagnostics
4. investigate provider alternatives separately
5. focus immediate migration research on warning-region hybrid behavior,
   not on forcing an IBKR dependency

## H — Verdict

**BORROW GAP IS REAL BUT NOT THE PRIMARY LIVE RANKING DRIVER**

Synthetic borrow sensitivity supports the Phase 2C.3 conclusion: ranking
movement is driven mainly by CRR-vs-local repricing in warning regions,
especially Base/Upside scenarios, not by modest missing borrow inputs.
Borrow still needs a real source before any `FULL_EXTERNAL_INPUTS` claim,
but lack of IBKR should not stop the next hybrid-model investigation.

STOP. No production pricing switch. No user-facing confidence change. No
order functionality added.
