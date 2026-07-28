// Self-check fmtCheck (T+ render). Run: node test_fmt_check.mjs  (expect ALL PASS)
import assert from 'node:assert';
import { fmtCheck } from './fmt_check.mjs';

// Fixture 1 (VN co warn): DATA_JSON co tplus + 1 scenario co tplus_warn.
const d1 = {
    ticker: 'HOSE:POW', price: 14900, date: '2026-07-06', structure: 'UPTREND',
    fp: { conf: 72, checks: { a: true, b: true, c: false }, score: 55, cumD: 1200, buyPct: 60, div: 1 },
    wave: { phase: 'IMPULSE', tp: { tp100: 15500, tp1272: 16200, tp1618: 17000 } },
    trail: { status: 'above', sma20_current: 14700 },
    ma: { sma20: 14700, sma100: 13800 },
    mtf: { notes: ['D2 len', 'W de'] },
    tplus: { lock_sessions: 2.5, atr_pct: 2.65, floor_pct: 4.23, exit_rule: 'ban phien chieu T+2' },
    scenarios: [{ label: 'breakout', sl_atr: 0.5, rr_locked: 1.5, tplus_warn: 'SL 0.5xATR trong 2 phien T+' }],
};
const out1 = fmtCheck('xxx\nDATA_JSON:' + JSON.stringify(d1));
assert.ok(out1.includes('T+: khoa 2.5 phien'), `F1 thieu dong T+ (got:\n${out1})`);
assert.ok(out1.includes('0.5xATR'), `F1 thieu canh bao SL ATR (got:\n${out1})`);
assert.ok(out1.includes('RR-ket 1.5'), 'F1 thieu RR-ket');
assert.ok(!out1.includes('undefined'), 'F1 co chu undefined');

// Fixture 2 (tplus null nhu XAUUSD): KHONG in T+ va KHONG in ⚠️.
const d2 = {
    ticker: 'ICMARKETS:XAUUSD', price: 2350, date: '2026-07-06', structure: 'UPTREND',
    fp: { conf: 60, checks: {}, score: 50 },
    wave: { phase: 'IMPULSE' }, trail: {}, ma: {}, mtf: {},
    tplus: null, scenarios: [{ label: 'retest', sl_atr: 2.0 }],
};
const out2 = fmtCheck('DATA_JSON:' + JSON.stringify(d2));
assert.ok(!out2.includes('T+:'), `F2 khong duoc co T+ (got:\n${out2})`);
assert.ok(!out2.includes('⚠️'), `F2 khong duoc co ⚠️ (got:\n${out2})`);

// Fixture 3: raw khong co DATA_JSON: -> tra nguyen van input.
const raw3 = 'LOI: khong co output';
assert.equal(fmtCheck(raw3), raw3, 'F3 phai tra nguyen input khi thieu DATA_JSON');
assert.equal(fmtCheck('gi do'), 'gi do', 'F3 plain text giu nguyen');

// Fixture 4: entering the geometry is not a passed readiness proof.
const inZoneWithoutProof = {
    ticker: 'HOSE:ACB', price: 25000, date: '2026-07-21', setup_state: 'IN_ZONE',
    fp: {}, wave: {}, trail: {}, ma: {}, mtf: {},
    readiness: { plan_status: 'WATCH' },
};
const out4 = fmtCheck('DATA_JSON:' + JSON.stringify(inZoneWithoutProof));
assert.ok(out4.includes('SETUP: IN_ZONE'), `F4 must render setup separately (got:\n${out4})`);
assert.ok(out4.includes('PLAN: WATCH'), `F4 must retain WATCH without proof (got:\n${out4})`);
assert.ok(out4.includes('GATE: WAITING'), `F4 must fail closed without proof (got:\n${out4})`);
assert.ok(out4.includes('BLOCKERS: NO_GATE_PROOF'), `F4 must name missing proof (got:\n${out4})`);
assert.ok(!out4.includes('PLAN: READY'), `F4 must never turn IN_ZONE into READY (got:\n${out4})`);

// Fixture 5: immutable READY plan and matching passed proof are distinct labels.
const readyWithProof = {
    ticker: 'HOSE:ACB', price: 25000, date: '2026-07-21', setup_state: 'IN_ZONE',
    fp: {}, wave: {}, trail: {}, ma: {}, mtf: {},
    readiness: {
        plan_status: 'READY', gate_state: 'PASSED', evidence_hash: 'proof-123',
        permission_state: 'ALLOWED', blockers: [],
    },
};
const out5 = fmtCheck('DATA_JSON:' + JSON.stringify(readyWithProof));
assert.ok(out5.includes('PLAN: READY'), `F5 must render READY plan (got:\n${out5})`);
assert.ok(out5.includes('GATE: PASSED'), `F5 must render PASSED proof (got:\n${out5})`);
assert.ok(out5.includes('PERMISSION: ALLOWED'), `F5 must render permission separately (got:\n${out5})`);
	assert.ok(out5.includes('ACTION: YES'), `F5 must render the derived actionable state (got:\n${out5})`);

// Fixture 6: deterministic proof blockers remain visible and cannot be bypassed by text.
const blockedProof = {
    ticker: 'HOSE:ACB', price: 25000, date: '2026-07-21', setup_state: 'IN_ZONE',
    fp: {}, wave: {}, trail: {}, ma: {}, mtf: {},
    readiness: {
        plan_status: 'WATCH', gate_state: 'BLOCKED', permission_state: 'UNKNOWN',
        blockers: ['LOW_TRUST_SESSION', 'TRIGGER_UNCONFIRMED'],
    },
};
const out6 = fmtCheck('DATA_JSON:' + JSON.stringify(blockedProof));
assert.ok(out6.includes('GATE: BLOCKED'), `F6 must render blocked gate (got:\n${out6})`);
assert.ok(out6.includes('BLOCKERS: LOW_TRUST_SESSION, TRIGGER_UNCONFIRMED'), `F6 must preserve blocker codes (got:\n${out6})`);
assert.ok(out6.includes('ACTION: NO'), `F6 must fail closed (got:\n${out6})`);

// Fixture 7: portfolio permission is an independent final gate.
const permissionBlocked = {
    ticker: 'HOSE:ACB', price: 25000, date: '2026-07-21', setup_state: 'IN_ZONE',
    fp: {}, wave: {}, trail: {}, ma: {}, mtf: {},
    readiness: {
        plan_status: 'READY', gate_state: 'PASSED', permission_state: 'BLOCKED', blockers: [],
    },
};
const out7 = fmtCheck('DATA_JSON:' + JSON.stringify(permissionBlocked));
assert.ok(out7.includes('PERMISSION: BLOCKED'), `F7 must render blocked portfolio permission (got:\n${out7})`);
assert.ok(out7.includes('ACTION: NO'), `F7 must keep passed proof non-actionable when permission blocks (got:\n${out7})`);

// Fixture 8: Telegram may supply stored plan validation without mutating engine output.
const out8 = fmtCheck('DATA_JSON:' + JSON.stringify(inZoneWithoutProof), {
    plan_status: 'READY', gate_state: 'PASSED', permission_state: 'REDUCED', blockers: [],
});
assert.ok(out8.includes('PLAN: READY'), `F8 must accept stored plan proof (got:\n${out8})`);
assert.ok(out8.includes('PERMISSION: REDUCED'), `F8 must render plan validation permission (got:\n${out8})`);
assert.ok(out8.includes('ACTION: YES'), `F8 must allow only passed proof plus explicit reduced permission (got:\n${out8})`);

// Fixture 9: data failure still renders the fail-closed contract supplied by Telegram.
const out9 = fmtCheck('LOI: engine unavailable', {
    plan_status: 'UNKNOWN', gate_state: 'BLOCKED', permission_state: 'BLOCKED',
    blockers: ['PLAN_LOOKUP_UNAVAILABLE'],
});
assert.ok(out9.includes('SETUP: UNKNOWN'), `F9 must label missing engine data (got:\n${out9})`);
assert.ok(out9.includes('GATE: BLOCKED'), `F9 must fail closed on missing engine data (got:\n${out9})`);
assert.ok(out9.includes('ACTION: NO'), `F9 must not become actionable (got:\n${out9})`);

// Fixture 10: malformed engine JSON must still retain the supplied blocked contract.
const out10 = fmtCheck('DATA_JSON:{not-json', {
    plan_status: 'UNKNOWN', gate_state: 'BLOCKED', permission_state: 'BLOCKED',
    blockers: ['ENGINE_DATA_MALFORMED'],
});
assert.ok(out10.includes('SETUP: UNKNOWN'), `F10 must label malformed engine data (got:\n${out10})`);
assert.ok(out10.includes('BLOCKERS: ENGINE_DATA_MALFORMED'), `F10 must preserve malformed-data blocker (got:\n${out10})`);

console.log('ALL PASS');
