// Phase 0C — deterministic strategy ranking. Pure, no I/O, no AI.
//
// Answers only: "given the user's explicit downside/base/upside scenarios,
// which valid candidates have the most attractive economics?" It does NOT
// answer "what will happen" or "what is the probability this trade wins."
//
// SCORE vs CONFIDENCE are kept strictly separate (Phase 0C Step 1): score
// measures economic attractiveness under the supplied scenarios; confidence
// measures how much to trust that score given scenario-model warnings,
// execution/data quality, and chain completeness. Confidence NEVER reduces
// score — see score_disclaimer on the output.

import {
  STRATEGY_TYPES, CONFIDENCE_LEVELS, RANKING_CLASSES, DECISION_STATES,
  REWARD_RISK_TYPES, RANKING_MODEL_VERSION, RANKING_REJECTION_REASONS,
} from './strategyTypes.js';

const round2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const COMPONENT_WEIGHTS = Object.freeze({ base: 0.35, downside: 0.25, upside: 0.20, breakeven: 0.15, execution: 0.05 });

const MAJOR_SCENARIO_WARNINGS = new Set(['LARGE_TIME_STEP', 'NEAR_EXPIRATION']);
const MODERATE_SCENARIO_WARNINGS = new Set(['LARGE_SPOT_MOVE', 'LARGE_IV_CHANGE', 'INTRINSIC_FLOOR_APPLIED']);

const BULLISH_TYPES = new Set([STRATEGY_TYPES.LONG_CALL, STRATEGY_TYPES.BULL_CALL_SPREAD, STRATEGY_TYPES.BUY_STOCK]);
const BEARISH_TYPES = new Set([STRATEGY_TYPES.LONG_PUT, STRATEGY_TYPES.BEAR_PUT_SPREAD]);
const CAPPED_REWARD_RISK_APPLICABLE = new Set([STRATEGY_TYPES.BULL_CALL_SPREAD, STRATEGY_TYPES.BEAR_PUT_SPREAD]);

const CONFIDENCE_RANK = { [CONFIDENCE_LEVELS.HIGH]: 3, [CONFIDENCE_LEVELS.MEDIUM]: 2, [CONFIDENCE_LEVELS.LOW]: 1 };
const minConfidence = (...levels) => levels.reduce((min, l) => (CONFIDENCE_RANK[l] < CONFIDENCE_RANK[min] ? l : min));
const confidenceAtLeast = (level, threshold) => CONFIDENCE_RANK[level] >= CONFIDENCE_RANK[threshold];

function validateRankingContext(context) {
  const { downside_scenario_id: d, base_scenario_id: b, upside_scenario_id: u } = context;
  for (const [name, v] of [['downside_scenario_id', d], ['base_scenario_id', b], ['upside_scenario_id', u]]) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`Invalid ranking context: ${name} is required and must be a non-empty string. Ranking unavailable without an explicit scenario role mapping.`);
    }
  }
}

function findScenarioResult(candidate, scenarioId) {
  return candidate.scenario_results?.find(sr => sr.scenario_id === scenarioId) ?? null;
}

// --- Component score transforms (Step 6) ------------------------------------

function baseScore(baseRorPct) {
  return clamp(50 + baseRorPct / 2, 0, 100);
}

function downsideScore(downsidePnl, maxLoss) {
  if (!(maxLoss > 0)) return 100; // no loss possible by construction
  const lossFraction = Math.abs(Math.min(downsidePnl, 0)) / maxLoss;
  return 100 * clamp(1 - lossFraction, 0, 1);
}

function upsideScore(upsideRorPct) {
  if (upsideRorPct <= 0) return 0;
  return clamp(upsideRorPct / 2, 0, 100);
}

function breakevenScore(breakevenMarginPct) {
  if (breakevenMarginPct == null) return null;
  return clamp(50 + breakevenMarginPct * 5, 0, 100);
}

function executionScore(maxLegSpreadPct, configuredMaxSpreadPct) {
  if (maxLegSpreadPct == null) return 100; // BUY_STOCK / not applicable
  if (!(configuredMaxSpreadPct > 0)) return 100;
  return 100 * clamp(1 - maxLegSpreadPct / configuredMaxSpreadPct, 0, 1);
}

function gradeOf(score) {
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

// --- Raw metrics (Step 3-5) --------------------------------------------------

function computeMaxLegSpreadPct(candidate, contractsByTicker) {
  if (candidate.strategy_type === STRATEGY_TYPES.BUY_STOCK || candidate.strategy_type === STRATEGY_TYPES.NO_TRADE) return null;
  let worst = null;
  for (const leg of candidate.legs) {
    const src = contractsByTicker.get(leg.contract);
    const pct = src?.spread_pct;
    if (pct != null && (worst == null || pct > worst)) worst = pct;
  }
  return worst;
}

function computeRewardRisk(candidate) {
  if (candidate.strategy_type === STRATEGY_TYPES.BUY_STOCK) {
    return { reward_risk_ratio: null, reward_risk_type: REWARD_RISK_TYPES.UNDERLYING_BASELINE };
  }
  if (candidate.max_profit_type === 'UNLIMITED') {
    return { reward_risk_ratio: null, reward_risk_type: REWARD_RISK_TYPES.UNBOUNDED_UPSIDE };
  }
  const ratio = candidate.max_loss > 0 ? candidate.max_profit / candidate.max_loss : null;
  return { reward_risk_ratio: ratio, reward_risk_type: REWARD_RISK_TYPES.DEFINED };
}

function computeScenarioAsymmetry(upsidePnl, downsidePnl) {
  if (upsidePnl > 0 && downsidePnl < 0) return upsidePnl / Math.abs(downsidePnl);
  return null;
}

function computeBreakevenMarginPct(candidate, currentSpot, baseSpot) {
  if (candidate.strategy_type === STRATEGY_TYPES.NO_TRADE) return null;
  if (candidate.breakeven == null) return null;
  if (BULLISH_TYPES.has(candidate.strategy_type)) {
    return ((baseSpot - candidate.breakeven) / currentSpot) * 100;
  }
  if (BEARISH_TYPES.has(candidate.strategy_type)) {
    return ((candidate.breakeven - baseSpot) / currentSpot) * 100;
  }
  return null;
}

// --- Confidence (Steps 8-10) -------------------------------------------------

function scenarioModelConfidence(candidate, requiredResults) {
  if (candidate.strategy_type === STRATEGY_TYPES.BUY_STOCK || candidate.strategy_type === STRATEGY_TYPES.NO_TRADE) {
    return { level: CONFIDENCE_LEVELS.HIGH, reasons: [] };
  }
  const reasons = [];
  let hasMajor = false, hasModerate = false;
  for (const { role, sr } of requiredResults) {
    for (const w of sr.warnings ?? []) {
      if (MAJOR_SCENARIO_WARNINGS.has(w)) { hasMajor = true; reasons.push(`${w} (${role})`); }
      else if (MODERATE_SCENARIO_WARNINGS.has(w)) { hasModerate = true; reasons.push(`${w} (${role})`); }
    }
  }
  const level = hasMajor ? CONFIDENCE_LEVELS.LOW : hasModerate ? CONFIDENCE_LEVELS.MEDIUM : CONFIDENCE_LEVELS.HIGH;
  return { level, reasons: [...new Set(reasons)] };
}

function executionDataConfidence(candidate, maxLegSpreadPct, configuredMaxSpreadPct) {
  if (candidate.strategy_type === STRATEGY_TYPES.BUY_STOCK || candidate.strategy_type === STRATEGY_TYPES.NO_TRADE) {
    return { level: CONFIDENCE_LEVELS.HIGH, reasons: [] };
  }
  if (maxLegSpreadPct == null) return { level: CONFIDENCE_LEVELS.LOW, reasons: ['MISSING_SPREAD_DATA'] };
  if (maxLegSpreadPct <= 5) return { level: CONFIDENCE_LEVELS.HIGH, reasons: [] };
  if (maxLegSpreadPct <= 10) return { level: CONFIDENCE_LEVELS.MEDIUM, reasons: [`max_leg_spread_pct=${maxLegSpreadPct}`] };
  return { level: CONFIDENCE_LEVELS.LOW, reasons: [`max_leg_spread_pct=${maxLegSpreadPct} exceeds 10%`] };
}

function universeConfidence(chainCompleteness) {
  if (chainCompleteness === 'POSSIBLY_TRUNCATED') {
    return { level: CONFIDENCE_LEVELS.MEDIUM, reasons: ['CHAIN_POSSIBLY_TRUNCATED'] };
  }
  return { level: CONFIDENCE_LEVELS.HIGH, reasons: [] };
}

// --- Per-candidate ranking ----------------------------------------------------

function rankOneCandidate(candidate, ctx, contractsByTicker, thresholds) {
  const { downside_scenario_id: downId, base_scenario_id: baseId, upside_scenario_id: upId } = ctx;

  if (candidate.strategy_type === STRATEGY_TYPES.NO_TRADE) {
    return {
      candidate_id: candidate.candidate_id,
      strategy_type: candidate.strategy_type,
      ranking_class: RANKING_CLASSES.BASELINE,
      score: null,
      grade: null,
      consideration_eligible: true,
      consideration_reasons: [],
      confidence: CONFIDENCE_LEVELS.HIGH,
      confidence_components: {
        scenario_model_confidence: CONFIDENCE_LEVELS.HIGH,
        execution_data_confidence: CONFIDENCE_LEVELS.HIGH,
        universe_confidence: CONFIDENCE_LEVELS.HIGH,
      },
      confidence_reasons: [],
      raw_metrics: null,
      component_scores: null,
      component_weights: null,
    };
  }

  const downsideSr = findScenarioResult(candidate, downId);
  const baseSr = findScenarioResult(candidate, baseId);
  const upsideSr = findScenarioResult(candidate, upId);

  const missing = [downsideSr, baseSr, upsideSr].some(sr => sr == null || sr.available === false);
  if (missing) {
    return {
      candidate_id: candidate.candidate_id,
      strategy_type: candidate.strategy_type,
      ranking_class: candidate.strategy_type === STRATEGY_TYPES.BUY_STOCK ? RANKING_CLASSES.UNDERLYING_BASELINE : RANKING_CLASSES.TRADE,
      score: null,
      grade: null,
      consideration_eligible: false,
      consideration_reasons: [RANKING_REJECTION_REASONS.SCENARIO_DATA_UNAVAILABLE],
      confidence: null,
      confidence_components: null,
      confidence_reasons: [RANKING_REJECTION_REASONS.SCENARIO_DATA_UNAVAILABLE],
      raw_metrics: null,
      component_scores: null,
      component_weights: null,
      rankable: false,
    };
  }

  const currentSpot = ctx.current_underlying_price;
  const baseSpot = baseSr.underlying_price;

  const downsidePnl = downsideSr.scenario_pnl;
  const basePnl = baseSr.scenario_pnl;
  const upsidePnl = upsideSr.scenario_pnl;
  const downsideRor = downsideSr.scenario_return_on_risk_pct;
  const baseRor = baseSr.scenario_return_on_risk_pct;
  const upsideRor = upsideSr.scenario_return_on_risk_pct;

  const { reward_risk_ratio: rewardRiskRatio, reward_risk_type: rewardRiskType } = computeRewardRisk(candidate);

  // Step 12: optional hard gate, disabled by default, applies only to spreads.
  if (thresholds.min_capped_reward_risk != null && CAPPED_REWARD_RISK_APPLICABLE.has(candidate.strategy_type)) {
    if (rewardRiskRatio == null || rewardRiskRatio < thresholds.min_capped_reward_risk) {
      return {
        candidate_id: candidate.candidate_id,
        strategy_type: candidate.strategy_type,
        ranking_class: RANKING_CLASSES.TRADE,
        score: null,
        grade: null,
        consideration_eligible: false,
        consideration_reasons: [RANKING_REJECTION_REASONS.CAPPED_REWARD_RISK_BELOW_MINIMUM],
        confidence: null,
        confidence_components: null,
        confidence_reasons: [],
        raw_metrics: { reward_risk_ratio: rewardRiskRatio, reward_risk_type: rewardRiskType },
        component_scores: null,
        component_weights: null,
        gated: true,
      };
    }
  }

  const maxLegSpreadPct = computeMaxLegSpreadPct(candidate, contractsByTicker);
  const breakevenMarginPct = computeBreakevenMarginPct(candidate, currentSpot, baseSpot);
  const scenarioAsymmetryRatio = computeScenarioAsymmetry(upsidePnl, downsidePnl);

  const componentScores = {
    base: baseScore(baseRor),
    downside: downsideScore(downsidePnl, candidate.max_loss),
    upside: upsideScore(upsideRor),
    breakeven: breakevenScore(breakevenMarginPct) ?? 50, // neutral if not applicable
    execution: executionScore(maxLegSpreadPct, thresholds.configured_max_spread_pct),
  };

  const score = COMPONENT_WEIGHTS.base * componentScores.base
    + COMPONENT_WEIGHTS.downside * componentScores.downside
    + COMPONENT_WEIGHTS.upside * componentScores.upside
    + COMPONENT_WEIGHTS.breakeven * componentScores.breakeven
    + COMPONENT_WEIGHTS.execution * componentScores.execution;

  const grade = gradeOf(score);

  const requiredResults = [
    { role: 'downside', sr: downsideSr },
    { role: 'base', sr: baseSr },
    { role: 'upside', sr: upsideSr },
  ];
  const scenarioConf = scenarioModelConfidence(candidate, requiredResults);
  const executionConf = executionDataConfidence(candidate, maxLegSpreadPct, thresholds.configured_max_spread_pct);
  const universeConf = universeConfidence(ctx.chain_completeness);
  const overallConfidence = minConfidence(scenarioConf.level, executionConf.level, universeConf.level);
  const confidenceReasons = [...scenarioConf.reasons, ...executionConf.reasons, ...universeConf.reasons];

  const considerationReasons = [];
  if (score < thresholds.minimum_score_for_consideration) considerationReasons.push(RANKING_REJECTION_REASONS.SCORE_BELOW_THRESHOLD);
  if (!confidenceAtLeast(overallConfidence, thresholds.minimum_confidence_for_consideration)) considerationReasons.push(RANKING_REJECTION_REASONS.CONFIDENCE_BELOW_THRESHOLD);
  const considerationEligible = considerationReasons.length === 0;

  return {
    candidate_id: candidate.candidate_id,
    strategy_type: candidate.strategy_type,
    ranking_class: candidate.strategy_type === STRATEGY_TYPES.BUY_STOCK ? RANKING_CLASSES.UNDERLYING_BASELINE : RANKING_CLASSES.TRADE,
    score: round2(score),
    grade,
    consideration_eligible: considerationEligible,
    consideration_reasons: considerationReasons,
    confidence: overallConfidence,
    confidence_components: {
      scenario_model_confidence: scenarioConf.level,
      execution_data_confidence: executionConf.level,
      universe_confidence: universeConf.level,
    },
    confidence_reasons: [...new Set(confidenceReasons)],
    raw_metrics: {
      downside_pnl: downsidePnl,
      base_pnl: basePnl,
      upside_pnl: upsidePnl,
      downside_return_on_risk_pct: downsideRor,
      base_return_on_risk_pct: baseRor,
      upside_return_on_risk_pct: upsideRor,
      max_loss: candidate.max_loss,
      capital_required: candidate.capital_required,
      breakeven: candidate.breakeven,
      reward_risk_ratio: rewardRiskRatio == null ? null : round2(rewardRiskRatio),
      reward_risk_type: rewardRiskType,
      scenario_asymmetry_ratio: scenarioAsymmetryRatio == null ? null : round2(scenarioAsymmetryRatio),
      breakeven_margin_pct: breakevenMarginPct == null ? null : round2(breakevenMarginPct),
      max_leg_spread_pct: maxLegSpreadPct,
    },
    component_scores: {
      base: round2(componentScores.base),
      downside: round2(componentScores.downside),
      upside: round2(componentScores.upside),
      breakeven: round2(componentScores.breakeven),
      execution: round2(componentScores.execution),
    },
    component_weights: { ...COMPONENT_WEIGHTS },
  };
}

/**
 * Ranks scenario-enriched Phase 0A/0B candidates using RANKING_MODEL_V1.
 *
 * @param {object[]} enrichedCandidates - output of generateCandidateScenarioResults, one per candidate
 * @param {object} rankingContext - { downside_scenario_id, base_scenario_id, upside_scenario_id, current_underlying_price, chain_completeness, configured_max_spread_pct }
 * @param {Map<string,object>} contractsByTicker - original chain contracts, for leg spread lookups
 * @param {object} [options] - { minimum_score_for_consideration=60, minimum_confidence_for_consideration='MEDIUM', min_capped_reward_risk=null }
 */
export function rankStrategyCandidates(enrichedCandidates, rankingContext, contractsByTicker, options = {}) {
  validateRankingContext(rankingContext);

  const thresholds = {
    minimum_score_for_consideration: options.minimum_score_for_consideration ?? 60,
    minimum_confidence_for_consideration: options.minimum_confidence_for_consideration ?? CONFIDENCE_LEVELS.MEDIUM,
    min_capped_reward_risk: options.min_capped_reward_risk ?? null,
    configured_max_spread_pct: rankingContext.configured_max_spread_pct ?? 15,
  };

  const results = enrichedCandidates.map(c => rankOneCandidate(c, rankingContext, contractsByTicker, thresholds));

  const baselines = results.filter(r => r.ranking_class === RANKING_CLASSES.BASELINE);
  const gateRejections = results.filter(r => r.gated).map(r => ({ candidate_id: r.candidate_id, reason: r.consideration_reasons[0] }));
  const ranked = results.filter(r => r.ranking_class !== RANKING_CLASSES.BASELINE && !r.gated);

  // Step 15: deterministic sort.
  ranked.sort((a, b) => {
    if (a.consideration_eligible !== b.consideration_eligible) return a.consideration_eligible ? -1 : 1;
    const scoreA = a.score ?? -Infinity, scoreB = b.score ?? -Infinity;
    if (scoreA !== scoreB) return scoreB - scoreA;
    const confA = a.confidence ? CONFIDENCE_RANK[a.confidence] : 0;
    const confB = b.confidence ? CONFIDENCE_RANK[b.confidence] : 0;
    if (confA !== confB) return confB - confA;
    return a.candidate_id < b.candidate_id ? -1 : a.candidate_id > b.candidate_id ? 1 : 0;
  });

  ranked.forEach((r, i) => { r.rank = i + 1; });

  const topEligible = ranked.find(r => r.consideration_eligible);
  const decisionState = topEligible ? DECISION_STATES.TRADE_CANDIDATES_AVAILABLE : DECISION_STATES.NO_TRADE_BASELINE_ONLY;

  return {
    ranking_model: RANKING_MODEL_VERSION,
    score_disclaimer: 'Comparative heuristic score under user-supplied scenarios; not probability or expected return.',
    ranking_context: rankingContext,
    thresholds,
    decision_state: decisionState,
    top_trade_candidate_id: topEligible ? topEligible.candidate_id : null,
    fallback_baseline: 'NO_TRADE',
    ranked_candidates: ranked,
    baselines,
    gate_rejections: gateRejections,
  };
}
