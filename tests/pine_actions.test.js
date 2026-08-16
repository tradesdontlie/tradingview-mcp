import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  FIND_PINE_ACTION_BUTTON,
  FIND_SAVE_BEFORE_ADD_BUTTON,
  READ_PINE_CONSOLE,
  READ_PINE_STUDY_LOGS,
} from '../src/core/pine.js';

function element({ text = '', attributes = {}, visible = true, className = '', cells = [] } = {}) {
  return {
    textContent: text,
    className,
    isConnected: true,
    offsetParent: visible ? {} : null,
    clicked: false,
    getAttribute(name) { return attributes[name] ?? null; },
    getBoundingClientRect() { return { width: visible ? 34 : 0, height: visible ? 34 : 0 }; },
    click() { this.clicked = true; },
    querySelectorAll(selector) {
      if (selector === 'td') return cells;
      return [];
    },
  };
}

test('Pine action finder selects a visible icon-only Add to chart button', () => {
  const hiddenAdd = element({ attributes: { title: 'Add to chart' }, visible: false });
  const save = element({ className: 'saveButton-abc', attributes: { title: 'Save' } });
  const add = element({ attributes: { title: 'Add to chart' } });
  const context = { document: { querySelectorAll: () => [hiddenAdd, save, add] } };

  const match = vm.runInNewContext(FIND_PINE_ACTION_BUTTON, context);

  assert.equal(match.action, 'Add to chart');
  assert.equal(match.button, add);
});

test('Pine action finder never treats the save icon as a compile control', () => {
  const save = element({ className: 'saveButton-abc', attributes: { title: 'Save' } });
  const context = { document: { querySelectorAll: () => [save] } };

  assert.equal(vm.runInNewContext(FIND_PINE_ACTION_BUTTON, context), null);
});

test('save-before-add finder selects only the affirmative button in the explicit confirmation', () => {
  const yes = element({ text: 'Save', attributes: { 'data-qa-id': 'yes-btn' } });
  const dialog = element({ text: 'Save this script before adding? Script with unsaved changes cannot be added.' });
  dialog.querySelector = () => yes;
  const context = { document: { querySelectorAll: () => [dialog] } };

  assert.equal(vm.runInNewContext(FIND_SAVE_BEFORE_ADD_BUTTON, context), yes);
});

test('save-before-add finder ignores unrelated save dialogs', () => {
  const save = element({ text: 'Save' });
  const dialog = element({ text: 'Save chart layout' });
  dialog.querySelector = () => save;
  const context = { document: { querySelectorAll: () => [dialog] } };

  assert.equal(vm.runInNewContext(FIND_SAVE_BEFORE_ADD_BUTTON, context), null);
});

test('Pine console reader returns only rows from the visible console table', () => {
  const time = element({ text: '12:34:56 AM', className: 'time-abc' });
  const log = element({ text: 'MCP_LOG_SMOKE|123.45' });
  const row = element({ cells: [time, log] });
  const wrapper = element({ className: 'consoleWrapper-abc consoleWrapperOpen-abc' });
  wrapper.querySelectorAll = (selector) => selector === 'table[class*="messages"] tbody tr' ? [row] : [];
  const context = { document: { querySelectorAll: () => [wrapper] } };

  const result = vm.runInNewContext(READ_PINE_CONSOLE, context);

  assert.equal(result.available, true);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].timestamp, '12:34:56 AM');
  assert.equal(result.entries[0].message, 'MCP_LOG_SMOKE|123.45');
});

test('Pine console reader does not fall back to editor or dialog text', () => {
  const context = { document: { querySelectorAll: () => [] } };

  const result = vm.runInNewContext(READ_PINE_CONSOLE, context);

  assert.equal(result.available, false);
  assert.equal(result.entries.length, 0);
});

test('Pine study log reader returns structured logs for the compiled study', () => {
  const source = {
    id: () => 'study-1',
    title: () => 'MCP smoke',
    logLevelMask: () => ({ error: true, warning: true, info: true }),
    logs: () => ({
      values: () => [{
        barTime: 1700000000000,
        time: 1700000000000,
        level: 4,
        message: 'MCP_LOG_SMOKE|123.45',
        source: { start: { line: 4, column: 5 } },
      }],
    }),
  };
  const context = {
    window: {
      TradingViewApi: {
        _activeChartWidgetWV: {
          value: () => ({
            _chartWidget: { model: () => ({ model: () => ({ dataSources: () => [source] }) }) },
          }),
        },
      },
    },
  };

  const result = vm.runInNewContext(`${READ_PINE_STUDY_LOGS}(['study-1'])`, context);

  assert.equal(result.available, true);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].message, 'MCP_LOG_SMOKE|123.45');
  assert.equal(result.entries[0].study_id, 'study-1');
  assert.equal(result.entries[0].source, 'pine_logs');
});

test('Pine study log reader ignores unselected studies with logging disabled', () => {
  const source = {
    id: () => 'other-study',
    logLevelMask: () => ({ error: false, warning: false, info: false }),
    logs: () => ({ values: () => [{ message: 'must not leak' }] }),
  };
  const context = {
    window: {
      TradingViewApi: {
        _activeChartWidgetWV: {
          value: () => ({
            _chartWidget: { model: () => ({ model: () => ({ dataSources: () => [source] }) }) },
          }),
        },
      },
    },
  };

  const result = vm.runInNewContext(`${READ_PINE_STUDY_LOGS}(['study-1'])`, context);

  assert.equal(result.available, false);
  assert.equal(result.entries.length, 0);
});
