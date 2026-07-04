import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './create-server.js';

const PORT = parseInt(process.env.MCP_HTTP_PORT || process.argv[2] || '3000');
const HOST = process.env.MCP_HTTP_HOST || '127.0.0.1';

// When binding to all interfaces, validate Host header ourselves to prevent DNS rebinding.
// The SDK's allowedHosts option runs after Hono's Node→WebStandard conversion which
// may mangle the header, so we check it at the raw Node.js layer instead.
const ALLOWED_HOSTS = process.env.MCP_ALLOWED_HOSTS
  ? process.env.MCP_ALLOWED_HOSTS.split(',').map(h => h.trim().toLowerCase())
  : null; // null = localhost-only binding, no check needed

function isHostAllowed(req) {
  if (!ALLOWED_HOSTS) return true;
  const host = (req.headers['host'] || '').toLowerCase();
  return ALLOWED_HOSTS.includes(host);
}

// sessionId → StreamableHTTPServerTransport
const sessions = new Map();

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return undefined;
  }
}

const httpServer = createServer(async (req, res) => {
  if (req.url !== '/mcp') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found — MCP endpoint is /mcp');
    return;
  }

  if (!isHostAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden: Host not allowed');
    return;
  }

  // Hono (used internally by the MCP SDK) validates the Host header by comparing
  // against a URL-parsed hostname which is always lowercased. Normalize here so
  // mixed-case .local / LAN hostnames (e.g. "Pi-iMac.local") pass validation.
  if (req.headers.host) req.headers.host = req.headers.host.toLowerCase();

  try {
    const sessionId = req.headers['mcp-session-id'];

    if (req.method === 'POST') {
      const body = await readBody(req);

      if (!sessionId) {
        const newId = randomUUID();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newId,
        });
        const mcpServer = createMcpServer();
        await mcpServer.connect(transport);
        sessions.set(newId, transport);
        transport.onclose = () => sessions.delete(newId);
        await transport.handleRequest(req, res, body);
      } else {
        const transport = sessions.get(sessionId);
        if (!transport) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Session not found');
          return;
        }
        await transport.handleRequest(req, res, body);
      }
    } else if (req.method === 'GET' || req.method === 'DELETE') {
      const transport = sessions.get(sessionId);
      if (!transport) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Session not found');
        return;
      }
      await transport.handleRequest(req, res, undefined);
    } else {
      res.writeHead(405, { Allow: 'GET, POST, DELETE' });
      res.end('Method not allowed');
    }
  } catch (err) {
    process.stderr.write(`MCP HTTP error: ${err.message}\n`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal server error');
    }
  }
});

process.stderr.write('⚠  tradingview-mcp  |  Unofficial tool. Not affiliated with TradingView Inc. or Anthropic.\n');
process.stderr.write('   Ensure your usage complies with TradingView\'s Terms of Use.\n\n');

httpServer.listen(PORT, HOST, () => {
  process.stderr.write(`MCP HTTP server listening on http://${HOST}:${PORT}/mcp\n`);
  if (ALLOWED_HOSTS) {
    process.stderr.write(`Allowed hosts: ${ALLOWED_HOSTS.join(', ')}\n`);
  }
});
