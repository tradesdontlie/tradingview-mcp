import { isToolEnabled, loadConfig, getAuditLogger } from '../permissions.js';

// Map every CLI operation to the same permission used by its MCP equivalent.
export function cliTools(command, sub, opts = {}, positionals = []) {
  const simple = {
    status: 'tv_health_check', launch: 'tv_launch', update: 'tv_update',
    state: 'chart_get_state', info: 'symbol_info', search: 'symbol_search',
    discover: 'tv_discover', 'ui-state': 'tv_ui_state', scroll: 'chart_scroll_to_date',
    quote: 'quote_get', ohlcv: 'data_get_ohlcv', values: 'data_get_study_values',
    screenshot: 'capture_screenshot',
  };
  if (command === 'call') return [positionals[0]];
  if (simple[command]) return [simple[command]];
  if (['symbol', 'timeframe', 'type'].includes(command)) return [positionals.length ? ({symbol:'chart_set_symbol',timeframe:'chart_set_timeframe',type:'chart_set_type'})[command] : 'chart_get_state'];
  if (command === 'range') return [opts.from && opts.to ? 'chart_set_visible_range' : 'chart_get_visible_range'];
  const groups = {
    alert: { list: 'alert_list', create: 'alert_create', delete: 'alert_delete' },
    data: { lines: 'data_get_pine_lines', labels: 'data_get_pine_labels', tables: 'data_get_pine_tables', boxes: 'data_get_pine_boxes', strategy: 'data_get_strategy_results', trades: 'data_get_trades', equity: 'data_get_equity', depth: 'depth_get', indicator: 'data_get_indicator' },
    indicator: { add: 'chart_manage_indicator', remove: 'chart_manage_indicator', toggle: 'indicator_toggle_visibility', set: 'indicator_set_inputs', get: 'data_get_indicator' },
    draw: { shape: 'draw_shape', list: 'draw_list', get: 'draw_get_properties', remove: 'draw_remove_one', clear: 'draw_clear' },
    layout: { list: 'layout_list', switch: 'layout_switch' },
    pane: { list: 'pane_list', layout: 'pane_set_layout', focus: 'pane_focus', symbol: 'pane_set_symbol' },
    tab: { list: 'tab_list', new: 'tab_new', close: 'tab_close', switch: 'tab_switch' },
    watchlist: { get: 'watchlist_get', add: 'watchlist_add', 'add-bulk': 'watchlist_add_bulk', remove: 'watchlist_remove' },
    ui: { click: 'ui_click', keyboard: 'ui_keyboard', hover: 'ui_hover', scroll: 'ui_scroll', find: 'ui_find_element', eval: 'ui_evaluate', type: 'ui_type_text', panel: 'ui_open_panel', fullscreen: 'ui_fullscreen', mouse: 'ui_mouse_click' },
  };
  if (command === 'pine') return [({get:'pine_get_source',set:'pine_set_source',compile:'pine_smart_compile','raw-compile':'pine_compile',analyze:'pine_analyze',check:'pine_check',save:'pine_save',new:'pine_new',open:'pine_open',list:'pine_list_scripts',errors:'pine_get_errors',console:'pine_get_console'})[sub]];
  if (command === 'replay') return [`replay_${sub}`];
  if (command === 'stream') {
    if (sub === 'all') return ['pane_list', 'quote_get', 'data_get_study_values', 'data_get_pine_lines', 'data_get_pine_labels', 'data_get_pine_tables'];
    return [{ quote: 'quote_get', bars: 'data_get_ohlcv', values: 'data_get_study_values', lines: 'data_get_pine_lines', labels: 'data_get_pine_labels', tables: 'data_get_pine_tables' }[sub]];
  }
  return [groups[command]?.[sub]];
}

export function assertCliPermission(command, sub, opts, positionals, cfg = loadConfig()) {
  for (const tool of cliTools(command, sub, opts, positionals)) {
    if (!tool || !isToolEnabled(tool, cfg)) {
      getAuditLogger().record({ tool: tool || command, status: 'denied', duration_ms: 0 });
      throw new Error(`Permission denied: ${tool || command}`);
    }
  }
}
