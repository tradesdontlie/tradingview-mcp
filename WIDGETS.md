# MCP Interactive Widgets

Real-time interactive UI components rendered inline in Claude chat. Built on MCP resource protocol.

## Widgets Available

### 1. Picker Form (`widget_picker_form`)
Symbol + timeframe selector for chart navigation.

```javascript
widget_picker_form({
  current_symbol: 'EURUSD',
  current_timeframe: '1H',
  symbols: ['EURUSD', 'BTCUSD', 'AAPL', 'SPY', 'GC', 'CL']
})
```

**Returns:** Interactive dropdown form with Apply/Cancel buttons.

---

### 2. Strategy Parameters (`widget_strategy_params`)
Dynamic form for strategy parameter input (numeric, select, boolean).

```javascript
widget_strategy_params({
  strategy_name: 'RSI Mean Reversion',
  params: {
    rsi_period: { type: 'number', min: 5, max: 50, default: 14, step: 1 },
    overbought: { type: 'number', min: 50, max: 100, default: 70, step: 1 },
    oversold: { type: 'number', min: 0, max: 50, default: 30, step: 1 },
    position_size: { type: 'number', min: 0.1, max: 10, default: 1, step: 0.1 },
    risk_reward: { type: 'select', options: ['1:1', '1:2', '1:3'], default: '1:2' },
    use_stops: { type: 'boolean', default: true }
  }
})
```

**Returns:** Styled form with Submit/Cancel buttons. Field values bindable via data-field attributes.

---

### 3. Trading Dashboard (`widget_dashboard`)
Real-time metrics + equity curve visualization.

```javascript
widget_dashboard({
  title: 'Live Trading Dashboard',
  metrics: {
    'Account Balance': '$50,234.50',
    'Profit/Loss': '+$1,234.50',
    'Win Rate': '65%',
    'Equity': '$51,468.00',
    'Drawdown': '-2.3%',
    'Sharpe Ratio': '1.85'
  },
  equity_data: [
    [1691001600000, 50000],
    [1691005200000, 50234],
    [1691008800000, 51000],
    [1691012400000, 50800],
    [1691016000000, 51468]
  ]
})
```

**Returns:** Gradient card with metric tiles + sparkline equity chart.

---

### 4. Confirmation Dialog (`widget_confirmation`)
Trade execution or risky action confirmation.

```javascript
widget_confirmation({
  title: 'Execute Trade',
  message: 'Confirm position entry?',
  action_label: 'Execute',
  cancel_label: 'Cancel',
  details: [
    { 'Symbol': 'EURUSD' },
    { 'Type': 'Long' },
    { 'Entry': '1.0950' },
    { 'Stop Loss': '1.0920' },
    { 'Take Profit': '1.0980' },
    { 'Position Size': '1 lot' }
  ]
})
```

**Returns:** Warning-styled dialog with execution details grid + action buttons.

---

### 5. Data Table (`widget_table`)
Sortable/filterable table for watchlists, scan results, trade history.

```javascript
widget_table({
  title: 'Watchlist',
  columns: [
    { key: 'symbol', label: 'Symbol', align: 'left' },
    { key: 'price', label: 'Price', align: 'right' },
    { key: 'change', label: 'Change %', align: 'right' },
    { key: 'rsi', label: 'RSI(14)', align: 'right' },
    { key: 'status', label: 'Status', align: 'center' }
  ],
  rows: [
    { symbol: 'EURUSD', price: '1.0952', change: '+0.45%', rsi: '42', status: '⚙️' },
    { symbol: 'GBPUSD', price: '1.2834', change: '-0.12%', rsi: '58', status: '📊' },
    { symbol: 'USDJPY', price: '145.23', change: '+1.23%', rsi: '71', status: '⚠️' }
  ],
  sortable: true,
  filterable: true
})
```

**Returns:** Styled table with search input + sortable headers.

---

### 6. Alert Banner (`widget_alert`)
Info/success/warning/error notifications.

```javascript
widget_alert({
  type: 'warning',
  title: 'High Leverage Detected',
  message: 'Your position leverage exceeds 50:1. Consider reducing exposure.',
  dismissible: true
})
```

**Returns:** Color-coded alert banner with optional dismiss button.

---

## Usage in Claude Chat

All widgets return MCP resource URIs:

```
{
  "success": true,
  "widget_id": "picker_1691001234_abc123",
  "resource_uri": "widget://picker_1691001234_abc123",
  "html": "...",
  "type": "picker_form"
}
```

Claude renders the HTML inline. On user interaction (form submit, button click), pass the data back to call follow-up tools.

## Integration Examples

### Symbol Picker → Load Chart

1. Call `widget_picker_form()`
2. User selects symbol + timeframe
3. Call `chart_manage_symbol({ symbol, timeframe })` with user's selection

### Strategy Setup → Backtest

1. Call `widget_strategy_params({ strategy_name, params })`
2. User fills form, clicks Submit
3. Pass filled params to `pine_set_source()` to inject strategy code
4. Call `ui_click()` to run backtest

### Trade Confirmation → Execute

1. Call `widget_confirmation()` with trade details
2. User clicks Execute
3. Call `ui_click()` + `ui_type()` to fill order entry form
4. Call `widget_dashboard()` to show live P&L

---

## Architecture

- **Widget Generation:** `src/core/widgets.js` builds HTML + inline CSS
- **Tool Registration:** `src/tools/widgets.js` registers MCP tools
- **Styling:** Each widget self-contained; uses system fonts + gradients
- **State:** Widget IDs unique per render (timestamp + random suffix)
- **Interactivity:** HTML data-* attributes mark user action points

No external dependencies. Pure HTML/CSS/inline SVG.
