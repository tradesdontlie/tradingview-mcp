/** Generate the deterministic full VN core READY producer payload. */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildCacheEnvelope, buildVnCoreAssembly } from '../check_one.mjs';

const FIXED_DATE = '2026-07-28T09:55:00.000Z';

export function buildVnCoreFixture() {
  const price = 103;
  const bar = { closed: false, age_pct: 60 };
  const h6History = {
    bars_completed: 120,
    sma20: 100,
    sma100: 90,
    structure: 'UPTREND',
    structure_v2: {
      version: 'vn-structure-v2-channel-20-3-005-2',
      trend_state: 'UP',
      range_state: 'SHIFTING',
      confirmed: true,
      upper: 112,
      upper_ref: 109,
      lower: 110,
      lower_ref: 107,
      as_of: '2026-07-28T09:55:00.000Z',
    },
    protected_low: 85,
    avg_vol_20: 5000,
  };
  const h6Live = {
    price,
    vol_ratio: 1.01,
    location_vs_sma20: 3,
    location_vs_sma100: 14.44,
    range: 3,
    range_atr: 1.2,
    vol_above_avg20: true,
    buy_pct: 55,
    bar_vol_delta: 1000,
    cum_delta: 500,
    delta_pct: 2.5,
    buy_stack: 2,
    sell_stack: 0,
    divergence: 0,
    vsa_churn: false,
    vsa_signals: { no_demand: false, no_supply: false },
    footprint_conf: 65,
  };
  const entryWindow = { window: 'HIGH', priority: true, reason: 'window open' };
  const assembly = buildVnCoreAssembly({
    price, h6History, h6Live, entryWindow, bar,
    overheadResistance: 115,
    trail: { status: 'SAFE' },
  });
  const vn = {
    setup: assembly.setup,
    setup_state: assembly.setupState,
    h6_history: h6History,
    h6_live: h6Live,
    entry_window: entryWindow,
    auto_core: assembly.autoCore,
    plan_scenario: assembly.planScenario,
    manual_checks: [
      { code: 'M15_CLOSED_NOT_BEARISH', label_vi: 'M15 gan nhat da dong va khong bearish' },
      { code: 'H6_LIVE_NO_UPTHRUST', label_vi: 'H6 live khong co Upthrust/Distribution/Effort-No-Result' },
      { code: 'FOOTPRINT_NO_SELL_IMBALANCE', label_vi: 'Footprint khong co sell imbalance/aggressive sell' },
      { code: 'DELTA_NO_BEARISH_DIVERGENCE', label_vi: 'Volume Delta khong bearish divergence' },
      { code: 'PM_PROFILE_CONFIRMATION', label_vi: 'Doi chieu PM POC/VAH/VAL' },
    ],
  };
  return buildCacheEnvelope({
    ticker: 'HOSE:AAA',
    price,
    timeframe: '360',
    tf_confirmed: true,
    symbol_confirmed: true,
    dir: 'LONG',
    date: '2026-07-28',
    bar: assembly.gateView.bar,
    session: { trust_level: 'HIGH', phase: 'CONTINUOUS', age_pct: 60, warnings: [] },
    htf: { trend: 'UP' },
    structure: 'UPTREND',
    setup_state: assembly.gateView.setup_state,
    scenarios: assembly.gateView.scenarios,
    price_limit: { ceiling_risk: false, floor_risk: false },
    adtv_20_bn: 30,
    spread: { atr14: 5 },
    events: { ex_upcoming: false },
    vsa_churn: { flag: false },
    phase_evidence: { retest: { supply_dry: true, micro_confirm: false } },
    vn,
  }, FIXED_DATE);
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(modulePath)) {
  const outPath = path.join(path.dirname(modulePath), 'fixtures', 'vn_core_ready.json');
  fs.writeFileSync(outPath, `${JSON.stringify(buildVnCoreFixture(), null, 2)}\n`);
  console.log(`Wrote fixture to ${outPath}`);
}
