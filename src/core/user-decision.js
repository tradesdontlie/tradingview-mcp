// Pre-Trade Checklist
export async function preTradeChecklist({ user_experience, capital_available, monthly_income }) {
  const riskAllocation = capital_available > monthly_income * 3 ? 'Safe (3+ months income)' : 'Risky (< 3 months income)';

  const checklist = {
    beginner: [
      '❌ Have you completed market basics course?',
      '❌ Do you understand margin calls & leverage risks?',
      '❌ Can you execute stop loss orders?',
      '❌ Have you paper traded for 30+ days?',
      '❌ Do you have a written trading plan?',
      '❌ Do you have 6+ months emergency fund?',
      '❌ Can you afford to lose this entire capital?',
    ],
    intermediate: [
      '❌ Have you backtested your strategy (100+ trades)?',
      '❌ Have you paper traded live signals (50+ trades)?',
      '❌ Do you have risk management rules documented?',
      '❌ Can you follow your plan during 20% losses?',
      '❌ Have you analyzed your past 10 losing trades?',
      '❌ Do you understand tax implications?',
    ],
    advanced: [
      '❌ Have you forward tested (paper trade current signals)?',
      '❌ Have you stress tested in different market conditions?',
      '❌ Do you have position sizing rules for drawdowns?',
      '❌ Have you reviewed last 100 trades for patterns?',
      '❌ Do you have contingency plans for system failures?',
    ],
  };

  const allUnchecked = checklist[user_experience].length;
  const readiness = allUnchecked === 0 ? 'Ready for Live Trading' : `Complete ${allUnchecked} items first`;

  return {
    success: true,
    user_experience,
    capital_available,
    monthly_income,
    risk_allocation: riskAllocation,
    checklist: checklist[user_experience],
    items_to_complete: allUnchecked,
    readiness_status: readiness,
    recommendation: allUnchecked > 0 ? 'DO NOT trade real money yet' : 'You may start with small capital',
    critical_items: [
      'Emergency fund (6+ months)',
      'Ability to lose entire capital',
      'Written trading plan',
      'Stop loss discipline',
    ],
  };
}

// Backtest vs Live Reality
export async function backtestVsLiveReality() {
  return {
    success: true,
    harsh_reality: [
      {
        issue: 'Slippage',
        backtest: 'Perfect fills at theoretical price',
        live: 'Orders fill at worse prices (0.5-5 pips away)',
        impact: '-2-10% of profits'
      },
      {
        issue: 'Gaps',
        backtest: 'Assumes continuous data',
        live: 'Gaps happen overnight, expiry, earnings',
        impact: 'Stop loss skipped, larger losses'
      },
      {
        issue: 'Liquidity',
        backtest: 'Assumes you can sell anytime',
        live: 'Large positions can\'t exit quickly',
        impact: 'Forced holding through drawdown'
      },
      {
        issue: 'Emotions',
        backtest: 'Algorithm follows rules perfectly',
        live: 'You second-guess, override rules',
        impact: '-30-50% of profits'
      },
      {
        issue: 'Fees/Taxes',
        backtest: 'Often ignored in simple backtests',
        live: 'Brokerage, taxes reduce returns',
        impact: '-5-20% annually'
      },
      {
        issue: 'Market Conditions',
        backtest: 'Historical data only',
        live: 'Unprecedented events happen',
        impact: 'Strategy breaks in new regimes'
      },
      {
        issue: 'Overfitting',
        backtest: 'Strategy tuned to past data',
        live: 'Future data different from past',
        impact: 'Strategy fails in live market'
      },
      {
        issue: 'Drawdowns',
        backtest: '50% DD feels abstract',
        live: 'Watching account drop real money painful',
        impact: 'Panic selling, emotional decisions'
      }
    ],
    typical_live_vs_backtest: {
      backtest_return: '25% annually',
      live_return: '8-12% (accounting for slippage, fees, emotions)',
      difference: '-50-70% reduction'
    },
    survival_stats: {
      traders_profitable_1st_year: '5%',
      traders_profitable_5th_year: '2%',
      traders_stay_after_50pct_loss: '10%',
    },
    recommendation: 'PAPER TRADE for 6-12 months first. See how you actually perform, not backtests.',
  };
}

// Paper Trading Recommendation
export async function paperTradingRecommendation({ strategy_type, backtest_results }) {
  const { win_rate, profit_factor, max_drawdown } = backtest_results;

  let recommendation = '';
  let paper_trading_duration = '';
  let concerns = [];

  if (profit_factor < 1.5) {
    concerns.push('Low profit factor - expect more losses live');
    paper_trading_duration = '12+ months';
  }
  if (win_rate < 40) {
    concerns.push('Low win rate - psychological challenge');
    paper_trading_duration = '9-12 months';
  }
  if (max_drawdown > 30) {
    concerns.push('High max DD - test emotional resilience');
    paper_trading_duration = '12+ months';
  }

  if (concerns.length === 0) {
    paper_trading_duration = '3-6 months';
    recommendation = 'Strategy looks solid. Paper trade 3-6 months before real money.';
  } else {
    recommendation = 'Strategy has risks. Paper trade 9-12 months to validate real-world performance.';
  }

  return {
    success: true,
    strategy_type,
    backtest_performance: backtest_results,
    paper_trading_recommendation: {
      duration: paper_trading_duration,
      minimum_trades: paper_trading_duration.includes('3-6') ? 100 : 200,
      test_scenarios: [
        'At least 1 complete market cycle (bull/bear)',
        'Through at least 1 major drawdown',
        'Multiple losing streaks',
        'Your emotional breaking points',
      ],
    },
    concerns,
    success_criteria: {
      must_achieve: [
        'Win rate within 5% of backtest',
        'Profit factor >= 1.2',
        'Follow 95% of trades (no skipping)',
        'Stick to risk management rules',
      ],
    },
    red_flags: [
      'Win rate drops >10% from backtest (overfitting)',
      'Can\'t follow stop losses (emotional)',
      'Miss more than 10% of setups (discipline)',
      'Can\'t tolerate drawdowns (need more education)',
    ],
    final_recommendation: recommendation,
  };
}

// User Readiness Assessment
export async function assessUserReadiness({ knowledge_level, emotional_control, capital_cushion }) {
  let readiness_score = 0;
  let blockers = [];

  // Knowledge check
  if (knowledge_level === 'all_above') readiness_score += 40;
  else if (knowledge_level === 'has_plan') readiness_score += 25;
  else if (knowledge_level === 'understands_risk') readiness_score += 15;
  else blockers.push('BLOCKER: Lacks basic market knowledge');

  // Emotional check
  if (emotional_control === 'strong') readiness_score += 35;
  else if (emotional_control === 'moderate') readiness_score += 20;
  else blockers.push('BLOCKER: Poor emotional control (high failure risk)');

  // Capital cushion check
  if (capital_cushion >= 6) readiness_score += 25;
  else if (capital_cushion >= 3) readiness_score += 10;
  else blockers.push('BLOCKER: Insufficient emergency fund (need 6+ months)');

  const ready = readiness_score >= 80 && blockers.length === 0;

  return {
    success: true,
    readiness_score: `${readiness_score}/100`,
    readiness_level: ready ? 'READY' : 'NOT READY',
    blockers,
    recommendation: ready ? 'You can start live trading with SMALL capital (1-2% of account per trade)' : 'Address blockers before live trading',
    next_steps: !ready ? blockers : ['Start with small position sizes', 'Use stop losses religiously', 'Track every trade in journal'],
  };
}

// Validate Risk Tolerance
export async function validateRiskTolerance({ stated_risk_appetite, max_loss_willing, account_size }) {
  const max_loss_amount = (account_size * max_loss_willing) / 100;
  const percent_monthly_income_risked = (max_loss_amount / (account_size * 0.12)) * 100; // Assuming 12% annual = 1% monthly

  let actual_tolerance = '';
  if (max_loss_willing <= 1) actual_tolerance = 'Conservative (even lower than stated)';
  else if (max_loss_willing <= 2) actual_tolerance = 'Conservative';
  else if (max_loss_willing <= 5) actual_tolerance = 'Moderate';
  else actual_tolerance = 'Aggressive';

  const matches = stated_risk_appetite === actual_tolerance.split(' ')[0].toLowerCase();

  return {
    success: true,
    stated_appetite: stated_risk_appetite,
    actual_tolerance,
    risk_match: matches ? 'MATCHES' : 'MISMATCH - User likely underestimating risk',
    max_loss_per_trade_usd: max_loss_amount.toFixed(2),
    account_size,
    validation: {
      is_realistic: max_loss_willing >= 1 && max_loss_willing <= 5,
      warning: max_loss_willing > 5 ? 'RISKY: Risking >5% per trade is too aggressive for most' : max_loss_willing < 1 ? 'OVERLY CONSERVATIVE: May miss opportunities' : 'REALISTIC',
    },
    recommendation: matches ? 'Risk tolerance validated' : 'Recalibrate expectations - actual risk higher than stated comfort',
  };
}

// Mental Checklist First Trade
export async function mentalChecklistFirstTrade() {
  return {
    success: true,
    mental_checklist: [
      {
        check: 'Have you slept well last night?',
        reason: 'Poor sleep = poor decision making',
        action: 'If no, wait for next setup'
      },
      {
        check: 'Are you in a calm emotional state?',
        reason: 'Fear/anger = irrational trades',
        action: 'If no, meditate or wait'
      },
      {
        check: 'Have you reviewed your trading plan?',
        reason: 'Ensures discipline',
        action: 'Read plan before EVERY trade'
      },
      {
        check: 'Are you trading THIS setup or all setups?',
        reason: 'Prevents revenge trading',
        action: 'Only trade high-probability setups'
      },
      {
        check: 'Is your stop loss set BEFORE entry?',
        reason: 'Prevents moving SL after entry',
        action: 'NEVER move stop loss to lose more'
      },
      {
        check: 'Have you calculated exact position size?',
        reason: 'Prevents over-sizing',
        action: 'Use position sizing formula'
      },
      {
        check: 'Do you have a take profit target?',
        reason: 'Prevents greed',
        action: 'Predefined TP before entry'
      },
      {
        check: 'Can you afford to lose this trade?',
        reason: 'Risk only what you can afford to lose',
        action: 'If worried about loss, trade is too big'
      },
    ],
    red_flags: [
      'Trading to recover losses (revenge trading)',
      'Overriding your setup rules',
      'Trading on emotion, not setup',
      'Ignoring your stop loss',
      'Trying to time the market perfectly',
      'Trading when tired/angry/distracted',
    ],
    gold_standard_first_trade: {
      setup_clarity: 'Setup is crystal clear (not borderline)',
      risk_reward: 'At least 1:2 ratio',
      position_size: 'Small (1-2% account)',
      stop_loss: 'Set & planned',
      take_profit: 'Clear level identified',
      psychology: 'You\'re calm & focused',
    },
    success_definition: 'Following your plan perfectly (not whether you win or lose)',
  };
}

// Widgets

export async function createUserDecisionWidget(backtest_score, user_readiness) {
  const id = `user_decision_${Date.now()}`;

  const readinessColors = {
    not_ready: { color: '#dc3545', text: '🚫 NOT READY' },
    needs_practice: { color: '#ffc107', text: '⚠️ NEEDS PRACTICE' },
    ready_small_capital: { color: '#17a2b8', text: '✓ READY (SMALL CAPITAL)' },
    ready: { color: '#28a745', text: '✓ READY' },
  };

  const readinessInfo = readinessColors[user_readiness];

  const html = `
    <div class="widget-user-decision" data-widget-id="${id}">
      <style>
        .widget-user-decision { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 24px; background: white; border-radius: 12px; max-width: 600px; }
        .decision-header { text-align: center; margin-bottom: 24px; }
        .decision-title { font-size: 22px; font-weight: 700; color: #333; margin-bottom: 8px; }
        .decision-subtitle { font-size: 12px; color: #666; }
        .scores-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
        .score-card { background: #f8f9fa; padding: 16px; border-radius: 8px; text-align: center; }
        .score-label { font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
        .score-value { font-size: 24px; font-weight: 700; }
        .readiness-banner { padding: 16px; border-radius: 8px; color: white; text-align: center; font-weight: 600; margin-bottom: 20px; }
        .decision-section { margin-bottom: 20px; }
        .section-title { font-size: 14px; font-weight: 600; color: #333; margin-bottom: 12px; }
        .section-item { padding: 10px; background: #f8f9fa; border-radius: 4px; font-size: 13px; margin-bottom: 6px; }
        .section-item.warning { border-left: 4px solid #ffc107; }
        .section-item.success { border-left: 4px solid #28a745; }
        .action-btn { width: 100%; padding: 12px; margin-top: 16px; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }
        .btn-paper-trade { background: #ffc107; color: #333; }
        .btn-real-trade { background: #28a745; color: white; }
      </style>
      <div class="decision-header">
        <div class="decision-title">🎯 Trading Readiness Decision</div>
        <div class="decision-subtitle">Based on backtest performance & user preparedness</div>
      </div>

      <div class="scores-grid">
        <div class="score-card">
          <div class="score-label">Backtest Score</div>
          <div class="score-value">${backtest_score}/100</div>
        </div>
        <div class="score-card">
          <div class="score-label">User Readiness</div>
          <div class="score-value">${user_readiness === 'ready' ? 'A+' : user_readiness === 'ready_small_capital' ? 'B' : user_readiness === 'needs_practice' ? 'C' : 'F'}</div>
        </div>
      </div>

      <div class="readiness-banner" style="background: ${readinessInfo.color};">
        ${readinessInfo.text}
      </div>

      <div class="decision-section">
        <div class="section-title">📋 Recommendation</div>
        ${user_readiness === 'not_ready' ? `
          <div class="section-item warning">
            ⚠️ Complete the pre-trade checklist before any real trading.
            <br/><br/>
            Current blockers must be addressed:
            <br/>• Market knowledge gaps
            <br/>• Emotional control training
            <br/>• Emergency fund building
          </div>
        ` : user_readiness === 'needs_practice' ? `
          <div class="section-item warning">
            Paper trade for 6-12 months first.
            <br/><br/>
            Validate strategy in real-time conditions before risking capital.
          </div>
        ` : `
          <div class="section-item success">
            ✓ You may start live trading with SMALL capital (1-2% per trade).
            <br/><br/>
            Start small, prove consistency, scale gradually.
          </div>
        `}
      </div>

      ${user_readiness === 'ready' ? `
        <button class="action-btn btn-real-trade">Start Live Trading (Small)</button>
      ` : `
        <button class="action-btn btn-paper-trade">Continue Paper Trading</button>
      `}
    </div>
  `;

  return {
    success: true,
    widget_id: id,
    resource_uri: `widget://${id}`,
    html,
    type: 'user_decision',
  };
}

export async function createRiskRealityWidget(capital, risk_per_trade_percent, strategy_win_rate) {
  const id = `risk_reality_${Date.now()}`;

  const risk_amount = (capital * risk_per_trade_percent) / 100;
  const expected_win = risk_amount * 2; // 1:2 RR
  const expected_loss = -risk_amount;

  // 10 trade simulation
  const wins = Math.round(10 * (strategy_win_rate / 100));
  const losses = 10 - wins;
  const net_10_trades = (wins * expected_win) + (losses * expected_loss);

  const html = `
    <div class="widget-risk-reality" data-widget-id="${id}">
      <style>
        .widget-risk-reality { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 24px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px; color: white; max-width: 600px; }
        .reality-title { font-size: 20px; font-weight: 700; margin-bottom: 20px; text-align: center; }
        .reality-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; }
        .reality-item { background: rgba(255, 255, 255, 0.1); padding: 16px; border-radius: 8px; }
        .reality-label { font-size: 11px; opacity: 0.8; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
        .reality-value { font-size: 18px; font-weight: 700; }
        .simulation-section { margin-top: 20px; padding: 16px; background: rgba(0, 0, 0, 0.2); border-radius: 8px; }
        .simulation-title { font-size: 12px; font-weight: 600; text-transform: uppercase; margin-bottom: 12px; opacity: 0.9; }
        .simulation-bar { display: flex; margin-bottom: 12px; }
        .bar-win { flex: ${wins}; background: #28a745; padding: 8px; text-align: center; font-size: 10px; font-weight: 600; }
        .bar-loss { flex: ${losses}; background: #dc3545; padding: 8px; text-align: center; font-size: 10px; font-weight: 600; }
        .simulation-result { margin-top: 12px; padding: 12px; background: rgba(255, 255, 255, 0.1); border-radius: 4px; text-align: center; }
        .result-label { font-size: 10px; opacity: 0.8; }
        .result-value { font-size: 20px; font-weight: 700; margin-top: 4px; }
      </style>
      <div class="reality-title">💰 Risk Reality Check</div>
      <div class="reality-grid">
        <div class="reality-item">
          <div class="reality-label">Account Size</div>
          <div class="reality-value">$${capital.toLocaleString()}</div>
        </div>
        <div class="reality-item">
          <div class="reality-label">Risk Per Trade</div>
          <div class="reality-value">$${risk_amount.toFixed(0)}</div>
        </div>
        <div class="reality-item">
          <div class="reality-label">Win Rate</div>
          <div class="reality-value">${strategy_win_rate}%</div>
        </div>
        <div class="reality-item">
          <div class="reality-label">Expected Win</div>
          <div class="reality-value">$${expected_win.toFixed(0)}</div>
        </div>
      </div>

      <div class="simulation-section">
        <div class="simulation-title">📊 10-Trade Simulation</div>
        <div class="simulation-bar">
          <div class="bar-win">${wins}W</div>
          <div class="bar-loss">${losses}L</div>
        </div>
        <div class="simulation-result">
          <div class="result-label">Expected P&L After 10 Trades</div>
          <div class="result-value" style="color: ${net_10_trades >= 0 ? '#4ec9b0' : '#ff6b6b'};">
            ${net_10_trades >= 0 ? '+' : ''}$${net_10_trades.toFixed(0)}
          </div>
        </div>
      </div>
    </div>
  `;

  return {
    success: true,
    widget_id: id,
    resource_uri: `widget://${id}`,
    html,
    type: 'risk_reality',
  };
}
