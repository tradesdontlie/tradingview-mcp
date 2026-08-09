import { withLease } from './lease.js';
import { resolveWatchItem, canAlert } from './profiles.js';
import { normalizeObservation } from './normalize.js';
import { detect } from './detector.js';
import { buildMonitorV1 } from './output.js';
import { identityKey } from './contracts.js';

export function createMonitorWorker({ watchlist = [], reader, store, clock = () => Date.now(), leaseTimeoutMs = 5000 } = {}) {
  if (!reader || typeof reader.readIdentity !== 'function' || typeof reader.readSnapshot !== 'function') throw new Error('READER_METHODS_MISSING');
  const items = watchlist.map(resolveWatchItem); let stopped = false; let running = false; let timer = null; let index = 0; const states = new Map();
  const identityFor = item => ({ ...(item.identity ?? item), profile: (item.identity ?? item).profile ?? item.profile });
  if (store?.replay) {
    const replay = store.replay(); const hydrated = (replay.checkpoints?.length ? replay.checkpoints : replay.events) ?? [];
    for (const event of hydrated) {
      const item = items.find(x => identityKey(identityFor(x)) === event.identity_key);
      if (item) states.set(identityKey(identityFor(item)), { state: { candidate_id: event.candidate_id, revision: event.revision, evidence_revision: event.evidence_revision ?? 0, status: event.status, evidence: event.evidence ?? [], evidence_hash: event.evidence_hash, observations: event.state_observations ?? [], bar_key: event.bar_key, last_seen: event.last_seen ?? event.generated_at }, observation: { bar_key: event.bar_key, bar_open_timestamp: Number(String(event.bar_key).split('|').at(-2)) } });
    }
  }
  async function runOnce() {
    if (stopped || running) return { paused: true, reason: 'BUSY' };
    running = true; const results = [];
    try {
      for (let count = 0; count < items.length; count += 1) {
        const item = items[index % items.length]; index += 1;
        if (!item) break;
        try {
          const expectedIdentity = identityFor(item);
          const snapshot = await withLease({ expectedIdentity, timeoutMs: leaseTimeoutMs, readIdentity: () => reader.readIdentity(item), readSnapshot: () => reader.readSnapshot(item), clock });
          const key = identityKey(expectedIdentity);
          const previous = states.get(key);
          const observation = normalizeObservation(snapshot, { expectedIdentity, now: clock(), sessionPolicy: item.sessionPolicy, previousObservation: previous?.observation });
          if (!observation.accepted) { results.push({ item, observation }); continue; }
          const sameBar = previous?.state?.bar_key === observation.bar_key;
          const result = detect({ observation, evidence: snapshot.evidence ?? [], previousState: sameBar ? previous.state : null, profile: item.profile, now: clock() });
          states.set(key, { state: result.state, observation });
          if (result.event && canAlert(item)) {
            const packet = buildMonitorV1({ ...result.event, profile: item.profile, policy_version: item.sessionPolicy?.version ?? item.policy_version, freshness: observation.quality, missing_stale: observation.missing_stale, source_timestamps: { source: observation.source_timestamp, receipt: observation.receipt_timestamp, evaluated: observation.evaluated_at, closed: observation.bar_closed ? observation.evaluated_at : null } });
            const persisted = { ...packet, identity_key: result.event.identity_key, evidence_revision: result.event.evidence_revision, state_observations: result.event.state_observations, last_seen: result.state?.last_seen };
            store?.appendEvent(persisted); (packet.evidence ?? []).forEach(e => store?.appendEvidence(e));
            if (packet.status === 'PROVISIONAL' || packet.status === 'CONFIRMED') store?.enqueueOutbox({ event_id: packet.event_id, notification_key: `${packet.candidate_id}:${result.event.revision}:${result.event.evidence_revision}:${result.event.evidence_hash}` });
            results.push(packet);
          } else results.push({ item, paused: item.tier === 'CONTEXT' });
        } catch (error) { results.push({ item, paused: true, reason: error.message }); }
      }
      return results;
    } finally { running = false; }
  }
  function start(intervalMs = 1000, signal) { stopped = false; const tick = async () => { if (!stopped) { await runOnce(); timer = setTimeout(tick, intervalMs); } }; if (signal) signal.addEventListener('abort', stop, { once: true }); timer = setTimeout(tick, 0); return stop; }
  function stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; }
  return { runOnce, start, stop, get paused() { return stopped; }, states };
}
