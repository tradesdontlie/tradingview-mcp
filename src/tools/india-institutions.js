import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/india-institutions.js';

export function registerIndiaInstitutionToolsTools(server) {
  // India Market Context
  server.tool('india_market_context', 'Get India market context (Nifty, Sensex, sectors, FII/DII flow)', {
    market_type: z.enum(['nifty50', 'sensex', 'midcap', 'smallcap']).optional().describe('Index type'),
  }, async ({ market_type = 'nifty50' }) => {
    try {
      return jsonResult(await core.getMarketContext(market_type));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // FII/DII Analysis
  server.tool('india_fii_dii_analysis', 'Analyze Foreign Institutional Investor (FII) and Domestic Institutional Investor (DII) flows', {
    period: z.enum(['today', 'week', 'month']).optional().describe('Analysis period'),
  }, async ({ period = 'week' }) => {
    try {
      return jsonResult(await core.getFIIDIIAnalysis(period));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Block Deal Analysis (Institutional Buying/Selling)
  server.tool('india_block_deals', 'Analyze large block deals (institutional accumulation/distribution)', {
    stock: z.string().optional().describe('Stock symbol (e.g., INFY, TCS, RELIANCE)'),
    date_range: z.string().optional().describe('Date range'),
  }, async ({ stock, date_range }) => {
    try {
      return jsonResult(await core.analyzeBlockDeals(stock, date_range));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Bulk Deal Analysis
  server.tool('india_bulk_deals', 'Analyze bulk deals (>0.5% shareholding changes)', {
    stock: z.string().optional().describe('Stock symbol'),
    pattern: z.enum(['accumulation', 'distribution', 'all']).optional().describe('Deal pattern'),
  }, async ({ stock, pattern = 'all' }) => {
    try {
      return jsonResult(await core.analyzeBulkDeals(stock, pattern));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Sector Rotation Analysis
  server.tool('india_sector_rotation', 'Analyze sector rotation (institutional preference shifts)', {
    sectors: z.array(z.string()).optional().describe('Sectors to analyze'),
  }, async ({ sectors = ['IT', 'Banking', 'Auto', 'Pharma', 'FMCG', 'Energy'] }) => {
    try {
      return jsonResult(await core.analyzeSectorRotation(sectors));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Institutional Support/Resistance Zones
  server.tool('india_institutional_zones', 'Identify institutional accumulation/distribution zones from volume profile', {
    stock: z.string().describe('Stock symbol'),
    timeframe: z.string().describe('Timeframe (1H, 4H, D, W)'),
  }, async ({ stock, timeframe }) => {
    try {
      return jsonResult(await core.findInstitutionalZones(stock, timeframe));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Open Interest Analysis (F&O)
  server.tool('india_open_interest', 'Analyze Open Interest in F&O (options/futures positioning)', {
    stock: z.string().describe('Stock symbol'),
    expiry: z.string().optional().describe('Option expiry (weekly, monthly)'),
  }, async ({ stock, expiry = 'weekly' }) => {
    try {
      return jsonResult(await core.analyzeOpenInterest(stock, expiry));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // PUT/CALL Ratio Analysis
  server.tool('india_put_call_analysis', 'Analyze PUT/CALL ratio for bullish/bearish sentiment', {
    stock: z.string().describe('Stock symbol'),
    strike_range: z.string().optional().describe('Strike range around current'),
  }, async ({ stock, strike_range = 'ATM' }) => {
    try {
      return jsonResult(await core.putCallAnalysis(stock, strike_range));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Mutual Fund Portfolio Tracking
  server.tool('india_mf_tracking', 'Track top mutual fund holdings and portfolio changes', {
    fund_type: z.enum(['large_cap', 'mid_cap', 'small_cap', 'balanced']).optional().describe('Fund category'),
  }, async ({ fund_type = 'large_cap' }) => {
    try {
      return jsonResult(await core.trackMutualFunds(fund_type));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Promoter Pledge Monitoring
  server.tool('india_promoter_pledge', 'Monitor promoter shareholding pledges (risk indicator)', {
    stock: z.string().describe('Stock symbol'),
  }, async ({ stock }) => {
    try {
      return jsonResult(await core.monitorPromoterPledge(stock));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Institutional Strategy Signal
  server.tool('india_institutional_signal', 'Generate trading signal based on institutional activity', {
    stock: z.string().describe('Stock symbol (NSE: e.g., INFY.NS)'),
    analysis_type: z.enum(['accumulation', 'distribution', 'neutral', 'all']).optional(),
  }, async ({ stock, analysis_type = 'all' }) => {
    try {
      return jsonResult(await core.generateInstitutionalSignal(stock, analysis_type));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Widget: India Institutional Dashboard
  server.tool('widget_india_dashboard', 'Render India institutional activity dashboard', {
    market_data: z.object({
      index: z.string(),
      price: z.number(),
      change: z.string(),
      fii_flow: z.string(),
      dii_flow: z.string(),
    }).describe('Market overview'),
    top_accumulators: z.array(z.string()).optional().describe('Top accumulation stocks'),
    top_distributors: z.array(z.string()).optional().describe('Top distribution stocks'),
  }, async ({ market_data, top_accumulators = [], top_distributors = [] }) => {
    try {
      return jsonResult(await core.createIndiaDashboard(market_data, top_accumulators, top_distributors));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Widget: FII/DII Flow Visualization
  server.tool('widget_fii_dii_flow', 'Render FII/DII flow chart', {
    data: z.array(z.object({
      date: z.string(),
      fii: z.number(),
      dii: z.number(),
    })).describe('Daily FII/DII flows'),
  }, async ({ data }) => {
    try {
      return jsonResult(await core.createFIIDIIChart(data));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Widget: Institutional Zones Heatmap
  server.tool('widget_institutional_heatmap', 'Render institutional accumulation/distribution zones', {
    zones: z.array(z.object({
      level: z.number(),
      type: z.enum(['accumulation', 'distribution']),
      strength: z.number(),
    })).describe('Institutional zones'),
    stock: z.string(),
  }, async ({ zones, stock }) => {
    try {
      return jsonResult(await core.createZoneHeatmap(zones, stock));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });
}
