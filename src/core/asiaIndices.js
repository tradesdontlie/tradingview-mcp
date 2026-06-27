/**
 * Asian index cache (Hang Seng, Nikkei 225, KOSPI), sourced from yfinance.
 * A large overnight drop in any of these during Asia hours can spill over
 * into MNQ/ES before NY open — refreshed periodically in the background.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../../strategies/asia_indices.py');
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';

const REFRESH_INTERVAL_MS = 60 * 1000; // 1 minute — close to real-time without hammering yfinance
const DROP_THRESHOLD = -1.5;

let cache = {};
let lastRefresh = 0;
let refreshPromise = null;

function runPython() {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, [SCRIPT, '--drop-threshold', String(DROP_THRESHOLD)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`asia_indices.py exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error(`failed to parse asia indices JSON: ${e.message}`)); }
    });
    proc.on('error', reject);
  });
}

export async function refreshAsiaIndices() {
  const result = await runPython();
  cache = result;
  lastRefresh = Date.now();
  return cache;
}

export async function getAsiaIndices() {
  const stale = Date.now() - lastRefresh > REFRESH_INTERVAL_MS;
  const coldStart = Object.keys(cache).length === 0;

  if ((stale || coldStart) && !refreshPromise) {
    refreshPromise = refreshAsiaIndices()
      .catch(err => { process.stderr.write(`[asiaIndices] refresh failed: ${err.message}\n`); })
      .finally(() => { refreshPromise = null; });
  }

  if (coldStart && refreshPromise) await refreshPromise;
  return { ...cache, _lastRefresh: lastRefresh };
}
