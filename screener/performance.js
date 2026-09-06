/**
 * Performance check for the most recent evening screening: finds the latest
 * scan-YYYY-MM-DD.json under ./results (NOT necessarily today's — the
 * screening runs in the evening and this check runs the next trading day,
 * so on a Monday the most recent scan is Friday's), pulls each matched
 * stock's current price, and reports plus/minus % versus the price at
 * signal time, plus whether the plan's TP1/TP2/cutloss was touched.
 *
 * Uses a lighter, faster symbol-switch-and-read path than the full scanner:
 * this only needs one OHLC bar (not 500 bars of history for pattern
 * detection), so the generic setSymbol()/waitForChartReady() helpers'
 * conservative waits (500ms fixed delay + 200ms poll needing 2 consecutive
 * stable reads, up to 10s) are overkill here and were the dominant cost
 * per symbol.
 *
 * Usage: node screener/performance.js
 * Requires at least one prior screening run (screener/results/scan-*.json)
 * to already exist — run scan.js/daily.js first.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAsync, KNOWN_PATHS, safeString, disconnect } from '../src/connection.js';
import { generatePerformanceReport } from './report.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHART_API = KNOWN_PATHS.chartApi;
const BARS_PATH = KNOWN_PATHS.mainSeriesBars;

/**
 * Switch symbol and read just today's bar — one single evaluateAsync call,
 * with the poll loop living inside the page's own JS. Each Node<->CDP round
 * trip has its own latency, so driving the poll from Node (await evaluate()
 * in a loop) paid that latency on every single check; polling in-page costs
 * only a setTimeout tick.
 *
 * The readiness check and the data read happen in the SAME tick before
 * resolving — an earlier version split them into two round trips (resolve
 * once "ready", then a separate evaluate() to read the bar), which left a
 * race window: by the time the second call landed, bars.valueAt(lastIndex())
 * could momentarily return null even though size()>0 and the symbol already
 * matched (a transient state while the series finished swapping in new
 * data). Resolving only once the actual bar value is in hand closes that gap.
 */
async function fastReadTodayBar(symbol) {
  const ticker = symbol.includes(':') ? symbol.slice(symbol.lastIndexOf(':') + 1) : symbol;

  const bar = await evaluateAsync(`
    (function() {
      var chart = ${CHART_API};
      chart.setSymbol(${safeString(symbol)}, {});
      return new Promise(function(resolve, reject) {
        var tries = 0;
        (function check() {
          tries++;
          var sym = '';
          try { sym = chart.symbol(); } catch (e) {}
          // Re-fetch bars fresh each poll — don't trust a reference captured
          // before the symbol switch in case TradingView swaps the series
          // object on symbol change rather than mutating it in place.
          var bars = ${BARS_PATH};
          var hasBars = !!(bars && typeof bars.lastIndex === 'function' && bars.size() > 0);
          var v = null;
          if (hasBars) { try { v = bars.valueAt(bars.lastIndex()); } catch (e) {} }
          if (v && sym && sym.toUpperCase().indexOf(${safeString(ticker.toUpperCase())}) !== -1) {
            resolve({ time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0 });
          } else if (tries > 60) {
            reject(new Error('timeout waiting for symbol'));
          } else {
            setTimeout(check, 50);
          }
        })();
      });
    })()
  `);
  if (!bar) throw new Error(`Tidak bisa membaca bar hari ini untuk ${symbol}.`);
  return bar;
}

function statusFor(plan, high, low) {
  if (!plan) return 'n/a';
  if (plan.take_profit_2 != null && high >= plan.take_profit_2) return 'TP2 Tercapai';
  if (plan.take_profit_1 != null && high >= plan.take_profit_1) return 'TP1 Tercapai';
  if (plan.cutloss != null && low <= plan.cutloss) return 'Kena Cutloss';
  return 'Berjalan';
}

function findLatestScanFile() {
  const resultsDir = join(__dirname, 'results');
  const files = readdirSync(resultsDir)
    .filter(f => /^scan-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort() // ISO dates sort lexicographically in chronological order
    .reverse();
  if (files.length === 0) return null;
  return { path: join(resultsDir, files[0]), dateStr: files[0].slice(5, 15) };
}

async function main() {
  const latest = findLatestScanFile();
  if (!latest) {
    throw new Error(`Tidak ada hasil screening sebelumnya di ${join(__dirname, 'results')}. Jalankan daily.js/scan.js dulu sebelum cek performa.`);
  }

  const scan = JSON.parse(readFileSync(latest.path, 'utf8'));
  const jsonPath = latest.path;
  const scanDateStr = latest.dateStr;

  console.log(`Mengecek performa ${scan.results.length} saham dari screening tanggal ${scanDateStr}...`);

  const rows = [];
  const errors = [];
  const startedAt = Date.now();

  for (let i = 0; i < scan.results.length; i++) {
    const stock = scan.results[i];
    try {
      const todayBar = await fastReadTodayBar(`IDX:${stock.symbol}`);

      const signalPrice = stock.last_close;
      const changeRp = todayBar.close - signalPrice;
      const changePct = Math.round((changeRp / signalPrice) * 10000) / 100;

      for (const m of stock.matches) {
        rows.push({
          symbol: stock.symbol,
          criterion: m.criterion,
          signal_price: signalPrice,
          open: todayBar.open,
          high: todayBar.high,
          low: todayBar.low,
          close: todayBar.close,
          change_rp: Math.round(changeRp),
          change_pct: changePct,
          status: statusFor(m.plan, todayBar.high, todayBar.low),
        });
      }
    } catch (err) {
      errors.push({ symbol: stock.symbol, error: err.message });
    }

    if ((i + 1) % 25 === 0 || i === scan.results.length - 1) {
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(0);
      console.log(`[${i + 1}/${scan.results.length}] elapsed=${elapsedSec}s errors_so_far=${errors.length}`);
    }
  }

  const perf = {
    generated_at: new Date().toISOString(),
    scan_date: scanDateStr,
    source_scan: jsonPath,
    rows,
    errors,
  };

  const won = rows.filter(r => r.status.includes('TP')).length;
  const lost = rows.filter(r => r.status === 'Kena Cutloss').length;
  const running = rows.filter(r => r.status === 'Berjalan').length;
  const elapsedTotal = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(`\nDone. ${rows.length} sinyal dicek. TP tercapai: ${won}. Kena cutloss: ${lost}. Masih berjalan: ${running}. Error: ${errors.length}. Elapsed ${elapsedTotal}s.`);
  console.log('\n\n' + generatePerformanceReport(perf));
}

main()
  .catch(err => {
    console.error('FATAL:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await disconnect(); } catch { /* already gone */ }
  });
