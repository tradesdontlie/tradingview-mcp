// Phase 2C.1, Step 14-15 — provider precedence + confidence for the CRR
// shadow pipeline. Pure: takes already-fetched provider results (IBKR,
// TradingView, documented-zero) and picks among them; does no I/O itself.
//
// Precedence (Step 14):
//   DISCOUNT: official Treasury Bill normalized rate only.
//   DIVIDEND: 1) IBKR expected 12m dividend  2) TradingView trailing yield
//             3) documented zero-dividend source  4) unavailable.
//   BORROW:   1) IBKR Fee Rate  2) unavailable.
// Phase 2B/2B.1's option-implied joint carry is NEVER used here.

import { DIVIDEND_MODES, resolveDividendInput, resolveBorrowInput } from './productionMarketInputs.js';
import { CARRY_CONFIDENCE } from './marketInputTypes.js';

/**
 * Step 14/12/13 — dividend precedence. `ibkrResult` is
 * fetchIbkrMarketInputs()'s output (or null/UNAVAILABLE-shaped if IBKR
 * wasn't reachable); `tvTrailingYieldPct` and `documentedZero` are the
 * existing Phase 2C sources.
 */
export function resolveDividendWithPrecedence({ spot, ibkrResult, tvTrailingYieldPct, documentedZeroSource }) {
  if (ibkrResult?.dividend_present && ibkrResult.expected_12m_dividend_per_share > 0) {
    return resolveDividendInput({
      mode: DIVIDEND_MODES.FORWARD_ANNUAL_DIVIDEND_APPROXIMATION, spot,
      expected12mDividendPerShare: ibkrResult.expected_12m_dividend_per_share,
      source: 'IBKR_FORWARD_12M_DIVIDEND', asOfUtc: ibkrResult.as_of_utc, confidence: 'MEDIUM',
    });
  }
  // Step 13 — an explicit IBKR-reported zero is FORWARD_DIVIDEND_ZERO_REPORTED,
  // not silently promoted to ZERO_DIVIDEND_CONFIRMED, unless a separate
  // documented source corroborates it.
  if (ibkrResult?.dividend_present && ibkrResult.expected_12m_dividend_per_share === 0) {
    if (documentedZeroSource) {
      return resolveDividendInput({ mode: DIVIDEND_MODES.ZERO_DIVIDEND_CONFIRMED, source: `${documentedZeroSource}+IBKR_CORROBORATED`, confidence: 'HIGH' });
    }
    return { mode: 'FORWARD_DIVIDEND_ZERO_REPORTED', annualized_yield: 0, source: 'IBKR_FORWARD_12M_DIVIDEND', as_of_utc: ibkrResult.as_of_utc, confidence: 'MEDIUM', warnings: ['FORWARD_DIVIDEND_ZERO_REPORTED_NOT_CORROBORATED'] };
  }
  if (tvTrailingYieldPct != null) {
    return resolveDividendInput({ mode: DIVIDEND_MODES.TRAILING_DIVIDEND_YIELD_APPROXIMATION, trailingYieldDecimal: tvTrailingYieldPct / 100, source: 'TRADINGVIEW_KEY_STATS_TRAILING_YIELD', confidence: 'LOW' });
  }
  if (documentedZeroSource) {
    return resolveDividendInput({ mode: DIVIDEND_MODES.ZERO_DIVIDEND_CONFIRMED, source: documentedZeroSource, confidence: 'HIGH' });
  }
  return resolveDividendInput({ mode: DIVIDEND_MODES.DIVIDEND_DATA_UNAVAILABLE });
}

/**
 * Step 14/9-10 — borrow precedence. Labels the source `IBKR_FEE_RATE`
 * (never `TRUE_MARKET_BORROW_RATE`) and carries the limitation warnings
 * from Steps 9-10 forward.
 */
export function resolveBorrowWithPrecedence({ ibkrResult }) {
  if (ibkrResult?.fee_rate_present) {
    const input = resolveBorrowInput({
      connected: true, feeRate: ibkrResult.fee_rate, source: 'IBKR_FEE_RATE',
      asOfUtc: ibkrResult.ibkr_snapshot_as_of_utc ?? ibkrResult.as_of_utc,
      confidence: ibkrResult.market_data_availability === 'REALTIME' ? 'MEDIUM' : 'LOW',
      shortableStatus: ibkrResult.shortable_status,
    });
    return { ...input, warnings: [...input.warnings, 'BORROW_PROXY_IBKR_FEE_RATE', 'IBKR_FEE_RATE_NOT_NET_SHORT_FINANCING_COST'] };
  }
  return resolveBorrowInput({ connected: false, feeRate: null });
}

/**
 * Step 15 — deterministic CRR-shadow market-input confidence (distinct
 * from Phase 0C's user-facing confidence, which this does NOT touch).
 *   HIGH:   Treasury available AND borrow present (IBKR) AND dividend
 *           present (IBKR forward or documented zero) AND market-data
 *           REALTIME (or borrow not required for a documented-zero name).
 *   MEDIUM: discount + dividend available, borrow missing; OR borrow/
 *           dividend present but snapshot delayed/frozen.
 *   LOW:    an important source is stale/uncertain/inconsistent.
 */
export function classifyShadowMarketInputConfidence({ discountAvailable, dividendConfidence, borrowPresent, marketDataAvailability }) {
  if (!discountAvailable || dividendConfidence == null) return CARRY_CONFIDENCE.LOW;
  if (borrowPresent && dividendConfidence !== 'LOW' && (marketDataAvailability == null || marketDataAvailability === 'REALTIME')) return CARRY_CONFIDENCE.HIGH;
  if (dividendConfidence === 'LOW' && !borrowPresent) return CARRY_CONFIDENCE.LOW;
  return CARRY_CONFIDENCE.MEDIUM;
}
