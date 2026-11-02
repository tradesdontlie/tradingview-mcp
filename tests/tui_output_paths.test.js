import { it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runTui } from '../src/admin/tui.js';

function harness(t, native = false, saveFailure = false) {
  const keys = ['MCP_SCREENSHOT_DIR', 'MCP_PERM_MODE', 'MCP_AUDIT_LOG'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.MCP_PERM_MODE = 'read'; process.env.MCP_AUDIT_LOG = 'false';
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const stdin = native ? new PassThrough() : new EventEmitter();
  if (!native) stdin.pause = () => {};
  let screen = ''; const saves = []; const quits = [];
  runTui({ stdin, stdout: { rows: 30, columns: 130, write: value => { screen += value; } },
    onQuit: code => { quits.push(code); }, saveSettings: values => { if (saveFailure) throw new Error('mock access denied'); saves.push(values); } });
  const key = (name, str = '') => stdin.emit('keypress', str, { name });
  return { stdin, key, saves, quits, get screen() { return screen; } };
}

it('edits the screenshot folder without interpreting text hotkeys, then saves beside unchanged permissions/audit', t => {
  const h = harness(t);
  h.key('f', 'f'); h.key('return', '\r');
  for (const letter of 'C:\\screens wrcqsl #ä') h.key(letter.toLowerCase(), letter);
  h.key('return', '\r'); h.key('s', 's');
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].MCP_SCREENSHOT_DIR, '"C:\\screens wrcqsl #ä"');
  assert.equal(h.saves[0].MCP_PERM_MODE, 'read');
  assert.equal(h.saves[0].MCP_AUDIT_LOG, 'false');
  assert.equal(h.quits.length, 0);
  h.key('q', 'q'); assert.deepEqual(h.quits, [0]);
});

it('Escape cancels a draft and empty accepted paths reset defaults', t => {
  const h = harness(t); h.key('f', 'f'); h.key('return'); h.key(undefined, 'discard this'); h.key('escape');
  h.key('return'); h.key('return'); h.key('s', 's');
  assert.equal(h.saves[0].MCP_SCREENSHOT_DIR, '');
  assert.equal(h.saves[0].MCP_SCREENSHOT_DIR, '');
  h.key('escape'); h.key('q'); assert.deepEqual(h.quits, [0]);
});

it('supports cursor editing, backspace/delete and unsaved quit without implicit saves', t => {
  const h = harness(t); h.key('f'); h.key('return'); h.key(undefined, 'abc'); h.key('home'); h.key('delete');
  h.key('end'); h.key('backspace'); h.key(undefined, 'z'); h.key('return');
  assert.match(h.screen, /Screenshots: bz/);
  h.key('q'); assert.equal(h.quits.length, 0); assert.equal(h.saves.length, 0);
  h.key('q'); assert.deepEqual(h.quits, [0]); assert.equal(h.saves.length, 0);
});

it('shows invalid paths and failed saves without leaving the application or clearing dirty state', t => {
  const h = harness(t, false, true); h.key('f'); h.key('return'); h.key(undefined, 'C:ambiguous'); h.key('return');
  assert.match(h.screen, /full drive path/); assert.equal(h.saves.length, 0);
  h.key('escape'); h.key('return'); h.key(undefined, 'valid folder'); h.key('return'); h.key('s');
  assert.match(h.screen, /Save failed: mock access denied/);
  h.key('q'); assert.equal(h.quits.length, 0); h.key('q'); assert.deepEqual(h.quits, [0]);
});

it('buffers real terminal bracketed paste and rejects newline/control content without running hotkeys', t => {
  const h = harness(t, true);
  h.stdin.write('f\r');
  h.stdin.write('\x1b[200~C:\\foo\r\nwsq\x03\x1b[201~');
  assert.match(h.screen, /Paste rejected/);
  assert.equal(h.saves.length, 0); assert.equal(h.quits.length, 0);
  h.stdin.write('\x1b[200~C:\\Fotos ä # O\'Brien\\\x1b[201~');
  h.stdin.write('\rs');
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].MCP_SCREENSHOT_DIR, '"C:\\Fotos ä # O\'Brien\\"');
  assert.equal(h.saves[0].MCP_PERM_MODE, 'read'); assert.equal(h.saves[0].MCP_AUDIT_LOG, 'false');
  h.stdin.write('q'); assert.deepEqual(h.quits, [0]);
});

it('does not execute a bracketed paste as global permission, logging, save or quit shortcuts', t => {
  const h = harness(t, true);
  h.stdin.write('\x1b[200~wlsq\x1b[201~');
  assert.equal(h.saves.length, 0); assert.equal(h.quits.length, 0);
  h.stdin.write('s');
  assert.equal(h.saves[0].MCP_PERM_MODE, 'read');
  assert.equal(h.saves[0].MCP_AUDIT_LOG, 'false');
  h.stdin.write('q');
});

it('rejects an oversized bracketed paste as a whole and keeps the editor active', t => {
  const h = harness(t, true); h.stdin.write('f\r');
  h.stdin.write('\x1b[200~' + 'w'.repeat(5000) + '\rsq\x1b[201~');
  assert.match(h.screen, /Paste rejected/);
  assert.equal(h.saves.length, 0); assert.equal(h.quits.length, 0);
  h.stdin.write('\rs');
  assert.equal(h.saves[0].MCP_SCREENSHOT_DIR, '');
  assert.equal(h.saves[0].MCP_PERM_MODE, 'read');
  h.stdin.write('q');
});
