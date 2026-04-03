/**
 * Core replay mode logic.
 */
import { evaluate, getReplayApi } from '../connection.js';

const VALID_AUTOPLAY_DELAYS = [100, 143, 200, 300, 1000, 2000, 3000, 5000, 10000];

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
    // Stop replay to recover chart
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
  if (speed > 0 && !VALID_AUTOPLAY_DELAYS.includes(speed)) {
    throw new Error(`Invalid autoplay delay ${speed}. Valid values: ${VALID_AUTOPLAY_DELAYS.join(', ')}`);
  }

  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');
  if (speed > 0) await evaluate(`${rp}.changeAutoplayDelay(${speed})`);
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
  return { success: true, ...st, position: pos, realized_pnl: pnl };
}
