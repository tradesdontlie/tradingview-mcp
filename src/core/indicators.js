/**
 * Core indicator settings logic.
 */
import { evaluate as _evaluate, safeString, parseJsonArg, KNOWN_PATHS } from '../connection.js';

const CHART_API = KNOWN_PATHS.chartApi;

function _resolve(deps) {
  return { evaluate: deps?.evaluate || _evaluate };
}

export async function setInputs({ entity_id, inputs: inputsRaw, _deps }) {
  const { evaluate } = _resolve(_deps);
  const inputs = parseJsonArg(inputsRaw, 'inputs');
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (!inputs || typeof inputs !== 'object' || Object.keys(inputs).length === 0) {
    throw new Error('inputs must be a non-empty object, e.g. { length: 50 }');
  }

  const inputsJson = JSON.stringify(inputs);

  // Two cases:
  //   - Pine script studies: study.getInputValues() returns the live input
  //     array, and study.setInputValues(...) wires changes to the calculation
  //     engine. Existing behavior preserved.
  //   - Built-in studies (Moving Average, RSI, etc.): getInputValues() returns
  //     []. We can read inputs from properties().inputs.state(), but mutating
  //     them (via setInputValues OR property.setValue) updates only the stored
  //     state — the calculation engine never re-runs. The only working path
  //     for built-ins is to remove and re-add the study with new inputs at
  //     creation time, so we surface an actionable error instead of silently
  //     no-op'ing (which previously made callers think the change took).
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var overrides = ${inputsJson};
      var overrideKeys = Object.keys(overrides);

      // Built-in studies (packageId 'tv-basicstudies') don't recompute when
      // inputs are mutated post-creation — neither setInputValues() nor
      // properties.inputs.<key>.setValue() drives the calculation engine,
      // even though both update getInputValues()/state() readouts. Only the
      // initial createStudy call wires inputs through. Detect and reject.
      var mi = study._study && study._study.metaInfo && study._study.metaInfo();
      if (mi && mi.packageId === 'tv-basicstudies') {
        var biKeys = [];
        try {
          var biState = study.properties().inputs.state();
          biKeys = Object.keys(biState);
        } catch(e) {}
        return {
          error: 'BUILT_IN_IMMUTABLE',
          available_keys: biKeys,
          attempted_keys: overrideKeys,
        };
      }

      var currentInputs = study.getInputValues();
      if (!currentInputs || currentInputs.length === 0) {
        return {
          error: 'NO_INPUTS',
          attempted_keys: overrideKeys,
        };
      }

      var validKeys = {};
      for (var i = 0; i < currentInputs.length; i++) validKeys[currentInputs[i].id] = true;
      var updatedKeys = {};
      var unmatchedKeys = [];
      for (var j = 0; j < currentInputs.length; j++) {
        if (overrides.hasOwnProperty(currentInputs[j].id)) {
          currentInputs[j].value = overrides[currentInputs[j].id];
          updatedKeys[currentInputs[j].id] = overrides[currentInputs[j].id];
        }
      }
      for (var k = 0; k < overrideKeys.length; k++) {
        if (!validKeys[overrideKeys[k]]) unmatchedKeys.push(overrideKeys[k]);
      }
      study.setInputValues(currentInputs);
      return {
        updated_inputs: updatedKeys,
        unmatched_keys: unmatchedKeys,
        available_keys: Object.keys(validKeys),
      };
    })()
  `);

  if (result && result.error === 'BUILT_IN_IMMUTABLE') {
    const available = result.available_keys?.length ? result.available_keys.join(', ') : '(unknown)';
    throw new Error(
      `Built-in study inputs cannot be changed after creation. Remove this study and add a new one with the desired inputs. ` +
      `Available input keys: ${available}. Attempted: ${(result.attempted_keys || []).join(', ') || '(none)'}.`
    );
  }
  if (result && result.error === 'NO_INPUTS') {
    throw new Error(
      `This study exposes no settable inputs. Attempted: ${(result.attempted_keys || []).join(', ') || '(none)'}.`
    );
  }
  if (result && result.error) throw new Error(result.error);
  if (result && result.unmatched_keys && result.unmatched_keys.length > 0 && Object.keys(result.updated_inputs || {}).length === 0) {
    throw new Error(
      `None of the provided input keys matched this study. Provided: ${result.unmatched_keys.join(', ')}. ` +
      `Valid keys: ${(result.available_keys || []).join(', ') || '(none)'}.`
    );
  }
  return {
    success: true,
    entity_id,
    updated_inputs: result.updated_inputs,
    ...(result.unmatched_keys && result.unmatched_keys.length ? { unmatched_keys: result.unmatched_keys } : {}),
  };
}

export async function toggleVisibility({ entity_id, visible, _deps }) {
  const { evaluate } = _resolve(_deps);
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
