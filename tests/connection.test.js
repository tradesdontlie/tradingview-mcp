/**
 * Regression tests for src/connection.js dedicated-tab resolution.
 *
 * Bug (2026-06-02): commit 508b16f made createDedicatedTab() open a new tab via
 *   the CDP HTTP endpoint `/json/new`. On TradingView Desktop (Electron 38 /
 *   Chrome 140) that endpoint is unusable — GET returns 405 ("unsafe HTTP verb"),
 *   PUT returns 500 ("Could not create new page"), and Target.createTarget reports
 *   "Not supported". The result: connect() failed 5× and the whole MCP could not
 *   attach. Fix: adopt an existing TradingView chart tab instead of creating one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/connection.js', import.meta.url), 'utf8');

describe('connection.js — adopts an existing tab, never creates one via CDP', () => {
  // Detect actual CALLS to the broken APIs (not comments documenting why we avoid them).
  it('does not fetch the /json/new endpoint (405/500 on TradingView Desktop)', () => {
    assert.ok(!/fetch\([^)]*\/json\/new/i.test(src),
      'connection.js must not fetch /json/new — TradingView Desktop rejects it');
  });

  it('does not call Target.createTarget ("Not supported" on this Electron build)', () => {
    assert.ok(!/\.createTarget\s*\(/.test(src),
      'connection.js must not call Target.createTarget — unsupported on TradingView Desktop');
  });

  it('createDedicatedTab adopts a chart tab from /json/list and pins it', () => {
    const start = src.indexOf('async function createDedicatedTab');
    assert.ok(start !== -1, 'createDedicatedTab must exist (referenced by findChartTarget)');
    const body = src.slice(start, src.indexOf('\n}', start) + 2);
    assert.ok(body.includes('/json/list'), 'must enumerate open tabs via /json/list');
    assert.ok(body.includes('tradingview'), 'must select a TradingView tab');
    assert.ok(body.includes('dedicatedTabId ='), 'must remember the adopted tab id');
  });

  it('findChartTarget reuses a still-open dedicated tab before adopting another', () => {
    const start = src.indexOf('async function findChartTarget');
    const body = src.slice(start, src.indexOf('\n}', start) + 2);
    assert.ok(body.indexOf('dedicatedTabId') < body.indexOf('createDedicatedTab'),
      'dedicatedTabId reuse must be checked before createDedicatedTab fallback');
  });
});
