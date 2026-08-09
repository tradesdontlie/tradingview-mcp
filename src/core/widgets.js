// Widgets don't need connection - they return HTML directly

// MCP resource URL builder
function resourceUrl(id) {
  return `widget://${id}`;
}

// Generate unique widget ID
function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Picker Form (symbol/timeframe)
export async function createPickerForm({ current_symbol, current_timeframe, symbols }) {
  const id = generateId('picker');
  const html = `
    <div class="widget-picker" data-widget-id="${id}">
      <style>
        .widget-picker { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; background: #f5f5f5; border-radius: 8px; max-width: 400px; }
        .widget-picker-group { margin-bottom: 16px; }
        .widget-picker-label { display: block; font-size: 14px; font-weight: 500; margin-bottom: 6px; color: #333; }
        .widget-picker-select { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; }
        .widget-picker-buttons { display: flex; gap: 8px; margin-top: 16px; }
        .widget-picker-button { flex: 1; padding: 10px; border: none; border-radius: 4px; font-size: 14px; font-weight: 500; cursor: pointer; }
        .widget-picker-button-primary { background: #007bff; color: white; }
        .widget-picker-button-primary:hover { background: #0056b3; }
        .widget-picker-button-secondary { background: #e9ecef; color: #333; }
        .widget-picker-button-secondary:hover { background: #dee2e6; }
      </style>
      <div class="widget-picker-group">
        <label class="widget-picker-label">Symbol</label>
        <select class="widget-picker-select" id="${id}-symbol" data-field="symbol">
          ${symbols.map(s => `<option value="${s}" ${s === current_symbol ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
      <div class="widget-picker-group">
        <label class="widget-picker-label">Timeframe</label>
        <select class="widget-picker-select" id="${id}-timeframe" data-field="timeframe">
          <option value="1" ${current_timeframe === '1' ? 'selected' : ''}>1 min</option>
          <option value="5" ${current_timeframe === '5' ? 'selected' : ''}>5 min</option>
          <option value="15" ${current_timeframe === '15' ? 'selected' : ''}>15 min</option>
          <option value="30" ${current_timeframe === '30' ? 'selected' : ''}>30 min</option>
          <option value="60" ${current_timeframe === '60' ? 'selected' : ''}>1 hour</option>
          <option value="240" ${current_timeframe === '240' ? 'selected' : ''}>4 hours</option>
          <option value="D" ${current_timeframe === 'D' ? 'selected' : ''}>Daily</option>
          <option value="W" ${current_timeframe === 'W' ? 'selected' : ''}>Weekly</option>
        </select>
      </div>
      <div class="widget-picker-buttons">
        <button class="widget-picker-button widget-picker-button-primary" data-action="apply">Apply</button>
        <button class="widget-picker-button widget-picker-button-secondary" data-action="cancel">Cancel</button>
      </div>
    </div>
  `;

  return {
    success: true,
    widget_id: id,
    resource_uri: resourceUrl(id),
    html,
    type: 'picker_form',
  };
}

// Strategy Parameters Form
export async function createStrategyParamsForm(strategy_name, params) {
  const id = generateId('strategy');

  const paramInputs = Object.entries(params).map(([name, config]) => {
    const { type, min, max, default: defaultVal, step, options } = config;
    let input = '';

    if (type === 'number') {
      input = `<input type="number" class="widget-input" id="${id}-${name}" data-field="${name}" value="${defaultVal ?? 0}" ${min !== undefined ? `min="${min}"` : ''} ${max !== undefined ? `max="${max}"` : ''} ${step !== undefined ? `step="${step}"` : ''} />`;
    } else if (type === 'select' && options) {
      input = `<select class="widget-input" id="${id}-${name}" data-field="${name}">
        ${options.map(opt => `<option value="${opt}" ${opt === defaultVal ? 'selected' : ''}>${opt}</option>`).join('')}
      </select>`;
    } else if (type === 'boolean') {
      input = `<label style="display: flex; align-items: center; gap: 8px;"><input type="checkbox" id="${id}-${name}" data-field="${name}" ${defaultVal ? 'checked' : ''} /> ${name}</label>`;
    } else {
      input = `<input type="text" class="widget-input" id="${id}-${name}" data-field="${name}" value="${defaultVal ?? ''}" />`;
    }

    return `<div class="widget-param-group"><label class="widget-param-label">${name}</label>${input}</div>`;
  }).join('');

  const html = `
    <div class="widget-strategy-params" data-widget-id="${id}">
      <style>
        .widget-strategy-params { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; background: #f5f5f5; border-radius: 8px; max-width: 500px; }
        .widget-strategy-title { font-size: 18px; font-weight: 600; margin-bottom: 20px; color: #333; }
        .widget-param-group { margin-bottom: 16px; }
        .widget-param-label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; color: #555; text-transform: uppercase; letter-spacing: 0.5px; }
        .widget-input { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; box-sizing: border-box; }
        .widget-buttons { display: flex; gap: 8px; margin-top: 20px; }
        .widget-button { flex: 1; padding: 10px; border: none; border-radius: 4px; font-size: 14px; font-weight: 500; cursor: pointer; }
        .widget-button-primary { background: #28a745; color: white; }
        .widget-button-primary:hover { background: #218838; }
        .widget-button-secondary { background: #e9ecef; color: #333; }
        .widget-button-secondary:hover { background: #dee2e6; }
      </style>
      <div class="widget-strategy-title">${strategy_name} Parameters</div>
      ${paramInputs}
      <div class="widget-buttons">
        <button class="widget-button widget-button-primary" data-action="submit">Submit</button>
        <button class="widget-button widget-button-secondary" data-action="cancel">Cancel</button>
      </div>
    </div>
  `;

  return {
    success: true,
    widget_id: id,
    resource_uri: resourceUrl(id),
    html,
    type: 'strategy_params',
  };
}

// Real-time Dashboard
export async function createDashboard({ title, metrics, equity_data }) {
  const id = generateId('dashboard');

  const metricCards = Object.entries(metrics).map(([label, value]) => {
    const isNumber = typeof value === 'number';
    const displayValue = isNumber ? (value > 0 ? `+${value.toFixed(2)}` : value.toFixed(2)) : value;
    const color = isNumber && value > 0 ? '#28a745' : (isNumber && value < 0 ? '#dc3545' : '#007bff');

    return `
      <div class="metric-card">
        <div class="metric-label">${label}</div>
        <div class="metric-value" style="color: ${color};">${displayValue}</div>
      </div>
    `;
  }).join('');

  // Simple sparkline chart
  let chartHtml = '';
  if (equity_data && equity_data.length > 0) {
    const values = equity_data.map(d => d[1]);
    const minVal = Math.min(...values);
    const maxVal = Math.max(...values);
    const range = maxVal - minVal || 1;
    const points = values.map((v, i) => {
      const x = (i / (values.length - 1)) * 100;
      const y = 100 - ((v - minVal) / range) * 100;
      return `${x},${y}`;
    }).join(' ');

    chartHtml = `
      <div class="chart-container">
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" class="sparkline">
          <polyline points="${points}" fill="none" stroke="#007bff" stroke-width="0.5" vector-effect="non-scaling-stroke" />
        </svg>
      </div>
    `;
  }

  const html = `
    <div class="widget-dashboard" data-widget-id="${id}">
      <style>
        .widget-dashboard { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 8px; color: white; max-width: 600px; }
        .dashboard-title { font-size: 20px; font-weight: 600; margin-bottom: 16px; }
        .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 20px; }
        .metric-card { background: rgba(255, 255, 255, 0.15); padding: 12px; border-radius: 6px; backdrop-filter: blur(10px); }
        .metric-label { font-size: 12px; opacity: 0.8; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
        .metric-value { font-size: 18px; font-weight: 600; }
        .chart-container { height: 80px; background: rgba(255, 255, 255, 0.1); border-radius: 6px; padding: 8px; margin-top: 16px; }
        .sparkline { width: 100%; height: 100%; }
      </style>
      <div class="dashboard-title">${title}</div>
      <div class="metrics-grid">${metricCards}</div>
      ${chartHtml}
    </div>
  `;

  return {
    success: true,
    widget_id: id,
    resource_uri: resourceUrl(id),
    html,
    type: 'dashboard',
  };
}

// Confirmation Dialog
export async function createConfirmationDialog({ title, message, action_label, cancel_label, details }) {
  const id = generateId('confirm');

  const detailsHtml = details.length > 0 ? `
    <div class="confirmation-details">
      ${details.map(detail => `
        <div class="detail-row">
          <span class="detail-label">${Object.keys(detail)[0]}</span>
          <span class="detail-value">${Object.values(detail)[0]}</span>
        </div>
      `).join('')}
    </div>
  ` : '';

  const html = `
    <div class="widget-confirmation" data-widget-id="${id}">
      <style>
        .widget-confirmation { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 400px; }
        .confirmation-card { background: white; border: 2px solid #ffc107; border-radius: 8px; padding: 24px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
        .confirmation-icon { font-size: 32px; margin-bottom: 12px; }
        .confirmation-title { font-size: 18px; font-weight: 600; color: #333; margin-bottom: 8px; }
        .confirmation-message { font-size: 14px; color: #666; margin-bottom: 16px; line-height: 1.5; }
        .confirmation-details { background: #f8f9fa; border-radius: 4px; padding: 12px; margin-bottom: 16px; }
        .detail-row { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 6px; }
        .detail-row:last-child { margin-bottom: 0; }
        .detail-label { color: #666; font-weight: 500; }
        .detail-value { color: #333; font-weight: 600; }
        .confirmation-buttons { display: flex; gap: 8px; }
        .confirmation-button { flex: 1; padding: 10px; border: none; border-radius: 4px; font-size: 14px; font-weight: 500; cursor: pointer; }
        .confirmation-button-action { background: #ffc107; color: #333; }
        .confirmation-button-action:hover { background: #ffb300; }
        .confirmation-button-cancel { background: #e9ecef; color: #333; }
        .confirmation-button-cancel:hover { background: #dee2e6; }
      </style>
      <div class="confirmation-card">
        <div class="confirmation-icon">⚠️</div>
        <div class="confirmation-title">${title}</div>
        <div class="confirmation-message">${message}</div>
        ${detailsHtml}
        <div class="confirmation-buttons">
          <button class="confirmation-button confirmation-button-action" data-action="confirm">${action_label}</button>
          <button class="confirmation-button confirmation-button-cancel" data-action="cancel">${cancel_label}</button>
        </div>
      </div>
    </div>
  `;

  return {
    success: true,
    widget_id: id,
    resource_uri: resourceUrl(id),
    html,
    type: 'confirmation',
  };
}

// Data Table
export async function createTable({ title, columns, rows, sortable, filterable }) {
  const id = generateId('table');

  const headerRow = columns.map(col => `
    <th class="table-header" data-key="${col.key}" data-sortable="${sortable}" style="text-align: ${col.align || 'left'};">
      ${col.label}
      ${sortable ? '<span class="sort-indicator">⇅</span>' : ''}
    </th>
  `).join('');

  const bodyRows = rows.map(row => `
    <tr class="table-row">
      ${columns.map(col => `<td class="table-cell" style="text-align: ${col.align || 'left'};">${row[col.key]}</td>`).join('')}
    </tr>
  `).join('');

  const filterHtml = filterable ? `
    <div class="table-filter">
      <input type="text" class="table-search" placeholder="Search..." />
    </div>
  ` : '';

  const html = `
    <div class="widget-table" data-widget-id="${id}">
      <style>
        .widget-table { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); max-width: 100%; }
        .table-title { padding: 16px 20px; border-bottom: 1px solid #e9ecef; font-size: 16px; font-weight: 600; color: #333; }
        .table-filter { padding: 12px 20px; border-bottom: 1px solid #e9ecef; }
        .table-search { width: 100%; max-width: 300px; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; }
        .table-container { overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; }
        .table-header { padding: 12px 16px; background: #f8f9fa; font-weight: 600; font-size: 13px; color: #555; text-transform: uppercase; letter-spacing: 0.5px; cursor: pointer; user-select: none; }
        .table-header[data-sortable="true"]:hover { background: #e9ecef; }
        .sort-indicator { margin-left: 4px; opacity: 0.5; font-size: 12px; }
        .table-row:nth-child(odd) { background: #fafbfc; }
        .table-row:hover { background: #f0f0f0; }
        .table-cell { padding: 12px 16px; font-size: 14px; color: #333; border-bottom: 1px solid #e9ecef; }
      </style>
      <div class="table-title">${title}</div>
      ${filterHtml}
      <div class="table-container">
        <table>
          <thead><tr>${headerRow}</tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
    </div>
  `;

  return {
    success: true,
    widget_id: id,
    resource_uri: resourceUrl(id),
    html,
    type: 'table',
  };
}

// Alert Banner
export async function createAlert({ type, title, message, dismissible }) {
  const id = generateId('alert');

  const colors = {
    info: { bg: '#d1ecf1', border: '#bee5eb', text: '#0c5460' },
    success: { bg: '#d4edda', border: '#c3e6cb', text: '#155724' },
    warning: { bg: '#fff3cd', border: '#ffeeba', text: '#856404' },
    error: { bg: '#f8d7da', border: '#f5c6cb', text: '#721c24' },
  };

  const icons = {
    info: 'ℹ️',
    success: '✓',
    warning: '⚠️',
    error: '✕',
  };

  const color = colors[type];
  const icon = icons[type];

  const dismissBtn = dismissible ? `<button class="alert-dismiss" data-action="dismiss" style="position: absolute; top: 12px; right: 12px; background: none; border: none; cursor: pointer; font-size: 18px;">×</button>` : '';

  const html = `
    <div class="widget-alert" data-widget-id="${id}">
      <style>
        .widget-alert { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; position: relative; }
        .alert-banner { background: ${color.bg}; border-left: 4px solid ${color.border}; border-radius: 4px; padding: 16px; color: ${color.text}; }
        .alert-icon { font-size: 18px; margin-right: 12px; display: inline-block; }
        .alert-content { display: inline-block; }
        .alert-title { font-weight: 600; margin-bottom: 4px; }
        .alert-message { font-size: 14px; }
      </style>
      <div class="alert-banner">
        ${dismissBtn}
        <span class="alert-icon">${icon}</span>
        <div class="alert-content">
          <div class="alert-title">${title}</div>
          <div class="alert-message">${message}</div>
        </div>
      </div>
    </div>
  `;

  return {
    success: true,
    widget_id: id,
    resource_uri: resourceUrl(id),
    html,
    type: 'alert',
  };
}
