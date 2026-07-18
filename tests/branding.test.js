import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getBranding } from '../src/branding.js';

describe('getBranding()', () => {
  it('uses NinjaView as the default product codename', () => {
    assert.deepEqual(getBranding({}), {
      displayName: 'NinjaView',
      codename: 'ninjaview',
      mcpServerName: 'ninjaview-bridge',
      description: 'Local MCP bridge for TradingView Desktop and read-only NinjaTrader TradingBridge snapshots',
    });
  });

  it('supports a later rename through generic environment overrides', () => {
    assert.deepEqual(getBranding({
      APP_DISPLAY_NAME: 'Project Horizon',
      APP_CODENAME: 'horizon',
    }), {
      displayName: 'Project Horizon',
      codename: 'horizon',
      mcpServerName: 'horizon-bridge',
      description: 'Local MCP bridge for TradingView Desktop and read-only NinjaTrader TradingBridge snapshots',
    });
  });

  it('rejects codenames that are unsafe for an MCP server identifier', () => {
    assert.throws(
      () => getBranding({ APP_CODENAME: 'Bad Name' }),
      /APP_CODENAME must be a lowercase slug/,
    );
  });
});

describe('server branding wiring', () => {
  it('uses the central branding module instead of product-name literals', () => {
    const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
    assert.match(source, /getBranding\(\)/);
    assert.match(source, /branding\.mcpServerName/);
    assert.match(source, /branding\.displayName/);
    assert.doesNotMatch(source, /FuturesMac Bridge|futuresmac-bridge|NinjaView/);
  });
});
