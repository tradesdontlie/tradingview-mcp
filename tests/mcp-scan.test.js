/**
 * mcp-scan.test.js — Offline tests for cli/scan.js and mcpDataProvider.
 *
 * All tests run without a TradingView connection.
 * The CLI smoke tests rely on MCP connect/health failing fast (ECONNREFUSED)
 * when port 9222 is not open.
 *
 * Run: node --test tests/mcp-scan.test.js
 */

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';
import { spawnSync }    from 'node:child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync }  from 'fs';
import { normalizeBar }  from '../data/mcpDataProvider.js';
import { checkStaleness, rejectToWait, validate } from '../risk/riskManager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCAN      = join(__dirname, '..', 'cli', 'scan.js');

/** Spawns cli/scan.js with given args, returns spawnSync result. */
function runScan(args = [], timeoutMs = 25_000) {
  return spawnSync('node', [SCAN, ...args], {
    timeout:  timeoutMs,
    encoding: 'utf8',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizeBar() — pure unit tests, no process spawn
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeBar()', () => {
  it('handles TradingView format { time(s), open, high, low, close, volume }', () => {
    const b = { time: 1748000000, open: 100, high: 102, low: 99, close: 101, volume: 1000 };
    const n = normalizeBar(b);
    assert.equal(n.ts,    1748000000 * 1000, 'ts should be converted to ms');
    assert.equal(n.open,  100);
    assert.equal(n.high,  102);
    assert.equal(n.low,    99);
    assert.equal(n.close, 101);
    assert.equal(n.vol,  1000);
  });

  it('converts seconds to milliseconds when timestamp < 1e12', () => {
    const b = { time: 1_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 };
    const n = normalizeBar(b);
    assert.equal(n.ts, 1_000_000 * 1000);
  });

  it('leaves millisecond timestamps unchanged', () => {
    const b = { ts: 1_748_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, vol: 10 };
    const n = normalizeBar(b);
    assert.equal(n.ts, 1_748_000_000_000);
  });

  it('handles shorthand field names { o, h, l, c, v }', () => {
    const b = { ts: 1_748_000_000, o: 100, h: 102, l: 99, c: 101, v: 500 };
    const n = normalizeBar(b);
    assert.equal(n.open,  100);
    assert.equal(n.high,  102);
    assert.equal(n.low,    99);
    assert.equal(n.close, 101);
    assert.equal(n.vol,   500);
  });

  it('defaults missing vol/volume/v to 0', () => {
    const b = { time: 1_748_000_000, open: 1, high: 2, low: 0.5, close: 1.5 };
    assert.equal(normalizeBar(b).vol, 0);
  });

  it('returns zero-value object for null/non-object input', () => {
    const n = normalizeBar(null);
    assert.equal(n.ts,    0);
    assert.equal(n.close, 0);
    assert.equal(n.vol,   0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cli/scan.js — offline smoke tests (spawnSync, no TradingView required)
// ─────────────────────────────────────────────────────────────────────────────

describe('scan.js CLI (offline)', () => {
  it('--help exits 0 and stdout includes "Usage:"', () => {
    const r = runScan(['--help']);
    assert.equal(r.status, 0, `unexpected exit code. stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('Usage:'), 'stdout should include Usage:');
  });

  it('--symbol INVALID exits 1', () => {
    const r = runScan(['--symbol', 'INVALID_SYM']);
    assert.equal(r.status, 1, 'invalid symbol should exit 1');
  });

  it('no TradingView: exits 0 (does not crash)', () => {
    const r = runScan(['--symbol', 'MNQ1!']);
    // spawnSync sets status=null and error if it times out
    assert.ok(r.error == null, `process timed out or errored: ${r.error}`);
    assert.equal(r.status, 0, `expected exit 0. stderr: ${r.stderr}`);
  });

  it('no TradingView: stdout is valid JSON', () => {
    const r = runScan(['--symbol', 'MNQ1!']);
    assert.doesNotThrow(
      () => JSON.parse(r.stdout),
      'stdout must be valid JSON',
    );
  });

  it('no TradingView: stdout starts with { (no leading log lines)', () => {
    const r = runScan(['--symbol', 'MNQ1!']);
    assert.ok(
      r.stdout.trim().startsWith('{'),
      `stdout must start with JSON object, got: ${r.stdout.slice(0, 40)}`,
    );
  });

  it('no TradingView: decision === WAIT', () => {
    const r  = runScan(['--symbol', 'MNQ1!']);
    const sig = JSON.parse(r.stdout);
    assert.equal(sig.decision, 'WAIT', `decision should be WAIT, got: ${sig.decision}`);
  });

  it('no TradingView: all required signal schema fields are present', () => {
    const r   = runScan(['--symbol', 'MNQ1!']);
    const sig = JSON.parse(r.stdout);
    const required = [
      'id', 'timestamp', 'date', 'time', 'symbol', 'decision',
      'bias', 'setup', 'entry', 'stop', 'tp1', 'tp2', 'r',
      'confidence', 'reasons', 'invalidation', 'what_would_change',
      'status', 'outcome_r',
    ];
    for (const field of required) {
      assert.ok(field in sig, `missing required field: "${field}"`);
    }
  });

  it('no TradingView: bias object has all four timeframe keys', () => {
    const r   = runScan(['--symbol', 'MNQ1!']);
    const sig = JSON.parse(r.stdout);
    assert.ok(typeof sig.bias === 'object' && sig.bias !== null, 'bias must be an object');
    for (const tf of ['4H', '1H', '15m', '5m']) {
      assert.ok(tf in sig.bias, `bias missing key: "${tf}"`);
    }
  });

  it('no TradingView: reasons is a non-empty array', () => {
    const r   = runScan(['--symbol', 'MNQ1!']);
    const sig = JSON.parse(r.stdout);
    assert.ok(Array.isArray(sig.reasons),      'reasons must be an array');
    assert.ok(sig.reasons.length > 0,          'reasons must not be empty');
  });

  it('no TradingView: default symbol is MNQ1! when --symbol is omitted', () => {
    const r   = runScan([]);   // no --symbol flag
    const sig = JSON.parse(r.stdout);
    assert.equal(sig.symbol, 'MNQ1!', 'default symbol should be MNQ1!');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3A-FIX: staleness, risk rejection, and guard tests
// All run without a TradingView connection — pure unit tests.
// ─────────────────────────────────────────────────────────────────────────────

const RULES = JSON.parse(readFileSync(join(__dirname, '..', 'rules.json'), 'utf8'));

/** Minimal valid LONG signal. All validate() gates pass by default. */
function makeLong(overrides = {}) {
  return {
    id:                '2026-05-23T10:00:00.000Z-MNQ1!',
    timestamp:         '2026-05-23T10:00:00.000Z',
    date:              '2026-05-23',
    time:              '10:00',
    symbol:            'MNQ1!',
    decision:          'LONG',
    bias:              { '4H': 'bullish', '1H': 'bullish', '15m': 'bullish', '5m': 'bullish' },
    setup:             'MTF Session Liquidity Trap',
    entry:             21000,
    stop:              20997.5,   // 10 ticks below entry
    tp1:               21080,
    tp2:               null,
    r:                 32.0,
    confidence:        'A',
    reasons:           ['test signal'],
    invalidation:      [],
    what_would_change: '',
    status:            'pending',
    outcome_r:         null,
    ...overrides,
  };
}

/** Minimal valid SHORT signal. All validate() gates pass by default. */
function makeShort(overrides = {}) {
  return {
    id:                '2026-05-23T10:00:00.000Z-MNQ1!',
    timestamp:         '2026-05-23T10:00:00.000Z',
    date:              '2026-05-23',
    time:              '10:00',
    symbol:            'MNQ1!',
    decision:          'SHORT',
    bias:              { '4H': 'bearish', '1H': 'bearish', '15m': 'bearish', '5m': 'bearish' },
    setup:             'MTF Session Liquidity Trap',
    entry:             21200,
    stop:              21202.5,   // 10 ticks above entry (SHORT stop is above)
    tp1:               21120,     // profit target is below entry for SHORT
    tp2:               null,
    r:                 32.0,
    confidence:        'A',
    reasons:           ['test signal'],
    invalidation:      [],
    what_would_change: '',
    status:            'pending',
    outcome_r:         null,
    ...overrides,
  };
}

describe('Phase 3A-FIX: staleness checks (checkStaleness)', () => {
  // ── LONG: price already at/beyond TP1 ──────────────────────────────────────

  it('LONG: current_price === tp1 → stale (beyond TP1)', () => {
    const sig    = makeLong({ entry: 21000, tp1: 21080 });
    const reason = checkStaleness(sig, 21080);
    assert.ok(reason !== null,                      'should return stale reason');
    assert.ok(reason.includes('beyond TP1'),         `reason: ${reason}`);
  });

  it('LONG: current_price > tp1 → stale (beyond TP1)', () => {
    const sig    = makeLong({ entry: 21000, tp1: 21080 });
    const reason = checkStaleness(sig, 21090);
    assert.ok(reason !== null,               'should return stale reason');
    assert.ok(reason.includes('beyond TP1'), `reason: ${reason}`);
  });

  // ── LONG: price too far above entry (chased) ───────────────────────────────
  // 4 ticks * 0.25 = 1.0 pt tolerance. entry + 1.0 = 21001.0.
  // current > 21001.0 → stale.

  it('LONG: current_price > entry + 4 ticks → stale (chased)', () => {
    const sig    = makeLong({ entry: 21000, tp1: 21080 });
    const reason = checkStaleness(sig, 21001.25);   // 5 ticks above
    assert.ok(reason !== null,                      'should return stale reason');
    assert.ok(reason.includes('too far from entry'), `reason: ${reason}`);
  });

  it('LONG: current_price === entry + 4 ticks → NOT stale (boundary, strict >)', () => {
    const sig = makeLong({ entry: 21000, tp1: 21080 });
    assert.equal(checkStaleness(sig, 21001.0), null, 'exactly at boundary should not be stale');
  });

  it('LONG: current_price within 4 ticks of entry → NOT stale', () => {
    const sig = makeLong({ entry: 21000, tp1: 21080 });
    assert.equal(checkStaleness(sig, 21000.75), null, '3 ticks above entry should not be stale');
  });

  // ── SHORT: price already at/below TP1 ─────────────────────────────────────

  it('SHORT: current_price === tp1 → stale (beyond TP1)', () => {
    const sig    = makeShort({ entry: 21200, tp1: 21120 });
    const reason = checkStaleness(sig, 21120);
    assert.ok(reason !== null,               'should return stale reason');
    assert.ok(reason.includes('beyond TP1'), `reason: ${reason}`);
  });

  it('SHORT: current_price < tp1 → stale (beyond TP1)', () => {
    const sig    = makeShort({ entry: 21200, tp1: 21120 });
    const reason = checkStaleness(sig, 21100);
    assert.ok(reason !== null,               'should return stale reason');
    assert.ok(reason.includes('beyond TP1'), `reason: ${reason}`);
  });

  // ── SHORT: price too far below entry (chased) ──────────────────────────────
  // 4 ticks * 0.25 = 1.0 pt. entry - 1.0 = 21199.0.
  // current < 21199.0 → stale.

  it('SHORT: current_price < entry - 4 ticks → stale (chased)', () => {
    const sig    = makeShort({ entry: 21200, tp1: 21120 });
    const reason = checkStaleness(sig, 21198.75);   // 5 ticks below
    assert.ok(reason !== null,                      'should return stale reason');
    assert.ok(reason.includes('too far from entry'), `reason: ${reason}`);
  });

  it('SHORT: current_price === entry - 4 ticks → NOT stale (boundary, strict <)', () => {
    const sig = makeShort({ entry: 21200, tp1: 21120 });
    assert.equal(checkStaleness(sig, 21199.0), null, 'exactly at boundary should not be stale');
  });

  // ── currentPrice = null → no staleness check ───────────────────────────────

  it('currentPrice = null → checkStaleness returns null (no quote available)', () => {
    const sig = makeLong();
    assert.equal(checkStaleness(sig, null), null, 'null price should skip staleness check');
  });

  // ── WAIT signals are never stale-checked ──────────────────────────────────

  it('WAIT signal → checkStaleness always returns null', () => {
    const wait = { ...makeLong(), decision: 'WAIT', entry: null, tp1: null };
    assert.equal(checkStaleness(wait, 21090), null);
  });
});

describe('Phase 3A-FIX: rejectToWait conversion', () => {
  it('LONG: rejectToWait produces schema-complete WAIT with nulled trade fields', () => {
    const sig  = makeLong({ entry: 21000, tp1: 21080 });
    const wait = rejectToWait(sig, 'signal stale: current price already beyond TP1', 'expired');

    assert.equal(wait.decision,    'WAIT');
    assert.equal(wait.confidence,  'Reject');
    assert.equal(wait.status,      'expired');
    assert.equal(wait.entry,       null);
    assert.equal(wait.stop,        null);
    assert.equal(wait.tp1,         null);
    assert.equal(wait.tp2,         null);
    assert.equal(wait.r,           null);
    assert.ok(wait.reasons.some(r => r.includes('beyond TP1')));
  });

  it('rejectToWait preserves original candidate under _meta.rejected_candidate', () => {
    const sig  = makeLong({ entry: 21000, stop: 20997.5, tp1: 21080, r: 32.0, confidence: 'A' });
    const wait = rejectToWait(sig, 'test reason', 'expired');

    const rc = wait._meta?.rejected_candidate;
    assert.ok(rc != null,                'rejected_candidate must be present');
    assert.equal(rc.decision,   'LONG');
    assert.equal(rc.entry,      21000);
    assert.equal(rc.stop,       20997.5);
    assert.equal(rc.tp1,        21080);
    assert.equal(rc.r,          32.0);
    assert.equal(rc.confidence, 'A');
  });

  it('SHORT: rejectToWait status=pending when risk (not staleness) caused rejection', () => {
    const sig  = makeShort({ entry: 21200, stop: 20750, tp1: 21500, r: 2.0 });
    const wait = rejectToWait(sig, 'stop_too_wide', 'pending');
    assert.equal(wait.status,   'pending');
    assert.equal(wait.decision, 'WAIT');
  });
});

describe('Phase 3A-FIX: validate() additions', () => {
  it('missing tp1: validate() rejects with tp1_undefined', () => {
    const sig = makeLong({ tp1: null, r: null });
    const { approved, rejection_reason } = validate(sig, RULES);
    assert.equal(approved, false);
    assert.ok(rejection_reason.includes('tp1'), `expected tp1 in reason, got: ${rejection_reason}`);
  });

  it('r is null: validate() rejects with r_is_null', () => {
    const sig = makeLong({ r: null });   // tp1 is still set (21080)
    const { approved, rejection_reason } = validate(sig, RULES);
    assert.equal(approved, false);
    assert.ok(rejection_reason.includes('r_is_null'), `expected r_is_null, got: ${rejection_reason}`);
  });

  it('risk rejection: validate() + rejectToWait produces auditable WAIT', () => {
    // Wide stop: |21000 - 20750| / 0.25 = 1000 ticks >> 40 max
    const sig = makeLong({ entry: 21000, stop: 20750, tp1: 21500, r: 2.0 });
    const { approved, rejection_reason } = validate(sig, RULES);

    assert.equal(approved, false,           'wide stop must be rejected');
    assert.ok(rejection_reason.includes('stop_too_wide'), `reason: ${rejection_reason}`);

    const wait = rejectToWait(sig, rejection_reason, 'pending');
    assert.equal(wait.decision,   'WAIT');
    assert.equal(wait.status,     'pending');
    assert.equal(wait.confidence, 'Reject');
    assert.ok(wait.reasons.includes(rejection_reason));
    assert.equal(wait._meta?.rejected_candidate?.entry, 21000);
    assert.equal(wait._meta?.rejected_candidate?.stop,  20750);
  });

  it('non-stale valid signal: checkStaleness returns null and validate approves', () => {
    // entry=21000, current=21000.75 (3 ticks above, within 4-tick tolerance)
    const sig = makeLong({ entry: 21000, stop: 20997.5, tp1: 21080, r: 32.0 });
    assert.equal(checkStaleness(sig, 21000.75), null, 'should not be stale near entry');
    const { approved } = validate(sig, RULES);
    assert.equal(approved, true, 'valid signal should pass risk validation');
  });
});

describe('Phase 3A-FIX: safety guards', () => {
  it('live_trading_enabled remains false in rules.json', () => {
    assert.equal(RULES?.risk?.live_trading_enabled, false,
      'live_trading_enabled must remain false');
  });

  it('validate() blocks any signal when live_trading_enabled is true', () => {
    const badRules = { ...RULES, risk: { ...RULES.risk, live_trading_enabled: true } };
    const { approved, rejection_reason } = validate(makeLong(), badRules);
    assert.equal(approved, false);
    assert.ok(rejection_reason.includes('live_trading_enabled'), `reason: ${rejection_reason}`);
  });

  it('no broker/order/live execution patterns in cli/scan.js or risk/riskManager.js', () => {
    const scanSrc = readFileSync(join(__dirname, '..', 'cli', 'scan.js'),       'utf8');
    const riskSrc = readFileSync(join(__dirname, '..', 'risk', 'riskManager.js'), 'utf8');
    for (const [name, src] of [['scan.js', scanSrc], ['riskManager.js', riskSrc]]) {
      for (const pattern of ['placeOrder', 'submitOrder', 'createOrder', 'executeOrder']) {
        assert.ok(!src.includes(pattern), `${name} must not contain "${pattern}"`);
      }
    }
  });
});
