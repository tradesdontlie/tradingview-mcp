/**
 * Offline unit tests for the launch-safety helpers in src/core/health.js.
 *
 * launch() itself spawns real processes and probes a real port, so it is NOT
 * exercised here. Instead the two pure decision/command helpers it delegates to
 * are unit-tested:
 *   - killCommandFor(platform, pid)  -> PID-targeted kill command (never /IM, never image name)
 *   - launchDecision({ portResponding, killExisting, knownPid }) -> action decision matrix
 *
 * Run: node --test tests/launch_safety.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { killCommandFor, launchDecision } from '../src/core/health.js';

describe('killCommandFor', () => {
  it('win32 targets a specific PID, not the image name', () => {
    const { cmd, args } = killCommandFor('win32', 1234);
    assert.equal(cmd, 'taskkill');
    const joined = [cmd, ...args].join(' ');
    assert.ok(joined.includes('1234'), 'command must include the PID');
    assert.ok(args.includes('/PID'), 'must use /PID targeting');
    assert.ok(!joined.includes('/IM'), 'must NOT use /IM (image-name) targeting');
    assert.ok(!/TradingView\.exe/i.test(joined), 'must NOT reference the image name');
  });

  it('darwin targets a specific PID, not the image name', () => {
    const { cmd, args } = killCommandFor('darwin', 4321);
    assert.equal(cmd, 'kill');
    const joined = [cmd, ...args].join(' ');
    assert.ok(joined.includes('4321'), 'command must include the PID');
    assert.ok(!/-f/.test(joined), 'must NOT use pkill -f style image matching');
    assert.ok(!/TradingView/i.test(joined), 'must NOT reference the image name');
  });

  it('linux targets a specific PID, not the image name', () => {
    const { cmd, args } = killCommandFor('linux', 999);
    assert.equal(cmd, 'kill');
    const joined = [cmd, ...args].join(' ');
    assert.ok(joined.includes('999'), 'command must include the PID');
    assert.ok(!/TradingView/i.test(joined), 'must NOT reference the image name');
  });

  it('rejects invalid PIDs', () => {
    assert.throws(() => killCommandFor('win32', 0), /invalid pid/);
    assert.throws(() => killCommandFor('linux', -1), /invalid pid/);
    assert.throws(() => killCommandFor('darwin', 1.5), /invalid pid/);
    assert.throws(() => killCommandFor('win32', undefined), /invalid pid/);
  });
});

describe('launchDecision', () => {
  it('port up + !kill -> already_running (no kill, no spawn)', () => {
    assert.equal(
      launchDecision({ portResponding: true, killExisting: false, knownPid: null }),
      'already_running',
    );
    // Even if we happen to know our own pid, without kill we still skip.
    assert.equal(
      launchDecision({ portResponding: true, killExisting: false, knownPid: 1234 }),
      'already_running',
    );
  });

  it('port up + kill + knownPid -> restart', () => {
    assert.equal(
      launchDecision({ portResponding: true, killExisting: true, knownPid: 1234 }),
      'restart',
    );
  });

  it('port up + kill + no knownPid -> refuse_kill_unknown (never kill a foreign instance)', () => {
    assert.equal(
      launchDecision({ portResponding: true, killExisting: true, knownPid: null }),
      'refuse_kill_unknown',
    );
  });

  it('port down -> spawn regardless of kill flag or known pid', () => {
    assert.equal(
      launchDecision({ portResponding: false, killExisting: false, knownPid: null }),
      'spawn',
    );
    assert.equal(
      launchDecision({ portResponding: false, killExisting: true, knownPid: 1234 }),
      'spawn',
    );
  });
});
