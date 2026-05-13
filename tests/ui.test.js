/**
 * Tests for src/core/ui.js — focused on bug fixes B6, B8, B10:
 *   B6  — Strategy Tester detection must match `reportContainer-*` (TV 3.1.0.7818).
 *   B8  — Fragile selectors centralized in a SELECTORS map with fallbacks.
 *   B10 — Strategy-tester openness is computed independently of the bottom panel.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectStrategyTester, openPanel, SELECTORS } from '../src/core/ui.js';

// ── Mock helpers (mirror tests/replay.test.js pattern) ───────────────────

/**
 * Create a mock evaluate function. `respond(expr) -> value` controls returns.
 * All call expressions are recorded on .calls.
 */
function mockEvaluate(respond) {
  const calls = [];
  const fn = async (expr) => {
    calls.push(expr);
    return typeof respond === 'function' ? respond(expr) : respond;
  };
  fn.calls = calls;
  return fn;
}

// ── SELECTORS map (B8) ───────────────────────────────────────────────────

describe('SELECTORS map (B8)', () => {
  it('exposes strategyTesterPanel with reportContainer fallback', () => {
    assert.ok(Array.isArray(SELECTORS.strategyTesterPanel));
    const joined = SELECTORS.strategyTesterPanel.join(' ');
    assert.ok(joined.includes('reportContainer'), 'must include reportContainer matcher (B6)');
    assert.ok(joined.includes('[class*="'), 'uses attribute-substring matcher');
  });

  it('includes legacy fallbacks for older TV builds', () => {
    const joined = SELECTORS.strategyTesterPanel.join(' ');
    assert.ok(joined.includes('backtesting') || joined.includes('strategyReport'),
      'retains legacy selectors as fallbacks');
  });

  it('exposes tab labels used as secondary detection signal', () => {
    assert.ok(SELECTORS.strategyTesterTabLabels.includes('Metrics'));
    assert.ok(SELECTORS.strategyTesterTabLabels.includes('List of trades'));
    assert.ok(SELECTORS.strategyTesterTabLabels.includes('Performance'));
  });
});

// ── detectStrategyTester() (B6) ──────────────────────────────────────────

describe('detectStrategyTester() (B6)', () => {
  it('returns open=true when evaluate reports a visible reportContainer', async () => {
    const evaluate = mockEvaluate({
      open: true,
      signals: ['panel:[class*="reportContainer"]'],
      tried: { panels: SELECTORS.strategyTesterPanel, tabs: SELECTORS.strategyTesterTabLabels },
    });
    const result = await detectStrategyTester({ _deps: { evaluate } });
    assert.equal(result.open, true);
    assert.ok(result.signals[0].startsWith('panel:'));
  });

  it('returns open=true when only a Metrics tab is visible (no container match)', async () => {
    const evaluate = mockEvaluate({
      open: true,
      signals: ['tab:Metrics'],
      tried: { panels: SELECTORS.strategyTesterPanel, tabs: SELECTORS.strategyTesterTabLabels },
    });
    const result = await detectStrategyTester({ _deps: { evaluate } });
    assert.equal(result.open, true);
    assert.equal(result.signals[0], 'tab:Metrics');
  });

  it('returns open=false when no signals fire and logs what was tried', async () => {
    const evaluate = mockEvaluate({
      open: false,
      signals: [],
      tried: { panels: SELECTORS.strategyTesterPanel, tabs: SELECTORS.strategyTesterTabLabels },
    });
    const result = await detectStrategyTester({ _deps: { evaluate } });
    assert.equal(result.open, false);
    assert.deepEqual(result.signals, []);
    assert.ok(result.tried.panels.length > 0, 'reports the panel selectors it attempted');
    assert.ok(result.tried.tabs.includes('Metrics'), 'reports the tab labels it attempted');
  });

  it('emits an IIFE that queries every selector in SELECTORS.strategyTesterPanel', async () => {
    const evaluate = mockEvaluate({ open: false, signals: [], tried: { panels: [], tabs: [] } });
    await detectStrategyTester({ _deps: { evaluate } });
    const expr = evaluate.calls[0];
    for (const sel of SELECTORS.strategyTesterPanel) {
      assert.ok(expr.includes(JSON.stringify(sel)), `IIFE must reference selector ${sel}`);
    }
    for (const tab of SELECTORS.strategyTesterTabLabels) {
      assert.ok(expr.includes(JSON.stringify(tab)), `IIFE must reference tab label ${tab}`);
    }
  });

  it('survives a null result from evaluate (defensive default)', async () => {
    const evaluate = mockEvaluate(null);
    const result = await detectStrategyTester({ _deps: { evaluate } });
    assert.equal(result.open, false);
    assert.deepEqual(result.signals, []);
  });
});

// ── openPanel() strategy-tester branch (B6 + B10) ────────────────────────

describe('openPanel({ panel: "strategy-tester" }) (B6 + B10)', () => {
  it('IIFE no longer ANDs strategy-tester openness with bottom-area open state (B10)', async () => {
    const evaluate = mockEvaluate({ was_open: false, performed: 'none', signals: [] });
    await openPanel({ panel: 'strategy-tester', action: 'toggle', _deps: { evaluate } });
    const expr = evaluate.calls[0];
    // The strategy-tester branch must NOT compute `isOpen = isOpen && stratPanel` style.
    // Specifically: in the strategy-tester branch, `bottomOpen` must not appear in the
    // assignment that sets isOpen.
    const stratBranch = expr.slice(expr.indexOf('else {'));
    assert.ok(!/isOpen\s*=\s*bottomOpen/.test(stratBranch),
      'strategy-tester openness must not be gated on bottomOpen (B10)');
    assert.ok(!/isOpen\s*&&\s*bottomOpen/.test(stratBranch),
      'strategy-tester openness must not be ANDed with bottomOpen (B10)');
  });

  it('IIFE references reportContainer selector (B6)', async () => {
    const evaluate = mockEvaluate({ was_open: false, performed: 'none', signals: [] });
    await openPanel({ panel: 'strategy-tester', action: 'toggle', _deps: { evaluate } });
    const expr = evaluate.calls[0];
    assert.ok(expr.includes('reportContainer'),
      'IIFE must look for [class*="reportContainer"] (B6)');
  });

  it('IIFE references tab-label fallback (Metrics / List of trades)', async () => {
    const evaluate = mockEvaluate({ was_open: false, performed: 'none', signals: [] });
    await openPanel({ panel: 'strategy-tester', action: 'toggle', _deps: { evaluate } });
    const expr = evaluate.calls[0];
    assert.ok(expr.includes('Metrics'), 'tab fallback: Metrics');
    assert.ok(expr.includes('List of trades'), 'tab fallback: List of trades');
  });

  it('forwards was_open=true when evaluate reports it (decoupled from bottom_panel)', async () => {
    const evaluate = mockEvaluate({ was_open: true, performed: 'closed', signals: ['panel:[class*="reportContainer"]'] });
    const r = await openPanel({ panel: 'strategy-tester', action: 'toggle', _deps: { evaluate } });
    assert.equal(r.was_open, true);
    assert.equal(r.performed, 'closed');
    assert.ok(Array.isArray(r.signals));
  });

  it('forwards was_open=false when no strategy-tester signals fire', async () => {
    const evaluate = mockEvaluate({ was_open: false, performed: 'opened', signals: [] });
    const r = await openPanel({ panel: 'strategy-tester', action: 'open', _deps: { evaluate } });
    assert.equal(r.was_open, false);
    assert.equal(r.performed, 'opened');
  });

  it('throws when bottomWidgetBar is unavailable', async () => {
    const evaluate = mockEvaluate({ error: 'bottomWidgetBar not available' });
    await assert.rejects(
      () => openPanel({ panel: 'strategy-tester', action: 'open', _deps: { evaluate } }),
      (err) => err.message.includes('bottomWidgetBar not available'),
    );
  });
});

// ── pine-editor branch — keep bottom-area gating (regression guard) ──────

describe('openPanel({ panel: "pine-editor" }) — unchanged gating', () => {
  it('still gates pine-editor openness on bottomOpen AND monaco visibility', async () => {
    const evaluate = mockEvaluate({ was_open: true, performed: 'none' });
    await openPanel({ panel: 'pine-editor', action: 'toggle', _deps: { evaluate } });
    const expr = evaluate.calls[0];
    // pine-editor branch: bottomOpen && !!monacoEl is correct behaviour.
    assert.ok(expr.includes('bottomOpen && !!monacoEl'),
      'pine-editor branch retains bottomOpen gate');
  });
});
