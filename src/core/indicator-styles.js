import { evaluate, safeString } from '../connection.js';

const API = 'window.TradingViewApi._activeChartWidgetWV.value()';
const PATH = /^(?:styles\.[A-Za-z0-9_-]+|graphics\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|palettes\.[A-Za-z0-9_-]+\.colors\.\d{1,3}|bands\.[A-Za-z0-9_-]+|filledAreas\.[A-Za-z0-9_-]+)\.(?:color|linewidth|lineWidth|width|percentWidth|visible|display|transparency|plottype|linestyle|style)$/;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

export function validateStyleOverrides(raw) {
  const input = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length || Object.keys(input).length > 50) {
    throw new Error('overrides must contain between 1 and 50 dotted style properties');
  }
  const result = {};
  for (const [path, value] of Object.entries(input)) {
    if (!PATH.test(path) || path.split('.').some(p => FORBIDDEN.has(p))) throw new Error(`Unsupported style path: ${path}`);
    const key = path.split('.').at(-1);
    if (key === 'color') {
      if (typeof value !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) throw new Error(`Invalid hex color: ${path}`);
    } else if (key === 'visible') {
      if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
    } else {
      const max = key === 'transparency' || key === 'percentWidth' ? 100 : key === 'display' ? 4294967295 : key === 'plottype' ? 9 : key === 'linestyle' ? 4 : 20;
      const min = ['linewidth', 'lineWidth', 'width', 'percentWidth'].includes(key) ? 1 : 0;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${path} must be an integer between ${min} and ${max}`);
    }
    result[path] = value;
  }
  return result;
}

function expression(entityId, action = '') {
  if (typeof entityId !== 'string' || !entityId.trim() || entityId.length > 200) throw new Error('An exact current entity_id is required');
  return `(() => { const study = ${API}.getStudyById(${safeString(entityId)});
    if (!study || typeof study.getStyleValues !== 'function') throw new Error('Study style API is unavailable for the exact entity ID');
    ${action}
    return { style: JSON.parse(JSON.stringify(study.getStyleValues())) };
  })()`;
}

export async function getIndicatorStyle({ entity_id, _deps } = {}) {
  const result = await (_deps?.evaluate || evaluate)(expression(entity_id));
  if (!result?.style || typeof result.style !== 'object') throw new Error('Study style readback is unavailable');
  return { success: true, entity_id, style: result.style };
}

export async function setIndicatorStyle({ entity_id, overrides, _deps } = {}) {
  const validated = validateStyleOverrides(overrides);
  const ev = _deps?.evaluate || evaluate;
  // Validate all target leaves in the same page operation before applying anything.
  const result = await ev(expression(entity_id, `
    const overrides = ${JSON.stringify(validated)};
    const before = JSON.parse(JSON.stringify(study.getStyleValues()));
    const color = value => { let text = String(value).toLowerCase(); if (/^#[0-9a-f]{3}$/.test(text)) text = '#' + text.slice(1).split('').map(c => c + c).join(''); return text.length === 9 && text.endsWith('ff') ? text.slice(0, 7) : text; };
    const same = (path, a, b) => path.endsWith('.color') ? color(a) === color(b) : JSON.stringify(a) === JSON.stringify(b);
    const read = (tree, path) => path.split('.').reduce((o, k) => o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined, tree);
    const originals = {};
    for (const path of Object.keys(overrides)) {
      const value = read(before, path);
      if (value === undefined) throw new Error('Unknown style property: ' + path);
      originals[path] = value;
    }
    if (typeof study.applyOverrides !== 'function') throw new Error('Style writes are unsupported');
    let writeError = null;
    try { study.applyOverrides(overrides); } catch (error) { writeError = error.message; }
    const after = JSON.parse(JSON.stringify(study.getStyleValues()));
    const confirmed = {}, unconfirmed = [];
    for (const [path, wanted] of Object.entries(overrides)) {
      const actual = read(after, path);
      if (same(path, actual, wanted)) confirmed[path] = actual;
      else unconfirmed.push(path);
    }
    if (writeError || unconfirmed.length) {
      let rollbackError = null;
      try { study.applyOverrides(originals); } catch (error) { rollbackError = error.message; }
      const restored = study.getStyleValues();
      const rollbackVerified = Object.entries(originals).every(([path, value]) => same(path, read(restored, path), value));
      return { success: false, confirmed, unconfirmed, error: writeError || 'One or more style changes were not confirmed', rollback_verified: rollbackVerified, rollback_error: rollbackError };
    }
    return { success: true, confirmed, unconfirmed: [] };
  `));
  if (typeof result?.success !== 'boolean') throw new Error('Style write receipt is unavailable; result is unknown');
  return { entity_id, ...result };
}
