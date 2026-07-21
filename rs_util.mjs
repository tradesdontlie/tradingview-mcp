/** Relative-strength cache with an explicit, injectable destination. */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CACHE = process.env.CHECK_DATA_ROOT
  ? path.join(process.env.CHECK_DATA_ROOT, 'vnindex_h6.json')
  : null;
const FRESH_MS = 36 * 3600 * 1000;
export const VNINDEX_SYM = 'HOSE:VNINDEX';

function cachePath(cache = DEFAULT_CACHE) {
  if (!cache) throw new Error('CHECK_DATA_ROOT or an explicit cache path is required');
  return cache;
}

export function writeVnindexCache(closes, cache) {
  const target = cachePath(cache);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ ts: Date.now(), closes }), 'utf8');
}

export function readVnindexCache(cache) {
  try {
    const d = JSON.parse(fs.readFileSync(cachePath(cache), 'utf8'));
    return { ...d, fresh: (Date.now() - (d.ts || 0)) < FRESH_MS };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function computeRS(stockBars, idxCloses, lookback = 20) {
  if (!stockBars || stockBars.length <= lookback || !idxCloses || idxCloses.length <= lookback)
    return { rs_20: null, leader: null, note: 'thieu data' };
  const sNow = stockBars[stockBars.length - 1].close;
  const sPast = stockBars[stockBars.length - 1 - lookback].close;
  const iNow = idxCloses[idxCloses.length - 1];
  const iPast = idxCloses[idxCloses.length - 1 - lookback];
  if (!sPast || !iPast || !sNow || !iNow) return { rs_20: null, leader: null, note: 'thieu data' };
  const sRet = (sNow / sPast - 1) * 100;
  const iRet = (iNow / iPast - 1) * 100;
  const rs = Math.round((sRet - iRet) * 10) / 10;
  return { rs_20: rs, leader: rs > 0, stock_ret_pct: Math.round(sRet * 10) / 10, index_ret_pct: Math.round(iRet * 10) / 10 };
}
