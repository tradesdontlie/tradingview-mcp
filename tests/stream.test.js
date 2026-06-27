/**
 * Offline tests for the streaming extraction convergence + bounded poll loop
 * (converge-streaming-extraction). No live TradingView — a fake `evaluate`
 * returns the raw payload the shared data.js builders would produce.
 *
 *  - Parity: the stream fetch* extractors reshape the SAME raw payload data.js
 *    extracts, so streamed values/lines/labels/tables match data_get_* output.
 *  - Bounded errors: streamErrorAction backs off every error and terminates a
 *    persistent NON-transport error instead of looping at the base interval.
 *
 * Run: node --test tests/stream.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchValues,
  fetchLines,
  fetchLabels,
  fetchTables,
  shapeStreamTables,
  streamErrorAction,
} from '../src/core/stream.js';
import { shapeLines, shapeLabels, getStudyValues } from '../src/core/data.js';

// A fake evaluate that returns `payload` regardless of the JS string. The stream
// extractors wrap the builder as `({ symbol: ..., data: <builder> })`, so the
// payload mirrors that shape.
const evalReturning = (payload) => async () => payload;

describe('stream fetchValues — reuses the data.js values path', () => {
  it('reshapes the shared builder payload to {symbol, studies:[{name,values}]}', async () => {
    const raw = [{ entity_id: 's1', name: 'RSI', values: { RSI: 54.32, Signal: 50 } }];
    const r = await fetchValues(evalReturning({ symbol: 'BINANCE:BTCUSDT', data: raw }));
    assert.equal(r.symbol, 'BINANCE:BTCUSDT');
    assert.equal(r.study_count, 1);
    assert.deepEqual(r.studies, [{ name: 'RSI', values: { RSI: 54.32, Signal: 50 } }]);
  });

  it('matches getStudyValues for the same extracted payload (parity)', async () => {
    const raw = [{ entity_id: 's1', name: 'RSI', values: { RSI: 54.32 } }];
    const streamed = await fetchValues(evalReturning({ symbol: 'X', data: raw }));
    const data = await getStudyValues({ _deps: { evaluate: async () => raw } });
    // Same per-study name + values (stream omits entity_id by schema).
    assert.equal(streamed.studies[0].name, data.studies[0].name);
    assert.deepEqual(streamed.studies[0].values, data.studies[0].values);
  });
});

describe('stream fetchLines — reuses buildGraphicsJS + shapeLines', () => {
  it('reshapes to {study, levels} matching shapeLines.horizontal_levels (parity)', async () => {
    const results = [{
      name: 'NY Levels', count: 2,
      items: [{ id: 'a', raw: { y1: 100, y2: 100 } }, { id: 'b', raw: { y1: 200, y2: 200 } }],
    }];
    const streamed = await fetchLines(evalReturning({ symbol: 'X', data: { results, warnings: [] } }));
    const data = shapeLines(results, []);
    assert.equal(streamed.symbol, 'X');
    assert.equal(streamed.study_count, 1);
    assert.equal(streamed.studies[0].study, 'NY Levels');
    assert.deepEqual(streamed.studies[0].levels, [200, 100]);
    // Parity: stream levels === data.js horizontal_levels for the same input.
    assert.deepEqual(streamed.studies[0].levels, data.studies[0].horizontal_levels);
  });
});

describe('stream fetchLabels — reuses buildGraphicsJS + shapeLabels', () => {
  it('reshapes to {study, labels:[{text,price}]} matching shapeLabels (parity)', async () => {
    const results = [{
      name: 'Bias', count: 1,
      items: [{ id: 'a', raw: { t: 'PDH', y: 24550 } }],
    }];
    const streamed = await fetchLabels(evalReturning({ symbol: 'X', data: { results, warnings: [] } }));
    const data = shapeLabels(results, []);
    assert.equal(streamed.studies[0].study, 'Bias');
    assert.deepEqual(streamed.studies[0].labels, [{ text: 'PDH', price: 24550 }]);
    assert.deepEqual(streamed.studies[0].labels, data.studies[0].labels);
  });
});

describe('stream fetchTables — reshapes the same tid/row/col/t raw fields', () => {
  it('builds array-of-cells rows from the shared dwgtablecells payload', async () => {
    const results = [{
      name: 'Session', count: 3,
      items: [
        { id: '1', raw: { tid: 0, row: 0, col: 0, t: 'A' } },
        { id: '2', raw: { tid: 0, row: 0, col: 1, t: 'B' } },
        { id: '3', raw: { tid: 0, row: 1, col: 0, t: 'C' } },
      ],
    }];
    const streamed = await fetchTables(evalReturning({ symbol: 'X', data: { results, warnings: [] } }));
    assert.equal(streamed.studies[0].study, 'Session');
    assert.deepEqual(streamed.studies[0].tables, [{ rows: [['A', 'B'], ['C']] }]);
    // shapeStreamTables is pure and reads the same fields data.js's shapeTables uses.
    assert.deepEqual(shapeStreamTables(results), streamed.studies);
  });
});

describe('streamErrorAction — bounds EVERY error, terminates persistent non-transport', () => {
  it('transport (CDP) errors back off but never terminate', () => {
    const a = streamErrorAction('CDP connection failed', 25);
    assert.equal(a.transport, true);
    assert.equal(a.terminate, false, 'CDP may self-heal — keep retrying');
    assert.equal(a.escalate, true);
  });

  it('persistent non-transport error terminates after the threshold', () => {
    assert.equal(streamErrorAction('TypeError: x is undefined', 19).terminate, false);
    assert.equal(streamErrorAction('TypeError: x is undefined', 20).terminate, true);
  });

  it('a single non-transport error neither escalates nor terminates', () => {
    const a = streamErrorAction('TypeError', 1);
    assert.equal(a.escalate, false);
    assert.equal(a.terminate, false);
  });

  it('backoff grows exponentially and caps', () => {
    assert.equal(streamErrorAction('x', 1).delay, 1000);
    assert.equal(streamErrorAction('x', 2).delay, 2000);
    assert.equal(streamErrorAction('x', 3).delay, 4000);
    assert.equal(streamErrorAction('x', 100).delay, 30000, 'capped at ERROR_BACKOFF_CAP');
  });
});
