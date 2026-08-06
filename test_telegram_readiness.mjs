import assert from 'node:assert';

process.env.TELEGRAM_BOT_TEST = '1';
const { currentReadiness, formatCanonicalScan, proofBlockers, runCanonicalScan, runScript } = await import('./telegram-bot.js');

const enginePayload = 'DATA_JSON:{"price":25000,"setup_state":"IN_ZONE"}';
const readyPlan = {
    status: 'READY', gate_state: 'PASSED', version: 7,
    gate_result: { state: 'PASSED', blockers: ['LOW_TRUST_SESSION'] },
};

const failedEngine = await runScript('check_one.mjs', ['HOSE:ACB'], (_bin, _args, _options, done) => {
    done(new Error('engine exit 2'), enginePayload, 'refresh failed');
});
assert.ok(failedEngine.startsWith('LOI:'), `nonzero engine must fail closed (got ${failedEngine})`);
assert.ok(!failedEngine.includes('DATA_JSON:'), `nonzero engine must not expose usable payload (got ${failedEngine})`);

const directionalRow = {
    ticker: 'ACB', signal: 'WATCH', engine_version: 'h6-footprint-v3', missing_fields: [],
    score_pct: 71, conf: 80, cum_delta: 10, buy_pct: 60, div_signal: 0, max_buy_stack: 1,
    price: 25000, sma20: 24000, sma100: 22000, above_ma20: true, ma20_slope_ok: true,
    market_regime: 'NEUTRAL', market_adj: -5, rank_score: 66, signal_quality: 'CONFIRMED',
    bar_closed: true, bar_age_pct: 100, session_phase: 'CONT_AM', session_trust: 'HIGH',
    phase: 'SIDEWAYS', churn: false, vol_ratio: null, decision_reasons: ['base_score:5/7'],
};
const scanPayload = { engine_version: 'h6-footprint-v3', date: '20260722', scan_time: '10:00',
    results: [directionalRow] };
const scanOk = await runCanonicalScan((_bin, args, _options, done) => {
    assert.deepEqual(args.slice(-1), ['scan-discover']);
    done(null, 'pipeline stdout', 'pipeline warning');
}, () => JSON.stringify(scanPayload));
assert.equal(scanOk.ok, true);
assert.match(scanOk.rendered, /ACB/);
assert.ok(!scanOk.rendered.includes('pipeline stdout'), 'success must render only canonical artifact');

const scanFailed = await runCanonicalScan((_bin, _args, _options, done) => {
    const error = new Error('exit 7'); error.code = 7;
    done(error, 'partial stdout', 'fatal stderr');
}, () => { throw new Error('must not read stale artifact'); });
assert.deepEqual(scanFailed, { ok: false, exit: 7, stdout: 'partial stdout', stderr: 'fatal stderr' });
assert.throws(() => formatCanonicalScan({ engine_version: 'old', results: [] }), /invalid/);
const incompleteScan = { ...scanPayload, results: [{ ...scanPayload.results[0], missing_fields: ['cum_delta'] }] };
assert.throws(() => formatCanonicalScan(incompleteScan), /incomplete/);
for (const malformed of [
    { score_pct: null }, { decision_reasons: [] }, { market_regime: 'UNKNOWN' },
    { bar_closed: false }, { signal_quality: 'PROVISIONAL', bar_closed: true },
]) {
    assert.throws(() => formatCanonicalScan({ ...scanPayload,
        results: [{ ...directionalRow, ...malformed }] }), /incomplete/);
}

assert.deepEqual(proofBlockers(readyPlan), ['LOW_TRUST_SESSION'], 'must use plan-latest gate_result blockers');

let calls = 0;
const allowed = await currentReadiness('ACB', enginePayload, async () => {
    calls += 1;
    return calls === 1 ? { ok: true, value: readyPlan } : { ok: true, value: { gate: 'ALLOWED' } };
});
assert.equal(allowed.gate_state, 'PASSED');
assert.equal(allowed.permission_state, 'ALLOWED');
assert.deepEqual(allowed.blockers, ['LOW_TRUST_SESSION']);

calls = 0;
const permissionBlocked = await currentReadiness('ACB', enginePayload, async () => {
    calls += 1;
    return calls === 1 ? { ok: true, value: readyPlan } : { ok: true, value: { gate: 'BLOCKED', reasons: ['PORTFOLIO_HEAT'] } };
});
assert.equal(permissionBlocked.gate_state, 'PASSED');
assert.equal(permissionBlocked.permission_state, 'BLOCKED');
assert.ok(permissionBlocked.blockers.includes('PORTFOLIO_HEAT'));

const missingProof = await currentReadiness('ACB', enginePayload, async () => ({
    ok: true, value: { ...readyPlan, gate_result: null },
}));
assert.equal(missingProof.gate_state, 'BLOCKED');
assert.ok(missingProof.blockers.includes('MISSING_GATE_PROOF'));

for (const label of ['stale', 'forged']) {
    calls = 0;
    const invalidProof = await currentReadiness('ACB', enginePayload, async () => {
        calls += 1;
        return calls === 1 ? { ok: true, value: readyPlan } : { ok: false, error: `${label} proof` };
    });
    assert.equal(invalidProof.gate_state, 'BLOCKED', `${label} proof must block`);
    assert.equal(invalidProof.permission_state, 'BLOCKED', `${label} proof must block permission`);
    assert.ok(invalidProof.blockers.includes('READY_PROOF_INVALID'), `${label} proof must retain stable blocker`);
}

console.log('ALL PASS');
