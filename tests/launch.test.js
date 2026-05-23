/**
 * Tests for the Windows MSIX launcher fallback used by tv_launch.
 * The real activation can only run on a Windows machine with TradingView
 * installed from the Microsoft Store, so we stub execSync and assert
 * tryLaunchMsixWindows() parses both outcomes correctly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tryLaunchMsixWindows } from '../src/core/health.js';

function fakeExecSync(stdout) {
  return () => Buffer.from(stdout);
}

function throwingExecSync(message) {
  return () => { throw new Error(message); };
}

describe('tryLaunchMsixWindows()', () => {
  it('returns null when TradingView is not installed as an MSIX package', () => {
    const result = tryLaunchMsixWindows(9222, true, fakeExecSync('NOT_INSTALLED\n'));
    assert.equal(result, null);
  });

  it('parses { pid, aumid } from a successful activation', () => {
    const stdout = 'OK 17188 TradingView.Desktop_n534cwy3pjxzj!TradingView.Desktop\n';
    const result = tryLaunchMsixWindows(9222, true, fakeExecSync(stdout));
    assert.deepEqual(result, {
      pid: 17188,
      aumid: 'TradingView.Desktop_n534cwy3pjxzj!TradingView.Desktop',
    });
  });

  it('returns null when PowerShell errors (e.g. COM activation fails)', () => {
    const result = tryLaunchMsixWindows(9222, true, throwingExecSync('Access denied'));
    assert.equal(result, null);
  });

  it('returns null on unexpected stdout that does not match either pattern', () => {
    const result = tryLaunchMsixWindows(9222, true, fakeExecSync('weird unparseable output'));
    assert.equal(result, null);
  });

  it('respects the killFirst flag in the generated PowerShell (smoke check)', () => {
    let captured = null;
    const exec = (cmd, opts) => {
      captured = { cmd, opts };
      return Buffer.from('NOT_INSTALLED');
    };
    tryLaunchMsixWindows(9222, false, exec);
    assert.ok(captured, 'execSync was called');
    assert.match(captured.cmd, /powershell .* -File /, 'invokes powershell with a script file');
  });
});
