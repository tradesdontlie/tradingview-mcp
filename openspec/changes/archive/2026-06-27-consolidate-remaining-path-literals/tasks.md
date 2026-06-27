## 1. Replace hardcoded path literals
- [x] 1.1 `src/core/data.js:95,129,504` — use `${CHART_API}` (already `= KNOWN_PATHS.chartApi`) in
      `buildGraphicsJS`, `buildAllGraphicsJS`, and `getStudyValues` instead of the inline
      `window.TradingViewApi._activeChartWidgetWV.value()` literal.
- [x] 1.2 `src/core/pane.js` — import `KNOWN_PATHS`; replace `const CWC = '...'` (`:14`) with
      `KNOWN_PATHS.chartWidgetCollection` and the inline chartApi literals (`:71`, `:165`) with
      `KNOWN_PATHS.chartApi`.
- [x] 1.3 `src/core/stream.js:395` — replace the redeclared collection literal with
      `KNOWN_PATHS.chartWidgetCollection`.
- [x] 1.4 `src/core/pine.js:21` — replace `PINE_FACADE_BASE`'s duplicated env-resolution with
      `KNOWN_PATHS.pineFacadeApi`. Also consolidated two `chartApi` literals found in `smartCompile`'s
      studies-before/after probes (added a `const CHART_API = KNOWN_PATHS.chartApi` alias) so pine.js has
      no remaining inline path literals — true to this change's name. (`src/core/health.js` keeps literal
      path strings deliberately: it is the diagnostic probe that *reports* those paths as data.)

## 2. Verify no behavior change
- [x] 2.1 Confirm the substituted expressions are byte-identical to the prior literals (string compare),
      so existing tests pass unchanged.

## 3. Validate
- [x] 3.1 `openspec validate consolidate-remaining-path-literals --strict`
