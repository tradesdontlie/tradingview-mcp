/**
 * Tests for the code-side signal→P&L engine (src/sidecar/signal_pnl.js) — T119.
 *
 * The P&L math is fixture-driven: the primary test hand-computes every metric
 * from a 7-bar series so a silent arithmetic bug can't hide. Pure functions —
 * no socket, no token, no fs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { backtestFromSignals } from '../src/sidecar/signal_pnl.js';

// Approx-equal for float fields.
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);

// Long-only fixture with explicit entry/exit flags → 3 trades: +10, -4, +6.
const FIXTURE = [
  { t: 10, values: { close: 100, entryS: 1, exitS: 0 } },
  { t: 11, values: { close: 105, entryS: 0, exitS: 0 } },
  { t: 12, values: { close: 110, entryS: 0, exitS: 1 } },
  { t: 13, values: { close: 108, entryS: 1, exitS: 0 } },
  { t: 14, values: { close: 104, entryS: 0, exitS: 1 } },
  { t: 15, values: { close: 106, entryS: 1, exitS: 0 } },
  { t: 16, values: { close: 112, entryS: 0, exitS: 0 } },
];

const FIXTURE_RULES = {
  side: 'long',
  entry: { field: 'entryS', op: 'truthy' },
  exit: { field: 'exitS', op: 'truthy' },
  price_field: 'close',
  qty: 1,
  fee_per_trade: 0,
  initial_capital: 1000,
};

describe('backtestFromSignals() — hand-computed fixture', () => {
  const r = backtestFromSignals({ series: FIXTURE, rules: FIXTURE_RULES });

  it('aggregate P&L metrics match hand-computed values', () => {
    near(r.net_profit, 12);
    near(r.gross_profit, 16);
    near(r.gross_loss, 4);
    near(r.profit_factor, 4);
    assert.equal(r.total_trades, 3);
    assert.equal(r.winning_trades, 2);
    assert.equal(r.losing_trades, 1);
    near(r.win_rate, 2 / 3);
    near(r.avg_trade, 4);
    near(r.avg_win, 8);
    near(r.avg_loss, -4);
    near(r.largest_win, 10);
    near(r.largest_loss, -4);
  });

  it('drawdown is measured on the realized-equity curve', () => {
    near(r.max_drawdown, 4);           // 1010 peak → 1006 trough
    near(r.max_drawdown_pct, 4 / 1010);
  });

  it('equity curve starts at initial_capital and records each close', () => {
    assert.deepEqual(r.equity_curve.map((p) => p.t), [10, 12, 14, 16]);
    const eq = r.equity_curve.map((p) => p.equity);
    assert.deepEqual(eq, [1000, 1010, 1006, 1012]);
  });

  it('trade list carries entry/exit/side/pnl and force-closes the last position', () => {
    assert.equal(r.trades.length, 3);
    const [a, b, c] = r.trades;
    assert.deepEqual(
      [a.entry_t, a.entry_price, a.exit_t, a.exit_price, a.side, a.pnl, a.bars_held, a.exit_reason],
      [10, 100, 12, 110, 'long', 10, 2, 'signal'],
    );
    near(a.return_pct, 10 / 100);
    assert.deepEqual([b.entry_t, b.exit_t, b.pnl, b.exit_reason], [13, 14, -4, 'signal']);
    assert.deepEqual([c.entry_t, c.exit_t, c.pnl, c.exit_reason], [15, 16, 6, 'end_of_data']);
  });
});

describe('backtestFromSignals() — crossover predicates', () => {
  // sig crosses above 0 → enter; crosses below 0 → exit.
  const series = [
    { t: 1, values: { close: 50, sig: -1 } },
    { t: 2, values: { close: 52, sig: 1 } },   // crosses_above 0 → enter @52
    { t: 3, values: { close: 55, sig: 2 } },
    { t: 4, values: { close: 53, sig: -1 } },  // crosses_below 0 → exit @53  (+1)
  ];
  const r = backtestFromSignals({
    series,
    rules: {
      side: 'long',
      entry: { field: 'sig', op: 'crosses_above', value: 0 },
      exit: { field: 'sig', op: 'crosses_below', value: 0 },
      price_field: 'close',
    },
  });
  it('enters on cross-above and exits on cross-below', () => {
    assert.equal(r.total_trades, 1);
    assert.equal(r.trades[0].entry_price, 52);
    assert.equal(r.trades[0].exit_price, 53);
    near(r.net_profit, 1);
  });
});

describe('backtestFromSignals() — short side', () => {
  const series = [
    { t: 1, values: { close: 100, s: 1 } }, // enter short @100
    { t: 2, values: { close: 90, s: 0 } },  // exit @90 → short gains +10
  ];
  const r = backtestFromSignals({
    series,
    rules: { side: 'short', entry: { field: 's', op: 'truthy' }, exit: { field: 's', op: 'falsy' }, price_field: 'close' },
  });
  it('a short profits when price falls', () => {
    assert.equal(r.trades[0].side, 'short');
    near(r.trades[0].pnl, 10);
    near(r.net_profit, 10);
  });
});

describe('backtestFromSignals() — fees and empty results', () => {
  it('subtracts a round-turn fee per trade', () => {
    const series = [
      { t: 1, values: { close: 100, e: 1, x: 0 } },
      { t: 2, values: { close: 110, e: 0, x: 1 } },
    ];
    const r = backtestFromSignals({
      series,
      rules: { entry: { field: 'e', op: 'truthy' }, exit: { field: 'x', op: 'truthy' }, price_field: 'close', fee_per_trade: 2 },
    });
    near(r.trades[0].pnl, 8); // 10 gross - 2 fee
    near(r.net_profit, 8);
  });

  it('returns null-safe metrics when no trade fires', () => {
    const series = [
      { t: 1, values: { close: 100, e: 0 } },
      { t: 2, values: { close: 110, e: 0 } },
    ];
    const r = backtestFromSignals({ series, rules: { entry: { field: 'e', op: 'truthy' }, price_field: 'close' } });
    assert.equal(r.total_trades, 0);
    assert.equal(r.net_profit, 0);
    assert.equal(r.win_rate, null);
    assert.equal(r.profit_factor, null);
    assert.equal(r.avg_trade, null);
    assert.deepEqual(r.trades, []);
  });
});

describe('backtestFromSignals() — input validation', () => {
  it('throws when the price field is missing from a bar that would fill', () => {
    const series = [{ t: 1, values: { e: 1 } }];
    assert.throws(
      () => backtestFromSignals({ series, rules: { entry: { field: 'e', op: 'truthy' }, price_field: 'close' } }),
      /price_field 'close'/,
    );
  });

  it('throws on missing entry rule', () => {
    assert.throws(() => backtestFromSignals({ series: [], rules: {} }), /entry` rule is required/);
  });

  it('throws on empty series', () => {
    assert.throws(() => backtestFromSignals({ series: [], rules: { entry: { field: 'e', op: 'truthy' } } }), /series` is required/);
  });
});

describe('all/any/not predicate combinators', () => {
  const series = [
    { t: 1, values: { close: 10, a: 1, b: 0 } }, // a&&!b → enter
    { t: 2, values: { close: 12, a: 1, b: 1 } }, // any(b) → exit
  ];
  it('combines leaf predicates', () => {
    const r = backtestFromSignals({
      series,
      rules: {
        entry: { all: [{ field: 'a', op: 'truthy' }, { not: { field: 'b', op: 'truthy' } }] },
        exit: { any: [{ field: 'b', op: 'truthy' }] },
        price_field: 'close',
      },
    });
    assert.equal(r.total_trades, 1);
    near(r.net_profit, 2);
  });
});
