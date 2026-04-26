/**
 * Single source of truth for TradingView scanner endpoints.
 *
 * The scanner API is partitioned by region — there's no global endpoint. Each
 * exchange prefix maps to a country segment of the URL (america, uk, germany,
 * japan, forex, crypto, etc.). Calls against the wrong segment silently return
 * empty data rather than 404, so getting the mapping right matters.
 *
 * Mapping derived from TradingView's public scanner regions, observed live at
 * scanner.tradingview.com/<country>/scan. Unknown / unprefixed symbols default
 * to `america` because that's the largest universe and most-used by callers.
 */

const EXCHANGE_TO_COUNTRY = new Map([
  // North America
  ['NASDAQ', 'america'], ['NYSE', 'america'], ['AMEX', 'america'], ['ARCA', 'america'],
  ['OTC', 'america'], ['BATS', 'america'], ['CBOE', 'america'], ['IEX', 'america'],
  ['TSX', 'canada'], ['TSXV', 'canada'], ['CSE', 'canada'], ['NEO', 'canada'],

  // Europe
  ['LSE', 'uk'], ['LSIN', 'uk'], ['AQUIS', 'uk'],
  ['XETR', 'germany'], ['FWB', 'germany'], ['SWB', 'germany'], ['MUN', 'germany'],
  ['BER', 'germany'], ['DUS', 'germany'], ['HAN', 'germany'],
  ['EURONEXT', 'france'], ['MIL', 'italy'], ['BIT', 'italy'],
  ['BME', 'spain'], ['LISBON', 'portugal'], ['DUBLIN', 'ireland'],
  ['SIX', 'switzerland'], ['OMXSTO', 'sweden'], ['OMXCOP', 'denmark'],
  ['OMXHEX', 'finland'], ['OSE', 'norway'],

  // Asia / Pacific
  ['TSE', 'japan'], ['JPX', 'japan'],
  ['HKEX', 'hongkong'],
  ['SSE', 'china'], ['SZSE', 'china'],
  ['NSE', 'india'], ['BSE', 'india'],
  ['ASX', 'australia'], ['NZX', 'newzealand'],
  ['KRX', 'korea'], ['TPEX', 'taiwan'], ['TWSE', 'taiwan'],
  ['SET', 'thailand'], ['IDX', 'indonesia'], ['HOSE', 'vietnam'], ['HNX', 'vietnam'],

  // Latin America / Middle East / Africa
  ['BMFBOVESPA', 'brazil'], ['BVMF', 'brazil'],
  ['BMV', 'mexico'], ['BVC', 'colombia'],
  ['TADAWUL', 'saudiarabia'], ['DFM', 'uae'], ['ADX', 'uae'],
  ['TASE', 'israel'], ['EGX', 'egypt'], ['JSE', 'southafrica'],

  // Pseudo-markets (not country-bound)
  ['FX', 'forex'], ['FX_IDC', 'forex'], ['OANDA', 'forex'],
  ['FOREXCOM', 'forex'], ['SAXO', 'forex'], ['ICMARKETS', 'forex'],
  ['BINANCE', 'crypto'], ['COINBASE', 'crypto'], ['KRAKEN', 'crypto'],
  ['BITSTAMP', 'crypto'], ['BITFINEX', 'crypto'], ['BYBIT', 'crypto'],
  ['HUOBI', 'crypto'], ['OKX', 'crypto'], ['BITGET', 'crypto'],
  ['CME', 'futures'], ['NYMEX', 'futures'], ['COMEX', 'futures'],
  ['CBOT', 'futures'], ['CME_MINI', 'futures'], ['EUREX', 'futures'],
]);

/**
 * Map a fully-qualified TradingView symbol (e.g. "NASDAQ:NVDA", "OANDA:XAUUSD")
 * to the scanner country segment used in the endpoint URL.
 *
 * Unknown prefix → `america`. Unprefixed symbol → `america`. Both fallbacks
 * are intentional — callers typically pass US tickers when they don't bother
 * with a prefix, and silently routing to the wrong region is worse than the
 * occasional empty-result on a non-US ticker we forgot to whitelist.
 */
export function exchangeToScannerCountry(symbol) {
  const s = String(symbol);
  const colonIdx = s.indexOf(':');
  if (colonIdx < 0) return 'america';
  const prefix = s.slice(0, colonIdx).toUpperCase();
  return EXCHANGE_TO_COUNTRY.get(prefix) || 'america';
}

/**
 * Build the scan endpoint URL for a given symbol. Used by data.js getQuoteViaScanner.
 */
export function scannerScanUrl(symbol) {
  return `https://scanner.tradingview.com/${exchangeToScannerCountry(symbol)}/scan`;
}

/**
 * Build the hotlist preset URL for a given slug. Hotlists are US-only per
 * TradingView's API surface (no `EU_*` / `ASIA_*` equivalents exist as of
 * 2026-04-26). The slug is expected to be already-validated by the caller.
 */
export function scannerPresetUrl(slug) {
  return `https://scanner.tradingview.com/presets/US_${slug}?label-product=right-hotlists`;
}

// Re-exported for tests / introspection.
export const SCANNER_COUNTRIES = Array.from(new Set(EXCHANGE_TO_COUNTRY.values())).sort();
