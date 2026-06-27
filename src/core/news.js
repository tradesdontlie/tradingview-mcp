/**
 * News aggregator cache — Trump/Iran/Fed/geopolitical headlines (Google News
 * RSS, no API key) + WTI/Brent oil price (yfinance). Refreshed periodically
 * in the background; the dashboard reads from this cache, never blocking.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../../strategies/news_aggregator.py');
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';

const REFRESH_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes — RSS sources don't update faster than this anyway

let cache = { topics: {}, oil: {} };
let lastRefresh = 0;
let refreshPromise = null;

function runPython() {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, [SCRIPT, '--max-per-topic', '5'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`news_aggregator.py exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error(`failed to parse news JSON: ${e.message}`)); }
    });
    proc.on('error', reject);
  });
}

export async function refreshNews() {
  const result = await runPython();
  cache = result;
  lastRefresh = Date.now();
  return cache;
}

export async function getNews() {
  const stale = Date.now() - lastRefresh > REFRESH_INTERVAL_MS;
  const coldStart = Object.keys(cache.topics || {}).length === 0;

  if ((stale || coldStart) && !refreshPromise) {
    refreshPromise = refreshNews()
      .catch(err => { process.stderr.write(`[news] refresh failed: ${err.message}\n`); })
      .finally(() => { refreshPromise = null; });
  }

  if (coldStart && refreshPromise) await refreshPromise;
  return { ...cache, _lastRefresh: lastRefresh };
}
