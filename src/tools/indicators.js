import { evaluate } from '../connection.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

export function registerIndicatorTools(server) {

  // ── 1. indicator_set_inputs — Change indicator settings ──

  server.tool('indicator_set_inputs', 'Change indicator/study input values (e.g., length, source, period)', {
    entity_id: { type: 'string', description: 'Entity ID of the study (from chart_get_state)' },
    inputs: { type: 'object', description: 'Object of input overrides, e.g. { length: 50, source: "close" }. Keys are input IDs, values are the new values.' },
  }, async ({ entity_id, inputs }) => {
    try {
      if (!entity_id) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: false,
            error: 'entity_id is required. Use chart_get_state to find study IDs.',
          }, null, 2) }],
          isError: true,
        };
      }

      if (!inputs || typeof inputs !== 'object' || Object.keys(inputs).length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: false,
            error: 'inputs must be a non-empty object, e.g. { length: 50 }',
          }, null, 2) }],
          isError: true,
        };
      }

      const escapedId = entity_id.replace(/'/g, "\\'");
      const inputsJson = JSON.stringify(inputs);

      const result = await evaluate(`
        (function() {
          var chart = ${CHART_API};
          var study = chart.getStudyById('${escapedId}');
          if (!study) return { error: 'Study not found: ${escapedId}' };

          var overrides = ${inputsJson};
          var updatedKeys = {};
          var path = 'unknown';
          var unverified = false;

          function countUpdated() { return Object.keys(updatedKeys).length; }
          function publicInputSummary(inputs) {
            return (inputs || []).map(function(input) {
              return { id: input.id, name: input.name, value: input.value };
            });
          }
          function getInputInfoSummary() {
            try {
              var info = study.getInputsInfo ? study.getInputsInfo() : [];
              return (info || []).map(function(input) {
                return {
                  id: input.id,
                  name: input.name || input.title || input.displayName,
                  value: input.value,
                  type: input.type,
                };
              });
            } catch(e) {
              return [];
            }
          }
          function getPropertyInputs() {
            var props = study._study
              ? study._study.properties().inputs
              : (study.properties ? study.properties().inputs : null);
            var summary = [];
            if (props) {
              summary = Object.keys(props).map(function(k) {
                var p = props[k];
                return { id: k, value: (p && typeof p.value === 'function') ? p.value() : (p ? p._value : undefined) };
              });
            }
            return { props: props, summary: summary };
          }

          // ── Path A: public getInputValues/setInputValues (works for built-ins) ──
          var currentInputs = study.getInputValues ? study.getInputValues() : [];
          if (currentInputs && currentInputs.length > 0) {
            path = 'setInputValues';
            for (var i = 0; i < currentInputs.length; i++) {
              if (overrides.hasOwnProperty(currentInputs[i].id)) {
                currentInputs[i].value = overrides[currentInputs[i].id];
                updatedKeys[currentInputs[i].id] = overrides[currentInputs[i].id];
              }
            }
            if (countUpdated() === 0) {
              return {
                error: 'No matching input IDs found for requested overrides',
                requested_inputs: Object.keys(overrides),
                available_inputs: publicInputSummary(currentInputs),
              };
            }
            study.setInputValues(currentInputs);

          } else {
            // ── Path B: custom Pine scripts — getInputValues() returns [] ──
            // Prefer properties so we can reject unknown IDs instead of silently
            // claiming success for keys TradingView ignored.
            var propResult = getPropertyInputs();
            if (propResult.props) {
              path = 'properties';
              var keys = Object.keys(overrides);
              for (var k = 0; k < keys.length; k++) {
                var key = keys[k];
                if (propResult.props[key] && typeof propResult.props[key].setValue === 'function') {
                  propResult.props[key].setValue(overrides[key]);
                  updatedKeys[key] = overrides[key];
                }
              }
              if (countUpdated() === 0) {
                return {
                  error: 'No matching input IDs found for requested overrides',
                  requested_inputs: keys,
                  available_inputs: propResult.summary.length > 0 ? propResult.summary : getInputInfoSummary(),
                };
              }
              // Trigger recompute via modifyStudy with exact updated inputs.
              try { chart.modifyStudy('${escapedId}', { inputs: updatedKeys }); } catch(e) {
                try { chart.modifyStudy('${escapedId}', {}); } catch(_) {}
              }
            } else {
              // ── Path C: final public modifyStudy fallback ──
              // This path is useful for study types with hidden input property
              // internals, but the result cannot be verified locally.
              try {
                chart.modifyStudy('${escapedId}', { inputs: overrides });
                path = 'modifyStudy';
                updatedKeys = overrides;
                unverified = true;
              } catch(modErr) {
                return {
                  error: 'No input path available for this study type',
                  modifyStudyError: modErr.message,
                  available_inputs: getInputInfoSummary(),
                };
              }
            }
          }

          // Enumerate available inputs from properties for diagnostics
          var propInputs = getPropertyInputs().summary;
          var infoInputs = getInputInfoSummary();

          var allInputs = study.getInputValues ? study.getInputValues() : [];
          return {
            updated_inputs: updatedKeys,
            path: path,
            all_inputs: allInputs.length > 0 ? allInputs : (propInputs.length > 0 ? propInputs : infoInputs),
            unverified: unverified,
            note: allInputs.length === 0 ? 'Custom script: getInputValues() empty — used fallback path; prefer IDs shown in all_inputs.' : undefined,
          };
        })()
      `);

      if (result && result.error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: result.error }, null, 2) }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true,
          entity_id,
          path: result.path,
          updated_inputs: result.updated_inputs,
          all_inputs: result.all_inputs,
          unverified: result.unverified,
          note: result.note,
        }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }],
        isError: true,
      };
    }
  });

  // ── 2. indicator_toggle_visibility — Show/hide a study ──

  server.tool('indicator_toggle_visibility', 'Show or hide an indicator/study on the chart', {
    entity_id: { type: 'string', description: 'Entity ID of the study (from chart_get_state)' },
    visible: { type: 'boolean', description: 'true to show, false to hide' },
  }, async ({ entity_id, visible }) => {
    try {
      if (!entity_id) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: false,
            error: 'entity_id is required. Use chart_get_state to find study IDs.',
          }, null, 2) }],
          isError: true,
        };
      }

      if (typeof visible !== 'boolean') {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: false,
            error: 'visible must be a boolean (true or false)',
          }, null, 2) }],
          isError: true,
        };
      }

      const escapedId = entity_id.replace(/'/g, "\\'");

      const result = await evaluate(`
        (function() {
          var chart = ${CHART_API};
          var study = chart.getStudyById('${escapedId}');
          if (!study) return { error: 'Study not found: ${escapedId}' };

          study.setVisible(${visible});
          var actualVisible = study.isVisible();

          return { visible: actualVisible };
        })()
      `);

      if (result && result.error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: result.error }, null, 2) }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true,
          entity_id,
          visible: result.visible,
        }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }],
        isError: true,
      };
    }
  });
}
