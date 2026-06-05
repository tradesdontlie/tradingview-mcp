#!/usr/bin/env node
/**
 * SessionStart hook: ensure TradingView is running and connected via CDP.
 * - Healthy: inject chart context into Claude's session.
 * - Not running: launch TV and wait for CDP.
 * - Running but API frozen: kill and relaunch.
 */
import { healthCheck, launch } from '../src/core/health.js';
import { execSync } from 'child_process';

async function run() {
  // First attempt
  let health = await tryHealth();

  if (health?.success && health.api_available) {
    respond({
      systemMessage: `TradingView connected — ${health.chart_symbol} ${health.chart_resolution}m`,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `TradingView is connected. Current chart: ${health.chart_symbol} on ${health.chart_resolution}m timeframe (chart type ${health.chart_type}).`,
      },
    });
    return;
  }

  if (health?.success && !health.api_available) {
    // CDP reachable but TV's chart API is unresponsive — restart
    try {
      execSync('pkill -f TradingView', { timeout: 5000 });
      await sleep(1500);
    } catch { /* may already be dead */ }
    health = await launchAndWait();
    respond({ systemMessage: health.msg });
    return;
  }

  // CDP not reachable — launch
  health = await launchAndWait();
  respond({ systemMessage: health.msg });
}

async function tryHealth() {
  try { return await healthCheck(); } catch { return null; }
}

async function launchAndWait() {
  try {
    await launch({});
    await sleep(3000);
    const h = await tryHealth();
    if (h?.api_available) {
      return { msg: `TradingView launched — ${h.chart_symbol} ${h.chart_resolution}m` };
    }
    return { msg: 'TradingView launched (chart still loading)' };
  } catch (err) {
    return { msg: `TradingView launch failed: ${err.message}` };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function respond(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

run().catch(err => respond({ systemMessage: `TV hook error: ${err.message}` }));
