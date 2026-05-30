Run the full pre-session watchlist scan across all 5 permitted instruments using the trading methodology in memory.

Instruments to scan in order: MES → M2K → MGC → MNQ → MBT

For each instrument run the full sequence:
1. Switch chart to that instrument (15m timeframe)
2. Step 1 — Daily Bias (D1): switch to D timeframe, read RSI + RSI-based MA → LONG or SHORT bias
3. Step 2 — 4H Signal: switch to 240 timeframe, read RSI gap (|RSI − MA|). Gap ≥ 10 = Swing candidate, 5–9 = Surgical only, < 5 = skip
4. Step 3 — 15m Signal: switch to 15 timeframe, read RSI gap
5. Step 4 — 5m Signal: switch to 5 timeframe, read RSI gap
6. Step 4b — MACD Confirmation: read MACD histogram on 5m — confirm direction matches RSI gap
7. Step 5 — OHLCV Momentum: data_get_ohlcv with summary=true, count=10
8. Step 6 — Volume: check if last 3 bars show increasing volume in trade direction
9. Step 7 — Quote: get current live price

After scanning all 5, produce a ranked summary table:

| Rank | Instrument | D1 Bias | 4H Gap | 15m Gap | 5m Gap | MACD | Mode | Grade |
|------|-----------|---------|--------|---------|--------|------|------|-------|

Then give a clear recommendation:
- Which instrument to trade first (#1 priority)
- Which mode (Swing or Surgical)
- Direction (Long or Short)
- What to watch for (entry trigger)
- Any instruments to skip and why

Apply all mode selection rules from the methodology:
- 4H gap ≥ 10 → Swing Scalp
- 4H gap 5–9 → Surgical only
- 4H gap < 5 → skip
- MNQ and MBT → Swing only regardless of gap
- MGC Surgical → requires 5m gap ≥ 9
- Midday (11:30–2:00 PM EST) → Surgical suspended
- Major news within 30 min → no new trades
