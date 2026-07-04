import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './create-server.js';

process.stderr.write('⚠  tradingview-mcp  |  Unofficial tool. Not affiliated with TradingView Inc. or Anthropic.\n');
process.stderr.write('   Ensure your usage complies with TradingView\'s Terms of Use.\n\n');

const server = createMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
