# TradingView Injected Script Debugging

This guide explains how to debug the JavaScript code that is injected from Node.js (via the MCP server) into the TradingView Desktop application's Electron renderer.

---

## 1. Prerequisites

- **TradingView Desktop** must be running.
- **Remote Debugging** must be enabled on port `9222`. (The MCP server handles this if you use `tv_launch`, or you can start TradingView with `--remote-debugging-port=9222`).

---

## 2. Step-by-Step Instructions

### A. Activate Debug Mode

Set the environment variable `TV_DEBUG=1` before running any MCP tool or harness script. This enables `debugger;` statements and `console.log` progress in the renderer.

**In VS Code:** Use the **"Debug Harness Script"** configuration.
**In Terminal:** `TV_DEBUG=1 node harness.js`

### B. Attach Chrome DevTools

1. Open **Chrome** and navigate to `chrome://inspect`.
2. Click **"Configure..."** and ensure `localhost:9222` is in the list.
3. Under **"Remote Target"**, find your TradingView chart (e.g., `tradingview.com/chart/...`) and click **"inspect"**.
4. A new DevTools window will open, connected to TradingView.

### C. Watch the Console

In the DevTools window, switch to the **Console** tab. You will see progress logs like:
`--- Strategy Extraction Started ---`
`Checking source [0]: ...`

### D. Step Through Code (The `sourceURL` Trick)

The injected script uses `//# sourceURL=getStrategyResults.js` to appear as a virtual file.

1. In the DevTools **Sources** tab, press `Cmd+P` (Mac) or `Ctrl+P` (Win).
2. Type **`getStrategyResults.js`** and open it.
3. You can now set manual breakpoints on any line!
4. Re-run your harness or tool call. DevTools will pause exactly where you set the break.

---

## 3. Configuration Details

### VS Code `launch.json`

The project includes a `Debug Harness Script` configuration:

```json
{
  "name": "Debug Harness Script",
  "type": "node",
  "request": "launch",
  "program": "${workspaceFolder}/${input:harnessFile}",
  "env": { "TV_DEBUG": "1" }
}
```

### Core Logic (`src/core/data.js`)

The `getStrategyResults` function checks for the env var and injects `debugger;` statements:

```javascript
const dbg = process.env.TV_DEBUG === '1' ? 'debugger;' : '';
await evaluate(`
  (function() {
    ${dbg} // Pause here
    ...
  })();
  //# sourceURL=getStrategyResults.js
`);
```

---

## 4. Troubleshooting

- **Break not firing?** Ensure you clicked **"inspect"** in `chrome://inspect` *before* the script reached the `evaluate` call.
- **Target not found?** Verify TradingView is open and port 9222 is accessible (`curl http://localhost:9222/json/list`).
- **Scripts look minified?** Use the `{ }` button in the DevTools Sources tab footer to pretty-print if needed, although `sourceURL` scripts should be readable.

---

## 5. Example Harness Script (`tmp/debug_strategy.mjs`)

You can use a simple script like this to trigger the extraction logic directly from your terminal or VS Code.

```javascript
import { getStrategyResults } from '../src/core/data.js';

// Activate debugging to inject 'debugger;' statements in TradingView renderer
process.env.TV_DEBUG = '1';

async function run() {
  console.log('Calling getStrategyResults...');
  const res = await getStrategyResults();
  console.log('Done:', res);
}

run();
```
