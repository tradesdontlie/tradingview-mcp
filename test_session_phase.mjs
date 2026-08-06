// Session Phase, Entry Window, and Locked LTF tests
// Run: node test_session_phase.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { barStatus, entryWindow, lockedLtf, sessionInfo } from './bar_status.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const BAR_STATUS_URL = pathToFileURL(path.join(TEST_DIR, 'bar_status.mjs')).href;

// Deterministic reference clock
const NOW = new Date('2026-07-09T10:30:00.000Z'); // Thursday
const NOW_MS = NOW.getTime();

// VN time = UTC+7
function vnUtc(vnHour, vnMin) {
  return new Date(Date.UTC(2026, 6, 9, vnHour - 7, vnMin));
}

// Build a bar with per-bar footprint
function ltfBar(close, open, opts = {}) {
  const ageMin = opts.ageMin ?? 10;
  const closedAt = new Date(NOW_MS - ageMin * 60000).toISOString();
  return {
    symbol: opts.symbol || 'HOSE:TEST',
    timeframe: opts.timeframe || '15',
    bar_closed: opts.bar_closed ?? true,
    closed_at: opts.closed_at ?? closedAt,
    open,
    high: opts.high ?? (close > open ? close + 1 : open + 1),
    low: opts.low ?? (close < open ? close - 1 : open - 1),
    close,
    volume: opts.volume ?? 100000,
    footprint: {
      bar_delta: opts.delta ?? 500,
      buy_pct: opts.buyPct ?? 55,
      buy_stack: opts.buyStack ?? 2,
      sell_stack: opts.sellStack ?? 1,
      bearish_divergence: opts.bearishDivergence ?? false,
      aggressive_sell: opts.aggressiveSell ?? false,
      bearish_vsa: opts.bearishVsa ?? false,
    },
  };
}

// ==================== entryWindow ====================

assert.equal(entryWindow(vnUtc(9, 45)).window, 'HIGH', 'VN 09:45 = HIGH');
assert.equal(entryWindow(vnUtc(10, 0)).window, 'HIGH', 'VN 10:00 = HIGH');
assert.equal(entryWindow(vnUtc(10, 29)).window, 'HIGH', 'VN 10:29 = HIGH');
assert.equal(entryWindow(vnUtc(13, 30)).window, 'HIGH', 'VN 13:30 = HIGH');
assert.equal(entryWindow(vnUtc(14, 9)).window, 'HIGH', 'VN 14:09 = HIGH');

assert.equal(entryWindow(vnUtc(10, 30)).window, 'NORMAL', 'VN 10:30 = NORMAL');
assert.equal(entryWindow(vnUtc(11, 0)).window, 'NORMAL', 'VN 11:00 = NORMAL');
assert.equal(entryWindow(vnUtc(11, 14)).window, 'NORMAL', 'VN 11:14 = NORMAL');

assert.equal(entryWindow(vnUtc(11, 20)).window, 'REDUCED', 'VN 11:20 = REDUCED');
assert.equal(entryWindow(vnUtc(11, 29)).window, 'REDUCED', 'VN 11:29 = REDUCED');
assert.equal(entryWindow(vnUtc(14, 15)).window, 'REDUCED', 'VN 14:15 = REDUCED');
assert.equal(entryWindow(vnUtc(14, 29)).window, 'REDUCED', 'VN 14:29 = REDUCED');

assert.equal(entryWindow(vnUtc(9, 20)).window, 'DISCOVERY', 'VN 09:20 = DISCOVERY');
assert.equal(entryWindow(vnUtc(9, 29)).window, 'DISCOVERY', 'VN 09:29 = DISCOVERY');
assert.equal(entryWindow(vnUtc(13, 5)).window, 'DISCOVERY', 'VN 13:05 = DISCOVERY');

assert.equal(entryWindow(vnUtc(9, 0)).window, 'BLOCKED', 'VN 09:00 = BLOCKED');
assert.equal(entryWindow(vnUtc(11, 40)).window, 'BLOCKED', 'VN 11:40 = BLOCKED');

// Weekend
const sat = new Date(Date.UTC(2026, 6, 11, 3, 0)); // Sat 10:00 VN
assert.equal(entryWindow(sat).window, 'BLOCKED', 'Saturday BLOCKED');

// Priority Tue/Wed
const tue = new Date(Date.UTC(2026, 6, 7, 3, 0));
assert.equal(entryWindow(tue).priority, true, 'Tue priority');
const thu = new Date(Date.UTC(2026, 6, 9, 3, 0));
assert.equal(entryWindow(thu).priority, false, 'Thu not priority');

// Non-VN
assert.equal(entryWindow(vnUtc(10, 0), 'FX').window, 'N/A', 'FX = N/A');

// ==================== barStatus/sessionInfo timezone boundaries ====================

const h6Open = vnUtc(9, 0);
const h6Close = vnUtc(15, 0);
assert.equal(barStatus(h6Open.getTime() / 1000, 360, h6Open).closed, false, 'VN 09:00 H6 is open');
assert.equal(barStatus(h6Open.getTime() / 1000, 360, h6Close).closed, true, 'VN 15:00 H6 is closed');
assert.equal(sessionInfo(vnUtc(9, 0)).phase, 'ATO', 'VN 09:00 session boundary');
assert.equal(sessionInfo(vnUtc(15, 0)).phase, 'CLOSED', 'VN 15:00 session boundary');
assert.equal(entryWindow(new Date('2026-07-09T00:00:00.000Z')).window, 'BLOCKED', 'UTC midnight = VN pre-market');
assert.equal(sessionInfo(new Date('2026-07-09T00:00:00.000Z')).phase, 'CLOSED', 'UTC midnight = VN pre-market session');

// Run the same boundary contract under two host timezones. All results must
// match because production uses explicit Asia/Ho_Chi_Minh conversion.
const boundaryCode = `
  import { barStatus, entryWindow, sessionInfo } from ${JSON.stringify(BAR_STATUS_URL)};
  const d = value => new Date(value);
  const open = d('2026-07-09T02:00:00.000Z');
  const close = d('2026-07-09T08:00:00.000Z');
  const out = {
    open: barStatus(open.getTime() / 1000, 360, open),
    close: barStatus(open.getTime() / 1000, 360, close),
    at9: sessionInfo(open),
    at15: sessionInfo(close),
    midnight: { entry: entryWindow(d('2026-07-09T00:00:00.000Z')), session: sessionInfo(d('2026-07-09T00:00:00.000Z')) },
  };
  process.stdout.write(JSON.stringify(out));
`;
function boundaryUnderTz(tz) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', boundaryCode], {
    cwd: TEST_DIR,
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `boundary self-test should run under ${tz}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
assert.deepEqual(boundaryUnderTz('UTC'), boundaryUnderTz('America/New_York'), 'host TZ must not alter VN boundaries');

// ==================== lockedLtf ====================

// M5 locked: 2 qualifying closed bars
{
  const b1 = ltfBar(101, 100, { timeframe: '5', ageMin: 12 });
  const b0 = ltfBar(102, 101, { timeframe: '5', ageMin: 6 });
  const r = lockedLtf({ bars: [b1, b0], timeframe: '5', expectedSymbol: 'HOSE:TEST', maxAgeMs: 7200000, now: NOW_MS });
  assert.equal(r.locked, true, 'M5 2 qualifying bars = locked');
}

// M5 unlocked: wrong symbol
{
  const b1 = ltfBar(101, 100, { timeframe: '5', ageMin: 12, symbol: 'HOSE:WRONG' });
  const b0 = ltfBar(102, 101, { timeframe: '5', ageMin: 6 });
  const r = lockedLtf({ bars: [b1, b0], timeframe: '5', expectedSymbol: 'HOSE:TEST', maxAgeMs: 7200000, now: NOW_MS });
  assert.equal(r.locked, false, 'wrong symbol');
  assert.ok(r.reason.includes('wrong_symbol'), r.reason);
}

// M5 unlocked: wrong timeframe
{
  const b1 = ltfBar(101, 100, { timeframe: '60', ageMin: 12 });
  const b0 = ltfBar(102, 101, { timeframe: '5', ageMin: 6 });
  const r = lockedLtf({ bars: [b1, b0], timeframe: '5', expectedSymbol: 'HOSE:TEST', maxAgeMs: 7200000, now: NOW_MS });
  assert.equal(r.locked, false, 'wrong timeframe');
  assert.ok(r.reason.includes('wrong_timeframe'), r.reason);
}

// M5 unlocked: open bar
{
  const b1 = ltfBar(101, 100, { timeframe: '5', ageMin: 12 });
  const b0 = ltfBar(102, 101, { timeframe: '5', ageMin: 1, bar_closed: false });
  const r = lockedLtf({ bars: [b1, b0], timeframe: '5', expectedSymbol: 'HOSE:TEST', maxAgeMs: 7200000, now: NOW_MS });
  assert.equal(r.locked, false, 'open bar');
  assert.ok(r.reason.includes('open'), r.reason);
}

// M5 unlocked: stale bar
{
  const b1 = ltfBar(101, 100, { timeframe: '5', ageMin: 120 }); // 2 hours old
  const b0 = ltfBar(102, 101, { timeframe: '5', ageMin: 6 });
  const r = lockedLtf({ bars: [b1, b0], timeframe: '5', expectedSymbol: 'HOSE:TEST', maxAgeMs: 60000, now: NOW_MS });
  assert.equal(r.locked, false, 'stale bar');
  assert.ok(r.reason.includes('stale'), r.reason);
}

// M5 unlocked: bearish VSA
{
  const b1 = ltfBar(101, 100, { timeframe: '5', ageMin: 12 });
  const b0 = ltfBar(99, 100, { timeframe: '5', ageMin: 6, bearishVsa: true });
  const r = lockedLtf({ bars: [b1, b0], timeframe: '5', expectedSymbol: 'HOSE:TEST', maxAgeMs: 7200000, now: NOW_MS });
  assert.equal(r.locked, false, 'bearish VSA');
  assert.ok(r.reason.includes('bearish_vsa'), r.reason);
}

// M5 unlocked: delta divergence
{
  const b1 = ltfBar(101, 100, { timeframe: '5', ageMin: 12 });
  const b0 = ltfBar(102, 101, { timeframe: '5', ageMin: 6, bearishDivergence: true });
  const r = lockedLtf({ bars: [b1, b0], timeframe: '5', expectedSymbol: 'HOSE:TEST', maxAgeMs: 7200000, now: NOW_MS });
  assert.equal(r.locked, false, 'delta divergence');
  assert.ok(r.reason.includes('delta_divergence'), r.reason);
}

// M5 unlocked: dominant sell stack
{
  const b1 = ltfBar(101, 100, { timeframe: '5', ageMin: 12 });
  const b0 = ltfBar(99, 101, { timeframe: '5', ageMin: 6, buyStack: 1, sellStack: 5, low: 98 });
  const r = lockedLtf({ bars: [b1, b0], timeframe: '5', expectedSymbol: 'HOSE:TEST', maxAgeMs: 7200000, now: NOW_MS });
  assert.equal(r.locked, false, 'dominant sell stack');
  assert.ok(r.reason.includes('dominant_sell_stack') || r.reason.includes('bearish_price'), r.reason);
}

// M5 unlocked: aggressive sell
{
  const b1 = ltfBar(101, 100, { timeframe: '5', ageMin: 12 });
  const b0 = ltfBar(99, 100, { timeframe: '5', ageMin: 6, buyPct: 30 });
  const r = lockedLtf({ bars: [b1, b0], timeframe: '5', expectedSymbol: 'HOSE:TEST', maxAgeMs: 7200000, now: NOW_MS });
  assert.equal(r.locked, false, 'aggressive sell');
}

// M5 unlocked: protected-low breach
{
  const b1 = ltfBar(101, 100, { timeframe: '5', ageMin: 12 });
  const b0 = ltfBar(102, 101, { timeframe: '5', ageMin: 6, low: 95 });
  const r = lockedLtf({ bars: [b1, b0], timeframe: '5', expectedSymbol: 'HOSE:TEST', maxAgeMs: 7200000, now: NOW_MS, protectedLow: 96 });
  assert.equal(r.locked, false, 'protected-low breach');
  assert.ok(r.reason.includes('protected_low_breach'), r.reason);
}

// M5 unlocked: trigger-zone breach
{
  const b1 = ltfBar(101, 100, { timeframe: '5', ageMin: 12 });
  const b0 = ltfBar(102, 101, { timeframe: '5', ageMin: 6, low: 97 });
  const r = lockedLtf({ bars: [b1, b0], timeframe: '5', expectedSymbol: 'HOSE:TEST', maxAgeMs: 7200000, now: NOW_MS, triggerZoneLow: 98 });
  assert.equal(r.locked, false, 'trigger-zone breach');
  assert.ok(r.reason.includes('trigger_zone_breach'), r.reason);
}

// M5 per-bar different Footprints (mixed: one OK, one not)
{
  const b1 = ltfBar(101, 100, { timeframe: '5', ageMin: 12, buyPct: 55, delta: 500 });
  const b0 = ltfBar(99, 101, { timeframe: '5', ageMin: 6, low: 98, buyPct: 30, buyStack: 1, sellStack: 4 }); // aggressive sell + dominant sell
  const r = lockedLtf({ bars: [b1, b0], timeframe: '5', expectedSymbol: 'HOSE:TEST', maxAgeMs: 7200000, now: NOW_MS });
  assert.equal(r.locked, false, 'mixed per-bar Footprints');
}

// M5 two different Footprints both OK → locked
{
  const b1 = ltfBar(101, 100, { timeframe: '5', ageMin: 12, delta: 300, buyPct: 58, buyStack: 3, sellStack: 1 });
  const b0 = ltfBar(102, 101, { timeframe: '5', ageMin: 6, delta: 200, buyPct: 55, buyStack: 2, sellStack: 1 });
  const r = lockedLtf({ bars: [b1, b0], timeframe: '5', expectedSymbol: 'HOSE:TEST', maxAgeMs: 7200000, now: NOW_MS });
  assert.equal(r.locked, true, 'two diff OK Footprints = locked');
}

// M15 locked: 1 qualifying bar
{
  const r = lockedLtf({
    bars: [ltfBar(101, 100, { timeframe: '15', ageMin: 20 })],
    timeframe: '15', expectedSymbol: 'HOSE:TEST', maxAgeMs: 7200000, now: NOW_MS,
  });
  assert.equal(r.locked, true, 'M15 locked');
}

// H1 locked: 1 qualifying bar
{
  const r = lockedLtf({
    bars: [ltfBar(101, 100, { timeframe: '60', ageMin: 70 })],
    timeframe: '60', expectedSymbol: 'HOSE:TEST', maxAgeMs: 7200000, now: NOW_MS,
  });
  assert.equal(r.locked, true, 'H1 locked');
}

// Unsupported timeframe
{
  const r = lockedLtf({
    bars: [ltfBar(101, 100, { timeframe: '360', ageMin: 70 })],
    timeframe: '360', expectedSymbol: 'HOSE:TEST', maxAgeMs: 7200000, now: NOW_MS,
  });
  assert.equal(r.locked, false, 'unsupported timeframe');
  assert.ok(r.reason.includes('unsupported_timeframe'), r.reason);
}

// Missing maxAgeMs
{
  const r = lockedLtf({
    bars: [ltfBar(101, 100)],
    timeframe: '15', expectedSymbol: 'HOSE:TEST', now: NOW_MS,
  });
  assert.equal(r.locked, false, 'missing maxAgeMs');
  assert.ok(r.reason.includes('missing_max_age'), r.reason);
}

// Missing expectedSymbol
{
  const r = lockedLtf({
    bars: [ltfBar(101, 100)],
    timeframe: '15', maxAgeMs: 7200000, now: NOW_MS,
  });
  assert.equal(r.locked, false, 'missing expectedSymbol');
  assert.ok(r.reason.includes('missing_expected_symbol'), r.reason);
}

// Insufficient bars
{
  const r = lockedLtf({
    bars: [ltfBar(101, 100, { timeframe: '5', ageMin: 12 })],
    timeframe: '5', expectedSymbol: 'HOSE:TEST', maxAgeMs: 7200000, now: NOW_MS,
  });
  assert.equal(r.locked, false, 'insufficient bars');
  assert.ok(r.reason.includes('insufficient_bars'), r.reason);
}

// No bars
{
  const r = lockedLtf({ bars: [], timeframe: '5', expectedSymbol: 'HOSE:TEST', maxAgeMs: 7200000, now: NOW_MS });
  assert.equal(r.locked, false, 'no bars');
  assert.ok(r.reason.includes('missing_data'), r.reason);
}

console.log('ALL PASS');
