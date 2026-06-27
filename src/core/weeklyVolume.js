/**
 * Weekly volume baseline cache, sourced from yfinance (via weekly_volume_baseline.py)
 * instead of whatever bars TradingView happens to have buffered in CDP memory.
 *
 * Refreshes in the background every REFRESH_INTERVAL_MS. The regime agent's poll
 * loop never blocks on this except on cold start (no cache yet).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../../strategies/weekly_volume_baseline.py');

const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';

let cache = {};          // { 'MNQ=F': { '0': avgVol, ..., '23': avgVol, _samples: {...} } }
let lastRefresh = 0;
let refreshPromise = null;

/** TradingView symbol ("CME_MINI:MNQU2026", "COMEX_MINI:MGC1!") → Yahoo ticker ("MNQ=F") */
export function tvSymbolToYahoo(tvSymbol) {
  if (!tvSymbol) return null;
  const afterColon = tvSymbol.includes(':') ? tvSymbol.split(':')[1] : tvSymbol;
  const root = afterColon
    .replace(/[A-Z]\d{4}$/, '')   // strip month+year code, e.g. "U2026"
    .replace(/\d+!$/, '')         // strip continuous-contract suffix, e.g. "1!"
    .replace(/!$/, '');
  return root ? root + '=F' : null;
}

function runPython(tickers) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, [SCRIPT, tickers.join(',')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`weekly_volume_baseline.py exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error(`failed to parse baseline JSON: ${e.message}`)); }
    });
    proc.on('error', reject);
  });
}

export async function refreshBaselines(tvSymbols) {
  const tickers = [...new Set(tvSymbols.map(tvSymbolToYahoo).filter(Boolean))];
  if (tickers.length === 0) return cache;
  const result = await runPython(tickers);
  cache = { ...cache, ...result };
  lastRefresh = Date.now();
  return cache;
}

/** Refresh in the background; only blocks the caller on a cold cache (first call). */
export async function ensureFreshBaselines(tvSymbols) {
  const stale = Date.now() - lastRefresh > REFRESH_INTERVAL_MS;
  const coldStart = Object.keys(cache).length === 0;

  if ((stale || coldStart) && !refreshPromise) {
    refreshPromise = refreshBaselines(tvSymbols)
      .catch(err => { process.stderr.write(`[weeklyVolume] refresh failed: ${err.message}\n`); })
      .finally(() => { refreshPromise = null; });
  }

  if (coldStart && refreshPromise) await refreshPromise;
  return cache;
}

/** Look up the ratio of currentVolume vs the same-hour-of-week baseline for a symbol. */
export function getWeeklyRatio(tvSymbol, hourBucket, currentVolume) {
  const yahooTicker = tvSymbolToYahoo(tvSymbol);
  if (!yahooTicker) return null;
  const baseline = cache[yahooTicker];
  if (!baseline || baseline.error) return null;
  const avg     = baseline[String(hourBucket)];
  const samples = baseline._samples ? baseline._samples[String(hourBucket)] : 0;
  if (!avg || avg <= 0 || !samples || samples < 5) return null;
  return {
    ratio:    Math.round((currentVolume / avg) * 100) / 100,
    baseline: avg,
    samples:  samples,
  };
}

export function cacheStatus() {
  return { lastRefresh, tickers: Object.keys(cache), refreshing: !!refreshPromise };
}
