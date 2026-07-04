/**
 * Deterministic guardrails — the most important code in the orchestrator.
 *
 * The agent PROPOSES a candidate config; this module ENFORCES. None of these
 * checks are reasoned over by the LLM — they run in plain JS and either pass or
 * reject. Order of operations:
 *
 *   1. Clamp to the validated universe (config can narrow, never invent).
 *   2. Structural: ≥2 strategies (confluence can never fire below 2).
 *   3. Rate limit: at most MAX_CHANGES_PER_CYCLE changes vs current.
 *   4. Objective: win% ≥ WIN_FLOOR AND expectancy ≥ EXPECTANCY_FLOOR AND
 *      sample ≥ MIN_SAMPLE, on the candidate's estimated performance.
 *   5. Risk gate direction: HISTORICAL_WIN_RATE may only move stricter (down)
 *      unsupervised; raising it is valid but requires approval.
 *
 * Returns { classification: 'reject'|'approval'|'auto', violations, clamped, changes }.
 */
import { UNIVERSE, THRESHOLDS, RISK_WINRATE_DIRECTION } from '../config.mjs';

export function clampToUniverse(bot, candidate) {
  const uni = UNIVERSE[bot];
  const violations = [];
  const allowedStrats = new Set(uni.strategies);
  const allowedFilters = new Set(uni.filters);

  const strategies = (candidate.active_strategies ?? []).filter((s) => {
    if (allowedStrats.has(s)) return true;
    violations.push(`strategy "${s}" is outside the ${bot} validated universe — stripped`);
    return false;
  });

  const filters = {};
  for (const [name, cfg] of Object.entries(candidate.active_filters ?? {})) {
    if (allowedFilters.has(name)) filters[name] = cfg;
    else violations.push(`filter "${name}" is outside the ${bot} validated universe — stripped`);
  }

  const clamped = { active_strategies: strategies, active_filters: filters };
  if (candidate.param_overrides) clamped.param_overrides = candidate.param_overrides;
  return { clamped, clampViolations: violations };
}

function countChanges(current, candidate, bot) {
  const changes = [];
  const cur = new Set(current.active_strategies ?? []);
  const cand = new Set(candidate.active_strategies ?? []);
  for (const s of UNIVERSE[bot].strategies) {
    if (cur.has(s) !== cand.has(s)) changes.push(`strategy ${s}: ${cur.has(s) ? 'on→off' : 'off→on'}`);
  }
  for (const f of UNIVERSE[bot].filters) {
    const a = (current.active_filters?.[f]?.enabled ?? true) !== false;
    const b = (candidate.active_filters?.[f]?.enabled ?? true) !== false;
    if (a !== b) changes.push(`filter ${f}: ${a ? 'on→off' : 'off→on'}`);
    // a param tweak (bins / value_area_percent) also counts as a change
    const ap = JSON.stringify({ bins: current.active_filters?.[f]?.bins, p: current.active_filters?.[f]?.value_area_percent });
    const bp = JSON.stringify({ bins: candidate.active_filters?.[f]?.bins, p: candidate.active_filters?.[f]?.value_area_percent });
    if (a === b && ap !== bp) changes.push(`filter ${f}: params changed`);
  }
  return changes;
}

export function validateProposal({ bot, current, candidate, estimate }) {
  const violations = [];
  const { clamped, clampViolations } = clampToUniverse(bot, candidate);
  // Clamp violations are informational (auto-corrected), not hard rejects.

  // 2. Structural
  if ((clamped.active_strategies?.length ?? 0) < 2)
    violations.push('candidate has < 2 active strategies — confluence can never fire');

  // 3. Rate limit
  const changes = countChanges(current, clamped, bot);
  if (changes.length > THRESHOLDS.MAX_CHANGES_PER_CYCLE)
    violations.push(`${changes.length} changes proposed; max ${THRESHOLDS.MAX_CHANGES_PER_CYCLE} per cycle`);

  // 4. Objective (only enforced when the config actually changed — a no-op
  //    re-affirmation of the current live config never needs to clear the bar)
  if (changes.length > 0) {
    if (estimate.sample == null || estimate.sample < THRESHOLDS.MIN_SAMPLE)
      violations.push(`insufficient sample (${estimate.sample ?? 0} retained trades; need ≥ ${THRESHOLDS.MIN_SAMPLE})`);
    if (estimate.winRate == null || estimate.winRate < THRESHOLDS.WIN_FLOOR)
      violations.push(`win% ${estimate.winRate == null ? 'unknown' : (estimate.winRate * 100).toFixed(1) + '%'} below floor ${THRESHOLDS.WIN_FLOOR * 100}%`);
    if (estimate.expectancy == null)
      violations.push('expectancy unknown (no pair with trustworthy avg-R) — cannot confirm positive edge');
    else if (estimate.expectancy < THRESHOLDS.EXPECTANCY_FLOOR)
      violations.push(`expectancy ${estimate.expectancy.toFixed(2)}R below floor +${THRESHOLDS.EXPECTANCY_FLOOR}R`);
  }

  // 5. Risk gate direction
  let requiresApproval = false;
  const curRisk = current.param_overrides?.HISTORICAL_WIN_RATE;
  const candRisk = clamped.param_overrides?.HISTORICAL_WIN_RATE ?? candidate.param_overrides?.HISTORICAL_WIN_RATE;
  if (candRisk != null && curRisk != null && candRisk > curRisk && RISK_WINRATE_DIRECTION === 'stricter-only') {
    requiresApproval = true;  // raising the gate loosens it — valid but human-gated
  }

  let classification;
  if (violations.length) classification = 'reject';
  else if (requiresApproval) classification = 'approval';
  else classification = 'auto';

  return { classification, violations, clampViolations, clamped, changes };
}
