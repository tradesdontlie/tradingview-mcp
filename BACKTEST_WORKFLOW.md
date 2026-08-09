# Backtest Workflow with Widgets

End-to-end backtest execution: strategy params form → backtest run → results dashboard.

## Tools

### 1. `widget_strategy_params` → User Input
Render interactive strategy parameter form in chat.

```javascript
widget_strategy_params({
  strategy_name: 'RSI Mean Reversion',
  params: {
    rsi_period: { type: 'number', min: 5, max: 50, default: 14, step: 1 },
    overbought: { type: 'number', min: 50, max: 100, default: 70, step: 1 },
    oversold: { type: 'number', min: 0, max: 50, default: 30, step: 1 },
    position_size: { type: 'number', min: 0.1, max: 10, default: 1, step: 0.1 },
  }
})
```

**User fills form, clicks Submit**

---

### 2. `backtest_run` → Execute Strategy Tester
Inject parameters, open tester, trigger backtest.

```javascript
backtest_run({
  strategy_name: 'RSI Mean Reversion',
  parameters: {
    rsi_period: 14,
    overbought: 70,
    oversold: 30,
    position_size: 1
  },
  symbol: 'EURUSD',
  timeframe: '1H',
  from_date: '2023-01-01',
  to_date: '2024-01-01'
})
```

**Returns:** Backtest started, tester panel opens, awaits "Run" click or automation.

---

### 3. `backtest_metrics` → Extract Performance Stats
Pull Sharpe ratio, max drawdown, win rate, profit factor from results panel.

```javascript
backtest_metrics()
```

**Returns:**
```json
{
  "success": true,
  "metrics": {
    "total_return": "12.45%",
    "sharpe_ratio": 1.85,
    "sortino_ratio": 2.12,
    "max_drawdown": "-8.3%",
    "win_rate": "65%",
    "profit_factor": 1.95,
    "trades": 245
  }
}
```

---

### 4. `backtest_equity_curve` → Get Timeseries Data
Extract equity progression for charting.

```javascript
backtest_equity_curve({ resample: '1D' })
```

**Returns:** `[[timestamp, equity], ...]` points for dashboard sparkline.

---

### 5. `widget_dashboard` → Display Results
Render live metrics + equity chart.

```javascript
widget_dashboard({
  title: 'Backtest Results',
  metrics: {
    'Total Return': '+12.45%',
    'Sharpe Ratio': '1.85',
    'Max Drawdown': '-8.3%',
    'Win Rate': '65%',
    'Trades': '245'
  },
  equity_data: [[1672531200000, 50000], [1672617600000, 50312], ...]
})
```

---

### 6. `backtest_trades` → View Trade History
List all executed trades.

```javascript
backtest_trades({ filter: 'all', limit: 50 })
```

**Returns:** Trade entries/exits + P&L.

---

### 7. `widget_table` → Display Trade Table
Render sortable/filterable trade log.

```javascript
widget_table({
  title: 'Backtest Trades',
  columns: [
    { key: 'date', label: 'Date', align: 'left' },
    { key: 'entry', label: 'Entry', align: 'right' },
    { key: 'exit', label: 'Exit', align: 'right' },
    { key: 'profit', label: 'P&L', align: 'right' }
  ],
  rows: [
    { date: '2023-01-15', entry: '1.0950', exit: '1.0965', profit: '+15 pips' },
    { date: '2023-01-16', entry: '1.0980', exit: '1.0970', profit: '-10 pips' }
  ],
  sortable: true,
  filterable: true
})
```

---

## Complete Workflow

```
┌──────────────────┐
│ Strategy Params  │ ← User enters: RSI=14, Overbought=70, etc
│ Form Widget      │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  backtest_run    │ ← Inject params, open tester
│  (executes)      │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Strategy Tester  │ ← Wait for backtest to complete
│ Running...       │   (1-30 seconds depending on data)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ backtest_metrics │ ← Parse results panel
│ + equity_curve   │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Dashboard Widget │ ← Display metrics + sparkline
│ + Trades Table   │
└──────────────────┘
```

---

## Example: Full Backtest Flow

```javascript
// 1. Show parameter form
await tool.widget_strategy_params({
  strategy_name: 'RSI Mean Reversion',
  params: {
    rsi_period: { type: 'number', min: 5, max: 50, default: 14 },
    overbought: { type: 'number', min: 50, max: 100, default: 70 },
    oversold: { type: 'number', min: 0, max: 50, default: 30 }
  }
})

// 2. User fills form, clicks Submit...

// 3. Execute backtest
const backtest = await tool.backtest_run({
  strategy_name: 'RSI Mean Reversion',
  parameters: { rsi_period: 14, overbought: 70, oversold: 30 },
  symbol: 'EURUSD',
  timeframe: '1H'
})

// Wait for results...

// 4. Fetch metrics
const metrics = await tool.backtest_metrics()

// 5. Fetch equity curve
const equity = await tool.backtest_equity_curve()

// 6. Display dashboard
await tool.widget_dashboard({
  title: 'Backtest Results',
  metrics: metrics.metrics,
  equity_data: equity.data
})

// 7. Show trades
const trades = await tool.backtest_trades({ limit: 50 })
await tool.widget_table({
  title: 'Trades',
  columns: [...],
  rows: trades.trades
})
```

---

## Notes

- **Async:** Backtests run in TradingView; polling interval ~1-5s recommended
- **CDP Limitations:** Equity curve extraction depends on DOM parsing (not guaranteed on all TradingView versions)
- **Parameter Format:** Numbers/booleans passed directly; strings quoted; arrays JSON
- **Optimization:** `backtest_optimize` is queued but requires multi-run implementation
- **Export:** HTML/JSON export available via `backtest_export`

---

## Integration with Existing Tools

- **Strategy Setup:** Use `pine_new('strategy')` → inject params → `pine_compile()`
- **Chart Context:** `chart_manage_symbol()` + `chart_manage_indicator()` before backtest
- **Pine Debugging:** `pine_get_errors()` + `pine_get_console()` if compilation fails
- **Capture Results:** `capture_screenshot('strategy_tester')` for manual reports
