// Win/loss analysis
export async function analyzeWinLoss(trades) {
  const wins = trades.filter(t => t.pips > 0 || t.type === 'win');
  const losses = trades.filter(t => t.pips < 0 || t.type === 'loss');

  const winPips = wins.reduce((sum, t) => sum + (t.pips || 0), 0);
  const lossPips = losses.reduce((sum, t) => sum + Math.abs(t.pips || 0), 0);

  const avgWin = wins.length > 0 ? winPips / wins.length : 0;
  const avgLoss = losses.length > 0 ? lossPips / losses.length : 0;

  const profitFactor = lossPips > 0 ? winPips / lossPips : (winPips > 0 ? Infinity : 0);
  const winRate = trades.length > 0 ? ((wins.length / trades.length) * 100).toFixed(2) : 0;

  return {
    success: true,
    total_trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    win_rate: `${winRate}%`,
    total_win_pips: winPips,
    total_loss_pips: lossPips,
    net_pips: winPips - lossPips,
    avg_win_pips: avgWin.toFixed(2),
    avg_loss_pips: avgLoss.toFixed(2),
    profit_factor: profitFactor.toFixed(2),
    largest_win: Math.max(...wins.map(t => t.pips || 0)),
    largest_loss: Math.min(...losses.map(t => t.pips || 0)),
  };
}

// Drawdown analysis
export async function analyzeDrawdown(equityData) {
  if (!equityData || equityData.length === 0) {
    return { success: false, error: 'No equity data' };
  }

  let peak = equityData[0][1];
  let maxDD = 0;
  let maxDDPercent = 0;
  let maxDDIndex = 0;
  let recoveryTime = 0;
  let inDD = false;
  let ddStart = 0;

  const drawdowns = [];

  for (let i = 0; i < equityData.length; i++) {
    const equity = equityData[i][1];

    if (equity > peak) {
      peak = equity;
      if (inDD) {
        recoveryTime = i - ddStart;
        inDD = false;
      }
    } else {
      const dd = peak - equity;
      const ddPercent = (dd / peak) * 100;

      if (dd > maxDD) {
        maxDD = dd;
        maxDDPercent = ddPercent;
        maxDDIndex = i;
        ddStart = i;
        inDD = true;
      }

      drawdowns.push({ time: equityData[i][0], dd, ddPercent });
    }
  }

  return {
    success: true,
    max_drawdown: maxDD.toFixed(2),
    max_drawdown_percent: maxDDPercent.toFixed(2),
    recovery_time_bars: recoveryTime,
    current_drawdown: (peak - equityData[equityData.length - 1][1]).toFixed(2),
    drawdowns: drawdowns.slice(-50), // Last 50 drawdowns
  };
}

// Trade duration analysis
export async function analyzeDuration(trades) {
  if (!trades || trades.length === 0) {
    return { success: false, error: 'No trades' };
  }

  const durations = trades
    .map(t => t.duration_minutes || (t.exit_time - t.entry_time) / 60000)
    .filter(d => d > 0);

  const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
  const minDuration = Math.min(...durations);
  const maxDuration = Math.max(...durations);
  const medianDuration = durations.sort((a, b) => a - b)[Math.floor(durations.length / 2)];

  // Group by duration buckets
  const buckets = {
    '< 5min': 0,
    '5-15min': 0,
    '15-60min': 0,
    '1-4h': 0,
    '4-24h': 0,
    '> 1day': 0,
  };

  durations.forEach(d => {
    if (d < 5) buckets['< 5min']++;
    else if (d < 15) buckets['5-15min']++;
    else if (d < 60) buckets['15-60min']++;
    else if (d < 240) buckets['1-4h']++;
    else if (d < 1440) buckets['4-24h']++;
    else buckets['> 1day']++;
  });

  return {
    success: true,
    total_trades: trades.length,
    avg_duration_minutes: avgDuration.toFixed(2),
    min_duration_minutes: minDuration,
    max_duration_minutes: maxDuration,
    median_duration_minutes: medianDuration,
    distribution: buckets,
  };
}

// Risk/reward analysis
export async function analyzeRiskReward(trades) {
  const riskRewards = trades
    .filter(t => t.stop_loss && t.take_profit)
    .map(t => {
      const risk = Math.abs(t.entry - t.stop_loss);
      const reward = Math.abs(t.take_profit - t.entry);
      return reward / (risk || 1);
    });

  const expectancy = trades.length > 0
    ? trades.reduce((sum, t) => sum + t.pips, 0) / trades.length
    : 0;

  const winPips = trades.filter(t => t.win).reduce((sum, t) => sum + t.pips, 0);
  const lossPips = trades.filter(t => !t.win).reduce((sum, t) => sum + Math.abs(t.pips), 0);
  const profitFactor = lossPips > 0 ? winPips / lossPips : Infinity;

  return {
    success: true,
    avg_risk_reward_ratio: (riskRewards.reduce((a, b) => a + b, 0) / (riskRewards.length || 1)).toFixed(2),
    expectancy_per_trade: expectancy.toFixed(2),
    profit_factor: profitFactor.toFixed(2),
    best_rr_ratio: Math.max(...riskRewards).toFixed(2),
    worst_rr_ratio: Math.min(...riskRewards).toFixed(2),
  };
}

// Consecutive wins/losses
export async function analyzeSequences(trades) {
  const sequences = [];
  let current = { type: trades[0]?.win ? 'win' : 'loss', count: 1, pips: trades[0]?.pips || 0 };

  for (let i = 1; i < trades.length; i++) {
    const isWin = trades[i].win;
    if ((isWin && current.type === 'win') || (!isWin && current.type === 'loss')) {
      current.count++;
      current.pips += trades[i].pips;
    } else {
      sequences.push(current);
      current = { type: isWin ? 'win' : 'loss', count: 1, pips: trades[i].pips };
    }
  }
  sequences.push(current);

  const winStreaks = sequences.filter(s => s.type === 'win').map(s => s.count);
  const lossStreaks = sequences.filter(s => s.type === 'loss').map(s => s.count);

  return {
    success: true,
    total_sequences: sequences.length,
    longest_win_streak: Math.max(...winStreaks, 0),
    longest_loss_streak: Math.max(...lossStreaks, 0),
    avg_win_streak: winStreaks.length > 0 ? (winStreaks.reduce((a, b) => a + b, 0) / winStreaks.length).toFixed(2) : 0,
    avg_loss_streak: lossStreaks.length > 0 ? (lossStreaks.reduce((a, b) => a + b, 0) / lossStreaks.length).toFixed(2) : 0,
    current_streak: sequences[sequences.length - 1],
  };
}

// Time of day analysis
export async function analyzeTimeOfDay(trades) {
  const byHour = {};
  for (let h = 0; h < 24; h++) byHour[h] = { wins: 0, losses: 0, pips: 0, trades: 0 };

  trades.forEach(t => {
    const hour = new Date(t.entry_time).getHours();
    byHour[hour].trades++;
    byHour[hour].pips += t.pips;
    if (t.win) byHour[hour].wins++;
    else byHour[hour].losses++;
  });

  const hourlyStats = Object.entries(byHour).map(([hour, data]) => ({
    hour: parseInt(hour),
    trades: data.trades,
    win_rate: data.trades > 0 ? `${((data.wins / data.trades) * 100).toFixed(1)}%` : '0%',
    avg_pips: data.trades > 0 ? (data.pips / data.trades).toFixed(2) : 0,
    total_pips: data.pips,
  }));

  return {
    success: true,
    by_hour: hourlyStats,
    best_hour: hourlyStats.reduce((best, h) => parseFloat(h.avg_pips) > parseFloat(best.avg_pips) ? h : best),
    worst_hour: hourlyStats.reduce((worst, h) => parseFloat(h.avg_pips) < parseFloat(worst.avg_pips) ? h : worst),
  };
}

// Slippage analysis
export async function analyzeSlippage(trades) {
  const entrySlippages = trades.map(t => Math.abs(t.actual_entry - t.expected_entry));
  const exitSlippages = trades.map(t => Math.abs(t.actual_exit - t.expected_exit));

  const avgEntrySlippage = entrySlippages.reduce((a, b) => a + b, 0) / entrySlippages.length;
  const avgExitSlippage = exitSlippages.reduce((a, b) => a + b, 0) / exitSlippages.length;

  return {
    success: true,
    total_trades: trades.length,
    avg_entry_slippage: avgEntrySlippage.toFixed(5),
    avg_exit_slippage: avgExitSlippage.toFixed(5),
    max_entry_slippage: Math.max(...entrySlippages).toFixed(5),
    max_exit_slippage: Math.max(...exitSlippages).toFixed(5),
    total_slippage_cost: (entrySlippages.reduce((a, b) => a + b, 0) + exitSlippages.reduce((a, b) => a + b, 0)).toFixed(5),
  };
}

// Period analysis
export async function analyzeByPeriod(trades, period) {
  const grouped = {};

  trades.forEach(t => {
    const date = new Date(t.entry_time);
    let key;

    if (period === 'daily') {
      key = date.toISOString().split('T')[0];
    } else if (period === 'weekly') {
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay());
      key = weekStart.toISOString().split('T')[0];
    } else {
      key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    }

    if (!grouped[key]) {
      grouped[key] = { trades: 0, wins: 0, losses: 0, pips: 0 };
    }
    grouped[key].trades++;
    grouped[key].pips += t.pips;
    if (t.win) grouped[key].wins++;
    else grouped[key].losses++;
  });

  const stats = Object.entries(grouped)
    .sort()
    .map(([period, data]) => ({
      period,
      trades: data.trades,
      win_rate: `${((data.wins / data.trades) * 100).toFixed(1)}%`,
      total_pips: data.pips,
      avg_pips_per_trade: (data.pips / data.trades).toFixed(2),
    }));

  return {
    success: true,
    period_type: period,
    periods: stats,
    best_period: stats.reduce((best, p) => parseFloat(p.total_pips) > parseFloat(best.total_pips) ? p : best),
    worst_period: stats.reduce((worst, p) => parseFloat(p.total_pips) < parseFloat(worst.total_pips) ? p : worst),
  };
}

// Heatmap widget
export async function createHeatmap({ data, title }) {
  const id = `heatmap_${Date.now()}`;
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const hours = Array.from({ length: 24 }, (_, i) => `${i}:00`);

  let html = `<div class="widget-heatmap" data-widget-id="${id}"><style>
    .widget-heatmap { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; background: white; border-radius: 8px; }
    .heatmap-title { font-size: 16px; font-weight: 600; margin-bottom: 16px; }
    .heatmap-grid { display: grid; grid-template-columns: 60px repeat(24, 1fr); gap: 2px; }
    .heatmap-label { font-size: 11px; font-weight: 500; display: flex; align-items: center; justify-content: center; }
    .heatmap-cell { aspect-ratio: 1; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 500; color: white; cursor: pointer; }
  </style><div class="heatmap-title">${title}</div><div class="heatmap-grid">`;

  // Header hours
  html += '<div class="heatmap-label"></div>';
  hours.forEach(h => html += `<div class="heatmap-label">${h}</div>`);

  // Rows per day
  days.forEach(day => {
    html += `<div class="heatmap-label">${day}</div>`;
    for (let h = 0; h < 24; h++) {
      const val = (data[day] && data[day][h]) || 0;
      const color = val > 0 ? `hsl(120, 70%, ${Math.max(30, 70 - val * 5)}%)` : `hsl(0, 70%, ${Math.max(30, 70 + val * 5)}%)`;
      html += `<div class="heatmap-cell" style="background: ${color};" title="${val}">${val}</div>`;
    }
  });

  html += '</div></div>';

  return {
    success: true,
    widget_id: id,
    resource_uri: `widget://${id}`,
    html,
    type: 'heatmap',
  };
}

// Histogram widget
export async function createHistogram({ trades, title, bins }) {
  const id = `histogram_${Date.now()}`;
  const minVal = Math.min(...trades);
  const maxVal = Math.max(...trades);
  const range = (maxVal - minVal) || 1;
  const binWidth = range / bins;

  const histogram = Array(bins).fill(0);
  trades.forEach(t => {
    const binIndex = Math.min(bins - 1, Math.floor((t - minVal) / binWidth));
    histogram[binIndex]++;
  });

  const maxCount = Math.max(...histogram);
  const barHtml = histogram.map((count, i) => {
    const binStart = (minVal + i * binWidth).toFixed(2);
    const binEnd = (minVal + (i + 1) * binWidth).toFixed(2);
    const height = (count / maxCount) * 100;
    return `<div class="histogram-bar" style="height: ${height}%;" title="${binStart} to ${binEnd}: ${count} trades"></div>`;
  }).join('');

  const html = `<div class="widget-histogram" data-widget-id="${id}"><style>
    .widget-histogram { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; background: white; border-radius: 8px; }
    .histogram-title { font-size: 16px; font-weight: 600; margin-bottom: 16px; }
    .histogram-container { display: flex; align-items: flex-end; height: 200px; gap: 2px; }
    .histogram-bar { flex: 1; background: #007bff; border-radius: 2px 2px 0 0; opacity: 0.8; }
    .histogram-bar:hover { opacity: 1; }
  </style><div class="histogram-title">${title}</div><div class="histogram-container">${barHtml}</div></div>`;

  return {
    success: true,
    widget_id: id,
    resource_uri: `widget://${id}`,
    html,
    type: 'histogram',
  };
}

// Drawdown chart widget
export async function createDrawdownChart({ equityData, title }) {
  const id = `drawdown_${Date.now()}`;

  let peak = equityData[0][1];
  const points = [];

  equityData.forEach((point, i) => {
    const equity = point[1];
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    const x = (i / (equityData.length - 1)) * 100;
    const y = 100 - Math.max(0, Math.min(100, dd));
    points.push(`${x},${y}`);
  });

  const svgPath = points.join(' L ');

  const html = `<div class="widget-drawdown" data-widget-id="${id}"><style>
    .widget-drawdown { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; background: white; border-radius: 8px; }
    .drawdown-title { font-size: 16px; font-weight: 600; margin-bottom: 16px; }
    .drawdown-svg { width: 100%; height: 200px; border: 1px solid #e9ecef; border-radius: 4px; }
  </style><div class="drawdown-title">${title}</div><svg class="drawdown-svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
    <polyline points="${svgPath}" fill="none" stroke="#dc3545" stroke-width="0.5" vector-effect="non-scaling-stroke" />
    <polyline points="${svgPath}" fill="url(#gradient)" opacity="0.3" />
    <defs><linearGradient id="gradient" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" style="stop-color:#dc3545;stop-opacity:1" /><stop offset="100%" style="stop-color:#dc3545;stop-opacity:0" /></linearGradient></defs>
  </svg></div>`;

  return {
    success: true,
    widget_id: id,
    resource_uri: `widget://${id}`,
    html,
    type: 'drawdown_chart',
  };
}

// Trade report widget
export async function createTradeReport({ stats, title }) {
  const id = `report_${Date.now()}`;

  const reportRows = Object.entries(stats)
    .filter(([key]) => key !== 'recovery_trades')
    .map(([label, value]) => `<div class="report-row"><span class="report-label">${label.replace(/_/g, ' ')}</span><span class="report-value">${value}</span></div>`)
    .join('');

  const html = `<div class="widget-report" data-widget-id="${id}"><style>
    .widget-report { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 8px; color: white; max-width: 500px; }
    .report-title { font-size: 18px; font-weight: 600; margin-bottom: 16px; }
    .report-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
    .report-row:last-child { border-bottom: none; }
    .report-label { opacity: 0.9; text-transform: capitalize; }
    .report-value { font-weight: 600; }
  </style><div class="report-title">${title}</div>${reportRows}</div>`;

  return {
    success: true,
    widget_id: id,
    resource_uri: `widget://${id}`,
    html,
    type: 'trade_report',
  };
}
