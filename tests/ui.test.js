import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mouseButtonMask, mouseClick } from '../src/core/ui.js';

describe('mouse button masks', () => {
  it('uses CDP bit masks for each button', () => {
    assert.equal(mouseButtonMask('left'), 1);
    assert.equal(mouseButtonMask('right'), 2);
    assert.equal(mouseButtonMask('middle'), 4);
  });
});

describe('mouseClick()', () => {
  it('sends the left-button bit when pressing', async () => {
    const events = [];
    const client = { Input: { dispatchMouseEvent: async (event) => events.push(event) } };
    const result = await mouseClick({ x: 10, y: 20, _deps: { getClient: async () => client } });
    assert.equal(result.success, true);
    assert.equal(events[1].type, 'mousePressed');
    assert.equal(events[1].button, 'left');
    assert.equal(events[1].buttons, 1);
  });
});
