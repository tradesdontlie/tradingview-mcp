// India Market Context
export async function getMarketContext(market_type) {
  const contexts = {
    nifty50: {
      index: 'NIFTY 50',
      price: 24580.45,
      change: '+0.85%',
      volume: '890M',
      sectors: {
        IT: { change: '+1.2%', weight: '22%' },
        Banking: { change: '+0.6%', weight: '28%' },
        Auto: { change: '+1.8%', weight: '8%' },
        Pharma: { change: '+0.3%', weight: '6%' },
        FMCG: { change: '-0.2%', weight: '12%' },
        Energy: { change: '+2.1%', weight: '18%' },
      },
      fii_flow: '+$250M (Net Positive)',
      dii_flow: '-$120M (Net Selling)',
      market_sentiment: 'Bullish on IT/Auto, Cautious on FMCG',
    },
    sensex: {
      index: 'BSE SENSEX',
      price: 82156.30,
      change: '+0.92%',
      volume: '650M',
      fii_flow: '+$280M',
      dii_flow: '-$100M',
      market_sentiment: 'Strong FII buying in IT & Banking',
    },
    midcap: {
      index: 'NIFTY MIDCAP 100',
      price: 12456.20,
      change: '-0.15%',
      volume: '120M',
      fii_flow: '-$50M (Profit Taking)',
      dii_flow: '+$200M',
      market_sentiment: 'DII accumulation in quality midcaps',
    },
    smallcap: {
      index: 'NIFTY SMALLCAP 50',
      price: 8945.60,
      change: '+1.35%',
      volume: '45M',
      fii_flow: '-$80M',
      dii_flow: '+$150M',
      market_sentiment: 'Domestic interest in smallcaps',
    },
  };

  return {
    success: true,
    market_type,
    ...contexts[market_type],
    timestamp: Date.now(),
  };
}

// FII/DII Analysis
export async function getFIIDIIAnalysis(period) {
  const data = {
    today: {
      fii_inflow: 250,
      dii_outflow: -120,
      net_flow: 130,
      top_buying_sectors: ['IT', 'Banking', 'Auto'],
      top_selling_sectors: ['FMCG', 'Telecom'],
      fii_avg_buy_price: 'Premium to close',
      dii_avg_sell_price: 'At support levels',
    },
    week: {
      fii_cumulative: 1250,
      dii_cumulative: -450,
      net_flow: 800,
      trend: 'Strong FII buying',
      volatility: 'Moderate',
    },
    month: {
      fii_cumulative: 3200,
      dii_cumulative: 1800,
      net_flow: 5000,
      trend: 'Sustained institutional interest',
      sectors_favored: ['IT', 'Financial Services', 'Auto'],
      sectors_avoided: ['Telecom', 'PSU Banks'],
    },
  };

  return {
    success: true,
    period,
    analysis: data[period],
    market_implication: `${period === 'today' ? 'FII buying strength suggests bullish momentum.' : 'Sustained institutional flows indicate long-term accumulation.'}`,
    trading_signal: 'Buy on dips in FII-favored sectors',
    timestamp: Date.now(),
  };
}

// Block Deal Analysis
export async function analyzeBlockDeals(stock, date_range) {
  const blockDeals = [
    {
      stock: 'INFY',
      buyer: 'Goldman Sachs',
      seller: 'Promoter',
      quantity: 250000,
      price: 1645.50,
      value_cr: 411.38,
      date: '2026-08-08',
      significance: 'Promoter offloading, FII accumulation',
    },
    {
      stock: 'TCS',
      buyer: 'Vanguard',
      seller: 'Promoter Nominee',
      quantity: 150000,
      price: 4125.75,
      value_cr: 618.86,
      date: '2026-08-07',
      significance: 'Strong institutional buying',
    },
    {
      stock: 'RELIANCE',
      buyer: 'Dimensional Fund',
      seller: 'HNI',
      quantity: 400000,
      price: 2985.25,
      value_cr: 1194.10,
      date: '2026-08-06',
      significance: 'Institutional accumulation in energy',
    },
  ];

  return {
    success: true,
    stock,
    block_deals: blockDeals.filter(d => !stock || d.stock === stock),
    total_deals: blockDeals.length,
    total_value_cr: blockDeals.reduce((sum, d) => sum + d.value_cr, 0),
    trend: 'Heavy institutional buying in IT and Energy',
    sentiment: 'Bullish accumulation',
  };
}

// Bulk Deal Analysis
export async function analyzeBulkDeals(stock, pattern) {
  const deals = {
    accumulation: [
      { stock: 'INFY', buyer: 'FPI', quantity: 500000, avg_price: 1643.20, pattern: 'accumulation' },
      { stock: 'WIPRO', buyer: 'MF', quantity: 250000, avg_price: 420.50, pattern: 'accumulation' },
    ],
    distribution: [
      { stock: 'KOTAKBANK', seller: 'HNI', quantity: 300000, avg_price: 1850.75, pattern: 'distribution' },
      { stock: 'HDFC', seller: 'Promoter', quantity: 200000, avg_price: 2540.30, pattern: 'distribution' },
    ],
  };

  return {
    success: true,
    stock,
    pattern,
    deals: pattern === 'all' ? [...deals.accumulation, ...deals.distribution] : deals[pattern] || [],
    institutional_signal: pattern === 'accumulation' ? 'Bullish' : pattern === 'distribution' ? 'Bearish' : 'Neutral',
    top_accumulators: ['INFY', 'TCS', 'RELIANCE'],
    top_distributors: ['KOTAKBANK', 'HDFC'],
  };
}

// Sector Rotation Analysis
export async function analyzeSectorRotation(sectors) {
  const sectorData = {
    IT: { strength: 85, fii_interest: 'High', performance: '+2.1%', trend: 'Strong Uptrend' },
    Banking: { strength: 72, fii_interest: 'High', performance: '+0.6%', trend: 'Consolidation' },
    Auto: { strength: 78, fii_interest: 'Medium', performance: '+1.8%', trend: 'Breaking Out' },
    Pharma: { strength: 58, fii_interest: 'Low', performance: '+0.3%', trend: 'Weak' },
    FMCG: { strength: 42, fii_interest: 'Low', performance: '-0.2%', trend: 'Downtrend' },
    Energy: { strength: 81, fii_interest: 'High', performance: '+2.1%', trend: 'Breakout' },
  };

  return {
    success: true,
    sectors_analyzed: sectors,
    sector_analysis: sectors.map(s => ({ sector: s, ...sectorData[s] })),
    rotation_pattern: 'Institutions rotating to Energy/Auto from FMCG',
    strong_sectors: ['IT', 'Energy', 'Auto'],
    weak_sectors: ['FMCG', 'Pharma'],
    recommendation: 'Follow institutional rotation into Energy/Auto',
  };
}

// Institutional Zones
export async function findInstitutionalZones(stock, timeframe) {
  const zones = {
    accumulation: [
      { level: 1640.00, strength: 85, bars_spent: 45, volume: 'Very High', status: 'Strong Support' },
      { level: 1630.00, strength: 92, bars_spent: 78, volume: 'Extreme', status: 'Major Support' },
    ],
    distribution: [
      { level: 1700.00, strength: 72, bars_spent: 32, volume: 'High', status: 'Resistance Zone' },
      { level: 1720.00, strength: 65, bars_spent: 20, volume: 'Moderate', status: 'Secondary Resistance' },
    ],
  };

  return {
    success: true,
    stock,
    timeframe,
    accumulation_zones: zones.accumulation,
    distribution_zones: zones.distribution,
    current_price_zone: 'Near major accumulation (1640)',
    institutional_activity: 'High accumulation below 1640, resistance at 1700+',
    trading_implication: 'Strong support at 1640, potential rally to 1720+',
  };
}

// Open Interest Analysis
export async function analyzeOpenInterest(stock, expiry) {
  return {
    success: true,
    stock,
    expiry,
    call_oi: 2500000,
    put_oi: 1800000,
    call_oi_change: '+5.2%',
    put_oi_change: '-1.8%',
    oi_trend: 'Bullish - Call OI increasing',
    max_pain_level: 1660.00,
    open_interest_signal: 'Institutional long positioning',
    expected_move: '±2.5% from current',
    implied_volatility: '18.5%',
  };
}

// PUT/CALL Analysis
export async function putCallAnalysis(stock, strike_range) {
  return {
    success: true,
    stock,
    strike_range,
    put_call_ratio: 0.72,
    interpretation: 'Bullish (ratio < 1.0)',
    total_puts: 1800000,
    total_calls: 2500000,
    call_buying_strength: '+5.2%',
    put_selling_pressure: 'Moderate',
    sentiment: 'Institutional bullish positioning',
    key_strikes: {
      calls: [1660, 1670, 1680],
      puts: [1650, 1640, 1630],
    },
    trading_signal: 'Bullish - More calls than puts, institutions buying upside',
  };
}

// Mutual Fund Tracking
export async function trackMutualFunds(fund_type) {
  const funds = {
    large_cap: [
      { fund: 'HDFC Large Cap', top_holding: 'RELIANCE', weight: '8.2%', inflow: '+₹500Cr' },
      { fund: 'ICICI Large Cap', top_holding: 'INFY', weight: '7.5%', inflow: '+₹300Cr' },
    ],
    mid_cap: [
      { fund: 'Axis Midcap', top_holding: 'MARUTI', weight: '6.8%', inflow: '+₹200Cr' },
    ],
    small_cap: [
      { fund: 'SBI Smallcap', top_holding: 'EXCELIND', weight: '5.2%', inflow: '+₹100Cr' },
    ],
    balanced: [
      { fund: 'HDFC Balanced', holdings: 'INFY, TCS, RELIANCE', avg_weight: '2-3%', inflow: '+₹150Cr' },
    ],
  };

  return {
    success: true,
    fund_type,
    funds: funds[fund_type] || [],
    total_aum_inflow: '+₹1500Cr',
    sector_preference: 'IT, Banking, Auto',
    recent_additions: ['MARUTI', 'BAJAJFINSV', 'HCLTECH'],
    underweight_sectors: ['FMCG', 'Telecom'],
  };
}

// Promoter Pledge Monitoring
export async function monitorPromoterPledge(stock) {
  return {
    success: true,
    stock,
    pledged_shares_percent: 12.5,
    pledge_status: 'Moderate Risk',
    pledged_to_lenders: ['ICICI Bank', 'HDFC Bank'],
    pledge_trend: 'Increasing (was 10.2% 3 months ago)',
    risk_level: 'Medium',
    stock_performance: '-2.3% vs index +0.85%',
    recommendation: 'Monitor pledge levels - rising pledges indicate financial stress',
    historical_context: 'Pledges increased during market volatility',
  };
}

// Institutional Signal Generation
export async function generateInstitutionalSignal(stock, analysis_type) {
  const signal = {
    symbol: stock,
    timestamp: Date.now(),
    accumulation: {
      score: 78,
      signal: 'BUY',
      confidence: 85,
      zones: [1640, 1630],
      reasoning: 'Heavy FII accumulation, block deals positive, OI bullish',
      targets: [1700, 1720, 1750],
      stop_loss: 1620,
    },
    distribution: {
      score: 35,
      signal: 'HOLD',
      confidence: 45,
      reasoning: 'Minimal distribution activity, no red flags',
    },
    neutral: {
      score: 50,
      signal: 'HOLD',
      confidence: 60,
      reasoning: 'Institutional activity neutral, wait for clearer direction',
    },
  };

  const selected = analysis_type === 'all' ? signal : { ...signal, [analysis_type]: signal[analysis_type] };

  return {
    success: true,
    ...selected,
    overall_signal: 'BUY',
    overall_confidence: 85,
    institutional_verdict: 'Strong accumulation pattern detected',
    entry_zone: '1640-1650',
    take_profit: '1750-1800',
    stop_loss: '1620',
  };
}

// Widgets

export async function createIndiaDashboard(market_data, top_accumulators, top_distributors) {
  const id = `india_dashboard_${Date.now()}`;

  const html = `
    <div class="widget-india-dashboard" data-widget-id="${id}">
      <style>
        .widget-india-dashboard { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 24px; background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%); border-radius: 12px; color: white; max-width: 600px; }
        .india-header { font-size: 22px; font-weight: 700; margin-bottom: 20px; text-align: center; }
        .india-index { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
        .index-card { background: rgba(255, 255, 255, 0.1); padding: 16px; border-radius: 8px; backdrop-filter: blur(10px); }
        .index-name { font-size: 12px; opacity: 0.8; text-transform: uppercase; letter-spacing: 0.5px; }
        .index-value { font-size: 20px; font-weight: 700; margin-top: 8px; }
        .index-change { font-size: 12px; margin-top: 4px; color: #4ec9b0; }
        .flows { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 16px; }
        .flow-item { padding: 12px; background: rgba(0, 0, 0, 0.2); border-radius: 6px; font-size: 12px; }
        .flow-label { opacity: 0.8; margin-bottom: 4px; }
        .flow-value { font-size: 14px; font-weight: 600; }
        .stocks-section { margin-top: 20px; }
        .stocks-title { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; opacity: 0.9; }
        .stock-list { display: flex; gap: 8px; flex-wrap: wrap; }
        .stock-tag { background: rgba(76, 201, 176, 0.2); border: 1px solid #4ec9b0; padding: 6px 12px; border-radius: 4px; font-size: 11px; }
      </style>
      <div class="india-header">🇮🇳 India Institutional Activity</div>
      <div class="india-index">
        <div class="index-card">
          <div class="index-name">${market_data.index}</div>
          <div class="index-value">${market_data.price}</div>
          <div class="index-change">${market_data.change}</div>
        </div>
      </div>
      <div class="flows">
        <div class="flow-item">
          <div class="flow-label">FII Flow</div>
          <div class="flow-value" style="color: #4ec9b0;">${market_data.fii_flow}</div>
        </div>
        <div class="flow-item">
          <div class="flow-label">DII Flow</div>
          <div class="flow-value" style="color: #ff6b6b;">${market_data.dii_flow}</div>
        </div>
      </div>
      <div class="stocks-section">
        <div class="stocks-title">📈 Top Accumulators</div>
        <div class="stock-list">${top_accumulators.map(s => `<div class="stock-tag">${s}</div>`).join('')}</div>
      </div>
      <div class="stocks-section">
        <div class="stocks-title">📉 Top Distributors</div>
        <div class="stock-list">${top_distributors.map(s => `<div class="stock-tag">${s}</div>`).join('')}</div>
      </div>
    </div>
  `;

  return {
    success: true,
    widget_id: id,
    resource_uri: `widget://${id}`,
    html,
    type: 'india_dashboard',
  };
}

export async function createFIIDIIChart(data) {
  const id = `fii_dii_${Date.now()}`;

  const maxFlow = Math.max(...data.map(d => Math.max(d.fii, Math.abs(d.dii)))) || 1;
  const barsHTML = data
    .slice(-10)
    .map(d => {
      const fiiHeight = (d.fii / maxFlow) * 100;
      const diiHeight = (Math.abs(d.dii) / maxFlow) * 100;
      const diiColor = d.dii > 0 ? '#4ec9b0' : '#ff6b6b';
      return `
        <div class="flow-bar">
          <div class="bar fii" style="height: ${fiiHeight}%;" title="FII: ${d.fii}"></div>
          <div class="bar dii" style="height: ${diiHeight}%; background: ${diiColor};" title="DII: ${d.dii}"></div>
        </div>
      `;
    })
    .join('');

  const html = `
    <div class="widget-fii-dii" data-widget-id="${id}">
      <style>
        .widget-fii-dii { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; background: white; border-radius: 8px; }
        .fii-title { font-size: 16px; font-weight: 600; margin-bottom: 16px; }
        .fii-chart { display: flex; align-items: flex-end; height: 150px; gap: 3px; }
        .flow-bar { flex: 1; display: flex; flex-direction: column; gap: 1px; height: 100%; }
        .bar { flex: 1; border-radius: 2px 2px 0 0; }
        .fii { background: #4ec9b0; }
      </style>
      <div class="fii-title">FII/DII Flow (₹ Crores)</div>
      <div class="fii-chart">${barsHTML}</div>
    </div>
  `;

  return {
    success: true,
    widget_id: id,
    resource_uri: `widget://${id}`,
    html,
    type: 'fii_dii_chart',
  };
}

export async function createZoneHeatmap(zones, stock) {
  const id = `zone_${Date.now()}`;

  const zonesHTML = zones
    .map(z => {
      const color = z.type === 'accumulation' ? '#28a745' : '#dc3545';
      const opacity = z.strength / 100;
      return `
        <div class="zone" style="background: ${color}; opacity: ${opacity}; height: 40px; margin: 8px 0; border-radius: 4px; display: flex; align-items: center; padding: 0 12px; color: white; font-weight: 600;">
          ${z.type.toUpperCase()} @ ${z.level} (${z.strength}% strength)
        </div>
      `;
    })
    .join('');

  const html = `
    <div class="widget-zone-heatmap" data-widget-id="${id}">
      <style>
        .widget-zone-heatmap { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; background: white; border-radius: 8px; max-width: 400px; }
        .zone-title { font-size: 16px; font-weight: 600; margin-bottom: 16px; }
        .zone { transition: all 0.3s ease; }
        .zone:hover { opacity: 1 !important; }
      </style>
      <div class="zone-title">🎯 Institutional Zones - ${stock}</div>
      ${zonesHTML}
    </div>
  `;

  return {
    success: true,
    widget_id: id,
    resource_uri: `widget://${id}`,
    html,
    type: 'zone_heatmap',
  };
}
