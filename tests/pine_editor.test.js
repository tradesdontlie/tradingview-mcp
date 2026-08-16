import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { FIND_MONACO } from '../src/core/pine.js';

function domNode({ visible }) {
  return {
    isConnected: true,
    offsetParent: visible ? {} : null,
    parentElement: null,
    getBoundingClientRect() {
      return visible ? { width: 500, height: 700 } : { width: 0, height: 0 };
    },
  };
}

function attachFiber(container, env) {
  const host = { parentElement: null };
  host.__reactFiber$test = {
    memoizedProps: {},
    return: {
      memoizedProps: { value: { monacoEnv: env } },
      return: null,
    },
  };
  container.parentElement = host;
}

describe('FIND_MONACO', () => {
  it('selects the visible editor when TradingView leaves a stale instance first', () => {
    const staleContainer = domNode({ visible: false });
    const activeContainer = domNode({ visible: true });
    const staleEditor = { getDomNode: () => staleContainer };
    const activeEditor = { getDomNode: () => activeContainer };
    const env = { editor: { getEditors: () => [staleEditor, activeEditor] } };
    attachFiber(activeContainer, env);

    const found = vm.runInNewContext(FIND_MONACO, {
      document: {
        querySelectorAll: () => [staleContainer, activeContainer],
      },
    });

    assert.equal(found.editor, activeEditor);
    assert.equal(found.env, env);
  });

  it('does not treat a hidden stale editor as ready', () => {
    const staleContainer = domNode({ visible: false });
    const staleEditor = { getDomNode: () => staleContainer };
    const env = { editor: { getEditors: () => [staleEditor] } };
    attachFiber(staleContainer, env);

    const found = vm.runInNewContext(FIND_MONACO, {
      document: {
        querySelectorAll: () => [staleContainer],
      },
    });

    assert.equal(found, null);
  });
});
