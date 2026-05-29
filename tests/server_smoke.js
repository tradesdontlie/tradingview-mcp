// Boot src/server.js as a child via stdio, run MCP handshake, list tools,
// then call one new API-only tool (yahoo_price). Verifies the full pipeline
// without needing TradingView Desktop.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER = path.join(__dirname, '..', 'src', 'server.js');

const child = spawn(process.execPath, [SERVER], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env },
});

let buf = '';
const pending = new Map();

child.stdout.on('data', chunk => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch { /* skip non-JSON */ }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise(resolve => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const TIMEOUT_MS = 30_000;
function withTimeout(p, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${label}`)), TIMEOUT_MS)),
  ]);
}

async function run() {
  console.log('1. initialize ...');
  const init = await withTimeout(rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.1' },
  }), 'initialize');
  console.log('   server:', init.result?.serverInfo?.name, init.result?.serverInfo?.version);

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  console.log('2. tools/list ...');
  const list = await withTimeout(rpc('tools/list', {}), 'tools/list');
  const tools = list.result?.tools || [];
  console.log('   total tools:', tools.length);

  const newToolNames = [
    'yahoo_price', 'market_snapshot', 'bitcoin_market_pulse',
    'stock_extended_hours', 'stock_options_chain', 'stock_options_unusual_activity',
    'exchanges_list', 'financial_news', 'market_sentiment',
    'coin_analysis', 'multi_timeframe_analysis', 'volume_confirmation_analysis',
    'top_gainers', 'top_losers', 'bollinger_scan', 'rating_filter',
    'volume_breakout_scanner', 'smart_volume_scanner',
    'consecutive_candles_scan', 'advanced_candle_pattern',
    'multi_agent_analysis', 'combined_analysis',
    'egx_market_overview', 'egx_sector_scan', 'egx_sector_scanner',
    'egx_index_analysis', 'egx_stock_screener', 'egx_trade_plan',
    'egx_fibonacci_retracement',
    'backtest_strategy', 'compare_strategies', 'walk_forward_backtest_strategy',
    'hyperliquid_meta', 'hyperliquid_ticker', 'hyperliquid_orderbook',
    'hyperliquid_candles', 'hyperliquid_funding', 'hyperliquid_open_interest_history',
    'broker_status', 'broker_holdings', 'broker_positions', 'broker_orders',
    'broker_funds', 'broker_ltp', 'broker_markets',
    'subscribe_ticker', 'unsubscribe', 'list_subscriptions',
    'get_latest_tick', 'get_recent_ticks',
    'signal_register', 'signal_remove', 'signal_list', 'signal_active', 'signal_ack',
  ];
  const found = new Set(tools.map(t => t.name));
  const missing = newToolNames.filter(n => !found.has(n));
  console.log('   new tools expected:', newToolNames.length);
  console.log('   missing:', missing.length, missing.slice(0, 5).join(','));

  console.log('3. tools/call yahoo_price BTC-USD ...');
  const call = await withTimeout(rpc('tools/call', {
    name: 'yahoo_price',
    arguments: { symbol: 'BTC-USD' },
  }), 'yahoo_price call');
  const text = call.result?.content?.[0]?.text;
  console.log('   payload (truncated):', String(text).slice(0, 200));

  console.log('4. tools/call exchanges_list ...');
  const ex = await withTimeout(rpc('tools/call', {
    name: 'exchanges_list', arguments: {},
  }), 'exchanges_list call');
  console.log('   payload (truncated):', String(ex.result?.content?.[0]?.text).slice(0, 150));

  console.log('5. tools/call broker_status ...');
  const bs = await withTimeout(rpc('tools/call', {
    name: 'broker_status', arguments: {},
  }), 'broker_status call');
  console.log('   payload:', String(bs.result?.content?.[0]?.text).slice(0, 200));

  console.log('6. tools/call hyperliquid_ticker BTC ...');
  const hl = await withTimeout(rpc('tools/call', {
    name: 'hyperliquid_ticker', arguments: { coin: 'BTC' },
  }), 'hyperliquid_ticker call');
  console.log('   payload (truncated):', String(hl.result?.content?.[0]?.text).slice(0, 200));

  console.log('\nDONE');
  child.kill();
  process.exit(missing.length === 0 ? 0 : 1);
}

run().catch(err => {
  console.error('FAIL:', err.message);
  child.kill();
  process.exit(1);
});
