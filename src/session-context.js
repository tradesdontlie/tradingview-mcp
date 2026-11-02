import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const storage = new AsyncLocalStorage();
const queues = new WeakMap();
let defaultSession;

export function createSessionContext({ targetId = process.env.TV_CDP_TARGET_ID || null } = {}) {
  if (targetId !== null && (typeof targetId !== 'string' || !targetId.trim())) {
    throw new Error('A selected CDP target must be a non-empty opaque target ID');
  }
  const session = { id: randomUUID(), selectedTargetId: targetId, closed: false };
  queues.set(session, Promise.resolve());
  return session;
}

export function hasSessionContext() {
  return Boolean(storage.getStore());
}

export function getSessionContext() {
  return storage.getStore() || (defaultSession ||= createSessionContext());
}

// Target changes and chart calls from one client execute in order. Other MCP
// sessions have independent queues and CDP clients. A nested call is reentrant.
export function runWithSessionContext(session, callback) {
  if (!queues.has(session) || session.closed) return Promise.reject(new Error('MCP session is closed or invalid'));
  if (storage.getStore() === session) return Promise.resolve().then(callback);
  const work = queues.get(session).then(() => {
    if (session.closed) throw new Error('MCP session is closed');
    return storage.run(session, callback);
  });
  queues.set(session, work.catch(() => {}));
  return work;
}
