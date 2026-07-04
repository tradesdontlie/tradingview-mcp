import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/risk.js';

/**
 * Deterministic risk-management tools — pure math, no live chart/exchange calls.
 * Encodes the risk-management curriculum (position sizing, R:R gating by win
 * rate, drawdown recovery, evolving R, leverage/risk caps, the Trading Trident
 * pre-trade gate) so these rules can be enforced mechanically rather than by
 * live judgment.
 */
export function registerRiskTools(server) {
  server.tool(
    'risk_position_size',
    'Calculate position size from capital, risk %, and stop-loss distance %. Pass available_capital ' +
    '(actual deployable balance) to cap the result at what the account can actually execute — the formula ' +
    'alone can recommend a position larger than the account holds (e.g. a tight stop on a small account); ' +
    'capping under-risks rather than over-risks, which is always acceptable per the curriculum\'s caps.',
    {
      capital: z.coerce.number().positive().describe('Total account capital'),
      risk_percent: z.coerce.number().min(0).max(100).describe('Percent of capital to risk on this trade (e.g. 2 for 2%)'),
      stop_loss_percent: z.coerce.number().positive().describe('Distance from entry to stop loss, as a percent (e.g. 5 for 5%)'),
      available_capital: z.coerce.number().positive().optional().describe('Actual deployable balance — caps the recommended size at what is executable'),
    },
    async ({ capital, risk_percent, stop_loss_percent, available_capital }) => {
      try { return jsonResult({ success: true, ...core.positionSize({ capital, riskPercent: risk_percent, stopLossPercent: stop_loss_percent, availableCapital: available_capital }) }); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool('risk_reward_ratio', 'Calculate the risk:reward ratio for a trade given entry, stop, and target prices', {
    entry: z.coerce.number().positive().describe('Entry price'),
    stop: z.coerce.number().positive().describe('Stop-loss price'),
    target: z.coerce.number().positive().describe('Target/take-profit price'),
    side: z.enum(['long', 'short']).optional().describe('Trade direction (default "long")'),
  }, async ({ entry, stop, target, side }) => {
    try { return jsonResult({ success: true, ...core.riskRewardRatio({ entry, stop, target, side }) }); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('risk_breakeven_win_rate', 'Calculate the win rate % needed to break even at a given reward:risk ratio', {
    reward_per_risk: z.coerce.number().positive().describe('Reward per unit of risk (e.g. 2 for a 1:2 risk:reward trade)'),
  }, async ({ reward_per_risk }) => {
    try { return jsonResult({ success: true, ...core.breakevenWinRate({ rewardPerRisk: reward_per_risk }) }); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('risk_min_reward_for_win_rate', 'Calculate the minimum reward:risk ratio needed to break even at a given historical win rate %', {
    win_rate: z.coerce.number().min(0).max(100).describe('Historical win rate as a percent (e.g. 40 for 40%)'),
  }, async ({ win_rate }) => {
    try { return jsonResult({ success: true, ...core.minRewardPerRiskForWinRate({ winRate: win_rate }) }); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('risk_drawdown_recovery', 'Calculate the % gain required to recover from a given % loss (drawdown asymmetry)', {
    loss_percent: z.coerce.number().min(0).max(100).describe('Loss as a percent of capital (e.g. 50 for a 50% loss)'),
  }, async ({ loss_percent }) => {
    try { return jsonResult({ success: true, ...core.drawdownRecovery({ lossPercent: loss_percent }) }); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('risk_evolving_r', 'Calculate the current R-multiple of an open trade and flag the early-exit threshold (evolving R < 0.5)', {
    entry: z.coerce.number().positive().describe('Entry price'),
    stop: z.coerce.number().positive().describe('Original stop-loss price'),
    current: z.coerce.number().positive().describe('Current price'),
    side: z.enum(['long', 'short']).optional().describe('Trade direction (default "long")'),
  }, async ({ entry, stop, current, side }) => {
    try { return jsonResult({ success: true, ...core.evolvingR({ entry, stop, current, side }) }); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('risk_check_limits', 'Check whether a proposed risk % and leverage clear the hard caps (max 3% risk per trade, max 5x leverage)', {
    risk_percent: z.coerce.number().min(0).max(100).describe('Percent of capital to risk on this trade'),
    leverage: z.coerce.number().positive().optional().describe('Leverage multiplier (default 1, no leverage)'),
  }, async ({ risk_percent, leverage }) => {
    try { return jsonResult({ success: true, ...core.checkRiskLimits({ riskPercent: risk_percent, leverage }) }); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool(
    'risk_evaluate_trade_setup',
    'Run the full "Trading Trident" pre-trade gate: checks risk/leverage caps, computes R:R and position size, ' +
    'and (if historical_win_rate is given) verifies the trade clears the win-rate/R:R breakeven threshold. ' +
    'Returns passes: false with reasons if any deterministic risk rule is violated — this does NOT evaluate ' +
    'technical/setup quality (entry trigger validity, confluence, etc.), only the arithmetic risk rules.',
    {
      capital: z.coerce.number().positive().describe('Total account capital'),
      risk_percent: z.coerce.number().min(0).max(100).describe('Percent of capital to risk on this trade'),
      leverage: z.coerce.number().positive().optional().describe('Leverage multiplier (default 1)'),
      entry: z.coerce.number().positive().describe('Entry price'),
      stop: z.coerce.number().positive().describe('Stop-loss price'),
      target: z.coerce.number().positive().describe('Target/take-profit price'),
      side: z.enum(['long', 'short']).optional().describe('Trade direction (default "long")'),
      historical_win_rate: z.coerce.number().min(0).max(100).optional().describe('Your historical win rate %, if known — enables the win-rate/R:R breakeven check'),
      available_capital: z.coerce.number().positive().optional().describe('Actual deployable balance — caps the recommended position size at what is executable (under-risking, never over-risking)'),
    },
    async ({ capital, risk_percent, leverage, entry, stop, target, side, historical_win_rate, available_capital }) => {
      try {
        return jsonResult({
          success: true,
          ...core.evaluateTradeSetup({
            capital,
            riskPercent: risk_percent,
            leverage,
            entry,
            stop,
            target,
            side,
            historicalWinRate: historical_win_rate,
            availableCapital: available_capital,
          }),
        });
      } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'risk_translate_for_account',
    'Translate a directional trade plan ({side, entry}, e.g. from sfp_build_trade_plan) into an executable order ' +
    'for a given account type. Spot accounts cannot open a short — there is nothing to borrow and sell — so a ' +
    'bearish ("short") signal is translated into selling existing inventory of the asset (capped at what is held); ' +
    'margin/futures accounts can open either side natively. Returns executable: false when a spot account holds ' +
    'nothing to sell against a bearish signal.',
    {
      side: z.enum(['long', 'short']).describe('Trade direction from the plan'),
      entry: z.coerce.number().positive().describe('Planned entry price (used to convert the $ position size into a quantity)'),
      account_type: z.enum(['spot', 'margin', 'futures']).optional().describe('Account type to execute on (default "spot")'),
      position_size_usd: z.coerce.number().positive().describe('Position size in $ (e.g. from risk_evaluate_trade_setup)'),
      held_quantity: z.coerce.number().min(0).optional().describe('Quantity of the asset currently held — required to translate a short onto a spot account (default 0)'),
    },
    async ({ side, entry, account_type, position_size_usd, held_quantity }) => {
      try {
        return jsonResult({
          success: true,
          ...core.translateForAccount({
            plan: { side, entry },
            accountType: account_type,
            positionSizeUsd: position_size_usd,
            heldQuantity: held_quantity,
          }),
        });
      } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
