/**
 * Daily orchestrator: ensure TradingView Desktop is up with CDP, run the
 * full IHSG scan, and print a Markdown report + Excel path to stdout. Meant
 * to be invoked by the "screening-ihsg" scheduled task (18:00 weekdays);
 * also runnable by hand.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { healthCheck, launch } from '../src/core/health.js';
import { generateReport } from './report.js';

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

  console.log('Running full IHSG scan...');
  execFileSync(process.execPath, [join(__dirname, 'scan.js')], { stdio: 'inherit' });

  const dateStr = new Date().toISOString().slice(0, 10);
  const jsonPath = join(__dirname, 'results', `scan-${dateStr}.json`);
  const excelPath = join(__dirname, 'results', `scan-${dateStr}.xlsx`);
  const scan = JSON.parse(readFileSync(jsonPath, 'utf8'));

  const report = generateReport(scan);
  console.log('\n\n' + report);
  console.log(`\nFile Excel hasil screening: ${excelPath}`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
