/**
 * Tests for findChartTarget() in src/connection.js.
 * Covers TV_CDP_TARGET_URL pinning: selecting a specific tab regardless of
 * /json/list ordering, the unpinned first-match default, and the loud failure
 * when a pin matches nothing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findChartTarget } from '../src/connection.js';

const CHART_A = { id: 'AAA', type: 'page', url: 'https://www.tradingview.com/chart/ZVB7EuWT/' };
const CHART_B = { id: 'BBB', type: 'page', url: 'https://www.tradingview.com/chart/qJPHO5Xx/' };
const SCREENER = { id: 'CCC', type: 'page', url: 'https://www.tradingview.com/screener/rWQKS4lz/' };
const SHELL = { id: 'DDD', type: 'page', url: 'file:///Applications/TradingView.app/shell.html' };
const WORKER = { id: 'EEE', type: 'service_worker', url: 'https://www.tradingview.com/chart/qJPHO5Xx/sw.js' };

/** Build a _deps bundle whose fetch returns the given /json/list payload. */
function deps(targets, targetUrl) {
  return { fetch: async () => ({ json: async () => targets }), targetUrl };
}

describe('findChartTarget() — pinned by TV_CDP_TARGET_URL', () => {
  it('selects the pinned tab even when another chart is listed first', async () => {
    const t = await findChartTarget({ _deps: deps([SHELL, CHART_A, CHART_B], '/chart/qJPHO5Xx/') });
    assert.equal(t.id, 'BBB');
  });

  it('selects the other chart under the other pin, from the same list', async () => {
    const t = await findChartTarget({ _deps: deps([SHELL, CHART_A, CHART_B], '/chart/ZVB7EuWT/') });
    assert.equal(t.id, 'AAA');
  });

  it('throws and names the open TradingView tabs when the pin matches nothing', async () => {
    await assert.rejects(
      () => findChartTarget({ _deps: deps([SHELL, CHART_A], '/chart/MISSING1/') }),
      (err) => {
        assert.match(err.message, /TV_CDP_TARGET_URL="\/chart\/MISSING1\/" matched no open tab/);
        assert.match(err.message, /ZVB7EuWT/);          // lists what IS open
        assert.doesNotMatch(err.message, /shell\.html/); // non-TradingView pages excluded
        return true;
      }
    );
  });

  it('does not silently fall back to first-match when pinned', async () => {
    await assert.rejects(() => findChartTarget({ _deps: deps([CHART_A, CHART_B], '/chart/NOPE/') }));
  });

  it('ignores non-page targets when matching a pin', async () => {
    await assert.rejects(() => findChartTarget({ _deps: deps([WORKER], '/chart/qJPHO5Xx/') }));
  });
});

describe('findChartTarget() — unpinned (existing behaviour)', () => {
  it('returns the first tradingview.com/chart page', async () => {
    const t = await findChartTarget({ _deps: deps([SHELL, CHART_A, CHART_B], null) });
    assert.equal(t.id, 'AAA');
  });

  it('falls back to any tradingview page when no chart is open', async () => {
    const t = await findChartTarget({ _deps: deps([SHELL, SCREENER], null) });
    assert.equal(t.id, 'CCC');
  });

  it('returns null when nothing matches', async () => {
    assert.equal(await findChartTarget({ _deps: deps([SHELL], null) }), null);
  });
});
