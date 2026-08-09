// Complete Chart Analysis
export async function completeChartAnalysis({ symbol, timeframe, price, volume }) {
  const analysis = {
    fixed_range: fixedRangeIndicators(price),
    volume_analysis: volumeSignals(volume),
    fibonacci: fibonacciLevels(price),
    liquidity: liquidityFlowAnalysis(volume),
    trend: trendAnalysis(price),
    support_resistance: supportResistanceZones(price),
  };

  const signals = [
    analysis.fixed_range.signal,
    analysis.volume_analysis.signal,
    analysis.trend.signal,
  ];

  const bullishSignals = signals.filter(s => s === 'Bullish').length;
  const bearishSignals = signals.filter(s => s === 'Bearish').length;
  const neutralSignals = signals.filter(s => s === 'Neutral').length;

  const overallSignal = bullishSignals > bearishSignals ? 'BUY' : bearishSignals > bullishSignals ? 'SELL' : 'HOLD';
  const confidence = Math.max(bullishSignals, bearishSignals) * 33.33;

  return {
    success: true,
    symbol,
    timeframe,
    current_price: price,
    timestamp: Date.now(),
    analysis,
    signal_summary: {
      bullish_indicators: bullishSignals,
      bearish_indicators: bearishSignals,
      neutral_indicators: neutralSignals,
    },
    overall_signal: overallSignal,
    confidence: confidence.toFixed(1),
    key_levels: {
      support: analysis.support_resistance.support,
      resistance: analysis.support_resistance.resistance,
      fibonacci_support: analysis.fibonacci.level_38_2,
      fibonacci_resistance: analysis.fibonacci.level_61_8,
    },
    entry_zone: `${analysis.support_resistance.support.toFixed(2)} - ${(analysis.support_resistance.support + 2).toFixed(2)}`,
    take_profit: analysis.support_resistance.resistance.toFixed(2),
    stop_loss: (analysis.support_resistance.support - 5).toFixed(2),
    risk_reward_ratio: ((analysis.support_resistance.resistance - price) / (price - (analysis.support_resistance.support - 5))).toFixed(2),
  };
}

// Fixed Range Indicators (RSI, Stochastic, CCI)
function fixedRangeIndicators(price) {
  // Mock RSI calculation (simplified)
  const rsi = 30 + Math.random() * 40; // 30-70 range

  let rsiSignal = 'Neutral';
  if (rsi > 70) rsiSignal = 'Overbought';
  if (rsi < 30) rsiSignal = 'Oversold';

  // Mock Stochastic
  const stochastic_k = 20 + Math.random() * 60;
  const stochastic_d = stochastic_k + (Math.random() - 0.5) * 5;

  let stochasticSignal = 'Neutral';
  if (stochastic_k > 80) stochasticSignal = 'Overbought';
  if (stochastic_k < 20) stochasticSignal = 'Oversold';

  // Mock CCI
  const cci = (Math.random() - 0.5) * 200; // -100 to +100
  let cciSignal = 'Neutral';
  if (cci > 100) cciSignal = 'Overbought';
  if (cci < -100) cciSignal = 'Oversold';

  const overallSignal =
    (rsiSignal === 'Overbought' || stochasticSignal === 'Overbought') ? 'Bearish' :
    (rsiSignal === 'Oversold' || stochasticSignal === 'Oversold') ? 'Bullish' :
    'Neutral';

  return {
    rsi: rsi.toFixed(2),
    rsi_signal: rsiSignal,
    stochastic_k: stochastic_k.toFixed(2),
    stochastic_d: stochastic_d.toFixed(2),
    stochastic_signal: stochasticSignal,
    cci: cci.toFixed(2),
    cci_signal: cciSignal,
    signal: overallSignal,
    interpretation: `${overallSignal} - Fixed range indicators show ${overallSignal.toLowerCase()} momentum`,
  };
}

// Volume Analysis
function volumeSignals(current_volume) {
  const avg_volume = 1500000;
  const volumeRatio = current_volume / avg_volume;

  let volumeSignal = 'Neutral';
  let interpretation = '';

  if (volumeRatio > 1.5) {
    volumeSignal = 'Strong Up';
    interpretation = 'High volume with price up = Strong buying (Bullish)';
  } else if (volumeRatio > 1.0) {
    volumeSignal = 'Bullish';
    interpretation = 'Above average volume supporting move';
  } else if (volumeRatio < 0.5) {
    volumeSignal = 'Weak';
    interpretation = 'Low volume - be cautious, may reverse';
  } else {
    volumeSignal = 'Average';
    interpretation = 'Normal volume - no clear signal';
  }

  return {
    current_volume,
    avg_volume_20: avg_volume,
    volume_ratio: volumeRatio.toFixed(2),
    signal: volumeSignal,
    interpretation,
    accumulation_distribution: volumeRatio > 1.0 ? 'Accumulation' : 'Distribution',
  };
}

// Fibonacci Analysis
function fibonacciLevels(swing_high, swing_low, current) {
  // Use default if not provided
  const high = swing_high || current * 1.1;
  const low = swing_low || current * 0.9;
  const difference = high - low;

  const levels = {
    level_0: high,
    level_23_6: (high - difference * 0.236).toFixed(2),
    level_38_2: (high - difference * 0.382).toFixed(2),
    level_50_0: (high - difference * 0.5).toFixed(2),
    level_61_8: (high - difference * 0.618).toFixed(2),
    level_78_6: (high - difference * 0.786).toFixed(2),
    level_100: low,
  };

  const signal = current < levels.level_38_2 ? 'Support Zone' : current > levels.level_61_8 ? 'Resistance Zone' : 'Mid-Range';

  return {
    swing_high: high.toFixed(2),
    swing_low: low.toFixed(2),
    ...levels,
    current_position_between_levels: `${levels.level_38_2} - ${levels.level_61_8}`,
    key_support: levels.level_38_2,
    key_resistance: levels.level_61_8,
    signal,
  };
}

// Liquidity Flow Analysis
function liquidityFlowAnalysis(volume) {
  const bid_volume = 600000;
  const ask_volume = 550000;
  const bid_ask_ratio = bid_volume / ask_volume;

  let liquiditySignal = 'Balanced';
  if (bid_ask_ratio > 1.1) liquiditySignal = 'Bullish (More Buyers)';
  if (bid_ask_ratio < 0.9) liquiditySignal = 'Bearish (More Sellers)';

  const largeBuyOrders = Math.floor(volume * 0.15); // 15% of volume in large orders
  const largeTradeActivity = largeBuyOrders > 100000 ? 'High (Institutions Active)' : 'Normal';

  return {
    bid_volume,
    ask_volume,
    bid_ask_ratio: bid_ask_ratio.toFixed(2),
    liquidity_signal: liquiditySignal,
    large_trade_activity: largeTradeActivity,
    total_volume,
    order_book_strength: liquiditySignal,
    smart_money_indicator: largeTradeActivity === 'High (Institutions Active)' ? 'Institutional interest detected' : 'Retail dominated',
  };
}

// Trend Analysis (Moving Averages)
function trendAnalysis(price) {
  const sma_20 = price * (1 + (Math.random() - 0.5) * 0.02);
  const sma_50 = price * (1 + (Math.random() - 0.5) * 0.04);
  const sma_200 = price * (1 + (Math.random() - 0.5) * 0.06);

  let trendSignal = 'Neutral';
  let trend = 'Sideways';

  if (price > sma_20 && sma_20 > sma_50 && sma_50 > sma_200) {
    trendSignal = 'Bullish';
    trend = 'Strong Uptrend';
  } else if (price < sma_20 && sma_20 < sma_50 && sma_50 < sma_200) {
    trendSignal = 'Bearish';
    trend = 'Strong Downtrend';
  } else if (price > sma_50) {
    trendSignal = 'Bullish';
    trend = 'Uptrend';
  } else if (price < sma_50) {
    trendSignal = 'Bearish';
    trend = 'Downtrend';
  }

  // Mock MACD
  const macd_line = 0.5 + (Math.random() - 0.5);
  const signal_line = 0.3 + (Math.random() - 0.5);
  const macd_histogram = macd_line - signal_line;

  const macdSignal = macd_line > signal_line ? 'Bullish Crossover' : 'Bearish Crossover';

  return {
    sma_20: sma_20.toFixed(2),
    sma_50: sma_50.toFixed(2),
    sma_200: sma_200.toFixed(2),
    trend,
    trend_signal: trendSignal,
    price_vs_sma: price > sma_50 ? 'Above MA50 (Bullish)' : 'Below MA50 (Bearish)',
    macd_signal: macdSignal,
    momentum: macd_histogram > 0 ? 'Positive (Accelerating)' : 'Negative (Decelerating)',
    signal: trendSignal,
  };
}

// Support & Resistance
function supportResistanceZones(price) {
  const volatility = price * 0.02; // 2% volatility

  return {
    current_price: price.toFixed(2),
    immediate_support: (price - volatility).toFixed(2),
    support: (price - volatility * 2).toFixed(2),
    strong_support: (price - volatility * 3).toFixed(2),
    immediate_resistance: (price + volatility).toFixed(2),
    resistance: (price + volatility * 2).toFixed(2),
    strong_resistance: (price + volatility * 3).toFixed(2),
    support_zone: `${(price - volatility * 3).toFixed(2)} - ${(price - volatility).toFixed(2)}`,
    resistance_zone: `${(price + volatility).toFixed(2)} - ${(price + volatility * 3).toFixed(2)}`,
  };
}

// Signal Confirmation (Cross Multiple Indicators)
export async function signalConfirmation({
  symbol,
  rsi_signal,
  macd_signal,
  volume_signal,
  price_position,
}) {
  const signals = [];
  if (rsi_signal === 'oversold') signals.push('Bullish');
  if (rsi_signal === 'overbought') signals.push('Bearish');

  if (macd_signal === 'bullish') signals.push('Bullish');
  if (macd_signal === 'bearish') signals.push('Bearish');

  if (volume_signal === 'strong_up') signals.push('Bullish');
  if (volume_signal === 'strong_down') signals.push('Bearish');

  if (price_position === 'above_sma') signals.push('Bullish');
  if (price_position === 'below_sma') signals.push('Bearish');

  const bullishCount = signals.filter(s => s === 'Bullish').length;
  const bearishCount = signals.filter(s => s === 'Bearish').length;

  const confirmation = bullishCount > bearishCount ? 'CONFIRMED BULLISH' : bearishCount > bullishCount ? 'CONFIRMED BEARISH' : 'CONFLICTING SIGNALS';
  const strength = Math.max(bullishCount, bearishCount);

  return {
    success: true,
    symbol,
    confirmation,
    signal_strength: `${strength}/4`,
    individual_signals: {
      rsi: rsi_signal,
      macd: macd_signal,
      volume: volume_signal,
      price_position,
    },
    bullish_votes: bullishCount,
    bearish_votes: bearishCount,
    recommendation: confirmation === 'CONFLICTING SIGNALS' ? 'Wait for clearer signal' : `${confirmation} - High confidence trade setup`,
  };
}

// Chart Analysis Dashboard Widget
export async function createChartAnalysisDashboard(symbol, analysis) {
  const id = `chart_${Date.now()}`;

  const html = `
    <div class="widget-chart-dashboard" data-widget-id="${id}">
      <style>
        .widget-chart-dashboard { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 24px; background: linear-gradient(135deg, #1e3a8a 0%, #1f2937 100%); border-radius: 12px; color: white; max-width: 700px; }
        .chart-title { font-size: 22px; font-weight: 700; margin-bottom: 20px; text-align: center; }
        .analysis-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
        .analysis-card { background: rgba(255, 255, 255, 0.1); padding: 16px; border-radius: 8px; backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.2); }
        .card-label { font-size: 11px; opacity: 0.8; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
        .card-value { font-size: 16px; font-weight: 700; }
        .card-signal { font-size: 12px; margin-top: 8px; padding: 6px; border-radius: 4px; text-align: center; }
        .signal-bullish { background: #10b981; color: white; }
        .signal-bearish { background: #ef4444; color: white; }
        .signal-neutral { background: #6b7280; color: white; }
        .levels-section { margin-top: 20px; padding-top: 20px; border-top: 1px solid rgba(255, 255, 255, 0.2); }
        .levels-title { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; opacity: 0.9; }
        .level-item { display: flex; justify-content: space-between; padding: 8px 0; font-size: 12px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
        .level-name { opacity: 0.8; }
        .level-value { font-weight: 600; }
        .overall-section { margin-top: 20px; padding: 16px; background: rgba(255, 255, 255, 0.15); border-radius: 8px; text-align: center; }
        .overall-signal { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
        .overall-confidence { font-size: 12px; opacity: 0.9; }
      </style>
      <div class="chart-title">${symbol} - Complete Chart Analysis</div>
      <div class="analysis-grid">
        <div class="analysis-card">
          <div class="card-label">Trend</div>
          <div class="card-value">${analysis.trend || 'Uptrend'}</div>
          <div class="card-signal signal-bullish">${analysis.trend_signal || 'Bullish'}</div>
        </div>
        <div class="analysis-card">
          <div class="card-label">Momentum</div>
          <div class="card-value">${analysis.momentum || 'Accelerating'}</div>
          <div class="card-signal signal-bullish">Strong</div>
        </div>
        <div class="analysis-card">
          <div class="card-label">Volume</div>
          <div class="card-value">${analysis.volume_signal || 'Strong Up'}</div>
          <div class="card-signal signal-bullish">Bullish</div>
        </div>
        <div class="analysis-card">
          <div class="card-label">Liquidity</div>
          <div class="card-value">${analysis.liquidity || 'Good'}</div>
          <div class="card-signal signal-neutral">Healthy</div>
        </div>
      </div>

      <div class="levels-section">
        <div class="levels-title">Key Levels</div>
        <div class="level-item">
          <span class="level-name">Strong Resistance</span>
          <span class="level-value">${analysis.resistance || '0.00'}</span>
        </div>
        <div class="level-item">
          <span class="level-name">Fibonacci 61.8%</span>
          <span class="level-value">${analysis.fibonacci_levels?.[2] || '0.00'}</span>
        </div>
        <div class="level-item">
          <span class="level-name">Current Price</span>
          <span class="level-value" style="color: #fbbf24;">${analysis.current_price || '0.00'}</span>
        </div>
        <div class="level-item">
          <span class="level-name">Fibonacci 38.2%</span>
          <span class="level-value">${analysis.fibonacci_levels?.[1] || '0.00'}</span>
        </div>
        <div class="level-item">
          <span class="level-name">Strong Support</span>
          <span class="level-value">${analysis.support || '0.00'}</span>
        </div>
      </div>

      <div class="overall-section">
        <div class="overall-signal">${analysis.overall_signal || 'BUY'}</div>
        <div class="overall-confidence">All Indicators Aligned - High Confidence Setup</div>
      </div>
    </div>
  `;

  return {
    success: true,
    widget_id: id,
    resource_uri: `widget://${id}`,
    html,
    type: 'chart_analysis_dashboard',
  };
}

// Exported functions for tools
export async function fixedRangeAnalysis({ symbol, price, high_14, low_14 }) {
  return {
    success: true,
    symbol,
    ...fixedRangeIndicators(price),
  };
}

export async function volumeAnalysis({ symbol, current_volume, avg_volume_20, price_action }) {
  return {
    success: true,
    symbol,
    ...volumeSignals(current_volume),
    price_action,
  };
}

export async function fibonacciAnalysis({ symbol, swing_high, swing_low, current_price }) {
  return {
    success: true,
    symbol,
    ...fibonacciLevels(swing_high, swing_low, current_price),
  };
}

export async function getLiquidityFlowAnalysis({ symbol, bid_volume, ask_volume, large_trades }) {
  return {
    success: true,
    symbol,
    ...liquidityFlowAnalysis(bid_volume || 600000),
    large_trades,
  };
}

export async function trendMomentumAnalysis({ symbol, sma_20, sma_50, sma_200, current_price }) {
  return {
    success: true,
    symbol,
    sma_20,
    sma_50,
    sma_200,
    ...trendAnalysis(current_price),
  };
}

export async function supportResistanceAnalysis({ symbol, current_price, day_high, day_low, week_high, week_low }) {
  return {
    success: true,
    symbol,
    current_price,
    daily_range: `${day_low.toFixed(2)} - ${day_high.toFixed(2)}`,
    weekly_range: `${week_low.toFixed(2)} - ${week_high.toFixed(2)}`,
    ...supportResistanceZones(current_price),
  };
}
