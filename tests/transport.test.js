import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'src', 'server.js');
const children = new Set();

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Server did not become healthy within 10 seconds');
}

async function launch(mode) {
  const port = await freePort();
  const args = [SERVER, mode === 'sse' ? '--sse' : '--http', '--no-tui', `--port=${port}`];
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MCP_PERM_MODE: 'rw' },
  });
  children.add(child);
  const health = await waitForHealth(port, child);
  return { child, port, health };
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  children.delete(child);
}

afterEach(async () => {
  await Promise.all([...children].map(stop));
});

describe('MCP HTTP transports', () => {
  it('serves Streamable HTTP at /mcp', async () => {
    const { child, port, health } = await launch('mcp');
    assert.equal(health.transport, 'streamable-http');
    assert.equal(health.endpoint, `http://127.0.0.1:${port}/mcp`);

    const client = new Client({ name: 'transport-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client.connect(transport);
    const result = await client.listTools();
    assert.ok(result.tools.some((tool) => tool.name === 'tv_health_check'));
    assert.ok(result.tools.length > 0);
    const toolResult = await client.callTool({
      name: 'pine_analyze',
      arguments: { source: '//@version=6\nindicator("test")\nplot(close)' },
    });
    assert.equal(toolResult.isError, undefined, JSON.stringify(toolResult));
    const activity = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
    assert.equal(activity.tool_calls, 1);
    await client.close();
    await stop(child);
  });

  it('serves legacy SSE at /sse when requested', async () => {
    const { child, port, health } = await launch('sse');
    assert.equal(health.transport, 'legacy-sse');
    assert.equal(health.endpoint, `http://127.0.0.1:${port}/sse`);

    const client = new Client({ name: 'sse-transport-test', version: '1.0.0' });
    const transport = new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`));
    await client.connect(transport);
    const result = await client.listTools();
    assert.ok(result.tools.some((tool) => tool.name === 'tv_health_check'));
    await client.close();
    await stop(child);
  });
});
