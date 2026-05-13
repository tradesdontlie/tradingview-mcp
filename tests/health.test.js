/**
 * Tests for path discovery and error accumulation in src/core/health.js.
 * All filesystem and shell calls are mocked — no host dependencies.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVersions,
  findMsixTradingView,
  locateTradingView,
  launch,
} from '../src/core/health.js';

// ── Mock helpers ─────────────────────────────────────────────────────────

/**
 * Build a mocked fs.existsSync that returns true only for explicitly-listed paths.
 * Tracks calls in .calls.
 */
function mockExistsSync(truthyPaths = []) {
  const set = new Set(truthyPaths);
  const calls = [];
  const fn = (p) => { calls.push(p); return set.has(p); };
  fn.calls = calls;
  return fn;
}

function mockReaddirSync(map) {
  const calls = [];
  const fn = (p) => {
    calls.push(p);
    if (Object.prototype.hasOwnProperty.call(map, p)) {
      const v = map[p];
      if (v instanceof Error) throw v;
      return v;
    }
    const err = new Error(`ENOENT: no such file or directory, scandir '${p}'`);
    err.code = 'ENOENT';
    throw err;
  };
  fn.calls = calls;
  return fn;
}

function mockExecSync(handler) {
  const calls = [];
  const fn = (cmd, _opts) => {
    calls.push(cmd);
    const r = handler(cmd);
    if (r instanceof Error) throw r;
    return Buffer.from(r ?? '');
  };
  fn.calls = calls;
  return fn;
}

function mockSpawn() {
  const calls = [];
  const fn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return { pid: 12345, unref() {} };
  };
  fn.calls = calls;
  return fn;
}

// ── compareVersions() ────────────────────────────────────────────────────

describe('compareVersions()', () => {
  it('orders semver-ish version strings numerically', () => {
    assert.ok(compareVersions('3.1.0.7818', '3.1.0.7000') > 0);
    assert.ok(compareVersions('3.1.0.7000', '3.1.0.7818') < 0);
    assert.equal(compareVersions('3.1.0.7818', '3.1.0.7818'), 0);
  });

  it('handles different segment counts', () => {
    assert.ok(compareVersions('3.2', '3.1.99.99') > 0);
    assert.ok(compareVersions('3.1', '3.1.0.1') < 0);
  });

  it('treats 9 vs 10 as numbers, not strings', () => {
    assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
  });
});

// ── findMsixTradingView() ────────────────────────────────────────────────

describe('findMsixTradingView()', () => {
  it('finds the highest-version MSIX install when multiple versions present', () => {
    const dir = 'C:\\Program Files\\WindowsApps';
    const readdirSync = mockReaddirSync({
      [dir]: [
        'Microsoft.WindowsCalculator_11.0_x64__8wekyb3d8bbwe',
        'TradingView.Desktop_3.0.5.7000_x64__n534cwy3pjxzj',
        'TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj',
        'TradingView.Desktop_3.0.9.7500_x64__n534cwy3pjxzj',
        'SomeOther.App_1.0.0.0_x64__abc',
      ],
    });
    const expected = `${dir}\\TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj\\TradingView.exe`;
    const existsSync = mockExistsSync([expected]);

    const result = findMsixTradingView({ readdirSync, existsSync, windowsAppsDir: dir });
    assert.equal(result, expected);
  });

  it('returns null when no TradingView.Desktop directories are present', () => {
    const dir = 'C:\\Program Files\\WindowsApps';
    const readdirSync = mockReaddirSync({
      [dir]: ['Microsoft.WindowsCalculator_11.0_x64__8wekyb3d8bbwe', 'SomeOther.App_1.0.0.0_x64__abc'],
    });
    const existsSync = mockExistsSync([]);
    const result = findMsixTradingView({ readdirSync, existsSync, windowsAppsDir: dir });
    assert.equal(result, null);
  });

  it('falls back to next-highest version if the top match has no exe', () => {
    const dir = 'C:\\Program Files\\WindowsApps';
    const readdirSync = mockReaddirSync({
      [dir]: [
        'TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj',
        'TradingView.Desktop_3.0.5.7000_x64__n534cwy3pjxzj',
      ],
    });
    // Only the older version has the exe (e.g. mid-uninstall).
    const fallback = `${dir}\\TradingView.Desktop_3.0.5.7000_x64__n534cwy3pjxzj\\TradingView.exe`;
    const existsSync = mockExistsSync([fallback]);
    const result = findMsixTradingView({ readdirSync, existsSync, windowsAppsDir: dir });
    assert.equal(result, fallback);
  });

  it('throws when WindowsApps directory is not readable', () => {
    const readdirSync = mockReaddirSync({}); // every read throws ENOENT
    const existsSync = mockExistsSync([]);
    assert.throws(
      () => findMsixTradingView({ readdirSync, existsSync, windowsAppsDir: 'C:\\Nope' }),
      /ENOENT/,
    );
  });
});

// ── locateTradingView() — B1: MSIX discovery via locateTradingView ──────

describe('locateTradingView() — Windows MSIX path discovery (B1)', () => {
  it('returns MSIX path when hardcoded win32 paths miss but WindowsApps has TradingView.Desktop_*', () => {
    const env = {
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      PROGRAMFILES: 'C:\\Program Files',
      'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    };
    const winApps = 'C:\\Program Files\\WindowsApps';
    const msixDir = `${winApps}\\TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj`;
    const msixExe = `${msixDir}\\TradingView.exe`;
    const existsSync = mockExistsSync([msixExe]);
    const readdirSync = mockReaddirSync({
      [winApps]: ['TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj'],
    });
    const execSync = mockExecSync(() => '');

    const result = locateTradingView({ platform: 'win32', env, existsSync, readdirSync, execSync });
    assert.equal(result.path, msixExe);
    assert.deepEqual(result.errors, []);
    // Shell probes must NOT have been called — MSIX hit short-circuited.
    assert.equal(execSync.calls.length, 0, 'execSync not invoked on MSIX success');
  });

  it('falls through to shell probes when MSIX glob finds nothing', () => {
    const env = {
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      PROGRAMFILES: 'C:\\Program Files',
      'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    };
    const winApps = 'C:\\Program Files\\WindowsApps';
    const wherePath = 'C:\\Foo\\TradingView.exe';
    const existsSync = mockExistsSync([wherePath]);
    const readdirSync = mockReaddirSync({
      [winApps]: ['NotTradingView_1.0_x64__abc'],
    });
    const execSync = mockExecSync((cmd) => cmd.includes('where') ? wherePath + '\n' : '');

    const result = locateTradingView({ platform: 'win32', env, existsSync, readdirSync, execSync });
    assert.equal(result.path, wherePath);
  });
});

// ── locateTradingView() — B7: error accumulation ─────────────────────────

describe('locateTradingView() — error accumulation (B7)', () => {
  it('accumulates errors from each failed probe', () => {
    const env = {
      LOCALAPPDATA: 'C:\\nope',
      PROGRAMFILES: 'C:\\Program Files',
      'PROGRAMFILES(X86)': 'C:\\nope',
    };
    const existsSync = mockExistsSync([]); // nothing exists
    const readdirSync = mockReaddirSync({}); // WindowsApps read throws ENOENT
    const execSync = mockExecSync(() => {
      const e = new Error('spawnSync where ENOENT');
      e.code = 'ENOENT';
      return e;
    });

    const result = locateTradingView({ platform: 'win32', env, existsSync, readdirSync, execSync });
    assert.equal(result.path, null);
    assert.ok(result.errors.length >= 2, `expected >=2 errors, got ${result.errors.length}`);
    const joined = result.errors.join(' | ');
    assert.match(joined, /WindowsApps glob/);
    assert.match(joined, /where\.exe/);
    assert.match(joined, /ENOENT/);
  });

  it('darwin: collects mdfind and which errors when no path matches', () => {
    const env = { HOME: '/Users/u' };
    const existsSync = mockExistsSync([]);
    const execSync = mockExecSync((cmd) => {
      if (cmd.includes('which')) {
        const e = new Error('which: command failed');
        return e;
      }
      if (cmd.includes('mdfind')) {
        const e = new Error('mdfind: spawnSync error');
        return e;
      }
      return '';
    });
    const result = locateTradingView({ platform: 'darwin', env, existsSync, execSync });
    assert.equal(result.path, null);
    const joined = result.errors.join(' | ');
    assert.match(joined, /which/);
    assert.match(joined, /mdfind/);
  });
});

// ── launch() — uses locateTradingView and includes errors in failure ─────

describe('launch() — error reporting', () => {
  it('throws a single message that includes searched paths AND probe errors', async () => {
    const env = {
      LOCALAPPDATA: 'C:\\nope',
      PROGRAMFILES: 'C:\\Program Files',
      'PROGRAMFILES(X86)': 'C:\\nope',
    };
    const existsSync = mockExistsSync([]);
    const readdirSync = mockReaddirSync({}); // ENOENT for WindowsApps
    const execSync = mockExecSync(() => new Error('where.exe spawnSync ENOENT'));
    const spawn = mockSpawn();

    await assert.rejects(
      () => launch({
        _deps: { platform: 'win32', env, existsSync, readdirSync, execSync, spawn, sleep: async () => {} },
      }),
      (err) => {
        assert.match(err.message, /TradingView not found on win32/);
        assert.match(err.message, /Searched:/);
        assert.match(err.message, /Shell probes failed:/);
        assert.match(err.message, /WindowsApps glob/);
        assert.match(err.message, /where\.exe/);
        return true;
      },
    );
  });

  it('launches via MSIX path when discovered, reports binary in result', async () => {
    const env = {
      LOCALAPPDATA: 'C:\\nope',
      PROGRAMFILES: 'C:\\Program Files',
      'PROGRAMFILES(X86)': 'C:\\nope',
    };
    const winApps = 'C:\\Program Files\\WindowsApps';
    const msixExe = `${winApps}\\TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj\\TradingView.exe`;
    const existsSync = mockExistsSync([msixExe]);
    const readdirSync = mockReaddirSync({
      [winApps]: ['TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj'],
    });
    const execSync = mockExecSync(() => '');
    const spawn = mockSpawn();
    const httpGet = async () => JSON.stringify({ Browser: 'Chrome/130.0', 'User-Agent': 'TV-Test' });

    const result = await launch({
      kill_existing: false,
      _deps: { platform: 'win32', env, existsSync, readdirSync, execSync, spawn, httpGet, sleep: async () => {} },
    });
    assert.equal(result.success, true);
    assert.equal(result.binary, msixExe);
    assert.equal(result.cdp_port, 9222);
    assert.equal(result.browser, 'Chrome/130.0');
    assert.equal(spawn.calls.length, 1);
    assert.equal(spawn.calls[0].bin, msixExe);
    assert.deepEqual(spawn.calls[0].args, ['--remote-debugging-port=9222']);
  });
});
