import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_CONFIG,
  detectCupAndHandle,
  findConfirmedPivots,
  normalizeBars,
  normalizeTimeframe,
  validateConfig,
} from '../cup-and-handle/analysis/cup-handle-core.mjs';

const STEP = 14_400_000;

function makeBar(index, close, overrides = {}) {
  return {
    time: 1_700_000_000_000 + index * STEP,
    time_close: 1_700_000_000_000 + (index + 1) * STEP,
    open: overrides.open ?? close,
    high: overrides.high ?? close + 0.4,
    low: overrides.low ?? close - 0.4,
    close: overrides.close ?? close,
    volume: overrides.volume ?? 1_000_000,
  };
}

function makeValidPattern({
  scale = 1,
  breakout = true,
  wickOnlyBreakout = false,
  invalidateHandle = false,
} = {}) {
  const closes = [];
  for (let index = 0; index < 10; index += 1) closes.push(92 + index * 0.8);
  for (let index = 10; index <= 50; index += 1) {
    const x = (index - 10) / 40;
    closes.push(100 - 25 * (1 - (2 * x - 1) ** 2));
  }
  closes.push(
    97, 95, 93, 94, 95, 96, 97, 98,
    96, 94, invalidateHandle ? 84 : 91, 93, 95, 95.5,
    breakout ? 99 : 95,
    breakout ? 101 : 94.8,
    breakout ? 102 : 94.6,
    breakout ? 103 : 94.4,
  );
  return closes.map((unscaledClose, index) => {
    const close = unscaledClose * scale;
    const overrides = {};
    if (wickOnlyBreakout && index === 65) {
      overrides.high = 101 * scale;
      overrides.close = 96 * scale;
    }
    if (invalidateHandle && index === 61) overrides.low = 83.5 * scale;
    return makeBar(index, close, {
      ...overrides,
      high: overrides.high ?? close + 0.4 * scale,
      low: overrides.low ?? close - 0.4 * scale,
    });
  });
}

function detect(bars, overrides = {}) {
  return detectCupAndHandle({
    bars,
    symbol: 'NASDAQ:TEST',
    timeframe: '4H',
    config: overrides,
  });
}

function makeDeterministicRandomWalk(seed, length = 500) {
  let state = seed >>> 0;
  const random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
  let previousClose = 100;
  return Array.from({ length }, (_, index) => {
    const open = previousClose;
    const close = Math.max(5, open + (random() - 0.49) * 6);
    const spread = 0.2 + random() * 2;
    previousClose = close;
    return makeBar(index, close, {
      open,
      high: Math.max(open, close) + spread,
      low: Math.max(0.1, Math.min(open, close) - spread),
    });
  });
}

describe('Cup-and-Handle clean-room configuration', () => {
  it('freezes TradingView-documented structural defaults separately from tunable rules', () => {
    assert.equal(DEFAULT_CONFIG.lookback_bars, 600);
    assert.equal(DEFAULT_CONFIG.pivot_left_bars, 5);
    assert.equal(DEFAULT_CONFIG.pivot_right_bars, 5);
    assert.equal(DEFAULT_CONFIG.minimum_cup_bars, 20);
    assert.equal(DEFAULT_CONFIG.prior_trend_gate_enabled, false);
    assert.equal(DEFAULT_CONFIG.detector_version, '0.1.2-cleanroom');
  });

  it('normalizes only the approved first-slice timeframes', () => {
    assert.equal(normalizeTimeframe('240'), '4H');
    assert.equal(normalizeTimeframe('D'), '1D');
    assert.equal(normalizeTimeframe('1W'), '1W');
    assert.throws(() => normalizeTimeframe('1M'), /4H, 1D, or 1W/);
  });

  it('rejects contradictory or malformed threshold contracts', () => {
    assert.throws(
      () => validateConfig({ forming_recovery_fraction: 0.9 }),
      /forming recovery must be below rim-approach recovery/,
    );
    assert.throws(
      () => validateConfig({ minimum_cup_bars: 40, maximum_cup_bars: 20 }),
      /maximum_cup_bars/,
    );
    assert.throws(
      () => validateConfig({ lookback_bars: 100, maximum_cup_bars: 100 }),
      /maximum_cup_bars must be below lookback_bars/,
    );
    assert.throws(
      () => validateConfig({ prior_trend_gate_enabled: true }),
      /not implemented/,
    );
    assert.notEqual(
      validateConfig().config_id,
      validateConfig({ minimum_handle_bars: 4 }).config_id,
    );
  });
});

describe('Closed-bar normalization and causal 5/5 pivots', () => {
  it('drops an explicitly incomplete tail but rejects duplicate or unordered bars', () => {
    const rows = makeValidPattern().slice(0, 20);
    const incomplete = { ...rows.at(-1), time: rows.at(-1).time + STEP, complete_bar: false };
    assert.equal(normalizeBars([...rows, incomplete]).length, rows.length);
    assert.throws(
      () => normalizeBars([rows[0], { ...rows[1], complete_bar: false }, rows[2]]),
      /terminal suffix/,
    );
    assert.throws(() => normalizeBars([...rows, { ...rows.at(-1) }]), /strictly increasing/);
    assert.throws(() => normalizeBars([rows[1], rows[0]]), /strictly increasing/);
  });

  it('records a pivot at its anchor bar but makes it available five bars later', () => {
    const bars = normalizeBars(makeValidPattern());
    const pivots = findConfirmedPivots(bars);
    const leftRim = pivots.highs.find((pivot) => pivot.index === 10);
    const bottom = pivots.lows.find((pivot) => pivot.index === 30);
    const rightRim = pivots.highs.find((pivot) => pivot.index === 50);
    assert.equal(leftRim.confirmed_index, 15);
    assert.equal(bottom.confirmed_index, 35);
    assert.equal(rightRim.confirmed_index, 55);
  });

  it('preserves explicit close time separately from the bar-open identity', () => {
    const [bar] = normalizeBars([makeBar(0, 100)]);
    assert.equal(bar.time_close - bar.time, STEP);
    assert.throws(
      () => normalizeBars([{ ...makeBar(0, 100), time_close: makeBar(0, 100).time }]),
      /time_close must be after time/,
    );
  });

  it('uses the rightmost member of an equal-price pivot plateau', () => {
    const rows = Array.from({ length: 20 }, (_, index) => makeBar(index, 90));
    rows[8] = makeBar(8, 100, { high: 101 });
    rows[9] = makeBar(9, 100, { high: 101 });
    for (let index = 10; index < 15; index += 1) rows[index] = makeBar(index, 95 - index / 10);
    const pivots = findConfirmedPivots(normalizeBars(rows));
    assert.equal(pivots.highs.some((pivot) => pivot.index === 8), false);
    assert.equal(pivots.highs.some((pivot) => pivot.index === 9), true);
  });
});

describe('Cup-and-Handle lifecycle', () => {
  it('progresses once through forming, rim, handle, ready, and close-confirmed breakout', () => {
    const result = detect(makeValidPattern());
    const breakout = result.transitions.find(
      (transition) => transition.to_stage === 'BREAKOUT_CONFIRMED',
    );
    const lifecycle = result.transitions.filter((transition) => (
      transition.family_id === breakout.family_id
      && (transition.provisional || transition.pattern_id === breakout.pattern_id)
    ));
    const stages = lifecycle.map((transition) => transition.to_stage);
    assert.deepEqual(stages, [
      'CUP_FORMING',
      'RIM_APPROACH',
      'HANDLE_FORMING',
      'HANDLE_READY',
      'BREAKOUT_CONFIRMED',
    ]);
    assert.equal(new Set(lifecycle.map((transition) => transition.event_id)).size, stages.length);
    assert.equal(new Set(lifecycle.map((transition) => transition.family_id)).size, 1);
    assert.equal(new Set(lifecycle.map((transition) => transition.pattern_id)).size, 2);
    assert.match(breakout.pattern_id, /\|p3=\d+$/);
    assert.equal(breakout.detection_bar_close_time - breakout.detection_bar_open_time, STEP);
    const completed = result.patterns.find((pattern) => pattern.stage === 'BREAKOUT_CONFIRMED');
    assert.equal(completed.provisional, false);
    assert.equal(completed.anchors.left_rim.index, 10);
    assert.equal(completed.anchors.cup_bottom.index, 30);
    assert.equal(completed.anchors.right_rim.index, 50);
    assert.equal(completed.anchors.handle.index, 58);
    assert.equal(completed.anchors.breakout.index, 65);
  });

  it('does not claim the confirmed cup before the right-rim pivot becomes knowable', () => {
    const bars = makeValidPattern();
    const beforeConfirmation = detect(bars.slice(0, 55));
    const atConfirmation = detect(bars.slice(0, 56));
    assert.equal(
      beforeConfirmation.transitions.some((transition) => transition.to_stage === 'HANDLE_FORMING'),
      false,
    );
    const handleEvent = atConfirmation.transitions.find(
      (transition) => transition.to_stage === 'HANDLE_FORMING',
    );
    assert.equal(handleEvent.detection_index, 55);
  });

  it('requires a close above the handle line, not merely a wick', () => {
    const result = detect(makeValidPattern({ breakout: false, wickOnlyBreakout: true }));
    assert.equal(
      result.transitions.some((transition) => transition.to_stage === 'BREAKOUT_CONFIRMED'),
      false,
    );
    assert.equal(result.current_pattern.stage, 'HANDLE_READY');
  });

  it('invalidates when the handle rollback crosses its configured floor', () => {
    const result = detect(makeValidPattern({ breakout: false, invalidateHandle: true }));
    const invalidation = result.transitions.find(
      (transition) => transition.to_stage === 'INVALIDATED' && !transition.provisional,
    );
    assert.ok(invalidation);
    assert.notEqual(result.current_pattern?.pattern_id, invalidation.pattern_id);
  });

  it('invalidates an upside escape that occurs before any handle pivot exists', () => {
    const bars = makeValidPattern().slice(0, 56);
    for (let index = 56; index < 70; index += 1) {
      bars.push(makeBar(index, 101 + (index - 56) * 0.5));
    }
    const result = detect(bars);
    const handleStart = result.transitions.find(
      (transition) => transition.to_stage === 'HANDLE_FORMING',
    );
    const invalidation = result.transitions.find((transition) => (
      transition.pattern_id === handleStart.pattern_id
      && transition.to_stage === 'INVALIDATED'
    ));
    assert.ok(invalidation);
    const escaped = result.patterns.find(
      (pattern) => pattern.pattern_id === handleStart.pattern_id,
    );
    assert.deepEqual(escaped.reasons, ['PRE_HANDLE_UPSIDE_ESCAPE']);
    assert.ok(bars[invalidation.detection_index].close > escaped.anchors.right_rim.price);
  });

  it('emits an explicit terminal event when provisional geometry collapses', () => {
    const bars = makeValidPattern().slice(0, 50);
    bars.push(makeBar(50, 60, { high: 61, low: 59 }));
    const result = detect(bars);
    assert.deepEqual(
      result.transitions.map((transition) => transition.to_stage),
      ['CUP_FORMING', 'RIM_APPROACH', 'INVALIDATED'],
    );
    const invalidation = result.transitions.at(-1);
    assert.equal(invalidation.from_stage, 'RIM_APPROACH');
    assert.equal(invalidation.provisional, true);
    assert.equal(invalidation.anchors.left_rim.index, 10);
    assert.equal(result.current_pattern, null);
  });

  it('treats a confirmed breakout as terminal and never later expires the same family', () => {
    const bars = makeValidPattern();
    const nextIndex = bars.length;
    for (let index = nextIndex; index < nextIndex + 60; index += 1) {
      bars.push(makeBar(index, 101 + Math.sin(index) * 0.2));
    }
    const result = detect(bars);
    const breakout = result.transitions.find(
      (transition) => transition.to_stage === 'BREAKOUT_CONFIRMED',
    );
    const terminalStages = result.transitions
      .filter((transition) => transition.pattern_id === breakout.pattern_id)
      .filter((transition) => (
        transition.to_stage === 'BREAKOUT_CONFIRMED'
        || transition.to_stage === 'INVALIDATED'
        || transition.to_stage === 'EXPIRED'
      ))
      .map((transition) => transition.to_stage);
    assert.deepEqual(terminalStages, ['BREAKOUT_CONFIRMED']);
    assert.notEqual(result.current_pattern?.pattern_id, breakout.pattern_id);
  });

  it('does not re-arm a completed cup family after its confirmed breakout', () => {
    const result = detect(makeValidPattern());
    const breakout = result.transitions.find(
      (transition) => transition.to_stage === 'BREAKOUT_CONFIRMED',
    );
    const sameFamilyAfterBreakout = result.transitions.filter((transition) => (
      transition.family_id === breakout.family_id
      && transition.detection_index > breakout.detection_index
    ));
    assert.deepEqual(sameFamilyAfterBreakout, []);
  });

  it('never starts a confirmed pattern from a right rim that was knowable on an earlier bar', () => {
    const result = detect(makeDeterministicRandomWalk(1), {
      minimum_u_shape_score: 0.2,
      center_tolerance_fraction_of_half_width: 0.8,
      rim_deviation_fraction_of_cup_height: 0.5,
    });
    const lateConfirmedStarts = result.transitions.filter((transition) => (
      transition.to_stage === 'HANDLE_FORMING'
      && transition.from_stage === 'NONE'
      && transition.anchors?.right_rim?.confirmed_index < transition.detection_index
    ));
    assert.deepEqual(lateConfirmedStarts, []);
  });

  it('retires the provisional record when its family promotes to a confirmed cup', () => {
    const result = detect(makeValidPattern());
    const breakout = result.transitions.find(
      (transition) => transition.to_stage === 'BREAKOUT_CONFIRMED',
    );
    assert.equal(
      result.patterns.some((pattern) => (
        pattern.family_id === breakout.family_id && pattern.provisional
      )),
      false,
    );
  });

  it('rejects a confirmed cup one bar inside the documented 20-bar minimum', () => {
    const bars = makeValidPattern();
    // Raising the minimum to 41 makes the otherwise valid 40-bar cup the exact
    // one-bar-inside boundary twin.
    const result = detect(bars, { minimum_cup_bars: 41 });
    assert.equal(
      result.patterns.some((pattern) => (
        pattern.anchors.left_rim?.index === 10
        && pattern.anchors.right_rim?.index === 50
      )),
      false,
    );
  });

  it('is price-scale invariant for stages and normalized geometry', () => {
    const base = detect(makeValidPattern());
    const scaled = detect(makeValidPattern({ scale: 100 }));
    assert.deepEqual(
      scaled.transitions.map((transition) => transition.to_stage),
      base.transitions.map((transition) => transition.to_stage),
    );
    const baseCompleted = base.patterns.find((pattern) => pattern.stage === 'BREAKOUT_CONFIRMED');
    const scaledCompleted = scaled.patterns.find((pattern) => pattern.stage === 'BREAKOUT_CONFIRMED');
    assert.equal(scaledCompleted.quality_score, baseCompleted.quality_score);
    assert.ok(
      Math.abs(
        scaledCompleted.metrics.rim_error - baseCompleted.metrics.rim_error,
      ) < 1e-12,
    );
  });
});

describe('Non-repainting invariants', () => {
  it('matches every transition on the same closed prefix', () => {
    const bars = makeValidPattern();
    const full = detect(bars);
    for (const length of [48, 50, 56, 64, 66]) {
      const prefix = detect(bars.slice(0, length));
      const cutoffTime = bars[length - 1].time;
      assert.deepEqual(
        full.transitions.filter(
          (transition) => transition.detection_bar_open_time <= cutoffTime,
        ),
        prefix.transitions,
        `prefix length ${length}`,
      );
    }
  });

  it('future mutations cannot alter already-known anchors, IDs, or transitions', () => {
    const bars = makeValidPattern();
    const cutoffLength = 64;
    const original = detect(bars.slice(0, cutoffLength));
    const mutated = bars.map((bar, index) => (
      index < cutoffLength
        ? bar
        : makeBar(index, 40 + index, { high: 200 + index, low: 20 })
    ));
    const mutatedResult = detect(mutated);
    const cutoffTime = bars[cutoffLength - 1].time;
    assert.deepEqual(
      mutatedResult.transitions.filter(
        (transition) => transition.detection_bar_open_time <= cutoffTime,
      ),
      original.transitions,
    );
  });

  it('recalculation is byte-deterministic', () => {
    const bars = makeValidPattern();
    assert.equal(JSON.stringify(detect(bars)), JSON.stringify(detect(bars)));
  });
});
