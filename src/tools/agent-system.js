import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/agent-system.js';

export function registerAgentSystemTools(server) {
  // Research Agent: Market data, technicals, fundamentals
  server.tool('agent_research', 'Research agent gathers market data, technicals, fundamentals', {
    symbol: z.string().describe('Stock symbol to research'),
    timeframe: z.string().describe('Chart timeframe'),
    research_type: z.enum(['technical', 'fundamental', 'sentiment', 'all']).optional().describe('Type of research'),
  }, async ({ symbol, timeframe, research_type = 'all' }) => {
    try {
      return jsonResult(await core.researchAgent({ symbol, timeframe, research_type }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Analyst Agent: Process research, perform analysis, generate signals
  server.tool('agent_analyst', 'Analyst agent processes research data and generates trading signals', {
    research_data: z.object({
      symbol: z.string(),
      timeframe: z.string(),
      technical_score: z.number().optional(),
      fundamental_score: z.number().optional(),
      sentiment_score: z.number().optional(),
      indicators: z.record(z.any()).optional(),
    }).describe('Research data from research agent'),
    strategy: z.string().optional().describe('Trading strategy to apply'),
  }, async ({ research_data, strategy = 'institutional_zones' }) => {
    try {
      return jsonResult(await core.analystAgent({ research_data, strategy }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Decision Agent: Final trade decision, risk assessment, execution recommendation
  server.tool('agent_decision', 'Decision agent makes final trade decision and risk assessment', {
    analysis_data: z.object({
      symbol: z.string(),
      signal: z.string(),
      confidence: z.number(),
      entry_price: z.number().optional(),
      stop_loss: z.number().optional(),
      take_profit: z.number().optional(),
      risk_reward_ratio: z.number().optional(),
    }).describe('Analysis from analyst agent'),
    account_size: z.number().optional().describe('Trading account size in USD'),
    max_risk_percent: z.number().optional().describe('Max % risk per trade'),
  }, async ({ analysis_data, account_size = 50000, max_risk_percent = 2 }) => {
    try {
      return jsonResult(await core.decisionAgent({
        analysis_data,
        account_size,
        max_risk_percent,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Agent Orchestrator: Coordinates all 3 agents end-to-end
  server.tool('agent_orchestrate', 'Orchestrate complete research→analysis→decision workflow', {
    symbol: z.string().describe('Stock symbol'),
    timeframe: z.string().describe('Timeframe'),
    account_size: z.number().optional().describe('Account size'),
    auto_execute: z.boolean().optional().describe('Auto-execute if signal confirmed'),
  }, async ({ symbol, timeframe, account_size = 50000, auto_execute = false }) => {
    try {
      return jsonResult(await core.orchestrateWorkflow({
        symbol,
        timeframe,
        account_size,
        auto_execute,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Market Meter Widget: Visualize all agent signals + final decision
  server.tool('widget_market_meter', 'Render market meter showing all agent signals and final decision', {
    research_score: z.number().describe('Research agent score (0-100)'),
    analyst_confidence: z.number().describe('Analyst signal confidence (0-100)'),
    decision_recommendation: z.enum(['BUY', 'SELL', 'HOLD']).describe('Final decision'),
    symbol: z.string().optional().describe('Stock symbol'),
  }, async ({ research_score, analyst_confidence, decision_recommendation, symbol = 'SPY' }) => {
    try {
      return jsonResult(await core.createMarketMeter({
        research_score,
        analyst_confidence,
        decision_recommendation,
        symbol,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  // Agent Communication Log Widget
  server.tool('widget_agent_log', 'Render agent communication and decision flow', {
    agents: z.array(z.object({
      name: z.string(),
      status: z.enum(['thinking', 'complete', 'error']),
      output: z.string(),
      timestamp: z.number().optional(),
    })).describe('Agent execution log'),
    final_decision: z.string().optional().describe('Final decision summary'),
  }, async ({ agents, final_decision }) => {
    try {
      return jsonResult(await core.createAgentLog({ agents, final_decision }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });
}
