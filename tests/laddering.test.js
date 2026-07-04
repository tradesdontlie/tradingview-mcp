/**
 * Tests for price-ladder order construction in core/laddering.js — pure
 * functions over plain numbers, validated against the curriculum's exact
 * worked example (Chapter 1, 1.9.2): "$10k... 5 different buy orders, each
 * valued at $2k, across a price range of $25k to $26k".
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildLadderOrders } from '../src/core/laddering.js';

describe('buildLadderOrders()', () => {
  it('reproduces the curriculum\'s worked example exactly: 5 x $2k orders at $250 spacing across $25k-$26k', () => {
    const { side, orders, sizePerOrder, averagePrice } = buildLadderOrders({ side: 'buy', totalSize: 10000, priceLow: 25000, priceHigh: 26000, numOrders: 5 });
    assert.equal(side, 'buy');
    assert.equal(sizePerOrder, 2000);
    assert.deepEqual(orders.map(o => o.price), [25000, 25250, 25500, 25750, 26000]);
    assert.ok(orders.every(o => o.size === 2000));
    assert.equal(averagePrice, 25500);
  });

  it('reproduces the second worked example: 3 equal slices across the dotted-line levels', () => {
    const { orders, sizePerOrder } = buildLadderOrders({ side: 'buy', totalSize: 9000, priceLow: 100, priceHigh: 120, numOrders: 3 });
    assert.deepEqual(orders.map(o => o.price), [100, 110, 120]);
    assert.equal(sizePerOrder, 3000);
  });

  it('lowercases and normalizes the side', () => {
    const { side } = buildLadderOrders({ side: 'SELL', totalSize: 100, priceLow: 10, priceHigh: 20, numOrders: 2 });
    assert.equal(side, 'sell');
  });

  it('rejects an unknown side', () => {
    assert.throws(() => buildLadderOrders({ side: 'short', totalSize: 100, priceLow: 10, priceHigh: 20, numOrders: 2 }));
  });

  it('rejects a non-positive size or price, and an inverted/zero-width range', () => {
    assert.throws(() => buildLadderOrders({ side: 'buy', totalSize: 0, priceLow: 10, priceHigh: 20, numOrders: 2 }));
    assert.throws(() => buildLadderOrders({ side: 'buy', totalSize: 100, priceLow: -5, priceHigh: 20, numOrders: 2 }));
    assert.throws(() => buildLadderOrders({ side: 'buy', totalSize: 100, priceLow: 20, priceHigh: 20, numOrders: 2 }));
    assert.throws(() => buildLadderOrders({ side: 'buy', totalSize: 100, priceLow: 30, priceHigh: 20, numOrders: 2 }));
  });

  it('rejects fewer than 2 orders — "multiple buy or sell orders" is the whole premise', () => {
    assert.throws(() => buildLadderOrders({ side: 'buy', totalSize: 100, priceLow: 10, priceHigh: 20, numOrders: 1 }));
    assert.throws(() => buildLadderOrders({ side: 'buy', totalSize: 100, priceLow: 10, priceHigh: 20, numOrders: 1.5 }));
  });
});
