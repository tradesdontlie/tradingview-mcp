// Phase 2C, Step 4 — DividendDataProvider interface + implementations.
// Pure module: providers that need live data take an injected fetch
// function (dependency injection) rather than importing TradingView/CDP
// tooling directly, so this file stays testable without network access.
//
// DividendDataProvider normalized output shape:
//   { symbol, expected_12m_dividend_per_share, next_ex_dividend_date,
//     next_dividend_amount, source, as_of_utc, confidence }

import { DIVIDEND_MODES, resolveDividendInput } from './productionMarketInputs.js';

/**
 * Fixture/test provider — deterministic, no I/O. Used in unit tests and
 * whenever no live provider is available (never blocks pure/shadow tests).
 */
export function fixtureDividendProvider(fixtureBySymbol) {
  return async function getDividendData(symbol) {
    const entry = fixtureBySymbol[symbol];
    if (!entry) return { symbol, source: 'FIXTURE_NOT_FOUND', confidence: 'LOW', expected_12m_dividend_per_share: null, next_ex_dividend_date: null, next_dividend_amount: null, as_of_utc: null };
    return { symbol, source: 'FIXTURE', confidence: 'MEDIUM', ...entry };
  };
}

/**
 * Live adapter over the project's existing `data_get_key_stats` MCP tool
 * (the only dividend-related data actually reachable in this environment
 * — see Phase 2C report Section C). `getKeyStats` is injected (e.g. the
 * MCP client's own call, or a wrapper) so this module has no direct
 * TradingView/CDP import. TradingView's `dividend_yield_pct` is a
 * TRAILING figure (last declared/observed rate), not a discrete forward
 * schedule — normalized here as
 * TRAILING_DIVIDEND_YIELD_APPROXIMATION, never claimed as
 * FORWARD_ANNUAL or DISCRETE.
 */
export function tradingViewKeyStatsDividendProvider(getKeyStats) {
  return async function getDividendData(symbol) {
    const stats = await getKeyStats({ symbol });
    if (stats?.dividend_yield_pct == null) {
      return { symbol, source: 'TRADINGVIEW_KEY_STATS', confidence: 'LOW', expected_12m_dividend_per_share: null, next_ex_dividend_date: null, next_dividend_amount: null, as_of_utc: new Date().toISOString() };
    }
    return {
      symbol,
      source: 'TRADINGVIEW_KEY_STATS_TRAILING_YIELD',
      confidence: 'LOW', // trailing, not forward/discrete — see resolveTradingViewDividendInput
      trailing_yield_decimal: stats.dividend_yield_pct / 100,
      expected_12m_dividend_per_share: null,
      next_ex_dividend_date: null,
      next_dividend_amount: null,
      as_of_utc: new Date().toISOString(),
    };
  };
}

/**
 * Resolves a provider's normalized output into a productionMarketInputs.js
 * dividend_input record, picking the mode the provider's data actually
 * supports (never inferring DISCRETE_DIVIDENDS or FORWARD from a provider
 * that only returned a trailing yield).
 */
export function toDividendInput(providerResult, { spot, zeroDividendConfirmedSymbols = [] } = {}) {
  if (zeroDividendConfirmedSymbols.includes(providerResult.symbol)) {
    return resolveDividendInput({ mode: DIVIDEND_MODES.ZERO_DIVIDEND_CONFIRMED, source: providerResult.source, asOfUtc: providerResult.as_of_utc, confidence: 'HIGH' });
  }
  if (providerResult.expected_12m_dividend_per_share != null) {
    return resolveDividendInput({ mode: DIVIDEND_MODES.FORWARD_ANNUAL_DIVIDEND_APPROXIMATION, spot, expected12mDividendPerShare: providerResult.expected_12m_dividend_per_share, source: providerResult.source, asOfUtc: providerResult.as_of_utc, confidence: providerResult.confidence });
  }
  if (providerResult.trailing_yield_decimal != null) {
    return resolveDividendInput({ mode: DIVIDEND_MODES.TRAILING_DIVIDEND_YIELD_APPROXIMATION, trailingYieldDecimal: providerResult.trailing_yield_decimal, source: providerResult.source, asOfUtc: providerResult.as_of_utc, confidence: providerResult.confidence });
  }
  return resolveDividendInput({ mode: DIVIDEND_MODES.DIVIDEND_DATA_UNAVAILABLE, source: providerResult.source, asOfUtc: providerResult.as_of_utc });
}
