// Phase 0A — deterministic entry-fill model. Pure, no I/O.
//
// CONSERVATIVE (default): long fills at ask, short fills at bid — the
// worse-for-you side of the quoted market on each leg.
// MID: fills at (bid+ask)/2 for both sides.
//
// Never use last trade price or theoretical_price for entry economics.
// theoretical_price is analytical context only (Step 3 of the phase spec).

import { EXECUTION_MODELS, REJECTION_REASONS } from './strategyTypes.js';

/**
 * @param {{bid:number|null, ask:number|null}} contract
 * @param {'long'|'short'} side
 * @param {'conservative'|'mid'} executionModel
 * @returns {number|null} fill price, or null if the required quote side is missing
 */
export function getFillPrice(contract, side, executionModel) {
  const { bid, ask } = contract;
  if (executionModel === EXECUTION_MODELS.MID) {
    if (bid == null || ask == null) return null;
    return (bid + ask) / 2;
  }
  // conservative (default)
  if (side === 'long') return ask ?? null;
  if (side === 'short') return bid ?? null;
  throw new Error(`Invalid leg side "${side}". Must be "long" or "short".`);
}

/**
 * Hard quality gates (Phase 0A Step 10). Returns a list of rejection reasons;
 * an empty list means the contract is eligible for the given leg role.
 *
 * @param {object} contract - a normalized options_get_chain contract
 * @param {'long'|'short'} side
 * @param {number} maxSpreadPct
 * @returns {string[]} rejection reasons (REJECTION_REASONS values)
 */
export function validateContractForLeg(contract, side, maxSpreadPct) {
  const reasons = [];
  const { bid, ask, iv, delta, gamma, theta, vega, rho, spread_pct: spreadPct } = contract;

  if (bid == null) reasons.push(REJECTION_REASONS.MISSING_BID);
  if (ask == null) reasons.push(REJECTION_REASONS.MISSING_ASK);
  if (bid != null && ask != null && ask < bid) reasons.push(REJECTION_REASONS.CROSSED_MARKET);
  if (iv == null) reasons.push(REJECTION_REASONS.MISSING_IV);
  if (delta == null || gamma == null || theta == null || vega == null || rho == null) {
    reasons.push(REJECTION_REASONS.MISSING_GREEKS);
  }
  if (spreadPct != null && maxSpreadPct != null && spreadPct > maxSpreadPct) {
    reasons.push(REJECTION_REASONS.WIDE_SPREAD);
  }

  if (side === 'long') {
    // A purchased leg with ask <= 0 has no meaningful entry cost basis.
    if (ask != null && ask <= 0) reasons.push(REJECTION_REASONS.INVALID_ASK);
  } else if (side === 'short') {
    // A short leg quoted at zero bid carries no meaningful liquidity/premium —
    // reject rather than accept a economically meaningless "free" short.
    if (bid === 0) reasons.push(REJECTION_REASONS.SHORT_LEG_ZERO_BID);
  }

  return reasons;
}
