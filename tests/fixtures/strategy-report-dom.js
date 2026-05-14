/**
 * Fixtures representing the TradingView Strategy Tester report metrics.
 * Values taken from a live TV Desktop 3.1.0.7818 session (2026-05-13).
 *
 * NOTE: We deliberately do NOT run JSDOM-based scrape tests against HTML
 * fixtures here. The scrape JS in src/core/data.js runs inside TradingView's
 * real Chromium page via CDP — jsdom's DOM is not a faithful substitute (no
 * layout, no offsetParent semantics, no CSS-module class hashing). Tests in
 * tests/data.test.js mock evaluate() to return pre-baked metric objects,
 * which is sufficient to exercise the JS wrapper logic.
 */

export const POPULATED_METRICS = {
  'Total P&L': '+15,437.00USD+1.54%',
  'Max equity drawdown': '7,256.00',
  'Total trades': '748',
  'Profitable trades': '33.29%',
  'Profit factor': '1.172',
};
