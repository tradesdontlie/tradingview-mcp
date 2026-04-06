# Transition to the Bridge Pattern (`evaluateFnc`)

We have moved away from direct string interpolation in `evaluate` calls to a more robust, lintable pattern using a global bridge object in the renderer.

---

## 1. The Old Way (Brittle)

Previously, we used Node.js template strings to inject paths. This was prone to syntax errors and lacked ESLint validation.

```javascript
// Node strings were blind to the JS inside
const res = await evaluate(`
  var chart = ${CHART_API}._chartWidget;
  return chart.size();
`);
```

---

## 2. The New Way (Robust)

We now use `evaluateFnc` which takes a raw JavaScript function. It resolves paths from a global `TV_CONFIG` bridge injected during connection.

### A. Resolve Paths with `eval()`
Because `TV_CONFIG` contains string paths, use `eval()` inside the renderer (and an ESLint disable comment on the Node side) to turn them into live objects.

```javascript
const results = await evaluateFnc(() => {
  // eslint-disable-next-line no-eval
  const api = eval(TV_CONFIG.chartApi);
  const chart = api._chartWidget;
  
  return { success: !!chart };
});
```

### B. Handle Dynamic Variables
If you need a Node variable (like `limit`) inside the function, inject it into the bridge *before* the call:

```javascript
await evaluate(`window.TV_CONFIG.limit = ${limit};`);
await evaluateFnc(() => {
  const myLimit = TV_CONFIG.limit;
  // ...
});
```

---

## 3. Benefits

- **ESLint Validation**: All logic inside the function is now checked for syntax and style.
- **Source Maps**: When debugging in Chrome DevTools via `TV_DEBUG=1`, the code appears as a proper JS file with readable variable names.
- **IDE Support**: You get autocomplete and jump-to-definition within the renderer's logic.

---

## 4. How it Works

The `TV_CONFIG` object is initialized in `src/connection.js` during the `connect()` phase. It is populated with the constants from `KNOWN_PATHS`.

```javascript
// src/connection.js
const bootstrap = `window.TV_CONFIG = ${JSON.stringify(KNOWN_PATHS)};`;
await evaluate(bootstrap);
```
