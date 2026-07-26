/** Read-only, restoring capture of the configured macro-event instruments. */
import crypto from 'node:crypto';
import * as chart from './chart.js';
import * as data from './data.js';

function resolve(deps = {}) {
  return {
    getState: deps.getState || chart.getState,
    setSymbol: deps.setSymbol || chart.setSymbol,
    setTimeframe: deps.setTimeframe || chart.setTimeframe,
    symbolInfo: deps.symbolInfo || chart.symbolInfo,
    getQuote: deps.getQuote || data.getQuote,
    getOhlcv: deps.getOhlcv || data.getOhlcv,
  };
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function requireReady(result, action) {
  if (!result || result.success === false || result.chart_ready !== true) {
    throw new Error(`macro chart ${action} did not become ready`);
  }
}

function normaliseBars(bars) {
  if (!Array.isArray(bars) || bars.length < 20) throw new Error('macro snapshot requires at least 20 one-minute bars');
  return bars.map((bar) => ({ ...bar, time: Number(bar.time) }));
}

function assertState(state, expected, label) {
  if (!state || state.symbol !== expected.symbol || String(state.resolution) !== String(expected.resolution)) {
    throw new Error(`macro chart ${label} state mismatch`);
  }
}

export async function captureMacroSnapshot({ config, eventId, phase, asOfUtc, deps } = {}) {
  if (!config?.assets || !eventId || !phase || !asOfUtc) throw new Error('config, eventId, phase, and asOfUtc are required');
  const api = resolve(deps);
  const original = await api.getState({});
  if (!original?.symbol || !original?.resolution) throw new Error('cannot determine original chart state');
  const assets = [];
  let captureError = null;
  try {
    for (const asset of config.assets) {
      requireReady(await api.setSymbol({ symbol: asset.provider_symbol }), `symbol switch to ${asset.provider_symbol}`);
      requireReady(await api.setTimeframe({ timeframe: '1' }), 'timeframe switch to 1');
      const info = await api.symbolInfo({});
      if (info.symbol !== asset.provider_symbol || info.full_name !== asset.expected_full_name || String(info.resolution) !== '1') {
        throw new Error(`macro identity mismatch for ${asset.provider_symbol}`);
      }
      const [quote, ohlcv] = await Promise.all([api.getQuote({}), api.getOhlcv({ count: 20 })]);
      const bars = normaliseBars(ohlcv.bars);
      const raw = { quote, bars };
      assets.push({ id: asset.id || asset.provider_symbol, provider_symbol: asset.provider_symbol,
        loaded_symbol: info.symbol, loaded_full_name: info.full_name, resolution: '1', quote, bars, raw_payload_hash: hash(raw) });
    }
  } catch (error) {
    captureError = error;
  } finally {
    try {
      requireReady(await api.setSymbol({ symbol: original.symbol }), 'symbol restoration');
      requireReady(await api.setTimeframe({ timeframe: String(original.resolution) }), 'timeframe restoration');
      assertState(await api.getState({}), original, 'final restoration');
    } catch (restoreError) {
      throw new Error(`macro chart restoration failed: ${restoreError.message}`);
    }
  }
  if (captureError) throw captureError;
  return { pipeline_mode: 'SHADOW', event_id: eventId, capture_phase: phase, as_of_utc: asOfUtc, assets };
}
