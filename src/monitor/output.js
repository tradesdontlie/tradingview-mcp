import { ENGINE_VERSION, MONITOR_SCHEMA_VERSION, STATUS, evidenceHash, serializeEvidence } from './contracts.js';

export function buildMonitorV1(event = {}) {
  const evidence = serializeEvidence(event.evidence ?? []);
  const out = {
    event_id: event.event_id, candidate_id: event.candidate_id, revision: event.revision ?? 0, status: event.status ?? STATUS.CANDIDATE,
    symbol_identity: event.symbol_identity, profile: event.profile, timeframe: event.timeframe, bar_key: event.bar_key,
    evidence, scenarios: [], action: event.action ?? 'WAIT', confidence_label: event.confidence_label ?? 'UNSPECIFIED',
    freshness: event.freshness ?? 'UNKNOWN', source_timestamps: event.source_timestamps ?? {}, policy_version: event.policy_version ?? 'unknown',
    engine_version: event.engine_version ?? ENGINE_VERSION, schema_version: MONITOR_SCHEMA_VERSION, generated_at: event.generated_at ?? null,
    missing_stale: event.missing_stale ?? [], invalidation: event.invalidation ?? null,
  };
  out.evidence_hash = evidenceHash(evidence);
  if (out.status !== STATUS.CONFIRMED || out.action === 'WAIT') out.action = 'WAIT';
  return out;
}

export function renderHumanAlert(packet) {
  const families = [...new Set((packet.evidence ?? []).map(x => x.family))].join(', ') || 'none';
  const closed = packet.source_timestamps?.closed ?? packet.source_timestamps?.bar_close ?? 'unknown';
  const missing = (packet.missing_stale ?? []).join(', ') || 'none';
  return `[${packet.status}] ${packet.symbol_identity ?? 'unknown'} · TF ${packet.timeframe ?? '?'}\nclosed: ${closed}\nfamilies: ${families}\nmissing/stale: ${missing}\nscenarios: none\ninvalidation: ${packet.invalidation ?? 'none'}\nfreshness: ${packet.freshness ?? 'UNKNOWN'}\naction: ${packet.action ?? 'WAIT'}`;
}
