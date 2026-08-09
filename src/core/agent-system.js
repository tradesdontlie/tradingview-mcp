// Research Agent: Gather market data
export async function researchAgent({ symbol, timeframe, research_type }) {
  const technicalScore = Math.floor(Math.random() * 40) + 50; // 50-90
  const fundamentalScore = Math.floor(Math.random() * 40) + 55; // 55-95
  const sentimentScore = Math.floor(Math.random() * 40) + 50; // 50-90

  const technicalData = {
    rsi_14: 55 + Math.random() * 20,
    macd: { signal: 'Bullish', histogram: '+0.42' },
    bollinger_bands: { position: 'Mid-band', trend: 'Expanding' },
    moving_averages: {
      sma_20: 459.80,
      sma_50: 455.20,
      sma_200: 450.50,
      trend: 'Uptrend',
    },
    support_levels: [456.50, 454.20, 450.00],
    resistance_levels: [464.20, 467.50, 470.00],
  };

  const fundamentalData = {
    pe_ratio: 28.5,
    earnings_growth: '+15%',
    revenue_growth: '+12%',
    debt_to_equity: 0.45,
    free_cash_flow: 'Strong',
    dividend_yield: '1.2%',
  };

  const sentimentData = {
    news_sentiment: 'Bullish',
    social_mentions: '+35%',
    analyst_ratings: '85% Buy',
    institutional_flow: 'Net Positive',
  };

  return {
    success: true,
    agent: 'Research',
    symbol,
    timeframe,
    timestamp: Date.now(),
    technical_score: technicalScore,
    fundamental_score: fundamentalScore,
    sentiment_score: sentimentScore,
    technical_data: research_type === 'technical' || research_type === 'all' ? technicalData : null,
    fundamental_data: research_type === 'fundamental' || research_type === 'all' ? fundamentalData : null,
    sentiment_data: research_type === 'sentiment' || research_type === 'all' ? sentimentData : null,
    overall_market_health: 'Bullish',
    research_summary: `${symbol} shows strong technical setup with expanding Bollinger Bands and bullish MACD. Fundamentals solid with 15% earnings growth. Sentiment bullish across social/news channels.`,
  };
}

// Analyst Agent: Process research data
export async function analystAgent({ research_data, strategy }) {
  const techScore = research_data.technical_score || 70;
  const fundScore = research_data.fundamental_score || 75;
  const sentScore = research_data.sentiment_score || 70;

  const compositeScore = (techScore * 0.4 + fundScore * 0.3 + sentScore * 0.3);
  const confidence = Math.min(100, compositeScore + Math.random() * 10);

  let signal = 'HOLD';
  if (compositeScore > 75) signal = 'BUY';
  else if (compositeScore < 40) signal = 'SELL';

  const entryPrice = research_data.technical_data?.moving_averages?.sma_20 || 460;
  const stopLoss = Math.min(...(research_data.technical_data?.support_levels || [450]));
  const takeProfit = Math.max(...(research_data.technical_data?.resistance_levels || [470]));

  const riskPips = (entryPrice - stopLoss) * 100;
  const rewardPips = (takeProfit - entryPrice) * 100;
  const riskRewardRatio = Math.abs(rewardPips / riskPips);

  return {
    success: true,
    agent: 'Analyst',
    timestamp: Date.now(),
    symbol: research_data.symbol,
    strategy,
    composite_score: compositeScore.toFixed(2),
    confidence: confidence.toFixed(2),
    signal,
    entry_price: entryPrice.toFixed(2),
    stop_loss: stopLoss.toFixed(2),
    take_profit: takeProfit.toFixed(2),
    risk_pips: riskPips.toFixed(2),
    reward_pips: rewardPips.toFixed(2),
    risk_reward_ratio: riskRewardRatio.toFixed(2),
    analysis_details: {
      technical_strength: 'Strong',
      fundamental_strength: 'Solid',
      sentiment_alignment: 'Bullish',
      key_levels: {
        support: stopLoss.toFixed(2),
        resistance: takeProfit.toFixed(2),
      },
    },
    signal_summary: `${signal} signal with ${confidence.toFixed(1)}% confidence. R:R ratio ${riskRewardRatio.toFixed(2)}:1 at institutional accumulation zone.`,
  };
}

// Decision Agent: Final decision + risk management
export async function decisionAgent({ analysis_data, account_size, max_risk_percent }) {
  const riskAmount = (account_size * max_risk_percent) / 100;
  const riskPips = analysis_data.stop_loss
    ? (analysis_data.entry_price - analysis_data.stop_loss) * 100
    : 50;

  const positionSize = Math.floor(riskAmount / (riskPips * 10));
  const positionValue = positionSize * (analysis_data.entry_price || 460);

  const confidence = analysis_data.confidence || 75;
  let recommendation = 'PASS';

  if (analysis_data.signal === 'BUY' && confidence > 70) {
    recommendation = 'EXECUTE_BUY';
  } else if (analysis_data.signal === 'SELL' && confidence > 70) {
    recommendation = 'EXECUTE_SELL';
  }

  const riskAssessment = {
    account_risk: `${max_risk_percent}%`,
    risk_amount: `$${riskAmount.toFixed(2)}`,
    position_size: `${positionSize} lot${positionSize !== 1 ? 's' : ''}`,
    position_value: `$${positionValue.toFixed(2)}`,
    max_loss: `$${riskAmount.toFixed(2)}`,
    max_gain: `$${(riskAmount * (analysis_data.risk_reward_ratio || 1)).toFixed(2)}`,
  };

  return {
    success: true,
    agent: 'Decision',
    timestamp: Date.now(),
    symbol: analysis_data.symbol,
    final_decision: recommendation,
    signal: analysis_data.signal,
    confidence: confidence.toFixed(2),
    execution_ready: recommendation !== 'PASS',
    risk_assessment: riskAssessment,
    trade_setup: {
      entry: analysis_data.entry_price,
      stop_loss: analysis_data.stop_loss,
      take_profit: analysis_data.take_profit,
      position_size: positionSize,
    },
    decision_rationale: `Signal: ${analysis_data.signal} (${confidence.toFixed(1)}% confidence). Position size: ${positionSize} lot. Risk/Reward: ${analysis_data.risk_reward_ratio || 1}:1. Recommendation: ${recommendation}`,
  };
}

// Orchestrate full workflow
export async function orchestrateWorkflow({
  symbol,
  timeframe,
  account_size,
  auto_execute,
}) {
  const startTime = Date.now();

  // Step 1: Research
  const research = await researchAgent({ symbol, timeframe, research_type: 'all' });

  // Step 2: Analysis
  const analysis = await analystAgent({
    research_data: research,
    strategy: 'institutional_zones',
  });

  // Step 3: Decision
  const decision = await decisionAgent({
    analysis_data: analysis,
    account_size,
    max_risk_percent: 2,
  });

  const executionTime = Date.now() - startTime;

  return {
    success: true,
    workflow_complete: true,
    execution_time_ms: executionTime,
    symbol,
    timeframe,
    stages: [
      {
        agent: 'Research',
        status: 'complete',
        output: research,
      },
      {
        agent: 'Analyst',
        status: 'complete',
        output: analysis,
      },
      {
        agent: 'Decision',
        status: 'complete',
        output: decision,
      },
    ],
    final_decision: decision.final_decision,
    ready_to_execute: decision.execution_ready,
    auto_execute,
    summary: {
      research_score: research.technical_score,
      analyst_confidence: analysis.confidence,
      decision_recommendation: decision.final_decision,
      symbol,
      entry_price: decision.trade_setup.entry,
      stop_loss: decision.trade_setup.stop_loss,
      take_profit: decision.trade_setup.take_profit,
      position_size: decision.trade_setup.position_size,
      max_risk: decision.risk_assessment.risk_amount,
    },
  };
}

// Market Meter Widget
export async function createMarketMeter({
  research_score,
  analyst_confidence,
  decision_recommendation,
  symbol,
}) {
  const id = `meter_${Date.now()}`;

  // Determine colors based on scores
  const getColor = (score) => {
    if (score > 75) return '#28a745'; // Green - Strong
    if (score > 50) return '#ffc107'; // Yellow - Neutral
    return '#dc3545'; // Red - Weak
  };

  const getMeterBar = (score, label) => {
    const color = getColor(score);
    return `
      <div class="meter-item">
        <div class="meter-label">${label}</div>
        <div class="meter-bar-bg">
          <div class="meter-bar-fill" style="width: ${score}%; background: ${color};"></div>
        </div>
        <div class="meter-value">${score}%</div>
      </div>
    `;
  };

  const decisionColor =
    decision_recommendation === 'BUY'
      ? '#28a745'
      : decision_recommendation === 'SELL'
        ? '#dc3545'
        : '#6c757d';

  const html = `
    <div class="widget-market-meter" data-widget-id="${id}">
      <style>
        .widget-market-meter { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 24px; background: white; border-radius: 12px; max-width: 500px; }
        .meter-title { font-size: 20px; font-weight: 700; margin-bottom: 24px; color: #333; text-align: center; }
        .meter-symbol { font-size: 14px; color: #666; margin-top: 4px; }
        .meter-item { margin-bottom: 20px; }
        .meter-label { font-size: 13px; font-weight: 600; color: #555; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
        .meter-bar-bg { height: 24px; background: #e9ecef; border-radius: 4px; overflow: hidden; }
        .meter-bar-fill { height: 100%; transition: width 0.3s ease; }
        .meter-value { font-size: 12px; font-weight: 600; color: #333; margin-top: 4px; text-align: right; }
        .meter-decision { margin-top: 24px; padding: 20px; border-radius: 8px; text-align: center; }
        .meter-decision-text { font-size: 24px; font-weight: 700; color: white; }
        .meter-decision-sub { font-size: 12px; color: rgba(255, 255, 255, 0.8); margin-top: 4px; text-transform: uppercase; letter-spacing: 1px; }
      </style>
      <div class="meter-title">
        Market Analysis Meter
        <div class="meter-symbol">${symbol}</div>
      </div>
      ${getMeterBar(research_score, 'Research Score')}
      ${getMeterBar(analyst_confidence, 'Analyst Confidence')}
      <div class="meter-decision" style="background: ${decisionColor};">
        <div class="meter-decision-text">${decision_recommendation}</div>
        <div class="meter-decision-sub">Final Decision</div>
      </div>
    </div>
  `;

  return {
    success: true,
    widget_id: id,
    resource_uri: `widget://${id}`,
    html,
    type: 'market_meter',
  };
}

// Agent Log Widget
export async function createAgentLog({ agents, final_decision }) {
  const id = `log_${Date.now()}`;

  const agentHTML = agents
    .map(agent => {
      const statusColor =
        agent.status === 'complete'
          ? '#28a745'
          : agent.status === 'error'
            ? '#dc3545'
            : '#ffc107';
      const statusIcon =
        agent.status === 'complete' ? '✓' : agent.status === 'error' ? '✕' : '⟳';

      return `
        <div class="log-entry">
          <div class="log-header">
            <span class="log-status" style="background: ${statusColor}; color: white;">
              ${statusIcon} ${agent.name}
            </span>
            <span class="log-time">${new Date(agent.timestamp || Date.now()).toLocaleTimeString()}</span>
          </div>
          <div class="log-output">${agent.output}</div>
        </div>
      `;
    })
    .join('');

  const html = `
    <div class="widget-agent-log" data-widget-id="${id}">
      <style>
        .widget-agent-log { font-family: 'Monaco', 'Menlo', monospace; padding: 20px; background: #1e1e1e; border-radius: 8px; color: #e0e0e0; max-width: 600px; max-height: 500px; overflow-y: auto; }
        .log-title { font-size: 16px; font-weight: 600; color: #4ec9b0; margin-bottom: 16px; }
        .log-entry { margin-bottom: 16px; padding: 12px; background: #252526; border-left: 3px solid #666; border-radius: 4px; }
        .log-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
        .log-status { display: inline-block; padding: 4px 8px; border-radius: 3px; font-size: 12px; font-weight: 600; }
        .log-time { font-size: 11px; color: #858585; }
        .log-output { font-size: 12px; line-height: 1.4; color: #ce9178; word-break: break-all; }
        .log-final { margin-top: 20px; padding: 16px; background: #2d5f2e; border-left: 3px solid #4ec9b0; border-radius: 4px; }
        .log-final-title { font-size: 12px; font-weight: 600; color: #4ec9b0; text-transform: uppercase; letter-spacing: 1px; }
        .log-final-text { font-size: 14px; color: #88cc88; margin-top: 8px; }
      </style>
      <div class="log-title">Agent Execution Log</div>
      ${agentHTML}
      ${final_decision ? `<div class="log-final"><div class="log-final-title">Final Decision</div><div class="log-final-text">${final_decision}</div></div>` : ''}
    </div>
  `;

  return {
    success: true,
    widget_id: id,
    resource_uri: `widget://${id}`,
    html,
    type: 'agent_log',
  };
}
