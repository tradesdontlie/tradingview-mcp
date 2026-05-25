// Static reference list of TradingView-supported exchanges.
// Ported (and extended for India) from atilaahmettaner exchanges_list resource.

export const EXCHANGES = {
  crypto: [
    'BINANCE', 'KUCOIN', 'BYBIT', 'MEXC', 'BITGET', 'OKX',
    'COINBASE', 'GATEIO', 'HUOBI', 'BITFINEX', 'KRAKEN', 'BITSTAMP',
  ],
  india_equities: ['NSE', 'BSE'],
  india_derivatives: ['NSE_INDEX', 'BSE_INDEX', 'MCX'],
  india_crypto: ['COINDCX', 'WAZIRX', 'BITBNS', 'DELTAINDIA'],
  global_equities: ['NASDAQ', 'NYSE', 'AMEX'],
  asia_equities: ['HKEX', 'SSE', 'SZSE', 'TWSE', 'TPEX', 'BURSA'],
  middle_east: ['EGX', 'BIST'],
  australia: ['ASX'],
};

export function listExchanges() {
  const flat = Object.values(EXCHANGES).flat().sort();
  return {
    by_category: EXCHANGES,
    all: flat,
    count: flat.length,
    source: 'static reference',
  };
}
