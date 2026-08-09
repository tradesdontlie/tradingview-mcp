import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const tickers = ['CTS', 'GMD', 'HCM', 'OCB', 'PET', 'POW', 'SAB', 'SHS', 'TPB', 'VCK', 'VND'];
const LOG = 'C:/Users/ADMIN/claude_os/data/batch_check_log.json';
const CHECK_ONE = 'C:/Users/ADMIN/tradingview-mcp/check_one.mjs';

// Attribution by ticker (not by line index): a failed ticker emits BATCH_ERROR with
// no DATA_JSON, so index mapping would assign the next ticker's payload to it.
// Keys are short names (payload.ticker / BATCH_ERROR ticker after ':') — this batch
// list is single-board HOSE, so short names are unique here.
export function buildResults(input, stdout, elapsed) {
  const byTicker = new Map();
  const short = value => String(value || '').split(':').pop().toUpperCase();
  for (const line of String(stdout || '').split('\n')) {
    if (line.startsWith('DATA_JSON:')) {
      try {
        const payload = JSON.parse(line.slice('DATA_JSON:'.length));
        const key = short(payload?.ticker);
        if (key) byTicker.set(key, { success: true, json: payload });
      } catch { /* malformed line: falls back to BATCH_ERROR/no-output attribution */ }
    } else if (line.startsWith('BATCH_ERROR ')) {
      const rest = line.slice('BATCH_ERROR '.length);
      const sep = rest.indexOf(': '); // ticker itself contains ':' -> separator is ': '
      const key = short(sep > -1 ? rest.slice(0, sep) : rest);
      if (key) byTicker.set(key, { success: false, error: sep > -1 ? rest.slice(sep + 2).trim() : 'unknown' });
    }
  }
  return input.map(ticker => {
    const entry = byTicker.get(short(ticker));
    return { ticker, elapsed, ...(entry || { success: false, error: 'no DATA_JSON output' }) };
  });
}

const IS_DIRECT = (process.argv[1] || '').replace(/\\/g, '/').endsWith('/batch_check.mjs');

if (IS_DIRECT) {
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

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const results = buildResults(tickers, stdout, elapsed);

  fs.writeFileSync(LOG, JSON.stringify(results, null, 2));
  for (const r of results) console.log(`${r.success ? 'OK' : 'FAIL'} ${r.ticker} (${r.elapsed}s)${r.error ? ': ' + r.error : ''}`);
  console.log(`\nDone. ${results.filter(r => r.success).length}/${results.length} OK. Log: ${LOG}`);
  process.exitCode = results.some(r => !r.success) ? 1 : 0;
}
