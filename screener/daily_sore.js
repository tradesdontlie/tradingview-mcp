/**
 * Performance-check orchestrator: ensure TradingView Desktop is up with CDP,
 * run the performance check against the most recent evening screening
 * (found automatically — not necessarily today's, e.g. Friday's on a
 * Monday), and print a text summary to stdout (no Excel for this report).
 * Meant to be invoked by the "performa-ihsg" scheduled task (17:00
 * weekdays); also runnable by hand.
 */
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { healthCheck, launch } from '../src/core/health.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function ensureTradingViewReady() {
  try {
    const health = await healthCheck();
    if (health?.cdp_connected) {
      console.log('TradingView already running with CDP — reusing existing session.');
      return;
    }
  } catch { /* not connected — fall through to launch */ }

  console.log('TradingView not reachable via CDP — launching it now...');
  const result = await launch({ kill_existing: false });
  if (!result?.success) {
    throw new Error(`Failed to launch TradingView: ${JSON.stringify(result)}`);
  }
  console.log(`Launched TradingView (pid ${result.pid}), CDP on port ${result.cdp_port}. Waiting for chart to settle...`);
  await new Promise(r => setTimeout(r, 8000));
}

async function main() {
  await ensureTradingViewReady();

  console.log('Menjalankan pengecekan performa akhir hari...');
  execFileSync(process.execPath, [join(__dirname, 'performance.js')], { stdio: 'inherit' });
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
