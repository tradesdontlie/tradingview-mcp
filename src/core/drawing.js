/**
 * Core drawing logic.
 */
import { evaluate as _evaluate, getChartApi as _getChartApi, safeString, requireFinite } from '../connection.js';

function _resolve(deps) {
  return { evaluate: deps?.evaluate || _evaluate, getChartApi: deps?.getChartApi || _getChartApi };
}

export async function drawShape({ shape, point, point2, overrides: overridesRaw, text, _deps }) {
  const { evaluate, getChartApi } = _resolve(_deps);
  const overrides = overridesRaw ? (typeof overridesRaw === 'string' ? JSON.parse(overridesRaw) : overridesRaw) : {};
  const apiPath = await getChartApi();
  const overridesStr = JSON.stringify(overrides || {});
  const textStr = text ? JSON.stringify(text) : '""';

  const p1time = requireFinite(point.time, 'point.time');
  const p1price = requireFinite(point.price, 'point.price');

  const before = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`);

  if (point2) {
    const p2time = requireFinite(point2.time, 'point2.time');
    const p2price = requireFinite(point2.price, 'point2.price');
    await evaluate(`
      ${apiPath}.createMultipointShape(
        [{ time: ${p1time}, price: ${p1price} }, { time: ${p2time}, price: ${p2price} }],
        { shape: ${safeString(shape)}, overrides: ${overridesStr}, text: ${textStr} }
      )
    `);
  } else {
    await evaluate(`
      ${apiPath}.createShape(
        { time: ${p1time}, price: ${p1price} },
        { shape: ${safeString(shape)}, overrides: ${overridesStr}, text: ${textStr} }
      )
    `);
  }

  await new Promise(r => setTimeout(r, 200));
  const after = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`);
  const newId = (after || []).find(id => !(before || []).includes(id)) || null;
  const result = { entity_id: newId };
  return { success: true, shape, entity_id: result?.entity_id };
}

export async function drawPosition({ direction, entry_price, stop_loss, take_profit, entry_time, account_size, risk, lot_size, _deps }) {
  const { evaluate, getChartApi } = _resolve(_deps);

  if (direction !== 'long' && direction !== 'short') {
    throw new Error('direction must be "long" or "short"');
  }

  const entry = requireFinite(entry_price, 'entry_price');
  const sl = requireFinite(stop_loss, 'stop_loss');
  const tp = requireFinite(take_profit, 'take_profit');

  if (direction === 'long') {
    if (sl >= entry) throw new Error('long position: stop_loss must be below entry_price');
    if (tp <= entry) throw new Error('long position: take_profit must be above entry_price');
  } else {
    if (sl <= entry) throw new Error('short position: stop_loss must be above entry_price');
    if (tp >= entry) throw new Error('short position: take_profit must be below entry_price');
  }

  const apiPath = await getChartApi();

  const pricescale = await evaluate(
    `${apiPath}._chartWidget.model().mainSeries().symbolInfo().pricescale`
  );
  if (!pricescale || pricescale <= 0) {
    throw new Error('Could not determine pricescale from symbol info');
  }

  const stopLevel = Math.round(Math.abs(entry - sl) * pricescale);
  const profitLevel = Math.round(Math.abs(tp - entry) * pricescale);

  let time = entry_time;
  if (time == null) {
    const range = await evaluate(`${apiPath}.getVisibleRange()`);
    time = range?.to || Math.floor(Date.now() / 1000);
  }
  time = requireFinite(time, 'entry_time');

  const shapeName = direction === 'long' ? 'long_position' : 'short_position';

  const overrides = { stopLevel, profitLevel };
  if (account_size != null) overrides.accountSize = requireFinite(account_size, 'account_size');
  if (risk != null) overrides.risk = requireFinite(risk, 'risk');
  if (lot_size != null) overrides.lotSize = requireFinite(lot_size, 'lot_size');

  const overridesStr = JSON.stringify(overrides);

  const before = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`);

  await evaluate(`
    ${apiPath}.createShape(
      { time: ${time}, price: ${entry} },
      { shape: ${safeString(shapeName)}, overrides: ${overridesStr} }
    )
  `);

  await new Promise(r => setTimeout(r, 200));
  const after = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`);
  const entityId = (after || []).find(id => !(before || []).includes(id)) || null;

  const rr = stopLevel > 0 ? Math.round((profitLevel / stopLevel) * 100) / 100 : null;

  return {
    success: true,
    direction,
    entity_id: entityId,
    entry_price: entry,
    stop_loss: sl,
    take_profit: tp,
    risk_reward_ratio: rr,
  };
}

export async function listDrawings() {
  const apiPath = await getChartApi();
  const shapes = await evaluate(`
    (function() {
      var api = ${apiPath};
      var all = api.getAllShapes();
      return all.map(function(s) { return { id: s.id, name: s.name }; });
    })()
  `);
  return { success: true, count: shapes?.length || 0, shapes: shapes || [] };
}

export async function getProperties({ entity_id }) {
  const apiPath = await getChartApi();
  const result = await evaluate(`
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
  const apiPath = await getChartApi();
  const result = await evaluate(`
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
  const apiPath = await getChartApi();
  await evaluate(`${apiPath}.removeAllShapes()`);
  return { success: true, action: 'all_shapes_removed' };
}
