import assert from 'node:assert/strict';
import { fmtCheck } from './fmt_check.mjs';

const legacy = {
  ticker: 'ICMARKETS:XAUUSD', price: 2350, date: '2026-07-29', structure: 'UPTREND',
  fp: { conf: 60, checks: {}, score: 50 }, wave: { phase: 'IMPULSE' },
  trail: {}, ma: {}, mtf: {}, tplus: null,
};
const legacyOut = fmtCheck(`DATA_JSON:${JSON.stringify(legacy)}`);
assert.ok(legacyOut.includes('ICMARKETS:XAUUSD'));
assert.ok(!legacyOut.includes('T+:'));
assert.equal(fmtCheck('LOI: khong co output'), 'LOI: khong co output');

const manualChecks = [
  { code: 'M15_CLOSED_NOT_BEARISH' },
  { code: 'H6_LIVE_NO_UPTHRUST' },
  { code: 'FOOTPRINT_NO_SELL_IMBALANCE' },
  { code: 'DELTA_NO_BEARISH_DIVERGENCE' },
  { code: 'PM_PROFILE_CONFIRMATION' },
];

function vnPayload(overrides = {}) {
  const payload = {
    ticker: 'HOSE:AAA', price: 103, date: '2026-07-29', as_of: '2026-07-29T06:00:00Z',
    vn: {
      setup: { setup: 'SMA20_PULLBACK', zone_low: 100, zone_high: 103, anchor: 'sma20' },
      setup_state: 'IN_ZONE',
      h6_history: {
        bars_completed: 120, sma20: 100, sma100: 90, structure: 'UPTREND', avg_vol_20: 5000,
        structure_v2: {
          version: 'vn-structure-v2-channel-20-3-005-2', trend_state: 'UP',
          range_state: 'SHIFTING', confirmed: true, upper: 112, upper_ref: 109,
          lower: 110, lower_ref: 107, as_of: '2026-07-29T06:00:00Z',
        },
      },
      h6_live: { vol_ratio: 1.2 },
      entry_window: { window: 'HIGH' },
      auto_core: { eligible: true, blockers: [] },
      plan_scenario: {
        trigger: 'AUTO_CORE_READY + CHECK_TAY_TRUOC_KHI_MUA',
        invalidation: 'dong cua duoi 95',
      },
      manual_checks: manualChecks,
      blockers: [],
    },
  };
  return { ...payload, ...overrides, vn: { ...payload.vn, ...(overrides.vn || {}) } };
}

function render(payload, readiness) {
  return fmtCheck(`DATA_JSON:${JSON.stringify(payload)}`, readiness);
}

function assertVnContract(output) {
  const lines = output.split('\n').filter(Boolean);
  assert.ok(lines.length <= 18, `VN output has ${lines.length} lines:\n${output}`);
  assert.deepEqual(
    lines.filter(line => ['QUYET DINH', 'HANH DONG', 'DIEU KIEN VO HIEU', 'BANG CHUNG'].includes(line)),
    ['QUYET DINH', 'HANH DONG', 'DIEU KIEN VO HIEU', 'BANG CHUNG'],
  );
  assert.equal(lines.filter(line => line.startsWith('[ ] ')).length, 5);
  assert.ok(lines.some(line => line.startsWith('THIEU DE CO SETUP:')));
  assert.ok(lines.some(line => line.startsWith('THIEU DE XEM XET MUA:')));
  assert.ok(!output.includes('ACTION: YES'));
}

const noSetupPayload = vnPayload({ vn: {
  setup: { setup: null, zone_low: null, zone_high: null, anchor: null },
  setup_state: 'NO_SETUP', blockers: ['NO_SETUP'],
} });
const noSetup = render(noSetupPayload);
assertVnContract(noSetup);
assert.match(noSetup, /SETUP: NONE/);
assert.match(noSetup, /ACTION: CHO DOI/);

const watch = render(vnPayload());
assertVnContract(watch);
assert.match(watch, /PLAN: WATCH \| GATE: WAITING/);
assert.match(watch, /ACTION: CHO DOI/);

const readyAllowed = render(vnPayload(), {
  setup_state: 'IN_ZONE', plan_status: 'READY', gate_state: 'PASSED',
  permission_state: 'ALLOWED', blockers: [],
});
assertVnContract(readyAllowed);
assert.match(readyAllowed, /ACTION: CHECK TAY TRUOC KHI MUA/);

const readyReduced = render(vnPayload(), {
  setup_state: 'IN_ZONE', plan_status: 'READY', gate_state: 'PASSED',
  permission_state: 'REDUCED', blockers: [],
});
assertVnContract(readyReduced);
assert.match(readyReduced, /PERMISSION: REDUCED/);
assert.match(readyReduced, /ACTION: CHECK TAY TRUOC KHI MUA/);

const permissionBlocked = render(vnPayload(), {
  setup_state: 'IN_ZONE', plan_status: 'READY', gate_state: 'PASSED',
  permission_state: 'BLOCKED', blockers: [],
});
assertVnContract(permissionBlocked);
assert.match(permissionBlocked, /ACTION: KHONG MUA/);

const malformed = vnPayload();
delete malformed.vn.h6_history.structure_v2;
const malformedOut = render(malformed);
assertVnContract(malformedOut);
assert.match(malformedOut, /STRUCTURE: UNKNOWN\/UNKNOWN - PROVISIONAL/);
assert.match(malformedOut, /ACTION: KHONG MUA/);

const provisional = vnPayload();
provisional.vn.h6_history.structure_v2.confirmed = false;
const provisionalOut = render(provisional);
assertVnContract(provisionalOut);
assert.match(provisionalOut, /STRUCTURE: UP\/SHIFTING - PROVISIONAL/);
assert.match(provisionalOut, /STRUCTURE_NOT_CONFIRMED/);
assert.match(provisionalOut, /ACTION: CHO DOI/);

const stale = render(vnPayload(), {
  setup_state: 'IN_ZONE', plan_status: 'WATCH', gate_state: 'BLOCKED',
  permission_state: 'UNKNOWN', blockers: ['CACHE_STALE'],
});
assertVnContract(stale);
assert.match(stale, /CACHE_STALE/);
assert.match(stale, /ACTION: CHO DOI/);

const hcm = vnPayload({
  ticker: 'HOSE:HCM', price: 25300,
  vn: {
    setup: { setup: null, zone_low: null, zone_high: null, anchor: null },
    setup_state: 'NO_SETUP',
    h6_history: {
      bars_completed: 120, sma20: 24608, sma100: 22738, structure: 'MIXED', avg_vol_20: 6790000,
      structure_v2: {
        version: 'vn-structure-v2-channel-20-3-005-2', trend_state: 'MIXED',
        range_state: 'EXPANDING', confirmed: true, upper: 26000, upper_ref: 25000,
        lower: 22000, lower_ref: 23000, as_of: '2026-07-29T06:00:00Z',
      },
    },
    h6_live: { vol_ratio: 0.79 }, entry_window: { window: 'HIGH' },
    auto_core: { eligible: false, blockers: ['NO_SETUP', 'H6_VOLUME_NOT_ABOVE_AVG20'] },
    manual_checks: manualChecks, blockers: ['NO_SETUP', 'H6_VOLUME_NOT_ABOVE_AVG20'],
  },
});
const hcmOut = render(hcm);
assertVnContract(hcmOut);
assert.match(hcmOut, /STRUCTURE: MIXED\/EXPANDING - CONFIRMED/);
assert.ok(!hcmOut.includes('OVEREXTENDED'));

const deep = fmtCheck(`--deep DATA_JSON:${JSON.stringify(vnPayload())}`);
assertVnContract(deep);

console.log('ALL PASS');
