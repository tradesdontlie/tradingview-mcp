// Explicit read-only live proof on a disposable layout. No chart/account/file mutations.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttp } from '../src/server.js';
import { evaluate, selectTarget, disconnect } from '../src/connection.js';
import { allTools } from '../src/permissions.js';

const old = Object.fromEntries(['MCP_PERM_MODE', 'MCP_PERM_DISABLED', 'MCP_AUDIT_LOG'].map(key => [key, process.env[key]]));
process.env.MCP_PERM_MODE = 'rw';
delete process.env.MCP_PERM_DISABLED;
process.env.MCP_AUDIT_LOG = 'false';
let running;
let client;
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  assert.ok(!response.isError, `${name} returned an MCP error`);
  const result = JSON.parse(response.content.find(item => item.type === 'text').text);
  assert.notEqual(result.success, false, `${name} reported failure`);
  console.log(`PASS ${name}`);
  return result;
}
try {
  running = await startHttp({ host: '127.0.0.1', port: 0, tui: false, transport: 'mcp' });
  client = new Client({ name: 'local-bridge-read-only-smoke', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.httpServer.address().port}/mcp`)));
  const targets = await call('target_list');
  const target = process.env.MCP_SMOKE_TARGET_ID || process.env.TV_CDP_TARGET_ID || (targets.targets.length === 1 ? targets.targets[0].id : null);
  assert.ok(target, 'Multiple charts require an explicit MCP_SMOKE_TARGET_ID');
  await call('target_select', { target_id: target });
  await selectTarget(target);
  const snapshot = () => evaluate(`(() => {
    const chart=window.TradingViewApi._activeChartWidgetWV.value();
    return { layout:window.TradingViewApi._chartWidgetCollection.metaInfo.name.value(),
      symbol:chart.symbolExt().full_name,resolution:chart.resolution(),
      studies:chart.getAllStudies(),shapes:chart.getAllShapes(),range:chart.getVisibleRange() };
  })()`);
  const before = await snapshot();
  assert.equal(before.layout, 'temp', 'Live proof is restricted to the disposable temp layout');
  assert.equal((await client.listTools()).tools.length, allTools().length);
  await call('tv_health_check');
  await call('chart_get_state');
  await call('quote_get');
  await call('data_get_ohlcv', { count: 10, summary: true });
  await call('data_get_study_values');
  await call('pine_analyze', { source: '//@version=6\nindicator("Smoke")\nplot(close)' });
  assert.deepEqual(await snapshot(), before);
  console.log('PASS selected chart identity, studies, drawings and viewport unchanged; no result payloads retained');
} finally {
  await client?.close();
  await running?.shutdown();
  await disconnect();
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
