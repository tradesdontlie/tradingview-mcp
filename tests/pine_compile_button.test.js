/**
 * Unit tests for the Pine-editor compile/add-to-chart button classifier.
 * No TradingView connection needed.
 *
 * Regression: the old finder matched ONLY English button textContent
 * (/^(Add to chart|Update on chart)/), so on a Korean UI — where the button is
 * icon-only with title="차트에 넣기" and empty textContent — it fell through to
 * the Save button, and pine_smart_compile never added the script to the chart.
 *
 * Run: node --test tests/pine_compile_button.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPineButton } from '../src/core/pine.js';

describe('classifyPineButton()', () => {
  it('classifies English "Add to chart" by textContent', () => {
    assert.equal(classifyPineButton({ text: 'Add to chart' }), 'add-or-update');
  });

  it('classifies English "Update on chart" by textContent', () => {
    assert.equal(classifyPineButton({ text: 'Update on chart' }), 'add-or-update');
  });

  it('classifies Korean "차트에 넣기" by title when textContent is empty (icon button)', () => {
    assert.equal(classifyPineButton({ text: '', title: '차트에 넣기' }), 'add-or-update');
  });

  it('classifies Korean "차트에서 업데이트" (update on chart) by title', () => {
    assert.equal(classifyPineButton({ text: '', title: '차트에서 업데이트' }), 'add-or-update');
  });

  it('classifies "Save and add to chart" with higher priority than plain add', () => {
    assert.equal(classifyPineButton({ text: 'Save and add to chart' }), 'save-and-add');
  });

  it('classifies the save button by its locale-independent className hook', () => {
    assert.equal(
      classifyPineButton({ text: '', className: 'saveButton-fF7iXGw2 saved-fF7iXGw2 lightButton-Mym3My5x' }),
      'save'
    );
  });

  it('returns null for unrelated buttons (publish, etc.)', () => {
    assert.equal(classifyPineButton({ text: '퍼블리쉬', className: 'publishButton-HeHIQL4x' }), null);
    assert.equal(classifyPineButton({ text: 'Publish', className: 'publishButton-x' }), null);
  });

  it('returns null for empty / nullish input', () => {
    assert.equal(classifyPineButton({}), null);
    assert.equal(classifyPineButton(null), null);
  });

  it('does not misclassify "Save and add to chart" as plain add (anchor check)', () => {
    // The add/update regex is anchored, so this must take the save-and-add branch.
    assert.notEqual(classifyPineButton({ text: 'Save and add to chart' }), 'add-or-update');
  });
});
