/**
 * Centralized DOM selectors for TradingView Desktop automation.
 *
 * Single source of truth. Edit this file when a TradingView release rotates
 * a CSS-module hash or renames a panel attribute. Consumers (ui.js, data.js,
 * health.js) import from here so a UI change requires editing ONE file, not
 * three.
 *
 * Rationale: TradingView's React build uses CSS-module hashed class names
 * (e.g. `reportContainer-hIlv5It8`, `backtestingReport-qyUx4U7K`) that rotate
 * per release. We use attribute-substring matchers (`[class*="..."]`) and
 * stack multiple fallback selectors so older builds keep working when newer
 * ones add a new class.
 */

export const SELECTORS = {
  // Layout regions
  bottomArea: ['[class*="layout__area--bottom"]'],
  rightArea: ['[class*="layout__area--right"]'],
  pineMonaco: ['.monaco-editor.pine-editor-monaco'],

  // Strategy Tester panel container. Observed names across TradingView builds:
  //   - `backtestingReport-qyUx4U7K` (TV 3.1.0.7818, May 2026)
  //   - `reportContainer-hIlv5It8`   (earlier hash within the same release)
  //   - `.bottom-widgetbar-content.backtesting` (stable wrapper)
  //   - `[data-name="backtesting"]`  (legacy attribute)
  //   - `strategyReport-*`           (oldest)
  // Order matters: newer-first so the substring match short-circuits cheaply.
  strategyTesterPanel: [
    '[class*="backtestingReport"]',
    '[class*="reportContainer"]',
    '.bottom-widgetbar-content.backtesting',
    '[data-name="backtesting"]',
    '[class*="strategyReport"]',
  ],

  // Tab labels unique to the Strategy Tester. A visible button or [role="tab"]
  // with one of these labels is a strong "panel is open" secondary signal,
  // independent of the container hash. WARNING: English-only — TradingView
  // localizes per session locale. Future work: match data-name/role attributes
  // instead of text.
  strategyTesterTabLabels: [
    'Metrics',
    'List of trades',
    'Performance',
    'Performance Summary',
  ],

  // Metric cards inside the Strategy Tester report. Card class observed as
  // `containerCell-zres18Ue`. Inside each card:
  //   - title:    div with class containing "title" (e.g. title-nEWm7_ye)
  //   - value:    div with class containing "value" / "positiveValue" / "negativeValue"
  metricCard: ['[class*="containerCell"]', '[class*="cardContainer"]', '[class*="card-"]'],
  metricLabel: ['[class*="title"]', '[class*="label"]'],
  metricValue: ['[class*="positiveValue"]', '[class*="negativeValue"]', '[class*="value"]'],

  // Trades table (the "List of trades" tab). Observed: TradingView uses
  // virtualized list containers — exact selectors guessed. Always pair with
  // a same-row check on the active tab before trusting the result.
  // TODO verify selectors against TV with live trades present.
  tradesTable: [
    '[class*="listOfTrades"]',
    '[class*="tradesList"]',
    '[class*="trades-"]',
  ],
};

/**
 * Build a JS-source array literal for use inside evaluate() bodies that need
 * to embed one of the selector lists into a CDP-injected IIFE. Uses
 * JSON.stringify per element so any future selector containing quotes or
 * backslashes is safely escaped.
 */
export function arrLit(arr) {
  return '[' + arr.map((s) => JSON.stringify(s)).join(',') + ']';
}
