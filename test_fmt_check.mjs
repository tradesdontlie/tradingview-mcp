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

// ===== VN readiness tests =====

// VN engine payload with no override → must NOT render READY
const vnPayload = {
    ticker: 'HOSE:ACB', price: 25000, date: '2026-07-21',
    vn: {
        h6_history: { sma20: 24000, sma100: 23000, structure: 'UPTREND', protected_low: 24500, avg_vol_20: 1000000, bars_completed: 80 },
        h6_live: { price: 25000, location_vs_sma20: 4.17, location_vs_sma100: 8.7, vol_ratio: 1.2, buy_pct: 60, bar_vol_delta: 5000, cum_delta: 20000, delta_pct: 8.5, buy_stack: 3, sell_stack: 1, divergence: 0 },
        ma_anchor: { allowed: true, anchor: 'sma20', extension_pct: 4.17, blocker: null },
        setup: { setup: 'SMA20_PULLBACK', zone_low: 23700, zone_high: 24300, anchor: 'sma20' },
        pm_profile: { poc: 24000, vah: 24800, val: 23500, profile_month: '2026-06' },
        locked_ltf: { locked: false, reason: 'missing_data' },
        entry_window: { window: 'HIGH', priority: false },
        exit_policy: { sl: 24500, trail: 'SAFE' },
        blockers: ['LTF_STABILITY_INSUFFICIENT'],
        setup_state: 'IN_ZONE',
        window_ok: true,
    },
};
const raw = 'DATA_JSON:' + JSON.stringify(vnPayload);

// VN-1: no override → PLAN: WATCH, GATE: WAITING
const outVn1 = fmtCheck(raw);
assert.ok(outVn1.includes('PLAN: WATCH'), `VN-1 must show WATCH without override (got:\n${outVn1})`);
assert.ok(outVn1.includes('GATE: WAITING'), `VN-1 must show WAITING without override (got:\n${outVn1})`);
assert.ok(outVn1.includes('ACTION:'), `VN-1 must have ACTION line (got:\n${outVn1})`);
assert.ok(!outVn1.includes('PLAN: READY'), `VN-1 must NOT render READY without override (got:\n${outVn1})`);

// VN-2: READY override → PLAN: READY, GATE: PASSED, ACTION: YES
const outVn2 = fmtCheck(raw, {
    setup_state: 'IN_ZONE', plan_status: 'READY', gate_state: 'PASSED',
    permission_state: 'ALLOWED', blockers: [],
});
assert.ok(outVn2.includes('PLAN: READY'), `VN-2 must show READY (got:\n${outVn2})`);
assert.ok(outVn2.includes('GATE: PASSED'), `VN-2 must show PASSED (got:\n${outVn2})`);

// VN-3: BLOCKED override → PLAN: BLOCKED, GATE: BLOCKED, ACTION: NO
const outVn3 = fmtCheck(raw, {
    setup_state: 'IN_ZONE', plan_status: 'BLOCKED', gate_state: 'BLOCKED',
    permission_state: 'BLOCKED', blockers: ['BELOW_SMA100'],
});
assert.ok(outVn3.includes('PLAN: BLOCKED'), `VN-3 must show BLOCKED (got:\n${outVn3})`);
assert.ok(outVn3.includes('GATE: BLOCKED'), `VN-3 must show BLOCKED gate (got:\n${outVn3})`);
	assert.ok(outVn3.includes('BELOW_SMA100'), `VN-3 must show blockers (got:\n${outVn3})`);

// VN-4: READY override but different setup_state → not actionable
const outVn4 = fmtCheck(raw, {
    setup_state: 'NO_SETUP', plan_status: 'READY', gate_state: 'PASSED',
    permission_state: 'ALLOWED', blockers: [],
});
assert.ok(!outVn4.includes('PLAN: READY'), `VN-4 must not render READY without IN_ZONE setup (got:\n${outVn4})`);

// VN-5: Default and deep output keep Buy%, Delta, Delta%, stacks, divergence, H6 vol/Avg20, LTF safety
assert.ok(outVn1.includes('Buy 60%'), `VN must show Buy% (got:\n${outVn1})`);
assert.ok(outVn1.includes('Delta%'), `VN must show Delta% (got:\n${outVn1})`);
assert.ok(outVn1.includes('Div 0'), `VN must show divergence (got:\n${outVn1})`);
assert.ok(outVn1.includes('B3/S1'), `VN must show stacks (got:\n${outVn1})`);
assert.ok(outVn1.includes('LTF'), `VN must show LTF safety (got:\n${outVn1})`);

	// VN-6: deep output includes MA gate diagnostics
	const outVnDeep = fmtCheck('--deep DATA_JSON:' + JSON.stringify(vnPayload));
	assert.ok(outVnDeep.includes('MA GATE'), `VN deep must show MA gate (got:\n${outVnDeep})`);

	// ===== VN manual checklist tests =====

	// VN-M1: engine + gate blockers are deduplicated
	const vnM1Payload = {
	    ticker: 'HOSE:ACB', price: 25000, date: '2026-07-21',
	    vn: {
	        h6_history: { sma20: 24000, sma100: 23000, structure: 'UPTREND', avg_vol_20: 1000000, bars_completed: 80 },
	        h6_live: { vol_ratio: 1.2, buy_pct: 60, bar_vol_delta: 5000, cum_delta: 20000, delta_pct: 8.5, buy_stack: 3, sell_stack: 1, divergence: 0, vsa_churn: false, footprint_conf: 72 },
	        ma_anchor: { allowed: true, anchor: 'sma20', extension_pct: 4.17, blocker: null },
	        setup: { setup: 'SMA20_PULLBACK', zone_low: 23700, zone_high: 24300, anchor: 'sma20' },
	        pm_profile: { poc: 24000, vah: 24800, val: 23500, profile_month: '2026-06' },
	        locked_ltf: { mode: 'MANUAL', timeframe: '15', locked: null, reason: 'manual_confirmation_required' },
	        entry_window: { window: 'HIGH' },
	        exit_policy: { sl: 24500, trail: 'SAFE' },
	        auto_core: { eligible: true, conditions: {}, blockers: [] },
	        manual_checks: [
	            { code: 'M15_CLOSED_NOT_BEARISH', label_vi: 'M15 gan nhat da dong va khong bearish' },
	            { code: 'H6_LIVE_NO_UPTHRUST', label_vi: 'H6 live khong co Upthrust/Distribution/Effort-No-Result' },
	            { code: 'FOOTPRINT_NO_SELL_IMBALANCE', label_vi: 'Footprint khong co sell imbalance/aggressive sell' },
	            { code: 'DELTA_NO_BEARISH_DIVERGENCE', label_vi: 'Volume Delta khong bearish divergence' },
	            { code: 'PM_PROFILE_CONFIRMATION', label_vi: 'Doi chieu PM POC/VAH/VAL' },
	        ],
	        blockers: ['ENGINE_BLOCKER'],
	        setup_state: 'IN_ZONE', window_ok: true,
	    },
	};
	const rawM1 = 'DATA_JSON:' + JSON.stringify(vnM1Payload);

	// VN-M1a: with override that also has blockers → union
	const outM1a = fmtCheck(rawM1, {
	    setup_state: 'IN_ZONE', plan_status: 'READY', gate_state: 'PASSED',
	    permission_state: 'ALLOWED', blockers: ['GATE_BLOCKER'],
	});
	assert.match(outM1a, /BLOCKERS: ENGINE_BLOCKER, GATE_BLOCKER/,
	    `VN-M1a must show deduplicated blockers (got:\n${outM1a})`);
	assert.match(outM1a, /CHECK TAY TRUOC KHI MUA:/,
	    `VN-M1a must show manual checklist header (got:\n${outM1a})`);

	// VN-M1b: all five manual checks rendered
	assert.match(outM1a, /M15 gan nhat da dong va khong bearish/,
	    `VN-M1b must show M15 check (got:\n${outM1a})`);
	assert.match(outM1a, /H6 live khong co Upthrust\/Distribution\/Effort-No-Result/,
	    `VN-M1b must show H6 VSA check (got:\n${outM1a})`);
	assert.match(outM1a, /Footprint khong co sell imbalance\/aggressive sell/,
	    `VN-M1b must show Footprint check (got:\n${outM1a})`);
	assert.match(outM1a, /Volume Delta khong bearish divergence/,
	    `VN-M1b must show Delta check (got:\n${outM1a})`);
	assert.match(outM1a, /Doi chieu PM POC\/VAH\/VAL/,
	    `VN-M1b must show PM Profile check (got:\n${outM1a})`);

	// VN-M2: valid READY proof → PLAN: READY, ACTION: CHECK TAY TRUOC KHI MUA, never ACTION: YES
	assert.match(outM1a, /^PLAN: READY$/m,
	    `VN-M2 must show READY plan (got:\n${outM1a})`);
	assert.match(outM1a, /^ACTION: CHECK TAY TRUOC KHI MUA$/m,
	    `VN-M2 must show manual ACTION (got:\n${outM1a})`);
	assert.doesNotMatch(outM1a, /^ACTION: YES$/m,
	    `VN-M2 must never render ACTION: YES (got:\n${outM1a})`);

	// VN-M3: no override → maximum WATCH, no READY
	const outM3 = fmtCheck(rawM1);
	assert.match(outM3, /^PLAN: WATCH$/m,
	    `VN-M3 must show WATCH without override (got:\n${outM3})`);
	assert.match(outM3, /^ACTION: /m,
	    `VN-M3 must have ACTION line (got:\n${outM3})`);
	assert.doesNotMatch(outM3, /^PLAN: READY$/m,
	    `VN-M3 must NOT render READY without override (got:\n${outM3})`);

	// VN-M4: malformed READY must include INVALID_READY_STATE
	const outM4 = fmtCheck(rawM1, {
	    setup_state: 'NO_SETUP', plan_status: 'READY', gate_state: 'PASSED',
	    permission_state: 'ALLOWED', blockers: [],
	});
	assert.match(outM4, /INVALID_READY_STATE/,
	    `VN-M4 must show INVALID_READY_STATE (got:\n${outM4})`);

	console.log('ALL PASS');
