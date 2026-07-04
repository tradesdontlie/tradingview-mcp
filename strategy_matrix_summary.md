# Strategy Comparison Matrix

_Generated 2026-06-12T10:16:43.096Z • symbols BTCUSDT, ETHUSDT, BNBUSDT • timeframes 1m, 5m, 15m, 1h, 4h, 1d • ~6 months • neutral both-directions simulation, pooled across symbols._

**Metrics:** win% and trades count resolved trades only (open trades excluded). R = realized move ÷ risk distance. Profit factor = Σ(+R)/Σ(|−R|). Max drawdown = deepest peak-to-trough of the time-ordered cumulative-R curve (portfolio-style across the 3 symbols). Net R = total R booked.

**Caveats:** Single-timeframe — every strategy is run on each TF in isolation (no 4H/daily mixing like the live bot). The curriculum scopes RSI divergence to ≥4H and CVD to short-term, so their sub-15m rows are out-of-spec by design; rank with the trade count in mind. Low-trade rows (<20) are statistically noisy.


## Step 1 — Individual Strategies (ranked by win%)

### Headline — min 20 trades

| Rank | Strategy / Combo | TF | Win% | Trades | PF | MaxDD (R) | Net R | Avg R |
|---|---|---|---|---|---|---|---|---|
| 1 | market_structure | 15m | 89.2 | 65 | 2.14 | 2.20 | 7.99 | 0.12 |
| 2 | market_structure | 1m | 86.6 | 1376 | 2.11 | 4.37 | 205.12 | 0.15 |
| 3 | market_structure | 5m | 86.2 | 218 | 1.63 | 4.66 | 18.93 | 0.09 |
| 4 | market_structure | 1h | 70.8 | 24 | 0.50 | 4.66 | -3.52 | -0.15 |
| 5 | divergence | 1m | 47.4 | 35772 | 785.72 | 26.00 | 14753535.56 | 412.43 |
| 6 | pinbar | 1m | 46.5 | 21348 | 1.53 | 75.54 | 6000.40 | 0.28 |
| 7 | divergence | 5m | 46.2 | 5698 | 901.93 | 17.00 | 2763156.69 | 484.93 |
| 8 | cvd_divergence | 1m | 45.3 | 45501 | 820.19 | 18.00 | 20402796.31 | 448.40 |
| 9 | pinbar | 1h | 44.5 | 348 | 1.50 | 29.57 | 96.42 | 0.28 |
| 10 | pinbar | 15m | 44.2 | 1290 | 1.40 | 47.02 | 285.98 | 0.22 |
| 11 | cvd_divergence | 5m | 44.0 | 9340 | 701.82 | 15.90 | 3665268.26 | 392.43 |
| 12 | pinbar | 5m | 43.5 | 4543 | 1.24 | 63.78 | 616.89 | 0.14 |
| 13 | cvd_divergence | 1h | 43.2 | 718 | 21.90 | 9.00 | 8529.20 | 11.88 |
| 14 | fibonacci | 4h | 42.9 | 296 | 2.19 | 15.91 | 201.48 | 0.68 |
| 15 | divergence | 1h | 42.5 | 327 | 15.30 | 13.00 | 2688.17 | 8.22 |
| 16 | divergence | 15m | 42.5 | 1679 | 851.59 | 18.00 | 821674.40 | 489.38 |
| 17 | cvd_divergence | 15m | 42.3 | 3098 | 461.67 | 12.00 | 822759.48 | 265.58 |
| 18 | fibonacci | 1m | 41.8 | 71696 | 1.75 | 60.27 | 31442.03 | 0.44 |
| 19 | fibonacci | 5m | 39.5 | 18877 | 1.53 | 59.17 | 6000.77 | 0.32 |
| 20 | fibonacci | 1h | 39.3 | 1774 | 1.43 | 32.90 | 458.61 | 0.26 |
| 21 | fibonacci | 15m | 38.7 | 7095 | 1.48 | 58.05 | 2072.75 | 0.29 |
| 22 | sfp | 1m | 35.8 | 61320 | 1.77 | 66.84 | 30333.16 | 0.49 |
| 23 | sfp | 1h | 34.9 | 1256 | 1.96 | 44.18 | 786.55 | 0.63 |
| 24 | divergence | 4h | 34.7 | 49 | 11.96 | 9.00 | 350.71 | 7.16 |
| 25 | sfp | 5m | 34.5 | 14888 | 1.71 | 62.39 | 6958.83 | 0.47 |
| 26 | sfp | 15m | 34.1 | 5236 | 1.61 | 42.59 | 2115.00 | 0.40 |
| 27 | pinbar | 4h | 32.4 | 37 | 0.45 | 20.66 | -13.66 | -0.37 |
| 28 | sfp | 4h | 31.8 | 277 | 1.98 | 26.44 | 185.57 | 0.67 |
| 29 | cvd_divergence | 4h | 30.6 | 134 | 7.70 | 11.00 | 623.09 | 4.65 |


<details><summary>Full table (all 35 rows, any trade count)</summary>


| Rank | Strategy / Combo | TF | Win% | Trades | PF | MaxDD (R) | Net R | Avg R |
|---|---|---|---|---|---|---|---|---|
| 1 | divergence | 1d | 100.0 | 1 | ∞ | 0.00 | 11.25 | 11.25 |
| 2 | market_structure | 15m | 89.2 | 65 | 2.14 | 2.20 | 7.99 | 0.12 |
| 3 | market_structure | 1m | 86.6 | 1376 | 2.11 | 4.37 | 205.12 | 0.15 |
| 4 | market_structure | 5m | 86.2 | 218 | 1.63 | 4.66 | 18.93 | 0.09 |
| 5 | market_structure | 1h | 70.8 | 24 | 0.50 | 4.66 | -3.52 | -0.15 |
| 6 | market_structure | 4h | 66.7 | 6 | 0.36 | 1.72 | -1.28 | -0.21 |
| 7 | fibonacci | 1d | 53.3 | 15 | 2.06 | 4.00 | 7.39 | 0.49 |
| 8 | divergence | 1m | 47.4 | 35772 | 785.72 | 26.00 | 14753535.56 | 412.43 |
| 9 | pinbar | 1m | 46.5 | 21348 | 1.53 | 75.54 | 6000.40 | 0.28 |
| 10 | divergence | 5m | 46.2 | 5698 | 901.93 | 17.00 | 2763156.69 | 484.93 |
| 11 | cvd_divergence | 1m | 45.3 | 45501 | 820.19 | 18.00 | 20402796.31 | 448.40 |
| 12 | pinbar | 1h | 44.5 | 348 | 1.50 | 29.57 | 96.42 | 0.28 |
| 13 | pinbar | 15m | 44.2 | 1290 | 1.40 | 47.02 | 285.98 | 0.22 |
| 14 | cvd_divergence | 5m | 44.0 | 9340 | 701.82 | 15.90 | 3665268.26 | 392.43 |
| 15 | pinbar | 5m | 43.5 | 4543 | 1.24 | 63.78 | 616.89 | 0.14 |
| 16 | cvd_divergence | 1h | 43.2 | 718 | 21.90 | 9.00 | 8529.20 | 11.88 |
| 17 | fibonacci | 4h | 42.9 | 296 | 2.19 | 15.91 | 201.48 | 0.68 |
| 18 | divergence | 1h | 42.5 | 327 | 15.30 | 13.00 | 2688.17 | 8.22 |
| 19 | divergence | 15m | 42.5 | 1679 | 851.59 | 18.00 | 821674.40 | 489.38 |
| 20 | cvd_divergence | 15m | 42.3 | 3098 | 461.67 | 12.00 | 822759.48 | 265.58 |
| 21 | fibonacci | 1m | 41.8 | 71696 | 1.75 | 60.27 | 31442.03 | 0.44 |
| 22 | fibonacci | 5m | 39.5 | 18877 | 1.53 | 59.17 | 6000.77 | 0.32 |
| 23 | fibonacci | 1h | 39.3 | 1774 | 1.43 | 32.90 | 458.61 | 0.26 |
| 24 | fibonacci | 15m | 38.7 | 7095 | 1.48 | 58.05 | 2072.75 | 0.29 |
| 25 | sfp | 1m | 35.8 | 61320 | 1.77 | 66.84 | 30333.16 | 0.49 |
| 26 | sfp | 1h | 34.9 | 1256 | 1.96 | 44.18 | 786.55 | 0.63 |
| 27 | divergence | 4h | 34.7 | 49 | 11.96 | 9.00 | 350.71 | 7.16 |
| 28 | sfp | 5m | 34.5 | 14888 | 1.71 | 62.39 | 6958.83 | 0.47 |
| 29 | sfp | 15m | 34.1 | 5236 | 1.61 | 42.59 | 2115.00 | 0.40 |
| 30 | pinbar | 1d | 33.3 | 3 | 1.16 | 2.00 | 0.32 | 0.11 |
| 31 | pinbar | 4h | 32.4 | 37 | 0.45 | 20.66 | -13.66 | -0.37 |
| 32 | sfp | 4h | 31.8 | 277 | 1.98 | 26.44 | 185.57 | 0.67 |
| 33 | cvd_divergence | 4h | 30.6 | 134 | 7.70 | 11.00 | 623.09 | 4.65 |
| 34 | cvd_divergence | 1d | 28.6 | 7 | 3.64 | 5.00 | 13.21 | 1.89 |
| 35 | sfp | 1d | 20.0 | 15 | 0.54 | 11.00 | -5.57 | -0.37 |
</details>


## Step 2 — Paired Strategies (ranked by win%)

### Headline — min 20 trades

| Rank | Strategy / Combo | TF | Win% | Trades | PF | MaxDD (R) | Net R | Avg R |
|---|---|---|---|---|---|---|---|---|
| 1 | sfp+market_structure | 15m | 91.4 | 35 | 2.01 | 1.00 | 3.02 | 0.09 |
| 2 | cvd_divergence+market_structure | 1m | 90.6 | 170 | 3.77 | 2.00 | 44.25 | 0.26 |
| 3 | divergence+market_structure | 1m | 88.3 | 103 | 3.78 | 2.96 | 33.36 | 0.32 |
| 4 | sfp+market_structure | 5m | 88.3 | 111 | 2.10 | 4.73 | 14.35 | 0.13 |
| 5 | sfp+market_structure | 1m | 87.2 | 674 | 2.50 | 5.00 | 129.23 | 0.19 |
| 6 | fibonacci+market_structure | 15m | 86.8 | 53 | 1.89 | 2.93 | 6.24 | 0.12 |
| 7 | fibonacci+market_structure | 1m | 85.5 | 897 | 2.04 | 7.02 | 134.78 | 0.15 |
| 8 | market_structure+pinbar | 1m | 84.4 | 77 | 1.67 | 3.88 | 8.01 | 0.10 |
| 9 | fibonacci+market_structure | 5m | 82.8 | 128 | 1.34 | 5.24 | 7.53 | 0.06 |
| 10 | divergence+pinbar | 15m | 56.6 | 53 | 2.89 | 6.53 | 43.49 | 0.82 |
| 11 | sfp+fibonacci | 4h | 55.6 | 54 | 2.46 | 12.29 | 35.05 | 0.65 |
| 12 | divergence+fibonacci | 5m | 53.8 | 1933 | 1.96 | 15.91 | 861.88 | 0.45 |
| 13 | divergence+fibonacci | 1m | 53.4 | 11977 | 2.04 | 22.60 | 5783.36 | 0.48 |
| 14 | divergence+pinbar | 5m | 52.5 | 204 | 2.97 | 6.74 | 191.45 | 0.94 |
| 15 | cvd_divergence+pinbar | 1h | 52.4 | 21 | 4.82 | 3.00 | 38.19 | 1.82 |
| 16 | cvd_divergence+fibonacci | 5m | 52.3 | 2859 | 1.86 | 23.32 | 1169.11 | 0.41 |
| 17 | cvd_divergence+fibonacci | 1m | 51.4 | 14788 | 2.04 | 21.59 | 7480.48 | 0.51 |
| 18 | cvd_divergence+fibonacci | 15m | 51.4 | 925 | 1.91 | 16.67 | 407.42 | 0.44 |
| 19 | sfp+fibonacci | 1m | 50.4 | 19194 | 1.30 | 51.81 | 2850.34 | 0.15 |
| 20 | divergence+fibonacci | 15m | 50.1 | 507 | 1.93 | 11.18 | 236.47 | 0.47 |
| 21 | divergence+fibonacci | 1h | 49.5 | 99 | 1.14 | 9.87 | 6.97 | 0.07 |
| 22 | cvd_divergence+fibonacci | 1h | 49.2 | 185 | 1.52 | 8.95 | 48.70 | 0.26 |
| 23 | sfp+fibonacci | 5m | 48.8 | 4506 | 1.43 | 32.60 | 1002.73 | 0.22 |
| 24 | divergence+pinbar | 1m | 48.7 | 1094 | 9.90 | 14.89 | 4992.70 | 4.56 |
| 25 | cvd_divergence+pinbar | 1m | 48.6 | 1532 | 7.70 | 20.20 | 5282.61 | 3.45 |
| 26 | divergence+cvd_divergence | 1m | 48.4 | 19318 | 832.73 | 18.81 | 8287367.35 | 429.00 |
| 27 | cvd_divergence+pinbar | 5m | 48.4 | 312 | 2.26 | 11.08 | 202.47 | 0.65 |
| 28 | cvd_divergence+pinbar | 15m | 47.8 | 69 | 2.69 | 6.00 | 60.69 | 0.88 |
| 29 | sfp+fibonacci | 1h | 47.5 | 396 | 1.29 | 26.17 | 60.39 | 0.15 |
| 30 | fibonacci+pinbar | 1m | 47.1 | 2874 | 1.35 | 66.30 | 529.29 | 0.18 |
| 31 | divergence+cvd_divergence | 5m | 46.7 | 3047 | 975.62 | 13.00 | 1581803.79 | 519.13 |
| 32 | sfp+fibonacci | 15m | 46.5 | 1754 | 1.34 | 31.23 | 314.25 | 0.18 |
| 33 | sfp+pinbar | 1h | 45.3 | 53 | 3.64 | 8.00 | 76.47 | 1.44 |
| 34 | sfp+divergence | 15m | 44.9 | 479 | 2.16 | 11.25 | 305.53 | 0.64 |
| 35 | divergence+cvd_divergence | 1h | 44.5 | 173 | 16.78 | 7.00 | 1515.11 | 8.76 |
| 36 | sfp+cvd_divergence | 15m | 44.4 | 952 | 2.08 | 13.00 | 569.83 | 0.60 |
| 37 | sfp+divergence | 5m | 44.3 | 1433 | 2.24 | 20.44 | 992.95 | 0.69 |
| 38 | cvd_divergence+fibonacci | 4h | 44.0 | 25 | 1.96 | 5.00 | 13.50 | 0.54 |
| 39 | sfp+cvd_divergence | 1m | 43.9 | 13879 | 2.28 | 30.21 | 9959.72 | 0.72 |
| 40 | sfp+divergence | 1m | 43.8 | 8238 | 2.43 | 27.49 | 6607.64 | 0.80 |
| 41 | fibonacci+pinbar | 5m | 43.8 | 683 | 1.20 | 47.49 | 75.86 | 0.11 |
| 42 | fibonacci+pinbar | 15m | 43.6 | 195 | 1.33 | 15.97 | 35.80 | 0.18 |
| 43 | sfp+cvd_divergence | 5m | 43.2 | 2825 | 2.00 | 19.79 | 1603.96 | 0.57 |
| 44 | divergence+cvd_divergence | 15m | 42.5 | 898 | 1107.99 | 11.00 | 571208.81 | 636.09 |
| 45 | sfp+divergence | 1h | 41.9 | 105 | 2.04 | 12.00 | 63.74 | 0.61 |
| 46 | sfp+cvd_divergence | 1h | 41.9 | 215 | 1.89 | 13.00 | 111.60 | 0.52 |
| 47 | sfp+pinbar | 1m | 41.4 | 3286 | 1.51 | 47.04 | 976.25 | 0.30 |
| 48 | sfp+pinbar | 5m | 36.7 | 681 | 1.12 | 45.54 | 53.56 | 0.08 |
| 49 | divergence+cvd_divergence | 4h | 36.0 | 25 | 17.20 | 7.00 | 259.25 | 10.37 |
| 50 | fibonacci+pinbar | 1h | 35.3 | 51 | 0.57 | 26.43 | -14.35 | -0.28 |
| 51 | sfp+pinbar | 15m | 33.0 | 212 | 0.87 | 33.28 | -18.29 | -0.09 |
| 52 | sfp+cvd_divergence | 4h | 31.7 | 41 | 1.80 | 8.51 | 22.51 | 0.55 |
| 53 | sfp+divergence | 4h | 22.7 | 22 | 1.25 | 9.00 | 4.21 | 0.19 |


<details><summary>Full table (all 78 rows, any trade count)</summary>


| Rank | Strategy / Combo | TF | Win% | Trades | PF | MaxDD (R) | Net R | Avg R |
|---|---|---|---|---|---|---|---|---|
| 1 | market_structure+pinbar | 5m | 100.0 | 14 | ∞ | 0.00 | 4.04 | 0.29 |
| 2 | cvd_divergence+market_structure | 15m | 100.0 | 6 | ∞ | 0.00 | 0.57 | 0.10 |
| 3 | fibonacci+market_structure | 4h | 100.0 | 3 | ∞ | 0.00 | 0.81 | 0.27 |
| 4 | sfp+market_structure | 4h | 100.0 | 2 | ∞ | 0.00 | 0.45 | 0.23 |
| 5 | market_structure+pinbar | 4h | 100.0 | 2 | ∞ | 0.00 | 0.04 | 0.02 |
| 6 | divergence+fibonacci | 1d | 100.0 | 1 | ∞ | 0.00 | 1.03 | 1.03 |
| 7 | divergence+market_structure | 4h | 100.0 | 1 | ∞ | 0.00 | 0.15 | 0.15 |
| 8 | divergence+pinbar | 1d | 100.0 | 1 | ∞ | 0.00 | 2.32 | 2.32 |
| 9 | cvd_divergence+market_structure | 4h | 100.0 | 1 | ∞ | 0.00 | 0.15 | 0.15 |
| 10 | fibonacci+pinbar | 1d | 100.0 | 1 | ∞ | 0.00 | 1.03 | 1.03 |
| 11 | market_structure+pinbar | 15m | 100.0 | 1 | ∞ | 0.00 | 0.10 | 0.10 |
| 12 | sfp+market_structure | 15m | 91.4 | 35 | 2.01 | 1.00 | 3.02 | 0.09 |
| 13 | cvd_divergence+market_structure | 1m | 90.6 | 170 | 3.77 | 2.00 | 44.25 | 0.26 |
| 14 | divergence+market_structure | 5m | 88.9 | 9 | 2.00 | 1.00 | 1.00 | 0.11 |
| 15 | divergence+market_structure | 1m | 88.3 | 103 | 3.78 | 2.96 | 33.36 | 0.32 |
| 16 | sfp+market_structure | 5m | 88.3 | 111 | 2.10 | 4.73 | 14.35 | 0.13 |
| 17 | sfp+market_structure | 1m | 87.2 | 674 | 2.50 | 5.00 | 129.23 | 0.19 |
| 18 | fibonacci+market_structure | 15m | 86.8 | 53 | 1.89 | 2.93 | 6.24 | 0.12 |
| 19 | fibonacci+market_structure | 1m | 85.5 | 897 | 2.04 | 7.02 | 134.78 | 0.15 |
| 20 | market_structure+pinbar | 1m | 84.4 | 77 | 1.67 | 3.88 | 8.01 | 0.10 |
| 21 | fibonacci+market_structure | 5m | 82.8 | 128 | 1.34 | 5.24 | 7.53 | 0.06 |
| 22 | cvd_divergence+market_structure | 5m | 76.5 | 17 | 0.91 | 2.21 | -0.34 | -0.02 |
| 23 | sfp+market_structure | 1h | 66.7 | 12 | 0.43 | 2.59 | -2.28 | -0.19 |
| 24 | fibonacci+market_structure | 1h | 66.7 | 12 | 0.40 | 3.17 | -2.40 | -0.20 |
| 25 | divergence+pinbar | 15m | 56.6 | 53 | 2.89 | 6.53 | 43.49 | 0.82 |
| 26 | sfp+fibonacci | 4h | 55.6 | 54 | 2.46 | 12.29 | 35.05 | 0.65 |
| 27 | divergence+fibonacci | 4h | 54.5 | 11 | 3.10 | 2.00 | 10.48 | 0.95 |
| 28 | divergence+fibonacci | 5m | 53.8 | 1933 | 1.96 | 15.91 | 861.88 | 0.45 |
| 29 | divergence+fibonacci | 1m | 53.4 | 11977 | 2.04 | 22.60 | 5783.36 | 0.48 |
| 30 | divergence+pinbar | 5m | 52.5 | 204 | 2.97 | 6.74 | 191.45 | 0.94 |
| 31 | cvd_divergence+pinbar | 1h | 52.4 | 21 | 4.82 | 3.00 | 38.19 | 1.82 |
| 32 | cvd_divergence+fibonacci | 5m | 52.3 | 2859 | 1.86 | 23.32 | 1169.11 | 0.41 |
| 33 | cvd_divergence+fibonacci | 1m | 51.4 | 14788 | 2.04 | 21.59 | 7480.48 | 0.51 |
| 34 | cvd_divergence+fibonacci | 15m | 51.4 | 925 | 1.91 | 16.67 | 407.42 | 0.44 |
| 35 | sfp+fibonacci | 1m | 50.4 | 19194 | 1.30 | 51.81 | 2850.34 | 0.15 |
| 36 | divergence+fibonacci | 15m | 50.1 | 507 | 1.93 | 11.18 | 236.47 | 0.47 |
| 37 | cvd_divergence+market_structure | 1h | 50.0 | 4 | 0.12 | 2.00 | -1.76 | -0.44 |
| 38 | divergence+fibonacci | 1h | 49.5 | 99 | 1.14 | 9.87 | 6.97 | 0.07 |
| 39 | cvd_divergence+fibonacci | 1h | 49.2 | 185 | 1.52 | 8.95 | 48.70 | 0.26 |
| 40 | sfp+fibonacci | 5m | 48.8 | 4506 | 1.43 | 32.60 | 1002.73 | 0.22 |
| 41 | divergence+pinbar | 1m | 48.7 | 1094 | 9.90 | 14.89 | 4992.70 | 4.56 |
| 42 | cvd_divergence+pinbar | 1m | 48.6 | 1532 | 7.70 | 20.20 | 5282.61 | 3.45 |
| 43 | divergence+cvd_divergence | 1m | 48.4 | 19318 | 832.73 | 18.81 | 8287367.35 | 429.00 |
| 44 | cvd_divergence+pinbar | 5m | 48.4 | 312 | 2.26 | 11.08 | 202.47 | 0.65 |
| 45 | cvd_divergence+pinbar | 15m | 47.8 | 69 | 2.69 | 6.00 | 60.69 | 0.88 |
| 46 | sfp+fibonacci | 1h | 47.5 | 396 | 1.29 | 26.17 | 60.39 | 0.15 |
| 47 | fibonacci+pinbar | 1m | 47.1 | 2874 | 1.35 | 66.30 | 529.29 | 0.18 |
| 48 | divergence+cvd_divergence | 5m | 46.7 | 3047 | 975.62 | 13.00 | 1581803.79 | 519.13 |
| 49 | sfp+fibonacci | 15m | 46.5 | 1754 | 1.34 | 31.23 | 314.25 | 0.18 |
| 50 | sfp+pinbar | 1h | 45.3 | 53 | 3.64 | 8.00 | 76.47 | 1.44 |
| 51 | sfp+divergence | 15m | 44.9 | 479 | 2.16 | 11.25 | 305.53 | 0.64 |
| 52 | divergence+cvd_divergence | 1h | 44.5 | 173 | 16.78 | 7.00 | 1515.11 | 8.76 |
| 53 | sfp+cvd_divergence | 15m | 44.4 | 952 | 2.08 | 13.00 | 569.83 | 0.60 |
| 54 | sfp+divergence | 5m | 44.3 | 1433 | 2.24 | 20.44 | 992.95 | 0.69 |
| 55 | cvd_divergence+fibonacci | 4h | 44.0 | 25 | 1.96 | 5.00 | 13.50 | 0.54 |
| 56 | sfp+cvd_divergence | 1m | 43.9 | 13879 | 2.28 | 30.21 | 9959.72 | 0.72 |
| 57 | sfp+divergence | 1m | 43.8 | 8238 | 2.43 | 27.49 | 6607.64 | 0.80 |
| 58 | fibonacci+pinbar | 5m | 43.8 | 683 | 1.20 | 47.49 | 75.86 | 0.11 |
| 59 | fibonacci+pinbar | 15m | 43.6 | 195 | 1.33 | 15.97 | 35.80 | 0.18 |
| 60 | sfp+cvd_divergence | 5m | 43.2 | 2825 | 2.00 | 19.79 | 1603.96 | 0.57 |
| 61 | divergence+cvd_divergence | 15m | 42.5 | 898 | 1107.99 | 11.00 | 571208.81 | 636.09 |
| 62 | sfp+divergence | 1h | 41.9 | 105 | 2.04 | 12.00 | 63.74 | 0.61 |
| 63 | sfp+cvd_divergence | 1h | 41.9 | 215 | 1.89 | 13.00 | 111.60 | 0.52 |
| 64 | divergence+pinbar | 1h | 41.7 | 12 | 1.01 | 2.87 | 0.10 | 0.01 |
| 65 | sfp+pinbar | 1m | 41.4 | 3286 | 1.51 | 47.04 | 976.25 | 0.30 |
| 66 | fibonacci+pinbar | 4h | 37.5 | 8 | 0.34 | 5.00 | -3.28 | -0.41 |
| 67 | sfp+pinbar | 5m | 36.7 | 681 | 1.12 | 45.54 | 53.56 | 0.08 |
| 68 | divergence+cvd_divergence | 4h | 36.0 | 25 | 17.20 | 7.00 | 259.25 | 10.37 |
| 69 | fibonacci+pinbar | 1h | 35.3 | 51 | 0.57 | 26.43 | -14.35 | -0.28 |
| 70 | cvd_divergence+fibonacci | 1d | 33.3 | 3 | 1.06 | 2.00 | 0.12 | 0.04 |
| 71 | sfp+pinbar | 15m | 33.0 | 212 | 0.87 | 33.28 | -18.29 | -0.09 |
| 72 | sfp+cvd_divergence | 4h | 31.7 | 41 | 1.80 | 8.51 | 22.51 | 0.55 |
| 73 | sfp+fibonacci | 1d | 25.0 | 8 | 0.18 | 6.00 | -4.90 | -0.61 |
| 74 | sfp+divergence | 4h | 22.7 | 22 | 1.25 | 9.00 | 4.21 | 0.19 |
| 75 | sfp+pinbar | 4h | 0.0 | 4 | 0.00 | 4.00 | -4.00 | -1.00 |
| 76 | sfp+cvd_divergence | 1d | 0.0 | 3 | 0.00 | 3.00 | -3.00 | -1.00 |
| 77 | cvd_divergence+pinbar | 4h | 0.0 | 1 | 0.00 | 1.00 | -1.00 | -1.00 |
| 78 | market_structure+pinbar | 1h | 0.0 | 1 | 0.00 | 1.00 | -1.00 | -1.00 |
</details>


## Step 3 — Filtered Strategies (ranked by win%)

### Headline — min 20 trades

| Rank | Strategy / Combo | TF | Win% | Trades | PF | MaxDD (R) | Net R | Avg R |
|---|---|---|---|---|---|---|---|---|
| 1 | market_structure | vwap | 15m | 93.2 | 59 | 3.65 | 2.00 | 10.61 | 0.18 |
| 2 | market_structure | levels | 15m | 92.9 | 42 | 3.55 | 1.00 | 7.65 | 0.18 |
| 3 | market_structure | vwap | 1m | 88.4 | 1158 | 2.41 | 3.45 | 188.30 | 0.16 |
| 4 | market_structure | vwap | 5m | 88.0 | 192 | 2.01 | 3.09 | 23.25 | 0.12 |
| 5 | market_structure | levels | 1m | 86.4 | 722 | 2.10 | 6.20 | 107.76 | 0.15 |
| 6 | market_structure | levels | 5m | 85.9 | 128 | 1.67 | 3.63 | 12.11 | 0.09 |
| 7 | market_structure | vwap | 1h | 77.3 | 22 | 0.70 | 3.55 | -1.52 | -0.07 |
| 8 | market_structure | vpvr | 1m | 66.7 | 39 | 1.17 | 7.55 | 2.26 | 0.06 |
| 9 | pinbar | vwap | 1h | 62.9 | 143 | 2.58 | 8.86 | 83.58 | 0.58 |
| 10 | divergence | vwap | 15m | 57.9 | 380 | 1158.38 | 7.00 | 185181.11 | 487.32 |
| 11 | cvd_divergence | vwap | 1h | 55.5 | 326 | 27.17 | 6.00 | 3794.77 | 11.64 |
| 12 | fibonacci | vwap | 4h | 54.9 | 184 | 2.25 | 6.92 | 104.10 | 0.57 |
| 13 | divergence | vwap | 1m | 54.1 | 12494 | 963.91 | 15.00 | 5521345.15 | 441.92 |
| 14 | divergence | vwap | 5m | 53.8 | 1718 | 1092.20 | 8.05 | 866414.05 | 504.32 |
| 15 | cvd_divergence | vwap | 15m | 52.0 | 1132 | 395.61 | 8.00 | 214272.61 | 189.29 |
| 16 | fibonacci | vwap | 1h | 51.9 | 912 | 1.61 | 17.26 | 269.77 | 0.30 |
| 17 | divergence | vwap | 1h | 51.5 | 163 | 15.60 | 8.00 | 1153.44 | 7.08 |
| 18 | pinbar | vwap | 15m | 51.4 | 566 | 1.46 | 24.48 | 127.59 | 0.23 |
| 19 | pinbar | vwap | 1m | 50.7 | 9855 | 1.68 | 46.97 | 3306.27 | 0.34 |
| 20 | pinbar | vwap | 5m | 50.5 | 1951 | 1.62 | 41.17 | 595.20 | 0.31 |
| 21 | sfp | vwap | 1h | 50.2 | 438 | 2.31 | 14.58 | 285.27 | 0.65 |
| 22 | cvd_divergence | vwap | 5m | 49.2 | 3827 | 766.10 | 11.00 | 1486582.69 | 388.45 |
| 23 | cvd_divergence | vwap | 1m | 49.1 | 19340 | 859.26 | 18.00 | 8454763.40 | 437.16 |
| 24 | divergence | levels | 1m | 49.0 | 16498 | 848.66 | 20.35 | 7132207.05 | 432.31 |
| 25 | divergence | levels | 5m | 47.7 | 2605 | 734.83 | 11.00 | 999473.52 | 383.68 |
| 26 | pinbar | levels | 1m | 47.4 | 10151 | 1.63 | 38.29 | 3380.37 | 0.33 |
| 27 | cvd_divergence | levels | 1m | 46.1 | 21485 | 886.84 | 17.00 | 10258933.33 | 477.49 |
| 28 | pinbar | levels | 15m | 44.8 | 531 | 1.18 | 29.64 | 51.51 | 0.10 |
| 29 | pinbar | levels | 1h | 44.7 | 152 | 1.68 | 15.64 | 56.73 | 0.37 |
| 30 | fibonacci | vwap | 15m | 44.5 | 3791 | 1.65 | 47.16 | 1372.46 | 0.36 |
| 31 | divergence | vwap | 4h | 44.4 | 36 | 17.93 | 8.00 | 338.59 | 9.41 |
| 32 | pinbar | levels | 5m | 44.3 | 2215 | 1.22 | 78.94 | 274.58 | 0.12 |
| 33 | cvd_divergence | levels | 5m | 43.6 | 4481 | 591.01 | 19.94 | 1490956.36 | 332.73 |
| 34 | sfp | vwap | 15m | 43.3 | 1846 | 1.80 | 39.46 | 839.10 | 0.45 |
| 35 | fibonacci | vwap | 1m | 42.9 | 37652 | 1.71 | 57.26 | 15308.62 | 0.41 |
| 36 | fibonacci | levels | 1m | 42.8 | 39877 | 1.83 | 57.50 | 18906.46 | 0.47 |
| 37 | cvd_divergence | levels | 1h | 42.8 | 327 | 26.75 | 6.00 | 4815.40 | 14.73 |
| 38 | divergence | levels | 15m | 42.2 | 752 | 511.99 | 15.42 | 222279.37 | 295.58 |
| 39 | fibonacci | vwap | 5m | 41.8 | 9973 | 1.64 | 77.72 | 3694.82 | 0.37 |
| 40 | cvd_divergence | levels | 15m | 41.6 | 1470 | 384.29 | 13.36 | 329245.56 | 223.98 |
| 41 | divergence | levels | 1h | 41.5 | 130 | 10.67 | 10.36 | 734.91 | 5.65 |
| 42 | divergence | vpvr | 5m | 41.2 | 1577 | 1042.03 | 22.00 | 966071.31 | 612.60 |
| 43 | fibonacci | levels | 5m | 40.2 | 10314 | 1.58 | 73.95 | 3576.81 | 0.35 |
| 44 | divergence | vpvr | 1m | 39.0 | 8989 | 635.28 | 23.00 | 3477111.76 | 386.82 |
| 45 | fibonacci | levels | 15m | 39.0 | 3863 | 1.43 | 66.64 | 1006.49 | 0.26 |
| 46 | cvd_divergence | vpvr | 5m | 38.9 | 1944 | 837.24 | 20.00 | 993455.71 | 511.04 |
| 47 | divergence | vpvr | 1h | 38.7 | 119 | 20.19 | 13.00 | 1400.97 | 11.77 |
| 48 | sfp | vwap | 5m | 38.6 | 6249 | 1.83 | 45.29 | 3200.81 | 0.51 |
| 49 | sfp | vwap | 1m | 38.6 | 27567 | 1.83 | 92.00 | 14024.60 | 0.51 |
| 50 | sfp | vwap | 4h | 38.3 | 154 | 1.66 | 21.84 | 62.65 | 0.41 |
| 51 | cvd_divergence | vpvr | 1m | 38.2 | 9466 | 733.40 | 20.00 | 4281610.35 | 452.31 |
| 52 | pinbar | vpvr | 5m | 38.0 | 835 | 1.20 | 41.11 | 101.41 | 0.12 |
| 53 | pinbar | vpvr | 1m | 37.9 | 3932 | 1.36 | 137.91 | 873.19 | 0.22 |
| 54 | fibonacci | levels | 4h | 37.9 | 124 | 2.01 | 15.33 | 77.94 | 0.63 |
| 55 | fibonacci | vpvr | 1m | 37.6 | 12174 | 2.08 | 143.30 | 8230.10 | 0.68 |
| 56 | fibonacci | levels | 1h | 37.6 | 934 | 1.23 | 27.91 | 132.50 | 0.14 |
| 57 | cvd_divergence | vwap | 4h | 37.2 | 86 | 11.44 | 9.00 | 563.89 | 6.56 |
| 58 | sfp | levels | 1m | 36.7 | 35039 | 1.75 | 58.85 | 16721.11 | 0.48 |
| 59 | cvd_divergence | vpvr | 1h | 36.7 | 150 | 34.90 | 9.00 | 3220.18 | 21.47 |
| 60 | sfp | levels | 1h | 35.7 | 689 | 2.25 | 29.36 | 554.46 | 0.80 |
| 61 | pinbar | vpvr | 1h | 35.5 | 93 | 0.95 | 17.45 | -3.10 | -0.03 |
| 62 | divergence | vpvr | 15m | 35.5 | 547 | 553.52 | 17.00 | 195040.47 | 356.56 |
| 63 | fibonacci | vpvr | 5m | 35.4 | 3267 | 1.17 | 87.78 | 354.18 | 0.11 |
| 64 | sfp | levels | 5m | 35.3 | 8443 | 1.70 | 57.92 | 3824.51 | 0.45 |
| 65 | cvd_divergence | vpvr | 15m | 34.9 | 679 | 398.25 | 18.71 | 175586.26 | 258.60 |
| 66 | sfp | levels | 15m | 34.6 | 2924 | 1.58 | 52.55 | 1102.51 | 0.38 |
| 67 | fibonacci | vpvr | 15m | 33.2 | 1193 | 1.13 | 54.00 | 107.43 | 0.09 |
| 68 | pinbar | vpvr | 15m | 33.2 | 211 | 0.91 | 28.37 | -12.85 | -0.06 |
| 69 | sfp | vpvr | 1h | 31.1 | 305 | 1.51 | 38.00 | 106.92 | 0.35 |
| 70 | sfp | vpvr | 5m | 30.2 | 3460 | 1.59 | 61.61 | 1426.28 | 0.41 |
| 71 | sfp | vpvr | 1m | 29.7 | 14914 | 1.64 | 81.43 | 6735.72 | 0.45 |
| 72 | fibonacci | vpvr | 1h | 29.3 | 283 | 0.88 | 44.96 | -23.18 | -0.08 |
| 73 | sfp | vpvr | 15m | 28.2 | 1326 | 1.32 | 98.19 | 307.46 | 0.23 |
| 74 | sfp | levels | 4h | 27.4 | 113 | 1.22 | 36.11 | 17.86 | 0.16 |
| 75 | fibonacci | vpvr | 4h | 27.3 | 66 | 0.62 | 29.69 | -18.31 | -0.28 |
| 76 | divergence | vpvr | 4h | 25.9 | 27 | 12.71 | 7.00 | 234.21 | 8.67 |
| 77 | cvd_divergence | vpvr | 4h | 21.2 | 33 | 11.61 | 9.00 | 275.78 | 8.36 |
| 78 | sfp | vpvr | 4h | 19.3 | 88 | 0.75 | 30.82 | -17.54 | -0.20 |
| 79 | cvd_divergence | levels | 4h | 13.6 | 44 | 1.86 | 23.00 | 32.66 | 0.74 |


<details><summary>Full table (all 96 rows, any trade count)</summary>


| Rank | Strategy / Combo | TF | Win% | Trades | PF | MaxDD (R) | Net R | Avg R |
|---|---|---|---|---|---|---|---|---|
| 1 | market_structure | vwap | 4h | 100.0 | 4 | ∞ | 0.00 | 0.72 | 0.18 |
| 2 | divergence | vwap | 1d | 100.0 | 1 | ∞ | 0.00 | 11.25 | 11.25 |
| 3 | fibonacci | levels | 1d | 100.0 | 1 | ∞ | 0.00 | 0.76 | 0.76 |
| 4 | market_structure | vpvr | 15m | 100.0 | 1 | ∞ | 0.00 | 0.05 | 0.05 |
| 5 | market_structure | vwap | 15m | 93.2 | 59 | 3.65 | 2.00 | 10.61 | 0.18 |
| 6 | market_structure | levels | 15m | 92.9 | 42 | 3.55 | 1.00 | 7.65 | 0.18 |
| 7 | market_structure | vwap | 1m | 88.4 | 1158 | 2.41 | 3.45 | 188.30 | 0.16 |
| 8 | market_structure | vwap | 5m | 88.0 | 192 | 2.01 | 3.09 | 23.25 | 0.12 |
| 9 | market_structure | levels | 1m | 86.4 | 722 | 2.10 | 6.20 | 107.76 | 0.15 |
| 10 | market_structure | levels | 5m | 85.9 | 128 | 1.67 | 3.63 | 12.11 | 0.09 |
| 11 | market_structure | vwap | 1h | 77.3 | 22 | 0.70 | 3.55 | -1.52 | -0.07 |
| 12 | market_structure | levels | 4h | 75.0 | 4 | 0.57 | 1.00 | -0.43 | -0.11 |
| 13 | market_structure | vpvr | 1m | 66.7 | 39 | 1.17 | 7.55 | 2.26 | 0.06 |
| 14 | market_structure | levels | 1h | 66.7 | 15 | 0.40 | 3.90 | -2.99 | -0.20 |
| 15 | fibonacci | vwap | 1d | 66.7 | 12 | 3.60 | 3.00 | 10.39 | 0.87 |
| 16 | pinbar | vwap | 1h | 62.9 | 143 | 2.58 | 8.86 | 83.58 | 0.58 |
| 17 | pinbar | vwap | 4h | 62.5 | 16 | 1.33 | 5.00 | 1.98 | 0.12 |
| 18 | divergence | vwap | 15m | 57.9 | 380 | 1158.38 | 7.00 | 185181.11 | 487.32 |
| 19 | cvd_divergence | vwap | 1h | 55.5 | 326 | 27.17 | 6.00 | 3794.77 | 11.64 |
| 20 | fibonacci | vwap | 4h | 54.9 | 184 | 2.25 | 6.92 | 104.10 | 0.57 |
| 21 | divergence | vwap | 1m | 54.1 | 12494 | 963.91 | 15.00 | 5521345.15 | 441.92 |
| 22 | divergence | vwap | 5m | 53.8 | 1718 | 1092.20 | 8.05 | 866414.05 | 504.32 |
| 23 | cvd_divergence | vwap | 15m | 52.0 | 1132 | 395.61 | 8.00 | 214272.61 | 189.29 |
| 24 | fibonacci | vwap | 1h | 51.9 | 912 | 1.61 | 17.26 | 269.77 | 0.30 |
| 25 | divergence | vwap | 1h | 51.5 | 163 | 15.60 | 8.00 | 1153.44 | 7.08 |
| 26 | pinbar | vwap | 15m | 51.4 | 566 | 1.46 | 24.48 | 127.59 | 0.23 |
| 27 | pinbar | vwap | 1m | 50.7 | 9855 | 1.68 | 46.97 | 3306.27 | 0.34 |
| 28 | pinbar | vwap | 5m | 50.5 | 1951 | 1.62 | 41.17 | 595.20 | 0.31 |
| 29 | sfp | vwap | 1h | 50.2 | 438 | 2.31 | 14.58 | 285.27 | 0.65 |
| 30 | market_structure | vpvr | 1h | 50.0 | 4 | 0.17 | 2.00 | -1.66 | -0.41 |
| 31 | pinbar | vwap | 1d | 50.0 | 2 | 2.32 | 1.00 | 1.32 | 0.66 |
| 32 | cvd_divergence | vwap | 5m | 49.2 | 3827 | 766.10 | 11.00 | 1486582.69 | 388.45 |
| 33 | cvd_divergence | vwap | 1m | 49.1 | 19340 | 859.26 | 18.00 | 8454763.40 | 437.16 |
| 34 | divergence | levels | 1m | 49.0 | 16498 | 848.66 | 20.35 | 7132207.05 | 432.31 |
| 35 | divergence | levels | 5m | 47.7 | 2605 | 734.83 | 11.00 | 999473.52 | 383.68 |
| 36 | pinbar | levels | 1m | 47.4 | 10151 | 1.63 | 38.29 | 3380.37 | 0.33 |
| 37 | cvd_divergence | levels | 1m | 46.1 | 21485 | 886.84 | 17.00 | 10258933.33 | 477.49 |
| 38 | pinbar | levels | 15m | 44.8 | 531 | 1.18 | 29.64 | 51.51 | 0.10 |
| 39 | pinbar | levels | 1h | 44.7 | 152 | 1.68 | 15.64 | 56.73 | 0.37 |
| 40 | fibonacci | vwap | 15m | 44.5 | 3791 | 1.65 | 47.16 | 1372.46 | 0.36 |
| 41 | divergence | vwap | 4h | 44.4 | 36 | 17.93 | 8.00 | 338.59 | 9.41 |
| 42 | pinbar | levels | 5m | 44.3 | 2215 | 1.22 | 78.94 | 274.58 | 0.12 |
| 43 | cvd_divergence | levels | 5m | 43.6 | 4481 | 591.01 | 19.94 | 1490956.36 | 332.73 |
| 44 | sfp | vwap | 15m | 43.3 | 1846 | 1.80 | 39.46 | 839.10 | 0.45 |
| 45 | fibonacci | vwap | 1m | 42.9 | 37652 | 1.71 | 57.26 | 15308.62 | 0.41 |
| 46 | fibonacci | levels | 1m | 42.8 | 39877 | 1.83 | 57.50 | 18906.46 | 0.47 |
| 47 | cvd_divergence | levels | 1h | 42.8 | 327 | 26.75 | 6.00 | 4815.40 | 14.73 |
| 48 | divergence | levels | 15m | 42.2 | 752 | 511.99 | 15.42 | 222279.37 | 295.58 |
| 49 | fibonacci | vwap | 5m | 41.8 | 9973 | 1.64 | 77.72 | 3694.82 | 0.37 |
| 50 | cvd_divergence | levels | 15m | 41.6 | 1470 | 384.29 | 13.36 | 329245.56 | 223.98 |
| 51 | divergence | levels | 1h | 41.5 | 130 | 10.67 | 10.36 | 734.91 | 5.65 |
| 52 | divergence | vpvr | 5m | 41.2 | 1577 | 1042.03 | 22.00 | 966071.31 | 612.60 |
| 53 | fibonacci | levels | 5m | 40.2 | 10314 | 1.58 | 73.95 | 3576.81 | 0.35 |
| 54 | market_structure | vpvr | 5m | 40.0 | 5 | 0.03 | 3.00 | -2.90 | -0.58 |
| 55 | divergence | vpvr | 1m | 39.0 | 8989 | 635.28 | 23.00 | 3477111.76 | 386.82 |
| 56 | fibonacci | levels | 15m | 39.0 | 3863 | 1.43 | 66.64 | 1006.49 | 0.26 |
| 57 | cvd_divergence | vpvr | 5m | 38.9 | 1944 | 837.24 | 20.00 | 993455.71 | 511.04 |
| 58 | divergence | vpvr | 1h | 38.7 | 119 | 20.19 | 13.00 | 1400.97 | 11.77 |
| 59 | sfp | vwap | 5m | 38.6 | 6249 | 1.83 | 45.29 | 3200.81 | 0.51 |
| 60 | sfp | vwap | 1m | 38.6 | 27567 | 1.83 | 92.00 | 14024.60 | 0.51 |
| 61 | sfp | vwap | 4h | 38.3 | 154 | 1.66 | 21.84 | 62.65 | 0.41 |
| 62 | cvd_divergence | vpvr | 1m | 38.2 | 9466 | 733.40 | 20.00 | 4281610.35 | 452.31 |
| 63 | pinbar | vpvr | 5m | 38.0 | 835 | 1.20 | 41.11 | 101.41 | 0.12 |
| 64 | pinbar | vpvr | 1m | 37.9 | 3932 | 1.36 | 137.91 | 873.19 | 0.22 |
| 65 | fibonacci | levels | 4h | 37.9 | 124 | 2.01 | 15.33 | 77.94 | 0.63 |
| 66 | fibonacci | vpvr | 1m | 37.6 | 12174 | 2.08 | 143.30 | 8230.10 | 0.68 |
| 67 | fibonacci | levels | 1h | 37.6 | 934 | 1.23 | 27.91 | 132.50 | 0.14 |
| 68 | pinbar | levels | 4h | 37.5 | 16 | 0.84 | 8.84 | -1.63 | -0.10 |
| 69 | cvd_divergence | vwap | 4h | 37.2 | 86 | 11.44 | 9.00 | 563.89 | 6.56 |
| 70 | sfp | levels | 1m | 36.7 | 35039 | 1.75 | 58.85 | 16721.11 | 0.48 |
| 71 | cvd_divergence | vpvr | 1h | 36.7 | 150 | 34.90 | 9.00 | 3220.18 | 21.47 |
| 72 | sfp | levels | 1h | 35.7 | 689 | 2.25 | 29.36 | 554.46 | 0.80 |
| 73 | pinbar | vpvr | 1h | 35.5 | 93 | 0.95 | 17.45 | -3.10 | -0.03 |
| 74 | divergence | vpvr | 15m | 35.5 | 547 | 553.52 | 17.00 | 195040.47 | 356.56 |
| 75 | fibonacci | vpvr | 5m | 35.4 | 3267 | 1.17 | 87.78 | 354.18 | 0.11 |
| 76 | sfp | levels | 5m | 35.3 | 8443 | 1.70 | 57.92 | 3824.51 | 0.45 |
| 77 | cvd_divergence | vpvr | 15m | 34.9 | 679 | 398.25 | 18.71 | 175586.26 | 258.60 |
| 78 | sfp | levels | 15m | 34.6 | 2924 | 1.58 | 52.55 | 1102.51 | 0.38 |
| 79 | cvd_divergence | vwap | 1d | 33.3 | 6 | 4.55 | 4.00 | 14.21 | 2.37 |
| 80 | fibonacci | vpvr | 15m | 33.2 | 1193 | 1.13 | 54.00 | 107.43 | 0.09 |
| 81 | pinbar | vpvr | 15m | 33.2 | 211 | 0.91 | 28.37 | -12.85 | -0.06 |
| 82 | sfp | vpvr | 1h | 31.1 | 305 | 1.51 | 38.00 | 106.92 | 0.35 |
| 83 | sfp | vpvr | 5m | 30.2 | 3460 | 1.59 | 61.61 | 1426.28 | 0.41 |
| 84 | sfp | vpvr | 1m | 29.7 | 14914 | 1.64 | 81.43 | 6735.72 | 0.45 |
| 85 | fibonacci | vpvr | 1h | 29.3 | 283 | 0.88 | 44.96 | -23.18 | -0.08 |
| 86 | sfp | vpvr | 15m | 28.2 | 1326 | 1.32 | 98.19 | 307.46 | 0.23 |
| 87 | sfp | levels | 4h | 27.4 | 113 | 1.22 | 36.11 | 17.86 | 0.16 |
| 88 | fibonacci | vpvr | 4h | 27.3 | 66 | 0.62 | 29.69 | -18.31 | -0.28 |
| 89 | divergence | vpvr | 4h | 25.9 | 27 | 12.71 | 7.00 | 234.21 | 8.67 |
| 90 | divergence | levels | 4h | 25.0 | 12 | 6.34 | 4.00 | 48.10 | 4.01 |
| 91 | pinbar | vpvr | 4h | 23.1 | 13 | 0.15 | 8.47 | -8.47 | -0.65 |
| 92 | cvd_divergence | vpvr | 4h | 21.2 | 33 | 11.61 | 9.00 | 275.78 | 8.36 |
| 93 | sfp | vpvr | 4h | 19.3 | 88 | 0.75 | 30.82 | -17.54 | -0.20 |
| 94 | sfp | vwap | 1d | 18.2 | 11 | 0.33 | 8.00 | -6.05 | -0.55 |
| 95 | cvd_divergence | levels | 4h | 13.6 | 44 | 1.86 | 23.00 | 32.66 | 0.74 |
| 96 | market_structure | vpvr | 4h | 0.0 | 1 | 0.00 | 1.00 | -1.00 | -1.00 |
</details>


## Step 4 — Filtered Pairs Strategies (ranked by win%)

### Headline — min 20 trades

| Rank | Strategy / Combo | TF | Win% | Trades | PF | MaxDD (R) | Net R | Avg R |
|---|---|---|---|---|---|---|---|---|
| 1 | divergence+market_structure | vwap | 1m | 92.7 | 82 | 5.11 | 2.92 | 24.67 | 0.30 |
| 2 | cvd_divergence+market_structure | levels | 1m | 91.8 | 85 | 3.21 | 1.64 | 15.50 | 0.18 |
| 3 | sfp+market_structure | levels | 5m | 91.3 | 69 | 2.76 | 2.00 | 10.54 | 0.15 |
| 4 | sfp+market_structure | vwap | 15m | 91.2 | 34 | 1.94 | 1.00 | 2.82 | 0.08 |
| 5 | cvd_divergence+market_structure | vwap | 1m | 91.1 | 135 | 3.62 | 2.07 | 31.44 | 0.23 |
| 6 | sfp+market_structure | levels | 15m | 90.9 | 22 | 2.09 | 1.00 | 2.18 | 0.10 |
| 7 | market_structure+pinbar | levels | 1m | 90.7 | 43 | 2.58 | 2.00 | 6.30 | 0.15 |
| 8 | divergence+market_structure | levels | 1m | 90.2 | 41 | 3.61 | 1.24 | 10.43 | 0.25 |
| 9 | fibonacci+market_structure | vwap | 15m | 89.6 | 48 | 2.51 | 2.93 | 7.54 | 0.16 |
| 10 | sfp+market_structure | levels | 1m | 89.0 | 355 | 3.33 | 4.73 | 90.97 | 0.26 |
| 11 | sfp+market_structure | vwap | 5m | 88.8 | 98 | 2.12 | 2.94 | 12.34 | 0.13 |
| 12 | sfp+market_structure | vwap | 1m | 87.3 | 567 | 2.60 | 3.37 | 115.28 | 0.20 |
| 13 | fibonacci+market_structure | levels | 15m | 87.1 | 31 | 1.85 | 1.98 | 3.38 | 0.11 |
| 14 | fibonacci+market_structure | vwap | 1m | 86.9 | 735 | 2.33 | 5.76 | 127.68 | 0.17 |
| 15 | fibonacci+market_structure | levels | 1m | 86.4 | 469 | 2.21 | 5.33 | 77.19 | 0.16 |
| 16 | market_structure+pinbar | vwap | 1m | 86.1 | 72 | 1.95 | 3.88 | 9.47 | 0.13 |
| 17 | fibonacci+market_structure | vwap | 5m | 84.7 | 111 | 1.61 | 4.24 | 10.43 | 0.09 |
| 18 | fibonacci+market_structure | levels | 5m | 82.1 | 78 | 1.29 | 3.41 | 4.00 | 0.05 |
| 19 | sfp+divergence | vwap | 15m | 69.1 | 81 | 4.21 | 3.00 | 80.25 | 0.99 |
| 20 | fibonacci+market_structure | vpvr | 1m | 65.2 | 23 | 0.45 | 5.81 | -4.39 | -0.19 |
| 21 | sfp+fibonacci | vwap | 1h | 60.6 | 198 | 1.24 | 11.56 | 18.87 | 0.10 |
| 22 | divergence+fibonacci | vwap | 15m | 60.0 | 120 | 1.94 | 6.00 | 45.17 | 0.38 |
| 23 | divergence+fibonacci | vwap | 5m | 59.5 | 624 | 2.56 | 10.82 | 395.55 | 0.63 |
| 24 | cvd_divergence+fibonacci | vwap | 15m | 59.1 | 423 | 2.29 | 9.45 | 222.73 | 0.53 |
| 25 | cvd_divergence+pinbar | levels | 15m | 58.1 | 31 | 3.34 | 3.29 | 30.42 | 0.98 |
| 26 | sfp+cvd_divergence | vwap | 15m | 57.6 | 297 | 2.37 | 4.38 | 173.16 | 0.58 |
| 27 | divergence+fibonacci | vwap | 1h | 57.1 | 56 | 1.20 | 4.00 | 4.85 | 0.09 |
| 28 | divergence+pinbar | vpvr | 5m | 56.6 | 53 | 3.16 | 6.00 | 49.75 | 0.94 |
| 29 | divergence+cvd_divergence | vwap | 15m | 56.1 | 180 | 1068.43 | 10.00 | 84326.73 | 468.48 |
| 30 | divergence+pinbar | levels | 5m | 56.0 | 100 | 3.61 | 6.24 | 114.84 | 1.15 |
| 31 | sfp+fibonacci | levels | 4h | 56.0 | 25 | 2.97 | 7.09 | 21.68 | 0.87 |
| 32 | divergence+fibonacci | vwap | 1m | 55.8 | 4270 | 2.31 | 17.48 | 2477.11 | 0.58 |
| 33 | sfp+fibonacci | vwap | 4h | 55.6 | 36 | 1.25 | 9.82 | 3.92 | 0.11 |
| 34 | cvd_divergence+pinbar | vwap | 5m | 55.1 | 136 | 3.16 | 7.82 | 131.64 | 0.97 |
| 35 | divergence+cvd_divergence | vwap | 5m | 55.1 | 864 | 1015.09 | 8.00 | 393466.17 | 455.40 |
| 36 | cvd_divergence+fibonacci | vwap | 5m | 55.1 | 1340 | 2.06 | 14.55 | 636.07 | 0.47 |
| 37 | cvd_divergence+fibonacci | vwap | 1h | 55.0 | 111 | 1.40 | 12.17 | 20.01 | 0.18 |
| 38 | divergence+cvd_divergence | vwap | 1m | 54.9 | 6497 | 939.50 | 12.00 | 2750733.81 | 423.39 |
| 39 | divergence+fibonacci | levels | 1m | 54.7 | 5818 | 2.17 | 16.94 | 3088.87 | 0.53 |
| 40 | divergence+fibonacci | levels | 5m | 54.7 | 935 | 1.82 | 11.65 | 348.16 | 0.37 |
| 41 | sfp+divergence | vwap | 5m | 54.6 | 324 | 2.73 | 8.00 | 254.55 | 0.79 |
| 42 | sfp+cvd_divergence | vwap | 1h | 54.5 | 99 | 2.66 | 5.00 | 74.79 | 0.76 |
| 43 | divergence+pinbar | levels | 15m | 54.5 | 22 | 3.48 | 3.00 | 24.80 | 1.13 |
| 44 | cvd_divergence+pinbar | vwap | 15m | 53.8 | 26 | 3.40 | 3.10 | 28.83 | 1.11 |
| 45 | cvd_divergence+pinbar | vpvr | 5m | 53.6 | 56 | 2.34 | 6.00 | 34.95 | 0.62 |
| 46 | divergence+fibonacci | levels | 1h | 53.5 | 43 | 1.17 | 5.00 | 3.41 | 0.08 |
| 47 | sfp+fibonacci | vwap | 15m | 53.4 | 815 | 1.03 | 40.68 | 12.27 | 0.02 |
| 48 | sfp+fibonacci | vwap | 1m | 53.0 | 9294 | 1.28 | 41.67 | 1231.84 | 0.13 |
| 49 | divergence+cvd_divergence | vwap | 1h | 52.7 | 93 | 20.71 | 6.00 | 867.29 | 9.33 |
| 50 | cvd_divergence+fibonacci | levels | 1m | 52.3 | 7351 | 2.13 | 21.39 | 3976.92 | 0.54 |
| 51 | cvd_divergence+fibonacci | vpvr | 1h | 52.2 | 23 | 1.73 | 3.58 | 8.04 | 0.35 |
| 52 | cvd_divergence+fibonacci | vwap | 1m | 52.1 | 6825 | 2.21 | 25.04 | 3947.89 | 0.58 |
| 53 | sfp+fibonacci | levels | 1m | 51.7 | 10418 | 1.29 | 40.68 | 1456.34 | 0.14 |
| 54 | sfp+pinbar | levels | 1h | 51.6 | 31 | 3.52 | 5.62 | 37.87 | 1.22 |
| 55 | cvd_divergence+pinbar | levels | 5m | 51.0 | 149 | 2.54 | 7.08 | 112.14 | 0.75 |
| 56 | sfp+fibonacci | vwap | 5m | 51.0 | 2174 | 1.43 | 23.01 | 453.34 | 0.21 |
| 57 | fibonacci+pinbar | vwap | 1m | 50.8 | 1385 | 1.54 | 34.81 | 368.95 | 0.27 |
| 58 | fibonacci+pinbar | vwap | 5m | 50.8 | 305 | 1.53 | 30.60 | 79.45 | 0.26 |
| 59 | cvd_divergence+fibonacci | levels | 5m | 50.6 | 1439 | 1.64 | 18.49 | 455.43 | 0.32 |
| 60 | divergence+pinbar | levels | 1m | 50.3 | 505 | 18.80 | 9.56 | 4468.51 | 8.85 |
| 61 | sfp+fibonacci | levels | 1h | 50.3 | 181 | 1.50 | 10.09 | 44.77 | 0.25 |
| 62 | divergence+fibonacci | vpvr | 1m | 50.2 | 2617 | 1.77 | 16.87 | 1000.03 | 0.38 |
| 63 | divergence+fibonacci | vpvr | 5m | 50.2 | 478 | 1.52 | 17.25 | 124.35 | 0.26 |
| 64 | divergence+fibonacci | levels | 15m | 50.2 | 243 | 2.22 | 9.91 | 147.04 | 0.61 |
| 65 | cvd_divergence+fibonacci | vpvr | 1m | 50.2 | 2420 | 1.82 | 23.69 | 987.42 | 0.41 |
| 66 | divergence+pinbar | vwap | 1m | 50.2 | 313 | 2.62 | 10.67 | 252.43 | 0.81 |
| 67 | sfp+fibonacci | levels | 5m | 50.1 | 2404 | 1.42 | 30.01 | 498.85 | 0.21 |
| 68 | sfp+divergence | vwap | 1m | 50.0 | 2036 | 2.83 | 13.30 | 1865.26 | 0.92 |
| 69 | cvd_divergence+fibonacci | vwap | 4h | 50.0 | 20 | 2.67 | 5.00 | 16.67 | 0.83 |
| 70 | cvd_divergence+pinbar | levels | 1m | 49.9 | 753 | 13.02 | 18.75 | 4532.70 | 6.02 |
| 71 | cvd_divergence+pinbar | vwap | 1m | 49.9 | 633 | 3.09 | 12.73 | 662.60 | 1.05 |
| 72 | cvd_divergence+fibonacci | vpvr | 5m | 49.7 | 485 | 1.77 | 12.58 | 189.07 | 0.39 |
| 73 | divergence+cvd_divergence | levels | 1m | 49.5 | 8949 | 885.23 | 13.87 | 3999366.93 | 446.91 |
| 74 | cvd_divergence+fibonacci | levels | 1h | 49.4 | 89 | 1.66 | 9.06 | 29.60 | 0.33 |
| 75 | sfp+divergence | vwap | 1h | 49.1 | 57 | 2.75 | 7.62 | 50.79 | 0.89 |
| 76 | cvd_divergence+fibonacci | levels | 15m | 48.7 | 454 | 1.89 | 19.63 | 208.11 | 0.46 |
| 77 | fibonacci+pinbar | levels | 1m | 48.4 | 1417 | 1.47 | 49.04 | 343.65 | 0.24 |
| 78 | divergence+pinbar | vwap | 5m | 48.3 | 60 | 3.25 | 6.24 | 69.84 | 1.16 |
| 79 | sfp+divergence | levels | 15m | 48.3 | 209 | 2.42 | 11.00 | 153.32 | 0.73 |
| 80 | divergence+cvd_divergence | levels | 5m | 48.0 | 1392 | 615.80 | 11.00 | 445117.83 | 319.77 |
| 81 | sfp+divergence | levels | 5m | 47.5 | 649 | 2.79 | 13.00 | 610.90 | 0.94 |
| 82 | cvd_divergence+fibonacci | vpvr | 15m | 47.3 | 169 | 1.50 | 8.96 | 44.88 | 0.27 |
| 83 | fibonacci+pinbar | vpvr | 15m | 46.9 | 32 | 1.28 | 7.96 | 4.80 | 0.15 |
| 84 | sfp+fibonacci | levels | 15m | 46.7 | 946 | 1.28 | 32.63 | 142.28 | 0.15 |
| 85 | fibonacci+pinbar | levels | 5m | 46.6 | 348 | 1.32 | 31.70 | 59.32 | 0.17 |
| 86 | sfp+fibonacci | vpvr | 5m | 46.2 | 783 | 1.55 | 31.77 | 230.61 | 0.29 |
| 87 | sfp+cvd_divergence | levels | 1h | 46.1 | 102 | 2.35 | 6.33 | 74.51 | 0.73 |
| 88 | sfp+pinbar | vwap | 1m | 45.4 | 1465 | 1.66 | 34.09 | 524.07 | 0.36 |
| 89 | sfp+divergence | levels | 1m | 45.2 | 3802 | 2.45 | 21.00 | 3027.48 | 0.80 |
| 90 | divergence+cvd_divergence | vwap | 4h | 45.0 | 20 | 25.02 | 6.00 | 264.25 | 13.21 |
| 91 | sfp+cvd_divergence | vwap | 1m | 44.7 | 5500 | 2.29 | 22.16 | 3912.00 | 0.71 |
| 92 | divergence+fibonacci | vpvr | 15m | 44.6 | 166 | 1.25 | 9.80 | 23.46 | 0.14 |
| 93 | sfp+pinbar | vpvr | 5m | 44.4 | 108 | 1.83 | 9.00 | 50.07 | 0.46 |
| 94 | sfp+cvd_divergence | vwap | 5m | 44.4 | 1113 | 2.00 | 16.32 | 619.19 | 0.56 |
| 95 | sfp+fibonacci | vpvr | 1m | 44.3 | 3432 | 1.28 | 76.91 | 535.93 | 0.16 |
| 96 | cvd_divergence+pinbar | vpvr | 1m | 44.3 | 296 | 2.34 | 13.97 | 221.77 | 0.75 |
| 97 | sfp+cvd_divergence | levels | 1m | 44.2 | 6779 | 2.24 | 23.24 | 4675.94 | 0.69 |
| 98 | sfp+cvd_divergence | levels | 5m | 43.8 | 1406 | 2.13 | 18.36 | 890.97 | 0.63 |
| 99 | sfp+pinbar | levels | 1m | 43.8 | 1684 | 1.68 | 29.92 | 646.95 | 0.38 |
| 100 | divergence+fibonacci | vpvr | 1h | 43.5 | 23 | 1.08 | 5.48 | 1.09 | 0.05 |
| 101 | fibonacci+pinbar | levels | 15m | 43.4 | 76 | 1.08 | 10.32 | 3.54 | 0.05 |
| 102 | sfp+cvd_divergence | levels | 15m | 43.3 | 496 | 1.90 | 10.82 | 253.63 | 0.51 |
| 103 | divergence+cvd_divergence | levels | 15m | 42.9 | 396 | 648.38 | 10.00 | 146308.84 | 369.47 |
| 104 | divergence+cvd_divergence | vpvr | 5m | 42.7 | 907 | 1411.65 | 13.00 | 733540.15 | 808.75 |
| 105 | sfp+divergence | vpvr | 5m | 42.4 | 483 | 2.09 | 17.85 | 302.17 | 0.63 |
| 106 | divergence+cvd_divergence | levels | 1h | 42.2 | 64 | 8.69 | 9.00 | 284.35 | 4.44 |
| 107 | sfp+fibonacci | vpvr | 15m | 42.1 | 328 | 1.16 | 21.64 | 30.74 | 0.09 |
| 108 | sfp+pinbar | vwap | 5m | 41.9 | 265 | 1.43 | 29.96 | 66.83 | 0.25 |
| 109 | divergence+pinbar | vpvr | 1m | 41.7 | 314 | 2.46 | 14.64 | 266.43 | 0.85 |
| 110 | sfp+cvd_divergence | vpvr | 5m | 40.9 | 558 | 1.97 | 14.60 | 318.56 | 0.57 |
| 111 | sfp+cvd_divergence | vpvr | 1m | 40.7 | 3038 | 2.20 | 37.55 | 2157.59 | 0.71 |
| 112 | fibonacci+pinbar | vpvr | 1m | 40.5 | 504 | 1.13 | 51.29 | 39.59 | 0.08 |
| 113 | sfp+cvd_divergence | vpvr | 1h | 40.4 | 47 | 1.89 | 8.56 | 25.01 | 0.53 |
| 114 | divergence+cvd_divergence | vpvr | 1m | 40.1 | 5025 | 666.07 | 20.28 | 2001863.85 | 398.38 |
| 115 | divergence+cvd_divergence | vpvr | 1h | 39.3 | 61 | 13.82 | 6.00 | 474.46 | 7.78 |
| 116 | sfp+divergence | vpvr | 15m | 39.2 | 181 | 1.83 | 10.61 | 90.89 | 0.50 |
| 117 | sfp+pinbar | levels | 15m | 38.5 | 96 | 0.81 | 17.13 | -11.22 | -0.12 |
| 118 | sfp+pinbar | vpvr | 1m | 38.0 | 623 | 1.51 | 40.39 | 196.15 | 0.31 |
| 119 | sfp+cvd_divergence | vpvr | 15m | 38.0 | 208 | 1.54 | 11.83 | 70.29 | 0.34 |
| 120 | sfp+cvd_divergence | vwap | 4h | 37.9 | 29 | 1.68 | 6.51 | 12.27 | 0.42 |
| 121 | sfp+divergence | vpvr | 1m | 37.8 | 2690 | 2.02 | 29.80 | 1714.37 | 0.64 |
| 122 | fibonacci+pinbar | vpvr | 5m | 37.2 | 121 | 0.89 | 18.61 | -8.50 | -0.07 |
| 123 | sfp+divergence | vpvr | 1h | 36.6 | 41 | 1.57 | 10.00 | 14.75 | 0.36 |
| 124 | sfp+pinbar | vwap | 15m | 36.3 | 80 | 0.97 | 18.25 | -1.64 | -0.02 |
| 125 | fibonacci+pinbar | vwap | 15m | 35.6 | 59 | 0.52 | 19.20 | -18.22 | -0.31 |
| 126 | sfp+divergence | levels | 1h | 35.6 | 45 | 1.22 | 11.40 | 6.32 | 0.14 |
| 127 | sfp+fibonacci | vpvr | 1h | 35.2 | 71 | 0.82 | 10.63 | -8.10 | -0.11 |
| 128 | divergence+cvd_divergence | vpvr | 15m | 34.9 | 318 | 762.01 | 16.00 | 157528.48 | 495.37 |
| 129 | fibonacci+pinbar | levels | 1h | 33.3 | 27 | 0.59 | 14.61 | -7.42 | -0.27 |
| 130 | sfp+pinbar | levels | 5m | 33.0 | 358 | 0.82 | 53.57 | -44.37 | -0.12 |
| 131 | sfp+pinbar | vpvr | 15m | 27.9 | 43 | 0.65 | 13.74 | -10.95 | -0.25 |


<details><summary>Full table (all 204 rows, any trade count)</summary>


| Rank | Strategy / Combo | TF | Win% | Trades | PF | MaxDD (R) | Net R | Avg R |
|---|---|---|---|---|---|---|---|---|
| 1 | market_structure+pinbar | vwap | 5m | 100.0 | 12 | ∞ | 0.00 | 2.91 | 0.24 |
| 2 | market_structure+pinbar | levels | 5m | 100.0 | 7 | ∞ | 0.00 | 1.71 | 0.24 |
| 3 | cvd_divergence+market_structure | vwap | 15m | 100.0 | 6 | ∞ | 0.00 | 0.57 | 0.10 |
| 4 | fibonacci+market_structure | vwap | 4h | 100.0 | 3 | ∞ | 0.00 | 0.81 | 0.27 |
| 5 | fibonacci+pinbar | vwap | 4h | 100.0 | 3 | ∞ | 0.00 | 1.72 | 0.57 |
| 6 | sfp+market_structure | levels | 4h | 100.0 | 2 | ∞ | 0.00 | 0.45 | 0.23 |
| 7 | sfp+market_structure | vwap | 4h | 100.0 | 2 | ∞ | 0.00 | 0.45 | 0.23 |
| 8 | cvd_divergence+market_structure | levels | 15m | 100.0 | 2 | ∞ | 0.00 | 0.11 | 0.06 |
| 9 | fibonacci+market_structure | levels | 4h | 100.0 | 2 | ∞ | 0.00 | 0.61 | 0.30 |
| 10 | market_structure+pinbar | vwap | 4h | 100.0 | 2 | ∞ | 0.00 | 0.04 | 0.02 |
| 11 | divergence+fibonacci | vwap | 1d | 100.0 | 1 | ∞ | 0.00 | 1.03 | 1.03 |
| 12 | divergence+market_structure | vwap | 4h | 100.0 | 1 | ∞ | 0.00 | 0.15 | 0.15 |
| 13 | divergence+pinbar | vwap | 1d | 100.0 | 1 | ∞ | 0.00 | 2.32 | 2.32 |
| 14 | cvd_divergence+market_structure | vwap | 4h | 100.0 | 1 | ∞ | 0.00 | 0.15 | 0.15 |
| 15 | fibonacci+pinbar | vwap | 1d | 100.0 | 1 | ∞ | 0.00 | 1.03 | 1.03 |
| 16 | market_structure+pinbar | levels | 15m | 100.0 | 1 | ∞ | 0.00 | 0.10 | 0.10 |
| 17 | market_structure+pinbar | levels | 4h | 100.0 | 1 | ∞ | 0.00 | 0.02 | 0.02 |
| 18 | market_structure+pinbar | vwap | 15m | 100.0 | 1 | ∞ | 0.00 | 0.10 | 0.10 |
| 19 | divergence+market_structure | vwap | 1m | 92.7 | 82 | 5.11 | 2.92 | 24.67 | 0.30 |
| 20 | cvd_divergence+market_structure | levels | 1m | 91.8 | 85 | 3.21 | 1.64 | 15.50 | 0.18 |
| 21 | sfp+market_structure | levels | 5m | 91.3 | 69 | 2.76 | 2.00 | 10.54 | 0.15 |
| 22 | sfp+market_structure | vwap | 15m | 91.2 | 34 | 1.94 | 1.00 | 2.82 | 0.08 |
| 23 | cvd_divergence+market_structure | vwap | 1m | 91.1 | 135 | 3.62 | 2.07 | 31.44 | 0.23 |
| 24 | sfp+market_structure | levels | 15m | 90.9 | 22 | 2.09 | 1.00 | 2.18 | 0.10 |
| 25 | market_structure+pinbar | levels | 1m | 90.7 | 43 | 2.58 | 2.00 | 6.30 | 0.15 |
| 26 | divergence+market_structure | levels | 1m | 90.2 | 41 | 3.61 | 1.24 | 10.43 | 0.25 |
| 27 | fibonacci+market_structure | vwap | 15m | 89.6 | 48 | 2.51 | 2.93 | 7.54 | 0.16 |
| 28 | sfp+market_structure | levels | 1m | 89.0 | 355 | 3.33 | 4.73 | 90.97 | 0.26 |
| 29 | sfp+market_structure | vwap | 5m | 88.8 | 98 | 2.12 | 2.94 | 12.34 | 0.13 |
| 30 | sfp+market_structure | vwap | 1m | 87.3 | 567 | 2.60 | 3.37 | 115.28 | 0.20 |
| 31 | fibonacci+market_structure | levels | 15m | 87.1 | 31 | 1.85 | 1.98 | 3.38 | 0.11 |
| 32 | fibonacci+market_structure | vwap | 1m | 86.9 | 735 | 2.33 | 5.76 | 127.68 | 0.17 |
| 33 | fibonacci+market_structure | levels | 1m | 86.4 | 469 | 2.21 | 5.33 | 77.19 | 0.16 |
| 34 | market_structure+pinbar | vwap | 1m | 86.1 | 72 | 1.95 | 3.88 | 9.47 | 0.13 |
| 35 | divergence+market_structure | vwap | 5m | 85.7 | 7 | 1.78 | 1.00 | 0.78 | 0.11 |
| 36 | fibonacci+market_structure | vwap | 5m | 84.7 | 111 | 1.61 | 4.24 | 10.43 | 0.09 |
| 37 | divergence+market_structure | levels | 5m | 83.3 | 6 | 1.42 | 1.00 | 0.42 | 0.07 |
| 38 | fibonacci+market_structure | levels | 5m | 82.1 | 78 | 1.29 | 3.41 | 4.00 | 0.05 |
| 39 | cvd_divergence+market_structure | vpvr | 1m | 80.0 | 5 | 0.44 | 1.00 | -0.56 | -0.11 |
| 40 | divergence+pinbar | vwap | 15m | 77.8 | 9 | 7.31 | 1.00 | 12.63 | 1.40 |
| 41 | cvd_divergence+market_structure | vwap | 5m | 73.3 | 15 | 0.76 | 2.21 | -0.97 | -0.06 |
| 42 | sfp+market_structure | vwap | 1h | 72.7 | 11 | 0.57 | 2.03 | -1.28 | -0.12 |
| 43 | cvd_divergence+market_structure | levels | 5m | 72.7 | 11 | 0.67 | 2.55 | -0.98 | -0.09 |
| 44 | fibonacci+market_structure | vwap | 1h | 72.7 | 11 | 0.53 | 2.38 | -1.40 | -0.13 |
| 45 | sfp+divergence | vwap | 15m | 69.1 | 81 | 4.21 | 3.00 | 80.25 | 0.99 |
| 46 | divergence+fibonacci | vwap | 4h | 66.7 | 9 | 5.16 | 2.00 | 12.48 | 1.39 |
| 47 | cvd_divergence+pinbar | vwap | 1h | 66.7 | 9 | 9.06 | 3.00 | 24.19 | 2.69 |
| 48 | cvd_divergence+market_structure | vwap | 1h | 66.7 | 3 | 0.24 | 1.00 | -0.76 | -0.25 |
| 49 | fibonacci+market_structure | vpvr | 5m | 66.7 | 3 | 0.10 | 1.00 | -0.90 | -0.30 |
| 50 | fibonacci+market_structure | vpvr | 1m | 65.2 | 23 | 0.45 | 5.81 | -4.39 | -0.19 |
| 51 | sfp+market_structure | vpvr | 1m | 63.6 | 11 | 0.16 | 3.85 | -3.37 | -0.31 |
| 52 | fibonacci+market_structure | levels | 1h | 62.5 | 8 | 0.33 | 2.77 | -2.01 | -0.25 |
| 53 | sfp+fibonacci | vwap | 1h | 60.6 | 198 | 1.24 | 11.56 | 18.87 | 0.10 |
| 54 | divergence+fibonacci | vwap | 15m | 60.0 | 120 | 1.94 | 6.00 | 45.17 | 0.38 |
| 55 | divergence+fibonacci | vwap | 5m | 59.5 | 624 | 2.56 | 10.82 | 395.55 | 0.63 |
| 56 | cvd_divergence+fibonacci | vwap | 15m | 59.1 | 423 | 2.29 | 9.45 | 222.73 | 0.53 |
| 57 | cvd_divergence+pinbar | levels | 15m | 58.1 | 31 | 3.34 | 3.29 | 30.42 | 0.98 |
| 58 | sfp+cvd_divergence | vwap | 15m | 57.6 | 297 | 2.37 | 4.38 | 173.16 | 0.58 |
| 59 | divergence+fibonacci | vwap | 1h | 57.1 | 56 | 1.20 | 4.00 | 4.85 | 0.09 |
| 60 | sfp+market_structure | levels | 1h | 57.1 | 7 | 0.31 | 2.38 | -2.06 | -0.29 |
| 61 | cvd_divergence+pinbar | levels | 1h | 57.1 | 7 | 4.35 | 2.00 | 10.06 | 1.44 |
| 62 | divergence+pinbar | vpvr | 5m | 56.6 | 53 | 3.16 | 6.00 | 49.75 | 0.94 |
| 63 | divergence+cvd_divergence | vwap | 15m | 56.1 | 180 | 1068.43 | 10.00 | 84326.73 | 468.48 |
| 64 | divergence+pinbar | levels | 5m | 56.0 | 100 | 3.61 | 6.24 | 114.84 | 1.15 |
| 65 | sfp+fibonacci | levels | 4h | 56.0 | 25 | 2.97 | 7.09 | 21.68 | 0.87 |
| 66 | divergence+fibonacci | vwap | 1m | 55.8 | 4270 | 2.31 | 17.48 | 2477.11 | 0.58 |
| 67 | sfp+fibonacci | vwap | 4h | 55.6 | 36 | 1.25 | 9.82 | 3.92 | 0.11 |
| 68 | cvd_divergence+pinbar | vwap | 5m | 55.1 | 136 | 3.16 | 7.82 | 131.64 | 0.97 |
| 69 | divergence+cvd_divergence | vwap | 5m | 55.1 | 864 | 1015.09 | 8.00 | 393466.17 | 455.40 |
| 70 | cvd_divergence+fibonacci | vwap | 5m | 55.1 | 1340 | 2.06 | 14.55 | 636.07 | 0.47 |
| 71 | cvd_divergence+fibonacci | vwap | 1h | 55.0 | 111 | 1.40 | 12.17 | 20.01 | 0.18 |
| 72 | divergence+cvd_divergence | vwap | 1m | 54.9 | 6497 | 939.50 | 12.00 | 2750733.81 | 423.39 |
| 73 | divergence+fibonacci | levels | 1m | 54.7 | 5818 | 2.17 | 16.94 | 3088.87 | 0.53 |
| 74 | divergence+fibonacci | levels | 5m | 54.7 | 935 | 1.82 | 11.65 | 348.16 | 0.37 |
| 75 | sfp+divergence | vwap | 5m | 54.6 | 324 | 2.73 | 8.00 | 254.55 | 0.79 |
| 76 | sfp+cvd_divergence | vwap | 1h | 54.5 | 99 | 2.66 | 5.00 | 74.79 | 0.76 |
| 77 | divergence+pinbar | levels | 15m | 54.5 | 22 | 3.48 | 3.00 | 24.80 | 1.13 |
| 78 | cvd_divergence+pinbar | vwap | 15m | 53.8 | 26 | 3.40 | 3.10 | 28.83 | 1.11 |
| 79 | cvd_divergence+pinbar | vpvr | 5m | 53.6 | 56 | 2.34 | 6.00 | 34.95 | 0.62 |
| 80 | divergence+fibonacci | levels | 1h | 53.5 | 43 | 1.17 | 5.00 | 3.41 | 0.08 |
| 81 | sfp+fibonacci | vwap | 15m | 53.4 | 815 | 1.03 | 40.68 | 12.27 | 0.02 |
| 82 | sfp+fibonacci | vwap | 1m | 53.0 | 9294 | 1.28 | 41.67 | 1231.84 | 0.13 |
| 83 | divergence+cvd_divergence | vwap | 1h | 52.7 | 93 | 20.71 | 6.00 | 867.29 | 9.33 |
| 84 | cvd_divergence+fibonacci | levels | 1m | 52.3 | 7351 | 2.13 | 21.39 | 3976.92 | 0.54 |
| 85 | cvd_divergence+fibonacci | vpvr | 1h | 52.2 | 23 | 1.73 | 3.58 | 8.04 | 0.35 |
| 86 | cvd_divergence+fibonacci | vwap | 1m | 52.1 | 6825 | 2.21 | 25.04 | 3947.89 | 0.58 |
| 87 | sfp+fibonacci | levels | 1m | 51.7 | 10418 | 1.29 | 40.68 | 1456.34 | 0.14 |
| 88 | sfp+pinbar | levels | 1h | 51.6 | 31 | 3.52 | 5.62 | 37.87 | 1.22 |
| 89 | cvd_divergence+pinbar | levels | 5m | 51.0 | 149 | 2.54 | 7.08 | 112.14 | 0.75 |
| 90 | sfp+fibonacci | vwap | 5m | 51.0 | 2174 | 1.43 | 23.01 | 453.34 | 0.21 |
| 91 | fibonacci+pinbar | vwap | 1m | 50.8 | 1385 | 1.54 | 34.81 | 368.95 | 0.27 |
| 92 | fibonacci+pinbar | vwap | 5m | 50.8 | 305 | 1.53 | 30.60 | 79.45 | 0.26 |
| 93 | cvd_divergence+fibonacci | levels | 5m | 50.6 | 1439 | 1.64 | 18.49 | 455.43 | 0.32 |
| 94 | divergence+pinbar | levels | 1m | 50.3 | 505 | 18.80 | 9.56 | 4468.51 | 8.85 |
| 95 | sfp+fibonacci | levels | 1h | 50.3 | 181 | 1.50 | 10.09 | 44.77 | 0.25 |
| 96 | divergence+fibonacci | vpvr | 1m | 50.2 | 2617 | 1.77 | 16.87 | 1000.03 | 0.38 |
| 97 | divergence+fibonacci | vpvr | 5m | 50.2 | 478 | 1.52 | 17.25 | 124.35 | 0.26 |
| 98 | divergence+fibonacci | levels | 15m | 50.2 | 243 | 2.22 | 9.91 | 147.04 | 0.61 |
| 99 | cvd_divergence+fibonacci | vpvr | 1m | 50.2 | 2420 | 1.82 | 23.69 | 987.42 | 0.41 |
| 100 | divergence+pinbar | vwap | 1m | 50.2 | 313 | 2.62 | 10.67 | 252.43 | 0.81 |
| 101 | sfp+fibonacci | levels | 5m | 50.1 | 2404 | 1.42 | 30.01 | 498.85 | 0.21 |
| 102 | sfp+divergence | vwap | 1m | 50.0 | 2036 | 2.83 | 13.30 | 1865.26 | 0.92 |
| 103 | cvd_divergence+fibonacci | vwap | 4h | 50.0 | 20 | 2.67 | 5.00 | 16.67 | 0.83 |
| 104 | cvd_divergence+fibonacci | vpvr | 4h | 50.0 | 8 | 2.51 | 3.00 | 6.03 | 0.75 |
| 105 | divergence+fibonacci | vpvr | 4h | 50.0 | 6 | 3.17 | 2.00 | 6.50 | 1.08 |
| 106 | fibonacci+pinbar | vpvr | 4h | 50.0 | 6 | 0.57 | 3.00 | -1.28 | -0.21 |
| 107 | cvd_divergence+market_structure | levels | 1h | 50.0 | 4 | 0.12 | 2.00 | -1.76 | -0.44 |
| 108 | sfp+market_structure | vpvr | 5m | 50.0 | 2 | 0.01 | 1.00 | -0.99 | -0.49 |
| 109 | cvd_divergence+pinbar | levels | 1m | 49.9 | 753 | 13.02 | 18.75 | 4532.70 | 6.02 |
| 110 | cvd_divergence+pinbar | vwap | 1m | 49.9 | 633 | 3.09 | 12.73 | 662.60 | 1.05 |
| 111 | cvd_divergence+fibonacci | vpvr | 5m | 49.7 | 485 | 1.77 | 12.58 | 189.07 | 0.39 |
| 112 | divergence+cvd_divergence | levels | 1m | 49.5 | 8949 | 885.23 | 13.87 | 3999366.93 | 446.91 |
| 113 | cvd_divergence+fibonacci | levels | 1h | 49.4 | 89 | 1.66 | 9.06 | 29.60 | 0.33 |
| 114 | sfp+divergence | vwap | 1h | 49.1 | 57 | 2.75 | 7.62 | 50.79 | 0.89 |
| 115 | cvd_divergence+fibonacci | levels | 15m | 48.7 | 454 | 1.89 | 19.63 | 208.11 | 0.46 |
| 116 | fibonacci+pinbar | levels | 1m | 48.4 | 1417 | 1.47 | 49.04 | 343.65 | 0.24 |
| 117 | divergence+pinbar | vwap | 5m | 48.3 | 60 | 3.25 | 6.24 | 69.84 | 1.16 |
| 118 | sfp+divergence | levels | 15m | 48.3 | 209 | 2.42 | 11.00 | 153.32 | 0.73 |
| 119 | divergence+cvd_divergence | levels | 5m | 48.0 | 1392 | 615.80 | 11.00 | 445117.83 | 319.77 |
| 120 | sfp+divergence | levels | 5m | 47.5 | 649 | 2.79 | 13.00 | 610.90 | 0.94 |
| 121 | fibonacci+pinbar | vwap | 1h | 47.4 | 19 | 0.43 | 8.00 | -5.72 | -0.30 |
| 122 | cvd_divergence+fibonacci | vpvr | 15m | 47.3 | 169 | 1.50 | 8.96 | 44.88 | 0.27 |
| 123 | fibonacci+pinbar | vpvr | 15m | 46.9 | 32 | 1.28 | 7.96 | 4.80 | 0.15 |
| 124 | sfp+fibonacci | levels | 15m | 46.7 | 946 | 1.28 | 32.63 | 142.28 | 0.15 |
| 125 | sfp+pinbar | vwap | 1h | 46.7 | 15 | 3.21 | 5.37 | 17.67 | 1.18 |
| 126 | fibonacci+pinbar | levels | 5m | 46.6 | 348 | 1.32 | 31.70 | 59.32 | 0.17 |
| 127 | sfp+fibonacci | vpvr | 5m | 46.2 | 783 | 1.55 | 31.77 | 230.61 | 0.29 |
| 128 | sfp+cvd_divergence | levels | 1h | 46.1 | 102 | 2.35 | 6.33 | 74.51 | 0.73 |
| 129 | sfp+pinbar | vwap | 1m | 45.4 | 1465 | 1.66 | 34.09 | 524.07 | 0.36 |
| 130 | sfp+divergence | levels | 1m | 45.2 | 3802 | 2.45 | 21.00 | 3027.48 | 0.80 |
| 131 | divergence+cvd_divergence | vwap | 4h | 45.0 | 20 | 25.02 | 6.00 | 264.25 | 13.21 |
| 132 | sfp+cvd_divergence | vwap | 1m | 44.7 | 5500 | 2.29 | 22.16 | 3912.00 | 0.71 |
| 133 | divergence+fibonacci | vpvr | 15m | 44.6 | 166 | 1.25 | 9.80 | 23.46 | 0.14 |
| 134 | sfp+pinbar | vpvr | 5m | 44.4 | 108 | 1.83 | 9.00 | 50.07 | 0.46 |
| 135 | sfp+cvd_divergence | vwap | 5m | 44.4 | 1113 | 2.00 | 16.32 | 619.19 | 0.56 |
| 136 | sfp+fibonacci | vpvr | 1m | 44.3 | 3432 | 1.28 | 76.91 | 535.93 | 0.16 |
| 137 | cvd_divergence+pinbar | vpvr | 1m | 44.3 | 296 | 2.34 | 13.97 | 221.77 | 0.75 |
| 138 | sfp+cvd_divergence | levels | 1m | 44.2 | 6779 | 2.24 | 23.24 | 4675.94 | 0.69 |
| 139 | sfp+cvd_divergence | levels | 5m | 43.8 | 1406 | 2.13 | 18.36 | 890.97 | 0.63 |
| 140 | sfp+pinbar | levels | 1m | 43.8 | 1684 | 1.68 | 29.92 | 646.95 | 0.38 |
| 141 | divergence+fibonacci | vpvr | 1h | 43.5 | 23 | 1.08 | 5.48 | 1.09 | 0.05 |
| 142 | fibonacci+pinbar | levels | 15m | 43.4 | 76 | 1.08 | 10.32 | 3.54 | 0.05 |
| 143 | sfp+cvd_divergence | levels | 15m | 43.3 | 496 | 1.90 | 10.82 | 253.63 | 0.51 |
| 144 | divergence+cvd_divergence | levels | 15m | 42.9 | 396 | 648.38 | 10.00 | 146308.84 | 369.47 |
| 145 | divergence+cvd_divergence | vpvr | 5m | 42.7 | 907 | 1411.65 | 13.00 | 733540.15 | 808.75 |
| 146 | sfp+divergence | vpvr | 5m | 42.4 | 483 | 2.09 | 17.85 | 302.17 | 0.63 |
| 147 | divergence+cvd_divergence | levels | 1h | 42.2 | 64 | 8.69 | 9.00 | 284.35 | 4.44 |
| 148 | sfp+fibonacci | vpvr | 15m | 42.1 | 328 | 1.16 | 21.64 | 30.74 | 0.09 |
| 149 | sfp+pinbar | vwap | 5m | 41.9 | 265 | 1.43 | 29.96 | 66.83 | 0.25 |
| 150 | divergence+pinbar | vpvr | 1m | 41.7 | 314 | 2.46 | 14.64 | 266.43 | 0.85 |
| 151 | sfp+cvd_divergence | vpvr | 5m | 40.9 | 558 | 1.97 | 14.60 | 318.56 | 0.57 |
| 152 | sfp+cvd_divergence | vpvr | 1m | 40.7 | 3038 | 2.20 | 37.55 | 2157.59 | 0.71 |
| 153 | fibonacci+pinbar | vpvr | 1m | 40.5 | 504 | 1.13 | 51.29 | 39.59 | 0.08 |
| 154 | sfp+cvd_divergence | vpvr | 1h | 40.4 | 47 | 1.89 | 8.56 | 25.01 | 0.53 |
| 155 | divergence+cvd_divergence | vpvr | 1m | 40.1 | 5025 | 666.07 | 20.28 | 2001863.85 | 398.38 |
| 156 | sfp+fibonacci | vwap | 1d | 40.0 | 5 | 0.37 | 3.00 | -1.90 | -0.38 |
| 157 | divergence+cvd_divergence | vpvr | 1h | 39.3 | 61 | 13.82 | 6.00 | 474.46 | 7.78 |
| 158 | sfp+divergence | vpvr | 15m | 39.2 | 181 | 1.83 | 10.61 | 90.89 | 0.50 |
| 159 | sfp+pinbar | levels | 15m | 38.5 | 96 | 0.81 | 17.13 | -11.22 | -0.12 |
| 160 | sfp+pinbar | vpvr | 1m | 38.0 | 623 | 1.51 | 40.39 | 196.15 | 0.31 |
| 161 | sfp+cvd_divergence | vpvr | 15m | 38.0 | 208 | 1.54 | 11.83 | 70.29 | 0.34 |
| 162 | sfp+cvd_divergence | vwap | 4h | 37.9 | 29 | 1.68 | 6.51 | 12.27 | 0.42 |
| 163 | sfp+divergence | vpvr | 1m | 37.8 | 2690 | 2.02 | 29.80 | 1714.37 | 0.64 |
| 164 | cvd_divergence+pinbar | vpvr | 1h | 37.5 | 8 | 3.08 | 2.00 | 10.40 | 1.30 |
| 165 | fibonacci+pinbar | vpvr | 5m | 37.2 | 121 | 0.89 | 18.61 | -8.50 | -0.07 |
| 166 | sfp+divergence | vpvr | 1h | 36.6 | 41 | 1.57 | 10.00 | 14.75 | 0.36 |
| 167 | sfp+pinbar | vwap | 15m | 36.3 | 80 | 0.97 | 18.25 | -1.64 | -0.02 |
| 168 | fibonacci+pinbar | vwap | 15m | 35.6 | 59 | 0.52 | 19.20 | -18.22 | -0.31 |
| 169 | sfp+divergence | levels | 1h | 35.6 | 45 | 1.22 | 11.40 | 6.32 | 0.14 |
| 170 | sfp+fibonacci | vpvr | 1h | 35.2 | 71 | 0.82 | 10.63 | -8.10 | -0.11 |
| 171 | divergence+cvd_divergence | vpvr | 15m | 34.9 | 318 | 762.01 | 16.00 | 157528.48 | 495.37 |
| 172 | fibonacci+pinbar | levels | 1h | 33.3 | 27 | 0.59 | 14.61 | -7.42 | -0.27 |
| 173 | divergence+pinbar | levels | 1h | 33.3 | 6 | 0.85 | 3.33 | -0.61 | -0.10 |
| 174 | divergence+pinbar | vpvr | 1h | 33.3 | 6 | 0.71 | 2.00 | -1.15 | -0.19 |
| 175 | divergence+cvd_divergence | levels | 4h | 33.3 | 3 | 10.99 | 1.00 | 19.98 | 6.66 |
| 176 | cvd_divergence+fibonacci | vwap | 1d | 33.3 | 3 | 1.06 | 2.00 | 0.12 | 0.04 |
| 177 | sfp+pinbar | levels | 5m | 33.0 | 358 | 0.82 | 53.57 | -44.37 | -0.12 |
| 178 | sfp+divergence | vwap | 4h | 31.3 | 16 | 1.93 | 6.00 | 10.21 | 0.64 |
| 179 | divergence+cvd_divergence | vpvr | 4h | 28.6 | 14 | 22.51 | 5.00 | 215.06 | 15.36 |
| 180 | sfp+pinbar | vpvr | 15m | 27.9 | 43 | 0.65 | 13.74 | -10.95 | -0.25 |
| 181 | sfp+fibonacci | vpvr | 4h | 21.4 | 14 | 0.20 | 9.21 | -8.77 | -0.63 |
| 182 | divergence+pinbar | vwap | 1h | 20.0 | 5 | 0.22 | 3.14 | -3.14 | -0.63 |
| 183 | sfp+cvd_divergence | vpvr | 4h | 18.2 | 11 | 0.30 | 6.85 | -6.32 | -0.57 |
| 184 | sfp+pinbar | vpvr | 1h | 14.3 | 7 | 2.90 | 5.00 | 11.42 | 1.63 |
| 185 | cvd_divergence+fibonacci | levels | 4h | 14.3 | 7 | 1.57 | 3.00 | 3.43 | 0.49 |
| 186 | divergence+pinbar | vpvr | 15m | 13.3 | 15 | 0.25 | 9.81 | -9.81 | -0.65 |
| 187 | cvd_divergence+pinbar | vpvr | 15m | 12.5 | 8 | 0.41 | 5.00 | -4.13 | -0.52 |
| 188 | fibonacci+pinbar | vpvr | 1h | 12.5 | 8 | 0.03 | 6.79 | -6.79 | -0.85 |
| 189 | sfp+divergence | vpvr | 4h | 9.1 | 11 | 0.58 | 9.00 | -4.23 | -0.38 |
| 190 | sfp+cvd_divergence | levels | 4h | 0.0 | 10 | 0.00 | 10.00 | -10.00 | -1.00 |
| 191 | sfp+divergence | levels | 4h | 0.0 | 6 | 0.00 | 6.00 | -6.00 | -1.00 |
| 192 | sfp+cvd_divergence | vwap | 1d | 0.0 | 3 | 0.00 | 3.00 | -3.00 | -1.00 |
| 193 | sfp+pinbar | vpvr | 4h | 0.0 | 3 | 0.00 | 3.00 | -3.00 | -1.00 |
| 194 | fibonacci+pinbar | levels | 4h | 0.0 | 3 | 0.00 | 3.00 | -3.00 | -1.00 |
| 195 | sfp+pinbar | levels | 4h | 0.0 | 2 | 0.00 | 2.00 | -2.00 | -1.00 |
| 196 | divergence+fibonacci | levels | 4h | 0.0 | 2 | 0.00 | 2.00 | -2.00 | -1.00 |
| 197 | sfp+market_structure | vpvr | 1h | 0.0 | 1 | 0.00 | 1.00 | -1.00 | -1.00 |
| 198 | sfp+pinbar | vwap | 4h | 0.0 | 1 | 0.00 | 1.00 | -1.00 | -1.00 |
| 199 | divergence+market_structure | vpvr | 1m | 0.0 | 1 | 0.00 | 1.00 | -1.00 | -1.00 |
| 200 | cvd_divergence+market_structure | vpvr | 1h | 0.0 | 1 | 0.00 | 1.00 | -1.00 | -1.00 |
| 201 | cvd_divergence+pinbar | levels | 4h | 0.0 | 1 | 0.00 | 1.00 | -1.00 | -1.00 |
| 202 | cvd_divergence+pinbar | vwap | 4h | 0.0 | 1 | 0.00 | 1.00 | -1.00 | -1.00 |
| 203 | fibonacci+market_structure | vpvr | 1h | 0.0 | 1 | 0.00 | 1.00 | -1.00 | -1.00 |
| 204 | market_structure+pinbar | vwap | 1h | 0.0 | 1 | 0.00 | 1.00 | -1.00 | -1.00 |
</details>
