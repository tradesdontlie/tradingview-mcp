import { z } from 'zod';
import { jsonResult } from './_format.js';

export function registerComplianceTools(server) {
  // Compliance Disclaimer Widget
  server.tool('widget_compliance_disclaimer', 'Render SEBI compliance disclaimer', {
    type: z.enum(['general', 'analysis', 'backtest', 'signals']).optional().describe('Disclaimer type'),
  }, async ({ type = 'general' }) => {
    try {
      return jsonResult(await createComplianceDisclaimer(type));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Educational Analysis (No Recommendations)
  server.tool('analysis_educational', 'Educational market analysis - NO buy/sell tips', {
    symbol: z.string().describe('Stock symbol'),
    analysis_focus: z.enum(['technical', 'fundamental', 'macro', 'risk_management']).describe('Analysis focus area'),
  }, async ({ symbol, analysis_focus }) => {
    try {
      return jsonResult(await educationalAnalysis(symbol, analysis_focus));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Risk Disclosure
  server.tool('widget_risk_disclosure', 'Render comprehensive risk disclosure', {
    product_type: z.enum(['equity', 'derivatives', 'options', 'all']).optional(),
  }, async ({ product_type = 'all' }) => {
    try {
      return jsonResult(await createRiskDisclosure(product_type));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Suitability Check
  server.tool('suitability_questionnaire', 'Investment profile & suitability assessment', {
    investment_horizon: z.enum(['short_term', 'medium_term', 'long_term']),
    risk_appetite: z.enum(['conservative', 'moderate', 'aggressive']),
    experience_level: z.enum(['beginner', 'intermediate', 'advanced']),
  }, async ({ investment_horizon, risk_appetite, experience_level }) => {
    try {
      return jsonResult(await suitabilityCheck({
        investment_horizon,
        risk_appetite,
        experience_level,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Learning Resource Widget
  server.tool('widget_learning_resources', 'Educational resources on market analysis', {
    topic: z.enum(['technical_analysis', 'fundamental_analysis', 'risk_management', 'market_basics']),
  }, async ({ topic }) => {
    try {
      return jsonResult(await createLearningResources(topic));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Terms & Conditions
  server.tool('widget_terms_conditions', 'Platform T&C and user agreement', {}, async () => {
    try {
      return jsonResult(await createTermsConditions());
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });
}

// Compliance Disclaimer
async function createComplianceDisclaimer(type) {
  const disclaimers = {
    general: `
      ⚠️ IMPORTANT DISCLAIMER

      This platform is NOT registered with SEBI (Securities and Exchange Board of India).

      • Tools provide EDUCATIONAL ANALYSIS ONLY
      • NO investment recommendations or buy/sell tips
      • NOT financial advice - consult registered advisor
      • Past performance ≠ future results
      • Market risks: loss of capital possible
      • Use at your own risk and responsibility
    `,
    analysis: `
      ANALYSIS DISCLAIMER

      Technical/fundamental analysis shown is for EDUCATIONAL purposes.

      • Charts & indicators are tools for learning
      • Not meant to predict price movement
      • Historical patterns don't guarantee future outcomes
      • Do your own research (DYOR)
      • Verify with multiple sources
      • Consult SEBI-registered advisor before trading
    `,
    backtest: `
      BACKTEST DISCLAIMER

      Historical backtest results:

      • Past performance ≠ future results
      • Backtests use historical data only
      • Real trading includes slippage, fees, gaps
      • Strategies may fail in live market
      • Overfitting to historical data common
      • Forward testing needed before real trading
    `,
    signals: `
      TRADING SIGNALS DISCLAIMER

      Analysis-generated signals are:

      • Educational demonstrations ONLY
      • NOT financial advice
      • NOT recommendations to buy/sell
      • High-risk educational tool
      • Do NOT trade based on these signals alone
      • Always consult registered investment advisor
    `,
  };

  const id = `compliance_${Date.now()}`;

  const html = `
    <div class="widget-compliance" data-widget-id="${id}">
      <style>
        .widget-compliance { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 24px; background: #fff3cd; border: 2px solid #ff6b6b; border-radius: 8px; max-width: 600px; }
        .compliance-title { font-size: 18px; font-weight: 700; color: #cc0000; margin-bottom: 16px; }
        .compliance-text { font-size: 13px; line-height: 1.6; color: #333; white-space: pre-wrap; }
        .compliance-highlight { background: #ff6b6b; color: white; padding: 2px 4px; border-radius: 2px; }
        .compliance-footer { margin-top: 16px; font-size: 11px; color: #666; text-align: center; border-top: 1px solid #ddd; padding-top: 12px; }
      </style>
      <div class="compliance-title">⚠️ ${type.toUpperCase()} DISCLAIMER</div>
      <div class="compliance-text">${disclaimers[type]}</div>
      <div class="compliance-footer">
        By using this tool, you accept all risks and take full responsibility for your decisions.
        <br/>This is NOT investment advice. Always consult SEBI-registered advisors.
      </div>
    </div>
  `;

  return {
    success: true,
    widget_id: id,
    resource_uri: `widget://${id}`,
    html,
    type: 'compliance_disclaimer',
    disclaimer_text: disclaimers[type],
  };
}

// Educational Analysis (No Recommendations)
async function educationalAnalysis(symbol, analysis_focus) {
  const analyses = {
    technical: {
      title: 'EDUCATIONAL: Technical Analysis Basics',
      content: `
        Technical analysis studies price/volume patterns for EDUCATIONAL understanding:

        1. Support/Resistance Levels
           - Price areas where buying/selling historically clusters
           - NOT predictions - just observed patterns

        2. Trend Analysis
           - Uptrend: Higher highs, higher lows
           - Downtrend: Lower highs, lower lows
           - Sideways: Range-bound movement

        3. Indicators (Educational Tools)
           - RSI (14): Overbought >70, Oversold <30 (not predictive)
           - MACD: Momentum analysis for learning
           - Bollinger Bands: Volatility visualization

        IMPORTANT:
        ✗ These do NOT predict future prices
        ✗ Not buy/sell signals
        ✓ Tools for learning market mechanics
        ✓ Use alongside fundamental analysis

        Always verify with multiple sources and consult registered advisors.
      `,
    },
    fundamental: {
      title: 'EDUCATIONAL: Fundamental Analysis Framework',
      content: `
        Fundamental analysis examines company financials for EDUCATIONAL learning:

        1. Financial Statements
           - P&L: Profitability analysis
           - Balance Sheet: Financial health
           - Cash Flow: Liquidity assessment

        2. Key Ratios
           - P/E Ratio: Valuation metric (not buy signal)
           - PEG Ratio: Growth-adjusted valuation
           - ROE/ROA: Profitability efficiency

        3. Industry Analysis
           - Sector trends
           - Competitive positioning
           - Market growth rates

        EDUCATIONAL APPROACH:
        ✓ Understand business model
        ✓ Analyze financial health
        ✓ Compare with peers
        ✗ Don't make decisions based on single metric
        ✗ Consider macro factors too

        Consult financial advisors for investment decisions.
      `,
    },
    macro: {
      title: 'EDUCATIONAL: Macro Factors Affecting Markets',
      content: `
        Macroeconomic factors impact overall market direction (EDUCATIONAL):

        1. Interest Rates
           - RBI policy decisions
           - Impact on borrowing costs
           - Market valuations sensitive to rates

        2. Inflation
           - CPI/WPI data
           - Purchasing power impact
           - Corporate margin effects

        3. GDP Growth
           - Economic expansion/contraction
           - Market valuations adjust
           - Sector-specific impacts

        4. FII/DII Flows
           - Foreign investor activity
           - Liquidity impact
           - Market trend influence

        5. Geopolitical Events
           - Global tensions
           - Trade policy changes
           - Currency movements

        EDUCATIONAL INSIGHTS:
        ✓ Understand market drivers
        ✓ Monitor economic calendar
        ✓ Analyze sector rotation
        ✗ Can't predict exact market moves
        ✗ Multiple factors interact unpredictably

        Always consult economic/financial advisors.
      `,
    },
    risk_management: {
      title: 'EDUCATIONAL: Risk Management Principles',
      content: `
        Risk management helps REDUCE losses (not eliminate them):

        1. Position Sizing
           - Risk only what you can afford to lose
           - Typical: 1-2% per trade maximum
           - Scale with account size

        2. Stop Loss Orders
           - Predefined exit level for losses
           - Emotional discipline tool
           - Doesn't guarantee execution

        3. Take Profit Targets
           - Lock in gains
           - Prevent greed-driven losses
           - Part of risk/reward planning

        4. Portfolio Diversification
           - Don't concentrate in single stocks
           - Mix sectors/asset classes
           - Reduces portfolio volatility

        5. Money Management
           - Risk/Reward ratio: At least 1:2
           - Max drawdown limits: 10-20%
           - Position correlation analysis

        CRITICAL RISKS YOU MUST UNDERSTAND:
        ⚠️ Market crashes can wipe accounts
        ⚠️ Liquidity risk in small caps
        ⚠️ Gap risk on open
        ⚠️ Leverage amplifies losses
        ⚠️ Psychological traps (FOMO, panic selling)

        Never risk capital you can't afford to lose.
      `,
    },
  };

  return {
    success: true,
    symbol,
    analysis_type: analysis_focus,
    educational_content: analyses[analysis_focus],
    disclaimer: 'This is EDUCATIONAL ANALYSIS ONLY - NOT investment advice',
    important_note: 'Do your own research. Consult SEBI-registered financial advisors before any trading decisions.',
    not_included: ['Buy recommendations', 'Sell signals', 'Price predictions', 'Investment tips'],
  };
}

// Risk Disclosure
async function createRiskDisclosure(product_type) {
  const id = `risk_${Date.now()}`;

  const risks = {
    equity: {
      title: 'Equity (Stock) Trading Risks',
      risks: [
        'Market Risk: Prices can fall sharply/suddenly',
        'Company Risk: Business failure/bankruptcy',
        'Liquidity Risk: Unable to sell quickly',
        'Event Risk: Unexpected announcements',
        'Psychological Risk: Emotional decisions',
        'Regulatory Risk: Policy changes',
      ],
    },
    derivatives: {
      title: 'Derivatives (Futures) Trading Risks',
      risks: [
        'Leverage Risk: 10x-20x leverage amplifies losses',
        'Margin Call: Sudden forced liquidation',
        'Overnight Gap Risk: Market gaps overnight',
        'Expiry Risk: Futures expire (contracts end)',
        'Slippage Risk: Execution at worse prices',
        'Total Loss Risk: Can lose entire capital + more',
      ],
    },
    options: {
      title: 'Options Trading Risks',
      risks: [
        'Time Decay: Option loses value daily',
        'Volatility Risk: IV crush can wipe profits',
        'Greeks Risk: Delta/gamma/vega impact',
        'Liquidity Risk: Bid-ask spreads widen',
        'Exercise Risk: Unexpected assignment',
        'Complexity Risk: Hard to understand Greeks',
      ],
    },
  };

  const riskItems = product_type === 'all'
    ? Object.values(risks).flatMap(r => r.risks)
    : risks[product_type]?.risks || [];

  const html = `
    <div class="widget-risk-disclosure" data-widget-id="${id}">
      <style>
        .widget-risk-disclosure { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 24px; background: #fff; border: 2px solid #dc3545; border-radius: 8px; max-width: 600px; }
        .risk-title { font-size: 18px; font-weight: 700; color: #dc3545; margin-bottom: 16px; }
        .risk-item { padding: 12px; margin: 8px 0; background: #f8f9fa; border-left: 4px solid #dc3545; border-radius: 4px; }
        .risk-item-text { font-size: 13px; color: #333; }
        .risk-severity { display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; margin-left: 8px; }
        .severity-high { background: #dc3545; color: white; }
        .severity-medium { background: #ffc107; color: #333; }
        .risk-footer { margin-top: 20px; padding: 16px; background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; font-size: 12px; color: #333; }
      </style>
      <div class="risk-title">⚠️ COMPREHENSIVE RISK DISCLOSURE</div>
      ${riskItems.map(risk => `<div class="risk-item"><div class="risk-item-text">• ${risk}</div></div>`).join('')}
      <div class="risk-footer">
        <strong>KEY UNDERSTANDING:</strong><br/>
        Capital loss is possible. Only trade with money you can afford to lose completely.
        Derivatives can result in losses EXCEEDING initial capital.
        Never use borrowed money without understanding risks.
        Always consult qualified financial advisors.
      </div>
    </div>
  `;

  return {
    success: true,
    widget_id: id,
    resource_uri: `widget://${id}`,
    html,
    type: 'risk_disclosure',
    risks_disclosed: riskItems,
  };
}

// Suitability Check
async function suitabilityCheck({ investment_horizon, risk_appetite, experience_level }) {
  const profiles = {
    conservative: 'Focus on capital preservation, bonds, dividend stocks',
    moderate: 'Balanced portfolio with growth and stability',
    aggressive: 'Growth-focused, can tolerate volatility',
  };

  const recommendations = {
    beginner: [
      'Learn fundamentals first - take courses',
      'Paper trade (simulated) before real money',
      'Start with index funds/mutual funds',
      'Avoid derivatives until experienced',
      'Read books on investing basics',
    ],
    intermediate: [
      'Can start individual stock picking',
      'Understand technical + fundamental analysis',
      'Try options with small capital',
      'Maintain trading journal',
      'Follow risk management discipline',
    ],
    advanced: [
      'Can use complex strategies',
      'Derivatives suitable if managed well',
      'But remember: losing streaks happen',
      'Continuous learning necessary',
      'Psychological management critical',
    ],
  };

  return {
    success: true,
    investment_profile: {
      horizon: investment_horizon,
      appetite: risk_appetite,
      experience: experience_level,
    },
    suitability_assessment: profiles[risk_appetite],
    recommended_approach: recommendations[experience_level],
    cautions: [
      'This is NOT personalized advice',
      'Consult SEBI-registered financial advisor for your situation',
      'Individual circumstances vary widely',
      'Regular review and rebalancing needed',
      'Market conditions change - adapt strategy',
    ],
    next_steps: [
      '1. Define your financial goals',
      '2. Assess true risk tolerance (not just appetite)',
      '3. Learn market fundamentals thoroughly',
      '4. Start small with education capital',
      '5. Consult qualified advisors regularly',
    ],
  };
}

// Learning Resources
async function createLearningResources(topic) {
  const id = `learning_${Date.now()}`;

  const resources = {
    technical_analysis: {
      title: 'Technical Analysis Learning Path',
      resources: [
        '📚 Books: "Technical Analysis Explained" by Martin Pring',
        '🎓 Courses: NSE certification - Technical Analysis',
        '📺 YouTube: Educational channels on chart patterns',
        '📊 Practice: TradingView free charts for learning',
        '📖 Blogs: Technical analysis educational articles',
      ],
    },
    fundamental_analysis: {
      title: 'Fundamental Analysis Resources',
      resources: [
        '📚 Books: "The Intelligent Investor" by Benjamin Graham',
        '🎓 NSE/BSE educational programs',
        '💼 Company websites: Annual reports, filings',
        '📊 Financial sites: Screeners for analysis practice',
        '🎯 Case studies: Analyze real companies',
      ],
    },
    risk_management: {
      title: 'Risk Management Mastery',
      resources: [
        '📚 Books: "Market Wizards" by Jack Schwager',
        '🎓 Risk management courses',
        '📊 Position sizing calculators',
        '📋 Trading journal templates',
        '🎯 Backtesting platforms for learning',
      ],
    },
    market_basics: {
      title: 'Market Fundamentals',
      resources: [
        '🎓 NSE: "Learn Market Basics" free course',
        '📚 Books: "The Big Picture" by Rick Swenson',
        '💡 Understanding: Stock markets, indices, instruments',
        '🏛️ Regulatory: SEBI investor protection rules',
        '🔗 Resources: Moneycontrol, ET Markets education',
      ],
    },
  };

  const resourceList = resources[topic];

  const html = `
    <div class="widget-learning" data-widget-id="${id}">
      <style>
        .widget-learning { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 24px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 8px; color: white; max-width: 600px; }
        .learning-title { font-size: 20px; font-weight: 700; margin-bottom: 20px; }
        .learning-item { padding: 12px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.1); font-size: 14px; }
        .learning-item:last-child { border-bottom: none; }
        .learning-footer { margin-top: 20px; padding-top: 20px; border-top: 1px solid rgba(255, 255, 255, 0.3); font-size: 12px; opacity: 0.9; }
      </style>
      <div class="learning-title">${resourceList.title}</div>
      ${resourceList.resources.map(r => `<div class="learning-item">${r}</div>`).join('')}
      <div class="learning-footer">
        💡 Invest in education BEFORE trading real money.
        <br/>Knowledge reduces losses significantly.
      </div>
    </div>
  `;

  return {
    success: true,
    widget_id: id,
    resource_uri: `widget://${id}`,
    html,
    type: 'learning_resources',
    resources: resourceList.resources,
  };
}

// Terms & Conditions
async function createTermsConditions() {
  const id = `terms_${Date.now()}`;

  const html = `
    <div class="widget-terms" data-widget-id="${id}">
      <style>
        .widget-terms { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 24px; background: white; border: 1px solid #ddd; border-radius: 8px; max-width: 700px; max-height: 600px; overflow-y: auto; }
        .terms-title { font-size: 20px; font-weight: 700; margin-bottom: 20px; }
        .terms-section { margin-bottom: 16px; }
        .terms-section-title { font-size: 14px; font-weight: 600; color: #333; margin-bottom: 8px; }
        .terms-text { font-size: 12px; line-height: 1.6; color: #666; margin-bottom: 12px; }
        .terms-highlight { background: #fff3cd; padding: 12px; border-left: 4px solid #ffc107; border-radius: 4px; font-size: 12px; }
      </style>
      <div class="terms-title">📋 Terms & Conditions</div>

      <div class="terms-section">
        <div class="terms-section-title">1. NOT SEBI Registered</div>
        <div class="terms-text">
          This platform/tool is NOT registered with SEBI. It provides educational analysis only.
          Not a broker, custodian, or investment advisor.
        </div>
      </div>

      <div class="terms-section">
        <div class="terms-section-title">2. Educational Use Only</div>
        <div class="terms-text">
          All analysis, backtests, and signals are for EDUCATIONAL purposes.
          NOT investment recommendations or financial advice.
        </div>
      </div>

      <div class="terms-section">
        <div class="terms-section-title">3. No Guarantees</div>
        <div class="terms-text">
          Past performance does not guarantee future results.
          Market losses are possible. Complete capital loss is possible.
        </div>
      </div>

      <div class="terms-section">
        <div class="terms-section-title">4. User Responsibility</div>
        <div class="terms-text">
          You assume ALL risks and responsibility for trading decisions.
          We are NOT liable for any losses incurred.
        </div>
      </div>

      <div class="terms-section">
        <div class="terms-section-title">5. Professional Advice</div>
        <div class="terms-text">
          Always consult SEBI-registered financial advisors before trading.
          Do your own research (DYOR).
        </div>
      </div>

      <div class="terms-highlight">
        <strong>IMPORTANT:</strong> By using this tool, you agree:
        • You understand investment risks
        • You take full responsibility for decisions
        • This is NOT investment advice
        • You will consult professionals before trading real money
      </div>
    </div>
  `;

  return {
    success: true,
    widget_id: id,
    resource_uri: `widget://${id}`,
    html,
    type: 'terms_conditions',
  };
}
