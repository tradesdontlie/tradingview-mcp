/**
 * emit_vn_core_fixture.mjs — Generate deterministic VN core READY fixture
 * Run: node tests/emit_vn_core_fixture.mjs
 */
import fs from 'fs';
import path from 'path';
import { buildCacheEnvelope, buildVnAutoCore, classifyVnSetup, buildVnPlanScenario, buildVnGateView } from '../check_one.mjs';

const FIXED_DATE = '2026-07-28T10:00:00.000Z';

// Input parameters (from plan)
// HOSE:AAA, timeframe 360, open H6, 120 completed bars,
// SMA20=100, SMA100=90, structure=UPTREND,
// price=101 (inside SMA20 zone [99,101]), vol_ratio=1.01, window=HIGH,
// setup=SMA20_PULLBACK, setup_state=IN_ZONE

const ticker = 'HOSE:AAA';
const timeframe = '360';
const bar = { closed: false, age_pct: 60 };
const price = 101;

// --- H6 history (120 completed bars, all within SMA zone) ---
const h6History = {
  bars_completed: 120,
  sma20: 100,
  sma100: 90,
  structure: 'UPTREND',
  protected_low: 85,
  avg_vol_20: 5000,
};

// Setup classification
const setup = classifyVnSetup({
  price,
  sma20: h6History.sma20,
  sma100: h6History.sma100,
  structure: h6History.structure,
  aboveSma100: true,
});

// H6 live
const h6Live = {
  price,
  vol_ratio: 1.01,
  location_vs_sma20: Math.round((price - h6History.sma20) / h6History.sma20 * 10000) / 100,
  location_vs_sma100: Math.round((price - h6History.sma100) / h6History.sma100 * 10000) / 100,
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

// Entry window
const entryWindow = { window: 'HIGH', priority: true, reason: 'window open' };

// Auto core
const autoCore = buildVnAutoCore({
  price,
  h6History,
  h6Live,
  entryWindow,
  setup,
});

// Setup state
const setupState = setup.setup != null && autoCore.blockers.length === 0 ? 'IN_ZONE' : 'NO_SETUP';

// Plan scenario
const planScenario = buildVnPlanScenario({
  setup: setup.setup ? setup : null,
  protectedLow: h6History.protected_low,
  overheadResistance: 115,
  trail: { status: 'SAFE' },
});

// Gate view
const vnGateView = buildVnGateView({
  bar,
  vn: { setup_state: setupState, h6_history: h6History },
  planScenario,
});

// Build the full envelope
const envelope = buildCacheEnvelope({
  ticker,
  price,
  timeframe,
  tf_confirmed: true,
  symbol_confirmed: true,
  dir: 'LONG',
  date: '2026-07-28',
  bar: vnGateView.bar,
  setup_state: vnGateView.setup_state,
  scenarios: vnGateView.scenarios,
  setup,
  vn: {
    setup,
    setup_state: setupState,
    h6_history: h6History,
    h6_live: h6Live,
    entry_window: entryWindow,
    auto_core: autoCore,
    plan_scenario: planScenario,
  },
}, FIXED_DATE);

// Write deterministic output
const __dirname = new URL('.', import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1');
const outPath = path.join(__dirname, 'fixtures', 'vn_core_ready.json');
fs.writeFileSync(outPath, JSON.stringify(envelope, null, 2) + '\n');
console.log('Wrote fixture to', outPath);
console.log('Fixture fields:', Object.keys(envelope).join(', '));
console.log('vn.setup.setup:', envelope.vn?.setup?.setup);
console.log('vn.setup_state:', envelope.vn?.setup_state);
console.log('scenarios:', JSON.stringify(envelope.scenarios));
console.log('bar:', JSON.stringify(envelope.bar));
console.log('setup_state:', envelope.setup_state);
