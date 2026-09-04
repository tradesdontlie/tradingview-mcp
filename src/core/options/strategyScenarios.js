// Phase 0B — deterministic scenario/mark-to-market engine. Pure, no I/O.
//
// Takes a Phase 0A candidate (from strategyCandidates.js), a map of the
// original chain contracts by ticker (for their Greeks/theoretical_price/iv,
// which Phase 0A candidates don't retain), and one or more scenario
// definitions. Produces exact leg-by-leg repricing + strategy-level
// scenario P&L. No ranking, no probability model, no AI — see
// strategyTypes.js for the full list of exclusions.
//
// FUTURE PRICER INTERFACE (Step 22): any future pricing engine (e.g. a real
// American-option model) must implement the same contract as
// optionRepricer.repriceOptionLocalGreeks:
//   input:  { optionType, strike, currentTheoreticalPrice, delta, gamma,
//             theta, vega, currentUnderlyingPrice, scenarioUnderlyingPrice,
//             daysForward, daysToExpiry, currentIv, scenarioIv }
//   output: { available, pricing_model, anchor_price_source,
//             current_theoretical_price, spot_effect, gamma_effect,
//             theta_effect, vega_effect, raw_estimated_value,
//             intrinsic_floor, final_estimated_value, warnings }
// generateCandidateScenarioResults() below is pricer-agnostic: swapping in
// a future AMERICAN_OPTION_MODEL repricer requires no changes here as long
// as it satisfies this same input/output shape. Not implemented in Phase 0B.

import { PRICING_MODELS, SCENARIO_WARNINGS } from './strategyTypes.js';
import { repriceOptionLocalGreeks, round2 } from './optionRepricer.js';

/**
 * Resolves the scenario's target IV (decimal) for one option leg from its
 * own current IV baseline. Two explicit input methods (Step 6):
 *   A) scenario.scenario_iv        - absolute target IV, DECIMAL (e.g. 0.45)
 *   B) scenario.iv_change_points   - a point shock, e.g. +10 means +0.10 decimal
 * If neither is given, IV is held constant (no change).
 */
export function resolveScenarioIv(currentIvDecimal, scenario) {
  if (scenario.scenario_iv != null) return scenario.scenario_iv;
  if (scenario.iv_change_points != null) return currentIvDecimal + scenario.iv_change_points / 100;
  return currentIvDecimal;
}

/**
 * Convenience helper (Step 10) — NOT the sole scenario generator. Explicit
 * user-defined scenarios remain preferred; this exists for a quick
 * three-point sanity check anchored on the current spot.
 */
export function buildThreeScenarioSet(currentSpot, {
  daysForward,
  bearMultiplier = 0.90,
  bullMultiplier = 1.10,
  bearIvChangePoints = 10,
  baseIvChangePoints = 0,
  bullIvChangePoints = -10,
} = {}) {
  return [
    { scenario_id: 'BEAR', underlying_price: round2(currentSpot * bearMultiplier), days_forward: daysForward, iv_change_points: bearIvChangePoints },
    { scenario_id: 'BASE', underlying_price: round2(currentSpot), days_forward: daysForward, iv_change_points: baseIvChangePoints },
    { scenario_id: 'BULL', underlying_price: round2(currentSpot * bullMultiplier), days_forward: daysForward, iv_change_points: bullIvChangePoints },
  ];
}

/**
 * Convenience helper (Step 11) — NOT the sole scenario generator. Builds a
 * BASE/BEAR/BULL set from a user's price thesis rather than flat percentages.
 * BEAR moves halfway in the opposite direction of the expected move; BULL
 * extends the expected move by 50%. Documented as convenience only.
 */
export function buildScenariosFromThesis({
  current_spot: currentSpot, expected_price: expectedPrice, horizon_days: horizonDays, expected_iv_change_points: ivChangePoints = 0,
}) {
  const expectedMove = expectedPrice - currentSpot;
  const bearSpot = currentSpot - 0.5 * expectedMove;
  const bullSpot = currentSpot + 1.5 * expectedMove;

  return [
    { scenario_id: 'BEAR', underlying_price: round2(bearSpot), days_forward: horizonDays, iv_change_points: ivChangePoints },
    { scenario_id: 'BASE', underlying_price: round2(expectedPrice), days_forward: horizonDays, iv_change_points: ivChangePoints },
    { scenario_id: 'BULL', underlying_price: round2(bullSpot), days_forward: horizonDays, iv_change_points: ivChangePoints },
  ];
}

function repriceLeg(leg, scenario, contractsByTicker, currentUnderlyingPrice) {
  const sourceContract = contractsByTicker.get(leg.contract);
  if (!sourceContract) {
    return { available: false, warnings: ['MISSING_SOURCE_CONTRACT'] };
  }

  const currentIvDecimal = sourceContract.iv == null ? null : sourceContract.iv / 100;
  if (currentIvDecimal == null) {
    return { available: false, warnings: [SCENARIO_WARNINGS.MISSING_GREEKS] };
  }
  const scenarioIvDecimal = resolveScenarioIv(currentIvDecimal, scenario);

  const priced = repriceOptionLocalGreeks({
    optionType: sourceContract.option_type,
    strike: sourceContract.strike,
    currentTheoreticalPrice: sourceContract.theoretical_price,
    delta: sourceContract.delta,
    gamma: sourceContract.gamma,
    theta: sourceContract.theta,
    vega: sourceContract.vega,
    currentUnderlyingPrice,
    scenarioUnderlyingPrice: scenario.underlying_price,
    daysForward: scenario.days_forward,
    daysToExpiry: sourceContract.days_to_expiry,
    currentIv: currentIvDecimal,
    scenarioIv: scenarioIvDecimal,
  });

  return { ...priced, currentIvDecimal, scenarioIvDecimal };
}

/**
 * Reprices one candidate under one scenario. Returns a single scenario_result
 * entry (Step 12 shape). Never fabricates a value when a required input is
 * missing — returns { available: false, ... } instead.
 */
export function repriceCandidateScenario(candidate, scenario, contractsByTicker, { contractMultiplier, currentUnderlyingPrice }) {
  const base = {
    scenario_id: scenario.scenario_id,
    underlying_price: scenario.underlying_price,
    days_forward: scenario.days_forward,
    scenario_iv: scenario.scenario_iv ?? null,
  };

  if (candidate.strategy_type === 'NO_TRADE') {
    return {
      ...base,
      available: true,
      estimated_strategy_value: 0,
      scenario_pnl: 0,
      scenario_return_on_risk_pct: 0,
      pricing_models_used: [],
      warnings: [],
      leg_results: [],
    };
  }

  if (candidate.strategy_type === 'BUY_STOCK') {
    const shares = candidate.legs[0].shares;
    const entryPrice = candidate.breakeven; // BUY_STOCK breakeven == entry underlying price
    const scenarioValue = shares * scenario.underlying_price;
    const scenarioPnl = shares * (scenario.underlying_price - entryPrice);
    const maxLoss = candidate.max_loss;
    return {
      ...base,
      available: true,
      estimated_strategy_value: round2(scenarioValue),
      scenario_pnl: round2(scenarioPnl),
      scenario_return_on_risk_pct: maxLoss > 0 ? round2((scenarioPnl / maxLoss) * 100) : 0,
      pricing_models_used: [],
      warnings: [],
      leg_results: [{ role: 'long', shares, entry_price: entryPrice, scenario_price: scenario.underlying_price }],
    };
  }

  // Option-leg strategies: LONG_CALL, LONG_PUT, BULL_CALL_SPREAD, BEAR_PUT_SPREAD
  const legResults = [];
  const pricingModelsUsed = new Set();
  const warnings = new Set();
  let sumLegPnl = 0;
  let estimatedStrategyValue = 0;
  let unavailable = false;

  for (const leg of candidate.legs) {
    const priced = repriceLeg(leg, scenario, contractsByTicker, currentUnderlyingPrice);
    if (!priced.available) {
      unavailable = true;
      (priced.warnings ?? []).forEach(w => warnings.add(w));
      legResults.push({ role: leg.role, contract: leg.contract, available: false, warnings: priced.warnings ?? [] });
      continue;
    }

    pricingModelsUsed.add(priced.pricing_model);
    (priced.warnings ?? []).forEach(w => warnings.add(w));

    const finalValue = priced.final_estimated_value;
    const legPnl = leg.role === 'long'
      ? (finalValue - leg.fill_price) * contractMultiplier
      : (leg.fill_price - finalValue) * contractMultiplier;
    sumLegPnl += legPnl;
    estimatedStrategyValue += leg.role === 'long' ? finalValue * contractMultiplier : -finalValue * contractMultiplier;

    legResults.push({
      role: leg.role,
      contract: leg.contract,
      available: true,
      fill_price: leg.fill_price,
      current_theoretical_price: priced.current_theoretical_price,
      estimated_value: finalValue,
      leg_pnl: round2(legPnl),
      pricing_model: priced.pricing_model,
      anchor_price_source: priced.anchor_price_source,
      spot_effect: priced.spot_effect,
      gamma_effect: priced.gamma_effect,
      theta_effect: priced.theta_effect,
      vega_effect: priced.vega_effect,
      raw_estimated_value: priced.raw_estimated_value,
      intrinsic_floor: priced.intrinsic_floor,
      current_iv: priced.currentIvDecimal,
      scenario_iv: priced.scenarioIvDecimal,
      warnings: priced.warnings ?? [],
    });
  }

  if (unavailable) {
    return {
      ...base,
      available: false,
      estimated_strategy_value: null,
      scenario_pnl: null,
      scenario_return_on_risk_pct: null,
      pricing_models_used: [...pricingModelsUsed],
      warnings: [...warnings],
      leg_results: legResults,
    };
  }

  // Fees are already embedded once in candidate.fees (Phase 0A entry
  // economics) — subtract exactly once here, never re-added per leg.
  const scenarioPnl = sumLegPnl - candidate.fees;
  const maxLoss = candidate.max_loss;

  return {
    ...base,
    available: true,
    estimated_strategy_value: round2(estimatedStrategyValue),
    scenario_pnl: round2(scenarioPnl),
    scenario_return_on_risk_pct: maxLoss > 0 ? round2((scenarioPnl / maxLoss) * 100) : 0,
    pricing_models_used: [...pricingModelsUsed],
    warnings: [...warnings],
    leg_results: legResults,
  };
}

/**
 * Attaches scenario_results (one per scenario) to a candidate. Does not
 * mutate the input candidate.
 */
export function generateCandidateScenarioResults(candidate, scenarios, contractsByTicker, cfg) {
  return {
    ...candidate,
    scenario_results: scenarios.map(scenario => repriceCandidateScenario(candidate, scenario, contractsByTicker, cfg)),
  };
}
