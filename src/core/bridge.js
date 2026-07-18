import { getState as getChartState } from './chart.js';
import { createTradingBridgeClient } from './ninjatrader.js';

const FUTURES_MONTH_CODES = 'FGHJKMNQUVXZ';

export function futuresRoot(symbol) {
  if (typeof symbol !== 'string') return null;
  const value = symbol.trim().toUpperCase().split(':').pop();
  if (!value) return null;

  const continuous = value.match(/^([A-Z]+)[12]!$/);
  if (continuous) return continuous[1];

  const exact = value.match(/^([A-Z]+)\s+\d{2}-\d{2}$/);
  if (exact) return exact[1];

  const compact = value.match(new RegExp(`^([A-Z]+)[${FUTURES_MONTH_CODES}](?:\\d{1,2}|\\d{4})$`));
  return compact?.[1] || null;
}

function instrumentOf(item) {
  return item?.instrument || item?.Instrument || item?.instrumentName || item?.InstrumentName || null;
}

export async function getBridgeContext({ _deps } = {}) {
  const chartState = _deps?.chartState || getChartState;
  const client = _deps?.client || createTradingBridgeClient();
  const [chart, status, connections, positions, orders] = await Promise.all([
    chartState(),
    client.status(),
    client.connections(),
    client.positions(),
    client.orders(),
  ]);

  const chartRoot = futuresRoot(chart.symbol);
  const instruments = [...new Set([
    ...(positions.positions || []).map(instrumentOf),
    ...(orders.orders || []).map(instrumentOf),
  ].filter(Boolean))];
  const compatibleInstruments = instruments.filter((instrument) => futuresRoot(instrument) === chartRoot);
  const otherInstruments = instruments.filter((instrument) => futuresRoot(instrument) !== chartRoot);

  return {
    success: true,
    tradingview: {
      symbol: chart.symbol,
      resolution: chart.resolution,
      chart_type: chart.chartType,
      futures_root: chartRoot,
      study_count: chart.studies?.length || 0,
    },
    ninjatrader: {
      bridge_status: status.status,
      bridge_version: status.version,
      bridge_mode: status.mode,
      data_feed_available: connections.hasAnyDataFeed === true,
      connection_count: connections.connections?.length || 0,
      position_count: positions.positions?.length || 0,
      order_count: orders.orders?.length || 0,
    },
    mapping: {
      compatible: chartRoot !== null && compatibleInstruments.length > 0,
      compatible_instruments: compatibleInstruments,
      other_instruments: otherInstruments,
    },
  };
}
