---
name: chart-control
description: Use for safe TradingView chart-only operations through MCP: checking the current chart, changing symbol/timeframe/chart type, reading study inventory, and verifying the result without touching Pine Editor slots or relaunching TradingView.
---

# Chart Control

Use this skill for chart-only requests such as "what chart am I on?" or
"change the timeframe to 1h."

## Core Rule

Chart control is not Pine editing. Do not call Pine Editor write tools, do not
push Pine, and do not relaunch or kill TradingView for chart-only changes.

## Safe Flow

1. Run `tv_health_check` or `chart_get_state`.
2. Apply the requested chart-only change:
   - timeframe: `chart_set_timeframe`
   - symbol: `chart_set_symbol`
   - chart type: `chart_set_type`
3. Verify with `chart_get_state`.
4. Report the actual symbol, resolution, and loaded studies.

## Timeframe Inputs

The MCP chart timeframe tool accepts common operator wording:

- `1`, `5`, `15`, `60`
- `1m`, `5m`, `15 minutes`
- `1h`, `4h`
- `D`, `W`, `M`

Hour aliases normalize to TradingView minute counts, so `1h` becomes `60`.

## Fallback Discipline

If an MCP wrapper drops arguments or reports a schema error, first verify that
the server is running the legacy-schema conversion in `src/tool-schema.js`.

Only use direct CDP evaluation as a temporary diagnostic fallback. If direct
Node/CDP is used, close the returned client in a `finally` block so no helper
process stays alive after success.

## Stop Conditions

- Pine Editor write is required.
- TradingView needs to be relaunched.
- A chart-only operation would alter study inputs, delete indicators, or touch
  a production Pine slot.

Stop and ask for explicit approval before any of those.
