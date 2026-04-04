/**
 * Core trading panel logic — reads account, positions, orders, notifications,
 * and risk:reward tools from TradingView.
 */
import { evaluate } from '../connection.js';

/**
 * Read account summary from the trading panel header bar and Account Summary tab.
 */
export async function getAccount() {
  const result = await evaluate(`
    (function() {
      // 1. Header bar: Account Balance, Equity, Profit
      var fields = document.querySelectorAll('[class*="accountSummaryField"]');
      var header = {};
      for (var i = 0; i < fields.length; i++) {
        var title = fields[i].querySelector('[class*="title-"]');
        var value = fields[i].querySelector('[class*="value-"]');
        if (title && value) {
          var key = title.textContent.trim().toLowerCase().replace(/\\s+/g, '_');
          header[key] = value.textContent.trim();
        }
      }

      // 2. Account name/ID
      var acctEl = document.querySelector('[class*="accountName"]');
      if (acctEl) header.account_id = acctEl.textContent.trim();

      // 3. Broker name
      var brokerEl = document.querySelector('[class*="title-Xl5x6VBi"]');
      if (brokerEl) header.broker = brokerEl.textContent.trim();

      // 4. Detailed summary from Account Summary tab (ka-table, may be hidden)
      var bottomArea = document.querySelector('#bottom-area');
      if (bottomArea) {
        var tables = bottomArea.querySelectorAll('[class*="ka-table"]');
        for (var t = 0; t < tables.length; t++) {
          var headerCells = tables[t].querySelectorAll('.ka-thead-cell-content, [class*="headCellContent"]');
          var headers = [];
          for (var h = 0; h < headerCells.length; h++) {
            var hText = headerCells[h].textContent.trim();
            if (hText) headers.push(hText);
          }
          // Identify account summary table by its unique columns
          if (headers.indexOf('Net Liq') !== -1 || headers.indexOf('Available Margin') !== -1) {
            var rows = tables[t].querySelectorAll('.ka-row, [class*="ka-row"]');
            if (rows.length > 0) {
              var cells = rows[0].querySelectorAll('.ka-cell-text, [class*="ka-cell-text"]');
              for (var c = 0; c < cells.length && c < headers.length; c++) {
                var val = cells[c].textContent.trim();
                if (val && headers[c]) {
                  var key = headers[c].toLowerCase().replace(/\\s+/g, '_');
                  header[key] = val;
                }
              }
            }
            break;
          }
        }
      }

      return header;
    })()
  `);

  if (!result || Object.keys(result).length === 0) {
    return { success: false, error: 'Trading panel not found. Open the trading panel in TradingView first.' };
  }
  return { success: true, ...result };
}

/**
 * Read open positions from the Positions tab.
 */
export async function getPositions() {
  const result = await evaluate(`
    (function() {
      var bottomArea = document.querySelector('#bottom-area');
      if (!bottomArea) return { positions: [], error: 'Bottom panel not found' };

      var tables = bottomArea.querySelectorAll('[class*="ka-table"]');
      var positions = [];

      for (var t = 0; t < tables.length; t++) {
        var headerCells = tables[t].querySelectorAll('.ka-thead-cell-content, [class*="headCellContent"]');
        var headers = [];
        for (var h = 0; h < headerCells.length; h++) {
          var hText = headerCells[h].textContent.trim();
          if (hText) headers.push(hText);
        }

        // Identify positions table: has Position ID but NOT Order ID
        if (headers.indexOf('Position ID') !== -1 && headers.indexOf('Order ID') === -1) {
          var rows = tables[t].querySelectorAll('.ka-row, [class*="ka-row"]');
          for (var r = 0; r < rows.length; r++) {
            var cells = rows[r].querySelectorAll('.ka-cell-text, [class*="ka-cell-text"]');
            var pos = {};
            for (var c = 0; c < cells.length && c < headers.length; c++) {
              var val = cells[c].textContent.trim();
              if (val && headers[c]) {
                var key = headers[c].toLowerCase().replace(/\\s+/g, '_');
                pos[key] = val;
              }
            }
            if (pos.symbol) positions.push(pos);
          }
          break;
        }
      }

      return { positions: positions };
    })()
  `);

  return { success: true, count: result.positions.length, positions: result.positions };
}

/**
 * Read open/pending orders from the Orders tab.
 */
export async function getOrders() {
  const result = await evaluate(`
    (function() {
      var bottomArea = document.querySelector('#bottom-area');
      if (!bottomArea) return { orders: [], error: 'Bottom panel not found' };

      var tables = bottomArea.querySelectorAll('[class*="ka-table"]');
      var orders = [];

      for (var t = 0; t < tables.length; t++) {
        var headerCells = tables[t].querySelectorAll('.ka-thead-cell-content, [class*="headCellContent"]');
        var headers = [];
        for (var h = 0; h < headerCells.length; h++) {
          var hText = headerCells[h].textContent.trim();
          if (hText) headers.push(hText);
        }

        // Identify orders table: has Order ID column
        if (headers.indexOf('Order ID') !== -1) {
          var rows = tables[t].querySelectorAll('.ka-row, [class*="ka-row"]');
          for (var r = 0; r < rows.length; r++) {
            var cells = rows[r].querySelectorAll('.ka-cell-text, [class*="ka-cell-text"]');
            var order = {};
            for (var c = 0; c < cells.length && c < headers.length; c++) {
              var val = cells[c].textContent.trim();
              if (val && headers[c]) {
                var key = headers[c].toLowerCase().replace(/\\s+/g, '_');
                order[key] = val;
              }
            }
            if (order.symbol) orders.push(order);
          }
          break;
        }
      }

      return { orders: orders };
    })()
  `);

  return { success: true, count: result.orders.length, orders: result.orders };
}

/**
 * Read notification log entries from the Notifications log tab.
 */
export async function getNotifications({ limit = 50 } = {}) {
  const result = await evaluate(`
    (function() {
      var bottomArea = document.querySelector('#bottom-area');
      if (!bottomArea) return { notifications: [], error: 'Bottom panel not found' };

      var tables = bottomArea.querySelectorAll('[class*="ka-table"]');
      var notifications = [];
      var maxRows = ${limit};

      for (var t = 0; t < tables.length; t++) {
        var headerCells = tables[t].querySelectorAll('.ka-thead-cell-content, [class*="headCellContent"]');
        var headers = [];
        for (var h = 0; h < headerCells.length; h++) {
          var hText = headerCells[h].textContent.trim();
          if (hText) headers.push(hText);
        }

        // Identify notifications table: has Title + Text columns but not Position ID or Order ID
        if (headers.indexOf('Title') !== -1 && headers.indexOf('Text') !== -1 && headers.indexOf('Order ID') === -1) {
          var rows = tables[t].querySelectorAll('.ka-row, [class*="ka-row"]');
          for (var r = 0; r < rows.length && r < maxRows; r++) {
            var cells = rows[r].querySelectorAll('.ka-cell-text, [class*="ka-cell-text"]');
            var notif = {};
            for (var c = 0; c < cells.length && c < headers.length; c++) {
              var val = cells[c].textContent.trim();
              if (val && headers[c]) {
                var key = headers[c].toLowerCase().replace(/\\s+/g, '_');
                notif[key] = val;
              }
            }
            if (notif.title || notif.text) notifications.push(notif);
          }
          break;
        }
      }

      return { notifications: notifications };
    })()
  `);

  return { success: true, count: result.notifications.length, notifications: result.notifications };
}

/**
 * Read all Risk/Reward drawing tools from the chart.
 * Uses the line tools model for full price data, then optionally matches
 * against open positions and orders from the trading panel.
 */
export async function getRiskReward({ match = true } = {}) {
  // 1. Get all R:R tools via line tools API (has actual prices)
  const rrTools = await evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var m = chart.model().model();
      var allTools = m.allLineTools();
      var results = [];

      for (var i = 0; i < allTools.length; i++) {
        var tool = allTools[i];
        var name = '';
        try { name = tool.name(); } catch(e) { continue; }
        if (name.indexOf('Risk/reward') === -1) continue;

        var info = { name: name, id: tool.id() };

        try {
          var props = tool.properties();
          info.symbol = props.symbol ? props.symbol.value() : null;
          info.interval = props.interval ? props.interval.value() : null;
          info.entry_price = props.entryPrice ? props.entryPrice.value() : null;
          info.stop_price = props.stopPrice ? props.stopPrice.value() : null;
          info.target_price = props.targetPrice ? props.targetPrice.value() : null;
          info.stop_ticks = props.stopLevel ? props.stopLevel.value() : null;
          info.target_ticks = props.profitLevel ? props.profitLevel.value() : null;
          info.account_size = props.accountSize ? props.accountSize.value() : null;
          info.risk_pct = props.risk ? props.risk.value() : null;
          info.risk_amount = props.riskSize ? props.riskSize.value() : null;
          info.qty = props.qty ? props.qty.value() : null;
          info.amount_target = props.amountTarget ? props.amountTarget.value() : null;
          info.amount_stop = props.amountStop ? props.amountStop.value() : null;
          info.lot_size = props.lotSize ? props.lotSize.value() : null;
          info.visible = props.visible ? props.visible.value() : null;
          info.frozen = props.frozen ? props.frozen.value() : null;
          info.title = props.title ? props.title.value() : '';
        } catch(e) { info.props_error = e.message; }

        // Compute R:R ratio
        if (info.stop_ticks && info.target_ticks && info.stop_ticks > 0) {
          info.risk_reward_ratio = Math.round((info.target_ticks / info.stop_ticks) * 100) / 100;
        }

        // Determine direction
        info.direction = name.indexOf('long') !== -1 ? 'long' : 'short';

        results.push(info);
      }

      return results;
    })()
  `);

  if (!rrTools || rrTools.length === 0) {
    return { success: true, count: 0, risk_reward_tools: [], note: 'No Risk/Reward tools found on chart.' };
  }

  // 2. Optionally match against positions and orders
  if (match) {
    const positions = (await getPositions()).positions || [];
    const orders = (await getOrders()).orders || [];

    for (const rr of rrTools) {
      rr.matched_position = null;
      rr.matched_order = null;

      if (!rr.entry_price) continue;

      // Match positions by symbol + approximate entry price
      for (const pos of positions) {
        const posPrice = parseFloat((pos.avg_fill_price || '').replace(/[^0-9.\-]/g, ''));
        if (!posPrice) continue;
        const sameSide = (rr.direction === 'long' && pos.side === 'Buy') ||
                         (rr.direction === 'short' && pos.side === 'Sell');
        if (sameSide && Math.abs(posPrice - rr.entry_price) < rr.entry_price * 0.005) {
          rr.matched_position = pos;
          break;
        }
      }

      // Match orders by symbol + approximate limit/stop price
      for (const ord of orders) {
        const ordPrice = parseFloat((ord.limit_price || ord.stop_price || '').replace(/[^0-9.\-]/g, ''));
        if (!ordPrice) continue;
        const sameSide = (rr.direction === 'long' && ord.side === 'Buy') ||
                         (rr.direction === 'short' && ord.side === 'Sell');
        if (sameSide && Math.abs(ordPrice - rr.entry_price) < rr.entry_price * 0.005) {
          rr.matched_order = ord;
          break;
        }
      }
    }
  }

  return { success: true, count: rrTools.length, risk_reward_tools: rrTools };
}
