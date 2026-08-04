import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tradingviewServerPath = path.join(__dirname, '..', '..', 'src', 'server.js');
const onchainServerPath = path.join(__dirname, '..', 'mcp-servers', 'onchain-server.js');

const agentOptions = {
  systemPrompt: {
    type: 'preset',
    preset: 'claude_code',
    append: `You are a market research agent. You have three capability groups:
- News: use WebSearch / WebFetch for current news, sentiment, and events.
- On-chain / crypto market data: use the "onchain" MCP tools (CoinGecko + DefiLlama — no API key needed).
- Live chart data: use the "tradingview" MCP tools to read the user's TradingView Desktop chart (must be running with tv_health_check first).
Combine these as needed and cite where each fact came from.`,
  },
  mcpServers: {
    tradingview: {
      command: 'node',
      args: [tradingviewServerPath],
    },
    onchain: {
      command: 'node',
      args: [onchainServerPath],
    },
  },
  allowedTools: ['mcp__tradingview__*', 'mcp__onchain__*', 'WebSearch', 'WebFetch'],
};

/**
 * Runs one agent turn for `prompt` and returns the final result text.
 * `onEvent(message)` is called for every raw SDK message, for callers that
 * want to stream progress (tool calls, warnings) as it happens.
 */
export async function runAgent(prompt, { onEvent } = {}) {
  let result = null;
  for await (const message of query({ prompt, options: agentOptions })) {
    onEvent?.(message);
    if (message.type === 'result' && message.subtype === 'success') {
      result = message.result;
    }
  }
  return result;
}
