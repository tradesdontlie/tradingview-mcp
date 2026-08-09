import { STATUS, DATA_QUALITY, validateEvidence, DIRECTIONS } from './contracts.js';
import { applyObservation, buildEvent } from './state.js';

export function detect({ observation, evidence = [], previousState = null, profile, now = Date.now(), expiryMs } = {}) {
  if (!observation?.bar_key) return { state: previousState, event: null, reason: 'OBSERVATION_INVALID' };
  for (const item of evidence) {
    validateEvidence(item, { barKey: observation.bar_key });
    if (item.profile !== profile || item.session !== observation.session || item.policy_version !== observation.policy_version) return { state: previousState, event: null, reason: 'EVIDENCE_POLICY_MISMATCH' };
    if (item.freshness !== 'FRESH' || !DIRECTIONS.includes(item.direction)) return { state: previousState, event: null, reason: 'EVIDENCE_NOT_ACTIONABLE' };
  }
  const families = new Set(evidence.map(item => item.family));
  const directions = new Set(evidence.map(item => item.direction));
  if (directions.size > 1) return { state: previousState, event: null, reason: 'EVIDENCE_CONFLICT' };
  const usable = observation && observation.accepted && observation.quality !== DATA_QUALITY.UNKNOWN && observation.quality !== DATA_QUALITY.STALE;
  const state = usable ? applyObservation(previousState, observation, evidence, { now, expiryMs }) : (previousState ?? null);
  if (!state) return { state: null, event: null, reason: observation?.reason ?? 'NO_EVIDENCE' };
  if (families.size < 2 && state.status === STATUS.CANDIDATE) state.status = STATUS.CANDIDATE;
  return { state, event: buildEvent(state, observation, { profile }) };
}

export function familyCount(evidence = []) { return new Set(evidence.map(item => item.family)).size; }
