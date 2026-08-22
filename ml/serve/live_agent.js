/**
 * Polls ml/serve/predict.py for each configured symbol/timeframe target and
 * caches results in memory, mirroring dashboard-server.js's poll-cache-serve
 * pattern (background interval fills the cache; HTTP handlers only ever read it).
 *
 * Targets run strictly sequentially, never in parallel: predict.py drives the
 * *same* TradingView Desktop chart (switching symbol/timeframe live) via CDP,
 * so two overlapping predict.py runs would race and corrupt each other's reads.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const SYMBOLS_CONFIG = path.resolve(__dirname, '../config/symbols.json');
const MODELS_DIR = path.resolve(__dirname, '../models');
const PREDICTIONS_FILE = path.join(process.env.HOME, 'data', 'ml-predictions.json');
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';

let cache = {}; // `${symbol}_${timeframe}` -> prediction result
let lastError = {};
let pollInFlight = false;
let saveTimer = null;

function safeStem(symbol, timeframe) {
  return symbol.replace(/[:!]/g, '').replace('/', '_') + `_${timeframe}`;
}

function hasTrainedModel(symbol, timeframe) {
  const stem = safeStem(symbol, timeframe);
  return fs.existsSync(path.join(MODELS_DIR, `${stem}_long.txt`)) ||
    fs.existsSync(path.join(MODELS_DIR, `${stem}_short.txt`));
}

// Only timeframes with an actual trained model become their own dashboard
// target/card — everything else in symbols.json (e.g. 5m/60m kept purely as
// higher-timeframe context, never trained standalone) stays silent instead of
// showing a permanent "no model yet" placeholder. This also means predict.py
// never drives the live chart to a timeframe nobody's looking at, which cuts
// down on unnecessary symbol/timeframe switching on the shared chart. New
// targets appear automatically the moment a model gets trained — no need to
// touch this file when that happens.
function buildTargets() {
  const config = JSON.parse(fs.readFileSync(SYMBOLS_CONFIG, 'utf8'));
  const targets = [];
  for (const [symbol, symCfg] of Object.entries(config)) {
    if (symbol.startsWith('_')) continue;
    const tfs = Object.keys(symCfg.timeframes).sort((a, b) => Number(a) - Number(b));
    for (let i = 0; i < tfs.length; i++) {
      const timeframe = tfs[i];
      if (!hasTrainedModel(symbol, timeframe)) continue;
      targets.push({ symbol, timeframe, context: tfs.slice(i + 1) });
    }
  }
  return targets;
}

// predict.py now does real work per switch (chart_lock, switch_chart's own
// verification retries, bars_look_contaminated's retry-then-fail) — a full run
// with 2 context timeframes measured at ~50s on a cold symbol switch. 30s was
// killing every single poll before it could finish, which is why the dashboard
// was showing nothing but "timed out" errors. 120s gives real margin above the
// measured worst case rather than just barely clearing it.
const PREDICT_TIMEOUT_MS = 120_000;

// The underlying `tv` CLI hangs indefinitely (no internal timeout) when CDP/
// TradingView Desktop isn't reachable, so without a hard kill here one dead
// target would wedge every subsequent target and poll cycle forever.
function runPredict({ symbol, timeframe, context }) {
  return new Promise((resolve, reject) => {
    const args = ['-m', 'ml.serve.predict', '--symbol', symbol, '--timeframe', timeframe];
    if (context.length) args.push('--context', context.join(','));
    const proc = spawn(PYTHON_BIN, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, PREDICT_TIMEOUT_MS);
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`predict.py timed out after ${PREDICT_TIMEOUT_MS}ms (is TradingView Desktop connected?)`));
      if (code !== 0) return reject(new Error(stderr.trim() || `predict.py exited ${code}`));
      try {
        resolve(JSON.parse(stdout.trim().split('\n').pop()));
      } catch (err) {
        reject(new Error(`Failed to parse predict.py output: ${err.message}\n${stdout}`));
      }
    });
  });
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(path.dirname(PREDICTIONS_FILE), { recursive: true });
    fs.writeFileSync(PREDICTIONS_FILE, JSON.stringify({ ts: Date.now(), predictions: cache }, null, 2));
  }, 2000);
}

async function pollOnce() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const targets = buildTargets();
    for (const target of targets) {
      const key = `${target.symbol}_${target.timeframe}`;
      try {
        const result = await runPredict(target);
        cache[key] = { ...result, polled_at: Date.now() };
        delete lastError[key];
      } catch (err) {
        lastError[key] = { message: err.message, at: Date.now() };
        console.error(`[ml-agent] ${key} failed: ${err.message}`);
      }
    }
    scheduleSave();
  } finally {
    pollInFlight = false;
  }
}

export function startPolling({ intervalMs = 45_000 } = {}) {
  pollOnce();
  const timer = setInterval(pollOnce, intervalMs);
  return () => clearInterval(timer);
}

export function getCache() {
  return { predictions: cache, errors: lastError };
}
