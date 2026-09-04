// Phase 0A — deterministic strategy economics. Pure, no I/O, no randomness.
//
// Every function here takes already-decided fill prices (from
// executionModel.js) and returns exact expiration economics. Nothing in
// this file depends on volume, open interest, last price, or any
// probability model — those are explicitly out of scope for Phase 0A.

import { MAX_PROFIT_TYPES, PAYOFF_TYPES } from './strategyTypes.js';

function round2(v) {
  return v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;
}

/** Long call: buy one call. */
export function computeLongCallEconomics({ strike, fillPrice, multiplier, commissionPerContract }) {
  const entryOptionCost = fillPrice * multiplier;
  const fees = commissionPerContract;
  const totalDebit = entryOptionCost + fees;
  const maxLoss = totalDebit;
  const breakeven = strike + totalDebit / multiplier;

  const expirationPnl = (spotAtExpiry) => {
    const intrinsic = Math.max(spotAtExpiry - strike, 0) * multiplier;
    return intrinsic - totalDebit;
  };

  return {
    entry_debit: round2(totalDebit),
    fees: round2(fees),
    capital_required: round2(totalDebit),
    max_loss: round2(maxLoss),
    max_profit: null,
    max_profit_type: MAX_PROFIT_TYPES.UNLIMITED,
    breakeven: round2(breakeven),
    expirationPnl,
    relevantPrices: [strike],
  };
}

/** Long put: buy one put. */
export function computeLongPutEconomics({ strike, fillPrice, multiplier, commissionPerContract }) {
  const totalDebit = fillPrice * multiplier + commissionPerContract;
  const maxLoss = totalDebit;
  const maxTheoreticalValue = strike * multiplier;
  const maxProfit = maxTheoreticalValue - totalDebit;
  const breakeven = strike - totalDebit / multiplier;

  const expirationPnl = (spotAtExpiry) => {
    const intrinsic = Math.max(strike - spotAtExpiry, 0) * multiplier;
    return intrinsic - totalDebit;
  };

  return {
    entry_debit: round2(totalDebit),
    fees: round2(commissionPerContract),
    capital_required: round2(totalDebit),
    max_loss: round2(maxLoss),
    max_profit: round2(maxProfit),
    max_profit_type: MAX_PROFIT_TYPES.DEFINED,
    breakeven: round2(breakeven),
    expirationPnl,
    relevantPrices: [strike],
  };
}

/**
 * Bull call spread: buy lower-strike call, sell higher-strike call, same
 * expiration. Debit spreads only in V1 — a non-positive net debit is
 * rejected by the caller (strategyCandidates.js), not here.
 */
export function computeBullCallSpreadEconomics({ longStrike, shortStrike, longFill, shortFill, multiplier, commissionPerContract }) {
  const grossOptionDebitPerShare = longFill - shortFill;
  const fees = 2 * commissionPerContract;
  const totalDebit = grossOptionDebitPerShare * multiplier + fees;
  const width = shortStrike - longStrike;
  const maxLoss = totalDebit;
  const maxProfit = width * multiplier - totalDebit;
  const breakeven = longStrike + totalDebit / multiplier;

  // Computed directly from both legs, not as a shortcut off net-debit alone.
  const expirationPnl = (spotAtExpiry) => {
    const longIntrinsic = Math.max(spotAtExpiry - longStrike, 0) * multiplier;
    const shortIntrinsic = Math.max(spotAtExpiry - shortStrike, 0) * multiplier;
    const longLegPnl = longIntrinsic - (longFill * multiplier);
    const shortLegPnl = (shortFill * multiplier) - shortIntrinsic;
    return longLegPnl + shortLegPnl - fees;
  };

  return {
    entry_debit: round2(totalDebit),
    fees: round2(fees),
    capital_required: round2(totalDebit),
    max_loss: round2(maxLoss),
    max_profit: round2(maxProfit),
    max_profit_type: MAX_PROFIT_TYPES.DEFINED,
    breakeven: round2(breakeven),
    expirationPnl,
    relevantPrices: [longStrike, shortStrike],
    totalDebitRaw: totalDebit,
  };
}

/**
 * Bear put spread: buy higher-strike put, sell lower-strike put, same
 * expiration. Debit spreads only — a non-positive net debit is rejected by
 * the caller, not here.
 */
export function computeBearPutSpreadEconomics({ longStrike, shortStrike, longFill, shortFill, multiplier, commissionPerContract }) {
  const fees = 2 * commissionPerContract;
  const totalDebit = (longFill - shortFill) * multiplier + fees;
  const width = longStrike - shortStrike;
  const maxLoss = totalDebit;
  const maxProfit = width * multiplier - totalDebit;
  const breakeven = longStrike - totalDebit / multiplier;

  const expirationPnl = (spotAtExpiry) => {
    const longIntrinsic = Math.max(longStrike - spotAtExpiry, 0) * multiplier;
    const shortIntrinsic = Math.max(shortStrike - spotAtExpiry, 0) * multiplier;
    const longLegPnl = longIntrinsic - (longFill * multiplier);
    const shortLegPnl = (shortFill * multiplier) - shortIntrinsic;
    return longLegPnl + shortLegPnl - fees;
  };

  return {
    entry_debit: round2(totalDebit),
    fees: round2(fees),
    capital_required: round2(totalDebit),
    max_loss: round2(maxLoss),
    max_profit: round2(maxProfit),
    max_profit_type: MAX_PROFIT_TYPES.DEFINED,
    breakeven: round2(breakeven),
    expirationPnl,
    relevantPrices: [longStrike, shortStrike],
    totalDebitRaw: totalDebit,
  };
}

/**
 * Buy-stock baseline — sized conservatively from the user's max_loss, purely
 * for economic comparison. Never presented as an options recommendation.
 */
export function computeBuyStockEconomics({ underlyingPrice, maxLoss }) {
  const shares = Math.floor(maxLoss / underlyingPrice);
  if (shares < 1) return null; // baseline unavailable

  const entryCost = shares * underlyingPrice;

  const expirationPnl = (spotAtExpiry) => (spotAtExpiry - underlyingPrice) * shares;

  return {
    shares,
    entry_debit: round2(entryCost),
    fees: 0,
    capital_required: round2(entryCost),
    max_loss: round2(entryCost), // worst case: stock goes to zero
    max_profit: null,
    max_profit_type: MAX_PROFIT_TYPES.UNLIMITED,
    breakeven: round2(underlyingPrice),
    expirationPnl,
    relevantPrices: [underlyingPrice],
  };
}

/** No-trade baseline — always zero, always present, never filtered. */
export function computeNoTradeEconomics() {
  return {
    entry_debit: 0,
    fees: 0,
    capital_required: 0,
    max_loss: 0,
    max_profit: 0,
    max_profit_type: MAX_PROFIT_TYPES.DEFINED,
    breakeven: null,
    expirationPnl: () => 0,
    relevantPrices: [],
  };
}

/**
 * Builds a deterministic EXPIRATION payoff grid (Step 18). Points are the
 * standard +/-20%/+/-10% spot multiples, the breakeven, and any relevant
 * strikes — deduplicated and sorted. Not a forecast: purely intrinsic value
 * at expiration for the given price points.
 */
export function buildPayoffGrid({ spot, breakeven, relevantPrices = [], expirationPnl }) {
  const raw = [0.8, 0.9, 1.0, 1.1, 1.2].map(m => spot * m);
  if (breakeven != null) raw.push(breakeven);
  for (const p of relevantPrices) if (p != null) raw.push(p);

  const rounded = raw.filter(p => p != null && Number.isFinite(p) && p > 0).map(p => round2(p));
  const unique = [...new Set(rounded)].sort((a, b) => a - b);

  return {
    payoff_type: PAYOFF_TYPES.EXPIRATION_INTRINSIC,
    points: unique.map(underlying_price_at_expiry => ({
      underlying_price_at_expiry,
      strategy_pnl: round2(expirationPnl(underlying_price_at_expiry)),
    })),
  };
}

export { round2 };
