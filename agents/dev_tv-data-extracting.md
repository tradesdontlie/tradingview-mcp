# TradingView Data Retrieval Algorithm Overview

This document outlines the internal mechanics of how the TradingView MCP server extracts live data from the TradingView Desktop application using the Chrome DevTools Protocol (CDP).

## 1. Connection Architecture

The MCP server functions as a headless debugger communicating with TradingView Desktop (which is built on Electron).

- **Target Host**: `localhost` (or `127.0.0.1`)
- **CDP Port**: `9222` (default for CDP-enabled Electron apps)
- **Library**: `chrome-remote-interface` is used to establish the WebSocket connection to specific renderer targets.

## 2. Target Identification

To find the active chart window, the algorithm performs the following:

1. Fetches `http://localhost:9222/json/list` to retrieve a list of all open renderer targets.
2. Filters targets where `type` is `"page"` and the `url` matches the pattern `/tradingview\.com\/chart/`.
3. **Target ID (Example)**: `B16D06C15CD30060D3B47EFFBDE543C8` (this ID changes whenever TradingView is restarted or the chart instance resets; use `node src/cli/index.js status` to find the current active ID).

## 3. Object Model Navigation

Once connected to a target, the algorithm evaluates standard JavaScript expressions to reach deep-state objects:

- **API Bridge**: `window.TradingViewApi`
- **Active Widget**: `_activeChartWidgetWV.value()._chartWidget` (located in `src/connection.js:KNOWN_PATHS.chartApi`)
- **Data Model**: `chart._chartWidget.model().model()`
- **Data Sources**: `.dataSources()` returns an array containing the main price series, all indicators (studies), and strategies.

## 4. Extraction Logic

### Strategies (Performance Metrics)

Iterates through `dataSources` looking for objects that meet these criteria:

- Possess a `reportData()` or `performance()` method.
- **Filtering Bug**: Currently, it skips sources where `metaInfo().is_price_study` is `true`. Standard Pine strategies are often `is_price_study: false`, but "Overlay" strategies (which display over the price) indicate `true` and are currently missed.
- **Metric Mapping**: Metrics like "Net profit", "Win rate (%)", and "Max drawdown" are extracted by calling `.value()` on the strategy objects.

### Indicators (Study Values)

For indicators like RSI or MACD:

- The algorithm calls `s.dataWindowView().items()`.
- It maps the internal titles (e.g., "RSI [14]") to their current numeric values displayed in the "Data Window" panel.

### Price Data (OHLCV)

- **Path**: `window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()`
- **Method**: Calls `.valueAt(index)` for a specified count of bars to retrieve `[time, open, high, low, close, volume]` arrays.

## 5. Security and Stability

- **`safeString()`**: Sanitizes all input strings using `JSON.stringify` to prevent XSS-style injection into the evaluated JavaScript.
- **Serialization**: Circular references in large TradingView objects are handled by manual transformation into clean JSON objects during evaluation.
