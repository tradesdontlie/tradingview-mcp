import { evaluate } from './connection.js';

const DEFAULT_TIMEOUT = 10000;
const POLL_INTERVAL = 200;

export async function waitForChartReady(expectedSymbol = null, expectedTf = null, timeout = DEFAULT_TIMEOUT) {
  const start = Date.now();
  let lastBarCount = -1;
  let stableCount = 0;

  while (Date.now() - start < timeout) {
    const state = await evaluate(`
      (function() {
        // Check for loading spinner
        var spinner = document.querySelector('[class*="loader"]')
          || document.querySelector('[class*="loading"]')
          || document.querySelector('[data-name="loading"]');
        var isLoading = spinner && spinner.offsetParent !== null;

        // Series load state + real bar count. The old '[class*="bar"]' DOM query matched
        // toolbars/scrollbars, so it never reflected data loading at all.
        // seriesLoading is the authoritative signal: chart.symbol() flips to the new symbol
        // up to ~700ms BEFORE its data lands (measured), so the symbol alone cannot gate
        // readiness — reading in that window returns the PREVIOUS symbol's bars.
        var seriesLoading = false;
        var barCount = -1;
        try {
          var ms = window.TradingViewApi._activeChartWidgetWV.value()
            ._chartWidget.model().mainSeries();
          var l = ms.isLoading;
          seriesLoading = !!(typeof l === 'function' ? ms.isLoading() : l);
          barCount = ms.bars().size();
        } catch(e) {}

        // Get current symbol from the chart API (the header selectors are gone in TV 3.3.0
        // and the fallback scrapes a description, so the match below could never pass)
        var currentSymbol = '';
        try {
          currentSymbol = window.TradingViewApi._activeChartWidgetWV.value().symbol() || '';
        } catch(e) {}

        return {
          isLoading: !!isLoading || seriesLoading,
          barCount: barCount,
          currentSymbol: currentSymbol
        };
      })()
    `);

    if (!state) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    // Not ready if still loading
    if (state.isLoading) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    // Check symbol match if expected
    if (expectedSymbol && state.currentSymbol && !state.currentSymbol.toUpperCase().includes(expectedSymbol.toUpperCase())) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    // Check bar count stability
    if (state.barCount === lastBarCount && state.barCount > 0) {
      stableCount++;
    } else {
      stableCount = 0;
    }
    lastBarCount = state.barCount;

    if (stableCount >= 2) {
      return true;
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  // Timeout — report NOT ready. Callers currently only echo this as `chart_ready`
  // and proceed regardless, so a timeout does not abort the operation.
  return false;
}

/**
 * Wait for the chart to finish (re)rendering — used before screenshots so a
 * capture right after chart_set_symbol / chart_set_timeframe doesn't grab a
 * stale frame (issue #144). Waits for any loading spinner to clear, then for
 * the symbol/resolution/canvas signature to hold stable across 3 polls.
 */
export async function waitForChartRender(timeout = 5000) {
  const start = Date.now();
  let lastSignature = null;
  let stableCount = 0;

  while (Date.now() - start < timeout) {
    const state = await evaluate(`
      (function() {
        var canvas = document.querySelector('[data-name="pane-canvas"] canvas')
          || document.querySelector('[data-name="pane-canvas"]')
          || document.querySelector('canvas');
        var rect = canvas ? canvas.getBoundingClientRect() : null;
        var symbol = '', resolution = '';
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          symbol = chart.symbol();
          resolution = chart.resolution();
        } catch(e) {}
        var spinner = document.querySelector('[class*="loader"]')
          || document.querySelector('[class*="loading"]')
          || document.querySelector('[data-name="loading"]');
        return {
          symbol: symbol,
          resolution: resolution,
          isLoading: !!(spinner && spinner.offsetParent !== null),
          canvasWidth: rect ? Math.round(rect.width) : 0,
          canvasHeight: rect ? Math.round(rect.height) : 0
        };
      })()
    `);

    if (!state || state.isLoading || !state.canvasWidth || !state.canvasHeight) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    const signature = [state.symbol, state.resolution, state.canvasWidth, state.canvasHeight].join('|');
    if (signature === lastSignature) stableCount++;
    else { stableCount = 0; lastSignature = signature; }

    if (stableCount >= 3) return true;
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  return false;
}
