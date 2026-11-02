import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { allTools, isToolEnabled, setPermissionMode, applyPermissions } from '../src/permissions.js';
import { getToolDefinitions } from '../src/tool-definitions.js';
import { assertCliPermission } from '../src/cli/permissions.js';
import { runTui } from '../src/admin/tui.js';

const config = (mode, enabled = [], disabled = []) => ({ mode, enabled: new Set(enabled), disabled: new Set(disabled) });

describe('permission catalog and TUI', () => {
  it('covers every registered tool exactly once, including fork and upstream additions', () => {
    const definitions = getToolDefinitions();
    const catalog = allTools();
    assert.equal(new Set(catalog.map(t => t.name)).size, catalog.length);
    assert.deepEqual(catalog.map(t => t.name).sort(), definitions.map(t => t.name).sort());
    for (const name of ['target_list', 'data_load_history', 'indicator_search', 'tv_update', 'strategy_prepare']) {
      assert.ok(catalog.some(t => t.name === name));
    }
    assert.ok(definitions.find(t => t.name === 'capture_screenshot').parameters.wait_for_render);
  });

  it('preserves Read selections when entering Custom, without enabling writes', () => {
    const cfg = config('read', [], ['quote_get']);
    const before = allTools().filter(t => isToolEnabled(t.name, cfg)).map(t => t.name);
    setPermissionMode(cfg, 'custom');
    assert.deepEqual([...cfg.enabled], before);
    assert.ok(!allTools().some(t => t.kind === 'write' && isToolEnabled(t.name, cfg)));
    assert.equal(isToolEnabled('quote_get', cfg), false);
  });

  it('retains individual denials across preset changes and preserves Custom selections', () => {
    const cfg = config('custom', ['quote_get'], ['tv_launch']);
    setPermissionMode(cfg, 'custom');
    assert.deepEqual([...cfg.enabled], ['quote_get']);
    cfg.disabled.add('tv_launch');
    setPermissionMode(cfg, 'rw');
    assert.equal(isToolEnabled('tv_launch', cfg), false);
    assert.equal(isToolEnabled('not_classified', cfg), false);
  });

  it('shows live parameter descriptions in the existing TUI details screen', () => {
    const stdin = new EventEmitter();
    stdin.pause = () => {};
    let output = '';
    const stdout = { rows: 35, columns: 120, write: value => { output += value; } };
    runTui({ stdin, stdout, onQuit() {} });
    stdin.emit('keypress', '\r', { name: 'return' });
    assert.match(output, /Parameters:/);
    assert.match(output, /target_list/);
    stdin.emit('keypress', '', { name: 'escape' });
    // Navigate to the first tool with parameters and open its schema details.
    const index = allTools().findIndex(t => t.name === 'tv_launch');
    for (let i = 0; i < index; i++) stdin.emit('keypress', '', { name: 'down' });
    stdin.emit('keypress', '\r', { name: 'return' });
    assert.match(output, /kill_existing \(optional\)/);
    stdin.emit('keypress', 'q', { name: 'q' });
  });
});

describe('permission enforcement', () => {
  it('rejects an unclassified MCP tool instead of silently granting access', () => {
    const server = { tool() {} };
    applyPermissions(server, config('rw'));
    assert.throws(() => server.tool('future_tool', '', {}, () => {}), /missing from permission catalog/);
  });

  it('checks saved/environment restrictions again before invoking an already registered MCP tool', async () => {
    let callback;
    const server = { tool(name, description, schema, cb) { callback = cb; } };
    applyPermissions(server, config('rw'));
    let invoked = false;
    server.tool('tv_launch', '', {}, () => { invoked = true; });
    const previous = process.env.MCP_PERM_MODE;
    try {
      process.env.MCP_PERM_MODE = 'read';
      assert.equal((await callback()).isError, true);
      assert.equal(invoked, false);
    } finally {
      if (previous === undefined) delete process.env.MCP_PERM_MODE;
      else process.env.MCP_PERM_MODE = previous;
    }
  });

  it('blocks CLI mutations and honors individual tool denials before CDP access', () => {
    const read = config('read');
    assert.throws(() => assertCliPermission('symbol', null, {}, ['NASDAQ:AAPL'], read), /Permission denied: chart_set_symbol/);
    assert.doesNotThrow(() => assertCliPermission('symbol', null, {}, [], read));
    assert.throws(() => assertCliPermission('ui', 'eval', {}, [], read), /Permission denied/);
    assert.throws(() => assertCliPermission('quote', null, {}, [], config('rw', [], ['quote_get'])), /Permission denied/);
    assert.throws(() => assertCliPermission('future', null, {}, [], config('rw')), /Permission denied/);
  });

  it('enforces restrictions through the real CLI entry point', () => {
    const result = spawnSync(process.execPath, ['src/cli/index.js', 'symbol', 'NASDAQ:AAPL'], {
      encoding: 'utf8', env: { ...process.env, MCP_PERM_MODE: 'read' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Permission denied: chart_set_symbol/);
    assert.doesNotMatch(result.stderr, /ECONNREFUSED/);
  });
});
