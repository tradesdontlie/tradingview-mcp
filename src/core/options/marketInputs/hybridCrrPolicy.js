// Phase 2D — diagnostic hybrid CRR policy.
//
// This module does not change production ranking or scenario pricing. It
// classifies already-generated local-Greek and CRR-shadow scenario results so
// migration decisions stay explicit: keep local where it is behaving, escalate
// only the warning/disagreement regions where CRR has shown live diagnostic
// value.

import { STRATEGY_TYPES } from '../strategyTypes.js';
import { computeModelDisagreement, DISAGREEMENT_LEVELS } from './crrShadowScenario.js';

export const HYBRID_CRR_ACTIONS = Object.freeze({
  NO_ACTION: 'NO_ACTION',
  LOCAL_ONLY: 'LOCAL_ONLY',
  LOCAL_WITH_WARNING: 'LOCAL_WITH_WARNING',
  CRR_SHADOW_REVIEW: 'CRR_SHADOW_REVIEW',
  HYBRID_REPRICE_CANDIDATE: 'HYBRID_REPRICE_CANDIDATE',
});

export const HYBRID_CRR_REASONS = Object.freeze({
  NON_OPTION_BASELINE: 'NON_OPTION_BASELINE',
  LOCAL_SCENARIO_DATA_UNAVAILABLE: 'LOCAL_SCENARIO_DATA_UNAVAILABLE',
  CRR_SHADOW_UNAVAILABLE: 'CRR_SHADOW_UNAVAILABLE',
  LOCAL_WARNINGS_MAJOR: 'LOCAL_WARNINGS_MAJOR',
  LOCAL_WARNINGS_MODERATE: 'LOCAL_WARNINGS_MODERATE',
  MODEL_DISAGREEMENT_MEDIUM: 'MODEL_DISAGREEMENT_MEDIUM',
  MODEL_DISAGREEMENT_HIGH: 'MODEL_DISAGREEMENT_HIGH',
  LOCAL_CLEAN_AND_CRR_AGREES: 'LOCAL_CLEAN_AND_CRR_AGREES',
});

const MAJOR_WARNING_SET = new Set(['LARGE_TIME_STEP', 'NEAR_EXPIRATION']);
const MODERATE_WARNING_SET = new Set(['LARGE_SPOT_MOVE', 'LARGE_IV_CHANGE', 'INTRINSIC_FLOOR_APPLIED']);
const DISAGREEMENT_RANK = {
  [DISAGREEMENT_LEVELS.LOW]: 1,
  [DISAGREEMENT_LEVELS.MEDIUM]: 2,
  [DISAGREEMENT_LEVELS.HIGH]: 3,
};

function scenarioIdsFromContext(rankingContext) {
  const ids = [
    rankingContext?.downside_scenario_id,
    rankingContext?.base_scenario_id,
    rankingContext?.upside_scenario_id,
  ].filter(Boolean);
  return [...new Set(ids)];
}

function scenarioIdsFor(localCandidate, crrShadowCandidate, rankingContext) {
  const contextIds = scenarioIdsFromContext(rankingContext);
  if (contextIds.length > 0) return contextIds;
  return [...new Set([
    ...(localCandidate?.scenario_results ?? []).map(sr => sr.scenario_id),
    ...(crrShadowCandidate?.scenario_results ?? []).map(sr => sr.scenario_id),
  ])];
}

function findScenario(candidate, scenarioId) {
  return candidate?.scenario_results?.find(sr => sr.scenario_id === scenarioId) ?? null;
}

function collectLocalWarnings(scenarioPairs) {
  const warningsByScenario = [];
  const all = new Set();
  let hasMajor = false;
  let hasModerate = false;

  for (const { scenario_id: scenarioId, local } of scenarioPairs) {
    const warnings = local?.warnings ?? [];
    if (warnings.length > 0) warningsByScenario.push({ scenario_id: scenarioId, warnings: [...warnings] });
    for (const warning of warnings) {
      all.add(warning);
      if (MAJOR_WARNING_SET.has(warning)) hasMajor = true;
      if (MODERATE_WARNING_SET.has(warning)) hasModerate = true;
    }
  }

  return { all: [...all], by_scenario: warningsByScenario, has_major: hasMajor, has_moderate: hasModerate };
}

function computeDisagreements(scenarioPairs, maxLoss) {
  const rows = [];
  for (const { scenario_id: scenarioId, local, crr_shadow: crrShadow } of scenarioPairs) {
    if (local?.available === false || crrShadow?.available === false) continue;
    if (!Number.isFinite(local?.scenario_pnl) || !Number.isFinite(crrShadow?.scenario_pnl)) continue;
    const disagreement = computeModelDisagreement(local.scenario_pnl, crrShadow.scenario_pnl, maxLoss);
    rows.push({
      scenario_id: scenarioId,
      local_pnl: local.scenario_pnl,
      crr_shadow_pnl: crrShadow.scenario_pnl,
      ...disagreement,
    });
  }
  return rows;
}

function maxDisagreementLevel(disagreements) {
  let level = DISAGREEMENT_LEVELS.LOW;
  for (const row of disagreements) {
    if (DISAGREEMENT_RANK[row.level] > DISAGREEMENT_RANK[level]) level = row.level;
  }
  return level;
}

function isOptionCandidate(candidate) {
  return candidate?.strategy_type !== STRATEGY_TYPES.NO_TRADE && candidate?.strategy_type !== STRATEGY_TYPES.BUY_STOCK;
}

function hasUnavailableLocalScenario(scenarioPairs) {
  return scenarioPairs.some(({ local }) => !local || local.available === false || !Number.isFinite(local.scenario_pnl));
}

function hasUnavailableCrrScenario(scenarioPairs) {
  return scenarioPairs.some(({ crr_shadow: crrShadow }) => !crrShadow || crrShadow.available === false || !Number.isFinite(crrShadow.scenario_pnl));
}

function decideAction({ localWarnings, crrAvailable, maxLevel }) {
  const reasons = [];
  if (!crrAvailable) reasons.push(HYBRID_CRR_REASONS.CRR_SHADOW_UNAVAILABLE);
  if (localWarnings.has_major) reasons.push(HYBRID_CRR_REASONS.LOCAL_WARNINGS_MAJOR);
  if (localWarnings.has_moderate) reasons.push(HYBRID_CRR_REASONS.LOCAL_WARNINGS_MODERATE);
  if (maxLevel === DISAGREEMENT_LEVELS.MEDIUM) reasons.push(HYBRID_CRR_REASONS.MODEL_DISAGREEMENT_MEDIUM);
  if (maxLevel === DISAGREEMENT_LEVELS.HIGH) reasons.push(HYBRID_CRR_REASONS.MODEL_DISAGREEMENT_HIGH);

  if (!crrAvailable) {
    return {
      action: localWarnings.all.length > 0 ? HYBRID_CRR_ACTIONS.LOCAL_WITH_WARNING : HYBRID_CRR_ACTIONS.LOCAL_ONLY,
      reasons,
    };
  }

  if (localWarnings.has_major && maxLevel !== DISAGREEMENT_LEVELS.LOW) {
    return { action: HYBRID_CRR_ACTIONS.HYBRID_REPRICE_CANDIDATE, reasons };
  }

  if (localWarnings.has_major || localWarnings.has_moderate || maxLevel !== DISAGREEMENT_LEVELS.LOW) {
    return { action: HYBRID_CRR_ACTIONS.CRR_SHADOW_REVIEW, reasons };
  }

  return {
    action: HYBRID_CRR_ACTIONS.LOCAL_ONLY,
    reasons: [HYBRID_CRR_REASONS.LOCAL_CLEAN_AND_CRR_AGREES],
  };
}

export function evaluateHybridCrrPolicyForCandidate(localCandidate, crrShadowCandidate, { rankingContext = {} } = {}) {
  const candidateId = localCandidate?.candidate_id ?? crrShadowCandidate?.candidate_id ?? null;
  const strategyType = localCandidate?.strategy_type ?? crrShadowCandidate?.strategy_type ?? null;

  if (!isOptionCandidate(localCandidate ?? crrShadowCandidate)) {
    return {
      candidate_id: candidateId,
      strategy_type: strategyType,
      action: HYBRID_CRR_ACTIONS.NO_ACTION,
      reasons: [HYBRID_CRR_REASONS.NON_OPTION_BASELINE],
      local_warnings: [],
      local_warnings_by_scenario: [],
      model_disagreements: [],
      max_model_disagreement_level: null,
      crr_shadow_available: true,
    };
  }

  const scenarioIds = scenarioIdsFor(localCandidate, crrShadowCandidate, rankingContext);
  const scenarioPairs = scenarioIds.map(scenarioId => ({
    scenario_id: scenarioId,
    local: findScenario(localCandidate, scenarioId),
    crr_shadow: findScenario(crrShadowCandidate, scenarioId),
  }));

  if (hasUnavailableLocalScenario(scenarioPairs)) {
    return {
      candidate_id: candidateId,
      strategy_type: strategyType,
      action: HYBRID_CRR_ACTIONS.LOCAL_WITH_WARNING,
      reasons: [HYBRID_CRR_REASONS.LOCAL_SCENARIO_DATA_UNAVAILABLE],
      local_warnings: [],
      local_warnings_by_scenario: [],
      model_disagreements: [],
      max_model_disagreement_level: null,
      crr_shadow_available: !hasUnavailableCrrScenario(scenarioPairs),
    };
  }

  const localWarnings = collectLocalWarnings(scenarioPairs);
  const crrAvailable = !hasUnavailableCrrScenario(scenarioPairs);
  const disagreements = crrAvailable ? computeDisagreements(scenarioPairs, localCandidate.max_loss) : [];
  const maxLevel = disagreements.length > 0 ? maxDisagreementLevel(disagreements) : null;
  const decision = decideAction({ localWarnings, crrAvailable, maxLevel });

  return {
    candidate_id: candidateId,
    strategy_type: strategyType,
    action: decision.action,
    reasons: [...new Set(decision.reasons)],
    local_warnings: localWarnings.all,
    local_warnings_by_scenario: localWarnings.by_scenario,
    model_disagreements: disagreements,
    max_model_disagreement_level: maxLevel,
    crr_shadow_available: crrAvailable,
  };
}

export function evaluateHybridCrrPolicy(localCandidates, crrShadowCandidates, { rankingContext = {} } = {}) {
  const shadowById = new Map((crrShadowCandidates ?? []).map(candidate => [candidate.candidate_id, candidate]));
  const candidates = (localCandidates ?? []).map(localCandidate => evaluateHybridCrrPolicyForCandidate(
    localCandidate,
    shadowById.get(localCandidate.candidate_id),
    { rankingContext },
  ));

  const summary = {
    total_candidates: candidates.length,
    by_action: {},
    crr_shadow_available_count: 0,
    local_warning_count: 0,
  };

  for (const candidate of candidates) {
    summary.by_action[candidate.action] = (summary.by_action[candidate.action] ?? 0) + 1;
    if (candidate.crr_shadow_available) summary.crr_shadow_available_count += 1;
    if (candidate.local_warnings.length > 0) summary.local_warning_count += 1;
  }

  return { summary, candidates };
}
