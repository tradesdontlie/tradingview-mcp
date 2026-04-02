import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/fundamentals.js';

export function registerFundamentalTools(server) {

  // -- Discovery ----------------------------------------------------------
  server.tool(
    'symbol_data_available',
    'Detect the asset type (stock, ETF, crypto, forex, futures, index) and list which data categories are available for it. Call this first when analyzing a new symbol.',
    {
      symbol: z.string().optional().describe('Symbol (e.g. "AAPL", "NASDAQ:AAPL"). Defaults to current chart symbol.'),
    },
    async ({ symbol }) => {
      try { return jsonResult(await core.getAvailableData({ symbol })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  // -- Technicals ---------------------------------------------------------
  server.tool(
    'data_get_technicals',
    'Get TradingView technical analysis summary: oscillators (RSI, MACD, Stoch, CCI, ADX, etc.), moving averages (SMA/EMA 10–200), overall Buy/Sell rating, performance, and volatility.',
    {
      symbol: z.string().optional().describe('Symbol. Defaults to current chart symbol.'),
    },
    async ({ symbol }) => {
      try { return jsonResult(await core.getTechnicals({ symbol })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  // -- Financials (stocks) -----------------------------------------------
  server.tool(
    'data_get_financials',
    'Get financial data for a stock. Sections: overview (market cap, P/E, EPS, sector), income_statement (revenue, margins, growth), balance_sheet (assets, liabilities, debt), cash_flow (operating CF, FCF, capex), statistics (ROE, ROA, ratios), dividends (yield, payout, ex-date), earnings (EPS, estimates, next release date).',
    {
      symbol:  z.string().optional().describe('Symbol. Defaults to current chart symbol.'),
      section: z.string().optional().describe('Section to fetch: overview, income_statement, balance_sheet, cash_flow, statistics, dividends, earnings. Default: overview'),
    },
    async ({ symbol, section }) => {
      try { return jsonResult(await core.getFinancials({ symbol, section })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  // -- ETF Profile --------------------------------------------------------
  server.tool(
    'data_get_etf_profile',
    'Get ETF profile data. Sections: overview (AUM, expense ratio, NAV, performance, volatility) or holdings (top holdings / components).',
    {
      symbol:  z.string().optional().describe('ETF symbol. Defaults to current chart symbol.'),
      section: z.string().optional().describe('Section: overview or holdings. Default: overview'),
    },
    async ({ symbol, section }) => {
      try { return jsonResult(await core.getEtfProfile({ symbol, section })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  // -- Seasonals ----------------------------------------------------------
  server.tool(
    'data_get_seasonals',
    'Get seasonal performance patterns: average monthly returns, win rate per month, plus period performance (1M, 3M, 6M, YTD, 1Y). Computed from price history on the chart.',
    {
      symbol: z.string().optional().describe('Symbol. Defaults to current chart symbol.'),
      years:  z.coerce.number().optional().describe('Years of history to analyze (default 5)'),
    },
    async ({ symbol, years }) => {
      try { return jsonResult(await core.getSeasonals({ symbol, years })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
