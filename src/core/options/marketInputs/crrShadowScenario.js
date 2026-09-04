// Phase 2C, Steps 10, 13-14, 26 — CRR shadow scenario aggregation.
// Mirrors strategyScenarios.js's repriceCandidateScenario /
// generateCandidateScenarioResults SHAPE exactly, so shadow-priced
// candidates can be fed straight into the existing, unmodified
// strategyRanking.rankStrategyCandidates for the Step 26 "shadow ranking"
// comparison. Does not import or mutate strategyScenarios.js.

import { round2 } from '../optionRepricer.js';
import { repriceOptionCrrShadow } from '../pricing/crrShadowRepricer.js';
import { resolveScenarioIv } from '../strategyScenarios.js';

function repriceLegCrrShadow(leg, scenario, contractsByTicker, currentUnderlyingPrice, marketInput) {
  const sourceContract = contractsByTicker.get(leg.contract);
  if (!sourceContract) return { available: false, warnings: ['MISSING_SOURCE_CONTRACT'] };

  const currentIvDecimal = sourceContract.iv == null ? null : sourceContract.iv / 100;
  if (currentIvDecimal == null) return { available: false, warnings: ['MISSING_GREEKS'] };
  const scenarioIvDecimal = resolveScenarioIv(currentIvDecimal, scenario);

  const priced = repriceOptionCrrShadow({
    optionType: sourceContract.option_type,
    strike: sourceContract.strike,
    currentUnderlyingPrice,
    scenarioUnderlyingPrice: scenario.underlying_price,
    daysForward: scenario.days_forward,
    daysToExpiry: sourceContract.days_to_expiry,
    currentIv: currentIvDecimal,
    scenarioIv: scenarioIvDecimal,
    discountRate: marketInput?.discount_rate,
    effectiveCarryYield: marketInput?.effective_carry_yield,
  });

  return { ...priced, currentIvDecimal, scenarioIvDecimal, market_input_confidence: marketInput?.overall_confidence ?? null, market_input_warnings: marketInput?.warnings ?? [] };
}

/**
 * Step 10/13 — CRR-shadow equivalent of strategyScenarios.repriceCandidateScenario.
 * Same aggregation math (leg_pnl formula, fee subtraction) as production,
 * just swapping the per-leg pricer. NO_TRADE/BUY_STOCK pass through
 * unchanged (they have no option legs to reprice differently).
 */
export function repriceCandidateScenarioCrrShadow(candidate, scenario, contractsByTicker, { contractMultiplier, currentUnderlyingPrice, marketInputByExpiration }) {
  const base = { scenario_id: scenario.scenario_id, underlying_price: scenario.underlying_price, days_forward: scenario.days_forward, scenario_iv: scenario.scenario_iv ?? null };

  if (candidate.strategy_type === 'NO_TRADE') {
    return { ...base, available: true, estimated_strategy_value: 0, scenario_pnl: 0, scenario_return_on_risk_pct: 0, pricing_models_used: [], warnings: [], leg_results: [] };
  }
  if (candidate.strategy_type === 'BUY_STOCK') {
    const shares = candidate.legs[0].shares;
    const entryPrice = candidate.breakeven;
    const scenarioValue = shares * scenario.underlying_price;
    const scenarioPnl = shares * (scenario.underlying_price - entryPrice);
    const maxLoss = candidate.max_loss;
    return {
      ...base, available: true, estimated_strategy_value: round2(scenarioValue), scenario_pnl: round2(scenarioPnl),
      scenario_return_on_risk_pct: maxLoss > 0 ? round2((scenarioPnl / maxLoss) * 100) : 0,
      pricing_models_used: [], warnings: [], leg_results: [{ role: 'long', shares, entry_price: entryPrice, scenario_price: scenario.underlying_price }],
    };
  }

  const legResults = [];
  const pricingModelsUsed = new Set();
  const warnings = new Set();
  let sumLegPnl = 0;
  let estimatedStrategyValue = 0;
  let unavailable = false;

  for (const leg of candidate.legs) {
    const marketInput = marketInputByExpiration.get(candidate.expiration);
    const priced = repriceLegCrrShadow(leg, scenario, contractsByTicker, currentUnderlyingPrice, marketInput);
    if (!priced.available) {
      unavailable = true;
      (priced.warnings ?? []).forEach(w => warnings.add(w));
      legResults.push({ role: leg.role, contract: leg.contract, available: false, warnings: priced.warnings ?? [] });
      continue;
    }
    pricingModelsUsed.add(priced.pricing_model);
    (priced.warnings ?? []).forEach(w => warnings.add(w));

    const finalValue = priced.final_estimated_value;
    const legPnl = leg.role === 'long' ? (finalValue - leg.fill_price) * contractMultiplier : (leg.fill_price - finalValue) * contractMultiplier;
    sumLegPnl += legPnl;
    estimatedStrategyValue += leg.role === 'long' ? finalValue * contractMultiplier : -finalValue * contractMultiplier;

    legResults.push({
      role: leg.role, contract: leg.contract, available: true, fill_price: leg.fill_price,
      estimated_value: finalValue, leg_pnl: round2(legPnl), pricing_model: priced.pricing_model,
      raw_estimated_value: priced.raw_estimated_value, intrinsic_floor: priced.intrinsic_floor,
      current_iv: priced.currentIvDecimal, scenario_iv: priced.scenarioIvDecimal,
      market_input_confidence: priced.market_input_confidence, warnings: priced.warnings ?? [],
    });
  }

  if (unavailable) {
    return { ...base, available: false, estimated_strategy_value: null, scenario_pnl: null, scenario_return_on_risk_pct: null, pricing_models_used: [...pricingModelsUsed], warnings: [...warnings], leg_results: legResults };
  }

  const scenarioPnl = sumLegPnl - candidate.fees;
  const maxLoss = candidate.max_loss;
  return {
    ...base, available: true, estimated_strategy_value: round2(estimatedStrategyValue), scenario_pnl: round2(scenarioPnl),
    scenario_return_on_risk_pct: maxLoss > 0 ? round2((scenarioPnl / maxLoss) * 100) : 0,
    pricing_models_used: [...pricingModelsUsed], warnings: [...warnings], leg_results: legResults,
  };
}

/**
 * Step 10/26 — CRR-shadow equivalent of strategyScenarios.generateCandidateScenarioResults.
 * `marketInputByExpiration`: Map<expiration string, market input record>
 * (Phase 2C's buildMarketInputRecord output) — one record per expiration,
 * per Phase 2B.1 Step 1's "never pool across expirations" discipline.
 */
export function generateCandidateScenarioResultsCrrShadow(candidate, scenarios, contractsByTicker, cfg) {
  return { ...candidate, scenario_results: scenarios.map(scenario => repriceCandidateScenarioCrrShadow(candidate, scenario, contractsByTicker, cfg)) };
}

// --- Step 16-17: model disagreement metric ----------------------------------

export const DISAGREEMENT_LEVELS = Object.freeze({ LOW: 'MODEL_DISAGREEMENT_LOW', MEDIUM: 'MODEL_DISAGREEMENT_MEDIUM', HIGH: 'MODEL_DISAGREEMENT_HIGH' });

/**
 * Step 16 — normalized disagreement, explicitly NOT called "model error"
 * (there is no ground-truth future price). Step 17's frozen thresholds:
 * LOW <=10% of max_loss, MEDIUM >10% and <=25%, HIGH >25%.
 */
export function computeModelDisagreement(localGreekPnl, crrShadowPnl, maxLoss, { epsilon = 1 } = {}) {
  const denom = Math.max(Math.abs(maxLoss), epsilon);
  const pct = (Math.abs(crrShadowPnl - localGreekPnl) / denom) * 100;
  let level;
  if (pct <= 10) level = DISAGREEMENT_LEVELS.LOW;
  else if (pct <= 25) level = DISAGREEMENT_LEVELS.MEDIUM;
  else level = DISAGREEMENT_LEVELS.HIGH;
  return { model_disagreement_pct_of_risk: round2(pct), level };
}
