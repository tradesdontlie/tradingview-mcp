/**
 * Tests for the shared tool-parameter schemas in src/tools/_schema.js,
 * and for the tools that use them.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { booleanParam } from '../src/tools/_schema.js';
import { registerAlertTools } from '../src/tools/alerts.js';
import { registerDataTools } from '../src/tools/data.js';
import { registerHealthTools } from '../src/tools/health.js';
import { registerIndicatorTools } from '../src/tools/indicators.js';
import { registerUiTools } from '../src/tools/ui.js';

const REGISTER = [registerAlertTools, registerDataTools, registerHealthTools, registerIndicatorTools, registerUiTools];

/** Collects each tool's parameter shape without starting a server. */
function toolShapes() {
  const shapes = new Map();
  const server = { tool: (name, _description, shape) => { shapes.set(name, shape); } };
  for (const register of REGISTER) register(server);
  return shapes;
}

// ── booleanParam() ───────────────────────────────────────────────────────

describe('booleanParam()', () => {
  const schema = booleanParam();

  it('accepts booleans and the words true/false in any case', () => {
    for (const [input, expected] of [
      [true, true], [false, false],
      ['true', true], ['false', false],
      ['False', false], [' TRUE ', true],
    ]) {
      assert.equal(schema.parse(input), expected, `input ${JSON.stringify(input)}`);
    }
  });

  // The regression: z.coerce.boolean() used Boolean(value), so these all became true.
  it('rejects anything else instead of guessing', () => {
    for (const input of ['0', '1', 'yes', 'no', '', ' ', null, 0, 1, [], {}]) {
      assert.equal(schema.safeParse(input).success, false, `input ${JSON.stringify(input)}`);
    }
  });

  it('stays optional when wrapped with .optional()', () => {
    const optional = booleanParam().optional();
    assert.equal(optional.parse(undefined), undefined);
    assert.equal(optional.parse('false'), false);
  });
});

// ── Tools that take booleans ─────────────────────────────────────────────

describe('boolean tool parameters', () => {
  it('alert_delete reads delete_all: "false" as false', () => {
    const params = z.object(toolShapes().get('alert_delete')).parse({ alert_id: 123, delete_all: 'false' });
    assert.equal(params.delete_all, false);
  });

  it('tv_launch reads kill_existing: "false" as false', () => {
    const params = z.object(toolShapes().get('tv_launch')).parse({ kill_existing: 'false' });
    assert.equal(params.kill_existing, false);
  });

  it('indicator_toggle_visibility reads visible: "false" as false', () => {
    const shape = toolShapes().get('indicator_toggle_visibility');
    assert.ok(shape.visible, 'expected a visible parameter');
    assert.equal(shape.visible.parse('false'), false);
  });

  it('no tool file uses z.coerce.boolean()', () => {
    const toolsDir = fileURLToPath(new URL('../src/tools/', import.meta.url));
    for (const file of readdirSync(toolsDir).filter((f) => f.endsWith('.js'))) {
      const source = readFileSync(toolsDir + file, 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('*'))
        .join('\n');
      assert.doesNotMatch(source, /z\.coerce\.boolean\(/, `${file} should use booleanParam()`);
    }
  });

  it('advertises the parameters as plain booleans to MCP clients', async () => {
    const server = new McpServer({ name: 'schema-test', version: '0' });
    for (const register of REGISTER) register(server);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'schema-test', version: '0' });
    await client.connect(clientSide);
    try {
      const { tools } = await client.listTools();
      const property = (tool, name) => tools.find((t) => t.name === tool).inputSchema.properties[name];
      for (const [tool, name] of [
        ['alert_delete', 'delete_all'],
        ['tv_launch', 'kill_existing'],
        ['indicator_toggle_visibility', 'visible'],
        ['data_get_ohlcv', 'summary'],
        ['ui_mouse_click', 'double_click'],
      ]) {
        assert.equal(property(tool, name).type, 'boolean', `${tool}.${name}`);
      }
    } finally {
      await client.close();
    }
  });
});
