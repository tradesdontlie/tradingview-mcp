/**
 * MCP client wrapper for TradingView data collection.
 *
 * Spawns src/server.js as a stdio subprocess and calls tools through the
 * MCP protocol. Every tool call has timeout protection.
 *
 * Phase 1 (preferred, no chart mutation):
 *   Tries data_get_ohlcv with a timeframe argument. If the tool supports it,
 *   all four TF bar sets are collected without touching the visible chart.
 *
 * Phase 2 (fallback, temporary chart mutation):
 *   If Phase 1 probe fails, callers use setTimeframe()/fetchAllTfsWithChartChange()
 *   and MUST restore chart state in a finally block.
 *
 * @module mcpDataProvider
 */

import { Client }               from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath }        from 'url';
import { dirname, join }        from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Timeframe label → TradingView resolution string */
export const TF_TV = { '4H': '240', '1H': '60', '15m': '15', '5m': '5' };

/**
 * Normalises a raw MCP bar object to the shape the engines expect.
 * Exported for unit testing.
 *
 * @param {object} b
 * @returns {{ ts:number, open:number, high:number, low:number, close:number, vol:number }}
 */
export function normalizeBar(b) {
  if (!b || typeof b !== 'object') {
    return { ts: 0, open: 0, high: 0, low: 0, close: 0, vol: 0 };
  }
  const tsRaw = b.time ?? b.ts ?? b.timestamp ?? 0;
  return {
    ts:    tsRaw < 1e12 ? tsRaw * 1000 : tsRaw,  // seconds → ms
    open:  b.open   ?? b.o ?? 0,
    high:  b.high   ?? b.h ?? 0,
    low:   b.low    ?? b.l ?? 0,
    close: b.close  ?? b.c ?? 0,
    vol:   b.volume ?? b.vol ?? b.v ?? 0,
  };
}

function parseBars(result) {
  if (!result?.success) return null;
  const raw = result.bars ?? result.data ?? result.ohlcv ?? [];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw.map(normalizeBar).filter(b => b.close > 0);
}

export class McpDataProvider {
  constructor() {
    this._client    = null;
    this._transport = null;
  }

  /**
   * Spawns src/server.js and performs the MCP handshake.
   * Throws if connection or handshake fails within timeoutMs.
   *
   * @param {number} [timeoutMs=15000]
   */
  async connect(timeoutMs = 15_000) {
    this._transport = new StdioClientTransport({
      command: 'node',
      args:    [join(__dirname, '..', 'src', 'server.js')],
      env:     process.env,
      cwd:     join(__dirname, '..'),
    });
    this._client = new Client(
      { name: 'scan-cli', version: '0.1.0' },
      { capabilities: {} },
    );
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`MCP connect timed out after ${timeoutMs}ms`)), timeoutMs),
    );
    await Promise.race([this._client.connect(this._transport), timeout]);
  }

  /** Closes the MCP client and kills the subprocess. Safe to call on a failed connect. */
  async disconnect() {
    try { await this._client?.close?.();     } catch { /* ignore */ }
    try { await this._transport?.close?.();  } catch { /* ignore */ }
  }

  /**
   * Calls a named MCP tool with timeout protection.
   * Returns the parsed JSON result, or null on any error.
   *
   * @param {string} name
   * @param {object} [args={}]
   * @param {number} [timeoutMs=10000]
   * @returns {Promise<object|null>}
   */
  async callTool(name, args = {}, timeoutMs = 10_000) {
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs),
    );
    const call = this._client.callTool({ name, arguments: args }).then(res => {
      const text = res?.content?.[0]?.text;
      if (!text) return null;
      try { return JSON.parse(text); } catch { return null; }
    });
    return Promise.race([call, timeout]);
  }

  /** Returns true if TradingView is reachable. */
  async healthCheck() {
    try {
      const r = await this.callTool('tv_health_check', {});
      return r?.success === true;
    } catch { return false; }
  }

  /**
   * Returns the current chart symbol and timeframe, or null.
   * @returns {Promise<{symbol:string, timeframe:string}|null>}
   */
  async getChartState() {
    try {
      const r = await this.callTool('chart_get_state', {});
      if (!r?.success) return null;
      return {
        symbol:    r.symbol    ?? r.ticker     ?? null,
        timeframe: r.timeframe ?? r.resolution ?? null,
      };
    } catch { return null; }
  }

  /** Switches the chart symbol. */
  async setSymbol(symbol) {
    await this.callTool('chart_set_symbol', { symbol });
  }

  /**
   * Switches the chart timeframe.
   * @param {string} timeframe - TradingView resolution string e.g. '240'
   */
  async setTimeframe(timeframe) {
    await this.callTool('chart_set_timeframe', { timeframe });
  }

  /**
   * Fetches bars for the CURRENT chart timeframe.
   * @param {number} [count=100]
   * @returns {Promise<Array|null>}
   */
  async getOhlcv(count = 100) {
    try {
      const r = await this.callTool('data_get_ohlcv', { count });
      return parseBars(r);
    } catch { return null; }
  }

  /**
   * Attempts to fetch bars for a specific TF by passing timeframe as a param.
   * Returns null if the tool does not support the timeframe argument.
   *
   * @param {string} tvTimeframe - e.g. '240'
   * @param {number} [count=100]
   * @returns {Promise<Array|null>}
   */
  async getOhlcvWithTimeframeParam(tvTimeframe, count = 100) {
    try {
      const r = await this.callTool('data_get_ohlcv', { timeframe: tvTimeframe, count });
      return parseBars(r);
    } catch { return null; }
  }

  /**
   * Probes whether data_get_ohlcv supports a timeframe argument.
   * Calls for two different TFs and checks that bars are returned for both.
   * Does not verify that the returned bars actually span the requested interval
   * (interval verification can be added in a future phase if needed).
   *
   * @returns {Promise<boolean>}
   */
  async probeTimeframeParam() {
    const bars4h = await this.getOhlcvWithTimeframeParam('240', 5);
    const bars5m = await this.getOhlcvWithTimeframeParam('5',   5);
    return bars4h !== null && bars4h.length >= 3
        && bars5m !== null && bars5m.length >= 3;
  }

  /**
   * Phase 1: Collects all 4 TFs using the timeframe param (no chart mutation).
   * Returns null if any TF returns fewer than 10 bars.
   *
   * @returns {Promise<object|null>} ohlcvByTimeframe or null
   */
  async fetchAllTfsWithParam() {
    const ohlcvByTimeframe = {};
    for (const [label, tvTf] of Object.entries(TF_TV)) {
      const bars = await this.getOhlcvWithTimeframeParam(tvTf, 100);
      if (!bars || bars.length < 10) return null;
      ohlcvByTimeframe[label] = bars;
    }
    return ohlcvByTimeframe;
  }

  /**
   * Phase 2: Collects all 4 TFs by temporarily setting chart_set_timeframe.
   *
   * IMPORTANT: This mutates the visible chart. The CALLER must restore the
   * original chart state in a finally block via restoreState().
   *
   * @returns {Promise<object|null>} ohlcvByTimeframe or null
   */
  async fetchAllTfsWithChartChange() {
    const ohlcvByTimeframe = {};
    for (const [label, tvTf] of Object.entries(TF_TV)) {
      await this.setTimeframe(tvTf);
      const bars = await this.getOhlcv(100);
      if (!bars || bars.length < 10) return null;
      ohlcvByTimeframe[label] = bars;
    }
    return ohlcvByTimeframe;
  }

  /**
   * Restores chart symbol and timeframe to a previously saved state.
   * Safe to call with null. Swallows errors so it never throws in a finally.
   *
   * @param {{ symbol:string, timeframe:string }|null} savedState
   */
  async restoreState(savedState) {
    if (!savedState) return;
    try { if (savedState.symbol)    await this.setSymbol(savedState.symbol);       } catch { /* ignore */ }
    try { if (savedState.timeframe) await this.setTimeframe(savedState.timeframe); } catch { /* ignore */ }
  }

  /**
   * Returns the current price quote, or null.
   * @returns {Promise<object|null>}
   */
  async getQuote() {
    try {
      const r = await this.callTool('quote_get', {});
      return r?.success ? r : null;
    } catch { return null; }
  }
}
