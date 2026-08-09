import crypto from 'node:crypto';
import { STATUS, DATA_QUALITY, evidenceHash, identityKey } from './contracts.js';

export function candidateId(observation) { return crypto.createHash('sha256').update(String(observation.bar_key)).digest('hex').slice(0, 24); }
export function eventId(candidate, revision, status, hash) { return crypto.createHash('sha256').update(`${candidate}|${revision}|${status}|${hash}`).digest('hex'); }

export function createState(observation = {}) { return { candidate_id: candidateId(observation), revision: 0, evidence_revision: 0, status: STATUS.CANDIDATE, observations: [], evidence: [], evidence_hash: evidenceHash([]), bar_key: observation.bar_key, last_seen: null }; }

export function applyObservation(previous = null, observation, evidence = [], { now = Date.now(), expiryMs = 86_400_000 } = {}) {
  const state = previous ? structuredClone(previous) : createState(observation);
  const priorSeen = state.last_seen;
  const hash = evidenceHash(evidence);
  if (observation.quality === DATA_QUALITY.UNKNOWN || observation.quality === DATA_QUALITY.STALE || !observation.accepted) return { ...state, last_seen: now };
  const families = new Set(evidence.map(e => e.family));
  const agrees = families.size >= 2;
  const contrary = evidence.some(e => e.contrary === true || e.direction === 'CONTRARY');
  const closed = observation.bar_closed === true;
  state.observations.push({ bar_key: observation.bar_key, closed, hash });
  if (state.evidence_hash !== hash) state.evidence_revision += 1;
  state.evidence = evidence;
  state.evidence_hash = hash;
  state.last_seen = now;
  let next = state.status;
  if (contrary && (state.status === STATUS.PROVISIONAL || state.status === STATUS.CONFIRMED)) next = STATUS.RETRACTED;
  else if (state.status === STATUS.CANDIDATE && agrees) next = STATUS.PROVISIONAL;
  else if (state.status === STATUS.PROVISIONAL && closed && state.observations.filter(x => x.closed && x.hash === hash).length >= 2) next = STATUS.CONFIRMED;
  else if (state.status === STATUS.CANDIDATE && priorSeen != null && now - priorSeen > expiryMs) next = STATUS.EXPIRED;
  if (next !== state.status) state.revision += 1;
  state.status = next;
  return state;
}

export function replayState(observations = [], { now = Date.now(), expiryMs } = {}) {
  let state = null;
  for (const item of observations) state = applyObservation(state, item.observation ?? item, item.evidence ?? [], { now, expiryMs });
  return state;
}

export function buildEvent(state, observation, { profile, action = state?.status === STATUS.PROVISIONAL ? 'WAIT' : 'WAIT' } = {}) {
  const hash = state?.evidence_hash ?? evidenceHash([]);
  const eid = eventId(state.candidate_id, state.revision, state.status, hash);
  return { event_id: eid, candidate_id: state.candidate_id, revision: state.revision, evidence_revision: state.evidence_revision ?? 0, status: state.status, symbol_identity: observation.symbol_identity, identity_key: identityKey(observation.identity), profile, timeframe: observation.timeframe, bar_key: observation.bar_key, evidence: state.evidence ?? [], evidence_hash: hash, state_observations: state.observations, generated_at: observation.evaluated_at, action };
}
