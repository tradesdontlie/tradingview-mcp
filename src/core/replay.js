/**
 * Core replay mode logic.
 */
import { evaluate, getReplayApi } from '../connection.js';

const FALLBACK_AUTOPLAY_DELAYS = [100, 143, 200, 300, 1000, 2000, 3000, 5000, 10000];

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
    try { await evaluate(`${rp}.hideReplayToolbar()`); } catch {}
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
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');
  const validDelays = await getAvailableAutoplayDelays(rp);
  if (speed > 0 && !validDelays.includes(speed)) {
    throw new Error(`Invalid autoplay delay ${speed}. Available delays: ${validDelays.join(', ')}`);
  }
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
    // Try to hide toolbar even if not started
    try { await evaluate(`${rp}.hideReplayToolbar()`); } catch {}
    return { success: true, action: 'already_stopped' };
  }
  await evaluate(`${rp}.stopReplay()`);
  try { await evaluate(`${rp}.hideReplayToolbar()`); } catch {}
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

async function getAvailableAutoplayDelays(rp) {
  const result = await evaluate(`
    (function() {
      var replay = ${rp};
      var seen = {};
      var out = [];

      function push(value) {
        if (typeof value !== 'number' || !isFinite(value)) return;
        if (seen[value]) return;
        seen[value] = true;
        out.push(value);
      }

      function read(entry) {
        if (entry == null) return;
        if (Array.isArray(entry)) {
          for (var i = 0; i < entry.length; i++) read(entry[i]);
          return;
        }
        if (typeof entry === 'number') {
          push(entry);
          return;
        }
        if (typeof entry === 'object' && typeof entry.value === 'function') {
          try { read(entry.value()); } catch (e) {}
          return;
        }
        if (typeof entry === 'object') {
          if (typeof entry.value === 'number') push(entry.value);
          if (typeof entry.id === 'number') push(entry.id);
          if (typeof entry.delay === 'number') push(entry.delay);
          if (typeof entry.autoplayDelay === 'number') push(entry.autoplayDelay);
        }
      }

      var candidates = [
        replay.findAutoplayDelayOptionItems && replay.findAutoplayDelayOptionItems(),
        replay._replayManager && replay._replayManager.findAutoplayDelayOptionItems && replay._replayManager.findAutoplayDelayOptionItems(),
        replay._replayUIController && replay._replayUIController._replayManager &&
          replay._replayUIController._replayManager.findAutoplayDelayOptionItems &&
          replay._replayUIController._replayManager.findAutoplayDelayOptionItems(),
      ];

      for (var i = 0; i < candidates.length; i++) {
        try { read(candidates[i]); } catch (e) {}
      }

      return out.sort(function(a, b) { return a - b; });
    })()
  `);
  return Array.isArray(result) && result.length ? result : FALLBACK_AUTOPLAY_DELAYS;
}
