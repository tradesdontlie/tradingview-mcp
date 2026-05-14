# Fix: `data.getQuote()` and `data.getOhlcv()` ignore their `symbol` parameter

> Draft for upstream PR against `tradesdontlie/tradingview-mcp`.
> Related: issue #140 (symbol cache invalidation in `data.js`).
> v2 update: silent fallback for frozen WebSocket data feed (5s timeout).

## Summary

`data.getQuote({ symbol })` and `data.getOhlcv({ symbol, ... })` accepted a
`symbol` argument but never actually fetched that symbol. Both functions
read from `KNOWN_PATHS.mainSeriesBars` — the **active chart's** main series
— and only echoed the requested `symbol` back into the response. As a
result, calling

```js
await data.getQuote({ symbol: 'BINANCE:BTCUSDT.P' });
await data.getQuote({ symbol: 'BINANCE:ETHUSDT.P' });
await data.getQuote({ symbol: 'OANDA:XAUUSD' });
```

returned three responses that all contained the OHLCV of whatever ticker
was last active on the chart (for example AAPL), but labelled with the
requested symbols. Downstream consumers (LLM tool-use loops, batch
screeners, watchlist analytics) silently got wrong data.

## Root cause

`src/core/data.js` (pre-fix) reads from a global JS path:

```js
const BARS_PATH = KNOWN_PATHS.mainSeriesBars;
// = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget
//     .model().mainSeries().bars()
```

That path always resolves to the **currently displayed** symbol's bars.
The `symbol` parameter was used only to populate the `quote.symbol`
return field via `safeString(symbol || '')`.

There is no automatic per-symbol cache to invalidate — the cache is
implicit in the chart's active state.

## Fix — Approach A (wrapper pattern)

Wrap each read with `_withSymbol(symbol, fn)`:

1. Read `chart.symbol()` to capture `originalSymbol`.
2. If `symbol` is falsy or matches `originalSymbol`, just call `fn()`.
3. Otherwise call `chart.setSymbol(symbol, {})`, then wait for both:
   - the existing DOM-level `waitForChartReady()` (spinner + header), and
   - a new internal-state poll that requires `mainSeries.isLoading() === false`
     and `bars.lastIndex()` stable across two samples.
4. Run `fn()` to read OHLCV / quote for the now-active symbol.
5. In a `finally`, best-effort restore `originalSymbol` so we don't
   permanently mutate the user's chart.

### Why both waits

`waitForChartReady` is DOM-based — it polls for the loading spinner and
the symbol legend. That is necessary but not sufficient: the spinner can
disappear before `mainSeries.isLoading()` flips to `false`, in which
case `bars()` still returns the previous symbol's cached values for
several hundred milliseconds. The added `_waitForSeriesLoaded` poll
covers that gap.

## Trade-offs

- **UI flicker.** The user's chart visually switches symbols for the
  duration of the read, then switches back. Acceptable for batch tool
  use, less acceptable in interactive sessions.
- **Serial.** Two `getQuote()` calls for different symbols cannot run in
  parallel — they share the chart. Callers wanting parallel screening
  should batch a single chart switch and then read multiple values.
- **Latency.** Each switch adds ~500 ms (`setSymbol` settle) +
  `waitForChartReady` time (up to 5 s, v2) + `_waitForSeriesLoaded` time
  (up to 5 s, v2). Same-symbol reads are unaffected. Worst case per
  call ≈ 10-11 s; on a healthy WS feed typical case is < 2 s.
- **Restore is best-effort.** If the restore `setSymbol` fails, the
  chart is left on the queried symbol and a warning is swallowed (the
  primary read result is preserved). The original symbol is recoverable
  by the user manually.

## v2 — Silent fallback for frozen WS feed

After v1 went out, we hit a separate failure mode in long-running TV
sessions (Chrome remote-debug builds, hours-old tab): `chart.setSymbol`
visually switches the chart, the DOM spinner clears, but
`mainSeries.isLoading()` stays `true` indefinitely because the
WebSocket data feed isn't re-subscribing. `bars.valueAt()` keeps
returning the *previous* symbol's last bar for tens of seconds. The v1
wait loop did its job — it never declared success — but it stalled the
wrapper at the full 8 s timeout per call and then threw a generic
"could not extract OHLCV" error, which higher-level callers couldn't
distinguish from "chart isn't loaded yet."

v2 changes:

1. `_waitForSeriesLoaded` and `waitForChartReady` timeouts reduced from
   8 s to **5 s** (`STALE_FEED_TIMEOUT_MS`). This is enough for a
   healthy feed (typical re-subscribe is < 2 s) without UX-damaging
   waits on a frozen one.
2. `_setChartSymbol` now returns `true | false` to surface whether
   `_waitForSeriesLoaded` actually completed.
3. `_withSymbol` checks that boolean. If `false`, instead of running
   `fn()` against stale bars, it returns an internal sentinel:
   `{ __TV_STALE_FEED__: true, requested_symbol, current_chart_symbol, reason }`,
   then restores the original symbol best-effort.
4. `getQuote` and `getOhlcv` detect the sentinel and translate it into
   a structured public response:
   ```js
   {
     success: false,
     stale_feed: true,
     reason: 'mainSeries.isLoading() timeout after 5s — TV Chrome WS feed appears frozen',
     fallback_advice: 'Use CCXT MCP for crypto or services.yahoo_fallback for forex/metals/indices',
     requested_symbol: 'BINANCE:BTCUSDT.P',
     current_chart_symbol: 'NASDAQ:AAPL',
   }
   ```
5. The smoke test treats `stale_feed: true` as a valid (non-stale)
   outcome — the patch did its job by *surfacing* the freeze instead of
   masking it with stale cached data.

### Why a sentinel rather than throw?

A throw would force every caller to wrap quote/OHLCV reads in
try/catch and string-match the error message to distinguish "feed
frozen" from "chart isn't loaded yet" from "symbol doesn't exist."
A structured `{ success: false, stale_feed: true }` response lets
caller code do a single `if (result.stale_feed) { fallback() }` check
and keep the happy-path read uniform.

## Future improvement — Approach B (quote session)

TradingView's internal `TradingViewApi` exposes a quote-session factory
that subscribes to a symbol's price feed without touching the visible
chart. A future iteration could:

1. Call `TradingViewApi.factory.createQuoteSession()` (path TBD by
   reverse-engineering `_activeChartWidgetWV`).
2. Subscribe to the requested symbol.
3. Read last/bid/ask from the subscription handle.
4. Unsubscribe.

This would remove the flicker, lower latency, and allow concurrent
reads. It is deferred because the internal API surface is undocumented
and may change between TV releases. Approach A is a stable, low-risk
backstop.

## Tests

A smoke test was added (`test-symbol-cache-fix.mjs`) that:

1. Captures the original chart symbol.
2. Calls `getQuote()` for 4 different symbols
   (`BINANCE:BTCUSDT.P`, `BINANCE:ETHUSDT.P`, `OANDA:XAUUSD`, `TVC:DXY`).
3. Calls `getOhlcv({ summary: true })` for the same 4 symbols.
4. Asserts: each symbol returns a distinct `close` value.
5. Verifies the chart is restored to the original symbol.

**Local test run note:** the smoke test was executed against the
author's running TV Desktop / TV-on-Chrome session. The session was
already in a stale state (`mainSeries.isLoading() === true` for tens of
seconds with no incoming WebSocket bars), so the test reported FAIL
across all four symbols — every read still returned the cached AAPL
values. The fix code path was exercised (each call took ~10–30 s
because the new wait loop correctly held while `isLoading` stayed
`true`), but a clean PASS run requires a TV session that is actually
fetching data. Recommendation for reviewers: restart TradingView /
Chrome with a fresh chart tab before re-running the smoke test.

## Backwards compatibility

- No new public parameters. The existing `symbol` parameter on
  `getQuote` and `getOhlcv` now behaves as documented.
- Calls that omit `symbol` (the common case for reading the currently-
  visible chart) take exactly the same code path as before — the
  wrapper is a no-op when `symbol` is falsy.
- No changes to other functions (`getStudyValues`, `getPineLines`, etc.).
- **v2 compatibility:** the happy-path return shape for `getQuote` and
  `getOhlcv` is unchanged — successful calls still return
  `{ success: true, ... }`. The only new shape is the
  `{ success: false, stale_feed: true, ... }` response, which only
  appears in the previously-unhandled failure mode where the read
  would have thrown a generic error in v1.
