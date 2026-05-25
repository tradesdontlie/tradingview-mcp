// JSON DSL parser + evaluator for local signal rules.
//
// Rule shape:
// {
//   name: 'btc_oversold_bounce',
//   sub_id: 'hl_a',                    // subscription producing ticks
//   conditions: [
//     { left: { metric:'rsi', period:14 }, op:'<', right:{ const: 30 } },
//     { left: { metric:'close' }, op:'>', right:{ metric:'ema', period:50 } }
//   ],
//   require: 'all' | 'any',            // default all
//   cooldown_ms: 3_600_000              // optional; default 0
// }

import ti from 'technicalindicators';

const OPS = {
  '<': (a, b) => a < b,
  '>': (a, b) => a > b,
  '<=': (a, b) => a <= b,
  '>=': (a, b) => a >= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
};

function lastClose(ring) {
  const t = ring.latest();
  return t ? t.price : null;
}

function pricesFromRing(ring) {
  // Treat each tick price as a "bar close". Sparse but simple. Future:
  // pre-aggregate to TF bars.
  return ring.data.map(t => t.price);
}

function lastIndicator(values) {
  return values && values.length ? values[values.length - 1] : null;
}

function evaluateOperand(operand, ring) {
  if (!operand) return null;
  if ('const' in operand) return Number(operand.const);
  if (operand.metric === 'close' || operand.metric === 'price') return lastClose(ring);
  if (operand.metric === 'rsi') {
    const prices = pricesFromRing(ring);
    if (prices.length < (operand.period || 14) + 1) return null;
    return lastIndicator(ti.RSI.calculate({ values: prices, period: operand.period || 14 }));
  }
  if (operand.metric === 'ema') {
    const prices = pricesFromRing(ring);
    if (prices.length < (operand.period || 20)) return null;
    return lastIndicator(ti.EMA.calculate({ values: prices, period: operand.period || 20 }));
  }
  if (operand.metric === 'sma') {
    const prices = pricesFromRing(ring);
    if (prices.length < (operand.period || 20)) return null;
    return lastIndicator(ti.SMA.calculate({ values: prices, period: operand.period || 20 }));
  }
  if (operand.metric === 'atr') {
    // Not enough data without highs/lows from real bars. Tick-based ATR
    // approximated via stdev of price diffs.
    const prices = pricesFromRing(ring);
    if (prices.length < (operand.period || 14) + 1) return null;
    const diffs = [];
    for (let i = 1; i < prices.length; i++) diffs.push(Math.abs(prices[i] - prices[i - 1]));
    const tail = diffs.slice(-(operand.period || 14));
    return tail.reduce((a, b) => a + b, 0) / tail.length;
  }
  return null;
}

export function evaluateRule(rule, ring) {
  if (!rule.conditions || !rule.conditions.length) return { matched: false, reason: 'no conditions' };
  const results = rule.conditions.map(c => {
    const l = evaluateOperand(c.left, ring);
    const r = evaluateOperand(c.right, ring);
    const op = OPS[c.op];
    if (l == null || r == null || !op) return { ok: false, l, r };
    return { ok: op(l, r), l, r };
  });
  const required = rule.require || 'all';
  const matched = required === 'any' ? results.some(x => x.ok) : results.every(x => x.ok);
  return { matched, details: results };
}

export function validateRule(rule) {
  const errors = [];
  if (!rule.name) errors.push('missing name');
  if (!rule.sub_id) errors.push('missing sub_id');
  if (!Array.isArray(rule.conditions) || !rule.conditions.length) errors.push('missing conditions[]');
  for (const c of rule.conditions || []) {
    if (!OPS[c.op]) errors.push(`unknown op ${c.op}`);
  }
  if (rule.require && !['all', 'any'].includes(rule.require)) errors.push('require must be all | any');
  return errors;
}
