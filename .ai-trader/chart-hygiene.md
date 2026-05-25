# Chart Hygiene Rules

## After Any Symbol / Timeframe / Layout Change
1. Verify chart scaling is not distorted (vertical or horizontal).
2. If distorted: pause analysis, reset/fix scale, then re-verify.
3. Never output LONG or SHORT from a distorted chart.

## Scaling Check
- Price action should fill ~70-80% of vertical space.
- No extreme whitespace above or below price.
- Bars should be visible — not crushed or stretched horizontally.
- If auto-scale is off and price is off-screen: re-enable auto-scale.

## Indicator Visibility
- Pine graphics (lines, labels, boxes, tables) only work when indicator is visible on chart.
- If a key indicator is hidden, unhide before reading Pine objects.

## Multi-Symbol Workflow
- When switching symbols via batch_run or chart_set_symbol, always call quote_get after switch to confirm active symbol.
- Do not carry over levels from prior symbol.

## Screenshot Policy
- Take screenshots for visual confirmation after data analysis is complete.
- Never skip data tools in favor of screenshot-only analysis.
- If screenshot shows something inconsistent with data, trust data first, then investigate.
