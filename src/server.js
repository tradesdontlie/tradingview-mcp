import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { registerTools, getToolDefinitions } from './tool-definitions.js';
import { pathToFileURL } from 'node:url';
import { ActivityMonitor } from './activity.js';
import { disconnect, disposeSession, CDP_HOST, CDP_PORT, isChartTarget } from './connection.js';
import { createSessionContext } from './session-context.js';
import { loadConfig, applyPermissions, allTools, isToolEnabled } from './permissions.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function parseArgs(argv) {
  const args = {
    admin: false,
    http: false,
    stdio: false,
    tui: false,
    transport: 'mcp',
    port: 3333,
    host: '127.0.0.1',
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--admin' || arg === '--config') args.admin = true;
    else if (arg === '--http') args.http = true;
    else if (arg === '--sse' || arg === 'sse') { args.http = true; args.transport = 'sse'; }
    else if (arg === '--stdio') args.stdio = true;
    else if (arg === '--tui') args.tui = true;
    else if (arg === '--no-tui') args.tui = false;
    else if (arg === '--port') args.port = Number(argv[++i]);
    else if (arg === '--host') args.host = argv[++i];
    else if (arg.startsWith('--port=')) args.port = Number(arg.slice(7));
    else if (arg.startsWith('--host=')) args.host = arg.slice(7);
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    throw new Error(`Invalid port: ${args.port}`);
  }
  return args;
}

function buildServer(activity = null, options = {}) {
  const session = options.session || createSessionContext();
  const cfg = loadConfig();
  const server = new McpServer(
    {
      name: 'tradingview',
      version: '1.0.0',
      description: 'AI-assisted TradingView chart analysis and Pine Script development via Chrome DevTools Protocol',
    },
    {
      instructions: 'Use target_list first when multiple charts are open and target_select to bind this MCP session. Then use tv_health_check before chart automation. Resolve ambiguous instruments with symbol_search. Preserve source/exchange identity when selecting symbols. Read-only chart tools operate on the session-selected chart unless their description explicitly says otherwise. TradingView Desktop must run with remote debugging on port 9222.',
    },
  );

  const catalog = new Set(allTools().map(t => t.name));
  const actual = new Set(getToolDefinitions().map(t => t.name));
  if (catalog.size !== actual.size || [...actual].some(name => !catalog.has(name))) {
    throw new Error('Permission catalog and registered tools differ. Classify every new tool before starting.');
  }
  const { skipped } = applyPermissions(server, cfg, activity, { session, getAuditLogger: options.getAuditLogger });

  (options.registerTools || registerTools)(server);

  return { server, cfg, skipped, session, dispose: () => disposeSession(session), total: allTools().length };
}

function writeBanner(cfg, skipped, total) {
  process.stderr.write('TradingView MCP (unofficial; not affiliated with TradingView Inc.)\n');
  process.stderr.write(`Permissions: mode=${cfg.mode}, enabled=${total - skipped.length}/${total}\n`);
}

async function startStdio({ buildServer: makeServer = buildServer, stdin = process.stdin, stdout = process.stdout } = {}) {
  const built = makeServer();
  const { server, cfg, skipped, total } = built;
  const transport = new StdioServerTransport(stdin, stdout);
  let closing = false;
  const removeListeners = () => {
    stdin.off('end', onEnd);
    stdin.off('close', onEnd);
    process.off('SIGINT', onEnd);
    process.off('SIGTERM', onEnd);
  };
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    removeListeners();
    try { await server.close(); } finally { await built.dispose(); }
  };
  const onEnd = () => { void shutdown(); };
  // The SDK preserves an existing transport hook, but McpServer does not expose
  // a delegated onclose property. The SDK stdio transport also needs EOF wiring.
  transport.onclose = () => { removeListeners(); void built.dispose(); };
  stdin.once('end', onEnd);
  stdin.once('close', onEnd);
  process.once('SIGINT', onEnd);
  process.once('SIGTERM', onEnd);
  writeBanner(cfg, skipped, total);
  try { await server.connect(transport); }
  catch (error) { await shutdown(); throw error; }
  return { ...built, transport, shutdown };
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body is too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 });
  }
}

function sendJson(res, statusCode, body) {
  if (res.headersSent) return;
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendMcpError(res, statusCode, message) {
  sendJson(res, statusCode, {
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  });
}

async function probeTradingView(monitor) {
  try {
    const response = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`CDP returned HTTP ${response.status}`);
    const targets = await response.json();
    const chart = targets.find(isChartTarget);
    if (chart) monitor.setTradingView(true, cropTarget(chart.title || chart.url));
    else monitor.setTradingView(false, 'Port 9222 is open, but no TradingView chart was found');
  } catch {
    monitor.setTradingView(false, 'Waiting for TradingView Desktop on port 9222');
  }
}

function cropTarget(value) {
  const text = String(value || 'TradingView chart');
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

async function startHttp({ host, port, tui, transport: transportMode, buildServer: makeServer = buildServer }) {
  const monitor = new ActivityMonitor();
  const streamableSessions = new Map();
  const legacySessions = new Map();
  let dashboard = null;
  let shuttingDown = false;

  async function handleStreamable(req, res, parsedBody) {
    const sessionId = req.headers['mcp-session-id'];
    let record = sessionId ? streamableSessions.get(sessionId) : null;

    if (!record && !sessionId && req.method === 'POST' && isInitializeRequest(parsedBody)) {
      let transport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableDnsRebindingProtection: true,
        allowedHosts: [`${host}:${port}`, `127.0.0.1:${port}`, `localhost:${port}`],
        onsessioninitialized: (id) => {
          record.id = id;
          streamableSessions.set(id, record);
          monitor.sessionOpened(id);
        },
      });
      const built = makeServer(monitor);
      record = { id: null, transport, server: built.server, dispose: built.dispose };
      transport.onclose = () => {
        void record.dispose();
        if (record.id) {
          streamableSessions.delete(record.id);
          monitor.sessionClosed(record.id);
        }
      };
      transport.onerror = (error) => monitor.failure(`MCP transport: ${error.message}`);
      await built.server.connect(transport);
    }

    if (!record) {
      sendMcpError(res, sessionId ? 404 : 400, sessionId ? 'Unknown MCP session' : 'Initialize the MCP session first');
      return;
    }
    await record.transport.handleRequest(req, res, parsedBody);
  }

  async function handleLegacySse(req, res) {
    const built = makeServer(monitor);
    const { server } = built;
    const transport = new SSEServerTransport('/messages', res, {
      enableDnsRebindingProtection: true,
      allowedHosts: [`${host}:${port}`, `127.0.0.1:${port}`, `localhost:${port}`],
    });
    const record = { id: transport.sessionId, transport, server, dispose: built.dispose };
    legacySessions.set(record.id, record);
    monitor.sessionOpened(record.id, 'legacy-sse');
    transport.onclose = () => {
      void record.dispose();
      legacySessions.delete(record.id);
      monitor.sessionClosed(record.id);
    };
    transport.onerror = (error) => monitor.failure(`Legacy SSE transport: ${error.message}`);
    await server.connect(transport);
  }

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
    monitor.request(req.method || 'GET', url.pathname);
    try {
      if (transportMode === 'mcp' && url.pathname === '/mcp') {
        const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
        await handleStreamable(req, res, body);
        return;
      }

      if (transportMode === 'sse' && req.method === 'GET' && url.pathname === '/sse') {
        await handleLegacySse(req, res);
        return;
      }

      if (transportMode === 'sse' && req.method === 'POST' && url.pathname === '/messages') {
        const sessionId = url.searchParams.get('sessionId');
        const record = legacySessions.get(sessionId);
        if (!record) {
          sendMcpError(res, 404, 'Unknown legacy SSE session');
          return;
        }
        const body = await readJsonBody(req);
        await record.transport.handlePostMessage(req, res, body);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        const state = monitor.snapshot();
        sendJson(res, 200, {
          ok: true,
          transport: transportMode === 'mcp' ? 'streamable-http' : 'legacy-sse',
          endpoint: `http://${host}:${port}/${transportMode}`,
          sessions: state.sessions.length,
          requests: state.requests,
          tool_calls: state.toolCalls,
          errors: state.errors,
          tradingview: state.tradingView,
        });
        return;
      }

      sendJson(res, 404, { error: 'Not found', endpoints: [`/${transportMode}`, '/health'] });
    } catch (error) {
      monitor.failure(`${req.method} ${url.pathname}: ${error.message}`);
      if (!res.headersSent) sendMcpError(res, error.statusCode || 500, error.message || 'Internal server error');
      else res.end();
    }
  });

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    monitor.addEvent('server', 'Shutting down');
    dashboard?.stop();
    clearInterval(probeTimer);
    for (const record of [...streamableSessions.values(), ...legacySessions.values()]) {
      try { await record.transport.close(); } catch {}
      await record.dispose();
    }
    await disconnect();
    await new Promise((resolve) => httpServer.close(resolve));
  };

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, resolve);
  });
  port = httpServer.address().port;

  const cfg = loadConfig();
  const total = allTools().length;
  const skipped = allTools().filter(t => !isToolEnabled(t.name, cfg));
  writeBanner(cfg, skipped, total);
  monitor.addEvent('server', `Listening on http://${host}:${port}/${transportMode}`, 'success');
  await probeTradingView(monitor);
  const probeTimer = setInterval(() => probeTradingView(monitor), 5000);

  if (tui) {
    const { TerminalDashboard } = await import('./admin/dashboard.js');
    dashboard = new TerminalDashboard(monitor, {
      host,
      port,
      endpoint: `/${transportMode}`,
      transport: transportMode === 'mcp' ? 'Streamable HTTP' : 'Legacy SSE',
      onQuit: () => shutdown().then(() => process.exit(0)),
    });
    dashboard.start();
  } else {
    const label = transportMode === 'mcp' ? 'Streamable HTTP' : 'Legacy SSE';
    process.stderr.write(`${label}: http://${host}:${port}/${transportMode}\n`);
  }

  process.once('SIGINT', () => shutdown().then(() => process.exit(0)));
  process.once('SIGTERM', () => shutdown().then(() => process.exit(0)));
  return { httpServer, monitor, shutdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
const args = parseArgs(process.argv);

if (args.admin) {
  const { runTui } = await import('./admin/tui.js');
  runTui();
} else if (args.http && !args.stdio) {
  await startHttp(args);
} else {
  await startStdio();
}

}

export { buildServer, parseArgs, startHttp, startStdio };
