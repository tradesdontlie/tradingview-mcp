// Ring buffer unit tests — offline, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RingBuffer } from '../src/core/streaming/ring.js';

test('RingBuffer.push appends in order', () => {
  const r = new RingBuffer(4);
  r.push({ v: 1 }); r.push({ v: 2 }); r.push({ v: 3 });
  assert.deepEqual(r.recent(10).map(x => x.v), [1, 2, 3]);
  assert.equal(r.size(), 3);
});

test('RingBuffer overflows drop oldest', () => {
  const r = new RingBuffer(3);
  for (let i = 1; i <= 5; i++) r.push({ v: i });
  assert.deepEqual(r.recent(10).map(x => x.v), [3, 4, 5]);
  assert.equal(r.size(), 3);
});

test('RingBuffer.latest returns last pushed or null', () => {
  const r = new RingBuffer(2);
  assert.equal(r.latest(), null);
  r.push({ v: 'a' });
  assert.equal(r.latest().v, 'a');
  r.push({ v: 'b' });
  assert.equal(r.latest().v, 'b');
});

test('RingBuffer.recent caps at requested n', () => {
  const r = new RingBuffer(10);
  [1, 2, 3, 4, 5].forEach(v => r.push({ v }));
  assert.deepEqual(r.recent(2).map(x => x.v), [4, 5]);
  assert.deepEqual(r.recent(0).map(x => x.v), [5]); // n<1 clamps to 1
});

test('RingBuffer.clear empties', () => {
  const r = new RingBuffer(3);
  r.push({ v: 1 });
  r.clear();
  assert.equal(r.size(), 0);
  assert.equal(r.latest(), null);
});
