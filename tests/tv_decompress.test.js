/**
 * Tests for the hardened compressed-report decoder (src/sidecar/tv_decompress.js) — T119.
 *
 * TradingView ships the strategy backtest report as a zlib-deflated (magic 78 9c)
 * base64 blob. @mathieuc/tradingview's own parseCompressed assumes a ZIP
 * container (jszip) and throws "Can't find end of central directory" on it,
 * crashing the study listener. decodeCompressed handles zlib/gzip/raw-inflate.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { decodeCompressed } from '../src/sidecar/tv_decompress.js';

const b64 = (buf) => buf.toString('base64');
const OBJ = { report: { performance: { all: { netProfit: 123 } } }, trades: [1, 2, 3] };

describe('decodeCompressed()', () => {
  it('decodes a zlib-deflated JSON blob (TV\'s real format, magic 78 9c)', () => {
    const encoded = b64(zlib.deflateSync(Buffer.from(JSON.stringify(OBJ))));
    assert.deepEqual(decodeCompressed(encoded), OBJ);
  });

  it('decodes a gzip blob (magic 1f 8b)', () => {
    const encoded = b64(zlib.gzipSync(Buffer.from(JSON.stringify(OBJ))));
    assert.deepEqual(decodeCompressed(encoded), OBJ);
  });

  it('decodes a raw-deflate blob', () => {
    const encoded = b64(zlib.deflateRawSync(Buffer.from(JSON.stringify(OBJ))));
    assert.deepEqual(decodeCompressed(encoded), OBJ);
  });

  it('throws on undecodable data', () => {
    assert.throws(() => decodeCompressed(b64(Buffer.from('not compressed json'))));
  });
});
