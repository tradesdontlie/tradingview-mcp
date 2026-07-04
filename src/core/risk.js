/**
 * Deterministic risk-management rules — pure functions, no chart/exchange I/O.
 * Encodes the risk-math from the trading curriculum (position sizing, R:R
 * gating by win rate, drawdown asymmetry, evolving R, leverage limits) so a
 * bot can enforce them mechanically rather than relying on live judgment.
 */

function requirePositiveFinite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive finite number, got: ${value}`);
  return n;
}

function requireFiniteInRange(value, name, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}, got: ${value}`);
  }
  return n;
}

// position size = (capital * risk%) / stop-loss distance%
//
// The formula alone can recommend a position larger than the account actually
// holds (e.g. a tight stop on a small account implies a large size to still
// risk the target %). Pass `availableCapital` (the actual deployable balance)
// to cap the result at what's executable — under-risking by capping is always
// conservative/acceptable per the curriculum's caps (they're a ceiling, not a floor).
//
// `maxPositionPercent` is a second, independent ceiling expressed as % of
// `capital` — without it, a tight enough stop can drive idealSize up to (and
// `availableCapital` lets it consume) the entire account in one trade. This
// caps single-trade concentration regardless of how tight the stop is.
export function positionSize({ capital, riskPercent, stopLossPercent, availableCapital, maxPositionPercent } = {}) {
  const cap = requirePositiveFinite(capital, 'capital');
  const risk = requireFiniteInRange(riskPercent, 'riskPercent', 0, 100);
  const stopDistance = requirePositiveFinite(stopLossPercent, 'stopLossPercent');
  const riskAmount = cap * (risk / 100);
  const idealSize = riskAmount / (stopDistance / 100);

  let ceiling;
  if (availableCapital !== undefined) ceiling = requirePositiveFinite(availableCapital, 'availableCapital');
  if (maxPositionPercent !== undefined) {
    const maxPct = requireFiniteInRange(maxPositionPercent, 'maxPositionPercent', 0, 100);
    const maxSize = cap * (maxPct / 100);
    ceiling = ceiling === undefined ? maxSize : Math.min(ceiling, maxSize);
  }

  if (ceiling === undefined || idealSize <= ceiling) {
    return { risk_amount: riskAmount, position_size: idealSize, ideal_position_size: idealSize, capital_constrained: false };
  }
  const actualRiskAmount = ceiling * (stopDistance / 100);
  return { risk_amount: actualRiskAmount, position_size: ceiling, ideal_position_size: idealSize, capital_constrained: true };
}

// R:R = (entry - stop) / (target - entry) for longs; mirrored for shorts
export function riskRewardRatio({ entry, stop, target, side = 'long' } = {}) {
  const e = requirePositiveFinite(entry, 'entry');
  const s = requirePositiveFinite(stop, 'stop');
  const t = requirePositiveFinite(target, 'target');
  const sideLower = String(side).toLowerCase();
  if (!['long', 'short'].includes(sideLower)) throw new Error('side must be "long" or "short"');

  const risk = sideLower === 'long' ? e - s : s - e;
  const reward = sideLower === 'long' ? t - e : e - t;
  if (risk <= 0) throw new Error('stop is on the wrong side of entry for the given side');
  if (reward <= 0) throw new Error('target is on the wrong side of entry for the given side');

  return { risk, reward, ratio: risk / reward };
}

// breakeven win rate % = 1 / (R:R + 1) * 100, where R:R is reward-per-unit-risk (e.g. 2 for 1:2)
export function breakevenWinRate({ rewardPerRisk } = {}) {
  const rr = requirePositiveFinite(rewardPerRisk, 'rewardPerRisk');
  return { breakeven_win_rate_percent: (1 / (rr + 1)) * 100 };
}

// Minimum reward:risk needed to break even at a given historical win rate.
// Sourced from the curriculum's lookup table; interpolated for in-between values.
const WIN_RATE_TABLE = [
  { winRate: 25, minRewardPerRisk: 3 },
  { winRate: 33, minRewardPerRisk: 2 },
  { winRate: 40, minRewardPerRisk: 1.5 },
  { winRate: 50, minRewardPerRisk: 1 },
  { winRate: 60, minRewardPerRisk: 0.7 },
  { winRate: 75, minRewardPerRisk: 0.3 },
];

export function minRewardPerRiskForWinRate({ winRate } = {}) {
  const wr = requireFiniteInRange(winRate, 'winRate', 0, 100);
  // Exact formula form of the same relationship as the lookup table:
  // at breakeven, winRate = 1 / (R + 1), so minimum R = (1 - winRate) / winRate
  const fraction = wr / 100;
  const minRewardPerRisk = (1 - fraction) / fraction;
  const tableEntry = WIN_RATE_TABLE.find(row => row.winRate === wr);
  return { min_reward_per_risk: minRewardPerRisk, table_reference: tableEntry?.minRewardPerRisk };
}

// % gain required to recover a given % loss: gain = loss / (1 - loss)
export function drawdownRecovery({ lossPercent } = {}) {
  const loss = requireFiniteInRange(lossPercent, 'lossPercent', 0, 100);
  const fraction = loss / 100;
  if (fraction >= 1) throw new Error('lossPercent must be less than 100');
  return { recovery_percent_required: (fraction / (1 - fraction)) * 100 };
}

// Evolving R: how many multiples of initial risk the trade currently represents.
// Positive = currently in profit by that many R; negative = currently at a loss of that many R.
export function evolvingR({ entry, stop, current, side = 'long' } = {}) {
  const e = requirePositiveFinite(entry, 'entry');
  const s = requirePositiveFinite(stop, 'stop');
  const c = requirePositiveFinite(current, 'current');
  const sideLower = String(side).toLowerCase();
  if (!['long', 'short'].includes(sideLower)) throw new Error('side must be "long" or "short"');

  const initialRisk = sideLower === 'long' ? e - s : s - e;
  if (initialRisk <= 0) throw new Error('stop is on the wrong side of entry for the given side');

  const move = sideLower === 'long' ? c - e : e - c;
  const currentR = move / initialRisk;
  // Checklist #50: when evolvingR drops below 0.5 while price is reversing, START TO CONSIDER an early exit.
  // This flag only signals the numeric half of that rule — the "is it reversing" half requires price-action judgment.
  const belowEarlyExitThreshold = currentR > 0 && currentR < 0.5;
  return { current_r: currentR, below_early_exit_threshold: belowEarlyExitThreshold };
}

// Checklist #47/#48: hard caps on risk-per-trade (1-3%) and leverage (max 5x).
// Returns a list of violated rules — empty array means the trade clears the gate.
export function checkRiskLimits({ riskPercent, leverage = 1 } = {}) {
  const risk = requireFiniteInRange(riskPercent, 'riskPercent', 0, 100);
  const lev = requirePositiveFinite(leverage, 'leverage');
  const violations = [];
  if (risk > 3) violations.push(`riskPercent ${risk}% exceeds the 1-3% per-trade cap`);
  if (lev > 5) violations.push(`leverage ${lev}x exceeds the 5x ceiling`);
  return { passes: violations.length === 0, violations };
}

/**
 * The "Trading Trident" pre-trade gate (checklist #51): a trade must clear
 * every deterministic risk rule before it is allowed through. This does not
 * replace technical judgment (entry trigger validity, confluence, etc.) —
 * it only enforces the parts of the curriculum that are pure arithmetic.
 */
export function evaluateTradeSetup({
  capital,
  riskPercent,
  leverage = 1,
  entry,
  stop,
  target,
  side = 'long',
  historicalWinRate,
  availableCapital,
  maxPositionPercent,
} = {}) {
  const limits = checkRiskLimits({ riskPercent, leverage });
  const rr = riskRewardRatio({ entry, stop, target, side });
  const rewardPerRisk = rr.reward / rr.risk;

  const reasons = [...limits.violations];

  let minRequired;
  if (historicalWinRate !== undefined) {
    minRequired = minRewardPerRiskForWinRate({ winRate: historicalWinRate });
  }
  // Hard 1:1 reward:risk floor regardless of the curriculum's win-rate-based
  // minimum — RR<1 trades are excluded across all strategies/combos.
  const effectiveMinRewardPerRisk = Math.max(minRequired?.min_reward_per_risk ?? 0, 1);
  if (rewardPerRisk < effectiveMinRewardPerRisk) {
    if (minRequired && minRequired.min_reward_per_risk >= 1) {
      reasons.push(
        `reward:risk ${rewardPerRisk.toFixed(2)} is below the ${minRequired.min_reward_per_risk.toFixed(2)} ` +
        `minimum required to break even at a ${historicalWinRate}% win rate`
      );
    } else {
      reasons.push(
        `reward:risk ${rewardPerRisk.toFixed(2)} is below the 1.0 minimum reward:risk floor`
      );
    }
  }

  const stopLossPercent = (Math.abs(entry - stop) / entry) * 100;
  const sizing = positionSize({ capital, riskPercent, stopLossPercent, availableCapital, maxPositionPercent });

  return {
    passes: reasons.length === 0,
    reasons,
    risk_reward: rr,
    reward_per_risk: rewardPerRisk,
    min_reward_per_risk_required: effectiveMinRewardPerRisk,
    position_size: sizing.position_size,
    ideal_position_size: sizing.ideal_position_size,
    capital_constrained: sizing.capital_constrained,
    risk_amount: sizing.risk_amount,
  };
}

/**
 * Translate a directional trade plan ({side, entry, ...}, e.g. from
 * buildSFPTradePlan) into an executable order for a given account type.
 *
 * Spot accounts cannot open a short — there's nothing to "borrow and sell".
 * The closest faithful expression of a bearish signal on spot is selling
 * existing inventory of the asset (reducing/closing long exposure), capped at
 * what's actually held. Margin/futures accounts can open either side natively.
 */
export function translateForAccount({ plan, accountType = 'spot', positionSizeUsd, heldQuantity = 0 } = {}) {
  if (!plan || !['long', 'short'].includes(plan.side)) throw new Error('plan must include side: "long" or "short" (e.g. from buildSFPTradePlan)');
  const type = String(accountType).toLowerCase();
  if (!['spot', 'margin', 'futures'].includes(type)) throw new Error('accountType must be "spot", "margin", or "futures"');
  const sizeUsd = requirePositiveFinite(positionSizeUsd, 'positionSizeUsd');
  const entry = requirePositiveFinite(plan.entry, 'plan.entry');
  const idealQuantity = sizeUsd / entry;

  if (type !== 'spot' || plan.side === 'long') {
    return {
      executable: true,
      order_side: plan.side === 'long' ? 'buy' : 'sell',
      quantity: idealQuantity,
      capped_by_holdings: false,
      note: type === 'spot'
        ? 'spot buy — long signals are directly executable on spot'
        : `${type} account can open a native ${plan.side} — directly executable`,
    };
  }

  const held = requireFiniteInRange(heldQuantity, 'heldQuantity', 0, Number.MAX_SAFE_INTEGER);
  if (held <= 0) {
    return {
      executable: false,
      order_side: undefined,
      quantity: 0,
      capped_by_holdings: false,
      note: 'spot account cannot open a short and holds no inventory of this asset to sell — acting on this signal requires a margin/futures account',
    };
  }
  const quantity = Math.min(idealQuantity, held);
  return {
    executable: true,
    order_side: 'sell',
    quantity,
    capped_by_holdings: quantity < idealQuantity,
    note: 'spot account cannot open a short — selling held inventory as the closest faithful spot-equivalent of the bearish signal',
  };
}
