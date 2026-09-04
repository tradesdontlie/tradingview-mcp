// Phase 2D.3 — non-IBKR production market-input builder for the guarded CRR
// hybrid diagnostic (Phase 2D.2's `deps.buildCrrShadowMarketInputs` hook).
//
// This is the default provider wired into directionalAnalysis.js for
// `include_crr_hybrid_diagnostics`. It is NOT used for production ranking,
// scoring, confidence, eligibility, or local-Greek pricing — those remain
// entirely on LOCAL_GREEK_APPROXIMATION. This module only feeds the
// diagnostic CRR shadow pathway (crrShadowScenario.js) that Phase 2D's
// hybrid policy (hybridCrrPolicy.js) reads.
//
// Inputs are whatever directionalAnalysis.js already fetched for the main
// analysis (`keyStats`, the expirations present in the candidate universe)
// — this module performs no TradingView/CDP I/O of its own.
//
// Sources, per Phase 2D.3's scope (IBKR intentionally excluded — the
// account is not funded/active, and Phase 2C.1-2C.4 already established
// IBKR is a "desirable, not required" input):
//   DISCOUNT: Treasury bill coupon-equivalent rates, via the same
//     resolveDiscountRate() used throughout Phase 2B/2C. No live Treasury
//     fetch exists in this codebase yet (every prior phase fetched it via
//     an ad-hoc curl/WebFetch call, never as reusable production code) —
//     so this module uses a frozen, explicitly-labeled fallback bill-rate
//     table (the same "stale fallback" pattern the Phase 2 scripts always
//     used), and tags every resulting record with
//     TREASURY_RATE_FROZEN_FALLBACK_NOT_LIVE so it's never mistaken for a
//     live quote. Refresh FALLBACK_TREASURY_* periodically; a live fetcher
//     is out of scope for this wiring step.
//   DIVIDEND: TradingView key-stats trailing yield (marketInputPrecedence's
//     established precedence chain), with the same "TradingView reports an
//     exact 0%" -> ZERO_DIVIDEND_CONFIRMED handling already used in the
//     Phase 2C/2C.1 live scripts for documented no-dividend names (PANW is
//     the running example, but the check is generic: any exact 0% from
//     TradingView, not a hardcoded symbol list).
//   BORROW: always unavailable (no IBKR) -> resolveBorrowWithPrecedence
//     with ibkrResult: null -> explicit BORROW_DATA_UNAVAILABLE, never a
//     silent zero. This always yields PARTIAL_EXTERNAL_INPUTS, never
//     FULL_EXTERNAL_INPUTS.

import { resolveDiscountRate, buildMarketInputRecord } from './productionMarketInputs.js';
import { resolveDividendWithPrecedence, resolveBorrowWithPrecedence } from './marketInputPrecedence.js';

// Frozen fallback bill-rate table — last refreshed from the U.S. Treasury
// Daily Treasury Bill Rates series during the Phase 2C.2 live acceptance
// run (docs/fixtures/phase2c2-live-acceptance-20260902/). Coupon-equivalent
// values, decimal. Update this constant (and FALLBACK_TREASURY_AS_OF_DATE)
// the next time a live Treasury observation is collected.
export const FALLBACK_TREASURY_BILL_RATES = Object.freeze({
  fourWeek: 0.0375,
  sixWeek: 0.0381,
  eightWeek: 0.0382,
  thirteenWeek: 0.0387,
  seventeenWeek: 0.0393,
  twentySixWeek: 0.0403,
  fiftyTwoWeek: 0.0418,
});
export const FALLBACK_TREASURY_AS_OF_DATE = '2026-09-01';

const TREASURY_FROZEN_FALLBACK_WARNING = 'TREASURY_RATE_FROZEN_FALLBACK_NOT_LIVE';

function resolveFrozenTreasuryDiscount(dte) {
  const resolved = resolveDiscountRate({ dte, billRates: FALLBACK_TREASURY_BILL_RATES, asOfDate: FALLBACK_TREASURY_AS_OF_DATE });
  return { ...resolved, warnings: [...new Set([...(resolved.warnings ?? []), TREASURY_FROZEN_FALLBACK_WARNING])] };
}

function resolveTradingViewDividend({ spot, keyStats }) {
  const divPct = keyStats?.dividend_yield_pct;
  if (divPct == null) {
    return resolveDividendWithPrecedence({ spot, ibkrResult: null, tvTrailingYieldPct: null, documentedZeroSource: null });
  }
  if (divPct === 0) {
    // TradingView itself reporting an exact 0% is treated as the documented
    // zero-dividend source — generic, not a hardcoded symbol allowlist, but
    // PANW is the established example from Phase 2C/2C.1's live scripts.
    return resolveDividendWithPrecedence({ spot, ibkrResult: null, tvTrailingYieldPct: null, documentedZeroSource: 'TRADINGVIEW_KEY_STATS_ZERO_DIVIDEND' });
  }
  return resolveDividendWithPrecedence({ spot, ibkrResult: null, tvTrailingYieldPct: divPct, documentedZeroSource: null });
}

/**
 * Builds the diagnostic-only CRR shadow market-input map for one symbol's
 * candidate universe. Matches the `deps.buildCrrShadowMarketInputs` shape
 * directionalAnalysis.js expects: async, returns
 * `Map<expiration, marketInputRecord>`.
 *
 * @param {object} params
 * @param {string} params.symbol - exchange-qualified, e.g. "NASDAQ:PANW"
 * @param {string} params.root - bare ticker root, e.g. "PANW" (unused directly
 *   here — dividend zero-detection is value-based, not symbol-based — kept
 *   for signature parity with the directionalAnalysis.js call site and any
 *   future symbol-specific override)
 * @param {number} params.spot
 * @param {object} params.keyStats - already-fetched getKeyStats() result
 * @param {object} params.chainResp - already-fetched chain response (unused
 *   here; accepted for signature parity / future use, e.g. per-contract IV)
 * @param {Array<{expiration: string, dte: number}>} params.expirations
 * @returns {Promise<Map<string, object>>}
 */
export async function buildTradingViewCrrShadowMarketInputs({ symbol, root, spot, keyStats, chainResp, expirations }) {
  const dividend = resolveTradingViewDividend({ spot, keyStats });
  const borrow = resolveBorrowWithPrecedence({ ibkrResult: null });

  const map = new Map();
  for (const { expiration, dte } of expirations ?? []) {
    const discount = resolveFrozenTreasuryDiscount(dte);
    map.set(expiration, buildMarketInputRecord({ expiration, daysToExpiry: dte, discount, dividend, borrow }));
  }
  return map;
}
