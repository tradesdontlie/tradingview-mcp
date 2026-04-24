/**
 * Smoke test for integration branch — exercises modified tools live against
 * the running TradingView Desktop. Read-only where possible; alerts are
 * tested via create+delete round-trip with a sentinel price.
 *
 * Run: node tests/smoke-live.mjs
 * Requires: TradingView Desktop running with --remote-debugging-port=9222
 */
import { connect, evaluate, evaluateAsync, getChartApi, disconnect } from '../src/connection.js';
import * as drawing from '../src/core/drawing.js';
import * as alerts from '../src/core/alerts.js';
import * as watchlist from '../src/core/watchlist.js';
import * as hotlist from '../src/core/hotlist.js';
import * as data from '../src/core/data.js';

const drawDeps = { _deps: { evaluate, evaluateAsync, getChartApi } };
const results = [];

function record(name, ok, detail) {
  const status = ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m';
  console.log(`${status} ${name}${detail ? `  — ${detail}` : ''}`);
  results.push({ name, ok, detail });
}

async function main() {
  console.log('Connecting to TradingView CDP at localhost:9222 ...');
  await connect();
  console.log('Connected.\n');

  // 1. alert_list (REST)
  let baselineAlertCount = 0;
  try {
    const r = await alerts.list();
    baselineAlertCount = r?.alert_count || 0;
    record('alert_list (REST)', r?.success === true, `count=${baselineAlertCount}, source=${r?.source}`);
  } catch (e) {
    record('alert_list (REST)', false, e.message);
  }

  // 2. alert_create REST (sentinel — far from current price)
  let createdId = null;
  try {
    const r = await alerts.create({ condition: 'crossing', price: 999999, message: 'smoke-test sentinel 999999' });
    createdId = r?.alert_id || r?.id || null;
    record('alert_create REST', r?.success === true && createdId, `id=${createdId}, source=${r?.source}`);
  } catch (e) {
    record('alert_create REST', false, e.message);
  }

  // 3. alert_delete REST cleanup
  if (createdId) {
    try {
      const r = await alerts.deleteAlerts({ alert_id: createdId });
      record('alert_delete REST cleanup', r?.success === true, `deleted=${r?.deleted_count}`);
    } catch (e) {
      record('alert_delete REST cleanup', false, e.message);
    }
  } else {
    record('alert_delete REST cleanup', false, 'skipped: no alert created');
  }

  // 4. watchlist.get (lazy-render fix)
  try {
    const r = await watchlist.get();
    const count = r?.symbols?.length || r?.count || 0;
    record('watchlist.get with lazy-render fix', r?.success === true, `symbols=${count}`);
  } catch (e) {
    record('watchlist.get with lazy-render fix', false, e.message);
  }

  // 5. hotlist.getHotlist (new tool, hits scanner.tradingview.com)
  try {
    const r = await hotlist.getHotlist({ slug: 'volume_gainers', limit: 5 });
    record('hotlist.getHotlist volume_gainers', r?.success === true && Array.isArray(r?.symbols), `got ${r?.symbols?.length || 0} symbols, total_count=${r?.total_count}`);
  } catch (e) {
    record('hotlist.getHotlist volume_gainers', false, e.message);
  }

  // 6. hotlist.getHotlist with bad slug (input validation)
  try {
    const r = await hotlist.getHotlist({ slug: 'bogus_slug' });
    record('hotlist input validation rejects bad slug', r?.success === false && r?.error?.includes('Unknown slug'), r?.error?.slice(0, 80));
  } catch (e) {
    record('hotlist input validation rejects bad slug', false, e.message);
  }

  // 7. data.getQuote — current chart symbol (no symbol arg)
  try {
    const r = await data.getQuote({});
    record('data.getQuote current chart', r?.success === true && Number.isFinite(r?.last || r?.close), `symbol=${r?.symbol}, last=${r?.last ?? r?.close}, source=${r?.source || 'chart'}`);
  } catch (e) {
    record('data.getQuote current chart', false, e.message);
  }

  // 8. data.getQuote — cross-symbol via scanner REST (the T35 fix)
  try {
    const r = await data.getQuote({ symbol: 'NASDAQ:NVDA' });
    record('data.getQuote cross-symbol (NVDA via REST)', r?.success === true && Number.isFinite(r?.last || r?.close), `last=${r?.last ?? r?.close}, source=${r?.source || 'unknown'}`);
  } catch (e) {
    record('data.getQuote cross-symbol (NVDA via REST)', false, e.message);
  }

  // 9. drawing.drawShape — well-formed (uses current chart price for y-coord)
  let validShapePrice = null;
  try {
    const q = await data.getQuote({});
    validShapePrice = q?.last ?? q?.close;
  } catch {}
  if (Number.isFinite(validShapePrice)) {
    try {
      const r = await drawing.drawShape({ ...drawDeps, shape: 'horizontal_line', point: { time: Math.floor(Date.now() / 1000), price: validShapePrice * 0.95 } });
      if (r?.success === true && r?.entity_id) {
        record('drawing.drawShape valid call', true, `created ${r.entity_id} at price ${(validShapePrice * 0.95).toFixed(2)}`);
        try { await drawing.removeOne({ ...drawDeps, entity_id: r.entity_id }); } catch {}
      } else {
        record('drawing.drawShape valid call', false, JSON.stringify(r).slice(0, 120));
      }
    } catch (e) {
      record('drawing.drawShape valid call', false, e.message);
    }
  } else {
    record('drawing.drawShape valid call', false, 'could not get current price');
  }

  // 10. drawing.drawShape — silent failure detection (deliberately bad shape)
  try {
    const r = await drawing.drawShape({ ...drawDeps, shape: 'horizontal_line_typo_invalid', point: { time: Math.floor(Date.now() / 1000), price: validShapePrice || 100 } });
    if (r?.success === false && r?.entity_id === null && r?.error?.includes('createShape returned no new entity')) {
      record('drawing.drawShape silent-failure detection', true, `correctly returned success:false`);
    } else {
      record('drawing.drawShape silent-failure detection', false, `expected success:false but got: ${JSON.stringify(r).slice(0, 120)}`);
      // Cleanup if a shape was actually created
      if (r?.entity_id) { try { await drawing.removeOne({ ...drawDeps, entity_id: r.entity_id }); } catch {} }
    }
  } catch (e) {
    record('drawing.drawShape silent-failure detection', false, e.message);
  }

  await disconnect();

  console.log('\n--- Summary ---');
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`${passed}/${results.length} passed${failed ? `, ${failed} failed` : ''}`);
  if (failed > 0) {
    console.log('\nFailures:');
    results.filter(r => !r.ok).forEach(r => console.log(`  - ${r.name}: ${r.detail}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Smoke test crashed:', err);
  process.exit(2);
});
