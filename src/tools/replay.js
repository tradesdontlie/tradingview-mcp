import { evaluate, getReplayApi } from '../connection.js';

// Helper: many replayApi methods return WatchedValue objects, not primitives.
// This helper unwraps them by calling .value() if needed.
function wv(path) {
  return `(function(){ var v = ${path}; return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; })()`;
}

export function replayDateToUnixSeconds(date) {
  if (!date) return null;

  const raw = String(date).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);

  const parsed = raw.includes('T') ? new Date(raw) : new Date(`${raw}T00:00:00Z`);
  const time = parsed.getTime();
  if (Number.isNaN(time)) {
    throw new Error(`Invalid replay date: ${date}. Use YYYY-MM-DD, ISO datetime, or a Unix timestamp in seconds.`);
  }

  return Math.floor(time / 1000);
}

export function registerReplayTools(server) {

  server.tool('replay_start', 'Start bar replay mode, optionally at a specific date', {
    date: { type: 'string', description: 'Date to start replay from (YYYY-MM-DD format). If omitted, selects first available date.', default: '' },
  }, async ({ date }) => {
    try {
      const rp = await getReplayApi();

      const available = await evaluate(wv(`${rp}.isReplayAvailable()`));
      if (!available) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: false,
            error: 'Replay is not available for the current symbol/timeframe',
          }, null, 2) }],
          isError: true,
        };
      }

      await evaluate(`${rp}.showReplayToolbar()`);
      await new Promise(r => setTimeout(r, 500));

      if (date) {
        // TradingView expects Unix timestamp in seconds for selectDate
        const ts = replayDateToUnixSeconds(date);
        await evaluate(`${rp}.selectDate(${ts})`);
      } else {
        await evaluate(`${rp}.selectFirstAvailableDate()`);
      }
      await new Promise(r => setTimeout(r, 1000));

      // Check if replay actually started; if not, try startReplay()
      let started = await evaluate(wv(`${rp}.isReplayStarted()`));
      if (!started) {
        try { await evaluate(`${rp}.startReplay()`); } catch { /* may not exist */ }
        await new Promise(r => setTimeout(r, 500));
        started = await evaluate(wv(`${rp}.isReplayStarted()`));
      }
      const currentDate = await evaluate(wv(`${rp}.currentDate()`));

      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true,
          replay_started: !!started,
          date: date || '(first available)',
          current_date: currentDate,
        }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }],
        isError: true,
      };
    }
  });

  server.tool('replay_step', 'Advance one bar in replay mode', {}, async () => {
    try {
      const rp = await getReplayApi();
      const started = await evaluate(wv(`${rp}.isReplayStarted()`));
      if (!started) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: false, error: 'Replay is not started. Use replay_start first.',
          }, null, 2) }],
          isError: true,
        };
      }

      await evaluate(`${rp}.doStep()`);
      const currentDate = await evaluate(wv(`${rp}.currentDate()`));

      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, action: 'step', current_date: currentDate }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }],
        isError: true,
      };
    }
  });

  server.tool('replay_autoplay', 'Toggle autoplay in replay mode, optionally set speed', {
    speed: { type: 'number', description: 'Autoplay delay in ms (lower = faster). Leave empty to just toggle.', default: 0 },
  }, async ({ speed }) => {
    try {
      const rp = await getReplayApi();
      const started = await evaluate(wv(`${rp}.isReplayStarted()`));
      if (!started) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: false, error: 'Replay is not started. Use replay_start first.',
          }, null, 2) }],
          isError: true,
        };
      }

      if (speed > 0) {
        await evaluate(`${rp}.changeAutoplayDelay(${speed})`);
      }
      await evaluate(`${rp}.toggleAutoplay()`);

      const isAutoplay = await evaluate(wv(`${rp}.isAutoplayStarted()`));
      const currentDelay = await evaluate(wv(`${rp}.autoplayDelay()`));

      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true, autoplay_active: !!isAutoplay, delay_ms: currentDelay,
        }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }],
        isError: true,
      };
    }
  });

  server.tool('replay_stop', 'Stop replay and return to realtime', {}, async () => {
    try {
      const rp = await getReplayApi();
      await evaluate(`${rp}.stopReplay()`);
      await evaluate(`${rp}.goToRealtime()`);
      await evaluate(`${rp}.hideReplayToolbar()`);

      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, action: 'replay_stopped' }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }],
        isError: true,
      };
    }
  });

  server.tool('replay_trade', 'Execute a trade action in replay mode (buy, sell, or close position)', {
    action: { type: 'string', description: 'Trade action: buy, sell, or close' },
  }, async ({ action }) => {
    try {
      const rp = await getReplayApi();
      const started = await evaluate(wv(`${rp}.isReplayStarted()`));
      if (!started) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: false, error: 'Replay is not started. Use replay_start first.',
          }, null, 2) }],
          isError: true,
        };
      }

      if (action === 'buy') await evaluate(`${rp}.buy()`);
      else if (action === 'sell') await evaluate(`${rp}.sell()`);
      else if (action === 'close') await evaluate(`${rp}.closePosition()`);
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: false, error: 'Invalid action. Use: buy, sell, or close',
          }, null, 2) }],
          isError: true,
        };
      }

      const position = await evaluate(wv(`${rp}.position()`));
      const pnl = await evaluate(wv(`${rp}.realizedPL()`));

      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true, action, position, realized_pnl: pnl,
        }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }],
        isError: true,
      };
    }
  });

  server.tool('replay_status', 'Get current replay mode status', {}, async () => {
    try {
      const rp = await getReplayApi();

      // All replayApi getters return WatchedValue objects — unwrap each one
      const status = await evaluate(`
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

      // position/pnl might also be WatchedValues
      const pos = await evaluate(wv(`${rp}.position()`));
      const pnl = await evaluate(wv(`${rp}.realizedPL()`));

      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true,
          ...status,
          position: pos,
          realized_pnl: pnl,
        }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }],
        isError: true,
      };
    }
  });
}
