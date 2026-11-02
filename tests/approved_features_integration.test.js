import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildServer, startHttp, startStdio } from '../src/server.js';
import { getToolDefinitions } from '../src/tool-definitions.js';
import { getSessionContext, createSessionContext } from '../src/session-context.js';
import { applyPermissions, loadConfig, getAuditLogger, allTools, isToolEnabled } from '../src/permissions.js';
import { runTui } from '../src/admin/tui.js';

function environment(t, changes) {
  const saved = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tv-feature-integration-'));
  t.after(() => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const text = response => JSON.parse(response.content[0].text);

it('keeps target ownership in real HTTP MCP sessions and disposes each disconnected session', async t => {
  environment(t, { MCP_PERM_MODE: 'rw', MCP_PERM_DISABLED: undefined, MCP_AUDIT_LOG: 'false' });
  const sessions = [];
  const register = server => {
    for (const definition of getToolDefinitions()) {
      let callback = definition.callback;
      if (definition.name === 'target_list') callback = async () => result({ selected_target_id: getSessionContext().selectedTargetId });
      if (definition.name === 'target_select') callback = async ({ target_id }) => {
        const session = getSessionContext();
        session.selectedTargetId = target_id;
        await new Promise(resolve => setTimeout(resolve, target_id === 'a' ? 20 : 1));
        return result({ selected_target_id: getSessionContext().selectedTargetId });
      };
      server.tool(definition.name, definition.description, definition.parameters, callback);
    }
  };
  const running = await startHttp({ host: '127.0.0.1', port: 0, tui: false, transport: 'mcp', buildServer: monitor => {
    const built = buildServer(monitor, { registerTools: register });
    sessions.push(built.session);
    return built;
  } });
  t.after(() => running.shutdown());
  const endpoint = new URL(`http://127.0.0.1:${running.httpServer.address().port}/mcp`);
  const a = new Client({ name: 'target-a', version: '1' });
  const b = new Client({ name: 'target-b', version: '1' });
  const transports = [new StreamableHTTPClientTransport(endpoint), new StreamableHTTPClientTransport(endpoint)];
  try {
    await Promise.all([a.connect(transports[0]), b.connect(transports[1])]);
    const selections = await Promise.all([
      a.callTool({ name: 'target_select', arguments: { target_id: 'a' } }),
      b.callTool({ name: 'target_select', arguments: { target_id: 'b' } }),
    ]);
    assert.deepEqual(selections.map(text).map(r => r.selected_target_id), ['a', 'b']);
    const reads = await Promise.all([a.callTool({ name: 'target_list' }), b.callTool({ name: 'target_list' })]);
    assert.deepEqual(reads.map(text).map(r => r.selected_target_id), ['a', 'b']);
    const tools = await a.listTools();
    assert.equal(tools.tools.length, allTools().length);
    assert.ok(tools.tools.find(tool => tool.name === 'replay_start').inputSchema.properties.timestamp);
    await Promise.all(transports.map(transport => transport.terminateSession()));
    assert.ok(sessions.every(session => session.closed), 'HTTP session termination disposes target ownership before server shutdown');
  } finally {
    await Promise.all([a.close(), b.close()]);
    await running.shutdown();
  }
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every(session => session.closed));
});

it('rechecks queued permissions and logs denied calls without retaining argument or error text', async t => {
  const directory = temporary(t);
  const path = join(directory, 'calls.jsonl');
  environment(t, { MCP_PERM_MODE: 'rw', MCP_PERM_DISABLED: undefined, MCP_AUDIT_LOG: 'true', MCP_AUDIT_LOG_PATH: path });
  const callbacks = new Map();
  const server = { tool(name, description, schema, callback) { callbacks.set(name, callback); } };
  const session = createSessionContext();
  applyPermissions(server, loadConfig(), null, { session });
  let release;
  let entered;
  const began = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let mutation = false;
  server.tool('quote_get', '', {}, async () => { entered(); await gate; return result({ success: true, password: 'sensitive-result' }); });
  server.tool('chart_set_symbol', '', {}, async () => { mutation = true; return result({ success: true }); });
  const first = callbacks.get('quote_get')({ source: 'sensitive-source' });
  await began;
  const second = callbacks.get('chart_set_symbol')({ source: 'sensitive-source' });
  process.env.MCP_PERM_MODE = 'read';
  release();
  await first;
  assert.equal((await second).isError, true);
  assert.equal(mutation, false);
  const contents = readFileSync(path, 'utf8');
  const records = contents.trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(record => record.status), ['success', 'denied']);
  assert.doesNotMatch(contents, /sensitive-source|sensitive-result|password|Permission denied/);
});

it('audit configuration switches on the next call and logging failures preserve the tool outcome', async t => {
  const directory = temporary(t);
  const path = join(directory, 'calls.jsonl');
  environment(t, { MCP_PERM_MODE: 'rw', MCP_PERM_DISABLED: undefined, MCP_AUDIT_LOG: 'false', MCP_AUDIT_LOG_PATH: path });
  assert.equal(getAuditLogger().enabled, false);
  process.env.MCP_AUDIT_LOG = 'true';
  assert.equal(getAuditLogger().enabled, true);
  const callbacks = new Map();
  const server = { tool(name, description, schema, callback) { callbacks.set(name, callback); } };
  // Unsupported destination disables the sink but not the successful tool call.
  process.env.MCP_AUDIT_LOG_PATH = join(directory, 'bad-extension.txt');
  applyPermissions(server, loadConfig());
  server.tool('quote_get', '', {}, async () => result({ success: true, last: 10 }));
  assert.equal(text(await callbacks.get('quote_get')()).last, 10);
});

it('the TUI audit opt-in saves alongside permissions and Read retains all new write restrictions', t => {
  environment(t, { MCP_PERM_MODE: 'read', MCP_AUDIT_LOG: 'false' });
  const stdin = new EventEmitter();
  stdin.pause = () => {};
  let captured;
  let screen = '';
  runTui({ stdin, stdout: { rows: 30, columns: 130, write: value => { screen += value; } }, onQuit() {}, saveSettings: values => { captured = values; } });
  stdin.emit('keypress', 'l', { name: 'l' });
  stdin.emit('keypress', 's', { name: 's' });
  assert.equal(captured.MCP_AUDIT_LOG, 'true');
  assert.equal(captured.MCP_PERM_MODE, 'read');
  assert.match(screen, /audit=on/);
  const cfg = loadConfig();
  for (const name of ['target_select', 'data_load_history', 'indicator_set_style', 'watchlist_create_section', 'watchlist_move_to_section']) {
    assert.equal(isToolEnabled(name, cfg), false, name);
  }
  for (const name of ['target_list', 'indicator_get_style', 'watchlist_get_sections']) assert.equal(isToolEnabled(name, cfg), true);
  stdin.emit('keypress', 'q', { name: 'q' });
});

it('disposes the stdio-owned session when client stdin reaches EOF', async t => {
  environment(t, { MCP_PERM_MODE: 'rw', MCP_AUDIT_LOG: 'false' });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const running = await startStdio({ stdin, stdout });
  assert.equal(running.session.closed, false);
  stdin.end();
  for (let i = 0; i < 20 && !running.session.closed; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(running.session.closed, true);
  await running.shutdown();
});

it('universal CLI validates real tool schemas and retains permission checks without a CDP connection', () => {
  const args = ['src/cli/index.js', 'call', 'pine_analyze', '--args', JSON.stringify({ source: '//@version=6\nindicator("Test")\nplot(close)' })];
  const permitted = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, MCP_PERM_MODE: 'rw', MCP_AUDIT_LOG: 'false' } });
  assert.equal(permitted.status, 0, permitted.stderr);
  assert.equal(JSON.parse(permitted.stdout).success, true);
  const denied = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, MCP_PERM_MODE: 'read', MCP_PERM_DISABLED: 'pine_analyze', MCP_AUDIT_LOG: 'false' } });
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /Permission denied: pine_analyze/);
  const invalid = spawnSync(process.execPath, ['src/cli/index.js', 'call', 'pine_analyze', '--args', '{"action":"invalid"}'], { encoding: 'utf8', env: { ...process.env, MCP_PERM_MODE: 'rw', MCP_AUDIT_LOG: 'false' } });
  assert.equal(invalid.status, 1);
  assert.doesNotMatch(invalid.stderr, /ECONNREFUSED/);
});
