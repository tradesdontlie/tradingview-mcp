/**
 * Core indicator settings logic.
 */
import { evaluate, safeString } from '../connection.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

export async function setInputs({ entity_id, inputs: inputsRaw }) {
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs) || Object.keys(inputs).length === 0) {
    throw new Error('inputs must be a non-empty object keyed by input id, e.g. { "length": 50 }');
  }

  const inputsJson = JSON.stringify(inputs);

  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var currentInputs = study.getInputValues();
      // A correctly-added study always exposes its inputs. Empty here means the study was created
      // in a broken state (see manageIndicator) — fail loudly instead of reporting a false success.
      if (!currentInputs || currentInputs.length === 0) {
        return { error: 'Study ' + ${safeString(entity_id)} + ' exposes no inputs (getInputValues empty). It was likely added in a broken state; remove and re-add it.' };
      }
      var overrides = ${inputsJson};
      var updatedKeys = {}, unknown = [];
      for (var key in overrides) {
        if (!Object.prototype.hasOwnProperty.call(overrides, key)) continue;
        var found = false;
        for (var i = 0; i < currentInputs.length; i++) {
          if (currentInputs[i].id === key) { currentInputs[i].value = overrides[key]; updatedKeys[key] = overrides[key]; found = true; break; }
        }
        if (!found) unknown.push(key);
      }
      study.setInputValues(currentInputs);
      // Re-read so we return what ACTUALLY took, not just what we intended.
      return { updated_inputs: updatedKeys, unknown: unknown, inputs: study.getInputValues() };
    })()
  `);

  if (result && result.error) throw new Error(result.error);
  const out = { success: true, entity_id, updated_inputs: result.updated_inputs, inputs: result.inputs };
  if (result.unknown && result.unknown.length) {
    const validIds = (result.inputs || []).map(i => i.id).join(', ');
    out.warning = 'Unknown input keys ignored (not valid for this indicator): ' + result.unknown.join(', ') + '. Valid ids: ' + validIds;
  }
  return out;
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
