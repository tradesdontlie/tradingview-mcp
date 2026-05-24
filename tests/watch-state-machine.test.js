/**
 * Phase 3C: watch-mode state machine tests.
 * Runs offline — no TradingView connection required.
 *
 * Run: node --test tests/watch-state-machine.test.js
 *
 * Covers all 14 required cases from Phase 3C spec:
 *  1.  A+ LONG alerts once
 *  2.  A+ SHORT alerts once
 *  3.  Duplicate identical A+ LONG does not alert twice
 *  3b. Duplicate identical A+ SHORT does not alert twice
 *  4.  Changed A+ setup key can alert again
 *  5.  A confidence LONG does not alert
 *  6.  A- confidence LONG does not alert
 *  7.  B+ confidence LONG does not alert
 *  8.  B confidence LONG does not alert
 *  9.  C confidence LONG does not alert
 *  10. Reject does not alert
 *  11. WAIT does not alert and resets state to IDLE
 *  12. Stale/expired/invalidated does not alert and resets safely
 *  13. After WAIT reset, fresh valid A+ LONG/SHORT can alert again
 *  14. State machine is pure/deterministic — no timers, no process access
 */

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  STATE,
  createSymbolState,
  makeSignalKey,
  transition,
  isActionableAPlus,
} from '../watch/watchStateMachine.js';
import { scanOnce } from '../watch/watchCli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Signal fixtures ─────────────────────────────────────────────────────────

function makeAplusLong(overrides = {}) {
  return {
    symbol:            'MNQ1!',
    decision:          'LONG',
    confidence:        'A+',
    entry:             21000,
    stop:              20997.5,
    tp1:               21015,
    tp2:               null,
    r:                 6.0,
    setup:             'MTF Session Liquidity Trap',
    reasons:           ['test'],
    invalidation:      [],
    what_would_change: '',
    status:            'pending',
    outcome_r:         null,
    _meta: {
      sweep_bar_index:        6,
      reclaim_bar_index:      8,
      mss_bar_index:          10,
      displacement_bar_index: 12,
    },
    ...overrides,
  };
}

function makeAplusShort(overrides = {}) {
  return makeAplusLong({
    decision: 'SHORT',
    entry:    20800,
    stop:     20802.5,
    tp1:      20785,
    ...overrides,
  });
}

function makeWaitSignal(symbol = 'MNQ1!') {
  return { symbol, decision: 'WAIT', confidence: 'Reject' };
}

const SILENT_SINKS  = { onAlert: () => {}, onSummary: () => {} };
const RULES_NO_LIVE = {
  risk: {
    live_trading_enabled: false,
    min_reward_risk:      1.5,
    max_stop_ticks:       { 'MNQ1!': 40 },
  },
};

// ─── isActionableAPlus gate ───────────────────────────────────────────────────

describe('Phase 3C: isActionableAPlus gate', () => {
  it('returns true for A+ LONG', () => {
    assert.equal(isActionableAPlus(makeAplusLong()),  true);
  });

  it('returns true for A+ SHORT', () => {
    assert.equal(isActionableAPlus(makeAplusShort()), true);
  });

  it('returns false for null', () => {
    assert.equal(isActionableAPlus(null),      false);
  });

  it('returns false for undefined', () => {
    assert.equal(isActionableAPlus(undefined), false);
  });

  it('returns false for A+ WAIT (decision must be LONG or SHORT)', () => {
    assert.equal(isActionableAPlus({ decision: 'WAIT', confidence: 'A+' }), false);
  });

  it('returns false for A+ with unrecognised decision', () => {
    assert.equal(isActionableAPlus({ decision: 'HOLD',   confidence: 'A+' }), false);
    assert.equal(isActionableAPlus({ decision: 'REJECT', confidence: 'A+' }), false);
    assert.equal(isActionableAPlus({ decision: '',       confidence: 'A+' }), false);
  });

  const subGrades = ['A', 'A-', 'B+', 'B', 'C', 'Reject'];
  for (const grade of subGrades) {
    it(`returns false for ${grade} LONG (confidence must be A+)`, () => {
      assert.equal(isActionableAPlus(makeAplusLong({ confidence: grade })), false);
    });
    it(`returns false for ${grade} SHORT (confidence must be A+)`, () => {
      assert.equal(isActionableAPlus(makeAplusShort({ confidence: grade })), false);
    });
  }
});

// ─── A+ LONG / SHORT alert once ──────────────────────────────────────────────

describe('Phase 3C: transition() — A+ LONG/SHORT alert once (tests 1-4)', () => {
  it('1. A+ LONG alerts once → alert=true, state=ALERTED, decision=LONG', () => {
    const st     = createSymbolState('MNQ1!');
    const signal = makeAplusLong();
    const { newState, alert, event } = transition(st, signal);

    assert.equal(alert,                   true,          'must fire alert');
    assert.equal(event,                   'new_alert');
    assert.equal(newState.state,          STATE.ALERTED);
    assert.equal(newState.lastAlertedKey, makeSignalKey(signal));
    assert.ok(
      signal.decision === 'LONG' || signal.decision === 'SHORT',
      'decision must be LONG or SHORT for an actionable alert',
    );
  });

  it('2. A+ SHORT alerts once → alert=true, state=ALERTED, decision=SHORT', () => {
    const st     = createSymbolState('MNQ1!');
    const signal = makeAplusShort();
    const { newState, alert, event } = transition(st, signal);

    assert.equal(alert,          true,          'must fire alert for SHORT');
    assert.equal(event,          'new_alert');
    assert.equal(newState.state, STATE.ALERTED);
    assert.equal(signal.decision, 'SHORT');
  });

  it('3. Duplicate identical A+ LONG does not alert twice (duplicate_suppressed)', () => {
    const st0    = createSymbolState('MNQ1!');
    const signal = makeAplusLong();
    const { newState: st1 }               = transition(st0, signal);
    const { newState: st2, alert, event } = transition(st1, signal);

    assert.equal(alert,              false,                'duplicate must not alert');
    assert.equal(event,              'duplicate_suppressed');
    assert.equal(st2.state,          STATE.ALERTED);
    assert.equal(st2.lastAlertedKey, makeSignalKey(signal), 'key must be preserved');
  });

  it('3b. Duplicate identical A+ SHORT does not alert twice', () => {
    const st0    = createSymbolState('MNQ1!');
    const signal = makeAplusShort();
    const { newState: st1 }               = transition(st0, signal);
    const { newState: st2, alert, event } = transition(st1, signal);

    assert.equal(alert, false, 'duplicate SHORT must not alert');
    assert.equal(event, 'duplicate_suppressed');
    assert.equal(st2.state, STATE.ALERTED);
  });

  it('4. Changed A+ setup key can alert again → alert=true, new_alert', () => {
    const st0     = createSymbolState('MNQ1!');
    const signal1 = makeAplusLong();
    const { newState: st1 } = transition(st0, signal1);

    const signal2 = makeAplusLong({
      _meta: { ...signal1._meta, displacement_bar_index: 99 },
    });
    const { newState: st2, alert, event } = transition(st1, signal2);

    assert.equal(alert,       true,        'different key must alert again');
    assert.equal(event,       'new_alert');
    assert.equal(st2.state,   STATE.ALERTED);
    assert.notEqual(
      makeSignalKey(signal2),
      makeSignalKey(signal1),
      'keys must differ for different setups',
    );
  });
});

// ─── Non-A+ grades do NOT alert (tests 5-10) ─────────────────────────────────

describe('Phase 3C: transition() — non-A+ confidence grades do NOT alert (tests 5-10)', () => {
  const nonAlertGrades = [
    { grade: 'A',      testNum: '5'  },
    { grade: 'A-',     testNum: '6'  },
    { grade: 'B+',     testNum: '7'  },
    { grade: 'B',      testNum: '8'  },
    { grade: 'C',      testNum: '9'  },
    { grade: 'Reject', testNum: '10' },
  ];

  for (const { grade, testNum } of nonAlertGrades) {
    it(`${testNum}. ${grade} LONG → alert=false, state=TRACKING, not ALERTED`, () => {
      const st     = createSymbolState('MNQ1!');
      const signal = makeAplusLong({ confidence: grade });
      const { newState, alert } = transition(st, signal);

      assert.equal(alert,               false,         `${grade} LONG must not alert`);
      assert.equal(newState.state,      STATE.TRACKING, `${grade} LONG must go to TRACKING`);
      assert.notEqual(newState.state,   STATE.ALERTED,  'must not be ALERTED');
    });

    it(`${testNum}. ${grade} SHORT → alert=false, state=TRACKING, not ALERTED`, () => {
      const st     = createSymbolState('MNQ1!');
      const signal = makeAplusShort({ confidence: grade });
      const { newState, alert } = transition(st, signal);

      assert.equal(alert,             false,         `${grade} SHORT must not alert`);
      assert.equal(newState.state,    STATE.TRACKING, `${grade} SHORT must go to TRACKING`);
      assert.notEqual(newState.state, STATE.ALERTED,  'must not be ALERTED');
    });
  }
});

// ─── WAIT / stale / expired / invalidated reset (tests 11-13) ────────────────

describe('Phase 3C: transition() — WAIT/stale/expired/invalidated reset (tests 11-13)', () => {
  it('11. WAIT signal does not alert and resets ALERTED → IDLE, key cleared', () => {
    const st0    = createSymbolState('MNQ1!');
    const signal = makeAplusLong();
    const { newState: alertedState } = transition(st0, signal);
    assert.equal(alertedState.state, STATE.ALERTED);

    const { newState, alert, event } = transition(alertedState, makeWaitSignal());

    assert.equal(alert,                   false);
    assert.equal(event,                   'signal_expired');
    assert.equal(newState.state,          STATE.IDLE);
    assert.equal(newState.lastAlertedKey, null, 'lastAlertedKey must be null after WAIT reset');
  });

  it('11b. WAIT on fresh IDLE → idle_wait, alert=false, stays IDLE', () => {
    const st = createSymbolState('MNQ1!');
    const { newState, alert, event } = transition(st, makeWaitSignal());

    assert.equal(alert,          false);
    assert.equal(event,          'idle_wait');
    assert.equal(newState.state, STATE.IDLE);
  });

  it('12a. Stale signal resets ALERTED → IDLE (staleness_reset), no alert', () => {
    const st0    = createSymbolState('MNQ1!');
    const signal = makeAplusLong();
    const { newState: alertedState } = transition(st0, signal);

    const { newState, alert, event } = transition(
      alertedState,
      signal,
      { staleness: 'price beyond tp1' },
    );

    assert.equal(alert,          false);
    assert.equal(event,          'staleness_reset');
    assert.equal(newState.state, STATE.IDLE);
  });

  it('12b. EXPIRED terminal state auto-resets at next tick; fresh A+ then alerts', () => {
    const expiredState = { ...createSymbolState('MNQ1!'), state: STATE.EXPIRED };
    const signal       = makeAplusLong();
    const { newState, alert, event } = transition(expiredState, signal);

    assert.equal(alert,          true,          'A+ after EXPIRED reset must alert');
    assert.equal(event,          'new_alert');
    assert.equal(newState.state, STATE.ALERTED);
  });

  it('12c. INVALIDATED terminal state auto-resets at next tick; fresh A+ then alerts', () => {
    const invalidState = { ...createSymbolState('MNQ1!'), state: STATE.INVALIDATED };
    const signal       = makeAplusLong();
    const { newState, alert, event } = transition(invalidState, signal);

    assert.equal(alert,          true,          'A+ after INVALIDATED reset must alert');
    assert.equal(event,          'new_alert');
    assert.equal(newState.state, STATE.ALERTED);
  });

  it('13. After WAIT reset, fresh A+ LONG alerts again (key cleared)', () => {
    const st0    = createSymbolState('MNQ1!');
    const signal = makeAplusLong();

    const { newState: st1 } = transition(st0, signal);
    assert.equal(st1.state, STATE.ALERTED);

    const { newState: st2 } = transition(st1, makeWaitSignal());
    assert.equal(st2.state,          STATE.IDLE);
    assert.equal(st2.lastAlertedKey, null);

    const signal2 = makeAplusLong({ entry: 21050, tp1: 21065 });
    const { newState: st3, alert: alert3, event: ev3 } = transition(st2, signal2);

    assert.equal(alert3,       true,          'fresh A+ after WAIT must alert again');
    assert.equal(ev3,          'new_alert');
    assert.equal(st3.state,    STATE.ALERTED);
  });

  it('13b. After WAIT reset, same-key A+ also alerts again (key was cleared)', () => {
    const st0    = createSymbolState('MNQ1!');
    const signal = makeAplusLong();

    const { newState: st1 }                           = transition(st0, signal);
    const { newState: st2 }                           = transition(st1, makeWaitSignal());
    const { alert, event, newState: st3 }             = transition(st2, signal);

    assert.equal(alert,     true,       'after WAIT reset, same-key A+ must alert (key cleared)');
    assert.equal(event,     'new_alert');
    assert.equal(st3.state, STATE.ALERTED);
  });

  it('13c. After WAIT reset, fresh A+ SHORT alerts again', () => {
    const st0    = createSymbolState('MNQ1!');
    const signal = makeAplusShort();

    const { newState: st1 } = transition(st0, signal);
    const { newState: st2 } = transition(st1, makeWaitSignal());
    const { alert, event }  = transition(st2, signal);

    assert.equal(alert, true,       'fresh A+ SHORT after WAIT must alert again');
    assert.equal(event, 'new_alert');
  });
});

// ─── Purity and determinism (test 14) ────────────────────────────────────────

describe('Phase 3C: transition() — purity and determinism (test 14)', () => {
  it('14. Identical inputs produce identical outputs; original state is not mutated', () => {
    const st     = createSymbolState('MNQ1!');
    const signal = makeAplusLong();

    const result1 = transition(st, signal);
    const result2 = transition(st, signal);

    assert.deepEqual(result1, result2, 'same inputs must produce same outputs');
    assert.equal(st.state,           STATE.IDLE, 'original state must not be mutated');
    assert.equal(st.lastAlertedKey,  null,       'original lastAlertedKey must not be mutated');
  });

  it('14b. Calling transition never touches process or timers (pure function)', () => {
    const origExit    = process.exit;
    const origStdout  = process.stdout.write.bind(process.stdout);
    let   exitCalled  = false;
    let   writeCalled = false;

    process.exit              = () => { exitCalled = true; };
    process.stdout.write      = (...a) => { writeCalled = true; return origStdout(...a); };

    try {
      const st     = createSymbolState('MNQ1!');
      const signal = makeAplusLong();
      transition(st, signal);
      assert.equal(exitCalled,  false, 'transition must not call process.exit');
      assert.equal(writeCalled, false, 'transition must not write to stdout');
    } finally {
      process.exit         = origExit;
      process.stdout.write = origStdout;
    }
  });
});

// ─── scanOnce resilience ─────────────────────────────────────────────────────

describe('Phase 3C: scanOnce resilience', () => {
  it('MCP fetch error → does not throw, returns unchanged state, alerted=false', async () => {
    const st            = createSymbolState('MNQ1!');
    const overrideFetch = async () => { throw new Error('MCP connection failed'); };

    let result;
    await assert.doesNotReject(async () => {
      result = await scanOnce('MNQ1!', st, RULES_NO_LIVE, overrideFetch, SILENT_SINKS);
    });

    assert.equal(result.newSymbolState.state, STATE.IDLE);
    assert.equal(result.alerted,              false);
  });
});

// ─── Safety guards ────────────────────────────────────────────────────────────

describe('Phase 3C: safety guards', () => {
  it('live_trading_enabled remains false in rules.json', () => {
    const rules = JSON.parse(readFileSync(join(__dirname, '..', 'rules.json'), 'utf8'));
    assert.equal(rules?.risk?.live_trading_enabled, false, 'live_trading_enabled must remain false');
  });

  it('no broker/order/live execution patterns in watch files', () => {
    const files  = ['watch/watchStateMachine.js', 'watch/alertSink.js', 'watch/watchCli.js'];
    const banned = ['placeOrder', 'submitOrder', 'createOrder', 'executeOrder', 'live_execution'];
    for (const f of files) {
      const content = readFileSync(join(__dirname, '..', f), 'utf8');
      for (const pattern of banned) {
        assert.ok(!content.includes(pattern), `${f} must not contain "${pattern}"`);
      }
    }
  });
});
