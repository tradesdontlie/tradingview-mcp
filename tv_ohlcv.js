#!/usr/bin/env node
/**
 * tv_ohlcv.js — ดึง OHLCV bars จาก TradingView Desktop ผ่าน CDP
 * Usage: node tv_ohlcv.js <symbol> <timeframe> [count]
 *   symbol    — เช่น BTCUSDT
 *   timeframe — TradingView resolution: 1, 5, 15, 30, 60, 240, D
 *   count     — จำนวน bars (default 200, max 500)
 * Output: JSON to stdout
 *   { success: true, symbol, timeframe, bars: [{time,open,high,low,close,volume},...] }
 *   { success: false, error: "..." }
 */

import { setSymbol, setTimeframe } from './src/core/chart.js';
import { evaluate, evaluateAsync, KNOWN_PATHS } from './src/connection.js';

const BARS_PATH = KNOWN_PATHS.mainSeriesBars;

const [,, symbol, timeframe, countArg] = process.argv;

if (!symbol || !timeframe) {
  process.stdout.write(JSON.stringify({
    success: false,
    error: 'Usage: node tv_ohlcv.js <symbol> <timeframe> [count]'
  }) + '\n');
  process.exit(1);
}

const count = Math.min(parseInt(countArg || '200', 10), 500);

async function fetchBars() {
  // สลับ symbol + timeframe แล้วรอ chart โหลด
  await setSymbol({ symbol });
  await setTimeframe({ timeframe });

  // รอให้ bars โหลดเสร็จ (retry สูงสุด 10 ครั้ง x 500ms)
  let bars = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const result = await evaluate(`
        (function() {
          var bars = ${BARS_PATH};
          if (!bars || typeof bars.lastIndex !== 'function') return null;
          var end   = bars.lastIndex();
          var start = Math.max(bars.firstIndex(), end - ${count} + 1);
          var out   = [];
          for (var i = start; i <= end; i++) {
            var v = bars.valueAt(i);
            if (v) out.push({ time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0 });
          }
          return out.length > 0 ? out : null;
        })()
      `);
      if (result && result.length > 0) {
        bars = result;
        break;
      }
    } catch { /* ยังโหลดไม่เสร็จ */ }
  }

  if (!bars) throw new Error(`No bars loaded for ${symbol} ${timeframe} after retries`);
  return bars;
}

fetchBars()
  .then(bars => {
    process.stdout.write(JSON.stringify({ success: true, symbol, timeframe, bar_count: bars.length, bars }) + '\n');
    process.exit(0);
  })
  .catch(err => {
    process.stdout.write(JSON.stringify({ success: false, symbol, timeframe, error: err.message }) + '\n');
    process.exit(1);
  });
