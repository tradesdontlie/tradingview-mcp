/**
 * Tests for the ui_evaluate gate. ui_evaluate runs arbitrary JS in the
 * TradingView page context, so it must be off unless explicitly enabled.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { uiEvaluate } from '../src/core/ui.js';
import { registerUiTools } from '../src/tools/ui.js';

describe('ui_evaluate — env-gated', () => {
  let prev;
  beforeEach(() => { prev = process.env.TRADINGVIEW_MCP_ALLOW_EVAL; });
  afterEach(() => {
    if (prev === undefined) delete process.env.TRADINGVIEW_MCP_ALLOW_EVAL;
    else process.env.TRADINGVIEW_MCP_ALLOW_EVAL = prev;
  });

  it('throws when TRADINGVIEW_MCP_ALLOW_EVAL is unset', async () => {
    delete process.env.TRADINGVIEW_MCP_ALLOW_EVAL;
    await assert.rejects(uiEvaluate({ expression: '1+1' }), /disabled/i);
  });

  it('throws when TRADINGVIEW_MCP_ALLOW_EVAL is any value other than "1"', async () => {
    process.env.TRADINGVIEW_MCP_ALLOW_EVAL = 'true';
    await assert.rejects(uiEvaluate({ expression: '1+1' }), /disabled/i);
  });

  it('does not register the ui_evaluate tool when env flag is unset', () => {
    delete process.env.TRADINGVIEW_MCP_ALLOW_EVAL;
    const registered = [];
    const server = { tool: (name) => registered.push(name) };
    registerUiTools(server);
    assert.ok(!registered.includes('ui_evaluate'), 'ui_evaluate should not be registered without the env flag');
  });

  it('registers the ui_evaluate tool when TRADINGVIEW_MCP_ALLOW_EVAL=1', () => {
    process.env.TRADINGVIEW_MCP_ALLOW_EVAL = '1';
    const registered = [];
    const server = { tool: (name) => registered.push(name) };
    registerUiTools(server);
    assert.ok(registered.includes('ui_evaluate'), 'ui_evaluate should be registered with the env flag');
  });
});
