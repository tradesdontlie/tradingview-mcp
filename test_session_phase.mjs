// Session Phase and Entry Window tests
// Run: node test_session_phase.mjs
import assert from 'node:assert/strict';
import { entryWindow, lockedLtf, sessionInfo } from './bar_status.mjs';

function mk(h, m, d = 9) { return new Date(2026, 6, d, h, m); } // July 2026
const NOW = new Date('2026-07-09T10:30:00Z').getTime(); // deterministic reference

// ===== entryWindow =====

// HIGH windows
assert.equal(entryWindow(mk(9, 45)).window, 'HIGH', '09:45 = HIGH');
assert.equal(entryWindow(mk(10, 0)).window, 'HIGH', '10:00 = HIGH');
assert.equal(entryWindow(mk(10, 29)).window, 'HIGH', '10:29 = HIGH');
assert.equal(entryWindow(mk(13, 30)).window, 'HIGH', '13:30 = HIGH');
assert.equal(entryWindow(mk(14, 9)).window, 'HIGH', '14:09 = HIGH');

// NORMAL window
assert.equal(entryWindow(mk(10, 30)).window, 'NORMAL', '10:30 = NORMAL');
assert.equal(entryWindow(mk(11, 0)).window, 'NORMAL', '11:00 = NORMAL');
assert.equal(entryWindow(mk(11, 14)).window, 'NORMAL', '11:14 = NORMAL');

// REDUCED windows
assert.equal(entryWindow(mk(11, 20)).window, 'REDUCED', '11:20 = REDUCED');
assert.equal(entryWindow(mk(11, 29)).window, 'REDUCED', '11:29 = REDUCED');
assert.equal(entryWindow(mk(14, 15)).window, 'REDUCED', '14:15 = REDUCED');
assert.equal(entryWindow(mk(14, 29)).window, 'REDUCED', '14:29 = REDUCED');

// DISCOVERY windows
assert.equal(entryWindow(mk(9, 20)).window, 'DISCOVERY', '09:20 = DISCOVERY');
assert.equal(entryWindow(mk(9, 29)).window, 'DISCOVERY', '09:29 = DISCOVERY');
assert.equal(entryWindow(mk(13, 5)).window, 'DISCOVERY', '13:05 = DISCOVERY');
assert.equal(entryWindow(mk(13, 14)).window, 'DISCOVERY', '13:14 = DISCOVERY');

// BLOCKED windows
assert.equal(entryWindow(mk(9, 0)).window, 'BLOCKED', '09:00 = BLOCKED (ato)');
assert.equal(entryWindow(mk(9, 14)).window, 'BLOCKED', '09:14 = BLOCKED (ato)');
assert.equal(entryWindow(mk(11, 40)).window, 'BLOCKED', '11:40 = BLOCKED (lunch)');
assert.equal(entryWindow(mk(12, 30)).window, 'BLOCKED', '12:30 = BLOCKED (lunch)');
assert.equal(entryWindow(mk(14, 35)).window, 'BLOCKED', '14:35 = BLOCKED (atc)');
assert.equal(entryWindow(mk(14, 44)).window, 'BLOCKED', '14:44 = BLOCKED (atc)');

// Weekend
const saturday = new Date(2026, 6, 11, 10, 0); // Saturday 2026-07-11
assert.equal(entryWindow(saturday).window, 'BLOCKED', 'Saturday = BLOCKED');
const sunday = new Date(2026, 6, 12, 10, 0); // Sunday 2026-07-12
assert.equal(entryWindow(sunday).window, 'BLOCKED', 'Sunday = BLOCKED');

// Priority: Tuesday/Wednesday
assert.equal(entryWindow(mk(10, 0, 7)).priority, true, 'Tuesday = priority'); // 2026-07-07 is Tuesday
assert.equal(entryWindow(mk(10, 0, 8)).priority, true, 'Wednesday = priority'); // 2026-07-08 is Wednesday
assert.equal(entryWindow(mk(10, 0, 9)).priority, false, 'Thursday = not priority'); // 2026-07-09 is Thursday
assert.equal(entryWindow(mk(10, 0, 6)).priority, false, 'Monday = not priority'); // 2026-07-06 is Monday

// Non-VN
assert.equal(entryWindow(mk(10, 0), 'FX').window, 'N/A', 'FX market = N/A');

// ===== lockedLtf =====

function bar(close, open, ageMin) {
  return { close, open, time: NOW / 1000 - ageMin * 60 };
}

// M5 locked: 2 consecutive closed non-bearish bars
{
  const result = lockedLtf({
    bars: [bar(101, 100, 12), bar(102, 101, 6)], // both closed (>5min), both non-bearish
    timeframe: '5', symbol: 'HOSE:TEST', maxAgeMs: 300000, now: NOW,
  });
  assert.equal(result.locked, true, 'M5 2 non-bearish closed bars = locked');
}

// M5 not locked: bearish bar
{
  const result = lockedLtf({
    bars: [bar(99, 100, 12), bar(102, 101, 6)],
    timeframe: '5', symbol: 'HOSE:TEST', now: NOW,
  });
  assert.equal(result.locked, false, 'M5 bearish bar = not locked');
}

// M5 not locked: open bar (too recent)
{
  const result = lockedLtf({
    bars: [bar(101, 100, 2), bar(102, 101, 6)], // first bar is only 2 min old, not closed
    timeframe: '5', symbol: 'HOSE:TEST', now: NOW,
  });
  assert.equal(result.locked, false, 'M5 open bar = not locked');
}

// M5 not locked: only 1 bar when 2 required
{
  const result = lockedLtf({
    bars: [bar(101, 100, 12)],
    timeframe: '5', symbol: 'HOSE:TEST', now: NOW,
  });
  assert.equal(result.locked, false, 'M5 insufficient bars = not locked');
}

// H1 locked: 1 closed non-bearish bar
{
  const result = lockedLtf({
    bars: [bar(101, 100, 70)], // 70 min old, well past 60 min
    timeframe: '60', symbol: 'HOSE:TEST', now: NOW,
  });
  assert.equal(result.locked, true, 'H1 1 non-bearish closed bar = locked');
}

// H1 not locked: bearish
{
  const result = lockedLtf({
    bars: [bar(99, 100, 70)],
    timeframe: '60', symbol: 'HOSE:TEST', now: NOW,
  });
  assert.equal(result.locked, false, 'H1 bearish = not locked');
}

// M15 locked: 1 closed non-bearish bar
{
  const result = lockedLtf({
    bars: [bar(101, 100, 20)], // 20 min old, past 15 min
    timeframe: '15', symbol: 'HOSE:TEST', now: NOW,
  });
  assert.equal(result.locked, true, 'M15 locked');
}

// Unsupported timeframe
{
  const result = lockedLtf({
    bars: [bar(101, 100, 70)],
    timeframe: '360', symbol: 'HOSE:TEST', now: NOW,
  });
  assert.equal(result.locked, false, 'H6 unsupported = not locked');
  assert.ok(result.reason.includes('unsupported_timeframe'));
}

// No bars
{
  const result = lockedLtf({ bars: [], timeframe: '5', symbol: 'HOSE:TEST', now: NOW });
  assert.equal(result.locked, false, 'no bars = not locked');
}

// Doi xung: entryWindow & sessionInfo phase boundaries match
{
  const e9_10 = entryWindow(mk(9, 10));
  const s9_10 = sessionInfo(mk(9, 10));
  assert.equal(e9_10.window, 'BLOCKED', '09:10 entry = BLOCKED (ato)');
  assert.equal(s9_10.phase, 'ATO', '09:10 session = ATO');
}

{
  const e13_30 = entryWindow(mk(13, 30));
  const s13_30 = sessionInfo(mk(13, 30));
  assert.equal(e13_30.window, 'HIGH', '13:30 entry = HIGH');
  assert.equal(s13_30.phase, 'CONT_PM', '13:30 session = CONT_PM');
}

{
  const e14_40 = entryWindow(mk(14, 40));
  const s14_40 = sessionInfo(mk(14, 40));
  assert.equal(e14_40.window, 'BLOCKED', '14:40 entry = BLOCKED (atc)');
  assert.equal(s14_40.phase, 'ATC', '14:40 session = ATC');
}

console.log('ALL PASS');
