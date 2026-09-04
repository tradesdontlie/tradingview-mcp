# Phase 2C.2 Active-Market Live Acceptance Summary

Run window: 2026-09-02 18:00:38-18:01:46 UTC / 21:00:38-21:01:46 TSİ.
Status: DIAGNOSTIC_ONLY_NO_PRODUCTION_SWITCH.

## Verdict

PARTIAL PASS: TradingView active-market live chain + CRR shadow comparison ran successfully, but full live acceptance is not complete because IBKR market inputs were unavailable.

Do not switch production pricing. Do not change user-facing confidence. Do not add order functionality.

## Data Sources

- TradingView Desktop/CDP: connected and returned live quote, key-stats, and option-chain snapshots.
- Treasury bill rates: latest published row used, 2026-09-01.
- IBKR Client Portal Gateway: unavailable. Port 5000 was occupied by a non-IBKR process; no IBKR/TWS/Client Portal process or app install was detected locally. Port 5001 was not reachable.

## Live Snapshot Coverage

| Symbol | Spot/Key Price | Returned Contracts | Candidates | Chain Completeness | IBKR |
|---|---:|---:|---:|---|---|
| NASDAQ:NVDA | 224.655 | 218 | 66 | COMPLETE | UNAVAILABLE |
| NASDAQ:AAPL | 325.83 | 244 | 66 | COMPLETE | UNAVAILABLE |
| NASDAQ:PANW | 322.67 | 289 | 102 | COMPLETE | UNAVAILABLE |

## Market Inputs

| Symbol | Mode / Confidence | Dividend Input | Borrow Input |
|---|---|---|---|
| NVDA | PARTIAL_EXTERNAL_INPUTS / LOW | TradingView trailing yield 0.1268% | Unavailable |
| AAPL | PARTIAL_EXTERNAL_INPUTS / LOW | TradingView trailing yield 0.3345% | Unavailable |
| PANW | PARTIAL_EXTERNAL_INPUTS / MEDIUM | ZERO_DIVIDEND_CONFIRMED | Unavailable |

## CRR Shadow Disagreement

Disagreement is percent of max risk.

| Symbol | 5D Median / P95 | 15D Median / P95 | 30D Median / P95 / Max |
|---|---:|---:|---:|
| NVDA | 2.03 / 4.00 | 4.48 / 13.41 | 1.92 / 35.28 / 61.57 |
| AAPL | 1.95 / 4.17 | 4.07 / 13.94 | 0.88 / 31.34 / 71.51 |
| PANW | 0.76 / 2.12 | 3.83 / 10.10 | 1.58 / 28.33 / 45.51 |

## Warning Correlation

| Symbol | Warned Mean | Unwarned Mean |
|---|---:|---:|
| NVDA | 12.38 | 2.48 |
| AAPL | 9.56 | 2.55 |
| PANW | 12.60 | 1.73 |

The expected relationship held: candidates already warning under LOCAL_GREEK_APPROXIMATION had materially higher CRR-vs-local disagreement.

## Ranking Stability

| Symbol | STRESS_30D Top-5 Overlap | Phase 2C Original 30D Top-5 Overlap |
|---|---:|---:|
| NVDA | 5/5 | 5/5 |
| AAPL | 2/5 | 5/5 |
| PANW | 4/5 | 5/5 |

AAPL remains the main active-market instability flag under the symmetric STRESS_30D scenario set.

## Acceptance Criteria

- Active-market TradingView live data: PASS.
- CRR shadow execution on live chains: PASS.
- Missing borrow is explicit, not silently zero: PASS.
- Low/local 5D disagreement bounds: PASS.
- Warning correlation: PASS.
- Top-5 ranking stability: MIXED. AAPL STRESS_30D was 2/5.
- FULL/HIGH market-input regime with IBKR borrow/forward dividend: NOT TESTED, blocked by IBKR unavailable.

## Next Step

Start and authenticate IBKR Client Portal Gateway, then rerun this exact test. Until IBKR returns fee-rate/shortable/forward-dividend data, Phase 2C.2 cannot be marked as a full acceptance pass.

Raw output: phase2c2-live-acceptance-2026-09-02.json
