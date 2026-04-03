/**
 * Core replay mode logic.
 */
import { evaluate, getReplayApi, getReplayUIController, safeString } from '../connection.js';

const VALID_AUTOPLAY_DELAYS = [100, 143, 200, 300, 1000, 2000, 3000, 5000, 10000];

// Replay update interval labels for human-readable output.
// Valid resolutions are dynamic (depend on chart timeframe) so we query TradingView at runtime.
// Known values: "1T" = 1 tick, "1S" = 1 second, "1" = 1 minute, "5" = 5 minutes, "10" = 10 minutes, etc.
const REPLAY_RESOLUTION_LABELS = {
  '1T': '1 tick', '1S': '1 second',
  '1': '1 min', '3': '3 min', '5': '5 min', '10': '10 min', '15': '15 min', '30': '30 min',
  '1H': '1 hour', '2H': '2 hours', '3H': '3 hours', '4H': '4 hours',
  '1D': '1 day', auto: 'auto',
};

function wv(path) {
  return `(function(){ var v = ${path}; return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; })()`;
}

export async function start({ date } = {}) {
  const rp = await getReplayApi();
  const available = await evaluate(wv(`${rp}.isReplayAvailable()`));
  if (!available) throw new Error('Replay is not available for the current symbol/timeframe');

  await evaluate(`${rp}.showReplayToolbar()`);
  await new Promise(r => setTimeout(r, 500));

  if (date) await evaluate(`${rp}.selectDate(new Date('${date}'))`);
  else await evaluate(`${rp}.selectFirstAvailableDate()`);
  await new Promise(r => setTimeout(r, 1000));

  // Check for "Data point unavailable" toast which corrupts the chart
  const toast = await evaluate(`
    (function() {
      var toasts = document.querySelectorAll('[class*="toast"], [class*="notification"], [class*="banner"]');
      for (var i = 0; i < toasts.length; i++) {
        var text = toasts[i].textContent || '';
        if (/data point unavailable|not available for playback/i.test(text)) return text.trim().substring(0, 200);
      }
      return null;
    })()
  `);

  if (toast) {
    // Stop replay to recover chart — do NOT hide toolbar (syncs to cloud account)
    try { await evaluate(`${rp}.stopReplay()`); } catch {}
    throw new Error(`Replay date unavailable: "${toast}". The requested date has no data for this timeframe. Try a more recent date or switch to a higher timeframe (e.g., Daily).`);
  }

  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  const currentDate = await evaluate(wv(`${rp}.currentDate()`));
  return { success: true, replay_started: !!started, date: date || '(first available)', current_date: currentDate };
}

export async function step() {
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');
  await evaluate(`${rp}.doStep()`);
  const currentDate = await evaluate(wv(`${rp}.currentDate()`));
  return { success: true, action: 'step', current_date: currentDate };
}

export async function autoplay({ speed } = {}) {
  // Validate BEFORE any CDP calls — invalid values corrupt cloud account state permanently
  if (speed > 0 && !VALID_AUTOPLAY_DELAYS.includes(speed))
    throw new Error(`Invalid autoplay delay ${speed}ms. Valid values: ${VALID_AUTOPLAY_DELAYS.join(', ')}`);

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

export async function stop() {
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) {
    return { success: true, action: 'already_stopped' };
  }
  await evaluate(`${rp}.stopReplay()`);
  return { success: true, action: 'replay_stopped' };
}

export async function trade({ action }) {
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

export async function setResolution({ interval } = {}) {
  // Resolve "auto" to null (TradingView's internal representation)
  const value = (!interval || interval === 'auto') ? null : interval;

  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');

  const ctrl = await getReplayUIController();

  // Query valid resolutions from TradingView — these are dynamic (depend on chart timeframe).
  // Validate BEFORE calling changeReplayResolution to prevent cloud state corruption.
  const available = await evaluate(wv(`${ctrl}._allReplayResolutions.value()`));
  if (!Array.isArray(available))
    throw new Error('Could not retrieve available replay resolutions from TradingView.');
  if (value !== null && !available.includes(value))
    throw new Error(`Invalid replay resolution "${interval}". Available for current timeframe: ${available.join(', ')}, auto. Note: 1T and 1S may require a paid TradingView plan.`);

  await evaluate(`${ctrl}.changeReplayResolution(${value === null ? 'null' : safeString(value)})`);

  const current = await evaluate(wv(`${ctrl}._currentReplayResolution.value()`));
  const auto = await evaluate(wv(`${ctrl}._autoReplayResolution.value()`));
  const label = resolveLabel(current, auto);
  return { success: true, resolution: current, resolution_label: label, auto_resolution: auto };
}

function resolveLabel(current, auto) {
  if (current === null) return `auto (${REPLAY_RESOLUTION_LABELS[auto] || auto})`;
  return REPLAY_RESOLUTION_LABELS[current] || current;
}

export async function status() {
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

  // Include replay resolution info
  let replay_resolution = null;
  let replay_resolution_label = null;
  try {
    const ctrl = await getReplayUIController();
    const current = await evaluate(wv(`${ctrl}._currentReplayResolution.value()`));
    const auto = await evaluate(wv(`${ctrl}._autoReplayResolution.value()`));
    replay_resolution = current;
    replay_resolution_label = resolveLabel(current, auto);
  } catch {}

  return { success: true, ...st, replay_resolution, replay_resolution_label, position: pos, realized_pnl: pnl };
}
