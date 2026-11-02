import { it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { getIndicatorStyle, setIndicatorStyle, validateStyleOverrides } from '../src/core/indicator-styles.js';

function mockStudy({ ignore = [], throwOnce = false, failRollback = false } = {}) {
  const style = { styles: { plot: { color: '#aabbcc', visible: true, linewidth: 1, display: 4294967295 } }, palettes: { volume: { colors: { 0: { color: '#123456', width: 1 } } } } };
  const original = structuredClone(style);
  let writes = 0;
  const applyOverrides = overrides => {
    writes++;
    if (failRollback && writes > 1) throw new Error('Rollback unsupported');
    for (const [path, value] of Object.entries(overrides)) {
      if (ignore.includes(path) && writes === 1) continue;
      const keys = path.split('.');
      let current = style;
      for (const key of keys.slice(0, -1)) current = current[key];
      current[keys.at(-1)] = value;
    }
    if (throwOnce && writes === 1) throw new Error('Partial write error');
  };
  const study = { getStyleValues: () => style, applyOverrides };
  const sandbox = { window: { TradingViewApi: { _activeChartWidgetWV: { value: () => ({ getStudyById: id => id === 'exact' ? study : null }) } } } };
  return { style, original, get writes() { return writes; }, _deps: { evaluate: async expression => vm.runInNewContext(expression, sandbox) } };
}

it('reads exact current study style and rejects missing entity IDs', async () => {
  const mock = mockStudy();
  const result = await getIndicatorStyle({ entity_id: 'exact', _deps: mock._deps });
  assert.deepEqual(JSON.parse(JSON.stringify(result.style)), mock.original);
  await assert.rejects(getIndicatorStyle({ entity_id: 'missing', _deps: mock._deps }), /unavailable/);
});

it('writes only requested allowed leaves and verifies every value while preserving unrelated fields', async () => {
  const mock = mockStudy();
  const result = await setIndicatorStyle({ entity_id: 'exact', overrides: { 'styles.plot.color': '#ffffff', 'styles.plot.linewidth': 3 }, _deps: mock._deps });
  assert.equal(result.success, true);
  assert.equal(mock.style.styles.plot.visible, true);
  assert.equal(mock.style.palettes.volume.colors[0].color, '#123456');
  assert.equal(mock.writes, 1);
});

it('supports palette colors and the native uint32 display bitmask', async () => {
  const mock = mockStudy();
  const result = await setIndicatorStyle({ entity_id: 'exact', overrides: { 'palettes.volume.colors.0.color': '#123', 'styles.plot.display': 4294967295 }, _deps: mock._deps });
  assert.equal(result.success, true);
});

it('rejects malformed colors, prototype paths and invalid widths before evaluating', async () => {
  for (const input of [{ 'styles.plot.color': '#abcde' }, { 'styles.plot.color': '#abcd' }, { 'styles.plot.linewidth': 100 }, { 'styles.__proto__.color': '#fff' }, { 'inputs.length': 1 }]) {
    assert.throws(() => validateStyleOverrides(input), /Invalid|Unsupported|integer/);
  }
  assert.deepEqual(validateStyleOverrides({ 'styles.plot.color': '#aabbccff' }), { 'styles.plot.color': '#aabbccff' });
});

it('checks all target paths before applying any requested property', async () => {
  const mock = mockStudy();
  await assert.rejects(setIndicatorStyle({ entity_id: 'exact', overrides: { 'styles.plot.color': '#fff', 'styles.unknown.color': '#fff' }, _deps: mock._deps }), /Unknown style property/);
  assert.equal(mock.writes, 0);
});

it('reports failed verification and proves rollback after a partial write', async () => {
  const mock = mockStudy({ ignore: ['styles.plot.linewidth'] });
  const result = await setIndicatorStyle({ entity_id: 'exact', overrides: { 'styles.plot.color': '#fff', 'styles.plot.linewidth': 2 }, _deps: mock._deps });
  assert.equal(result.success, false);
  assert.equal(result.rollback_verified, true);
  assert.deepEqual(mock.style, mock.original);
});

it('rereads after an API exception and exposes failed rollback instead of claiming success', async () => {
  const mock = mockStudy({ throwOnce: true, failRollback: true });
  const result = await setIndicatorStyle({ entity_id: 'exact', overrides: { 'styles.plot.color': '#fff' }, _deps: mock._deps });
  assert.equal(result.success, false);
  assert.equal(result.rollback_verified, false);
  assert.match(result.rollback_error, /Rollback unsupported/);
});
