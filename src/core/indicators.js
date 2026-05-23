/**
 * Core indicator settings logic.
 */
import { evaluate, safeString } from '../connection.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

export async function setInputs({ entity_id, inputs: inputsRaw }) {
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (!inputs || typeof inputs !== 'object' || Object.keys(inputs).length === 0) {
    throw new Error('inputs must be a non-empty object, e.g. { length: 50 }');
  }

  const inputsJson = JSON.stringify(inputs);

  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var currentInputs = study.getInputValues();
      var overrides = ${inputsJson};
      var updatedKeys = {};
      for (var i = 0; i < currentInputs.length; i++) {
        if (overrides.hasOwnProperty(currentInputs[i].id)) {
          currentInputs[i].value = overrides[currentInputs[i].id];
          updatedKeys[currentInputs[i].id] = overrides[currentInputs[i].id];
        }
      }
      study.setInputValues(currentInputs);
      return { updated_inputs: updatedKeys };
    })()
  `);

  if (result && result.error) throw new Error(result.error);
  return { success: true, entity_id, updated_inputs: result.updated_inputs };
}

export async function toggleVisibility({ entity_id, visible }) {
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (typeof visible !== 'boolean') throw new Error('visible must be a boolean (true or false)');

  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      study.setVisible(${visible});
      var actualVisible = study.isVisible();
      return { visible: actualVisible };
    })()
  `);

  if (result && result.error) throw new Error(result.error);
  return { success: true, entity_id, visible: result.visible };
}
