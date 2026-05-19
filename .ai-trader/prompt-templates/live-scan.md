# Live Scan Prompt Template

Use this to scan one or more symbols for active setups.

---

Scan [SYMBOL(S)] on [TIMEFRAME] for active setups.

Steps:
1. quote_get → current price
2. data_get_study_values → indicator readings
3. data_get_pine_labels → key levels and bias
4. data_get_pine_lines → structural price levels
5. data_get_pine_boxes → FVG / zone context
6. data_get_ohlcv (summary:true) → price action summary
7. capture_screenshot → visual confirmation

Then output signal in required format:

---
Decision: LONG / SHORT / WAIT
Symbol:
Timeframe:
Bias:
Setup type:
Entry zone:
Stop:
TP1:
TP2:
Calculated R:
Confidence: HIGH / MEDIUM / LOW
Reasons:
Invalidation:
What would change this decision:
---
