import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const files = ['events.jsonl', 'evidence.jsonl', 'outbox.jsonl', 'checkpoints.jsonl'];
function guardRoot(rootDir) {
  const requested = path.resolve(rootDir); let probe = requested;
  while (!fs.existsSync(probe)) { const parent = path.dirname(probe); if (parent === probe) break; probe = parent; }
  const root = fs.existsSync(probe) ? path.resolve(fs.realpathSync(probe), path.relative(probe, requested)) : requested;
  const lower = root.toLowerCase().replace(/\\/g, '/');
  if (/(^|\/)journal\.db(?:[-.].*)?$/.test(lower) || /(^|\/)(data|check|scan)(?:\/|$)/.test(lower)) throw new Error('STORE_PATH_REJECTED');
  if (fs.existsSync(root) && fs.statSync(root).isFile()) throw new Error('STORE_PATH_REJECTED');
  return root;
}
function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}
function append(file, value) { fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8'); }

export function openMonitorStore({ rootDir }) {
  const root = guardRoot(rootDir); fs.mkdirSync(root, { recursive: true });
  const paths = Object.fromEntries(files.map(name => [name.replace('.jsonl', ''), path.join(root, name)]));
  for (const file of Object.values(paths)) if (!fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8');
  const events = () => readLines(paths.events);
  const evidence = () => readLines(paths.evidence);
  const outbox = () => readLines(paths.outbox);
  const checkpoints = () => readLines(paths.checkpoints);
  return {
    rootDir: root,
    appendEvent(event) {
      if (!events().some(x => x.event_id === event.event_id)) append(paths.events, event);
      if (event.identity_key && event.bar_key) {
        const observations = event.state_observations ?? []; const progress = crypto.createHash('sha256').update(JSON.stringify(observations)).digest('hex');
        const checkpoint = { checkpoint_key: `${event.identity_key}:${event.bar_key}:${event.revision ?? 0}:${event.evidence_revision ?? 0}:${event.evidence_hash ?? ''}:${progress}`, event_id: event.event_id, identity_key: event.identity_key, candidate_id: event.candidate_id, revision: event.revision ?? 0, evidence_revision: event.evidence_revision ?? 0, status: event.status, evidence: event.evidence ?? [], evidence_hash: event.evidence_hash, state_observations: observations, bar_key: event.bar_key, last_seen: event.last_seen ?? event.generated_at };
        if (!checkpoints().some(x => x.checkpoint_key === checkpoint.checkpoint_key)) append(paths.checkpoints, checkpoint);
      }
      return event;
    },
    appendEvidence(item) { const key = item.evidence_id ?? `${item.bar_key}:${item.source_id}`; if (!evidence().some(x => (x.evidence_id ?? `${x.bar_key}:${x.source_id}`) === key)) append(paths.evidence, item); return item; },
    enqueueOutbox(item) { const key = item.notification_key ?? item.event_id; if (!outbox().some(x => x.notification_key === key)) append(paths.outbox, { ...item, notification_key: key, pending: true }); return item; },
    ackOutbox: async (key, adapter) => {
      const pending = outbox().find(x => (x.notification_key ?? x.event_id) === key && x.pending !== false);
      if (!pending) return false;
      if (typeof adapter !== 'function') throw new Error('OUTBOX_ADAPTER_MISSING');
      const acknowledged = await adapter(pending);
      if (!acknowledged) return false;
      append(paths.outbox, { notification_key: key, ack: true, pending: false });
      return true;
    },
    replay() {
      const acked = new Set(outbox().filter(x => x.ack).map(x => x.notification_key));
      return { events: events(), evidence: evidence(), checkpoints: checkpoints(), outbox: outbox().filter(x => x.pending !== false && !acked.has(x.notification_key)) };
    },
  };
}
