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

console.log('ALL PASS');
