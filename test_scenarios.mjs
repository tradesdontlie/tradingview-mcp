// Self-check buildScenarios. Run: node test_scenarios.mjs  (expect ALL PASS)
import assert from 'node:assert';
import { buildScenarios, contRetestScenario, findDemandBar } from './check_one.mjs';

const long = (lo, hi, sl, t1) => sl < lo && lo <= hi && hi < t1;

// IMPULSE -> retest nhanh ve ph1, levels hop le
let s = buildScenarios('UPTREND',
  { phase: 'IMPULSE', ph1: 21927, pl1: 19342, tp: { tp1272: 22685, tp1618: 23594 } },
  { resistance: null }, 'LONG');
assert.equal(s.length, 1, 'impulse phai cho 1 nhanh');
assert.equal(s[0].label, 'retest');
assert.ok(long(s[0].entry_low, s[0].entry_high, s[0].sl, s[0].tp1), 'retest SL<entry<TP1');

// IMPULSE + shelf gan (shelf < entry) -> SL dung shelf chat thay vi pivot low xa (RR thuc)
let si = buildScenarios('UPTREND',
  { phase: 'IMPULSE', ph1: 16400, pl1: 15519, tp: { tp1272: 17140, tp1618: 17573 } },
  { resistance: 16650 }, 'LONG', 16000);
assert.equal(si[0].label, 'retest');
assert.ok(si[0].sl > 15519 && si[0].sl <= 16000, 'IMPULSE SL dung shelf (chat hon pivot low)');
assert.ok(long(si[0].entry_low, si[0].entry_high, si[0].sl, si[0].tp1), 'IMPULSE+shelf SL<entry<TP1');
// IMPULSE khong co shelf -> van fallback pivot low (backward compat)
si = buildScenarios('UPTREND',
  { phase: 'IMPULSE', ph1: 21927, pl1: 19342, tp: { tp1272: 22685, tp1618: 23594 } },
  { resistance: null }, 'LONG');
assert.equal(Math.round(si[0].sl), Math.round(19342 * 0.998), 'khong shelf -> SL = pivot low');

// PULLBACK + overhead gan (<=5%) -> breakout, levels hop le
s = buildScenarios('UPTREND',
  { phase: 'PULLBACK', tp: { tp1272: 22685, tp1618: 23594 } },
  { resistance: 21000, headroom_pct: 3 }, 'LONG');
assert.equal(s[0].label, 'breakout');
assert.ok(long(s[0].entry_low, s[0].entry_high, s[0].sl, s[0].tp1), 'breakout SL<entry<TP1');

// overhead qua xa (>5%) -> khong co nhanh breakout
assert.equal(buildScenarios('UPTREND',
  { phase: 'PULLBACK', tp: { tp1272: 22685 } },
  { resistance: 21000, headroom_pct: 9 }, 'LONG').length, 0, 'overhead xa -> rong');

// DOWNTREND / SHORT / NEUTRAL -> rong
assert.equal(buildScenarios('DOWNTREND', {}, {}, 'LONG').length, 0);
assert.equal(buildScenarios('UPTREND', { phase: 'IMPULSE', ph1: 100, tp: { tp1272: 120 } }, {}, 'SHORT').length, 0);

// geometry xau (tp1 <= entry) -> bo nhanh, khong sinh scenario invalid
assert.equal(buildScenarios('UPTREND',
  { phase: 'IMPULSE', ph1: 21927, pl1: 19342, tp: { tp1272: 21000 } },
  {}, 'LONG').length, 0, 'tp1 duoi entry -> bo');

// --- contRetestScenario (shelf-based: POW shelf ~14000, demand close 14500) ---
// gia 14250 > shelf 14000 (chua dong duoi shelf), D-0 can cung 0.39x -> co retest, entry [14000, min(14500,14250)]
let cr = contRetestScenario({ shelf: 14000, zoneHi: 14500,
  price: 14250, d0vol: 0.39, resistance: 14800, atr14: 343, dir: 'LONG' });
assert.ok(cr && cr.label === 'retest', 'gia tren shelf phai sinh retest');
assert.ok(long(cr.entry_low, cr.entry_high, cr.sl, cr.tp1), 'cont retest SL<entry<TP1');
assert.ok(cr.entry_high <= 14250, 'entry_high khong tren gia hien tai');
// gia 13950 DONG DUOI shelf 14000 = mat shelf -> null
assert.equal(contRetestScenario({ shelf: 14000, zoneHi: 14500,
  price: 13950, d0vol: 0.39, resistance: 14800, atr14: 343, dir: 'LONG' }), null, 'mat shelf -> null');
// khang cu sat gia -> TP1 fallback price+2ATR, khong RR ao
let cr2 = contRetestScenario({ shelf: 14000, zoneHi: 14500,
  price: 14250, d0vol: 0.39, resistance: 14300, atr14: 343, dir: 'LONG' });
assert.ok(cr2 && cr2.tp1 > 14250 * 1.01, 'TP1 khong duoc sat gia (RR ao)');
// D-0 chua can cung (vol >=1x) -> null
assert.equal(contRetestScenario({ shelf: 14000, zoneHi: 14500,
  price: 14250, d0vol: 1.2, resistance: 14800, atr14: 343, dir: 'LONG' }), null, 'D-0 chua can cung -> null');
// retest qua xa (price - zoneHi > 2*ATR) -> null
assert.equal(contRetestScenario({ shelf: 14000, zoneHi: 14500,
  price: 15300, d0vol: 0.39, resistance: 15800, atr14: 343, dir: 'LONG' }), null, 'retest qua xa -> null');
// SHORT -> null
assert.equal(contRetestScenario({ shelf: 14000, zoneHi: 14500,
  price: 14250, d0vol: 0.39, resistance: 14800, atr14: 343, dir: 'SHORT' }), null, 'SHORT -> null');

// --- findDemandBar: quet D-1..D-5, shelf = muc 25% range nen manh, chua dong duoi shelf ---
const B = (o, h, l, c, v) => ({ open: o, high: h, low: l, close: c, volume: v });
const AV = 1_000_000;
// idx2 demand low 14.0 high 15.0 close 14.8 (close_pos 0.8) -> shelf = 14.0 + 0.25*1.0 = 14.25
let bars = [B(13,14,13,13.5,1e6), B(13.5,14.1,13.4,14.0,1e6), B(14.1,15.0,14.0,14.8,2e6), B(14.8,14.9,14.5,14.6,0.4e6)];
let db = findDemandBar(bars, bars.length, AV);
assert.ok(db && db.off === 1 && db.shelf === 14.25 && db.zoneHi === 14.8, 'demand D-1 shelf=25% range');
// close_pos thap (0.5 <0.65) -> khong phai nen cau manh -> null
let nb = [B(13,14,13,13.5,1e6), B(13.5,14.1,13.4,14.0,1e6), B(14.1,15.0,14.0,14.5,2e6), B(14.5,14.6,14.3,14.4,0.4e6)];
assert.equal(findDemandBar(nb, nb.length, AV), null, 'close_pos <65% -> null');
// nen manh o D-5 (off=5, idx1 voi len=7); low 9.9 high 12 -> shelf = 9.9 + 0.25*2.1 = 10.425
bars = [B(9.8,10,9.7,9.9,1e6),
        B(9.9,12,9.9,11.8,3e6),               // idx1: demand off=5, close_pos 0.905
        B(11.8,12,11.5,11.9,1e6), B(11.9,12,11.6,11.7,1e6), B(11.7,12,11.5,11.8,1e6), B(11.8,12,11.6,11.9,1e6),
        B(11.9,12,11.7,11.9,0.4e6)];          // idx6 D-0 forming
db = findDemandBar(bars, bars.length, AV);
assert.ok(db && db.off === 5 && Math.abs(db.shelf - 10.425) < 1e-6, 'tim demand bar lui ve D-5, shelf 25%');
// mot nen sau dong DUOI shelf (10.425) -> mat da -> null
bars[3] = B(11.9,12,9.5,10.0,1e6);  // close 10.0 < 10.425
assert.equal(findDemandBar(bars, bars.length, AV), null, 'dong duoi muc 25% -> null');

console.log('ALL PASS');
