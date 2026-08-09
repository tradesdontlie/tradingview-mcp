import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/user-decision.js';

export function registerUserDecisionTools(server) {
  // Pre-Trade Checklist
  server.tool('user_pretrade_checklist', 'Complete pre-trade checklist before any real trading', {
    user_experience: z.enum(['beginner', 'intermediate', 'advanced']),
    capital_available: z.number().describe('Trading capital in USD'),
    monthly_income: z.number().describe('Monthly income for risk assessment'),
  }, async ({ user_experience, capital_available, monthly_income }) => {
    try {
      return jsonResult(await core.preTradeChecklist({
        user_experience,
        capital_available,
        monthly_income,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Reality Check: Historical vs Live
  server.tool('reality_check_backtest_vs_live', 'Reality check: Why backtests don\'t equal live profits', {}, async () => {
    try {
      return jsonResult(await core.backtestVsLiveReality());
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Paper Trading Recommendation
  server.tool('recommend_paper_trading', 'Recommend paper trading before real money', {
    strategy_type: z.string().describe('Strategy name'),
    backtest_results: z.object({
      win_rate: z.number(),
      profit_factor: z.number(),
      max_drawdown: z.number(),
    }).describe('Historical backtest performance'),
  }, async ({ strategy_type, backtest_results }) => {
    try {
      return jsonResult(await core.paperTradingRecommendation({
        strategy_type,
        backtest_results,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // User Readiness Assessment
  server.tool('assess_user_readiness', 'Assess if user is ready for live trading', {
    knowledge_level: z.enum(['knows_basics', 'understands_risk', 'has_plan', 'all_above']),
    emotional_control: z.enum(['poor', 'moderate', 'strong']),
    capital_cushion: z.number().describe('Months of living expenses saved (min 6)'),
  }, async ({ knowledge_level, emotional_control, capital_cushion }) => {
    try {
      return jsonResult(await core.assessUserReadiness({
        knowledge_level,
        emotional_control,
        capital_cushion,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Risk Tolerance vs Reality
  server.tool('validate_risk_tolerance', 'Validate stated risk tolerance vs real risk tolerance', {
    stated_risk_appetite: z.enum(['conservative', 'moderate', 'aggressive']),
    max_loss_willing: z.number().describe('Max loss user willing to accept per trade (%)'),
    account_size: z.number().describe('Account size in USD'),
  }, async ({ stated_risk_appetite, max_loss_willing, account_size }) => {
    try {
      return jsonResult(await core.validateRiskTolerance({
        stated_risk_appetite,
        max_loss_willing,
        account_size,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Mental Checklist Before First Trade
  server.tool('mental_checklist_first_trade', 'Mental checklist before first real trade', {}, async () => {
    try {
      return jsonResult(await core.mentalChecklistFirstTrade());
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Widget: User Decision Guide
  server.tool('widget_user_decision_guide', 'Render comprehensive user decision guide', {
    backtest_score: z.number().describe('Backtest performance score (0-100)'),
    user_readiness: z.enum(['not_ready', 'needs_practice', 'ready_small_capital', 'ready']),
  }, async ({ backtest_score, user_readiness }) => {
    try {
      return jsonResult(await core.createUserDecisionWidget(backtest_score, user_readiness));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Widget: Risk Reality Check
  server.tool('widget_risk_reality_check', 'Show real risk vs perceived risk', {
    capital: z.number(),
    risk_per_trade_percent: z.number(),
    strategy_win_rate: z.number(),
  }, async ({ capital, risk_per_trade_percent, strategy_win_rate }) => {
    try {
      return jsonResult(await core.createRiskRealityWidget(capital, risk_per_trade_percent, strategy_win_rate));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });
}
