/**
 * Phase 0A — deterministic, network-free tests for the pure strategy
 * economics math (src/core/options/strategyEconomics.js + executionModel.js).
 * No TradingView, no CDP, no live data. Textbook fixtures with hand-checked
 * expected values, plus invariant/property tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getFillPrice, validateContractForLeg } from '../src/core/options/executionModel.js';
import {
  computeLongCallEconomics, computeLongPutEconomics,
  computeBullCallSpreadEconomics, computeBearPutSpreadEconomics,
  computeBuyStockEconomics, computeNoTradeEconomics, buildPayoffGrid,
} from '../src/core/options/strategyEconomics.js';
import { EXECUTION_MODELS, REJECTION_REASONS } from '../src/core/options/strategyTypes.js';

const MULT = 100;

describe('getFillPrice()', () => {
  it('conservative: long fills at ask, short fills at bid', () => {
    const c = { bid: 4.9, ask: 5.1 };
    assert.equal(getFillPrice(c, 'long', 'conservative'), 5.1);
    assert.equal(getFillPrice(c, 'short', 'conservative'), 4.9);
  });

  it('mid: both sides fill at (bid+ask)/2', () => {
    const c = { bid: 4.9, ask: 5.1 };
    assert.equal(getFillPrice(c, 'long', 'mid'), 5.0);
    assert.equal(getFillPrice(c, 'short', 'mid'), 5.0);
  });

  it('a worse fill (wider market) never improves entry economics for a long', () => {
    // Wider ask = worse for a buyer. Conservative long fill must track ask upward.
    const tight = { bid: 4.9, ask: 5.0 };
    const wide = { bid: 4.5, ask: 5.5 };
    const tightFill = getFillPrice(tight, 'long', 'conservative');
    const wideFill = getFillPrice(wide, 'long', 'conservative');
    assert.ok(wideFill >= tightFill, 'a wider ask must never produce a cheaper long fill');
  });

  it('a worse fill never improves entry economics for a short', () => {
    // Wider bid (lower) = worse for a seller.
    const tight = { bid: 5.0, ask: 5.1 };
    const wide = { bid: 4.5, ask: 5.5 };
    const tightFill = getFillPrice(tight, 'short', 'conservative');
    const wideFill = getFillPrice(wide, 'short', 'conservative');
    assert.ok(wideFill <= tightFill, 'a lower bid must never produce a richer short fill');
  });

  it('never uses last price or theoretical_price for fills', () => {
    const c = { bid: 4.9, ask: 5.1, last: 999, theoretical_price: 999 };
    assert.equal(getFillPrice(c, 'long', 'conservative'), 5.1);
    assert.equal(getFillPrice(c, 'short', 'conservative'), 4.9);
  });
});

describe('validateContractForLeg() — hard gates', () => {
  const clean = { bid: 4.9, ask: 5.1, iv: 30, delta: 0.5, gamma: 0.02, theta: -0.1, vega: 0.2, rho: 0.05, spread_pct: 4 };

  it('accepts a fully clean contract', () => {
    assert.deepEqual(validateContractForLeg(clean, 'long', 15), []);
    assert.deepEqual(validateContractForLeg(clean, 'short', 15), []);
  });

  it('rejects missing bid/ask', () => {
    assert.ok(validateContractForLeg({ ...clean, bid: null }, 'long', 15).includes(REJECTION_REASONS.MISSING_BID));
    assert.ok(validateContractForLeg({ ...clean, ask: null }, 'long', 15).includes(REJECTION_REASONS.MISSING_ASK));
  });

  it('rejects a crossed market', () => {
    const crossed = { ...clean, bid: 5.5, ask: 5.0 };
    assert.ok(validateContractForLeg(crossed, 'long', 15).includes(REJECTION_REASONS.CROSSED_MARKET));
  });

  it('rejects missing IV', () => {
    assert.ok(validateContractForLeg({ ...clean, iv: null }, 'long', 15).includes(REJECTION_REASONS.MISSING_IV));
  });

  it('rejects missing any single greek', () => {
    for (const key of ['delta', 'gamma', 'theta', 'vega', 'rho']) {
      const reasons = validateContractForLeg({ ...clean, [key]: null }, 'long', 15);
      assert.ok(reasons.includes(REJECTION_REASONS.MISSING_GREEKS), `expected MISSING_GREEKS when ${key} is null`);
    }
  });

  it('rejects spread_pct above the configured max', () => {
    const wide = { ...clean, spread_pct: 20 };
    assert.ok(validateContractForLeg(wide, 'long', 15).includes(REJECTION_REASONS.WIDE_SPREAD));
    assert.ok(!validateContractForLeg(wide, 'long', 25).includes(REJECTION_REASONS.WIDE_SPREAD));
  });

  it('rejects ask <= 0 only for a long (purchased) leg', () => {
    const zeroAsk = { ...clean, ask: 0 };
    assert.ok(validateContractForLeg(zeroAsk, 'long', 15).includes(REJECTION_REASONS.INVALID_ASK));
    assert.ok(!validateContractForLeg(zeroAsk, 'short', 15).includes(REJECTION_REASONS.INVALID_ASK));
  });

  it('rejects a zero-bid short leg (illiquid/meaningless short) but not a long leg', () => {
    const zeroBid = { ...clean, bid: 0 };
    assert.ok(validateContractForLeg(zeroBid, 'short', 15).includes(REJECTION_REASONS.SHORT_LEG_ZERO_BID));
    assert.ok(!validateContractForLeg(zeroBid, 'long', 15).includes(REJECTION_REASONS.SHORT_LEG_ZERO_BID));
  });
});

// ---------------------------------------------------------------------------
// Textbook fixtures (Step 19) — hand-calculable expected values.
// ---------------------------------------------------------------------------

describe('Textbook fixture — Long Call', () => {
  // Spot 100, buy 100C at ask 5.00, commission 0, multiplier 100.
  const strike = 100, fillPrice = 5.00, commissionPerContract = 0;
  const econ = computeLongCallEconomics({ strike, fillPrice, multiplier: MULT, commissionPerContract });

  it('matches hand-calculated debit/max-loss/breakeven', () => {
    assert.equal(econ.entry_debit, 500);
    assert.equal(econ.max_loss, 500);
    assert.equal(econ.breakeven, 105);
    assert.equal(econ.max_profit_type, 'UNLIMITED');
    assert.equal(econ.max_profit, null);
  });

  it('matches hand-calculated expiration P&L at several spots', () => {
    assert.equal(econ.expirationPnl(90), -500);
    assert.equal(econ.expirationPnl(100), -500);
    assert.equal(econ.expirationPnl(105), 0);
    assert.equal(econ.expirationPnl(120), 1500);
  });
});

describe('Textbook fixture — Long Put', () => {
  // Spot 100, buy 100P at ask 4.00, commission 0.
  const strike = 100, fillPrice = 4.00, commissionPerContract = 0;
  const econ = computeLongPutEconomics({ strike, fillPrice, multiplier: MULT, commissionPerContract });

  it('matches hand-calculated debit/max-loss/max-profit/breakeven', () => {
    assert.equal(econ.entry_debit, 400);
    assert.equal(econ.max_loss, 400);
    assert.equal(econ.max_profit, 100 * 100 - 400); // 9600
    assert.equal(econ.breakeven, 96);
  });

  it('matches hand-calculated expiration P&L at several spots', () => {
    assert.equal(econ.expirationPnl(120), -400); // deep OTM
    assert.equal(econ.expirationPnl(100), -400); // ATM
    assert.equal(econ.expirationPnl(96), 0); // breakeven
    assert.equal(econ.expirationPnl(0), 9600); // max profit (stock to zero)
  });
});

describe('Textbook fixture — Bull Call Spread (Step 19 exact example)', () => {
  // Spot 100. Buy 100C ask 5.00. Sell 110C bid 2.00. Multiplier 100. Commission 0.
  const econ = computeBullCallSpreadEconomics({
    longStrike: 100, shortStrike: 110, longFill: 5.00, shortFill: 2.00,
    multiplier: MULT, commissionPerContract: 0,
  });

  it('matches the exact expected net debit / max loss / max profit / breakeven', () => {
    assert.equal(econ.entry_debit, 300);
    assert.equal(econ.max_loss, 300);
    assert.equal(econ.max_profit, 700);
    assert.equal(econ.breakeven, 103);
  });

  it('matches the exact expected P&L curve', () => {
    assert.equal(econ.expirationPnl(90), -300);
    assert.equal(econ.expirationPnl(100), -300);
    assert.equal(econ.expirationPnl(103), 0);
    assert.equal(econ.expirationPnl(110), 700);
    assert.equal(econ.expirationPnl(120), 700);
  });

  it('shortcut (width*mult - debit) matches the direct two-leg calculation at max profit', () => {
    const width = 110 - 100;
    const shortcutMaxProfit = width * MULT - econ.entry_debit;
    assert.equal(shortcutMaxProfit, econ.expirationPnl(200)); // deep past short strike
    assert.equal(shortcutMaxProfit, econ.max_profit);
  });
});

describe('Textbook fixture — Bear Put Spread', () => {
  // Spot 100. Buy 100P ask 5.00. Sell 90P bid 2.00. Multiplier 100. Commission 0.
  const econ = computeBearPutSpreadEconomics({
    longStrike: 100, shortStrike: 90, longFill: 5.00, shortFill: 2.00,
    multiplier: MULT, commissionPerContract: 0,
  });

  it('matches hand-calculated debit/max-loss/max-profit/breakeven', () => {
    assert.equal(econ.entry_debit, 300); // (5-2)*100
    assert.equal(econ.max_loss, 300);
    assert.equal(econ.max_profit, (100 - 90) * 100 - 300); // 700
    assert.equal(econ.breakeven, 97);
  });

  it('matches hand-calculated P&L curve', () => {
    assert.equal(econ.expirationPnl(110), -300); // above long strike -> max loss
    assert.equal(econ.expirationPnl(100), -300);
    assert.equal(econ.expirationPnl(97), 0);
    assert.equal(econ.expirationPnl(90), 700);
    assert.equal(econ.expirationPnl(80), 700);
  });

  it('shortcut matches direct two-leg calculation at max profit', () => {
    const width = 100 - 90;
    const shortcutMaxProfit = width * MULT - econ.entry_debit;
    assert.equal(shortcutMaxProfit, econ.expirationPnl(0));
    assert.equal(shortcutMaxProfit, econ.max_profit);
  });
});

describe('Textbook fixture — Buy Stock baseline', () => {
  it('sizes shares conservatively from max_loss, floor()', () => {
    // max_loss=1000, price=333 -> floor(1000/333)=3 shares -> entry cost 999
    const econ = computeBuyStockEconomics({ underlyingPrice: 333, maxLoss: 1000 });
    assert.equal(econ.shares, 3);
    assert.equal(econ.entry_debit, 999);
    assert.equal(econ.max_loss, 999); // worst case: stock to zero
    assert.equal(econ.breakeven, 333);
  });

  it('returns null (baseline unavailable) when max_loss cannot buy even 1 share', () => {
    const econ = computeBuyStockEconomics({ underlyingPrice: 1000, maxLoss: 500 });
    assert.equal(econ, null);
  });

  it('expiration P&L matches (S_T - entry_price) * shares', () => {
    const econ = computeBuyStockEconomics({ underlyingPrice: 100, maxLoss: 1000 }); // 10 shares
    assert.equal(econ.expirationPnl(110), 100); // (110-100)*10
    assert.equal(econ.expirationPnl(90), -100);
    assert.equal(econ.expirationPnl(0), -1000); // total loss, matches max_loss
  });
});

describe('Textbook fixture — No Trade baseline', () => {
  const econ = computeNoTradeEconomics();

  it('is always zero capital, zero loss, zero profit', () => {
    assert.equal(econ.entry_debit, 0);
    assert.equal(econ.max_loss, 0);
    assert.equal(econ.max_profit, 0);
    assert.equal(econ.capital_required, 0);
  });

  it('P&L is always exactly zero at any spot', () => {
    for (const s of [0, 1, 50, 100, 1000, 1e6]) {
      assert.equal(econ.expirationPnl(s), 0);
    }
  });
});

// ---------------------------------------------------------------------------
// Property / invariant tests (Step 20)
// ---------------------------------------------------------------------------

describe('Invariants', () => {
  it('long option max_loss is always >= 0', () => {
    const call = computeLongCallEconomics({ strike: 50, fillPrice: 1.23, multiplier: 100, commissionPerContract: 0.65 });
    const put = computeLongPutEconomics({ strike: 50, fillPrice: 1.23, multiplier: 100, commissionPerContract: 0.65 });
    assert.ok(call.max_loss >= 0);
    assert.ok(put.max_loss >= 0);
  });

  it('debit vertical: max_profit + max_loss == width * multiplier (bull call)', () => {
    const econ = computeBullCallSpreadEconomics({ longStrike: 50, shortStrike: 55, longFill: 3, shortFill: 1, multiplier: 100, commissionPerContract: 1 });
    const width = 55 - 50;
    assert.equal(econ.max_profit + econ.max_loss, width * 100);
  });

  it('debit vertical: max_profit + max_loss == width * multiplier (bear put)', () => {
    const econ = computeBearPutSpreadEconomics({ longStrike: 55, shortStrike: 50, longFill: 3, shortFill: 1, multiplier: 100, commissionPerContract: 1 });
    const width = 55 - 50;
    assert.equal(econ.max_profit + econ.max_loss, width * 100);
  });

  it('bull call P&L never exceeds max_profit and never falls below -max_loss', () => {
    const econ = computeBullCallSpreadEconomics({ longStrike: 50, shortStrike: 60, longFill: 4, shortFill: 1.5, multiplier: 100, commissionPerContract: 0.5 });
    for (const s of [0, 10, 30, 49, 50, 55, 60, 61, 100, 1000]) {
      const pnl = econ.expirationPnl(s);
      assert.ok(pnl <= econ.max_profit + 1e-9, `pnl ${pnl} exceeded max_profit ${econ.max_profit} at S_T=${s}`);
      assert.ok(pnl >= -econ.max_loss - 1e-9, `pnl ${pnl} fell below -max_loss ${-econ.max_loss} at S_T=${s}`);
    }
  });

  it('bear put P&L never exceeds max_profit and never falls below -max_loss', () => {
    const econ = computeBearPutSpreadEconomics({ longStrike: 60, shortStrike: 50, longFill: 4, shortFill: 1.5, multiplier: 100, commissionPerContract: 0.5 });
    for (const s of [0, 10, 30, 49, 50, 55, 60, 61, 100, 1000]) {
      const pnl = econ.expirationPnl(s);
      assert.ok(pnl <= econ.max_profit + 1e-9, `pnl ${pnl} exceeded max_profit ${econ.max_profit} at S_T=${s}`);
      assert.ok(pnl >= -econ.max_loss - 1e-9, `pnl ${pnl} fell below -max_loss ${-econ.max_loss} at S_T=${s}`);
    }
  });

  it('NO_TRADE P&L is always exactly 0', () => {
    const econ = computeNoTradeEconomics();
    for (const s of [-1, 0, 1, 1e9]) assert.equal(econ.expirationPnl(s), 0);
  });

  it('fees strictly increase max_loss for a long call, all else equal', () => {
    const noFee = computeLongCallEconomics({ strike: 50, fillPrice: 2, multiplier: 100, commissionPerContract: 0 });
    const withFee = computeLongCallEconomics({ strike: 50, fillPrice: 2, multiplier: 100, commissionPerContract: 5 });
    assert.ok(withFee.max_loss > noFee.max_loss);
  });

  it('fees strictly increase max_loss for a bull call spread, all else equal', () => {
    const noFee = computeBullCallSpreadEconomics({ longStrike: 50, shortStrike: 55, longFill: 3, shortFill: 1, multiplier: 100, commissionPerContract: 0 });
    const withFee = computeBullCallSpreadEconomics({ longStrike: 50, shortStrike: 55, longFill: 3, shortFill: 1, multiplier: 100, commissionPerContract: 2 });
    assert.ok(withFee.max_loss > noFee.max_loss);
  });

  it('a worse (more expensive) long fill never decreases max_loss', () => {
    const cheap = computeLongCallEconomics({ strike: 50, fillPrice: 2, multiplier: 100, commissionPerContract: 0 });
    const expensive = computeLongCallEconomics({ strike: 50, fillPrice: 3, multiplier: 100, commissionPerContract: 0 });
    assert.ok(expensive.max_loss > cheap.max_loss);
  });
});

describe('buildPayoffGrid()', () => {
  it('produces the 5 standard spot multiples plus breakeven and strikes, deduplicated and sorted', () => {
    const econ = computeLongCallEconomics({ strike: 100, fillPrice: 5, multiplier: 100, commissionPerContract: 0 });
    const grid = buildPayoffGrid({ spot: 100, breakeven: econ.breakeven, relevantPrices: econ.relevantPrices, expirationPnl: econ.expirationPnl });
    assert.equal(grid.payoff_type, 'EXPIRATION_INTRINSIC');
    const prices = grid.points.map(p => p.underlying_price_at_expiry);
    // sorted ascending
    for (let i = 1; i < prices.length; i++) assert.ok(prices[i] > prices[i - 1]);
    // contains the standard multiples
    for (const m of [80, 90, 100, 110, 120]) assert.ok(prices.includes(m));
    // contains breakeven (105) and strike (100, already present)
    assert.ok(prices.includes(105));
  });

  it('never includes non-positive or non-finite price points', () => {
    const grid = buildPayoffGrid({ spot: 10, breakeven: null, relevantPrices: [null, -5, NaN, Infinity], expirationPnl: () => 0 });
    for (const p of grid.points) assert.ok(p.underlying_price_at_expiry > 0 && Number.isFinite(p.underlying_price_at_expiry));
  });
});
