import { evaluate, KNOWN_PATHS } from './connection.js';

const DEFAULT_TIMEOUT = 10000;
const POLL_INTERVAL = 200;
const CHART_API = KNOWN_PATHS.chartApi;

/**
 * Normalize a TradingView resolution string for comparison.
 * TV resolutions look like "1", "5", "60", "D", "W", "M" and sometimes carry a
 * leading "1" prefix ("1D" === "D", "1W" === "W"). We uppercase, trim, and strip a
 * redundant leading "1" before a letter so "1D" and "D" compare equal.
 */
export function normalizeResolution(res) {
  if (res === null || res === undefined) return null;
  let s = String(res).trim().toUpperCase();
  if (!s) return null;
  // "1D" -> "D", "1W" -> "W", "1M" (month) -> "M"; but plain "1" (1 minute) stays "1".
  if (/^1[DWM]$/.test(s)) s = s.slice(1);
  return s;
}

/**
 * Generic poll-until helper.
 * Repeatedly invokes `predicate()` (which may be async) every `interval` ms until
 * it returns a truthy value or `timeout` ms elapse. Resolves to the truthy value
 * on success, or `null` on timeout. Used to replace hand-rolled polling loops.
 */
export async function pollUntil(predicate, { interval = 200, timeout = 10000 } = {}) {
  const start = Date.now();
  // Evaluate at least once, then keep polling while inside the time budget.
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start >= timeout) return null;
    await new Promise(r => setTimeout(r, interval));
  }
}

export async function waitForChartReady(expectedSymbol = null, expectedTf = null, timeout = DEFAULT_TIMEOUT, { _deps } = {}) {
  // _deps lets offline tests inject evaluate (controlled chart state) and sleep
  // (instant), so the readiness gate/stability/timeout paths are unit-testable.
  const ev = _deps?.evaluate || evaluate;
  const sleep = _deps?.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
  const start = Date.now();
  let lastBarCount = -1;
  let stableCount = 0;
  const wantTf = normalizeResolution(expectedTf);

  while (Date.now() - start < timeout) {
    const state = await ev(`
      (function() {
        // Check for loading spinner
        var spinner = document.querySelector('[class*="loader"]')
          || document.querySelector('[class*="loading"]')
          || document.querySelector('[data-name="loading"]');
        var isLoading = spinner && spinner.offsetParent !== null;

        // Bar-count stability probe scoped to the chart series container so
        // unrelated UI ("toolbar", "progress bar", etc.) cannot satisfy it.
        // We count rendered series/bar nodes inside the chart pane(s) only.
        var barCount = -1;
        try {
          var panes = document.querySelectorAll('[data-name="pane"], [class*="chart-container"] canvas');
          if (panes.length) {
            var n = 0;
            for (var i = 0; i < panes.length; i++) {
              var p = panes[i];
              if (p.tagName === 'CANVAS') { n += 1; continue; }
              n += p.querySelectorAll('canvas').length;
            }
            barCount = n;
          }
        } catch (e) {}

        // Get current symbol from header
        var symbolEl = document.querySelector('[data-name="legend-source-title"]')
          || document.querySelector('[class*="title"] [class*="apply-common-tooltip"]');
        var currentSymbol = symbolEl ? symbolEl.textContent.trim() : '';

        // Read the chart's actual resolution from the chart API (authoritative).
        var resolution = null;
        try {
          var chart = ${CHART_API};
          if (chart && typeof chart.resolution === 'function') resolution = chart.resolution();
        } catch (e) {}

        return {
          isLoading: !!isLoading,
          barCount: barCount,
          currentSymbol: currentSymbol,
          resolution: resolution,
        };
      })()
    `);

    if (!state) {
      await sleep(POLL_INTERVAL);
      continue;
    }

    // Not ready if still loading
    if (state.isLoading) {
      stableCount = 0;
      await sleep(POLL_INTERVAL);
      continue;
    }

    // Check symbol match if expected
    if (expectedSymbol && state.currentSymbol && !state.currentSymbol.toUpperCase().includes(expectedSymbol.toUpperCase())) {
      stableCount = 0;
      await sleep(POLL_INTERVAL);
      continue;
    }

    // Check timeframe match if expected. Graceful degradation: only block when we
    // positively read a DIFFERENT resolution. If the resolution can't be read
    // (null), we don't gate on it and let the symbol/bar-stability checks decide.
    if (wantTf) {
      const actualTf = normalizeResolution(state.resolution);
      if (actualTf && actualTf !== wantTf) {
        stableCount = 0;
        await sleep(POLL_INTERVAL);
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

  // Timed out without reaching a stable, matching state.
  return false;
}
