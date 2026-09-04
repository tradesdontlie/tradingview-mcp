// Phase 0A — deterministic candidate generation. Pure, no I/O.
//
// Input: a normalized chain snapshot (the shape produced by
// options_get_chain, or an equivalent from any future provider) and an
// explicit user request. Output: valid directional strategy candidates
// with exact expiration economics. No ranking, no probability model, no
// volume/OI dependency — see strategyTypes.js and the Phase 0A report for
// the full list of intentional exclusions.

import {
  STRATEGY_TYPES, EXECUTION_MODELS, REJECTION_REASONS,
  CONTRACT_MULTIPLIER_SOURCE, CHAIN_COMPLETENESS,
} from './strategyTypes.js';
import { getFillPrice, validateContractForLeg } from './executionModel.js';
import {
  computeLongCallEconomics, computeLongPutEconomics,
  computeBullCallSpreadEconomics, computeBearPutSpreadEconomics,
  computeBuyStockEconomics, computeNoTradeEconomics,
  buildPayoffGrid, round2,
} from './strategyEconomics.js';

const DEFAULT_EXECUTION_MODEL = EXECUTION_MODELS.CONSERVATIVE;
const DEFAULT_MAX_SPREAD_PCT = 15;
const DEFAULT_CONTRACT_MULTIPLIER = 100;
const DEFAULT_COMMISSION_PER_CONTRACT = 0;
const DEFAULT_MIN_LONG_DELTA = 0.30;
const DEFAULT_MAX_LONG_DELTA = 0.70;

// Candidate-explosion control (Step 13): for each qualifying long leg, only
// the nearest N short strikes beyond it (next-higher for a bull call spread,
// next-lower for a bear put spread) are considered as spread partners. This
// bounds spread-pairing work to O(long legs x N) regardless of total chain
// size, independent of any width cap the caller supplies.
const DEFAULT_SPREAD_PARTNER_CANDIDATES = 3;

function validateRequest(request) {
  const {
    direction, underlying_price: underlyingPrice, horizon_days: horizonDays, max_loss: maxLoss,
  } = request;

  if (direction !== 'bullish' && direction !== 'bearish') {
    throw new Error(`Invalid direction "${direction}". Must be "bullish" or "bearish".`);
  }
  if (!Number.isFinite(underlyingPrice) || underlyingPrice <= 0) {
    throw new Error(`Invalid underlying_price "${underlyingPrice}". Must be a positive number.`);
  }
  if (!Number.isFinite(horizonDays) || horizonDays < 0) {
    throw new Error(`Invalid horizon_days "${horizonDays}". Must be a non-negative number.`);
  }
  if (!Number.isFinite(maxLoss) || maxLoss <= 0) {
    throw new Error(`Invalid max_loss "${maxLoss}". Must be a positive number.`);
  }

  const executionModel = request.execution_model ?? DEFAULT_EXECUTION_MODEL;
  if (!Object.values(EXECUTION_MODELS).includes(executionModel)) {
    throw new Error(`Invalid execution_model "${executionModel}". Must be "conservative" or "mid".`);
  }

  const maxSpreadPct = request.max_spread_pct ?? DEFAULT_MAX_SPREAD_PCT;
  const contractMultiplier = request.contract_multiplier ?? DEFAULT_CONTRACT_MULTIPLIER;
  const commissionPerContract = request.commission_per_contract ?? DEFAULT_COMMISSION_PER_CONTRACT;
  const minLongDelta = request.min_long_delta ?? DEFAULT_MIN_LONG_DELTA;
  const maxLongDelta = request.max_long_delta ?? DEFAULT_MAX_LONG_DELTA;

  for (const [name, v] of [
    ['max_spread_pct', maxSpreadPct], ['contract_multiplier', contractMultiplier],
    ['commission_per_contract', commissionPerContract], ['min_long_delta', minLongDelta], ['max_long_delta', maxLongDelta],
  ]) {
    if (!Number.isFinite(v) || v < 0) throw new Error(`Invalid ${name} "${v}". Must be a non-negative number.`);
  }
  for (const [name, v] of [['expiration_min_dte', request.expiration_min_dte], ['expiration_max_dte', request.expiration_max_dte], ['max_vertical_width', request.max_vertical_width]]) {
    if (v != null && (!Number.isFinite(v) || v < 0)) throw new Error(`Invalid ${name} "${v}". Must be a non-negative number.`);
  }

  return {
    direction,
    underlyingPrice,
    horizonDays,
    maxLoss,
    executionModel,
    maxSpreadPct,
    contractMultiplier,
    commissionPerContract,
    minLongDelta,
    maxLongDelta,
    expirationMinDte: request.expiration_min_dte ?? null,
    expirationMaxDte: request.expiration_max_dte ?? null,
    maxVerticalWidth: request.max_vertical_width ?? null,
  };
}

function passesExpirationFilter(contract, cfg, rejections) {
  const dte = contract.days_to_expiry;
  if (dte < cfg.horizonDays) {
    rejections.push(REJECTION_REASONS.EXPIRY_BEFORE_HORIZON);
    return false;
  }
  if (cfg.expirationMinDte != null && dte < cfg.expirationMinDte) {
    rejections.push(REJECTION_REASONS.OUTSIDE_DTE_WINDOW);
    return false;
  }
  if (cfg.expirationMaxDte != null && dte > cfg.expirationMaxDte) {
    rejections.push(REJECTION_REASONS.OUTSIDE_DTE_WINDOW);
    return false;
  }
  return true;
}

function passesLongDeltaFilter(contract, cfg, rejections) {
  const absDelta = contract.delta == null ? null : Math.abs(contract.delta);
  if (absDelta == null || absDelta < cfg.minLongDelta || absDelta > cfg.maxLongDelta) {
    rejections.push(REJECTION_REASONS.DELTA_OUT_OF_RANGE);
    return false;
  }
  return true;
}

function candidateId(parts) {
  return parts.join('::');
}

function contractSortKey(c) {
  return `${c.expiration}|${c.option_type}|${c.strike}`;
}

function buildCandidateEnvelope({
  strategyType, underlying, expiration, daysToExpiry, legs, economics, spot, sourceContracts, executionModel,
}) {
  const payoff = buildPayoffGrid({
    spot,
    breakeven: economics.breakeven,
    relevantPrices: economics.relevantPrices,
    expirationPnl: economics.expirationPnl,
  });

  const idParts = [strategyType, underlying, expiration ?? 'NA', ...sourceContracts, executionModel];

  return {
    candidate_id: candidateId(idParts),
    strategy_type: strategyType,
    expiration: expiration ?? null,
    days_to_expiry: daysToExpiry ?? null,
    legs,
    entry_debit: economics.entry_debit,
    fees: economics.fees,
    capital_required: economics.capital_required,
    max_loss: economics.max_loss,
    max_profit: economics.max_profit,
    max_profit_type: economics.max_profit_type,
    breakeven: economics.breakeven,
    payoff_grid: payoff,
    source_contracts: sourceContracts,
  };
}

/**
 * Generates deterministic directional strategy candidates + exact expiration
 * economics from a normalized chain snapshot.
 *
 * @param {{underlying:string, underlying_price:number, contracts:object[], chain_completeness?:string}} chainSnapshot
 * @param {object} request - see strategyTypes.js / Phase 0A spec for shape
 */
export function generateStrategyCandidates(chainSnapshot, request) {
  const cfg = validateRequest(request);
  const { underlying, contracts } = chainSnapshot;
  const spot = cfg.underlyingPrice;

  const chainCompleteness = chainSnapshot.chain_completeness ?? CHAIN_COMPLETENESS.COMPLETE;
  const warnings = [];
  if (chainCompleteness === CHAIN_COMPLETENESS.POSSIBLY_TRUNCATED) {
    warnings.push('CHAIN_POSSIBLY_TRUNCATED');
  }

  const wantType = cfg.direction === 'bullish' ? 'call' : 'put';
  const rejectionSummary = {};
  const tally = (reason) => { rejectionSummary[reason] = (rejectionSummary[reason] ?? 0) + 1; };

  // --- Stage 1: direction + expiration-eligible universe -------------------
  let eligibleContractCount = 0;
  const directionMatched = [];
  for (const c of contracts) {
    if (c.option_type !== wantType) continue; // not part of this direction's universe at all
    eligibleContractCount++;
    const rejections = [];
    if (!passesExpirationFilter(c, cfg, rejections)) {
      rejections.forEach(tally);
      continue;
    }
    directionMatched.push(c);
  }

  // --- Stage 2: hard quality gates, evaluated separately per leg role ------
  const longEligible = [];
  const shortEligibleByExpiry = new Map(); // expiration -> contract[]
  for (const c of directionMatched) {
    const longReasons = validateContractForLeg(c, 'long', cfg.maxSpreadPct);
    if (longReasons.length === 0) {
      longEligible.push(c);
    } else {
      longReasons.forEach(tally);
    }

    const shortReasons = validateContractForLeg(c, 'short', cfg.maxSpreadPct);
    if (shortReasons.length === 0) {
      const key = c.expiration;
      if (!shortEligibleByExpiry.has(key)) shortEligibleByExpiry.set(key, []);
      shortEligibleByExpiry.get(key).push(c);
    }
    // Short-leg rejections are not separately tallied here — a contract that
    // fails as a short leg but succeeds as a long leg still produces a
    // LONG_CALL/LONG_PUT candidate; only pairing failures are tallied below.
  }

  // --- Stage 3: single-leg long candidates (delta-filtered) ---------------
  const candidates = [];
  const longLegsForSpreads = [];
  for (const c of longEligible) {
    const deltaRejections = [];
    if (!passesLongDeltaFilter(c, cfg, deltaRejections)) {
      deltaRejections.forEach(tally);
      continue;
    }
    longLegsForSpreads.push(c);

    const fill = getFillPrice(c, 'long', cfg.executionModel);
    const economics = cfg.direction === 'bullish'
      ? computeLongCallEconomics({ strike: c.strike, fillPrice: fill, multiplier: cfg.contractMultiplier, commissionPerContract: cfg.commissionPerContract })
      : computeLongPutEconomics({ strike: c.strike, fillPrice: fill, multiplier: cfg.contractMultiplier, commissionPerContract: cfg.commissionPerContract });

    if (economics.max_loss > cfg.maxLoss) { tally(REJECTION_REASONS.MAX_LOSS_EXCEEDED); continue; }

    candidates.push(buildCandidateEnvelope({
      strategyType: cfg.direction === 'bullish' ? STRATEGY_TYPES.LONG_CALL : STRATEGY_TYPES.LONG_PUT,
      underlying,
      expiration: c.expiration,
      daysToExpiry: c.days_to_expiry,
      legs: [{ role: 'long', contract: c.contract, strike: c.strike, option_type: c.option_type, fill_price: round2(fill) }],
      economics,
      spot,
      sourceContracts: [c.contract],
      executionModel: cfg.executionModel,
    }));
  }

  // --- Stage 4: vertical spreads -------------------------------------------
  for (const longLeg of longLegsForSpreads) {
    const sameExpiryShorts = (shortEligibleByExpiry.get(longLeg.expiration) ?? [])
      .filter(s => s.contract !== longLeg.contract);

    const partners = cfg.direction === 'bullish'
      ? sameExpiryShorts.filter(s => s.strike > longLeg.strike).sort((a, b) => a.strike - b.strike)
      : sameExpiryShorts.filter(s => s.strike < longLeg.strike).sort((a, b) => b.strike - a.strike);

    const bounded = partners.slice(0, DEFAULT_SPREAD_PARTNER_CANDIDATES);

    for (const shortLeg of bounded) {
      const width = Math.abs(shortLeg.strike - longLeg.strike);
      if (cfg.maxVerticalWidth != null && width > cfg.maxVerticalWidth) { tally(REJECTION_REASONS.WIDTH_EXCEEDED); continue; }

      const longFill = getFillPrice(longLeg, 'long', cfg.executionModel);
      const shortFill = getFillPrice(shortLeg, 'short', cfg.executionModel);

      const economics = cfg.direction === 'bullish'
        ? computeBullCallSpreadEconomics({ longStrike: longLeg.strike, shortStrike: shortLeg.strike, longFill, shortFill, multiplier: cfg.contractMultiplier, commissionPerContract: cfg.commissionPerContract })
        : computeBearPutSpreadEconomics({ longStrike: longLeg.strike, shortStrike: shortLeg.strike, longFill, shortFill, multiplier: cfg.contractMultiplier, commissionPerContract: cfg.commissionPerContract });

      if (economics.totalDebitRaw <= 0) { tally(REJECTION_REASONS.NON_POSITIVE_DEBIT); continue; }
      if (economics.max_loss > cfg.maxLoss) { tally(REJECTION_REASONS.MAX_LOSS_EXCEEDED); continue; }

      candidates.push(buildCandidateEnvelope({
        strategyType: cfg.direction === 'bullish' ? STRATEGY_TYPES.BULL_CALL_SPREAD : STRATEGY_TYPES.BEAR_PUT_SPREAD,
        underlying,
        expiration: longLeg.expiration,
        daysToExpiry: longLeg.days_to_expiry,
        legs: [
          { role: 'long', contract: longLeg.contract, strike: longLeg.strike, option_type: longLeg.option_type, fill_price: round2(longFill) },
          { role: 'short', contract: shortLeg.contract, strike: shortLeg.strike, option_type: shortLeg.option_type, fill_price: round2(shortFill) },
        ],
        economics,
        spot,
        sourceContracts: [longLeg.contract, shortLeg.contract].sort(),
        executionModel: cfg.executionModel,
      }));
    }
  }

  // --- Stage 5: BUY_STOCK baseline (bullish only) --------------------------
  if (cfg.direction === 'bullish') {
    const stockEconomics = computeBuyStockEconomics({ underlyingPrice: spot, maxLoss: cfg.maxLoss });
    if (stockEconomics == null) {
      tally(REJECTION_REASONS.INSUFFICIENT_CAPITAL_FOR_SHARE);
    } else {
      candidates.push({
        candidate_id: candidateId([STRATEGY_TYPES.BUY_STOCK, underlying, round2(spot), cfg.executionModel]),
        strategy_type: STRATEGY_TYPES.BUY_STOCK,
        baseline_type: 'UNDERLYING',
        expiration: null,
        days_to_expiry: null,
        legs: [{ role: 'long', contract: null, shares: stockEconomics.shares }],
        entry_debit: stockEconomics.entry_debit,
        fees: stockEconomics.fees,
        capital_required: stockEconomics.capital_required,
        max_loss: stockEconomics.max_loss,
        max_profit: stockEconomics.max_profit,
        max_profit_type: stockEconomics.max_profit_type,
        breakeven: stockEconomics.breakeven,
        payoff_grid: buildPayoffGrid({ spot, breakeven: stockEconomics.breakeven, relevantPrices: stockEconomics.relevantPrices, expirationPnl: stockEconomics.expirationPnl }),
        source_contracts: [],
      });
    }
  }

  // --- Stage 6: NO_TRADE baseline — always present, never filtered --------
  const noTradeEconomics = computeNoTradeEconomics();
  candidates.push({
    candidate_id: candidateId([STRATEGY_TYPES.NO_TRADE, underlying]),
    strategy_type: STRATEGY_TYPES.NO_TRADE,
    baseline_type: 'NONE',
    expiration: null,
    days_to_expiry: null,
    legs: [],
    entry_debit: noTradeEconomics.entry_debit,
    fees: noTradeEconomics.fees,
    capital_required: noTradeEconomics.capital_required,
    max_loss: noTradeEconomics.max_loss,
    max_profit: noTradeEconomics.max_profit,
    max_profit_type: noTradeEconomics.max_profit_type,
    breakeven: noTradeEconomics.breakeven,
    payoff_grid: buildPayoffGrid({ spot, breakeven: null, relevantPrices: [], expirationPnl: noTradeEconomics.expirationPnl }),
    source_contracts: [],
  });

  // --- Stage 7: deterministic sort -----------------------------------------
  candidates.sort((a, b) => {
    if (a.strategy_type !== b.strategy_type) return a.strategy_type < b.strategy_type ? -1 : 1;
    const ae = a.expiration ?? '';
    const be = b.expiration ?? '';
    if (ae !== be) return ae < be ? -1 : 1;
    const aKey = (a.legs[0]?.strike ?? 0) + (a.legs[1]?.strike ? `|${a.legs[1].strike}` : '');
    const bKey = (b.legs[0]?.strike ?? 0) + (b.legs[1]?.strike ? `|${b.legs[1].strike}` : '');
    return String(aKey) < String(bKey) ? -1 : String(aKey) > String(bKey) ? 1 : 0;
  });

  const rejectedCount = Object.values(rejectionSummary).reduce((a, b) => a + b, 0);

  return {
    underlying,
    underlying_price: spot,
    direction: cfg.direction,
    horizon_days: cfg.horizonDays,
    max_loss_constraint: cfg.maxLoss,
    execution_model: cfg.executionModel,
    commission_per_contract: cfg.commissionPerContract,
    contract_multiplier: cfg.contractMultiplier,
    contract_multiplier_source: CONTRACT_MULTIPLIER_SOURCE.ASSUMED_STANDARD_US_EQUITY_OPTION,
    chain_completeness: chainCompleteness,
    warnings,
    input_contract_count: contracts.length,
    eligible_contract_count: eligibleContractCount,
    candidate_count: candidates.length,
    rejected_count: rejectedCount,
    rejection_summary: rejectionSummary,
    candidates,
  };
}
