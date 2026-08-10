/**
 * Core drawing logic.
 */
import { evaluate as _evaluate, getChartApi as _getChartApi, safeString, requireFinite } from '../connection.js';

function _resolve(deps) {
  return { evaluate: deps?.evaluate || _evaluate, getChartApi: deps?.getChartApi || _getChartApi };
}

export async function drawShape({ shape, point, point2, point3, overrides: overridesRaw, text, _deps }) {
  const { evaluate, getChartApi } = _resolve(_deps);
  const overrides = overridesRaw ? (typeof overridesRaw === 'string' ? JSON.parse(overridesRaw) : overridesRaw) : {};
  const apiPath = await getChartApi();
  const overridesStr = JSON.stringify(overrides || {});
  const textStr = text ? JSON.stringify(text) : '""';

  // Build the point list; supports 1-point (createShape) and 2-/3-point
  // (createMultipointShape) tools — e.g. parallel_channel & pitchfork need 3.
  const pts = [{ time: requireFinite(point.time, 'point.time'), price: requireFinite(point.price, 'point.price') }];
  if (point2) pts.push({ time: requireFinite(point2.time, 'point2.time'), price: requireFinite(point2.price, 'point2.price') });
  if (point3) pts.push({ time: requireFinite(point3.time, 'point3.time'), price: requireFinite(point3.price, 'point3.price') });

  const before = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`);

  const createExpr = pts.length > 1
    ? `${apiPath}.createMultipointShape(${JSON.stringify(pts)}, { shape: ${safeString(shape)}, overrides: ${overridesStr}, text: ${textStr} })`
    : `${apiPath}.createShape(${JSON.stringify(pts[0])}, { shape: ${safeString(shape)}, overrides: ${overridesStr}, text: ${textStr} })`;

  // Fire the create. We deliberately do NOT awaitPromise: on this build the
  // Promise returned by createMultipointShape can reject ("Value is undefined")
  // even though the shape IS created, so detect the new entity by polling
  // getAllShapes instead (3-point shapes like parallel_channel register async).
  await evaluate(createExpr);
  let newId = null;
  for (let i = 0; i < 12 && !newId; i++) {
    await new Promise(r => setTimeout(r, 150));
    const after = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`);
    newId = (after || []).find(id => !(before || []).includes(id)) || null;
  }
  return { success: true, shape, entity_id: newId };
}

// Convenience wrapper around the native TradingView "parallel_channel" linetool.
// The main rail is point -> point2; the parallel rail is set either by an explicit
// point3, or by `width` (price units; positive = parallel rail BELOW the main rail).
// Using the native shape guarantees the two rails stay truly parallel.
export async function drawParallelChannel({ point, point2, width, point3, overrides, _deps }) {
  let third = point3;
  if (!third) {
    const w = requireFinite(width, 'width');
    const p2price = requireFinite(point2.price, 'point2.price');
    third = { time: point2.time, price: p2price - w };
  }
  // Note: TradingView's parallel_channel linetool does not accept a `text`
  // label (passing one makes createMultipointShape fail); style via overrides.
  return drawShape({ shape: 'parallel_channel', point, point2, point3: third, overrides, _deps });
}

export async function listDrawings() {
  const apiPath = await _getChartApi();
  const shapes = await _evaluate(`
    (function() {
      var api = ${apiPath};
      var all = api.getAllShapes();
      return all.map(function(s) { return { id: s.id, name: s.name }; });
    })()
  `);
  return { success: true, count: shapes?.length || 0, shapes: shapes || [] };
}

export async function getProperties({ entity_id }) {
  const apiPath = await _getChartApi();
  const result = await _evaluate(`
    (function() {
      var api = ${apiPath};
      var eid = ${safeString(entity_id)};
      var props = { entity_id: eid };
      var shape = api.getShapeById(eid);
      if (!shape) return { error: 'Shape not found: ' + eid };
      var methods = [];
      try { for (var key in shape) { if (typeof shape[key] === 'function') methods.push(key); } props.available_methods = methods; } catch(e) {}
      try { var pts = shape.getPoints(); if (pts) props.points = pts; } catch(e) { props.points_error = e.message; }
      try { var ovr = shape.getProperties(); if (ovr) props.properties = ovr; } catch(e) {
        try { var ovr2 = shape.properties(); if (ovr2) props.properties = ovr2; } catch(e2) { props.properties_error = e2.message; }
      }
      try { props.visible = shape.isVisible(); } catch(e) {}
      try { props.locked = shape.isLocked(); } catch(e) {}
      try { props.selectable = shape.isSelectionEnabled(); } catch(e) {}
      try {
        var all = api.getAllShapes();
        for (var i = 0; i < all.length; i++) { if (all[i].id === eid) { props.name = all[i].name; break; } }
      } catch(e) {}
      return props;
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return { success: true, ...result };
}

export async function removeOne({ entity_id }) {
  const apiPath = await _getChartApi();
  const result = await _evaluate(`
    (function() {
      var api = ${apiPath};
      var eid = ${safeString(entity_id)};
      var before = api.getAllShapes();
      var found = false;
      for (var i = 0; i < before.length; i++) { if (before[i].id === eid) { found = true; break; } }
      if (!found) return { removed: false, error: 'Shape not found: ' + eid, available: before.map(function(s) { return s.id; }) };
      api.removeEntity(eid);
      var after = api.getAllShapes();
      var stillExists = false;
      for (var j = 0; j < after.length; j++) { if (after[j].id === eid) { stillExists = true; break; } }
      return { removed: !stillExists, entity_id: eid, remaining_shapes: after.length };
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return { success: true, entity_id: result?.entity_id, removed: result?.removed, remaining_shapes: result?.remaining_shapes };
}

export async function clearAll() {
  const apiPath = await _getChartApi();
  await _evaluate(`${apiPath}.removeAllShapes()`);
  return { success: true, action: 'all_shapes_removed' };
}
