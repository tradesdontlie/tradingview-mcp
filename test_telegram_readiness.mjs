import assert from 'node:assert';

process.env.TELEGRAM_BOT_TEST = '1';
const { currentReadiness, proofBlockers, runScript } = await import('./telegram-bot.js');

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
