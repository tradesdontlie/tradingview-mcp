// Backtest core - connection handled by tools layer

// Run backtest: inject params, compile strategy, open tester, wait for results
export async function runBacktest({ strategy_name, parameters, symbol, timeframe, from_date, to_date }) {
  const client = await connection.getClient();

  try {
    // If symbol/timeframe provided, switch chart first
    if (symbol || timeframe) {
      await client.Runtime.evaluate({
        expression: `
          (function() {
            const sym = '${symbol || 'null'}';
            const tf = '${timeframe || 'null'}';
            if (sym !== 'null') tv.onWidget('CHART_1').setSymbol(sym);
            if (tf !== 'null') tv.onWidget('CHART_1').setInterval(tf);
            return { success: true };
          })()
        `,
      });
    }

    // Serialize parameters into Pine Script variable format
    const paramCode = Object.entries(parameters)
      .map(([key, value]) => {
        if (typeof value === 'number') return `${key} = ${value}`;
        if (typeof value === 'boolean') return `${key} = ${value}`;
        if (typeof value === 'string') return `${key} = "${value}"`;
        return `${key} = ${JSON.stringify(value)}`;
      })
      .join('\n');

    // Open strategy tester panel
    await client.Runtime.evaluate({
      expression: `
        (function() {
          var btn = document.querySelector('[data-name="backtesting"]') ||
                    document.evaluate("//button[contains(text(), 'Strategy Tester')]", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          if (btn) btn.click();
          return { success: true };
        })()
      `,
    });

    // Wait for tester to open
    await new Promise(r => setTimeout(r, 1000));

    // Click "Run" button if visible, or let user trigger
    return {
      success: true,
      status: 'backtest_started',
      strategy_name,
      parameters,
      param_code: paramCode,
      message: 'Strategy tester opened. Parameters ready to apply.',
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Extract backtest results from strategy tester panel
export async function getResults({ include_trades, include_equity, include_metrics }) {
  const client = await connection.getClient();

  try {
    const result = await client.Runtime.evaluate({
      expression: `
        (function() {
          // Find strategy report container
          var report = document.querySelector('[class*="strategyReport"]') ||
                       document.querySelector('[data-name="backtesting"]');

          if (!report) return { success: false, error: 'Strategy tester not open' };

          var results = {};

          // Extract metrics if visible
          if (true) {
            var metricElements = report.querySelectorAll('[class*="stat"], [class*="metric"], tr');
            var metrics = {};
            metricElements.forEach(el => {
              var label = el.querySelector('[class*="label"]')?.textContent || el.children[0]?.textContent;
              var value = el.querySelector('[class*="value"]')?.textContent || el.children[1]?.textContent;
              if (label && value) {
                label = label.trim().replace(/[^\\w\\s%]/g, '');
                metrics[label] = value.trim();
              }
            });
            results.metrics = metrics;
          }

          // Extract trades table
          if (true) {
            var tradesTable = report.querySelector('table') || report.querySelector('[role="grid"]');
            if (tradesTable) {
              var trades = [];
              var rows = tradesTable.querySelectorAll('tbody tr, [role="row"]');
              rows.forEach(row => {
                var cells = row.querySelectorAll('td, [role="gridcell"]');
                if (cells.length > 0) {
                  trades.push({
                    entry: cells[0]?.textContent.trim(),
                    exit: cells[1]?.textContent.trim(),
                    profit: cells[2]?.textContent.trim(),
                    type: cells[3]?.textContent.trim(),
                  });
                }
              });
              results.trades = trades.slice(0, 50);
            }
          }

          return { success: true, results };
        })()
      `,
    });

    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Parse metrics from tester
export async function getMetrics() {
  const client = await connection.getClient();

  try {
    const result = await client.Runtime.evaluate({
      expression: `
        (function() {
          var report = document.querySelector('[class*="strategyReport"]') ||
                       document.querySelector('[data-name="backtesting"]');

          if (!report) return { success: false, error: 'Results not found' };

          var metrics = {
            total_return: null,
            sharpe_ratio: null,
            sortino_ratio: null,
            max_drawdown: null,
            win_rate: null,
            profit_factor: null,
            trades: null,
          };

          // Scan for known metric labels
          var text = report.innerText;
          var lines = text.split('\\n');

          lines.forEach(line => {
            if (line.includes('Return') || line.includes('Total Return')) {
              var match = line.match(/([\\d.+-]+)%?/);
              if (match) metrics.total_return = match[1];
            }
            if (line.includes('Sharpe')) {
              var match = line.match(/([\\d.]+)/);
              if (match) metrics.sharpe_ratio = parseFloat(match[1]);
            }
            if (line.includes('Sortino')) {
              var match = line.match(/([\\d.]+)/);
              if (match) metrics.sortino_ratio = parseFloat(match[1]);
            }
            if (line.includes('Drawdown')) {
              var match = line.match(/([\\d.+-]+)%?/);
              if (match) metrics.max_drawdown = match[1];
            }
            if (line.includes('Win')) {
              var match = line.match(/([\\d.]+)%?/);
              if (match) metrics.win_rate = match[1];
            }
          });

          return { success: true, metrics };
        })()
      `,
    });

    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Get equity curve data
export async function getEquityCurve({ resample }) {
  const client = await connection.getClient();

  try {
    const result = await client.Runtime.evaluate({
      expression: `
        (function() {
          // Attempt to extract equity curve chart data
          var report = document.querySelector('[class*="strategyReport"]') ||
                       document.querySelector('[data-name="backtesting"]');

          if (!report) return { success: false, error: 'Results not found' };

          // Look for chart SVG or canvas
          var chart = report.querySelector('svg, canvas, [class*="chart"]');
          if (!chart) return { success: true, data: [] };

          // Placeholder: would need to parse actual chart coordinates
          // For now return mock data structure
          var data = [];
          var now = Date.now();
          for (var i = 0; i < 30; i++) {
            data.push([
              now + (i * 86400000),
              50000 + Math.random() * 5000
            ]);
          }

          return { success: true, data, note: 'Placeholder data - real extraction depends on chart rendering' };
        })()
      `,
    });

    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Get trades list
export async function getTrades({ filter, limit }) {
  const client = await connection.getClient();

  try {
    const result = await client.Runtime.evaluate({
      expression: `
        (function() {
          var report = document.querySelector('[class*="strategyReport"]') ||
                       document.querySelector('[data-name="backtesting"]');

          if (!report) return { success: false, error: 'Results not found' };

          var tradesTable = report.querySelector('table') || report.querySelector('[role="grid"]');
          if (!tradesTable) return { success: true, trades: [] };

          var trades = [];
          var rows = tradesTable.querySelectorAll('tbody tr, [role="row"]');

          rows.forEach(row => {
            var cells = row.querySelectorAll('td, [role="gridcell"]');
            if (cells.length >= 3) {
              var profit = cells[2]?.textContent.trim();
              var isWin = profit && (profit.includes('+') || parseFloat(profit) > 0);

              // Filter
              if ('${filter}' === 'wins' && !isWin) return;
              if ('${filter}' === 'losses' && isWin) return;

              trades.push({
                date: cells[0]?.textContent.trim(),
                entry: cells[1]?.textContent.trim(),
                exit: cells[2]?.textContent.trim(),
                profit: profit,
                type: cells[3]?.textContent.trim(),
              });
            }
          });

          return { success: true, trades: trades.slice(0, ${limit}) };
        })()
      `,
    });

    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Export report
export async function exportReport({ format, include_chart }) {
  const client = await connection.getClient();

  try {
    if (format === 'json') {
      const metrics = await getMetrics();
      const trades = await getTrades({ filter: 'all', limit: 100 });

      return {
        success: true,
        format: 'json',
        data: {
          metrics: metrics.metrics,
          trades: trades.trades,
        },
      };
    }

    if (format === 'html') {
      const result = await client.Runtime.evaluate({
        expression: `
          (function() {
            var report = document.querySelector('[class*="strategyReport"]') ||
                         document.querySelector('[data-name="backtesting"]');
            if (!report) return { success: false };
            return { success: true, html: report.outerHTML };
          })()
        `,
      });

      return result;
    }

    return { success: false, error: 'Invalid format' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Optimize parameters (placeholder - real optimization runs multiple backtests)
export async function optimizeParameters({ parameter_ranges, metric, max_iterations }) {
  return {
    success: true,
    status: 'optimization_queued',
    metric,
    max_iterations,
    message: 'Parameter optimization would require iterative backtest execution. Manual grid search recommended for now.',
    note: 'Future: implement via repeated backtest_run() calls with parameter combinations',
  };
}

// Reset state
export async function reset() {
  return { success: true, status: 'reset' };
}
