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

        // Bar count via TV's internal model (canonical, not DOM scraping).
        // [class*="bar"] previously matched toolbars/sidebars/scrollbars and
        // produced a near-constant signal that returned false-positive readiness.
        var barCount = -1;
        try {
          var chart = window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV
            && window.TradingViewApi._activeChartWidgetWV.value();
          var bars = chart && chart._chartWidget.model().mainSeries().bars();
          if (bars) barCount = bars.lastIndex() - bars.firstIndex() + 1;
        } catch {}

        // Get current symbol — first try internal API, fall back to DOM legend.
        var currentSymbol = '';
        try {
          var c = window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV
            && window.TradingViewApi._activeChartWidgetWV.value();
          if (c && typeof c.symbol === 'function') currentSymbol = String(c.symbol() || '');
        } catch {}
        if (!currentSymbol) {
          var symbolEl = document.querySelector('[data-name="legend-source-title"]')
            || document.querySelector('[class*="title"] [class*="apply-common-tooltip"]');
          currentSymbol = symbolEl ? symbolEl.textContent.trim() : '';
        }

        return { isLoading: !!isLoading, barCount: barCount, currentSymbol: currentSymbol };
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

    // Symbol match check — requires a non-empty currentSymbol.
    // Previously: if expectedSymbol set but currentSymbol was empty (legend not
    // yet rendered), the && short-circuit treated that as "matched" and let
    // readiness proceed. Now we wait until the legend or API reports something.
    //
    // We compare against the *bare ticker* (segment after the last `:`)
    // because TV resolves caller's exchange prefix to its preferred feed:
    // a request for "NASDAQ:IREN" lands as "BATS:IREN" in chart.symbol(),
    // and the previous strict `.includes(expectedSymbol)` would never match.
    if (expectedSymbol) {
      if (!state.currentSymbol) {
        stableCount = 0;
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
        continue;
      }
      const bareExpected = expectedSymbol.split(':').pop().toUpperCase();
      if (!state.currentSymbol.toUpperCase().includes(bareExpected)) {
        stableCount = 0;
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
        continue;
      }
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

  // Timeout — caller must treat false as "not confirmed ready, verify before proceeding"
  return false;
}

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

        var chart = null;
        var symbol = '';
        var resolution = '';

        try {
          chart = window.TradingViewApi._activeChartWidgetWV.value();
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

    const signature = [
      state.symbol,
      state.resolution,
      state.canvasWidth,
      state.canvasHeight,
    ].join('|');

    if (signature === lastSignature) {
      stableCount++;
    } else {
      stableCount = 0;
      lastSignature = signature;
    }

    if (stableCount >= 3) {
      return true;
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  return false;
}
