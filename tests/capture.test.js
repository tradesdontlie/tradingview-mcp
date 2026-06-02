/**
 * Regression tests for src/core/capture.js.
 *
 * Bug (2026-06-02): capture_screenshot (method=cdp) was decoupled from the
 *   active data chart. evaluate()/chart_set_symbol run JS in the connected CDP
 *   target, but Page.captureScreenshot grabs the painted window surface = whatever
 *   tab is in front, so the PNG showed a different tab. Fix: call
 *   Page.bringToFront() on the same client before captureScreenshot, so the
 *   captured surface matches the chart the data layer drives. (fromSurface:false
 *   was verified to return a blank image in this Electron build — not usable.)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { captureScreenshot } from '../src/core/capture.js';

// ── Mock helpers ─────────────────────────────────────────────────────────

function makeClient() {
  const order = [];
  const captureParams = [];
  return {
    order, captureParams,
    Page: {
      bringToFront: async () => { order.push('bringToFront'); },
      captureScreenshot: async (params) => {
        order.push('captureScreenshot');
        captureParams.push(params);
        return { data: Buffer.from('PNGDATA').toString('base64') };
      },
    },
  };
}

function makeDeps(overrides = {}) {
  const client = overrides.client || makeClient();
  const writes = [];
  const _deps = {
    getClient: async () => client,
    evaluate: async () => null,
    getChartCollection: async () => 'COL',
    writeFile: (path, buf) => { writes.push({ path, len: buf.length }); },
    mkdir: () => {},
    ...overrides,
  };
  delete _deps.client;
  return { _deps, client, writes };
}

// ── CDP capture couples to the connected target ────────────────────────────

describe('captureScreenshot (cdp) — couples capture to the data-layer tab', () => {
  it('calls Page.bringToFront BEFORE Page.captureScreenshot on the same client', async () => {
    const { _deps, client } = makeDeps();
    const result = await captureScreenshot({ region: 'full', method: 'cdp', _deps });
    assert.equal(result.success, true);
    assert.equal(result.method, 'cdp');
    assert.deepEqual(client.order, ['bringToFront', 'captureScreenshot'],
      'bringToFront must precede captureScreenshot');
  });

  it('writes a .png and returns its path', async () => {
    const { _deps, writes } = makeDeps();
    const result = await captureScreenshot({ region: 'full', filename: 'unit_test_cap', _deps });
    assert.ok(result.file_path.endsWith('unit_test_cap.png'));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].len, Buffer.from('PNGDATA').length);
  });

  it('region=chart clips to the bounds from evaluate, after bringToFront', async () => {
    const evaluate = async () => ({ x: 10, y: 20, width: 300, height: 200 });
    const { _deps, client } = makeDeps({ evaluate });
    await captureScreenshot({ region: 'chart', method: 'cdp', _deps });
    assert.deepEqual(client.captureParams[0].clip, { x: 10, y: 20, width: 300, height: 200, scale: 1 });
    assert.deepEqual(client.order, ['bringToFront', 'captureScreenshot']);
  });

  it('region=full passes no clip', async () => {
    const { _deps, client } = makeDeps();
    await captureScreenshot({ region: 'full', method: 'cdp', _deps });
    assert.equal(client.captureParams[0].clip, undefined);
  });

  it('still captures if bringToFront fails (degrades gracefully)', async () => {
    const client = makeClient();
    client.Page.bringToFront = async () => { throw new Error('bringToFront unsupported'); };
    const { _deps } = makeDeps({ client });
    const result = await captureScreenshot({ region: 'full', method: 'cdp', _deps });
    assert.equal(result.success, true);
    assert.deepEqual(client.order, ['captureScreenshot'], 'capture proceeds despite bringToFront error');
  });
});

// ── API method is unaffected ───────────────────────────────────────────────

describe('captureScreenshot (api) — triggers TV UI, no CDP capture', () => {
  it('uses takeScreenshot and does not call captureScreenshot/bringToFront', async () => {
    const { _deps, client } = makeDeps();
    const result = await captureScreenshot({ region: 'full', method: 'api', _deps });
    assert.equal(result.method, 'api');
    assert.equal(client.order.length, 0, 'no CDP bringToFront/captureScreenshot for api method');
  });
});

// ── Source audit ─────────────────────────────────────────────────────────

describe('capture.js source audit', () => {
  it('calls Page.bringToFront before Page.captureScreenshot in source order', () => {
    const src = readFileSync(new URL('../src/core/capture.js', import.meta.url), 'utf8');
    const front = src.indexOf('Page.bringToFront');
    const shot = src.indexOf('Page.captureScreenshot');
    assert.ok(front !== -1, 'capture.js must call Page.bringToFront');
    assert.ok(shot !== -1, 'capture.js must call Page.captureScreenshot');
    assert.ok(front < shot, 'bringToFront must appear before captureScreenshot');
  });
});
