/**
 * Tests for launch() in src/core/health.js.
 * Covers Windows MSIX handling: COM activation as the primary path, local-copy
 * fallback when activation fails or CDP never binds, copy reuse, synchronous
 * spawn throws, and classic-path launches.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { launch } from '../src/core/health.js';

const MSIX_EXE = 'C:\\Program Files\\WindowsApps\\TradingView.Desktop_3.3.0.8112_x64__n534cwy3pjxzj\\TradingView.exe';
const LOCAL_COPY_EXE = `${process.env.LOCALAPPDATA || ''}\\tradingview-mcp\\TradingView.Desktop_3.3.0.8112_x64__n534cwy3pjxzj\\TradingView.exe`;
const CDP_VERSION = JSON.stringify({ Browser: 'Chrome/140', 'User-Agent': 'TVDesktop/3.3.0' });
const COM_PID = 4321;

// ── Mock helpers ─────────────────────────────────────────────────────────

function mockChild({ failWith } = {}) {
  const child = new EventEmitter();
  child.pid = 12345;
  child.unref = () => {};
  if (failWith) queueMicrotask(() => child.emit('error', Object.assign(new Error(failWith), { code: failWith })));
  return child;
}

/**
 * Build a _deps bundle simulating a win32 MSIX environment.
 * @param {object} opts
 *   comFails     — the COM activation PowerShell script exits non-zero
 *   comBindsCdp  — probeCdp starts succeeding after COM activation
 *   spawnFailures — spawn paths (substring) that emit an async EACCES error
 *   spawnThrows  — spawn paths (substring) that throw EPERM synchronously
 *   cdpBindsFor  — spawn paths (substring) after which probeCdp starts succeeding
 *   copyExists   — local copy already present
 */
function msixDeps({ comFails = false, comBindsCdp = false, spawnFailures = [], spawnThrows = [], cdpBindsFor = [], copyExists = false } = {}) {
  const state = { spawned: [], copies: [], removed: [], killed: 0, comActivations: 0, cdpUp: false };
  const deps = {
    existsSync: (p) => {
      if (p === MSIX_EXE) return true;
      if (p.includes('tradingview-mcp')) return copyExists || state.copies.length > 0;
      return false;
    },
    execSync: (cmd) => {
      if (cmd.includes('activate_msix.ps1')) {
        state.comActivations++;
        if (comFails) throw new Error('powershell exited with code 1');
        if (comBindsCdp) state.cdpUp = true;
        return `${COM_PID}\n`;
      }
      if (cmd.includes('Get-AppxPackage')) {
        return 'C:\\Program Files\\WindowsApps\\TradingView.Desktop_3.3.0.8112_x64__n534cwy3pjxzj\n';
      }
      if (cmd.includes('taskkill')) { state.killed++; return ''; }
      throw new Error(`unexpected execSync: ${cmd}`);
    },
    spawn: (exe) => {
      state.spawned.push(exe);
      if (spawnThrows.some((s) => exe.includes(s))) {
        throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM' });
      }
      const fail = spawnFailures.some((s) => exe.includes(s));
      if (!fail && cdpBindsFor.some((s) => exe.includes(s))) state.cdpUp = true;
      return mockChild(fail ? { failWith: 'EACCES' } : {});
    },
    cpSync: (src, dst) => { state.copies.push({ src, dst }); },
    rmSync: (p) => { state.removed.push(p); },
    readdirSync: () => ['TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj'],
    delay: async () => {},
    probeCdp: async () => (state.cdpUp ? CDP_VERSION : null),
  };
  return { deps, state };
}

// launch() only takes the MSIX code path on win32; skip elsewhere.
const onWindows = process.platform === 'win32';

describe('launch() — MSIX WindowsApps handling', { skip: !onWindows }, () => {
  it('COM activation that binds CDP neither spawns nor copies', async () => {
    const { deps, state } = msixDeps({ comBindsCdp: true });
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.binary, MSIX_EXE);
    assert.equal(result.msix_com_activation, true);
    assert.equal(result.msix_local_copy, undefined);
    assert.equal(result.pid, COM_PID);
    assert.equal(state.comActivations, 1);
    assert.equal(state.spawned.length, 0);
    assert.equal(state.copies.length, 0);
    assert.equal(result.cdp_url, 'http://127.0.0.1:9222');
  });

  it('COM activation failure falls back to local copy', async () => {
    const { deps, state } = msixDeps({ comFails: true, cdpBindsFor: ['tradingview-mcp'] });
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.msix_com_activation, undefined);
    assert.equal(result.msix_local_copy, true);
    assert.equal(result.binary, LOCAL_COPY_EXE);
    assert.equal(state.copies.length, 1);
    assert.match(state.copies[0].src, /WindowsApps/);
    // stale cached version of another release is cleaned up first
    assert.equal(state.removed.length, 1);
    assert.match(state.removed[0], /3\.1\.0\.7818/);
    // any half-launched instance is killed before relaunching from the copy
    assert.ok(state.killed >= 2);
  });

  it('CDP never binding after COM activation falls back to local copy', async () => {
    const { deps, state } = msixDeps({ cdpBindsFor: ['tradingview-mcp'] });
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.msix_local_copy, true);
    assert.equal(state.comActivations, 1);
    assert.deepEqual(state.spawned, [LOCAL_COPY_EXE]);
  });

  it('reuses an existing local copy without re-copying', async () => {
    const { deps, state } = msixDeps({ comFails: true, cdpBindsFor: ['tradingview-mcp'], copyExists: true });
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.msix_local_copy, true);
    assert.equal(state.copies.length, 0);
  });

  it('returns cdp_ready:false warning when nothing binds', async () => {
    const { deps } = msixDeps({});
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.cdp_ready, false);
    assert.equal(result.msix_local_copy, true);
    assert.ok(result.warning);
  });

  it('synchronous spawn throw on the fallback copy resolves instead of crashing', async () => {
    const { deps, state } = msixDeps({ comFails: true, spawnThrows: ['tradingview-mcp'] });
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.cdp_ready, false);
    assert.equal(result.msix_local_copy, true);
    assert.equal(state.spawned.length, 1);
  });
});

describe('launch() — classic install path', { skip: !onWindows }, () => {
  function classicDeps({ spawnThrowsSync = false } = {}) {
    const classicExe = `${process.env.LOCALAPPDATA}\\TradingView\\TradingView.exe`;
    const state = { spawned: [], cdpUp: false };
    const deps = {
      existsSync: (p) => p === classicExe,
      execSync: (cmd) => { if (cmd.includes('taskkill')) return ''; throw new Error(`unexpected: ${cmd}`); },
      spawn: (exe) => {
        state.spawned.push(exe);
        if (spawnThrowsSync) throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM' });
        state.cdpUp = true;
        return mockChild();
      },
      cpSync: () => { throw new Error('should not copy'); },
      rmSync: () => {},
      readdirSync: () => [],
      delay: async () => {},
      probeCdp: async () => (state.cdpUp ? CDP_VERSION : null),
    };
    return { deps, state, classicExe };
  }

  it('launches classic LOCALAPPDATA install without MSIX logic', async () => {
    const { deps, state, classicExe } = classicDeps();
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.binary, classicExe);
    assert.equal(result.msix_com_activation, undefined);
    assert.equal(result.msix_local_copy, undefined);
    assert.deepEqual(state.spawned, [classicExe]);
  });

  it('synchronous spawn throw yields cdp_ready:false instead of throwing', async () => {
    const { deps } = classicDeps({ spawnThrowsSync: true });
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.cdp_ready, false);
    assert.ok(result.warning);
  });

  it('throws a helpful error when TradingView is not found', async () => {
    const deps = {
      existsSync: () => false,
      execSync: () => { throw new Error('not found'); },
      spawn: () => { throw new Error('should not spawn'); },
      cpSync: () => {}, rmSync: () => {}, readdirSync: () => [],
      delay: async () => {}, probeCdp: async () => null,
    };
    await assert.rejects(() => launch({ _deps: deps }), /TradingView not found/);
  });
});
