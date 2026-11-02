import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getQuote } from '../src/core/data.js';

const activeQuote = {
  symbol: 'INDEX:BTCUSD',
  close: 63261.89,
  last: 63261.89,
  exchange: 'INDEX',
};

const deps = { evaluate: async () => ({ ...activeQuote }) };

describe('quote_get symbol identity', () => {
  it('uses the active SOURCE:TICKER when symbol is omitted', async () => {
    const result = await getQuote({ _deps: deps });
    assert.equal(result.symbol, 'INDEX:BTCUSD');
    assert.equal(result.last, 63261.89);
  });

  it('accepts an exact active SOURCE:TICKER case-insensitively', async () => {
    const result = await getQuote({ symbol: 'index:btcusd', _deps: deps });
    assert.equal(result.symbol, 'INDEX:BTCUSD');
  });

  it('rejects an unqualified ticker', async () => {
    await assert.rejects(
      getQuote({ symbol: 'BTCUSD', _deps: deps }),
      /must use SOURCE:TICKER/,
    );
  });

  it('never relabels the active quote as a different symbol', async () => {
    await assert.rejects(
      getQuote({ symbol: 'TVC:GOLD', _deps: deps }),
      /is not the active chart symbol "INDEX:BTCUSD"/,
    );
  });
});
