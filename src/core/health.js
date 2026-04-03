/**
 * Core health/discovery/launch logic.
 */
import { getClient, getTargetInfo, evaluate } from '../connection.js';
import { existsSync } from 'fs';
import { execSync, spawn } from 'child_process';

export async function healthCheck() {
  await getClient();
  const target = await getTargetInfo();

  const state = await evaluate(`
    (function() {
      var result = { url: window.location.href, title: document.title };
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        result.symbol = chart.symbol();
        result.resolution = chart.resolution();
        result.chartType = chart.chartType();
        result.apiAvailable = true;
      } catch(e) {
        result.symbol = 'unknown';
        result.resolution = 'unknown';
        result.chartType = null;
        result.apiAvailable = false;
        result.apiError = e.message;
      }
      return result;
    })()
  `);

  return {
    success: true,
    cdp_connected: true,
    target_id: target.id,
    target_url: target.url,
    target_title: target.title,
    chart_symbol: state?.symbol || 'unknown',
    chart_resolution: state?.resolution || 'unknown',
    chart_type: state?.chartType ?? null,
    api_available: state?.apiAvailable ?? false,
  };
}

export async function discover() {
  const paths = await evaluate(`
    (function() {
      var results = {};
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var methods = [];
        for (var k in chart) { if (typeof chart[k] === 'function') methods.push(k); }
        results.chartApi = { available: true, path: 'window.TradingViewApi._activeChartWidgetWV.value()', methodCount: methods.length, methods: methods.slice(0, 50) };
      } catch(e) { results.chartApi = { available: false, error: e.message }; }
      try {
        var col = window.TradingViewApi._chartWidgetCollection;
        var colMethods = [];
        for (var k in col) { if (typeof col[k] === 'function') colMethods.push(k); }
        results.chartWidgetCollection = { available: !!col, path: 'window.TradingViewApi._chartWidgetCollection', methodCount: colMethods.length, methods: colMethods.slice(0, 30) };
      } catch(e) { results.chartWidgetCollection = { available: false, error: e.message }; }
      try {
        var ws = window.ChartApiInstance;
        var wsMethods = [];
        for (var k in ws) { if (typeof ws[k] === 'function') wsMethods.push(k); }
        results.chartApiInstance = { available: !!ws, path: 'window.ChartApiInstance', methodCount: wsMethods.length, methods: wsMethods.slice(0, 30) };
      } catch(e) { results.chartApiInstance = { available: false, error: e.message }; }
      try {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        var bwbMethods = [];
        if (bwb) { for (var k in bwb) { if (typeof bwb[k] === 'function') bwbMethods.push(k); } }
        results.bottomWidgetBar = { available: !!bwb, path: 'window.TradingView.bottomWidgetBar', methodCount: bwbMethods.length, methods: bwbMethods.slice(0, 20) };
      } catch(e) { results.bottomWidgetBar = { available: false, error: e.message }; }
      try {
        var replay = window.TradingViewApi._replayApi;
        results.replayApi = { available: !!replay, path: 'window.TradingViewApi._replayApi' };
      } catch(e) { results.replayApi = { available: false, error: e.message }; }
      try {
        var alerts = window.TradingViewApi._alertService;
        results.alertService = { available: !!alerts, path: 'window.TradingViewApi._alertService' };
      } catch(e) { results.alertService = { available: false, error: e.message }; }
      return results;
    })()
  `);

  const available = Object.values(paths).filter(v => v.available).length;
  const total = Object.keys(paths).length;

  return { success: true, apis_available: available, apis_total: total, apis: paths };
}

export async function uiState() {
  const state = await evaluate(`
    (function() {
      var ui = {};
      var bottom = document.querySelector('[class*="layout__area--bottom"]');
      ui.bottom_panel = { open: !!(bottom && bottom.offsetHeight > 50), height: bottom ? bottom.offsetHeight : 0 };
      var right = document.querySelector('[class*="layout__area--right"]');
      ui.right_panel = { open: !!(right && right.offsetWidth > 50), width: right ? right.offsetWidth : 0 };
      var monacoEl = document.querySelector('.monaco-editor.pine-editor-monaco');
      ui.pine_editor = { open: !!monacoEl, width: monacoEl ? monacoEl.offsetWidth : 0, height: monacoEl ? monacoEl.offsetHeight : 0 };
      var stratPanel = document.querySelector('[data-name="backtesting"]') || document.querySelector('[class*="strategyReport"]');
      ui.strategy_tester = { open: !!(stratPanel && stratPanel.offsetParent) };
      var widgetbar = document.querySelector('[data-name="widgetbar-wrap"]');
      ui.widgetbar = { open: !!(widgetbar && widgetbar.offsetWidth > 50) };
      ui.buttons = {};
      var btns = document.querySelectorAll('button');
      var seen = {};
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (b.offsetParent === null || b.offsetWidth < 15) continue;
        var text = b.textContent.trim();
        var aria = b.getAttribute('aria-label') || '';
        var dn = b.getAttribute('data-name') || '';
        var label = text || aria || dn;
        if (!label || label.length > 60) continue;
        var key = label.replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 40);
        if (seen[key]) continue;
        seen[key] = true;
        var rect = b.getBoundingClientRect();
        var region = 'other';
        if (rect.y < 50) region = 'top_bar';
        else if (rect.y < 90 && rect.x < 650) region = 'toolbar';
        else if (rect.x < 45) region = 'left_sidebar';
        else if (rect.x > 650 && rect.y < 100) region = 'pine_header';
        else if (rect.y > 750) region = 'bottom_bar';
        if (!ui.buttons[region]) ui.buttons[region] = [];
        ui.buttons[region].push({ label: label.substring(0, 40), disabled: b.disabled, x: Math.round(rect.x), y: Math.round(rect.y) });
      }
      ui.key_buttons = {};
      var keyLabels = {
        'add_to_chart': /add to chart/i, 'save_and_add': /save and add/i,
        'update_on_chart': /update on chart/i, 'save': /^Save(Save)?$/,
        'saved': /^Saved/, 'publish_script': /publish script/i,
        'compile_errors': /error/i, 'unsaved_version': /unsaved version/i,
      };
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (b.offsetParent === null) continue;
        var text = b.textContent.trim();
        for (var k in keyLabels) {
          if (keyLabels[k].test(text)) {
            ui.key_buttons[k] = { text: text.substring(0, 40), disabled: b.disabled, visible: b.offsetWidth > 0 };
          }
        }
      }
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        ui.chart = { symbol: chart.symbol(), resolution: chart.resolution(), chartType: chart.chartType(), study_count: chart.getAllStudies().length };
      } catch(e) { ui.chart = { error: e.message }; }
      try {
        var replay = window.TradingViewApi._replayApi;
        function unwrap(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
        ui.replay = { available: unwrap(replay.isReplayAvailable()), started: unwrap(replay.isReplayStarted()) };
      } catch(e) { ui.replay = { error: e.message }; }
      return ui;
    })()
  `);

  return { success: true, ...state };
}

export async function launch({ port, kill_existing, _deps } = {}) {
  const deps = { spawn, execSync, existsSync, platform: process.platform, env: process.env, httpGet: null, ..._deps };
  const cdpPort = port || 9222;
  const killFirst = kill_existing !== false;
  const platform = deps.platform;

  const pathMap = {
    darwin: [
      '/Applications/TradingView.app/Contents/MacOS/TradingView',
      `${deps.env.HOME}/Applications/TradingView.app/Contents/MacOS/TradingView`,
    ],
    win32: [
      `${deps.env.LOCALAPPDATA}\\TradingView\\TradingView.exe`,
      `${deps.env.PROGRAMFILES}\\TradingView\\TradingView.exe`,
      `${deps.env['PROGRAMFILES(X86)']}\\TradingView\\TradingView.exe`,
    ],
    linux: [
      '/opt/TradingView/tradingview',
      '/opt/TradingView/TradingView',
      `${deps.env.HOME}/.local/share/TradingView/TradingView`,
      '/usr/bin/tradingview',
      '/snap/tradingview/current/tradingview',
    ],
  };

  let tvPath = null;
  const candidates = pathMap[platform] || pathMap.linux;
  for (const p of candidates) {
    if (p && deps.existsSync(p)) { tvPath = p; break; }
  }

  if (!tvPath) {
    try {
      const cmd = platform === 'win32' ? 'where TradingView.exe' : 'which tradingview';
      tvPath = deps.execSync(cmd, { timeout: 3000 }).toString().trim().split('\n')[0];
      if (tvPath && !deps.existsSync(tvPath)) tvPath = null;
    } catch { /* ignore */ }
  }

  if (!tvPath && platform === 'darwin') {
    try {
      const found = deps.execSync('mdfind "kMDItemFSName == TradingView.app" | head -1', { timeout: 5000 }).toString().trim();
      if (found) {
        const candidate = `${found}/Contents/MacOS/TradingView`;
        if (deps.existsSync(candidate)) tvPath = candidate;
      }
    } catch { /* ignore */ }
  }

  if (!tvPath) {
    throw new Error(`TradingView not found on ${platform}. Searched: ${candidates.join(', ')}. Launch manually with: /path/to/TradingView --remote-debugging-port=${cdpPort} (note: TradingView v2.14.0+ may reject this flag)`);
  }

  if (killFirst) {
    try {
      if (platform === 'win32') deps.execSync('taskkill /F /IM TradingView.exe', { timeout: 5000 });
      else deps.execSync('pkill -f TradingView', { timeout: 5000 });
      await new Promise(r => setTimeout(r, 1500));
    } catch { /* may not be running */ }
  }

  // Try direct spawn first (works on TradingView < v2.14 / Electron < 38).
  // Electron 38+ (Node 22) rejects --remote-debugging-port as an unknown CLI flag
  // before Chromium can process it. Detect that and fall back to platform-specific strategies.
  let child = deps.spawn(tvPath, [`--remote-debugging-port=${cdpPort}`], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const spawnFailed = await new Promise((resolve) => {
    let settled = false;
    const settle = (val) => { if (!settled) { settled = true; resolve(val); } };
    child.stderr.on('data', () => {});
    child.on('error', () => { clearTimeout(timer); settle(true); });
    child.on('exit', (code) => {
      if (code !== null && code !== 0) { clearTimeout(timer); settle(true); }
    });
    const timer = setTimeout(() => {
      // Process survived 2s — flag was accepted. Detach stderr so parent can exit.
      child.stderr.destroy();
      settle(false);
    }, 2000);
  });

  if (spawnFailed) {
    // Direct flag rejected (Electron 38+ / Node 22 strict validation).
    // Try platform-specific fallbacks.
    child = null;

    if (platform === 'darwin') {
      // Kill any running instance first — `open -a` only works if no existing
      // instance is running, otherwise macOS just activates the old (non-CDP) window.
      try { deps.execSync('pkill -f TradingView', { timeout: 5000 }); } catch { /* may not be running */ }
      await new Promise(r => setTimeout(r, 2000));

      // Derive the .app bundle path from the binary path for `open -a`.
      const appMatch = tvPath.match(/^(.+\.app)\//);
      if (appMatch) {
        const appBundle = appMatch[1];
        try {
          deps.execSync(`open -a "${appBundle}" --args --remote-debugging-port=${cdpPort}`, { timeout: 5000 });
        } catch { /* ignore — open may return non-zero even on success */ }
      } else {
        // No .app bundle found; try spawning without the flag as last resort.
        const fallback = deps.spawn(tvPath, [], { detached: true, stdio: 'ignore' });
        fallback.unref();
      }
    } else {
      // Linux / Windows: try environment variable hint, then bare launch.
      const fallback = deps.spawn(tvPath, [`--remote-debugging-port=${cdpPort}`], {
        detached: true, stdio: 'ignore',
        env: { ...deps.env, REMOTE_DEBUGGING_PORT: String(cdpPort) },
      });
      fallback.unref();
    }
  } else {
    child.unref();
  }

  // Poll for CDP regardless of launch strategy.
  // deps.httpGet allows tests to inject a fake; production uses real http.get.
  const httpGet = deps.httpGet || (await import('http')).get;
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const ready = await new Promise((resolve) => {
        httpGet(`http://localhost:${cdpPort}/json/version`, (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => resolve(data));
        }).on('error', () => resolve(null));
      });
      if (ready) {
        const info = JSON.parse(ready);
        return {
          success: true, platform, binary: tvPath, pid: child?.pid ?? null,
          cdp_port: cdpPort, cdp_url: `http://localhost:${cdpPort}`,
          browser: info.Browser, user_agent: info['User-Agent'],
          ...(spawnFailed ? { fallback_used: true } : {}),
        };
      }
    } catch { /* retry */ }
  }

  if (spawnFailed) {
    return {
      success: false, platform, binary: tvPath, cdp_port: cdpPort, cdp_ready: false,
      error: `TradingView launched but CDP not available on port ${cdpPort}. ` +
        'This is likely TradingView v2.14.0+ (Electron 38 / Node 22) which rejects --remote-debugging-port as a CLI flag. ' +
        'Workaround: pkill -f TradingView; sleep 2; open -a TradingView --args --remote-debugging-port=' + cdpPort,
    };
  }

  return {
    success: true, platform, binary: tvPath, pid: child?.pid ?? null, cdp_port: cdpPort, cdp_ready: false,
    warning: 'TradingView launched but CDP not responding yet. It may still be loading. Try tv_health_check in a few seconds.',
  };
}
