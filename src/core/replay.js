/**
 * Core replay mode logic.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, getReplayApi as _getReplayApi, safeString } from '../connection.js';

export const VALID_AUTOPLAY_DELAYS = [100, 143, 200, 300, 1000, 2000, 3000, 5000, 10000];

// step() completion-wait tuning. Overridable via _deps for fast unit tests.
export const STEP_POLL_MS = 60;      // how often to re-read the replay cursor
export const STEP_TIMEOUT_MS = 3000; // hard ceiling before we declare "no advance"

function wv(path) {
  return `(function(){ var v = ${path}; return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; })()`;
}

// Drift beyond this (seconds) between requested and landed date signals a clamp
// (target predates the loaded history buffer) rather than a normal time-convention
// offset (session-close vs midnight ~1 day, or a weekend/holiday gap).
const DRIFT_WARN_SECONDS = 4 * 86400;

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    // evaluateAsync sets CDP awaitPromise:true. Required for selectDate() —
    // see start(). Falls back to the injected `evaluate` in unit tests that
    // only stub the sync one, so existing test doubles keep working.
    evaluateAsync: deps?.evaluateAsync || deps?.evaluate || _evaluateAsync,
    getReplayApi: deps?.getReplayApi || _getReplayApi,
    pollMs: deps?.pollMs ?? STEP_POLL_MS,
    stepTimeoutMs: deps?.stepTimeoutMs ?? STEP_TIMEOUT_MS,
  };
}

export async function start({ date, _deps } = {}) {
  const { evaluate, evaluateAsync, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const available = await evaluate(wv(`${rp}.isReplayAvailable()`));
  if (!available) throw new Error('Replay is not available for the current symbol/timeframe');

  // Re-jump safety: if replay is already running, a second selectDate() can be
  // absorbed and the cursor stays pinned. Stop and let it settle before
  // re-selecting so the new start lands where asked (T113a).
  const alreadyRunning = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (alreadyRunning) {
    try { await evaluate(`${rp}.stopReplay()`); } catch {}
    await new Promise(r => setTimeout(r, 300));
  }

  await evaluate(`${rp}.showReplayToolbar()`);

  // selectDate() is async — it calls enableReplayMode() then _onPointSelected()
  // which initializes the server-side replay session. Must be awaited inside the
  // page context, otherwise the promise is fire-and-forget and replay state says
  // "started" but stepping doesn't work (issue #26).
  //
  // The previous `.then(function(){return 'ok';})` wrapper did NOT achieve that:
  // it just built another Promise, and `evaluate()` runs with CDP
  // awaitPromise:false, so the whole chain was still fire-and-forget.
  // selectFirstAvailableDate() had no wrapper at all. Use evaluateAsync
  // (awaitPromise:true) so the page-side session is genuinely initialized
  // before we poll. Upstream tradesdontlie/tradingview-mcp#172.
  if (date) {
    const ts = new Date(date).getTime();
    if (isNaN(ts)) throw new Error(`Invalid date: "${date}". Use YYYY-MM-DD format.`);
    await evaluateAsync(`${rp}.selectDate(${ts})`);
  } else {
    await evaluateAsync(`${rp}.selectFirstAvailableDate()`);
  }

  // Poll until replay is fully initialized: isReplayStarted AND currentDate is set.
  // selectDate()'s promise resolves before the data series is ready, so we need
  // to wait for currentDate to become non-null before stepping will work.
  let started = false;
  let currentDate = null;
  for (let i = 0; i < 30; i++) {
    started = await evaluate(wv(`${rp}.isReplayStarted()`));
    currentDate = await evaluate(wv(`${rp}.currentDate()`));
    if (started && currentDate !== null) break;
    await new Promise(r => setTimeout(r, 250));
  }

  if (!started) {
    try { await evaluate(`${rp}.stopReplay()`); } catch {}
    throw new Error('Replay failed to start. The selected date may not have data for this timeframe. Try a more recent date or a higher timeframe (e.g., Daily).');
  }

  // Drift-warning: surface a silent clamp instead of pretending success. If the
  // landed cursor is far from the requested date, the target likely predates the
  // loaded history buffer (scroll_back to pre-load history is T113b).
  let warning;
  if (date && typeof currentDate === 'number') {
    const reqSec = Math.floor(new Date(date).getTime() / 1000);
    const driftSec = Math.abs(currentDate - reqSec);
    if (driftSec > DRIFT_WARN_SECONDS) {
      const landed = new Date(currentDate * 1000).toISOString().slice(0, 10);
      warning = `Replay landed ~${Math.round(driftSec / 86400)}d from the requested date (requested ${date}, cursor ${landed}). The target may predate the loaded history buffer.`;
    }
  }

  const result = { success: true, replay_started: true, date: date || '(first available)', current_date: currentDate };
  if (warning) result.warning = warning;
  return result;
}

export async function step({ _deps } = {}) {
  const { evaluate, getReplayApi, pollMs, stepTimeoutMs } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');

  // Completion signal is currentDate() changing. doStep() is async with no return
  // value; live probing (TV Desktop 3.1.0) confirms bars().lastIndex() does NOT
  // track the replay cursor — it jumps to the full loaded-series size on the first
  // step and then freezes — whereas currentDate() advances by exactly one bar each
  // step (each replay bar has a unique timestamp). The old code polled this on a
  // fixed 250ms×12 timer and, worse, returned a STALE date on timeout — masking
  // end-of-data as success. We poll tighter (60ms) and THROW when the cursor never
  // moves, so callers (and the T115 walk loop) get a real end-of-data signal.
  const cdExpr = wv(`${rp}.currentDate()`);
  const before = await evaluate(cdExpr);

  await evaluate(`${rp}.doStep()`);

  // Require FORWARD progress, not just "different". Live probing shows currentDate()
  // can flicker to a transient/stale lower value mid-transition before settling on
  // the next bar; replay is strictly forward, so "current > before" rejects those
  // glitches and only accepts the real next bar. (When `before` isn't numeric —
  // shouldn't happen post-start — fall back to "changed and non-null".)
  const advanced = (c) => (typeof before === 'number')
    ? (typeof c === 'number' && c > before)
    : (c != null && c !== before);

  let current = before;
  const deadline = Date.now() + stepTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    current = await evaluate(cdExpr);
    if (advanced(current)) break;
  }
  if (!advanced(current)) {
    throw new Error('Replay bar did not advance (end of available data, or replay not ready). Try a higher timeframe or an earlier start date.');
  }

  return { success: true, action: 'step', current_date: current };
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

export async function setResolution({ resolution, _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  if (resolution === undefined) throw new Error('resolution is required (e.g. "1H", "1D", or "auto")');

  // Normalize: null / "auto" / "" → auto (null).
  let target = resolution;
  if (target === null || target === '' || String(target).toLowerCase() === 'auto') target = null;
  else target = String(target);

  const rp = await getReplayApi();

  // Validate against the LIVE valid set before mutating — the set is dynamic
  // (depends on symbol/timeframe) and sending an unsupported value corrupts
  // TradingView's cloud replay state (S1). replayResolutions() includes null (auto).
  const valid = await evaluate(wv(`${rp}.replayResolutions()`));
  const validStrings = Array.isArray(valid) ? valid.filter(v => v != null).map(String) : [];
  if (target !== null && !validStrings.includes(target)) {
    throw new Error(`Invalid replay resolution "${target}". Valid for this symbol/timeframe: ${validStrings.join(', ') || '(none — start replay / check symbol)'}, or "auto".`);
  }

  await evaluate(`${rp}.changeReplayResolution(${target === null ? 'null' : safeString(target)})`);

  const current = await evaluate(wv(`${rp}.currentReplayResolution()`));
  const auto = await evaluate(wv(`${rp}.autoReplayResolution()`));
  return {
    success: true,
    resolution: current,
    is_auto: current == null,
    auto_resolution: auto,
    valid_resolutions: validStrings,
  };
}

export async function stop({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) {
    return { success: true, action: 'already_stopped' };
  }
  await evaluate(`${rp}.stopReplay()`);
  // T113b (safe subset): best-effort return-to-realtime teardown. Mirrors what
  // TV's own UI does on replay exit and matches this tool's "return to realtime"
  // contract. try/catch-wrapped so it can NEVER change the stop result or throw —
  // it cannot regress the normal stop→start→step path. NOTE: this does not clear
  // the TV-side replay-session degradation that accumulates after ~4-5 start/stop
  // cycles in one session (that needs a Desktop restart — a TV-side limitation;
  // see FORK_NOTES §21). For long or repeated backtests, prefer backtest_pull
  // (headless, no replay session) over many replay_walk cycles.
  try { await evaluate(`${rp}.goToRealtime()`); } catch {}

  // VERIFY the stop actually took, instead of assuming it did.
  //
  // Measured on TV Desktop 3.3.0: from the SECOND start/stop cycle onward in a
  // single app session, stopReplay() has no effect but this function still
  // reported success — isReplayStarted() stays true. That silent lie is the
  // dangerous part, because a subsequent replay_walk then captures ONE bar and
  // returns success:true / truncated:false. A backtest built on that produces
  // confident numbers from a single bar with nothing anywhere saying so.
  //
  // The underlying session degradation is a TV-side limitation nobody has
  // solved (upstream #172 is a real but separate bug — awaiting selectDate did
  // NOT fix this, measured; upstream PR #306 loosened its e2e test to match
  // "the tool's actual (unverified) stop semantics"; this fork's T113b probed
  // the teardown API and closed it as a TV limitation). So we cannot make stop
  // succeed — but we CAN refuse to claim it did. Callers get a real signal and
  // can relaunch Desktop, which is the only known recovery.
  let stillStarted = true;
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 150));
    stillStarted = await evaluate(wv(`${rp}.isReplayStarted()`));
    if (!stillStarted) break;
  }
  if (stillStarted) {
    return {
      success: false,
      action: 'stop_failed',
      replay_still_started: true,
      error: 'replay_stop did not take: isReplayStarted() is still true after stopReplay(). '
           + 'TradingView\'s replay session is degraded (typically from the 2nd start/stop cycle '
           + 'onward in one app session). Recovery requires relaunching TradingView Desktop '
           + '(tv_launch with kill_existing:true). WARNING: replay_walk in this state silently '
           + 'returns a single bar with success:true — do not trust capture output until this clears.',
    };
  }
  return { success: true, action: 'replay_stopped' };
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
