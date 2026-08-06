const { execFileSync } = require('child_process');
const fs = require('fs');

const tickers = ['CTS', 'GMD', 'HCM', 'OCB', 'PET', 'POW', 'SAB', 'SHS', 'TPB', 'VCK', 'VND'];
const LOG = 'C:/Users/ADMIN/claude_os/data/batch_check_log.json';
const CHECK_ONE = 'C:/Users/ADMIN/tradingview-mcp/check_one.mjs';

// Single-process batch: one CDP connection, one chart lock, restore once at the end.
const start = Date.now();
let stdout = '';
try {
  stdout = execFileSync(process.execPath,
    [CHECK_ONE, '--batch', ...tickers.map(t => `HOSE:${t}`), '360'],
    { timeout: 120000 * tickers.length, encoding: 'utf-8' });
} catch (e) {
  stdout = `${e.stdout || ''}\n${e.stderr || ''}`;
}

const lines = stdout.split('\n');
const dataLines = lines.filter(l => l.startsWith('DATA_JSON:')).map(l => l.slice('DATA_JSON:'.length));
const errorLines = lines.filter(l => l.startsWith('BATCH_ERROR ')).map(l => l.slice('BATCH_ERROR '.length));

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
const results = tickers.map((ticker, i) => {
  const line = dataLines[i];
  if (line !== undefined) {
    try {
      return { ticker, success: true, elapsed, json: JSON.parse(line) };
    } catch (e) {
      return { ticker, success: false, elapsed, error: 'malformed DATA_JSON' };
    }
  }
  return { ticker, success: false, elapsed, error: errorLines[i] || 'no DATA_JSON output' };
});

fs.writeFileSync(LOG, JSON.stringify(results, null, 2));
for (const r of results) console.log(`${r.success ? 'OK' : 'FAIL'} ${r.ticker} (${r.elapsed}s)${r.error ? ': ' + r.error : ''}`);
console.log(`\nDone. ${results.filter(r => r.success).length}/${results.length} OK. Log: ${LOG}`);
process.exitCode = results.some(r => !r.success) ? 1 : 0;
