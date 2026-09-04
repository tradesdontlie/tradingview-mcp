// Phase 2C, Steps 5-6 — BorrowDataProvider interface + implementations.
// Pure module: no TradingView/CDP/IBKR imports. No credentials are ever
// stored or required here — an IBKR (or any other) live adapter would be
// injected as a plain async function, per dependency injection, exactly
// like dividendProviders.js's tradingViewKeyStatsDividendProvider.
//
// BorrowDataProvider normalized output shape:
//   { symbol, borrow_fee_rate, shortable_status, shortable_shares,
//     source, as_of_utc, confidence }

import { resolveBorrowInput } from './productionMarketInputs.js';

/**
 * Default provider when no live securities-lending connection exists in
 * this environment (the case throughout Phase 2C — no IBKR or other
 * authenticated broker session is connected here). Returns
 * provider_status: NOT_CONNECTED and a null fee rather than ever
 * defaulting to 0 (Step 5). Never blocks pure/shadow tests (Step 6).
 */
export async function notConnectedBorrowProvider(symbol) {
  return { symbol, provider_status: 'NOT_CONNECTED', borrow_fee_rate: null, shortable_status: 'UNKNOWN', shortable_shares: null, source: 'NOT_CONNECTED', as_of_utc: null, confidence: 'LOW' };
}

/**
 * Fixture/test provider — deterministic, no I/O.
 */
export function fixtureBorrowProvider(fixtureBySymbol) {
  return async function getBorrowData(symbol) {
    const entry = fixtureBySymbol[symbol];
    if (!entry) return notConnectedBorrowProvider(symbol);
    return { symbol, provider_status: 'CONNECTED', source: 'FIXTURE', confidence: 'MEDIUM', ...entry };
  };
}

/**
 * Optional IBKR-shaped adapter interface (Step 6). This project has no
 * authenticated IBKR (or other broker) connection — this function exists
 * to document the intended shape (IBKR concepts: Fee Rate, Shortable
 * Shares) so a future session can implement it via dependency injection
 * without changing any caller. `ibkrClient` is injected; if null/undefined,
 * behaves identically to notConnectedBorrowProvider.
 */
export function ibkrBorrowProviderAdapter(ibkrClient) {
  if (!ibkrClient) return notConnectedBorrowProvider;
  return async function getBorrowData(symbol) {
    // Shape only — no live IBKR session exists in this environment to
    // exercise this path. A real implementation would call e.g.
    // ibkrClient.getShortableShares(symbol) / ibkrClient.getFeeRate(symbol).
    const data = await ibkrClient.getBorrowInfo(symbol);
    return { symbol, provider_status: 'CONNECTED', borrow_fee_rate: data.feeRate, shortable_status: data.shortableStatus, shortable_shares: data.shortableShares, source: 'IBKR_SECURITIES_LENDING', as_of_utc: new Date().toISOString(), confidence: 'MEDIUM' };
  };
}

export function toBorrowInput(providerResult) {
  return resolveBorrowInput({
    connected: providerResult.provider_status === 'CONNECTED',
    feeRate: providerResult.borrow_fee_rate,
    source: providerResult.source,
    asOfUtc: providerResult.as_of_utc,
    confidence: providerResult.confidence,
    shortableStatus: providerResult.shortable_status,
  });
}
