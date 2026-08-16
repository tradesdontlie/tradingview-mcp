import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { FIND_PINE_ACTION_BUTTON, READ_PINE_CONSOLE } from '../src/core/pine.js';

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
