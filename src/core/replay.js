/**
 * Core replay mode logic.
 */
import { evaluate as _evaluate, getReplayApi as _getReplayApi } from '../connection.js';

export const VALID_AUTOPLAY_DELAYS = [100, 143, 200, 300, 1000, 2000, 3000, 5000, 10000];

function wv(path) {
  return `(function(){ var v = ${path}; return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; })()`;
}

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    getReplayApi: deps?.getReplayApi || _getReplayApi,
    sleep: deps?.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))),
  };
}

// The public timestamp contract is always Unix seconds. Convert only at the API boundary.
export function parseReplayStart({ date, timestamp } = {}) {
  if (date !== undefined && timestamp !== undefined) throw new Error('Provide date or timestamp, not both');
  if (timestamp !== undefined) {
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < -62135596800 || timestamp > 253402300799.999) {
      throw new Error('timestamp must be finite Unix seconds between years 0001 and 9999; milliseconds are not accepted');
    }
    return Math.round(timestamp * 1000);
  }
  if (date === undefined) return null;
  if (typeof date !== 'string') throw new Error('Invalid date: use YYYY-MM-DD or ISO 8601 with an explicit Z/offset');
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,3}))?)?(Z|[+-](?:0\d|1[0-4]):[0-5]\d))?$/.exec(date);
  if (!match) throw new Error(`Invalid date: "${date}". Use YYYY-MM-DD or ISO 8601 with an explicit Z/offset.`);
  const [year, month, day] = match.slice(1, 4).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || /[+-]14:(?!00)/.test(date)) {
    throw new Error(`Invalid date: "${date}"`);
  }
  const milliseconds = Date.parse(match[4] === undefined ? `${date}T00:00:00Z` : date);
  if (!Number.isFinite(milliseconds) || milliseconds < -62135596800000 || milliseconds > 253402300799999) throw new Error(`Invalid date: "${date}"`);
  return milliseconds;
}

export async function start({ date, timestamp, _deps } = {}) {
  // Validate before opening the toolbar or making any other chart change.
  const selectedMs = parseReplayStart({ date, timestamp });
  const { evaluate, getReplayApi, sleep } = _resolve(_deps);
  const rp = await getReplayApi();
  const available = await evaluate(wv(`${rp}.isReplayAvailable()`));
  if (!available) throw new Error('Replay is not available for the current symbol/timeframe');

  await evaluate(`${rp}.showReplayToolbar()`);
  if (selectedMs !== null) {
    await evaluate(`Promise.resolve(${rp}.selectDate(${selectedMs})).then(function() { return 'ok'; })`, { awaitPromise: true });
  } else {
    await evaluate(`Promise.resolve(${rp}.selectFirstAvailableDate()).then(function() { return 'ok'; })`, { awaitPromise: true });
  }

  let started = false;
  let currentDate = null;
  for (let i = 0; i < 30; i++) {
    started = await evaluate(wv(`${rp}.isReplayStarted()`));
    currentDate = await evaluate(wv(`${rp}.currentDate()`));
    if (started === true && Number.isFinite(currentDate)) break;
    await sleep(250);
  }
  if (started !== true || !Number.isFinite(currentDate)) {
    // Recover a partially started session through the same verified live-return path.
    if (started === true) { try { await stop({ _deps }); } catch { /* original initialization error remains primary */ } }
    throw new Error('Replay failed to start with a ready bar. The selected time may not have data for this timeframe. Try a more recent date or a higher timeframe.');
  }
  return {
    success: true, replay_started: true, date: date ?? (timestamp === undefined ? '(first available)' : null),
    ...(selectedMs !== null && { requested_timestamp: selectedMs / 1000, requested_time_utc: new Date(selectedMs).toISOString() }),
    current_date: currentDate,
  };
}

export async function step({ _deps } = {}) {
  const { evaluate, getReplayApi, sleep } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay action=start first.');
  const before = await evaluate(wv(`${rp}.currentDate()`));
  await evaluate(`${rp}.doStep()`);
  // doStep() is async internally — currentDate takes ~500ms to update.
  // Poll until it changes or timeout after 3s.
  let currentDate = before;
  for (let i = 0; i < 12; i++) {
    await sleep(250);
    currentDate = await evaluate(wv(`${rp}.currentDate()`));
    if (currentDate !== before) break;
  }
  return { success: true, action: 'step', current_date: currentDate };
}

export async function autoplay({ speed, _deps } = {}) {
  // Validate BEFORE any CDP calls — invalid values corrupt cloud account state permanently
  if (speed > 0 && !VALID_AUTOPLAY_DELAYS.includes(speed))
    throw new Error(`Invalid autoplay delay ${speed}ms. Valid values: ${VALID_AUTOPLAY_DELAYS.join(', ')}`);

  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');
  if (speed > 0) {
    await evaluate(`${rp}.changeAutoplayDelay(${speed})`);
  }
  await evaluate(`${rp}.toggleAutoplay()`);
  const isAutoplay = await evaluate(wv(`${rp}.isAutoplayStarted()`));
  const currentDelay = await evaluate(wv(`${rp}.autoplayDelay()`));
  return { success: true, autoplay_active: !!isAutoplay, delay_ms: currentDelay };
}

export async function stop({ _deps } = {}) {
  const { evaluate, getReplayApi, sleep } = _resolve(_deps);
  const rp = await getReplayApi();
  const readState = async () => ({
    started: await evaluate(wv(`${rp}.isReplayStarted()`)),
    date: await evaluate(wv(`${rp}.currentDate()`)),
  });
  const before = await readState();
  if (before.started === false && before.date === null) {
    return { success: true, action: 'already_stopped', is_replay_started: false, current_date: null };
  }
  if (typeof before.started !== 'boolean') throw new Error('Could not establish replay state; refusing an unverified stop');

  // Calling the legacy close first can leave the manager desynchronized. Prefer
  // the one operation that ends the session and returns the chart to the live edge.
  const canReturnLive = await evaluate(`typeof ${rp}.goToRealtime === 'function'`);
  let method;
  if (canReturnLive === true) method = 'goToRealtime';
  else if (canReturnLive === false && before.started === true && await evaluate(`typeof ${rp}.stopReplay === 'function'`) === true) method = 'stopReplay';
  else throw new Error('No supported replay-to-live operation is available; state was not changed');
  await evaluate(`Promise.resolve(${rp}.${method}()).then(function() { return 'ok'; })`, { awaitPromise: true });

  for (let attempt = 0; attempt < 20; attempt++) {
    const current = await readState();
    if (current.started === false && current.date === null) {
      return { success: true, action: 'replay_stopped', method, is_replay_started: false, current_date: null };
    }
    if (attempt < 19) await sleep(250);
  }
  throw new Error(`Replay did not return to verified realtime after ${method}; no success was reported`);
}

export async function trade({ action, _deps }) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');

  if (action === 'buy') await evaluate(`${rp}.buy()`);
  else if (action === 'sell') await evaluate(`${rp}.sell()`);
  else if (action === 'close') await evaluate(`${rp}.closePosition()`);
  else throw new Error('Invalid action. Use: buy, sell, or close');

  const position = await evaluate(wv(`${rp}.position()`));
  const pnl = await evaluate(wv(`${rp}.realizedPL()`));
  return { success: true, action, position, realized_pnl: pnl };
}

export async function status({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const st = await evaluate(`
    (function() {
      var r = ${rp};
      function unwrap(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
      return {
        is_replay_available: unwrap(r.isReplayAvailable()),
        is_replay_started: unwrap(r.isReplayStarted()),
        is_autoplay_started: unwrap(r.isAutoplayStarted()),
        replay_mode: unwrap(r.replayMode()),
        current_date: unwrap(r.currentDate()),
        autoplay_delay: unwrap(r.autoplayDelay()),
      };
    })()
  `);
  const pos = await evaluate(wv(`${rp}.position()`));
  const pnl = await evaluate(wv(`${rp}.realizedPL()`));
  return { success: true, ...st, position: pos, realized_pnl: pnl };
}
