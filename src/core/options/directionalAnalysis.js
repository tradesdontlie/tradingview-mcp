// Phase 1A — directional options analysis orchestrator.
//
// This module is the ORCHESTRATION layer: it is allowed to import
// TradingView-facing code (options_get_chain, getKeyStats) because it is
// not part of the pure strategy domain. The pure modules it calls
// (strategyCandidates, strategyScenarios, strategyRanking) must never import
// anything from this file or from connection.js/CDP — that separation is
// what lets a future non-TradingView data provider reuse the same math.
//
// This orchestrator contains NO AI/LLM logic, generates NO narrative, and
// invents NO market assumptions beyond the documented, deterministic helper
// formulas below (which are always labeled DETERMINISTIC_ASSUMPTION/
// DETERMINISTIC_HELPER, never silently presented as fact).

import { createHash } from 'node:crypto';
import * as _data from '../data.js';
import { generateStrategyCandidates as _generateStrategyCandidates } from './strategyCandidates.js';
import { generateCandidateScenarioResults as _generateCandidateScenarioResults } from './strategyScenarios.js';
import { rankStrategyCandidates as _rankStrategyCandidates } from './strategyRanking.js';
import { generateCandidateScenarioResultsCrrShadow as _generateCandidateScenarioResultsCrrShadow } from './marketInputs/crrShadowScenario.js';
import { evaluateHybridCrrPolicy as _evaluateHybridCrrPolicy } from './marketInputs/hybridCrrPolicy.js';
import { buildTradingViewCrrShadowMarketInputs as _buildCrrShadowMarketInputs } from './marketInputs/tradingViewCrrShadowMarketInputs.js';

const round2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

const DEFAULT_MAX_RANKED_RESULTS = 10;
const HARD_MAX_RANKED_RESULTS = 25;
const NEAR_MISS_LIMIT = 5;
const DEFAULT_MAX_DTE_PADDING = 45;

// ---------------------------------------------------------------------------
// Step 2/5/6 — input validation
// ---------------------------------------------------------------------------

function validateRequiredInputs(req) {
  const { symbol, direction, horizon_days: horizonDays, max_loss: maxLoss, base_target_price: baseTarget } = req;

  if (typeof symbol !== 'string' || symbol.trim() === '') {
    throw new Error('Invalid symbol. An exchange-qualified symbol (e.g. "NASDAQ:NVDA") is required.');
  }
  if (direction !== 'bullish' && direction !== 'bearish') {
    throw new Error(`Invalid direction "${direction}". Must be "bullish" or "bearish".`);
  }
  if (!Number.isFinite(horizonDays) || horizonDays < 0) {
    throw new Error(`Invalid horizon_days "${horizonDays}". Must be a non-negative number.`);
  }
  if (!Number.isFinite(maxLoss) || maxLoss <= 0) {
    throw new Error(`Invalid max_loss "${maxLoss}". Must be a positive number.`);
  }
  if (!Number.isFinite(baseTarget) || baseTarget <= 0) {
    throw new Error('Invalid or missing base_target_price. This must be supplied explicitly — the engine will not silently assume current spot, an analyst target, a technical target, or an AI-generated target.');
  }
}

function validateThesisDirection(direction, baseTarget, currentSpot) {
  if (direction === 'bullish' && baseTarget <= currentSpot) {
    throw new Error(`TARGET_DIRECTION_MISMATCH: bullish direction requires base_target_price (${baseTarget}) > current spot (${currentSpot}). Refusing to silently proceed with an inconsistent thesis.`);
  }
  if (direction === 'bearish' && baseTarget >= currentSpot) {
    throw new Error(`TARGET_DIRECTION_MISMATCH: bearish direction requires base_target_price (${baseTarget}) < current spot (${currentSpot}). Refusing to silently proceed with an inconsistent thesis.`);
  }
}

function resolveExpirationWindow(req) {
  const horizonDays = req.horizon_days;
  const minDte = req.min_dte != null ? Math.max(horizonDays, req.min_dte) : horizonDays;
  const maxDte = req.max_dte != null ? req.max_dte : horizonDays + DEFAULT_MAX_DTE_PADDING;
  if (maxDte < minDte) {
    throw new Error(`Invalid expiration window: max_dte (${maxDte}) must be >= min_dte (${minDte}).`);
  }
  return { minDte, maxDte };
}

function resolveMaxRankedResults(value) {
  const n = value ?? DEFAULT_MAX_RANKED_RESULTS;
  if (!Number.isFinite(n) || n < 1) throw new Error(`Invalid max_ranked_results "${value}". Must be a positive integer.`);
  if (n > HARD_MAX_RANKED_RESULTS) throw new Error(`max_ranked_results ${n} exceeds the hard maximum of ${HARD_MAX_RANKED_RESULTS}.`);
  return n;
}

// ---------------------------------------------------------------------------
// Step 3/4 — scenario construction
// ---------------------------------------------------------------------------

/**
 * Builds the three role-based scenario target prices (Step 3). DOWNSIDE
 * means "unfavorable outcome" and UPSIDE means "favorable outcome" — NOT
 * necessarily lower/higher numerical price; direction determines which side
 * is which.
 */
function resolveScenarioTargets(req, currentSpot) {
  const baseTarget = req.base_target_price;
  const expectedMove = baseTarget - currentSpot;
  const absMove = Math.abs(expectedMove);

  let downside, downsideSource;
  if (req.downside_target_price != null) {
    downside = req.downside_target_price;
    downsideSource = 'USER_EXPLICIT';
  } else {
    downside = req.direction === 'bullish' ? currentSpot - 0.5 * absMove : currentSpot + 0.5 * absMove;
    downsideSource = 'DETERMINISTIC_HELPER';
  }

  let upside, upsideSource;
  if (req.upside_target_price != null) {
    upside = req.upside_target_price;
    upsideSource = 'USER_EXPLICIT';
  } else {
    upside = req.direction === 'bullish' ? baseTarget + 0.5 * absMove : baseTarget - 0.5 * absMove;
    upsideSource = 'DETERMINISTIC_HELPER';
  }

  return {
    expectedMove, absMove,
    downside: round2(downside), downsideSource,
    base: round2(baseTarget), baseSource: 'USER_EXPLICIT',
    upside: round2(upside), upsideSource,
  };
}

function resolveIvShocks(req) {
  const provided = req.downside_iv_change_points != null || req.base_iv_change_points != null || req.upside_iv_change_points != null;
  return {
    downside: req.downside_iv_change_points ?? 0,
    base: req.base_iv_change_points ?? 0,
    upside: req.upside_iv_change_points ?? 0,
    warningNeeded: !provided,
  };
}

// ---------------------------------------------------------------------------
// Step 8 — deterministic snapshot id
// ---------------------------------------------------------------------------

function buildSnapshotId(parts) {
  const canonical = JSON.stringify(parts, Object.keys(parts).sort());
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Step 14 — leg/candidate detail assembly
// ---------------------------------------------------------------------------

function buildLegDetail(leg, contractsByTicker) {
  if (leg.contract == null) {
    // BUY_STOCK's synthetic "leg" — shares, not an option contract.
    return { role: leg.role, action: leg.role === 'long' ? 'BUY' : 'SELL', shares: leg.shares };
  }
  const src = contractsByTicker.get(leg.contract);
  return {
    contract: leg.contract,
    action: leg.role === 'long' ? 'BUY' : 'SELL',
    option_type: leg.option_type,
    strike: leg.strike,
    fill_price: leg.fill_price,
    bid: src?.bid ?? null,
    ask: src?.ask ?? null,
    spread_pct: src?.spread_pct ?? null,
    iv: src?.iv ?? null,
    delta: src?.delta ?? null,
    gamma: src?.gamma ?? null,
    theta: src?.theta ?? null,
    vega: src?.vega ?? null,
  };
}

function buildScenarioSummary(enrichedCandidate, scenarioId, ivPointsRequested) {
  const sr = enrichedCandidate.scenario_results.find(s => s.scenario_id === scenarioId);
  if (!sr) return null;
  return {
    underlying_price: sr.underlying_price,
    iv_change_points_requested: ivPointsRequested,
    available: sr.available,
    scenario_pnl: sr.scenario_pnl,
    scenario_return_on_risk_pct: sr.scenario_return_on_risk_pct,
    pricing_models_used: sr.pricing_models_used,
    warnings: sr.warnings,
  };
}

function buildTopCandidateEntry(rankedEntry, enrichedCandidate, contractsByTicker, ivShocks) {
  return {
    candidate_id: rankedEntry.candidate_id,
    rank: rankedEntry.rank,
    strategy_type: rankedEntry.strategy_type,
    ranking_class: rankedEntry.ranking_class,
    expiration: enrichedCandidate.expiration,
    days_to_expiry: enrichedCandidate.days_to_expiry,
    legs: enrichedCandidate.legs.map(leg => buildLegDetail(leg, contractsByTicker)),
    entry_debit: enrichedCandidate.entry_debit,
    capital_required: enrichedCandidate.capital_required,
    max_loss: enrichedCandidate.max_loss,
    max_profit: enrichedCandidate.max_profit,
    max_profit_type: enrichedCandidate.max_profit_type,
    breakeven: enrichedCandidate.breakeven,
    reward_risk_ratio: rankedEntry.raw_metrics?.reward_risk_ratio ?? null,
    reward_risk_type: rankedEntry.raw_metrics?.reward_risk_type ?? null,
    score: rankedEntry.score,
    grade: rankedEntry.grade,
    confidence: rankedEntry.confidence,
    confidence_reasons: rankedEntry.confidence_reasons,
    consideration_eligible: rankedEntry.consideration_eligible,
    consideration_reasons: rankedEntry.consideration_reasons,
    component_scores: rankedEntry.component_scores,
    raw_metrics: rankedEntry.raw_metrics,
    scenario_results: {
      downside: buildScenarioSummary(enrichedCandidate, 'DOWNSIDE', ivShocks.downside),
      base: buildScenarioSummary(enrichedCandidate, 'BASE', ivShocks.base),
      upside: buildScenarioSummary(enrichedCandidate, 'UPSIDE', ivShocks.upside),
    },
  };
}

// ---------------------------------------------------------------------------
// Step 15 — numeric provenance map (static, documented; not per-scalar inline)
// ---------------------------------------------------------------------------

function buildFieldProvenance(scenarioSources) {
  return {
    MARKET_NATIVE: ['bid', 'ask', 'iv', 'bid_iv', 'ask_iv', 'delta', 'gamma', 'theta', 'vega', 'rho', 'theoretical_price', 'underlying_price'],
    MARKET_DERIVED: ['spread_pct', 'mid', 'spread', 'iv_spread', 'fill_price'],
    ENGINE_CALCULATED: [
      'entry_debit', 'capital_required', 'max_loss', 'max_profit', 'breakeven', 'reward_risk_ratio',
      'scenario_pnl', 'scenario_return_on_risk_pct', 'estimated_value', 'score', 'grade', 'confidence',
      'component_scores', 'analysis_snapshot_id', 'diagnostics.crr_hybrid_policy',
    ],
    USER_INPUT: [
      'symbol', 'direction', 'horizon_days', 'max_loss (constraint)', 'base_target_price',
      ...(scenarioSources.downsideSource === 'USER_EXPLICIT' ? ['downside_target_price'] : []),
      ...(scenarioSources.upsideSource === 'USER_EXPLICIT' ? ['upside_target_price'] : []),
    ],
    DETERMINISTIC_ASSUMPTION: [
      'contract_multiplier (assumed 100 for standard US equity options)',
      ...(scenarioSources.downsideSource === 'DETERMINISTIC_HELPER' ? ['downside_target_price (helper-derived)'] : []),
      ...(scenarioSources.upsideSource === 'DETERMINISTIC_HELPER' ? ['upside_target_price (helper-derived)'] : []),
      ...(scenarioSources.ivWarningNeeded ? ['downside/base/upside iv_change_points (defaulted to 0 — no IV scenario specified)'] : []),
    ],
  };
}

const AI_CONTRACT_RULES = Object.freeze([
  'Do not invent option contracts.',
  'Do not invent prices.',
  'Do not recalculate Greeks.',
  'Do not recalculate max loss/profit.',
  'Do not alter scenario P&L.',
  'Do not state score as probability.',
  'Do not state delta as probability of profit.',
  'Do not claim consideration_eligible means recommendation.',
  'If no candidate is eligible, preserve that result — do not promote a near-miss into a recommendation.',
  'Explicitly mention LOW confidence when discussing a candidate.',
  'Mention important scenario warnings (e.g. LARGE_TIME_STEP, NEAR_EXPIRATION) when present.',
  'Do not treat crr_hybrid_policy diagnostics as a recommendation, score override, or production pricing switch.',
  'Do not infer volume or open interest. Open interest is currently unavailable. Volume is not used by this analysis (not a filtering/scoring/ranking input) even where it may be technically obtainable elsewhere as optional live enrichment.',
]);

const KNOWN_LIMITATIONS = Object.freeze([
  'Score is a heuristic comparative metric (RANKING_MODEL_V1), not a probability or expected return.',
  'Scenario repricing (LOCAL_GREEK_APPROXIMATION) is a local approximation, not a full option pricing model — see Phase 0B limitations.',
  'Ranking depends entirely on the user-supplied scenario prices; different assumptions produce different rankings.',
  'Open interest is currently unavailable. Volume (technically obtainable via TradingView WebSocket subscription, but UI/subscription-dependent and event-driven, not a guaranteed initial snapshot) is not a dependency of this tool — neither volume nor open interest is used in filtering, scoring, or ranking.',
  'No historical calibration of scoring weights or thresholds.',
  'No earnings/event-driven volatility model — IV shocks default to 0 unless explicitly supplied.',
  'No portfolio-level risk (correlation, margin, concentration) is modeled.',
  'No early-exercise/assignment or dividend/ex-dividend modeling.',
  'The scan2 request may be capped by TradingView at 4000 rows for very large chains; chain_completeness/warnings surface this, but the DTE window does not currently reduce the underlying request size.',
  'No AI/LLM reasoning is performed by this tool — it returns structured, deterministic data only.',
]);

// ---------------------------------------------------------------------------
// Phase 2D.2 — guarded CRR hybrid diagnostics
// ---------------------------------------------------------------------------

function candidateIdsFromTopAndNearMisses(rankingResult, maxRankedResults) {
  const topIds = rankingResult.ranked_candidates.slice(0, maxRankedResults).map(c => c.candidate_id);
  const nearMissIds = rankingResult.decision_state === 'NO_TRADE_BASELINE_ONLY'
    ? rankingResult.ranked_candidates.filter(c => !c.consideration_eligible).slice(0, NEAR_MISS_LIMIT).map(c => c.candidate_id)
    : [];
  return [...new Set([...topIds, ...nearMissIds])];
}

function summarizeMarketInputs(marketInputByExpiration) {
  if (!marketInputByExpiration) return [];
  return [...marketInputByExpiration.values()].map(r => ({
    expiration: r.expiration,
    days_to_expiry: r.days_to_expiry,
    mode: r.mode,
    overall_confidence: r.overall_confidence,
    discount_rate_source: r.discount_rate_source,
    dividend_mode: r.dividend_input?.mode ?? null,
    borrow_source: r.borrow_input?.source ?? null,
    warnings: r.warnings ?? [],
  }));
}

async function buildCrrHybridDiagnostics({
  req,
  deps,
  currentSpot,
  keyStats,
  chainResp,
  contractsByTicker,
  candidatesResult,
  enrichedCandidates,
  rankingResult,
  rankingContext,
  scenarios,
  contractMultiplier,
  maxRankedResults,
}) {
  if (!req.include_crr_hybrid_diagnostics) {
    return {
      status: 'NOT_REQUESTED',
      mode: 'DIAGNOSTIC_ONLY_NO_RANKING_CHANGE',
    };
  }

  // Phase 2D.3 — defaults to the non-IBKR TradingView+Treasury-fallback
  // builder (tradingViewCrrShadowMarketInputs.js) unless a test/deps
  // override supplies a different provider. Still fully opt-in: this
  // branch only runs when include_crr_hybrid_diagnostics is true, and its
  // output only ever reaches diagnostics.crr_hybrid_policy.
  const buildCrrShadowMarketInputs = deps.buildCrrShadowMarketInputs ?? _buildCrrShadowMarketInputs;
  if (typeof buildCrrShadowMarketInputs !== 'function') {
    return {
      status: 'UNAVAILABLE',
      mode: 'DIAGNOSTIC_ONLY_NO_RANKING_CHANGE',
      reason: 'CRR_SHADOW_MARKET_INPUT_PROVIDER_NOT_CONFIGURED',
    };
  }

  const expirations = [...new Map(candidatesResult.candidates
    .filter(c => c.expiration)
    .map(c => [c.expiration, c.days_to_expiry])).entries()]
    .map(([expiration, dte]) => ({ expiration, dte }));
  const marketInputByExpiration = await buildCrrShadowMarketInputs({
    symbol: req.symbol,
    root: req.symbol.split(':').at(-1),
    spot: currentSpot,
    keyStats,
    chainResp,
    expirations,
  });

  const generateCandidateScenarioResultsCrrShadow = deps.generateCandidateScenarioResultsCrrShadow ?? _generateCandidateScenarioResultsCrrShadow;
  const evaluateHybridCrrPolicy = deps.evaluateHybridCrrPolicy ?? _evaluateHybridCrrPolicy;
  const shadowEnriched = candidatesResult.candidates.map(c => generateCandidateScenarioResultsCrrShadow(c, scenarios, contractsByTicker, {
    contractMultiplier,
    currentUnderlyingPrice: currentSpot,
    marketInputByExpiration,
  }));
  const policy = evaluateHybridCrrPolicy(enrichedCandidates, shadowEnriched, { rankingContext });
  const allowedIds = new Set(candidateIdsFromTopAndNearMisses(rankingResult, maxRankedResults));

  return {
    status: 'AVAILABLE',
    mode: 'DIAGNOSTIC_ONLY_NO_RANKING_CHANGE',
    market_inputs: summarizeMarketInputs(marketInputByExpiration),
    summary: policy.summary,
    candidates: policy.candidates
      .filter(c => allowedIds.has(c.candidate_id))
      .map(c => ({
        candidate_id: c.candidate_id,
        strategy_type: c.strategy_type,
        action: c.action,
        reasons: c.reasons,
        local_warnings: c.local_warnings,
        max_model_disagreement_level: c.max_model_disagreement_level,
        crr_shadow_available: c.crr_shadow_available,
      })),
  };
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * @param {object} req - see src/tools/optionsAnalysis.js for the full field list
 * @param {object} [deps] - injectable dependencies for deterministic, network-free
 *   unit testing (mirrors the _deps pattern used in src/core/chart.js). Defaults
 *   to the real TradingView-backed implementations.
 */
export async function analyzeDirectional(req, deps = {}) {
  const getOptionChain = deps.getOptionChain ?? _data.getOptionChain;
  const getKeyStats = deps.getKeyStats ?? _data.getKeyStats;
  const generateStrategyCandidates = deps.generateStrategyCandidates ?? _generateStrategyCandidates;
  const generateCandidateScenarioResults = deps.generateCandidateScenarioResults ?? _generateCandidateScenarioResults;
  const rankStrategyCandidates = deps.rankStrategyCandidates ?? _rankStrategyCandidates;

  validateRequiredInputs(req);

  const executionModel = req.execution_model ?? 'conservative';
  const contractMultiplier = req.contract_multiplier ?? 100;
  const commissionPerContract = req.commission_per_contract ?? 0;
  const maxSpreadPct = req.max_spread_pct ?? 15;
  const maxRankedResults = resolveMaxRankedResults(req.max_ranked_results);
  const { minDte, maxDte } = resolveExpirationWindow(req);

  // Step 7 — current spot via the existing reliable non-chart-touching
  // mechanism (scanner /symbol fields), never option last price.
  const keyStats = await getKeyStats({ symbol: req.symbol });
  const currentSpot = keyStats.price;
  if (currentSpot == null) {
    throw new Error(`Could not determine current price for "${req.symbol}". Cannot construct scenarios without a current spot.`);
  }

  validateThesisDirection(req.direction, req.base_target_price, currentSpot);

  const scenarioTargets = resolveScenarioTargets(req, currentSpot);
  const ivShocks = resolveIvShocks(req);

  // Step 7 — bounded chain request (does not eliminate the scan2 4000-row
  // cap risk in the current options_get_chain implementation — see limitations).
  const chainResp = await getOptionChain({ symbol: req.symbol, min_dte: minDte, max_dte: maxDte, max_results: 500 });

  const analysisAsOfUtc = new Date().toISOString();
  const snapshotId = buildSnapshotId({
    symbol: chainResp.symbol,
    underlying_price: currentSpot,
    options_retrieved_at_utc: chainResp.retrieved_at_utc,
    direction: req.direction,
    horizon_days: req.horizon_days,
    max_loss: req.max_loss,
    base_target_price: req.base_target_price,
    downside_target_price: scenarioTargets.downside,
    upside_target_price: scenarioTargets.upside,
    iv_shocks: ivShocks,
    min_dte: minDte,
    max_dte: maxDte,
    execution_model: executionModel,
    commission_per_contract: commissionPerContract,
    contract_multiplier: contractMultiplier,
  });

  const chainSnapshot = {
    underlying: chainResp.symbol,
    underlying_price: currentSpot,
    chain_completeness: chainResp.chain_completeness,
    contracts: chainResp.contracts,
  };
  const contractsByTicker = new Map(chainResp.contracts.map(c => [c.contract, c]));

  // Step 9 — Phase 0A candidate generation.
  const candidatesResult = generateStrategyCandidates(chainSnapshot, {
    direction: req.direction,
    underlying_price: currentSpot,
    horizon_days: req.horizon_days,
    max_loss: req.max_loss,
    max_spread_pct: maxSpreadPct,
    min_long_delta: req.min_long_delta,
    max_long_delta: req.max_long_delta,
    max_vertical_width: req.max_vertical_width,
    execution_model: executionModel,
    commission_per_contract: commissionPerContract,
    contract_multiplier: contractMultiplier,
  });

  // Step 10 — exactly three role-based scenarios, Phase 0B repricing.
  const scenarios = [
    { scenario_id: 'DOWNSIDE', underlying_price: scenarioTargets.downside, days_forward: req.horizon_days, iv_change_points: ivShocks.downside },
    { scenario_id: 'BASE', underlying_price: scenarioTargets.base, days_forward: req.horizon_days, iv_change_points: ivShocks.base },
    { scenario_id: 'UPSIDE', underlying_price: scenarioTargets.upside, days_forward: req.horizon_days, iv_change_points: ivShocks.upside },
  ];
  const enrichedCandidates = candidatesResult.candidates.map(c =>
    generateCandidateScenarioResults(c, scenarios, contractsByTicker, { contractMultiplier, currentUnderlyingPrice: currentSpot }));
  const enrichedByCandidateId = new Map(enrichedCandidates.map(c => [c.candidate_id, c]));

  // Step 11 — Phase 0C ranking.
  const rankingContext = {
    downside_scenario_id: 'DOWNSIDE',
    base_scenario_id: 'BASE',
    upside_scenario_id: 'UPSIDE',
    current_underlying_price: currentSpot,
    chain_completeness: chainResp.chain_completeness,
    configured_max_spread_pct: maxSpreadPct,
  };
  const rankingResult = rankStrategyCandidates(enrichedCandidates, rankingContext, contractsByTicker, {
    minimum_score_for_consideration: req.minimum_score_for_consideration,
    minimum_confidence_for_consideration: req.minimum_confidence_for_consideration,
    min_capped_reward_risk: req.min_capped_reward_risk,
  });

  const crrHybridDiagnostics = await buildCrrHybridDiagnostics({
    req,
    deps,
    currentSpot,
    keyStats,
    chainResp,
    contractsByTicker,
    candidatesResult,
    enrichedCandidates,
    rankingResult,
    rankingContext,
    scenarios,
    contractMultiplier,
    maxRankedResults,
  });

  // Step 12/14 — top N candidates, fully detailed.
  const topRanked = rankingResult.ranked_candidates.slice(0, maxRankedResults);
  const topCandidates = topRanked.map(entry =>
    buildTopCandidateEntry(entry, enrichedByCandidateId.get(entry.candidate_id), contractsByTicker, ivShocks));

  // Step 17 — near misses only when nothing is eligible.
  const nearMissCandidates = rankingResult.decision_state === 'NO_TRADE_BASELINE_ONLY'
    ? rankingResult.ranked_candidates.filter(c => !c.consideration_eligible).slice(0, NEAR_MISS_LIMIT).map(c => ({
      candidate_id: c.candidate_id,
      strategy_type: c.strategy_type,
      score: c.score,
      confidence: c.confidence,
      consideration_eligible: c.consideration_eligible,
      consideration_reasons: c.consideration_reasons,
    }))
    : [];

  // Step 18 — scenario/confidence quality summary across the full ranked universe.
  const scenarioQualitySummary = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const c of rankingResult.ranked_candidates) {
    if (c.confidence && scenarioQualitySummary[c.confidence] != null) scenarioQualitySummary[c.confidence]++;
  }

  const warnings = [...chainResp.warnings];
  if (ivShocks.warningNeeded) warnings.push('IV_SCENARIO_NOT_SPECIFIED');

  return {
    analysis_type: 'DIRECTIONAL_OPTIONS',
    analysis_snapshot_id: snapshotId,
    analysis_as_of_utc: analysisAsOfUtc,

    symbol: chainResp.symbol,
    underlying_price: currentSpot,

    direction: req.direction,
    horizon_days: req.horizon_days,
    max_loss: req.max_loss,

    thesis: {
      base_target_price: req.base_target_price,
      expected_move_absolute: round2(scenarioTargets.expectedMove),
      expected_move_pct: round2((scenarioTargets.expectedMove / currentSpot) * 100),
    },

    // Step 19 — exact normalized input echo.
    input_echo: {
      symbol: req.symbol,
      direction: req.direction,
      horizon_days: req.horizon_days,
      max_loss: req.max_loss,
      base_target_price: req.base_target_price,
      downside_target_price: req.downside_target_price ?? null,
      upside_target_price: req.upside_target_price ?? null,
      downside_iv_change_points: req.downside_iv_change_points ?? null,
      base_iv_change_points: req.base_iv_change_points ?? null,
      upside_iv_change_points: req.upside_iv_change_points ?? null,
      min_dte: req.min_dte ?? null,
      max_dte: req.max_dte ?? null,
      include_crr_hybrid_diagnostics: req.include_crr_hybrid_diagnostics ?? false,
      execution_model: executionModel,
      commission_per_contract: commissionPerContract,
      contract_multiplier: contractMultiplier,
      max_spread_pct: maxSpreadPct,
      max_ranked_results: maxRankedResults,
    },

    scenario_definitions: {
      downside: { scenario_id: 'DOWNSIDE', underlying_price: scenarioTargets.downside, iv_change_points: ivShocks.downside, days_forward: req.horizon_days, scenario_source: scenarioTargets.downsideSource },
      base: { scenario_id: 'BASE', underlying_price: scenarioTargets.base, iv_change_points: ivShocks.base, days_forward: req.horizon_days, scenario_source: scenarioTargets.baseSource },
      upside: { scenario_id: 'UPSIDE', underlying_price: scenarioTargets.upside, iv_change_points: ivShocks.upside, days_forward: req.horizon_days, scenario_source: scenarioTargets.upsideSource },
    },

    data_source: {
      provider: chainResp.source,
      endpoint: chainResp.source_endpoint,
      options_retrieved_at_utc: chainResp.retrieved_at_utc,
      chain_completeness: chainResp.chain_completeness,
      warnings,
    },

    candidate_generation: {
      input_contract_count: candidatesResult.input_contract_count,
      eligible_contract_count: candidatesResult.eligible_contract_count,
      candidate_count: candidatesResult.candidate_count,
      rejected_count: candidatesResult.rejected_count,
      rejection_summary: candidatesResult.rejection_summary,
    },

    ranking: {
      model: rankingResult.ranking_model,
      disclaimer: rankingResult.score_disclaimer,
      decision_state: rankingResult.decision_state,
      top_trade_candidate_id: rankingResult.top_trade_candidate_id,
      fallback_baseline: rankingResult.fallback_baseline,
      thresholds: rankingResult.thresholds,
    },

    scenario_quality_summary: {
      HIGH_CONFIDENCE_CANDIDATES: scenarioQualitySummary.HIGH,
      MEDIUM_CONFIDENCE_CANDIDATES: scenarioQualitySummary.MEDIUM,
      LOW_CONFIDENCE_CANDIDATES: scenarioQualitySummary.LOW,
    },

    diagnostics: {
      crr_hybrid_policy: crrHybridDiagnostics,
    },

    top_candidates: topCandidates,
    near_miss_candidates: nearMissCandidates,

    baselines: rankingResult.baselines.map(b => ({
      candidate_id: b.candidate_id,
      strategy_type: b.strategy_type,
      ranking_class: b.ranking_class,
      score: b.score,
      grade: b.grade,
      confidence: b.confidence,
      consideration_eligible: b.consideration_eligible,
    })),

    field_provenance: buildFieldProvenance({
      downsideSource: scenarioTargets.downsideSource,
      upsideSource: scenarioTargets.upsideSource,
      ivWarningNeeded: ivShocks.warningNeeded,
    }),

    ai_contract: {
      allowed_candidate_ids: [
        ...topCandidates.map(c => c.candidate_id),
        ...nearMissCandidates.map(c => c.candidate_id),
        ...rankingResult.baselines.map(b => b.candidate_id),
      ],
      numeric_source_of_truth: 'THIS_ANALYSIS_PACKET',
      rules: AI_CONTRACT_RULES,
    },

    limitations: KNOWN_LIMITATIONS,
  };
}
