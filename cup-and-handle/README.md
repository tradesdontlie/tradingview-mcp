# Cup-and-Handle Pattern Watch

This directory contains an original, clean-room Cup-and-Handle detector for
TradingView. It is informed by TradingView's public pattern documentation, not
by copied, extracted, or reverse-engineered proprietary source code.

## First-slice scope

- Bullish Cup-and-Handle only.
- Native `4H`, `1D`, and `1W` charts.
- Closed-bar, causal calculations.
- A pure JavaScript reference detector plus a Pine v6 overlay.
- Machine-readable lifecycle stages and transition alerts.
- One chart symbol at a time. Watchlist scanners come later.

The detector is an attention tool named **Pattern Watch**. It is not a trading
strategy, a buy signal, or a claim that a pattern predicts returns.

## Public TradingView behavior used as a specification

TradingView publicly documents these Cup-and-Handle behaviors:

- Search the most recent 600 bars.
- Use 5-left/5-right pivots for the structural points.
- Require a cup at least 20 bars wide.
- Place the cup low near the horizontal center.
- Keep the two rims approximately level.
- Limit handle rollback relative to cup height.
- Do not allow the handle to outlive the cup.
- Support in-progress patterns.
- Confirm breakout from a close above the handle line.
- Prefer an awaiting pattern, then the more U-shaped cup, when patterns overlap.
- Leave the optional prior-trend rollback check disabled by default.

Source: <https://www.tradingview.com/support/solutions/43000732556-chart-pattern-cup-and-handle/>

TradingView does not publish its source or exact formulas for center tolerance,
U-shape quality, plateau handling, default deviations, or provisional handle
selection. Our definitions for those items are explicit in
`analysis/frozen-v0-cup-handle.json` and are intended to be calibrated from
human-reviewed chart labels.

## Lifecycle

```text
NONE
  -> CUP_FORMING
  -> RIM_APPROACH
  -> HANDLE_FORMING
  -> HANDLE_READY
  -> BREAKOUT_CONFIRMED

Any confirmed pattern can instead become INVALIDATED or EXPIRED.
```

Anchor timestamps describe where the geometry is drawn. Detection timestamps
identify both the open and close of the bar on which the information became
knowable. A 5/5 pivot is never used until five later closed bars exist.

Provisional alerts share a `family_id` based on the left rim and cup bottom.
Once the right rim confirms, the final `pattern_id` also contains point 3, so a
different confirmed right rim is a new pattern. Every runtime threshold is
encoded in the configuration identity carried by detector events.

## Files

- `analysis/cup-handle-core.mjs` — deterministic reference implementation.
- `analysis/frozen-v0-cup-handle.json` — public rules, tunable defaults, and
  explicit non-goals.
- `analysis/live-qa-v0.json` — source-bound historical 0.1.0 TradingView
  runtime-matrix, screenshot-hash, and cleanup receipt; superseded after the
  independent review found lifecycle defects.
- `analysis/verification-0.1.1.json` — current source hashes, regression checks,
  TradingView compile-only result, and exact remaining verification boundary.
- `cup-and-handle.pine` — TradingView overlay and alert surface.
- `../tests/cup_handle_core.test.js` — geometry, lifecycle, and causality tests.
- `../tests/cup_handle_pine_contract.test.js` — static Pine safety contract.

## Alert choices

TradingView exposes six conditions after the indicator is added to a chart:

- **Forming Watch** — early `CUP_FORMING` or `RIM_APPROACH` heads-up.
- **Confirmed Cup / Handle Forming** — a causal right rim exists and the handle
  is still developing.
- **Handle Ready** — the handle pivot exists and price has not yet broken out.
- **Breakout Confirmed** — a closed bar crossed above the handle line.
- **Invalidated or Expired** — the active setup failed or aged out.
- **Any Lifecycle Event** — one combined event stream.

The first two are the useful attention alerts for the initial calibration.
Each transition fires once per pattern on a closed chart-timeframe bar. The
dynamic `alert()` payload includes the symbol, timeframe, stage, pattern IDs,
pivot, invalidation level, quality, version, and full runtime configuration.

Unlike TradingView's documented overlap preference, V0 follows one active
pattern family per chart and does not queue overlapping families. A newer setup
can therefore be missed while another valid setup is active. The broad
candidate generator for calibration cards must not inherit that
restriction. V0 follows the documented default of leaving the optional prior-
trend rollback gate disabled; the human-labeled examples can tell us whether a
stricter gate would make the alerts more useful.

## Local verification

```sh
npm run test:cup-handle
node src/cli/index.js pine analyze --file "cup-and-handle/cup-and-handle.pine"
```

The 0.1.0 Pine source completed a live seven-case matrix on AAPL and BTC across
4H, 1D, and 1W, plus a 1M fail-closed check. The disposable study, cloud script,
and chart tab were removed afterward; the original chart and alert definitions
were re-verified unchanged. Independent review then found lifecycle defects in
that exact build, so its matrix is retained as historical integration evidence,
not as acceptance evidence for the current source.

Version 0.1.1 fixes the reproduced post-breakout re-arming, stale provisional,
pre-handle upside-escape, and late historical-right-rim paths. The exact 0.1.1
Pine source passes TradingView's server compiler with zero errors and warnings,
the local analyzer reports zero issues, and all 35 focused tests pass. It has
not yet been applied to a live chart.

The historical matrix proves basic integration and runtime behavior, not signal
quality for the current source.
No alert was activated, no replay-vs-live Pine trace was produced, and the
Pine/JavaScript implementations do not yet have per-bar parity evidence. This
therefore remains a calibration draft until the 0.1.1 source receives a fresh
chart runtime check and representative good, early, late, and rejected
formations are labeled against a frozen acceptance set.
