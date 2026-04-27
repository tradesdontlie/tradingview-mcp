import { register } from '../router.js';
import * as core from '../../core/chart.js';
import * as healthCore from '../../core/health.js';

register('state', {
  description: 'Get current chart state (symbol, TF, studies)',
  handler: () => core.getState(),
});

register('symbol', {
  description: 'Get or set the chart symbol',
  handler: async (opts, positionals) => {
    const sym = positionals[0];
    if (sym) return core.setSymbol({ symbol: sym });
    const state = await core.getState();
    return { success: true, symbol: state.symbol, resolution: state.resolution };
  },
});

register('timeframe', {
  description: 'Get or set the chart timeframe',
  handler: async (opts, positionals) => {
    const tf = positionals[0];
    if (tf) return core.setTimeframe({ timeframe: tf });
    const state = await core.getState();
    return { success: true, resolution: state.resolution, symbol: state.symbol };
  },
});

register('type', {
  description: 'Get or set the chart type (Candles, Line, etc.)',
  handler: async (opts, positionals) => {
    const ct = positionals[0];
    if (ct) return core.setType({ chart_type: ct });
    const state = await core.getState();
    const typeNames = ['Bars', 'Candles', 'Line', 'Area', 'Renko', 'Kagi', 'PointAndFigure', 'LineBreak', 'HeikinAshi', 'HollowCandles'];
    return { success: true, chart_type: typeNames[state.chartType] || state.chartType, type_num: state.chartType };
  },
});

register('info', {
  description: 'Get detailed symbol metadata',
  handler: () => core.symbolInfo(),
});

register('search', {
  description: 'Search for symbols by name or keyword',
  handler: (opts, positionals) => {
    if (!positionals[0]) throw new Error('Query required. Usage: tv search AAPL');
    return core.symbolSearch({ query: positionals.join(' ') });
  },
});

register('range', {
  description: 'Get or set the visible chart range',
  options: {
    from: { type: 'string', description: 'Start timestamp (unix seconds)' },
    to: { type: 'string', description: 'End timestamp (unix seconds)' },
  },
  handler: async (opts) => {
    if (opts.from && opts.to) return core.setVisibleRange({ from: Number(opts.from), to: Number(opts.to) });
    return core.getVisibleRange();
  },
});

register('scroll', {
  description: 'Scroll the chart to a specific date',
  handler: (opts, positionals) => {
    if (!positionals[0]) throw new Error('Date required. Usage: tv scroll 2025-01-15');
    return core.scrollToDate({ date: positionals[0] });
  },
});

register('replace-study', {
  description: 'Re-add a Pine script with optional input overrides (compound, single round-trip)',
  options: {
    inputs: { type: 'string', short: 'i', description: 'JSON string of input overrides, e.g. \'{"length": 50}\'' },
  },
  handler: (opts, positionals) => {
    if (!positionals[0]) throw new Error('Script name required. Usage: tv replace-study "vse_parity_probe_1m" --inputs \'{"emaLen": 5}\'');
    return core.replaceStudy({ script_name: positionals.join(' '), inputs: opts.inputs });
  },
});

register('discover', {
  description: 'Report which TradingView API paths are available',
  handler: () => healthCore.discover(),
});

register('ui-state', {
  description: 'Get current UI state (panels, buttons)',
  handler: () => healthCore.uiState(),
});
