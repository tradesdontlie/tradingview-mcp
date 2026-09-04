import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  evaluateHybridCrrPolicy,
  evaluateHybridCrrPolicyForCandidate,
  HYBRID_CRR_ACTIONS,
  HYBRID_CRR_REASONS,
} from '../src/core/options/marketInputs/hybridCrrPolicy.js';

const CTX = {
  downside_scenario_id: 'DOWNSIDE',
  base_scenario_id: 'BASE',
  upside_scenario_id: 'UPSIDE',
};

function sr(scenarioId, pnl, warnings = [], available = true) {
  return {
    scenario_id: scenarioId,
    available,
    scenario_pnl: available ? pnl : null,
    warnings,
  };
}

function optionCandidate(id, scenarioResults, maxLoss = 1000) {
  return {
    candidate_id: id,
    strategy_type: 'LONG_CALL',
    max_loss: maxLoss,
    scenario_results: scenarioResults,
  };
}

function cleanLocal(id = 'C1') {
  return optionCandidate(id, [
    sr('DOWNSIDE', -300),
    sr('BASE', 120),
    sr('UPSIDE', 450),
  ]);
}

function closeShadow(id = 'C1') {
  return optionCandidate(id, [
    sr('DOWNSIDE', -305),
    sr('BASE', 126),
    sr('UPSIDE', 455),
  ]);
}

describe('evaluateHybridCrrPolicyForCandidate()', () => {
  it('keeps clean local-Greek candidates local when CRR agrees', () => {
    const result = evaluateHybridCrrPolicyForCandidate(cleanLocal(), closeShadow(), { rankingContext: CTX });

    assert.equal(result.action, HYBRID_CRR_ACTIONS.LOCAL_ONLY);
    assert.deepEqual(result.reasons, [HYBRID_CRR_REASONS.LOCAL_CLEAN_AND_CRR_AGREES]);
    assert.equal(result.max_model_disagreement_level, 'MODEL_DISAGREEMENT_LOW');
  });

  it('marks major warning plus material CRR disagreement as a hybrid reprice candidate', () => {
    const local = optionCandidate('C2', [
      sr('DOWNSIDE', -300),
      sr('BASE', 100, ['LARGE_TIME_STEP']),
      sr('UPSIDE', 420),
    ]);
    const shadow = optionCandidate('C2', [
      sr('DOWNSIDE', -300),
      sr('BASE', 410),
      sr('UPSIDE', 420),
    ]);

    const result = evaluateHybridCrrPolicyForCandidate(local, shadow, { rankingContext: CTX });

    assert.equal(result.action, HYBRID_CRR_ACTIONS.HYBRID_REPRICE_CANDIDATE);
    assert.ok(result.reasons.includes(HYBRID_CRR_REASONS.LOCAL_WARNINGS_MAJOR));
    assert.ok(result.reasons.includes(HYBRID_CRR_REASONS.MODEL_DISAGREEMENT_HIGH));
  });

  it('keeps major-warning candidates under shadow review when CRR agrees', () => {
    const local = optionCandidate('C3', [
      sr('DOWNSIDE', -300),
      sr('BASE', 100, ['NEAR_EXPIRATION']),
      sr('UPSIDE', 420),
    ]);
    const shadow = optionCandidate('C3', [
      sr('DOWNSIDE', -302),
      sr('BASE', 105),
      sr('UPSIDE', 425),
    ]);

    const result = evaluateHybridCrrPolicyForCandidate(local, shadow, { rankingContext: CTX });

    assert.equal(result.action, HYBRID_CRR_ACTIONS.CRR_SHADOW_REVIEW);
    assert.ok(result.reasons.includes(HYBRID_CRR_REASONS.LOCAL_WARNINGS_MAJOR));
  });

  it('does not auto-reprice moderate warnings; it routes them to shadow review', () => {
    const local = optionCandidate('C4', [
      sr('DOWNSIDE', -300),
      sr('BASE', 100, ['LARGE_IV_CHANGE']),
      sr('UPSIDE', 420),
    ]);
    const shadow = optionCandidate('C4', [
      sr('DOWNSIDE', -300),
      sr('BASE', 230),
      sr('UPSIDE', 420),
    ]);

    const result = evaluateHybridCrrPolicyForCandidate(local, shadow, { rankingContext: CTX });

    assert.equal(result.action, HYBRID_CRR_ACTIONS.CRR_SHADOW_REVIEW);
    assert.ok(result.reasons.includes(HYBRID_CRR_REASONS.LOCAL_WARNINGS_MODERATE));
    assert.ok(result.reasons.includes(HYBRID_CRR_REASONS.MODEL_DISAGREEMENT_MEDIUM));
  });

  it('falls back to local-with-warning when CRR shadow is unavailable', () => {
    const local = optionCandidate('C5', [
      sr('DOWNSIDE', -300),
      sr('BASE', 100, ['LARGE_TIME_STEP']),
      sr('UPSIDE', 420),
    ]);
    const shadow = optionCandidate('C5', [
      sr('DOWNSIDE', -300),
      sr('BASE', 0, [], false),
      sr('UPSIDE', 420),
    ]);

    const result = evaluateHybridCrrPolicyForCandidate(local, shadow, { rankingContext: CTX });

    assert.equal(result.action, HYBRID_CRR_ACTIONS.LOCAL_WITH_WARNING);
    assert.equal(result.crr_shadow_available, false);
    assert.ok(result.reasons.includes(HYBRID_CRR_REASONS.CRR_SHADOW_UNAVAILABLE));
  });

  it('leaves non-option baselines out of hybrid repricing', () => {
    const result = evaluateHybridCrrPolicyForCandidate({
      candidate_id: 'C6',
      strategy_type: 'BUY_STOCK',
      scenario_results: [sr('BASE', 100)],
    }, null, { rankingContext: CTX });

    assert.equal(result.action, HYBRID_CRR_ACTIONS.NO_ACTION);
    assert.deepEqual(result.reasons, [HYBRID_CRR_REASONS.NON_OPTION_BASELINE]);
  });
});

describe('evaluateHybridCrrPolicy()', () => {
  it('summarizes action counts across local and CRR-shadow candidates', () => {
    const localCandidates = [
      cleanLocal('C1'),
      optionCandidate('C2', [
        sr('DOWNSIDE', -300),
        sr('BASE', 100, ['LARGE_TIME_STEP']),
        sr('UPSIDE', 420),
      ]),
    ];
    const shadowCandidates = [
      closeShadow('C1'),
      optionCandidate('C2', [
        sr('DOWNSIDE', -300),
        sr('BASE', 410),
        sr('UPSIDE', 420),
      ]),
    ];

    const result = evaluateHybridCrrPolicy(localCandidates, shadowCandidates, { rankingContext: CTX });

    assert.equal(result.summary.total_candidates, 2);
    assert.equal(result.summary.by_action[HYBRID_CRR_ACTIONS.LOCAL_ONLY], 1);
    assert.equal(result.summary.by_action[HYBRID_CRR_ACTIONS.HYBRID_REPRICE_CANDIDATE], 1);
    assert.equal(result.summary.local_warning_count, 1);
  });
});
