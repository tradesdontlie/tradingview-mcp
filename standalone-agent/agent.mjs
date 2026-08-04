import 'dotenv/config';
import { runAgent } from './lib/run-agent.mjs';

const prompt = process.argv.slice(2).join(' ');
if (!prompt) {
  console.error('Usage: npm start -- "<your research prompt>"');
  process.exit(1);
}

function onEvent(message) {
  if (message.type === 'system' && message.subtype === 'init') {
    const failed = message.mcp_servers.filter((s) => s.status === 'failed' || s.status === 'needs-auth');
    if (failed.length) console.warn('MCP servers unavailable:', failed);
  } else if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if (block.type === 'text') console.log(block.text);
      else if (block.type === 'tool_use') console.log(`[tool] ${block.name}`, JSON.stringify(block.input));
    }
  } else if (message.type === 'result' && message.subtype !== 'success') {
    console.error('Run ended with an error:', message.subtype);
  }
}

await runAgent(prompt, { onEvent });
