/**
 * Tests for the launch() function in src/core/health.js.
 *
 * Covers: path detection, kill-existing, direct spawn success/failure,
 * macOS `open -a` fallback, Linux/Windows env-var fallback,
 * CDP polling (success + timeout), and error messages.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { launch } from '../src/core/health.js';

// ── Helpers ──────────────────────────────────────────────────────────────

/** Minimal fake readable stream (for child.stderr). */
function fakeStream() {
  const ee = new EventEmitter();
  ee.destroy = () => {};
  return ee;
}

/**
 * Create a fake child process.
 * @param {'survive'|'fail'|'error'} behavior
 *   - survive: stays alive (never emits exit)
 *   - fail:    emits exit(1) immediately
 *   - error:   emits 'error' immediately
 */
function fakeChild(behavior = 'survive') {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stderr = fakeStream();
  child.unref = () => {};

  if (behavior === 'fail') {
    process.nextTick(() => child.emit('exit', 1, null));
  } else if (behavior === 'error') {
    process.nextTick(() => child.emit('error', new Error('spawn ENOENT')));
  }
  return child;
}

/**
 * Build a mock deps object.
 * @param {object} overrides — keys to override defaults
 */
function mockDeps(overrides = {}) {
  const spawnCalls = [];
  const execSyncCalls = [];

  const defaults = {
    platform: 'darwin',
    env: { HOME: '/Users/testuser' },
    existsSync: () => true,
    execSync: (cmd, opts) => {
      execSyncCalls.push({ cmd, opts });
      return Buffer.from('');
    },
    spawn: (bin, args, opts) => {
      spawnCalls.push({ bin, args, opts });
      return fakeChild('survive');
    },
    httpGet: null,
  };

  const deps = { ...defaults, ...overrides };
  deps._spawnCalls = spawnCalls;
  deps._execSyncCalls = execSyncCalls;
  return deps;
}

/**
 * Create an httpGet mock that responds on the Nth call.
 * @param {number} respondOnCall - 1-based index of the call that succeeds (0 = never)
 * @param {object} [body] - JSON body to return
 */
function mockHttpGet(respondOnCall, body = { Browser: 'Electron', 'User-Agent': 'test' }) {
  let callCount = 0;
  return (url, cb) => {
    callCount++;
    const req = new EventEmitter();
    req.on = req.on.bind(req);
    if (callCount >= respondOnCall && respondOnCall > 0) {
      const res = new EventEmitter();
      process.nextTick(() => {
        cb(res);
        res.emit('data', JSON.stringify(body));
        res.emit('end');
      });
    } else {
      process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')));
    }
    return req;
  };
}

const TV_BIN = '/Applications/TradingView.app/Contents/MacOS/TradingView';

// ── Tests ────────────────────────────────────────────────────────────────

describe('launch() — path detection', () => {
  it('finds binary from pathMap', async () => {
    const deps = mockDeps({
      existsSync: (p) => p === TV_BIN,
      httpGet: mockHttpGet(1),
    });
    const result = await launch({ port: 9222, kill_existing: false, _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.binary, TV_BIN);
  });

  it('falls back to which/where when pathMap misses', async () => {
    const deps = mockDeps({
      platform: 'linux',
      existsSync: (p) => p === '/usr/local/bin/tradingview',
      execSync: (cmd) => {
        if (cmd.includes('which')) return Buffer.from('/usr/local/bin/tradingview\n');
        return Buffer.from('');
      },
      httpGet: mockHttpGet(1),
    });
    const result = await launch({ port: 9222, kill_existing: false, _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.binary, '/usr/local/bin/tradingview');
  });

  it('falls back to mdfind on macOS', async () => {
    let mdfindCalled = false;
    const deps = mockDeps({
      platform: 'darwin',
      existsSync: (p) => p === '/custom/TradingView.app/Contents/MacOS/TradingView',
      execSync: (cmd) => {
        if (cmd.includes('mdfind')) {
          mdfindCalled = true;
          return Buffer.from('/custom/TradingView.app\n');
        }
        throw new Error('not found');
      },
      httpGet: mockHttpGet(1),
    });
    const result = await launch({ port: 9222, kill_existing: false, _deps: deps });
    assert.equal(result.success, true);
    assert.ok(mdfindCalled, 'mdfind was called');
    assert.equal(result.binary, '/custom/TradingView.app/Contents/MacOS/TradingView');
  });

  it('throws when binary not found on any platform', async () => {
    const deps = mockDeps({
      platform: 'linux',
      existsSync: () => false,
      execSync: () => { throw new Error('not found'); },
    });
    await assert.rejects(
      () => launch({ port: 9222, kill_existing: false, _deps: deps }),
      (err) => {
        assert.ok(err.message.includes('TradingView not found'));
        assert.ok(err.message.includes('v2.14.0+'));
        return true;
      },
    );
  });
});

describe('launch() — kill existing', () => {
  it('calls pkill on darwin when kill_existing is true', async () => {
    const deps = mockDeps({
      existsSync: (p) => p === TV_BIN,
      httpGet: mockHttpGet(1),
    });
    // kill_existing defaults to true
    await launch({ port: 9222, _deps: deps });
    const pkillCall = deps._execSyncCalls.find(c => c.cmd.includes('pkill'));
    assert.ok(pkillCall, 'pkill was called');
  });

  it('calls taskkill on win32', async () => {
    const winBin = 'C:\\Users\\test\\AppData\\Local\\TradingView\\TradingView.exe';
    const deps = mockDeps({
      platform: 'win32',
      env: { HOME: 'C:\\Users\\test', LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local', PROGRAMFILES: '', 'PROGRAMFILES(X86)': '' },
      existsSync: (p) => p === winBin,
      httpGet: mockHttpGet(1),
    });
    await launch({ port: 9222, _deps: deps });
    const taskKill = deps._execSyncCalls.find(c => c.cmd.includes('taskkill'));
    assert.ok(taskKill, 'taskkill was called');
  });

  it('skips kill when kill_existing is false', async () => {
    const deps = mockDeps({
      existsSync: (p) => p === TV_BIN,
      httpGet: mockHttpGet(1),
    });
    await launch({ port: 9222, kill_existing: false, _deps: deps });
    const killCall = deps._execSyncCalls.find(c => c.cmd.includes('pkill') || c.cmd.includes('taskkill'));
    assert.equal(killCall, undefined, 'no kill command issued');
  });
});

describe('launch() — direct spawn succeeds (old TradingView)', () => {
  it('returns success with CDP info when spawn + CDP both succeed', async () => {
    const deps = mockDeps({
      existsSync: (p) => p === TV_BIN,
      httpGet: mockHttpGet(1, { Browser: 'Electron/28', 'User-Agent': 'TV-old' }),
    });
    const result = await launch({ port: 9222, kill_existing: false, _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.cdp_port, 9222);
    assert.equal(result.browser, 'Electron/28');
    assert.equal(result.pid, 12345);
    assert.equal(result.fallback_used, undefined);
  });

  it('passes --remote-debugging-port to spawn', async () => {
    const deps = mockDeps({
      existsSync: (p) => p === TV_BIN,
      httpGet: mockHttpGet(1),
    });
    await launch({ port: 4444, kill_existing: false, _deps: deps });
    const spawnCall = deps._spawnCalls[0];
    assert.equal(spawnCall.args[0], '--remote-debugging-port=4444');
  });

  it('returns cdp_ready:false warning when CDP never responds', async () => {
    const deps = mockDeps({
      existsSync: (p) => p === TV_BIN,
      httpGet: mockHttpGet(0), // never responds
    });
    const result = await launch({ port: 9222, kill_existing: false, _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.cdp_ready, false);
    assert.ok(result.warning.includes('CDP not responding'));
  });
});

describe('launch() — spawn fails, macOS fallback', () => {
  it('kills existing, then uses open -a with .app bundle when direct spawn exits non-zero', async () => {
    const deps = mockDeps({
      platform: 'darwin',
      existsSync: (p) => p === TV_BIN,
      spawn: (bin, args, opts) => {
        deps._spawnCalls.push({ bin, args, opts });
        return fakeChild('fail'); // exit(1) immediately
      },
      httpGet: mockHttpGet(1, { Browser: 'Electron/38', 'User-Agent': 'TV-new' }),
    });

    const result = await launch({ port: 9222, kill_existing: false, _deps: deps });

    // Should have re-killed before open -a (critical: open -a only works on fresh launch)
    const pkillCall = deps._execSyncCalls.find(c => c.cmd.includes('pkill'));
    assert.ok(pkillCall, 'pkill called in fallback path to ensure clean launch');

    // Should have called execSync with open -a
    const openCall = deps._execSyncCalls.find(c => c.cmd.includes('open -a'));
    assert.ok(openCall, 'open -a was called as fallback');
    assert.ok(openCall.cmd.includes('/Applications/TradingView.app'), 'uses .app bundle path');
    assert.ok(openCall.cmd.includes('--remote-debugging-port=9222'), 'passes CDP port');

    // pkill should come BEFORE open -a
    const pkillIdx = deps._execSyncCalls.findIndex(c => c.cmd.includes('pkill'));
    const openIdx = deps._execSyncCalls.findIndex(c => c.cmd.includes('open -a'));
    assert.ok(pkillIdx < openIdx, 'pkill runs before open -a');

    assert.equal(result.success, true);
    assert.equal(result.fallback_used, true);
    assert.equal(result.browser, 'Electron/38');
  });

  it('falls back to bare spawn when no .app bundle in path', async () => {
    const linuxBin = '/usr/bin/tradingview';
    const deps = mockDeps({
      platform: 'darwin',
      existsSync: (p) => p === linuxBin,
      execSync: (cmd) => {
        deps._execSyncCalls.push({ cmd });
        if (cmd.includes('which')) return Buffer.from(linuxBin + '\n');
        if (cmd.includes('pkill')) return Buffer.from('');
        throw new Error('fail');
      },
      spawn: (bin, args, opts) => {
        deps._spawnCalls.push({ bin, args, opts });
        // First call (direct) fails, second call (bare) survives
        return fakeChild(deps._spawnCalls.length === 1 ? 'fail' : 'survive');
      },
      httpGet: mockHttpGet(0), // CDP never responds
    });

    const result = await launch({ port: 9222, kill_existing: false, _deps: deps });

    // Second spawn should be bare (no args)
    assert.equal(deps._spawnCalls.length, 2);
    assert.deepEqual(deps._spawnCalls[1].args, []);
  });

  it('returns success:false with workaround hint when fallback + CDP both fail', async () => {
    const deps = mockDeps({
      platform: 'darwin',
      existsSync: (p) => p === TV_BIN,
      spawn: (bin, args, opts) => {
        deps._spawnCalls.push({ bin, args, opts });
        return fakeChild('fail');
      },
      httpGet: mockHttpGet(0), // never responds
    });

    const result = await launch({ port: 9222, kill_existing: false, _deps: deps });
    assert.equal(result.success, false);
    assert.ok(result.error.includes('pkill -f TradingView'), 'error includes manual workaround');
    assert.ok(result.error.includes('open -a TradingView'), 'error includes open -a hint');
    assert.equal(result.cdp_ready, false);
  });
});

describe('launch() — spawn fails, Linux/Windows fallback', () => {
  it('re-spawns with REMOTE_DEBUGGING_PORT env var on Linux', async () => {
    const linuxBin = '/opt/TradingView/tradingview';
    let spawnCount = 0;
    const deps = mockDeps({
      platform: 'linux',
      env: { HOME: '/home/testuser' },
      existsSync: (p) => p === linuxBin,
      spawn: (bin, args, opts) => {
        spawnCount++;
        deps._spawnCalls.push({ bin, args, opts });
        // First call fails, second survives
        return fakeChild(spawnCount === 1 ? 'fail' : 'survive');
      },
      httpGet: mockHttpGet(1),
    });

    const result = await launch({ port: 9222, kill_existing: false, _deps: deps });

    assert.equal(deps._spawnCalls.length, 2, 'spawn called twice');
    const fallbackCall = deps._spawnCalls[1];
    assert.equal(fallbackCall.opts.env.REMOTE_DEBUGGING_PORT, '9222');
    assert.equal(result.success, true);
    assert.equal(result.fallback_used, true);
  });

  it('re-spawns with env var on Windows', async () => {
    const winBin = 'C:\\Program Files\\TradingView\\TradingView.exe';
    let spawnCount = 0;
    const deps = mockDeps({
      platform: 'win32',
      env: { HOME: 'C:\\Users\\test', LOCALAPPDATA: '', PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': '' },
      existsSync: (p) => p === winBin,
      spawn: (bin, args, opts) => {
        spawnCount++;
        deps._spawnCalls.push({ bin, args, opts });
        return fakeChild(spawnCount === 1 ? 'fail' : 'survive');
      },
      httpGet: mockHttpGet(1),
    });

    const result = await launch({ port: 9222, kill_existing: false, _deps: deps });
    const fallbackCall = deps._spawnCalls[1];
    assert.equal(fallbackCall.opts.env.REMOTE_DEBUGGING_PORT, '9222');
  });
});

describe('launch() — spawn error event', () => {
  it('detects spawn error (ENOENT) and falls back via open -a', async () => {
    const deps = mockDeps({
      platform: 'darwin',
      existsSync: (p) => p === TV_BIN,
      spawn: (bin, args, opts) => {
        deps._spawnCalls.push({ bin, args, opts });
        return fakeChild('error');
      },
      httpGet: mockHttpGet(0),
    });

    const result = await launch({ port: 9222, kill_existing: false, _deps: deps });
    // Should have triggered fallback: pkill then open -a
    const pkillCall = deps._execSyncCalls.find(c => c.cmd && c.cmd.includes('pkill'));
    assert.ok(pkillCall, 'pkill called in fallback after spawn error');
    const openCall = deps._execSyncCalls.find(c => c.cmd && c.cmd.includes('open -a'));
    assert.ok(openCall, 'macOS open fallback was triggered after spawn error');
  });
});

describe('launch() — CDP polling', () => {
  it('succeeds when CDP responds on 3rd poll', async () => {
    const deps = mockDeps({
      existsSync: (p) => p === TV_BIN,
      httpGet: mockHttpGet(3, { Browser: 'SlowStart', 'User-Agent': 'test' }),
    });
    const result = await launch({ port: 9222, kill_existing: false, _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.browser, 'SlowStart');
  });

  it('uses custom port in CDP URL', async () => {
    const deps = mockDeps({
      existsSync: (p) => p === TV_BIN,
      httpGet: mockHttpGet(1),
    });
    const result = await launch({ port: 8888, kill_existing: false, _deps: deps });
    assert.equal(result.cdp_port, 8888);
    assert.equal(result.cdp_url, 'http://localhost:8888');
  });
});

describe('launch() — defaults', () => {
  it('defaults to port 9222', async () => {
    const deps = mockDeps({
      existsSync: (p) => p === TV_BIN,
      httpGet: mockHttpGet(1),
    });
    const result = await launch({ kill_existing: false, _deps: deps });
    assert.equal(result.cdp_port, 9222);
    assert.equal(deps._spawnCalls[0].args[0], '--remote-debugging-port=9222');
  });

  it('defaults kill_existing to true', async () => {
    const deps = mockDeps({
      existsSync: (p) => p === TV_BIN,
      httpGet: mockHttpGet(1),
    });
    await launch({ _deps: deps });
    const pkillCall = deps._execSyncCalls.find(c => c.cmd.includes('pkill'));
    assert.ok(pkillCall, 'kill was called by default');
  });
});
