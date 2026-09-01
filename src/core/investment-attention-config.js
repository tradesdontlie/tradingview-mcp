import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INVESTMENT_ATTENTION_CONFIG_SCHEMA_VERSION = 'investment-attention-monitoring-config/v1';

export const METALS_WATCHLIST_SYMBOLS = Object.freeze([
  'CBOE:GVX', 'AMEX:GMET', 'TSX:AII', 'LSE:0MKJ', 'NYSE:ATI', 'AMEX:BATT',
  'NYSE:CCJ', 'LSE:COPA', 'NASDAQ:COPP', 'AMEX:COPX', 'AMEX:GLD', 'COMEX:HG1!',
  'NASDAQ:ICOP', 'ASX:ILU', 'AMEX:LIT', 'NASDAQ:LITP', 'NASDAQ:METL', 'NASDAQ:NIKL',
  'LSE:PHPD', 'AMEX:PLG', 'AMEX:PPLT', 'LSE:REGB', 'NYSE:RIO', 'NASDAQ:SETM',
  'AMEX:SLV', 'ASX:TGN', 'AMEX:URA', 'SIX:URNU', 'COMEX:UX1!', 'FX_IDC:XAGUSD',
  'FX_IDC:XAUUSD', 'FX_IDC:XPDUSD', 'FX_IDC:XPTUSD',
]);

export const FEED_SUBSTITUTIONS = Object.freeze([
  Object.freeze({
    source_symbol: 'CBOE:GVX',
    runtime_symbol: 'FRED:GVZCLS',
    type: 'same-index-delayed-fallback',
    reason: 'Direct CBOE:GVX alert access is unavailable; FRED:GVZCLS is the delayed TradingView series for the same CBOE Gold ETF Volatility Index.',
  }),
  Object.freeze({
    source_symbol: 'AMEX:GMET',
    runtime_symbol: 'BATS:EMET',
    type: 'corrected-successor-and-feed',
    reason: 'The active metals ETF is EMET and TradingView accepted the BATS feed.',
  }),
  Object.freeze({
    source_symbol: 'TSX:AII',
    runtime_symbol: 'ASX_DLY:AII',
    type: 'corrected-exchange',
    reason: 'Almonty Industries is available as AII on the ASX delayed TradingView feed; the stale TSX identifier was rejected.',
  }),
]);

// These are the canonical TradingView feed identities already present in the
// accepted live RSI alert inputs. The three stale source feeds above remain
// the only explicit substitutions; the remaining rows are exchange/feed
// canonicalizations needed to make the 33 x D/W route receipt exact.
export const FEED_RUNTIME_CANONICALIZATIONS = Object.freeze([
  ['CBOE:GVX', 'FRED:GVZCLS'], ['AMEX:GMET', 'BATS:EMET'], ['TSX:AII', 'ASX_DLY:AII'],
  ['LSE:0MKJ', 'LSE_DLY:0MKJ'], ['NYSE:ATI', 'BATS:ATI'], ['AMEX:BATT', 'BATS:BATT'],
  ['NYSE:CCJ', 'BATS:CCJ'], ['LSE:COPA', 'LSE_DLY:COPA'], ['NASDAQ:COPP', 'BATS:COPP'],
  ['AMEX:COPX', 'BATS:COPX'], ['AMEX:GLD', 'BATS:GLD'], ['COMEX:HG1!', 'COMEX_DL:HG1!'],
  ['NASDAQ:ICOP', 'BATS:ICOP'], ['ASX:ILU', 'ASX_DLY:ILU'], ['AMEX:LIT', 'BATS:LIT'],
  ['NASDAQ:LITP', 'BATS:LITP'], ['NASDAQ:METL', 'BATS:METL'], ['NASDAQ:NIKL', 'BATS:NIKL'],
  ['LSE:PHPD', 'LSE_DLY:PHPD'], ['AMEX:PLG', 'BATS:PLG'], ['AMEX:PPLT', 'BATS:PPLT'],
  ['LSE:REGB', 'LSE_DLY:REGB'], ['NYSE:RIO', 'BATS:RIO'], ['NASDAQ:SETM', 'BATS:SETM'],
  ['AMEX:SLV', 'BATS:SLV'], ['ASX:TGN', 'ASX_DLY:TGN'], ['AMEX:URA', 'BATS:URA'],
  ['SIX:URNU', 'SIX_DLY:URNU'], ['COMEX:UX1!', 'COMEX_DL:UX1!'],
  ['FX_IDC:XAGUSD', 'FX_IDC:XAGUSD'], ['FX_IDC:XAUUSD', 'FX_IDC:XAUUSD'],
  ['FX_IDC:XPDUSD', 'FX_IDC:XPDUSD'], ['FX_IDC:XPTUSD', 'FX_IDC:XPTUSD'],
].map(([source_symbol, runtime_symbol]) => Object.freeze({ source_symbol, runtime_symbol })));

const RUNTIME_SYMBOL_MAP = new Map(FEED_RUNTIME_CANONICALIZATIONS.map(row => [row.source_symbol, row.runtime_symbol]));

export function runtimeSymbol(sourceSymbol) {
  const value = String(sourceSymbol ?? '').trim().toUpperCase();
  if (!value.includes(':')) throw new TypeError(`exchange-qualified source symbol required: ${sourceSymbol}`);
  return RUNTIME_SYMBOL_MAP.get(value) ?? value;
}

export function buildMetalsRouteUniverse() {
  return Object.freeze(METALS_WATCHLIST_SYMBOLS.flatMap(sourceSymbol => (
    ['D', 'W'].map(timeframe => Object.freeze({
      source_symbol: sourceSymbol,
      runtime_symbol: runtimeSymbol(sourceSymbol),
      timeframe,
      route_key: `${runtimeSymbol(sourceSymbol)}|${timeframe}`,
      substitution: FEED_SUBSTITUTIONS.some(row => row.source_symbol === sourceSymbol)
        ? FEED_SUBSTITUTIONS.find(row => row.source_symbol === sourceSymbol)
        : null,
      canonicalization: RUNTIME_SYMBOL_MAP.has(sourceSymbol)
        ? FEED_RUNTIME_CANONICALIZATIONS.find(row => row.source_symbol === sourceSymbol)
        : null,
    }))
  )));
}

export const CUP_TARGETS = Object.freeze([
  Object.freeze({
    target_id: 'NASDAQ_NVDA_1D',
    requested_symbol: 'NASDAQ:NVDA',
    feed_symbol: 'BATS:NVDA',
    display_label: 'NVDA',
    timeframe: '1D',
  }),
  Object.freeze({
    target_id: 'NASDAQ_TSLA_1W',
    requested_symbol: 'NASDAQ:TSLA',
    feed_symbol: 'BATS:TSLA',
    display_label: 'TSLA',
    timeframe: '1W',
  }),
  Object.freeze({
    target_id: 'BINANCE_BTCUSDT_4H',
    requested_symbol: 'BINANCE:BTCUSDT',
    feed_symbol: 'BINANCE:BTCUSDT',
    display_label: 'BTCUSDT',
    timeframe: '4H',
  }),
]);

export const SOURCE_BINDINGS = Object.freeze({
  sma_fib: Object.freeze({
    definition_version: 'sma-fib-watchlist-alert-scanner/v2',
    source_path: 'ma reaction classifier/sma-fib-watchlist-alert-scanner-metals-v2.pine',
    source_sha256: '963c8e848fc6dd3cc004c5d8c548182669bb04e608f18ed4c20a427ba8b65386',
    selected_query_source_path: 'contracts/sources/sma-fib-confluence-selected-v2.pine',
    selected_query_source_sha256: 'a6157850ff55cce7c4c539ab59d0b337a1db553327a8cc8f3ef0147aa9d12ec0',
  }),
  rsi_scanner_s1: Object.freeze({
    definition_version: 'rsi-watchlist-alert-scanner/v1',
    source_path: 'rsi indicator/bullish-rsi-watchlist-alert-scanner-metals-s01-v1.pine',
    source_sha256: '3614a1d689a56487cc796ea8709c60e56439f836a1f500f755ae001015a3a90a',
    selected_query_source_path: 'contracts/sources/rsi-divergence-selected-v1.pine',
    selected_query_source_sha256: '5c8368f21c3d83fbac517f250b0bb6614924286fecde403701de1e40d722832e',
  }),
  rsi_scanner_s2: Object.freeze({
    definition_version: 'rsi-watchlist-alert-scanner/v1',
    source_path: 'rsi indicator/bullish-rsi-watchlist-alert-scanner-metals-s02-v1.pine',
    source_sha256: 'de7e7a82a2b64de5cc3cebb543e6998022e9537cb670edc1fbb7def5596e8a2b',
    selected_query_source_path: 'contracts/sources/rsi-divergence-selected-v1.pine',
    selected_query_source_sha256: '5c8368f21c3d83fbac517f250b0bb6614924286fecde403701de1e40d722832e',
  }),
  cup_and_handle: Object.freeze({
    definition_version: '0.2.0-cleanroom',
    source_path: 'cup-and-handle/cup-and-handle.pine',
    source_sha256: 'b7609bda7ecf5d51f003e6ae3b19b25e1ccbaf9744c1b7c398bb813eb21c17bc',
  }),
});

export const CUP_EARLY_INPUTS = Object.freeze({
  in_0: true,
  in_1: true,
  in_2: true,
  in_3: true,
  in_4: false,
  in_5: false,
  in_6: false,
});

export const CUP_TERMINAL_INPUTS = Object.freeze({
  in_0: true,
  in_1: true,
  in_2: false,
  in_3: false,
  in_4: true,
  in_5: true,
  in_6: true,
});

// The Cup cohort is deliberately represented as six logical routes: one
// early route and one quiet terminal route for each of the three approved
// symbol/timeframe pairs. It must not grow with the watchlist universe.
export const CUP_ALERT_ROUTES = Object.freeze(CUP_TARGETS.flatMap(target => [
  Object.freeze({
    ...target,
    family: 'cup_and_handle',
    stage_group: 'early',
    route_id: `${target.target_id}|early`,
    input_definition: CUP_EARLY_INPUTS,
  }),
  Object.freeze({
    ...target,
    family: 'cup_and_handle',
    stage_group: 'terminal',
    route_id: `${target.target_id}|terminal`,
    input_definition: CUP_TERMINAL_INPUTS,
  }),
]));

export const OPERATIONAL_CHECK_INTERVAL_MS = 15 * 60 * 1000;
export const WEEKLY_REVIEW_DAY_UTC = 1;

export const DEFAULT_ATTENTION_STATE_DIR = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  '..',
  'analysis',
  'runtime',
);

export const DEFAULT_ATTENTION_INBOX_PATH = join(
  DEFAULT_ATTENTION_STATE_DIR,
  'attention-inbox.jsonl',
);

export function sourceBindingFor(family, shard = null) {
  if (family === 'rsi') return shard === 2 ? SOURCE_BINDINGS.rsi_scanner_s2 : SOURCE_BINDINGS.rsi_scanner_s1;
  if (!SOURCE_BINDINGS[family]) throw new TypeError(`unknown source binding family: ${family}`);
  return SOURCE_BINDINGS[family];
}
