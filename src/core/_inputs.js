/**
 * Shared page-context JS for applying study input overrides.
 * Used by chart_manage_indicator (after createStudy) and indicator_set_inputs.
 */
import { safeString } from '../connection.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

/**
 * Returns an IIFE that applies `inputs` ({ id: value }) to study `entityId`
 * via getInputValues/setInputValues and reads the result back.
 * Evaluates to { confirmed: {id: value}, unknown: [ids] } or { error }.
 */
export function applyInputsJS(entityId, inputs) {
  return `
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById(${safeString(entityId)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entityId)} };
      if (typeof study.getInputValues !== 'function') return { error: 'inputs unsupported for this study' };
      var current = study.getInputValues();
      var overrides = ${JSON.stringify(inputs)};
      var byId = {}, applied = {}, unknown = [];
      for (var i = 0; i < current.length; i++) byId[current[i].id] = current[i];
      for (var k in overrides) {
        if (!Object.prototype.hasOwnProperty.call(overrides, k)) continue;
        if (byId[k]) { byId[k].value = overrides[k]; applied[k] = true; }
        else unknown.push(k);
      }
      study.setInputValues(current);
      var after = study.getInputValues();
      var confirmed = {};
      for (var m = 0; m < after.length; m++) { if (applied[after[m].id]) confirmed[after[m].id] = after[m].value; }
      return { confirmed: confirmed, unknown: unknown };
    })()
  `;
}
