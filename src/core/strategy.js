/**
 * Strategy/workspace orchestration helpers.
 * Opens a named TradingView layout with optional verification and panel setup.
 */
import { getState as _getState } from './chart.js';
import { layoutList as _layoutList, layoutSwitch as _layoutSwitch, openPanel as _openPanel } from './ui.js';

function _resolve(deps) {
  return {
    getState: deps?.getState || _getState,
    layoutList: deps?.layoutList || _layoutList,
    layoutSwitch: deps?.layoutSwitch || _layoutSwitch,
    openPanel: deps?.openPanel || _openPanel,
  };
}

function _normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function _resolveLayout(layouts, query) {
  const raw = String(query || '').trim();
  const normalized = _normalize(raw);
  if (!normalized) throw new Error('Strategy/layout name is required');

  const exactById = layouts.find(layout => String(layout.id) === raw);
  if (exactById) return exactById;

  const exactByName = layouts.find(layout => _normalize(layout.name) === normalized);
  if (exactByName) return exactByName;

  const partialMatches = layouts.filter(layout => _normalize(layout.name).includes(normalized));
  if (partialMatches.length === 1) return partialMatches[0];
  if (partialMatches.length > 1) {
    const names = partialMatches.slice(0, 5).map(layout => layout.name).join(', ');
    throw new Error(`Strategy/layout "${query}" is ambiguous. Matches: ${names}`);
  }

  throw new Error(`Strategy/layout "${query}" not found.`);
}

function _normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function _normalizeTimeframe(value) {
  return String(value || '').trim().toUpperCase();
}

function _verifyChartState(state, { expectedSymbol, expectedTimeframe }) {
  const issues = [];
  if (expectedSymbol && _normalizeSymbol(state.symbol) !== _normalizeSymbol(expectedSymbol)) {
    issues.push(`Expected symbol ${expectedSymbol} but active chart is ${state.symbol}`);
  }
  if (expectedTimeframe && _normalizeTimeframe(state.resolution) !== _normalizeTimeframe(expectedTimeframe)) {
    issues.push(`Expected timeframe ${expectedTimeframe} but active chart is ${state.resolution}`);
  }
  return issues;
}

export async function openStrategy({ name, symbol, timeframe, panels, dry_run, _deps } = {}) {
  const { layoutList, layoutSwitch, openPanel, getState } = _resolve(_deps);
  const requestedPanels = Array.isArray(panels) ? panels : [];
  const dryRun = !!dry_run;

  const layouts = await layoutList();
  const target = _resolveLayout(layouts.layouts || [], name);
  const plan = {
    strategy: name,
    target_layout: {
      id: target.id,
      name: target.name,
      url: target.url || null,
      active: !!target.active,
    },
    current_layout: layouts.active_layout || null,
    requested_symbol: symbol || null,
    requested_timeframe: timeframe || null,
    requested_panels: requestedPanels,
    dry_run: dryRun,
  };

  if (dryRun) {
    return {
      success: true,
      action: 'planned',
      would_switch_layout: !target.active,
      would_open_panels: requestedPanels,
      plan,
    };
  }

  const steps = [];
  let switchResult;
  if (target.active) {
    switchResult = {
      success: true,
      action: 'already_active',
      verified: true,
      layout: target.name,
      layout_id: target.id,
      layout_url: target.url || null,
    };
  } else {
    switchResult = await layoutSwitch({ name: target.name });
  }
  steps.push({ step: 'layout', result: switchResult });

  const panelResults = [];
  for (const panel of requestedPanels) {
    const result = await openPanel({ panel, action: 'open' });
    panelResults.push(result);
  }
  if (panelResults.length > 0) steps.push({ step: 'panels', result: panelResults });

  const state = await getState();
  const issues = _verifyChartState(state, { expectedSymbol: symbol, expectedTimeframe: timeframe });
  if (issues.length > 0) {
    throw new Error(`Strategy/layout opened but verification failed: ${issues.join('; ')}`);
  }
  steps.push({ step: 'chart_state', result: state });

  return {
    success: true,
    action: 'opened',
    verified: true,
    strategy: name,
    layout: switchResult.layout || target.name,
    layout_id: switchResult.layout_id || target.id,
    layout_url: switchResult.layout_url || target.url || null,
    chart_state: state,
    panels_opened: panelResults.map(result => result.panel),
    steps,
    plan,
  };
}
