import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { compile, smartCompile, save, newScript, openScript, getDeclaredTitle, ensurePineEditorOpen } from '../src/core/pine.js';

function button({ text = '', title = '', path = '', className = '', visible = true } = {}) {
  let clicks = 0;
  return {
    textContent: text, className,
    getBoundingClientRect: () => ({ width: visible ? 20 : 0, height: visible ? 20 : 0 }),
    getAttribute: name => name === 'title' ? title : '',
    querySelector: () => path ? { getAttribute: () => path } : null,
    click: () => { clicks++; },
    get clicks() { return clicks; },
  };
}

function editorMock({ identity = { title: 'Existing', modelUri: 'model:old', source: 'indicator("Existing")' }, buttons = [], switchTo, unsaved = false, scripts = [{ scriptName: 'Target', scriptIdPart: 'target-id' }] } = {}) {
  let current = identity;
  let selected = false;
  let cancelClicks = 0;
  let keyCount = 0;
  const expressions = [];
  const evaluate = async expression => {
    expressions.push(expression);
    assert.ok(!expression.includes('.setValue('), 'new/open must never replace source in an existing model');
    if (expression.includes('return m !== null')) return true;
    if (expression.includes('modelUri:')) return current;
    if (expression.includes('findRunButton')) return vm.runInNewContext(expression, { document: { querySelectorAll: () => buttons } });
    if (expression.includes('var dontSave')) {
      if (!unsaved) return false;
      const cancel = { textContent: 'Cancel', click: () => { cancelClicks++; } };
      const dontSave = { getBoundingClientRect: () => ({ width: 20, height: 20 }), parentElement: { querySelectorAll: () => [cancel] } };
      return vm.runInNewContext(expression, { document: { querySelector: () => dontSave } });
    }
    if (expression.includes('var pattern =') || expression.includes('open-script-dialog-item-name')) {
      selected = true;
      if (switchTo && !unsaved) current = switchTo;
      return true;
    }
    if (expression.includes('var markers')) return [];
    if (expression.includes('getAllStudies')) return 1;
    if (expression.includes('var saveBtn')) return false;
    return true;
  };
  return {
    _deps: {
      evaluate,
      evaluateAsync: expression => vm.runInNewContext(expression, { fetch: async () => ({ json: async () => scripts }) }),
      getClient: async () => ({ Input: { dispatchKeyEvent: async () => { keyCount++; } } }),
      sleep: async () => {},
    },
    expressions,
    get cancelClicks() { return cancelClicks; },
    get keyCount() { return keyCount; },
    get current() { return current; },
    get selected() { return selected; },
  };
}

describe('Pine save and compile safety', () => {
  it('parses declaration titles without treating commented declarations as live', () => {
    assert.equal(getDeclaredTitle('// indicator("old")\nstrategy(title = "New", overlay=true)'), 'New');
    assert.equal(getDeclaredTitle('plot(close)'), null);
  });

  for (const operation of [compile, smartCompile, save]) {
    it(`${operation.name} refuses a saved-script/source title mismatch before clicking or saving`, async () => {
      const mocks = editorMock({ identity: { title: 'Original', modelUri: 'saved:1', source: 'indicator("Replacement")' } });
      await assert.rejects(operation({ _deps: mocks._deps }), /Refusing to save/);
      assert.equal(mocks.keyCount, 0);
    });
  }

  it('refuses a saved script whose declaration title cannot be established', async () => {
    const mocks = editorMock({ identity: { title: 'Original', modelUri: 'saved:1', source: 'plot(close)' } });
    await assert.rejects(save({ _deps: mocks._deps }), /refusing to save/);
    assert.equal(mocks.keyCount, 0);
  });

  it('does not exempt saved scripts merely because their name begins with Untitled', async () => {
    const mocks = editorMock({ identity: { title: 'Untitled important strategy', modelUri: 'saved:untitled', source: 'indicator("Replacement")' } });
    await assert.rejects(save({ _deps: mocks._deps }), /Refusing to save/);
    assert.equal(mocks.keyCount, 0);
  });

  for (const operation of [compile, smartCompile]) {
    it(`${operation.name} never clicks the Save button as a compile fallback`, async () => {
      const saveButton = button({ text: 'Save', className: 'saveButton-test' });
      const mocks = editorMock({ buttons: [saveButton] });
      await assert.rejects(operation({ _deps: mocks._deps }), /No Add\/Update-to-chart control/);
      assert.equal(saveButton.clicks, 0);
      assert.equal(mocks.keyCount, 0);
    });
  }

  it('recognizes a visible icon-only run button while ignoring hidden controls', async () => {
    const hidden = button({ title: 'Update on chart', visible: false });
    const run = button({ path: 'm10.82 6.82 icon path' });
    const mocks = editorMock({ buttons: [hidden, run] });
    const result = await compile({ _deps: mocks._deps });
    assert.equal(result.button_clicked, 'Add to chart (icon)');
    assert.equal(run.clicks, 1);
    assert.equal(hidden.clicks, 0);
  });

  it('permits an explicit intentional save despite a title mismatch', async () => {
    const mocks = editorMock({ identity: { title: 'Original', modelUri: 'saved:1', source: 'indicator("Renamed")' } });
    assert.equal((await save({ allowTitleMismatch: true, _deps: mocks._deps })).success, true);
    assert.equal(mocks.keyCount, 2);
  });

  it('refuses a global Save shortcut when the bound editor cannot be focused', async () => {
    const mocks = editorMock();
    const original = mocks._deps.evaluate;
    mocks._deps.evaluate = expression => expression.includes('m.editor.focus()') ? false : original(expression);
    await assert.rejects(save({ _deps: mocks._deps }), /Could not focus the bound Pine Editor/);
    assert.equal(mocks.keyCount, 0);
  });
});

describe('Pine new/open binding and unsaved source preservation', () => {
  it('newScript requires a fresh untitled model and never injects a template into the old model', async () => {
    const mocks = editorMock({ switchTo: { title: 'Untitled script', modelUri: 'model:new', source: 'indicator("My script")' } });
    const result = await newScript({ type: 'indicator', _deps: mocks._deps });
    assert.equal(result.success, true);
    assert.equal(mocks.current.modelUri, 'model:new');
    assert.equal(mocks.selected, true);
  });

  it('newScript refuses success if the model remains bound to the existing script', async () => {
    const mocks = editorMock();
    await assert.rejects(newScript({ type: 'indicator', _deps: mocks._deps }), /Could not verify/);
    assert.equal(mocks.current.title, 'Existing');
  });

  for (const operation of ['new', 'open']) {
    it(`${operation} cancels an unsaved prompt without saving or discarding source`, async () => {
      const mocks = editorMock({ unsaved: true });
      const result = operation === 'new' ? newScript({ type: 'indicator', _deps: mocks._deps }) : openScript({ name: 'Target', _deps: mocks._deps });
      await assert.rejects(result, /unsaved changes/);
      assert.equal(mocks.cancelClicks, 1);
      assert.equal(mocks.current.title, 'Existing');
      assert.equal(mocks.keyCount, 0);
    });
  }

  it('openScript verifies both the selected title and changed Monaco model', async () => {
    const mocks = editorMock({ switchTo: { title: 'Target', modelUri: 'model:target', source: 'indicator("Target")' } });
    const result = await openScript({ name: 'Target', _deps: mocks._deps });
    assert.equal(result.opened, true);
    assert.equal(result.script_id, 'target-id');
  });

  it('openScript rejects a changed title with the old bound model', async () => {
    const mocks = editorMock({ switchTo: { title: 'Target', modelUri: 'model:old', source: 'indicator("Existing")' } });
    await assert.rejects(openScript({ name: 'Target', _deps: mocks._deps }), /Could not verify/);
  });

  it('openScript rejects ambiguous matches before opening any editor menu', async () => {
    const mocks = editorMock({ scripts: [{ scriptName: 'Target one' }, { scriptName: 'Target two' }] });
    await assert.rejects(openScript({ name: 'Target', _deps: mocks._deps }), /Ambiguous script name/);
    assert.equal(mocks.expressions.length, 0);
  });

  it('finds the editor bound to the visible container rather than the first hidden Monaco instance', async () => {
    const hidden = { getDomNode: () => ({ contains: () => false }) };
    const container = { getBoundingClientRect: () => ({ width: 100, height: 100 }), contains: () => false };
    const active = { getDomNode: () => container };
    container.__reactFiber$test = { memoizedProps: { value: { monacoEnv: { editor: { getEditors: () => [hidden, active] } } } } };
    const evaluate = expression => vm.runInNewContext(expression, { document: { querySelectorAll: () => [container] } });
    assert.equal(await ensurePineEditorOpen({ _deps: { evaluate } }), true);
  });
});
