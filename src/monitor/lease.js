import { assertIdentityMatch, validateIdentity } from './contracts.js';

let busy = false;
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
};

export async function withLease({ expectedIdentity, timeoutMs = 5000, readIdentity, readSnapshot, clock = () => Date.now() }) {
  if (busy) throw new Error('LEASE_CONCURRENT');
  const expected = validateIdentity(expectedIdentity);
  if (typeof readIdentity !== 'function' || typeof readSnapshot !== 'function') throw new Error('LEASE_PROVIDER_MISSING');
  busy = true;
  const started = clock();
  let timer;
  let timedOut = false;
  try {
    const work = (async () => {
      const observed = assertIdentityMatch(expected, await readIdentity());
      const snapshot = await readSnapshot();
      if (clock() - started > timeoutMs) throw new Error('LEASE_TIMEOUT');
      const identity = assertIdentityMatch(expected, snapshot?.identity ?? observed);
      return freeze({ ...snapshot, identity });
    })();
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('LEASE_TIMEOUT')), timeoutMs); });
    try {
      return await Promise.race([work, timeout]);
    } catch (error) {
      if (error.message === 'LEASE_TIMEOUT') {
        timedOut = true;
        work.then(() => { busy = false; }, () => { busy = false; });
      }
      throw error;
    }
  } finally {
    clearTimeout(timer); if (!timedOut) busy = false;
  }
}

export function resetLeaseForTests() { busy = false; }
