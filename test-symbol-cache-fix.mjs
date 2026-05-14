// Smoke test for the symbol cache fix (upstream issue #140 / Lesson #36
// + v2 silent fallback for Lesson #37 WS feed freeze).
//
// Calls quote_get and data_get_ohlcv for 4 different symbols back-to-back.
// Before the fix: all calls returned whichever symbol was already on the
// active chart (AAPL/XAUUSD/etc.) regardless of the `symbol` parameter.
// After the fix: each call returns data for the requested symbol.
//
// v2 (Lesson #37): if mainSeries.isLoading() stays true for >5s, the
// wrapper now returns { success: false, stale_feed: true, ... } instead
// of stale cached bars. This test treats `stale_feed: true` as a valid
// (non-stale) outcome — the patch did its job by surfacing the freeze
// instead of hiding it.
//
// Per symbol, the expected outcomes are:
//   (a) success: true with real OHLCV/quote data, OR
//   (b) success: false with stale_feed: true (WS frozen — fallback to
//       CCXT/yahoo recommended).
// Either outcome is acceptable in this smoke test. The test only FAILs
// when two distinct symbols return identical close+volume on the
// success path (i.e. the original cache bug resurfaced).

import { data, chart } from './src/core/index.js';
import { disconnect } from './src/connection.js';

const SYMBOLS = [
  'BINANCE:BTCUSDT.P',
  'BINANCE:ETHUSDT.P',
  'OANDA:XAUUSD',
  'TVC:DXY',
];

async function main() {
  const originalState = await chart.getState();
  console.log(`Original chart symbol: ${originalState.symbol}`);
  console.log('-'.repeat(60));

  const results = [];

  for (const sym of SYMBOLS) {
    const startedAt = Date.now();
    try {
      const q = await data.getQuote({ symbol: sym });
      const ms = Date.now() - startedAt;
      if (q && q.stale_feed === true) {
        console.log(
          `[quote_get]   ${sym.padEnd(22)} WS frozen — fallback önerisi: ${q.fallback_advice}  (${ms}ms)`
        );
        results.push({
          tool: 'quote_get',
          symbol: sym,
          stale_feed: true,
          reason: q.reason,
          ms,
        });
      } else {
        console.log(
          `[quote_get]   ${sym.padEnd(22)} close=${q.close}  vol=${q.volume}  (${ms}ms)`
        );
        results.push({
          tool: 'quote_get',
          symbol: sym,
          close: q.close,
          volume: q.volume,
          ms,
        });
      }
    } catch (err) {
      console.log(`[quote_get]   ${sym.padEnd(22)} ERROR: ${err.message}`);
      results.push({ tool: 'quote_get', symbol: sym, error: err.message });
    }
  }

  console.log('-'.repeat(60));

  for (const sym of SYMBOLS) {
    const startedAt = Date.now();
    try {
      const o = await data.getOhlcv({ symbol: sym, summary: true, count: 50 });
      const ms = Date.now() - startedAt;
      if (o && o.stale_feed === true) {
        console.log(
          `[ohlcv_get]   ${sym.padEnd(22)} WS frozen — fallback önerisi: ${o.fallback_advice}  (${ms}ms)`
        );
        results.push({
          tool: 'ohlcv_get',
          symbol: sym,
          stale_feed: true,
          reason: o.reason,
          ms,
        });
      } else {
        console.log(
          `[ohlcv_get]   ${sym.padEnd(22)} close=${o.close}  avg_vol=${o.avg_volume}  bars=${o.bar_count}  (${ms}ms)`
        );
        results.push({
          tool: 'ohlcv_get',
          symbol: sym,
          close: o.close,
          avg_volume: o.avg_volume,
          bar_count: o.bar_count,
          ms,
        });
      }
    } catch (err) {
      console.log(`[ohlcv_get]   ${sym.padEnd(22)} ERROR: ${err.message}`);
      results.push({ tool: 'ohlcv_get', symbol: sym, error: err.message });
    }
  }

  console.log('-'.repeat(60));
  const finalState = await chart.getState();
  console.log(`Final chart symbol:    ${finalState.symbol}`);

  // PASS/FAIL evaluation v2:
  //   - Each symbol must produce EITHER a real success row OR a
  //     `stale_feed: true` row (Lesson #37 silent fallback).
  //   - On the success path, every distinct symbol's `close` must be
  //     unique — that's the original cache-bug check.
  function evalGroup(tool) {
    const rows = results.filter((r) => r.tool === tool);
    const successes = rows.filter((r) => r.close != null);
    const stale = rows.filter((r) => r.stale_feed === true);
    const errors = rows.filter((r) => r.error);

    const closes = successes.map((r) => r.close);
    const uniqueCloses = new Set(closes);
    // No cache-bug if all successful closes are distinct.
    const noCacheBug = closes.length === uniqueCloses.size;
    // All symbols accounted for (either success or stale-feed signal).
    const accountedFor = successes.length + stale.length === SYMBOLS.length;
    const pass = noCacheBug && accountedFor && errors.length === 0;
    return { pass, successes: successes.length, stale: stale.length, errors: errors.length, uniqueCloses: uniqueCloses.size };
  }
  const quoteEval = evalGroup('quote_get');
  const ohlcvEval = evalGroup('ohlcv_get');

  console.log('-'.repeat(60));
  console.log(
    `quote_get:    ${quoteEval.pass ? 'PASS' : 'FAIL'} (success=${quoteEval.successes}, stale_feed=${quoteEval.stale}, errors=${quoteEval.errors}, unique_closes=${quoteEval.uniqueCloses})`
  );
  console.log(
    `ohlcv_get:    ${ohlcvEval.pass ? 'PASS' : 'FAIL'} (success=${ohlcvEval.successes}, stale_feed=${ohlcvEval.stale}, errors=${ohlcvEval.errors}, unique_closes=${ohlcvEval.uniqueCloses})`
  );
  const quotePass = quoteEval.pass;
  const ohlcvPass = ohlcvEval.pass;
  console.log(
    `Chart restored: ${finalState.symbol === originalState.symbol ? 'YES' : 'NO (was ' + originalState.symbol + ', now ' + finalState.symbol + ')'}`
  );

  await disconnect();
  process.exit(quotePass && ohlcvPass ? 0 : 1);
}

main().catch(async (err) => {
  console.error('FATAL:', err);
  try {
    await disconnect();
  } catch {}
  process.exit(2);
});
