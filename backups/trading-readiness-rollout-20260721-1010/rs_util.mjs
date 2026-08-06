/**
 * rs_util.mjs — Relative Strength vs VNINDEX (dung chung scan_live.mjs + check_one.mjs)
 * RS_20 = stockRet(20 bar) - indexRet(20 bar), tinh bang diem %. >0 = manh hon index (leader).
 * VNINDEX series cache o claude_os/data/vnindex_h6.json (scan_live ghi, check_one doc).
 */
import fs from 'fs';

const CACHE = 'C:/Users/ADMIN/claude_os/data/vnindex_h6.json';
const FRESH_MS = 36 * 3600 * 1000;   // cache qua 36h coi nhu cu -> RS null
export const VNINDEX_SYM = 'HOSE:VNINDEX';

export function writeVnindexCache(closes) {
  try { fs.writeFileSync(CACHE, JSON.stringify({ ts: Date.now(), closes })); } catch (e) {}
}
export function readVnindexCache() {
  try {
    const d = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    return { ...d, fresh: (Date.now() - (d.ts || 0)) < FRESH_MS };
  } catch (e) { return null; }
}

// stockBars: [{close,...}] cung TF; idxCloses: [number]. Tra { rs_20, leader, stock_ret_pct, index_ret_pct }.
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
