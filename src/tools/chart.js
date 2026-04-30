import { evaluate, evaluateAsync, getClient } from '../connection.js';
import { waitForChartReady } from '../wait.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

function jsonResult(obj, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
    ...(isError && { isError: true }),
  };
}

export function normalizeTimeframe(value) {
  if (value === undefined || value === null) {
    throw new Error('timeframe is required. Examples: 1, 5, 15, 60, 1h, 4h, D, W, M.');
  }

  const raw = String(value).trim();
  if (!raw) {
    throw new Error('timeframe cannot be empty. Examples: 1, 5, 15, 60, 1h, 4h, D, W, M.');
  }

  const compact = raw.replace(/\s+/g, '');

  if (/^\d+$/.test(compact)) {
    return compact;
  }

  if (compact === 'D' || compact === '1D') return 'D';
  if (compact === 'W' || compact === '1W') return 'W';
  if (compact === 'M' || compact === '1M') return 'M';

  const uppercasePeriod = compact.match(/^(\d+)([DWM])$/);
  if (uppercasePeriod) {
    const count = Number(uppercasePeriod[1]);
    const unit = uppercasePeriod[2];
    return count === 1 ? unit : `${count}${unit}`;
  }

  const lower = compact.toLowerCase();

  const minuteMatch = lower.match(/^(\d+)(m|min|mins|minute|minutes)$/);
  if (minuteMatch) {
    return minuteMatch[1];
  }

  const hourMatch = lower.match(/^(\d+)(h|hr|hrs|hour|hours)$/);
  if (hourMatch) {
    return String(Number(hourMatch[1]) * 60);
  }

  const dayMatch = lower.match(/^(\d+)?(d|day|days)$/);
  if (dayMatch) {
    const count = Number(dayMatch[1] || 1);
    return count === 1 ? 'D' : `${count}D`;
  }

  const weekMatch = lower.match(/^(\d+)?(w|wk|wks|week|weeks)$/);
  if (weekMatch) {
    const count = Number(weekMatch[1] || 1);
    return count === 1 ? 'W' : `${count}W`;
  }

  const monthMatch = lower.match(/^(\d+)?(mo|mon|month|months)$/);
  if (monthMatch) {
    const count = Number(monthMatch[1] || 1);
    return count === 1 ? 'M' : `${count}M`;
  }

  throw new Error(`Unsupported timeframe: ${raw}. Use minute counts, 1h/4h, D, W, or M.`);
}

function timeframesMatch(actual, expected) {
  try {
    return normalizeTimeframe(actual) === normalizeTimeframe(expected);
  } catch {
    return String(actual) === String(expected);
  }
}

export function registerChartTools(server) {

  server.tool('chart_get_state', 'Get current chart state (symbol, timeframe, chart type, indicators)', {}, async () => {
    try {
      const state = await evaluate(`
        (function() {
          var chart = ${CHART_API};
          var studies = [];
          try {
            var allStudies = chart.getAllStudies();
            studies = allStudies.map(function(s) {
              return { id: s.id, name: s.name || s.title || 'unknown' };
            });
          } catch(e) {}
          return {
            symbol: chart.symbol(),
            resolution: chart.resolution(),
            chartType: chart.chartType(),
            studies: studies,
          };
        })()
      `);

      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, ...state }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }],
        isError: true,
      };
    }
  });

  server.tool('chart_set_symbol', 'Change the chart symbol', {
    symbol: { type: 'string', description: 'Symbol to set (e.g., BTCUSD, AAPL, ES1!, NYMEX:CL1!)' },
  }, async ({ symbol }) => {
    try {
      if (!symbol || typeof symbol !== 'string') {
        return jsonResult({ success: false, error: 'symbol is required.' }, true);
      }

      const symbolLiteral = JSON.stringify(symbol.trim());
      await evaluateAsync(`
        (function() {
          var chart = ${CHART_API};
          return new Promise(function(resolve) {
            chart.setSymbol(${symbolLiteral}, {});
            // Give TV a moment to start the symbol change
            setTimeout(resolve, 500);
          });
        })()
      `);

      const ready = await waitForChartReady(symbol);
      const actual = await evaluate(`
        (function() {
          var chart = ${CHART_API};
          return { symbol: chart.symbol(), resolution: chart.resolution(), chartType: chart.chartType() };
        })()
      `);

      const requested = symbol.trim().toUpperCase();
      const actualSymbol = String(actual?.symbol || '').toUpperCase();
      const success = actualSymbol.length > 0 && (actualSymbol.includes(requested) || requested.includes(actualSymbol));
      return jsonResult({
        success,
        requested_symbol: symbol.trim(),
        actual_symbol: actual?.symbol,
        resolution: actual?.resolution,
        chartType: actual?.chartType,
        chart_ready: ready,
        error: success ? undefined : `TradingView reported symbol ${actual?.symbol ?? 'unknown'} after setting ${symbol.trim()}.`,
      }, !success);
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool('chart_set_timeframe', 'Change the chart timeframe/resolution', {
    timeframe: { type: 'string', description: 'Timeframe/resolution. Accepts minute counts or aliases like 1m, 5m, 1h, 4h, D, W, M.' },
  }, async ({ timeframe }) => {
    try {
      const requested = normalizeTimeframe(timeframe);
      const timeframeLiteral = JSON.stringify(requested);
      await evaluate(`
        (function() {
          var chart = ${CHART_API};
          chart.setResolution(${timeframeLiteral}, {});
        })()
      `);

      const ready = await waitForChartReady(null, requested);
      const actual = await evaluate(`
        (function() {
          var chart = ${CHART_API};
          return { symbol: chart.symbol(), resolution: chart.resolution(), chartType: chart.chartType() };
        })()
      `);

      const success = timeframesMatch(actual?.resolution, requested);
      return jsonResult({
        success,
        input_timeframe: timeframe,
        requested_resolution: requested,
        actual_resolution: actual?.resolution,
        symbol: actual?.symbol,
        chartType: actual?.chartType,
        chart_ready: ready,
        error: success ? undefined : `TradingView reported resolution ${actual?.resolution ?? 'unknown'} after setting ${requested}.`,
      }, !success);
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool('chart_set_type', 'Change chart type', {
    chart_type: { type: 'string', description: 'Chart type: Bars(0), Candles(1), Line(2), Area(3), Renko(4), Kagi(5), PointAndFigure(6), LineBreak(7), HeikinAshi(8), HollowCandles(9) — pass name or number' },
  }, async ({ chart_type }) => {
    try {
      const typeMap = {
        bars: 0,
        candles: 1,
        line: 2,
        area: 3,
        renko: 4,
        kagi: 5,
        pointandfigure: 6,
        linebreak: 7,
        heikinashi: 8,
        hollowcandles: 9,
      };
      const typeKey = String(chart_type).trim();
      const typeNum = typeMap[typeKey.replace(/\s+/g, '').toLowerCase()] ?? Number(typeKey);

      if (isNaN(typeNum)) {
        return jsonResult({
          success: false,
          error: `Unknown chart type: ${chart_type}. Use a name (Candles, Line, etc.) or number (0-9).`,
        }, true);
      }

      await evaluate(`
        (function() {
          var chart = ${CHART_API};
          chart.setChartType(${typeNum});
        })()
      `);

      const actual = await evaluate(`${CHART_API}.chartType()`);
      return jsonResult({ success: actual === typeNum, chart_type, type_num: typeNum, actual_chart_type: actual }, actual !== typeNum);
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool('chart_manage_indicator', 'Add or remove an indicator/study on the chart', {
    action: { type: 'string', description: 'Action: add or remove' },
    indicator: { type: 'string', description: 'Full indicator name: "Relative Strength Index", "MACD", "Volume", "Moving Average", "Bollinger Bands", "Moving Average Exponential". Short names like RSI/EMA do NOT work.' },
    entity_id: { type: 'string', description: 'Entity ID to remove (from chart_get_state). Required for remove.', default: '' },
    inputs: { type: 'object', description: 'Input overrides for the indicator (e.g., { length: 20 })', default: {} },
  }, async ({ action, indicator, entity_id, inputs }) => {
    try {
      if (action === 'add') {
        const inputArr = inputs ? Object.entries(inputs).map(([k, v]) => ({ id: k, value: v })) : [];
        // Get studies before adding
        const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);

        // createStudy callback doesn't always fire; use before/after diff
        await evaluate(`
          (function() {
            var chart = ${CHART_API};
            chart.createStudy('${indicator.replace(/'/g, "\\'")}', false, false, ${JSON.stringify(inputArr)});
          })()
        `);
        await new Promise(r => setTimeout(r, 1500));

        const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
        const newIds = (after || []).filter(id => !(before || []).includes(id));

        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: newIds.length > 0,
            action: 'add',
            indicator,
            entity_id: newIds[0] || null,
            new_study_count: newIds.length,
          }, null, 2) }],
        };
      } else if (action === 'remove') {
        if (!entity_id) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: 'entity_id required for remove action. Use chart_get_state to find study IDs.',
            }, null, 2) }],
            isError: true,
          };
        }

        await evaluate(`
          (function() {
            var chart = ${CHART_API};
            chart.removeEntity('${entity_id.replace(/'/g, "\\'")}');
          })()
        `);

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, action: 'remove', entity_id }, null, 2) }],
        };
      } else {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: false,
            error: 'action must be "add" or "remove"',
          }, null, 2) }],
          isError: true,
        };
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }],
        isError: true,
      };
    }
  });

  // ─── chart_get_visible_range ───────────────────────────────────────────
  server.tool('chart_get_visible_range', 'Get the visible date range (unix timestamps) and bars range on the chart', {}, async () => {
    try {
      const result = await evaluate(`
        (function() {
          var chart = ${CHART_API};
          return {
            visible_range: chart.getVisibleRange(),
            bars_range: chart.getVisibleBarsRange()
          };
        })()
      `);

      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true,
          visible_range: result.visible_range,
          bars_range: result.bars_range,
        }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }],
        isError: true,
      };
    }
  });

  // ─── chart_set_visible_range ───────────────────────────────────────────
  server.tool('chart_set_visible_range', 'Zoom the chart to a specific date range (unix timestamps)', {
    from: { type: 'number', description: 'Start of range (unix timestamp in seconds)' },
    to: { type: 'number', description: 'End of range (unix timestamp in seconds)' },
  }, async ({ from, to }) => {
    try {
      // setVisibleRange() throws "Not implemented" in TV Desktop.
      // Use timeScale().zoomToBarsRange() with bar index lookup instead.
      await evaluate(`
        (function() {
          var chart = ${CHART_API};
          var m = chart._chartWidget.model();
          var ts = m.timeScale();
          var bars = m.mainSeries().bars();
          // Find bar indices closest to the requested timestamps
          var startIdx = bars.firstIndex();
          var endIdx = bars.lastIndex();
          var fromIdx = startIdx, toIdx = endIdx;
          for (var i = startIdx; i <= endIdx; i++) {
            var v = bars.valueAt(i);
            if (v && v[0] >= ${from} && fromIdx === startIdx) fromIdx = i;
            if (v && v[0] <= ${to}) toIdx = i;
          }
          ts.zoomToBarsRange(fromIdx, toIdx);
        })()
      `);

      await new Promise(r => setTimeout(r, 500));

      const actual = await evaluate(`
        (function() {
          var chart = ${CHART_API};
          return chart.getVisibleRange();
        })()
      `);

      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true,
          requested: { from, to },
          actual: actual,
        }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }],
        isError: true,
      };
    }
  });

  // ─── chart_scroll_to_date ─────────────────────────────────────────────
  server.tool('chart_scroll_to_date', 'Jump the chart view to center on a specific date', {
    date: { type: 'string', description: 'ISO date string (e.g., "2024-01-15") or unix timestamp as a string' },
  }, async ({ date }) => {
    try {
      // Parse the date to a unix timestamp
      let timestamp;
      if (/^\d+$/.test(date)) {
        timestamp = Number(date);
      } else {
        timestamp = Math.floor(new Date(date).getTime() / 1000);
      }

      if (isNaN(timestamp)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: false,
            error: `Could not parse date: ${date}. Use ISO format (2024-01-15) or unix timestamp.`,
          }, null, 2) }],
          isError: true,
        };
      }

      // Get current resolution to calculate a reasonable window
      const resolution = await evaluate(`${CHART_API}.resolution()`);

      // Estimate seconds per bar based on resolution
      let secsPerBar = 60; // default 1 minute
      const res = String(resolution);
      if (res === 'D' || res === '1D') secsPerBar = 86400;
      else if (res === 'W' || res === '1W') secsPerBar = 604800;
      else if (res === 'M' || res === '1M') secsPerBar = 2592000;
      else {
        const mins = parseInt(res, 10);
        if (!isNaN(mins)) secsPerBar = mins * 60;
      }

      // Show ~50 bars centered on the target date
      // Use timeScale().zoomToBarsRange() since setVisibleRange is "Not implemented" in TV Desktop
      const halfWindow = 25 * secsPerBar;
      const from = timestamp - halfWindow;
      const to = timestamp + halfWindow;

      await evaluate(`
        (function() {
          var chart = ${CHART_API};
          var m = chart._chartWidget.model();
          var ts = m.timeScale();
          var bars = m.mainSeries().bars();
          var startIdx = bars.firstIndex();
          var endIdx = bars.lastIndex();
          var fromIdx = startIdx, toIdx = endIdx;
          for (var i = startIdx; i <= endIdx; i++) {
            var v = bars.valueAt(i);
            if (v && v[0] >= ${from} && fromIdx === startIdx) fromIdx = i;
            if (v && v[0] <= ${to}) toIdx = i;
          }
          ts.zoomToBarsRange(fromIdx, toIdx);
        })()
      `);

      await new Promise(r => setTimeout(r, 500));

      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true,
          date,
          centered_on: timestamp,
          resolution,
          window: { from, to },
        }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }],
        isError: true,
      };
    }
  });

  // ─── symbol_info ──────────────────────────────────────────────────────
  server.tool('symbol_info', 'Get detailed metadata about the current symbol (name, exchange, type, description)', {}, async () => {
    try {
      const result = await evaluate(`
        (function() {
          var chart = ${CHART_API};
          var info = chart.symbolExt();
          return {
            symbol: info.symbol,
            full_name: info.full_name,
            exchange: info.exchange,
            description: info.description,
            type: info.type,
            pro_name: info.pro_name,
            typespecs: info.typespecs,
            resolution: chart.resolution(),
            chart_type: chart.chartType()
          };
        })()
      `);

      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }],
        isError: true,
      };
    }
  });

  // ─── symbol_search ────────────────────────────────────────────────────
  server.tool('symbol_search', 'Search for symbols by name or keyword using the TradingView search dialog', {
    query: { type: 'string', description: 'Search query (e.g., "AAPL", "crude oil", "ES")' },
  }, async ({ query }) => {
    try {
      const client = await getClient();
      const { Input, Runtime } = client;

      // Click the symbol search button in the header toolbar
      await Runtime.evaluate({
        expression: `
          (function() {
            var btn = document.querySelector('[aria-label="Change symbol"]')
                   || document.querySelector('[data-name="symbol-button"]');
            if (btn) { btn.click(); return true; }
            // Fallback: click the symbol text in the legend/header
            var sym = document.querySelector('.chart-widget .pane .symbol-last');
            if (sym) { sym.click(); return true; }
            return false;
          })()
        `,
      });

      // Wait for dialog to appear
      await new Promise(r => setTimeout(r, 300));

      // Clear any existing text in the search input and type the query
      await Runtime.evaluate({
        expression: `
          (function() {
            var input = document.querySelector('[data-role="search"] input')
                     || document.querySelector('.dialogSearch input')
                     || document.querySelector('.search-ZXzPWcCf input')
                     || document.activeElement;
            if (input && input.tagName === 'INPUT') {
              input.value = '';
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.focus();
            }
          })()
        `,
      });

      await new Promise(r => setTimeout(r, 100));

      // Type the search query using CDP Input.insertText
      await Input.insertText({ text: query });

      // Wait for search results to populate
      await new Promise(r => setTimeout(r, 500));

      // Scrape the search results from the dialog
      const results = await Runtime.evaluate({
        expression: `
          (function() {
            var rows = document.querySelectorAll('[data-role="list-item"], .symbolRow-pnIJWxyD, .listRow, [class*="listRow"]');
            var out = [];
            for (var i = 0; i < Math.min(rows.length, 15); i++) {
              var row = rows[i];
              var symbolEl = row.querySelector('[class*="symbolNameText"], [class*="bold"], .highlight-GZaJnFcP, .symbolTitle-GZaJnFcP')
                          || row.querySelector('span:first-child');
              var descEl = row.querySelector('[class*="description"], [class*="lightText"], .symbolDescription-GZaJnFcP');
              var exchangeEl = row.querySelector('[class*="exchangeName"], [class*="exchange"], .exchangeName-GZaJnFcP');
              var typeEl = row.querySelector('[class*="typeText"], [class*="marketType"], .typeText-GZaJnFcP');

              var symbol = symbolEl ? symbolEl.textContent.trim() : '';
              var desc = descEl ? descEl.textContent.trim() : '';
              var exchange = exchangeEl ? exchangeEl.textContent.trim() : '';
              var type = typeEl ? typeEl.textContent.trim() : '';

              if (symbol) {
                out.push({ symbol: symbol, description: desc, exchange: exchange, type: type });
              }
            }
            return out;
          })()
        `,
        returnByValue: true,
      });

      // Close the dialog with Escape
      await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

      const searchResults = results.result.value || [];

      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true,
          query,
          results: searchResults,
          count: searchResults.length,
        }, null, 2) }],
      };
    } catch (err) {
      // Try to close the dialog if it's still open
      try {
        const client = await getClient();
        await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      } catch (_) {}

      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }],
        isError: true,
      };
    }
  });
}
