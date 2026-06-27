/**
 * Core health/discovery/launch logic.
 */
import { getClient as _getClient, getTargetInfo as _getTargetInfo, evaluate as _evaluate } from '../connection.js';
import { existsSync } from 'fs';
import { execSync, execFileSync, spawn } from 'child_process';

function _resolve(deps) {
  return {
    getClient: deps?.getClient || _getClient,
    getTargetInfo: deps?.getTargetInfo || _getTargetInfo,
    evaluate: deps?.evaluate || _evaluate,
  };
}

// PID of the TradingView process this tool last spawned, persisted for the
// lifetime of the MCP server process. We only ever force-kill THIS pid on a
// restart — never processes the tool did not start (e.g. windows the user
// opened themselves). See launchDecision()/killCommandFor() below.
let lastSpawnedPid = null;
// Async spawn error (binary unreadable, permission denied, etc.) captured by the
// child's 'error' handler so a true spawn failure isn't misreported as a generic
// "CDP not responding" timeout.
let lastSpawnError = null;

// Test-only seam: reset the module-level spawn state between unit tests.
export function __resetLaunchStateForTest() {
  lastSpawnedPid = null;
  lastSpawnError = null;
}

/**
 * Pure helper: build the PID-targeted kill command for a given platform.
 * Returns { cmd, args } where args is an argv array. The command MUST target a
 * specific PID — never the TradingView image name (no `taskkill /IM`, no
 * `pkill -f TradingView`), so we never terminate processes we didn't spawn.
 *
 * @param {string} platform  process.platform value ('win32' | 'darwin' | 'linux')
 * @param {number} pid       the PID to terminate
 */
export function killCommandFor(platform, pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`killCommandFor: invalid pid ${pid}`);
  }
  if (platform === 'win32') {
    // taskkill scoped to a single PID (the tree it owns), never /IM <image>.
    return { cmd: 'taskkill', args: ['/F', '/PID', String(pid), '/T'] };
  }
  // darwin + linux: kill the single PID. No `pkill -f`/image-name matching.
  return { cmd: 'kill', args: ['-9', String(pid)] };
}

/**
 * Pure decision helper: given the observed state, decide what launch() should do.
 *   - port responding + !killExisting        -> 'already_running' (skip)
 *   - port responding + killExisting + pid    -> 'restart' (kill known pid, respawn)
 *   - port responding + killExisting + no pid -> 'refuse_kill_unknown' (don't kill foreign instance)
 *   - port not responding                     -> 'spawn'
 *
 * @param {object}  o
 * @param {boolean} o.portResponding  whether the CDP port currently answers
 * @param {boolean} o.killExisting    caller's kill_existing flag (already defaulted)
 * @param {?number} o.knownPid        PID the tool previously spawned, if any
 * @returns {'already_running'|'restart'|'spawn'|'refuse_kill_unknown'}
 */
export function launchDecision({ portResponding, killExisting, knownPid }) {
  if (!portResponding) return 'spawn';
  if (!killExisting) return 'already_running';
  if (knownPid) return 'restart';
  return 'refuse_kill_unknown';
}

// Quick offline-friendly CDP port probe used by launch(). Resolves true if the
// /json/version endpoint answers, false otherwise. Never throws.
async function probeCdpPort(cdpPort) {
  try {
    const http = await import('http');
    return await new Promise((resolve) => {
      const req = http.get(`http://localhost:${cdpPort}/json/version`, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(!!data));
      });
      req.on('error', () => resolve(false));
      req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    });
  } catch {
    return false;
  }
}

export async function healthCheck({ _deps } = {}) {
  const { getClient, getTargetInfo, evaluate } = _resolve(_deps);
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

export async function discover({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
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

export async function uiState({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
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

export async function launch({ port, kill_existing } = {}) {
  const cdpPort = port || 9222;
  // Non-destructive default: kill_existing defaults to FALSE.
  const killExisting = kill_existing === true;
  const platform = process.platform;

  // Decide up front whether we should even touch any processes. If the CDP port
  // is already answering and the caller didn't request a restart, do nothing.
  const portResponding = await probeCdpPort(cdpPort);
  const decision = launchDecision({ portResponding, killExisting, knownPid: lastSpawnedPid });

  if (decision === 'already_running') {
    return {
      success: true,
      action: 'already_running',
      platform,
      cdp_port: cdpPort,
      cdp_url: `http://localhost:${cdpPort}`,
      cdp_ready: true,
      note: 'TradingView already running — pass kill_existing:true to restart',
    };
  }

  if (decision === 'refuse_kill_unknown') {
    // Port is up but WE didn't spawn it. Refuse to force-kill a process we don't
    // own; the user can close it themselves or we leave it running.
    return {
      success: true,
      action: 'external_instance',
      platform,
      cdp_port: cdpPort,
      cdp_url: `http://localhost:${cdpPort}`,
      cdp_ready: true,
      note: 'A TradingView instance the tool did not start is already running. This tool will not force-kill processes it did not spawn. Close it manually and re-run, or use it as-is.',
    };
  }

  const pathMap = {
    darwin: [
      '/Applications/TradingView.app/Contents/MacOS/TradingView',
      `${process.env.HOME}/Applications/TradingView.app/Contents/MacOS/TradingView`,
    ],
    win32: [
      `${process.env.LOCALAPPDATA}\\TradingView\\TradingView.exe`,
      `${process.env.PROGRAMFILES}\\TradingView\\TradingView.exe`,
      `${process.env['PROGRAMFILES(X86)']}\\TradingView\\TradingView.exe`,
    ],
    linux: [
      '/opt/TradingView/tradingview',
      '/opt/TradingView/TradingView',
      `${process.env.HOME}/.local/share/TradingView/TradingView`,
      '/usr/bin/tradingview',
      '/snap/tradingview/current/tradingview',
    ],
  };

  let tvPath = null;
  const candidates = pathMap[platform] || pathMap.linux;
  for (const p of candidates) {
    if (p && existsSync(p)) { tvPath = p; break; }
  }

  if (!tvPath) {
    try {
      const cmd = platform === 'win32' ? 'where TradingView.exe' : 'which tradingview';
      tvPath = execSync(cmd, { timeout: 3000 }).toString().trim().split('\n')[0];
      if (tvPath && !existsSync(tvPath)) tvPath = null;
    } catch { /* ignore */ }
  }

  if (!tvPath && platform === 'darwin') {
    try {
      const found = execSync('mdfind "kMDItemFSName == TradingView.app" | head -1', { timeout: 5000 }).toString().trim();
      if (found) {
        const candidate = `${found}/Contents/MacOS/TradingView`;
        if (existsSync(candidate)) tvPath = candidate;
      }
    } catch { /* ignore */ }
  }

  if (!tvPath) {
    throw new Error(`TradingView not found on ${platform}. Searched: ${candidates.join(', ')}. Launch manually with: /path/to/TradingView --remote-debugging-port=${cdpPort}`);
  }

  // decision === 'restart': kill ONLY the PID we previously spawned, never the
  // image name. (decision === 'spawn' falls straight through to spawn.)
  if (decision === 'restart' && lastSpawnedPid) {
    try {
      const { cmd, args } = killCommandFor(platform, lastSpawnedPid);
      // execFileSync (no shell) — args are passed directly, never interpolated.
      execFileSync(cmd, args, { timeout: 5000 });
      await new Promise(r => setTimeout(r, 1500));
    } catch { /* may already be gone */ }
    lastSpawnedPid = null;
  }

  lastSpawnError = null;
  const child = spawn(tvPath, [`--remote-debugging-port=${cdpPort}`], { detached: true, stdio: 'ignore' });
  // Capture async spawn failures (ENOENT, EACCES, ...) BEFORE unref so we don't
  // misreport them as a CDP timeout below.
  child.on('error', (err) => { lastSpawnError = err; });
  lastSpawnedPid = child.pid || null;
  child.unref();

  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const http = await import('http');
      const ready = await new Promise((resolve) => {
        http.get(`http://localhost:${cdpPort}/json/version`, (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => resolve(data));
        }).on('error', () => resolve(null));
      });
      if (ready) {
        const info = JSON.parse(ready);
        return {
          success: true, action: decision === 'restart' ? 'restarted' : 'spawned',
          platform, binary: tvPath, pid: child.pid,
          cdp_port: cdpPort, cdp_url: `http://localhost:${cdpPort}`,
          browser: info.Browser, user_agent: info['User-Agent'],
        };
      }
    } catch { /* retry */ }
  }

  // CDP never came up. If the child emitted a spawn error, that's the real
  // cause — surface it instead of a misleading "CDP not responding" notice.
  if (lastSpawnError) {
    return {
      success: false, platform, binary: tvPath, cdp_port: cdpPort,
      error: 'TradingView failed to start: ' + lastSpawnError.message,
    };
  }

  return {
    success: true, action: decision === 'restart' ? 'restarted' : 'spawned',
    platform, binary: tvPath, pid: child.pid, cdp_port: cdpPort, cdp_ready: false,
    warning: 'TradingView launched but CDP not responding yet. It may still be loading. Try tv_health_check in a few seconds.',
  };
}
