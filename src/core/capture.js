/**
 * Core screenshot/capture logic.
 */
import { getClient as _getClient, evaluate as _evaluate, getChartCollection as _getChartCollection } from '../connection.js';
import { writeFile, mkdir, readdir, stat, unlink } from 'fs/promises';
import { mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(dirname(dirname(__dirname)), 'screenshots');

// Default retention policy: keep recent screenshots so the report pipeline's
// run artifacts persist, but bound the directory so it doesn't grow forever.
const DEFAULT_MAX_FILES = 50;
const DEFAULT_MAX_AGE_DAYS = 7;

// Ensure the screenshot dir exists once at module load (out of any hot path).
mkdirSync(SCREENSHOT_DIR, { recursive: true });

export { SCREENSHOT_DIR };

function _resolve(deps) {
  return {
    getClient: deps?.getClient || _getClient,
    evaluate: deps?.evaluate || _evaluate,
    getChartCollection: deps?.getChartCollection || _getChartCollection,
  };
}

/**
 * Reduce a caller-supplied filename to a traversal-safe basename.
 * Strips any path segments (so `..\..\etc\hosts` cannot escape SCREENSHOT_DIR)
 * and restricts the remaining characters to an allowlist of
 * alphanumeric / `-` / `_` / `.`. Returns a non-empty fallback if nothing
 * survives sanitization.
 */
export function safeScreenshotName(name) {
  const base = basename(String(name == null ? '' : name));
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_');
  // Collapse any leading dots so a name like "..." can't resolve to a dotfile
  // or empty segment; ensure we always return something usable.
  const stripped = cleaned.replace(/^\.+/, '');
  return stripped.length > 0 ? stripped : 'screenshot';
}

/**
 * Prune old PNG screenshots in `dir` beyond the configured bounds.
 * Removes files (oldest first) until BOTH the file-count and total-bytes
 * caps are satisfied, and also removes any file older than `maxAgeDays`.
 * Bounds are optional; pass null/undefined to disable a given bound.
 * Exported and dir-parameterized so it's testable against a temp dir.
 *
 * @returns {Promise<{removed: string[]}>} basenames of removed files
 */
export async function pruneScreenshots({
  dir = SCREENSHOT_DIR,
  maxFiles = DEFAULT_MAX_FILES,
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  maxBytes = null,
} = {}) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return { removed: [] };
  }

  const pngs = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.png')) continue;
    const full = join(dir, entry);
    try {
      const st = await stat(full);
      if (st.isFile()) pngs.push({ name: entry, full, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // ignore files that vanished or can't be stat'd
    }
  }

  // Oldest first so we drop the stalest screenshots when over a bound.
  pngs.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const toRemove = new Set();

  // Age bound.
  if (maxAgeDays != null && Number.isFinite(maxAgeDays) && maxAgeDays >= 0) {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    for (const f of pngs) {
      if (f.mtimeMs < cutoff) toRemove.add(f.full);
    }
  }

  // Count bound.
  if (maxFiles != null && Number.isFinite(maxFiles) && maxFiles >= 0) {
    const survivors = pngs.filter(f => !toRemove.has(f.full));
    const overflow = survivors.length - maxFiles;
    for (let i = 0; i < overflow; i++) toRemove.add(survivors[i].full);
  }

  // Total-bytes bound (optional).
  if (maxBytes != null && Number.isFinite(maxBytes) && maxBytes >= 0) {
    const survivors = pngs.filter(f => !toRemove.has(f.full));
    let total = survivors.reduce((acc, f) => acc + f.size, 0);
    for (const f of survivors) {
      if (total <= maxBytes) break;
      toRemove.add(f.full);
      total -= f.size;
    }
  }

  const removed = [];
  for (const f of pngs) {
    if (!toRemove.has(f.full)) continue;
    try {
      await unlink(f.full);
      removed.push(f.name);
    } catch {
      // ignore; file may already be gone
    }
  }
  return { removed };
}

export async function captureScreenshot({
  region,
  filename,
  method,
  persist = true,
  max_files,
  max_age_days,
  max_bytes,
  _deps,
} = {}) {
  const { getClient, evaluate, getChartCollection } = _resolve(_deps);
  await mkdir(SCREENSHOT_DIR, { recursive: true });

  // Build the default timestamp name first, then sanitize the final filename.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fname = safeScreenshotName(filename || `tv_${region}_${ts}`);
  const filePath = join(SCREENSHOT_DIR, `${fname}.png`);

  if (method === 'api') {
    try {
      const colPath = await getChartCollection();
      await evaluate(`${colPath}.takeScreenshot()`);
      return {
        success: true, method: 'api',
        note: 'takeScreenshot() triggered — TradingView will save/show the screenshot via its own UI',
      };
    } catch {
      // Fall through to CDP method
    }
  }

  const client = await getClient();
  let clip = undefined;

  if (region === 'chart') {
    const bounds = await evaluate(`
      (function() {
        var el = document.querySelector('[data-name="pane-canvas"]')
          || document.querySelector('[class*="chart-container"]')
          || document.querySelector('canvas');
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()
    `);
    if (bounds) clip = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale: 1 };
  } else if (region === 'strategy_tester') {
    const bounds = await evaluate(`
      (function() {
        var el = document.querySelector('[data-name="backtesting"]')
          || document.querySelector('[class*="strategyReport"]');
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()
    `);
    if (bounds) clip = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale: 1 };
  }

  const params = { format: 'png' };
  if (clip) params.clip = clip;

  const { data } = await client.Page.captureScreenshot(params);
  // Decode the base64 payload exactly once; reuse the buffer for both the
  // async write and the reported byte size.
  const buffer = Buffer.from(data, 'base64');
  await writeFile(filePath, buffer);

  const result = {
    success: true, method: 'cdp', file_path: filePath, region,
    size_bytes: buffer.length,
  };

  // Enforce retention after a successful capture. A non-persistent capture
  // removes its own artifact once written (caller already has the path/size).
  if (persist === false) {
    try { await unlink(filePath); } catch {}
    result.persisted = false;
  } else {
    result.persisted = true;
    const pruned = await pruneScreenshots({
      maxFiles: max_files != null ? max_files : DEFAULT_MAX_FILES,
      maxAgeDays: max_age_days != null ? max_age_days : DEFAULT_MAX_AGE_DAYS,
      maxBytes: max_bytes != null ? max_bytes : null,
    });
    if (pruned.removed.length) result.pruned = pruned.removed.length;
  }

  return result;
}
