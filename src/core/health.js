/**
 * Core health/discovery/launch logic.
 */
import { getClient, getTargetInfo, evaluate } from '../connection.js';
import { existsSync as _existsSync, readdirSync as _readdirSync } from 'fs';
import { execSync as _execSync, spawn as _spawn } from 'child_process';
import { SELECTORS as _UI_SELECTORS } from './ui.js';

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
  const stPanelSelsLit = JSON.stringify(_UI_SELECTORS.strategyTesterPanel);
  const stTabLabelsLit = JSON.stringify(_UI_SELECTORS.strategyTesterTabLabels);
  const state = await evaluate(`
    (function() {
      var ui = {};
      var bottom = document.querySelector('[class*="layout__area--bottom"]');
      ui.bottom_panel = { open: !!(bottom && bottom.offsetHeight > 50), height: bottom ? bottom.offsetHeight : 0 };
      var right = document.querySelector('[class*="layout__area--right"]');
      ui.right_panel = { open: !!(right && right.offsetWidth > 50), width: right ? right.offsetWidth : 0 };
      var monacoEl = document.querySelector('.monaco-editor.pine-editor-monaco');
      ui.pine_editor = { open: !!monacoEl, width: monacoEl ? monacoEl.offsetWidth : 0, height: monacoEl ? monacoEl.offsetHeight : 0 };
      // Strategy Tester detection: independent of bottom-panel state (B6, B10).
      // Matches Agent F's detectStrategyTester() helper in ui.js.
      var _stSignals = [];
      var _stPanelSels = ${stPanelSelsLit};
      for (var _i = 0; _i < _stPanelSels.length; _i++) {
        var _stEl = document.querySelector(_stPanelSels[_i]);
        if (_stEl && _stEl.offsetParent) { _stSignals.push('panel:' + _stPanelSels[_i]); break; }
      }
      var _stTabLabels = ${stTabLabelsLit};
      var _allBtns = document.querySelectorAll('button, [role="tab"]');
      // TradingView buttons often emit label twice ("MetricsMetrics") — accept either form.
      for (var _j = 0; _j < _allBtns.length; _j++) {
        var _btn = _allBtns[_j];
        if (!_btn.offsetParent) continue;
        var _txt = (_btn.textContent || '').trim();
        for (var _k = 0; _k < _stTabLabels.length; _k++) {
          var _lbl = _stTabLabels[_k];
          if (_txt === _lbl || _txt === _lbl + _lbl) { _stSignals.push('tab:' + _lbl); break; }
        }
        if (_stSignals.length >= 4) break;
      }
      ui.strategy_tester = { open: _stSignals.length > 0, signals: _stSignals };
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

/**
 * Compare two version strings such as "3.1.0.7818". Returns negative, 0, or positive
 * the way String.localeCompare's numeric collator does. Non-numeric segments compare
 * lexically. Exported for testing.
 */
export function compareVersions(a, b) {
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const sa = pa[i] || '0';
    const sb = pb[i] || '0';
    const na = parseInt(sa, 10);
    const nb = parseInt(sb, 10);
    if (!isNaN(na) && !isNaN(nb) && String(na) === sa && String(nb) === sb) {
      if (na !== nb) return na - nb;
    } else {
      if (sa !== sb) return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Find the highest-version MSIX install of TradingView Desktop on Windows.
 * Looks under C:\Program Files\WindowsApps for directories named
 * `TradingView.Desktop_<version>_x64__<publisherHash>` and returns the path
 * to `TradingView.exe` inside the highest-version directory whose exe exists.
 *
 * Returns null if no match is found. Throws errors are caught by caller.
 *
 * @param {object} [deps]
 * @param {(p:string)=>string[]} [deps.readdirSync]
 * @param {(p:string)=>boolean} [deps.existsSync]
 * @param {string} [deps.windowsAppsDir] — override the WindowsApps directory (for testing)
 */
export function findMsixTradingView({ readdirSync = _readdirSync, existsSync = _existsSync, windowsAppsDir } = {}) {
  const dir = windowsAppsDir || `${process.env.PROGRAMFILES || 'C:\\Program Files'}\\WindowsApps`;
  const entries = readdirSync(dir);
  const matches = [];
  for (const name of entries) {
    // Expected: TradingView.Desktop_<version>_<arch>__<publisherHash>
    const m = name.match(/^TradingView\.Desktop_([0-9][0-9.]*)_/i);
    if (!m) continue;
    matches.push({ name, version: m[1] });
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => compareVersions(b.version, a.version));
  for (const m of matches) {
    const exe = `${dir}\\${m.name}\\TradingView.exe`;
    if (existsSync(exe)) return exe;
  }
  return null;
}

function _resolve(deps) {
  return {
    existsSync: deps?.existsSync || _existsSync,
    readdirSync: deps?.readdirSync || _readdirSync,
    execSync: deps?.execSync || _execSync,
    spawn: deps?.spawn || _spawn,
    platform: deps?.platform || process.platform,
    env: deps?.env || process.env,
    httpGet: deps?.httpGet, // optional, only used in launch's CDP poll
    sleep: deps?.sleep || ((ms) => new Promise(r => setTimeout(r, ms))),
  };
}

/**
 * Locate the TradingView binary on disk. Returns { path, errors } where
 * `path` may be null if not found. `errors` is an array of strings describing
 * caught probe failures (empty when everything succeeds). Exported for testing.
 */
export function locateTradingView(deps = {}) {
  const { existsSync, readdirSync, execSync, platform, env } = _resolve(deps);
  const errors = [];

  const pathMap = {
    darwin: [
      '/Applications/TradingView.app/Contents/MacOS/TradingView',
      `${env.HOME}/Applications/TradingView.app/Contents/MacOS/TradingView`,
    ],
    win32: [
      `${env.LOCALAPPDATA}\\TradingView\\TradingView.exe`,
      `${env.PROGRAMFILES}\\TradingView\\TradingView.exe`,
      `${env['PROGRAMFILES(X86)']}\\TradingView\\TradingView.exe`,
    ],
    linux: [
      '/opt/TradingView/tradingview',
      '/opt/TradingView/TradingView',
      `${env.HOME}/.local/share/TradingView/TradingView`,
      '/usr/bin/tradingview',
      '/snap/tradingview/current/tradingview',
    ],
  };

  const candidates = pathMap[platform] || pathMap.linux;
  for (const p of candidates) {
    if (p && existsSync(p)) return { path: p, errors, candidates };
  }

  // Windows MSIX (Microsoft Store) install — discover via WindowsApps dir.
  if (platform === 'win32') {
    try {
      const msix = findMsixTradingView({
        readdirSync,
        existsSync,
        windowsAppsDir: `${env.PROGRAMFILES || 'C:\\Program Files'}\\WindowsApps`,
      });
      if (msix) return { path: msix, errors, candidates };
    } catch (e) {
      errors.push(`WindowsApps glob: ${e.message || e}`);
    }
  }

  // Shell-based PATH probe.
  try {
    const cmd = platform === 'win32' ? 'where TradingView.exe' : 'which tradingview';
    const out = execSync(cmd, { timeout: 3000 }).toString().trim().split('\n')[0];
    if (out && existsSync(out)) return { path: out, errors, candidates };
    if (out) errors.push(`${cmd} returned "${out}" but file does not exist`);
  } catch (e) {
    errors.push(`${platform === 'win32' ? 'where.exe' : 'which'}: ${e.message || e}`);
  }

  if (platform === 'darwin') {
    try {
      const found = execSync('mdfind "kMDItemFSName == TradingView.app" | head -1', { timeout: 5000 }).toString().trim();
      if (found) {
        const candidate = `${found}/Contents/MacOS/TradingView`;
        if (existsSync(candidate)) return { path: candidate, errors, candidates };
        errors.push(`mdfind found "${found}" but ${candidate} does not exist`);
      }
    } catch (e) {
      errors.push(`mdfind: ${e.message || e}`);
    }
  }

  return { path: null, errors, candidates };
}

export async function launch({ port, kill_existing, _deps } = {}) {
  const deps = _resolve(_deps);
  const { execSync, spawn, platform, sleep } = deps;
  const cdpPort = port || 9222;
  const killFirst = kill_existing !== false;

  const { path: tvPath, errors, candidates } = locateTradingView(_deps);

  if (!tvPath) {
    const probeMsg = errors.length ? ` Shell probes failed: ${errors.join('; ')}.` : '';
    throw new Error(`TradingView not found on ${platform}. Searched: ${candidates.join(', ')}.${probeMsg} Launch manually with: /path/to/TradingView --remote-debugging-port=${cdpPort}`);
  }

  if (killFirst) {
    try {
      if (platform === 'win32') execSync('taskkill /F /IM TradingView.exe', { timeout: 5000 });
      else execSync('pkill -f TradingView', { timeout: 5000 });
      await sleep(1500);
    } catch { /* may not be running */ }
  }

  const child = spawn(tvPath, [`--remote-debugging-port=${cdpPort}`], { detached: true, stdio: 'ignore' });
  if (typeof child.unref === 'function') child.unref();

  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    try {
      const httpGetFn = deps.httpGet || (async (url) => {
        const http = await import('http');
        return new Promise((resolve) => {
          http.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve(data));
          }).on('error', () => resolve(null));
        });
      });
      const ready = await httpGetFn(`http://localhost:${cdpPort}/json/version`);
      if (ready) {
        const info = JSON.parse(ready);
        return {
          success: true, platform, binary: tvPath, pid: child.pid,
          cdp_port: cdpPort, cdp_url: `http://localhost:${cdpPort}`,
          browser: info.Browser, user_agent: info['User-Agent'],
        };
      }
    } catch { /* retry */ }
  }

  return {
    success: true, platform, binary: tvPath, pid: child.pid, cdp_port: cdpPort, cdp_ready: false,
    warning: 'TradingView launched but CDP not responding yet. It may still be loading. Try tv_health_check in a few seconds.',
  };
}
