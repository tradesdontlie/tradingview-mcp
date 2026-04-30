import CDP from 'chrome-remote-interface';
import { execFileSync } from 'node:child_process';

let client = null;
let targetInfo = null;
let bridgeMode = false;
let mainClient = null; // V8 inspector client (bridge mode only)

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;
const INSPECTOR_PORT = 9229;
const MAX_RETRIES = 5;
const BASE_DELAY = 500;

// Known direct API paths discovered via live probing (see PROBE_RESULTS.md)
const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
};

export { KNOWN_PATHS };

export async function getClient() {
  if (client) {
    try {
      if (bridgeMode) {
        await evaluateViaBridge('1');
      } else {
        await client.Runtime.evaluate({ expression: '1', returnByValue: true });
      }
      return client;
    } catch {
      await cleanupAll();
    }
  }
  return connect();
}

export async function connect() {
  let cdpError;

  // --- Attempt 1: Normal CDP on port 9222 ---
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const target = await findChartTarget(CDP_PORT);
      if (!target) throw new Error('No TradingView chart target found');
      targetInfo = target;
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });
      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();
      bridgeMode = false;
      return client;
    } catch (err) {
      cdpError = err;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  // --- Attempt 2: SIGUSR1 bridge via V8 inspector on port 9229 ---
  try {
    return await connectViaBridge();
  } catch (bridgeErr) {
    throw new Error(
      `CDP connection failed after ${MAX_RETRIES} attempts: ${cdpError?.message}. ` +
      `Bridge fallback also failed: ${bridgeErr?.message}`
    );
  }
}

// ─── Bridge connection: SIGUSR1 → V8 inspector → webContents.debugger ────────

async function connectViaBridge() {
  // Ensure V8 inspector is listening (send SIGUSR1 if needed)
  await ensureInspectorListening();

  // Connect to the main process V8 inspector
  const targets = await fetchJsonTargets(INSPECTOR_PORT);
  if (!targets.length) throw new Error('No V8 inspector targets on port ' + INSPECTOR_PORT);

  mainClient = await CDP({ host: CDP_HOST, port: INSPECTOR_PORT, target: targets[0].id });
  await mainClient.Runtime.enable();

  // Find the chart webContents and attach the debugger
  const setupResult = await mainClient.Runtime.evaluate({
    expression: `
      (function() {
        var binding = process._linkedBinding('electron_browser_web_contents');
        var all = binding.getAllWebContents();
        var chart = null;
        for (var i = 0; i < all.length; i++) {
          var url = '';
          try { url = all[i].getURL(); } catch(e) {}
          if (url.indexOf('tradingview.com/chart') !== -1) { chart = all[i]; break; }
        }
        if (!chart) return JSON.stringify({ error: 'No chart webContents found. Is a chart tab open?' });
        try { chart.debugger.attach('1.3'); } catch(e) { /* already attached */ }
        global.__tvBridgeChart = chart;
        return JSON.stringify({ ok: true, id: chart.id, url: chart.getURL() });
      })()
    `,
    returnByValue: true,
  });

  const parsed = JSON.parse(setupResult.result?.value ?? '{"error":"No result"}');
  if (parsed.error) throw new Error(parsed.error);

  bridgeMode = true;
  targetInfo = { id: 'bridge-' + parsed.id, url: parsed.url, type: 'page', title: 'TradingView (bridge)' };

  // Create proxy client that all 68 tools can use transparently
  client = {
    Runtime: {
      evaluate: (params) => bridgeRuntimeEvaluate(params),
      enable: async () => {},
      disable: async () => {},
    },
    Page: {
      enable: async () => {},
      disable: async () => {},
      captureScreenshot: async (params) => bridgeCaptureScreenshot(params),
    },
    Input: {
      dispatchKeyEvent: (params) => bridgeDebuggerCommand('Input.dispatchKeyEvent', params),
      insertText: (params) => bridgeDebuggerCommand('Input.insertText', params),
    },
    DOM: {
      enable: async () => {},
      disable: async () => {},
    },
    close: async () => { await cleanupAll(); },
  };

  return client;
}

async function ensureInspectorListening() {
  // Check if inspector is already up
  try {
    const targets = await fetchJsonTargets(INSPECTOR_PORT);
    if (targets.length > 0) return;
  } catch { /* not listening yet */ }

  // Find the TradingView main process and send SIGUSR1
  let pid;
  try {
    pid = execFileSync('pgrep', ['-f', '/Applications/TradingView.app/Contents/MacOS/TradingView$'], { encoding: 'utf8' }).trim();
  } catch {
    try {
      pid = execFileSync('pgrep', ['-f', 'TradingView --type=browser'], { encoding: 'utf8' }).trim();
    } catch {
      throw new Error('Cannot find TradingView main process. Is TradingView running?');
    }
  }

  if (!pid) throw new Error('No TradingView process found');

  // SIGUSR1 toggles the V8 inspector
  process.kill(parseInt(pid.split('\n')[0]), 'SIGUSR1');

  // Wait for inspector to start (poll up to 5s)
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const targets = await fetchJsonTargets(INSPECTOR_PORT);
      if (targets.length > 0) return;
    } catch { /* keep waiting */ }
  }
  throw new Error('V8 inspector did not start on port ' + INSPECTOR_PORT + ' after SIGUSR1');
}

async function bridgeRuntimeEvaluate(params) {
  if (!mainClient) throw new Error('Bridge not connected');

  const expr = params.expression ?? '';
  const returnByValue = params.returnByValue !== false;
  const awaitPromise = params.awaitPromise ?? false;

  // Pass expression safely via JSON.stringify — avoids all escaping issues
  const safeExpr = JSON.stringify(expr);

  // Electron 38+ uses Promise-based debugger.sendCommand (callback form deprecated)
  const wrapper = `
    global.__tvBridgeChart.debugger.sendCommand('Runtime.evaluate', {
      expression: ${safeExpr},
      returnByValue: ${returnByValue},
      awaitPromise: ${awaitPromise}
    })
  `;

  const result = await mainClient.Runtime.evaluate({
    expression: wrapper,
    returnByValue: true,
    awaitPromise: true,
  });

  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Bridge evaluation error';
    throw new Error(msg);
  }

  // The bridge returns the inner Runtime.evaluate result
  const inner = result.result?.value;
  if (inner && typeof inner === 'object') {
    return inner;
  }
  return result;
}

async function bridgeDebuggerCommand(method, params = {}) {
  if (!mainClient) throw new Error('Bridge not connected');

  const safeMethod = JSON.stringify(method);
  const safeParams = JSON.stringify(params || {});
  const result = await mainClient.Runtime.evaluate({
    expression: `global.__tvBridgeChart.debugger.sendCommand(${safeMethod}, ${safeParams})`,
    returnByValue: true,
    awaitPromise: true,
  });

  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || `${method} bridge command failed`;
    throw new Error(msg);
  }

  return result.result?.value ?? {};
}

// Liveness check for bridge mode
async function evaluateViaBridge(expression) {
  return bridgeRuntimeEvaluate({ expression, returnByValue: true });
}

async function bridgeCaptureScreenshot(_params) {
  if (!mainClient) throw new Error('Bridge not connected');
  const result = await mainClient.Runtime.evaluate({
    expression: `
      new Promise(function(resolve, reject) {
        global.__tvBridgeChart.capturePage().then(function(img) {
          resolve(img.toDataURL().replace('data:image/png;base64,', ''));
        }).catch(reject);
      })
    `,
    returnByValue: true,
    awaitPromise: true,
  });
  return { data: result.result?.value ?? result?.value ?? '' };
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

async function fetchJsonTargets(port) {
  const resp = await fetch(`http://${CDP_HOST}:${port}/json/list`);
  return resp.json();
}

async function findChartTarget(port) {
  const targets = await fetchJsonTargets(port);
  return targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    || targets.find(t => t.type === 'page' && /tradingview/i.test(t.url))
    || null;
}

async function cleanupAll() {
  if (client && !bridgeMode) {
    try { await client.close(); } catch {}
  }
  if (mainClient) {
    try {
      await mainClient.Runtime.evaluate({
        expression: `
          (function() {
            if (!global.__tvBridgeChart || !global.__tvBridgeChart.debugger) return false;
            try {
              if (global.__tvBridgeChart.debugger.isAttached()) {
                global.__tvBridgeChart.debugger.detach();
              }
            } catch(e) {}
            delete global.__tvBridgeChart;
            return true;
          })()
        `,
        returnByValue: true,
      });
    } catch {}
    try { await mainClient.close(); } catch {}
    mainClient = null;
  }
  client = null;
  targetInfo = null;
  bridgeMode = false;
}

export async function getTargetInfo() {
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

export async function evaluate(expression, opts = {}) {
  const c = await getClient();
  const result = await c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? false,
    ...opts,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression) {
  return evaluate(expression, { awaitPromise: true });
}

export async function disconnect() {
  await cleanupAll();
}

// --- Direct API path helpers ---
async function verifyAndReturn(path, name) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi() {
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API');
}

export async function getChartCollection() {
  return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection');
}

export async function getBottomBar() {
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar');
}

export async function getReplayApi() {
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API');
}

export async function getMainSeriesBars() {
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars');
}
