/**
 * Public API: parse(source) → ParsedScript
 *
 * Three worked examples at the bottom of this file show real v5 Pine scripts
 * and the block representation they produce.
 */

import { tokenize } from './tokenizer.js';
import { buildAst } from './ast.js';
import { extractBlocks } from './extractor.js';
import { ScriptType } from './schema.js';

/**
 * @param {string} source - Pine v5 source code
 * @returns {ParsedScript}
 */
export function parse(source) {
  const tokens = tokenize(source);
  const ast = buildAst(tokens);
  const blocks = extractBlocks(ast);

  const meta = extractMeta(ast);

  return {
    version: meta.version,
    scriptType: meta.scriptType,
    name: meta.name,
    params: meta.params,
    blocks,
    blockCount: blocks.length,
  };
}

function extractMeta(ast) {
  let version = 5;
  let scriptType = ScriptType.STRATEGY;
  let name = 'Unnamed';
  let params = {};

  for (const node of ast) {
    if (node.nodeType === 'Version') {
      version = node.version;
    } else if (node.nodeType === 'ScriptDecl') {
      scriptType = node.scriptType;
      const title = node.params.positional[0] || node.params.named.title;
      if (title) name = title.replace(/['"]/g, '');
      // Collect additional params
      const { positional: _p, ...rest } = node.params;
      params = node.params.named;
    }
  }

  return { version, scriptType, name, params };
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKED EXAMPLES
// These are documented here and exercised in tests/parser.test.js
// ─────────────────────────────────────────────────────────────────────────────

/**
 * EXAMPLE 1 — EMA Crossover Strategy
 *
 * Source:
 *   //@version=5
 *   strategy("EMA Cross", overlay=true, initial_capital=10000)
 *   fast = ta.ema(close, 9)
 *   slow = ta.ema(close, 21)
 *   if ta.crossover(fast, slow)
 *       strategy.entry("Long", strategy.long)
 *   if ta.crossunder(fast, slow)
 *       strategy.close("Long")
 *
 * Expected blocks:
 *   [
 *     { type: "Indicator", variableName: "fast", function: "ta.ema", args: ["close", "9"] },
 *     { type: "Indicator", variableName: "slow", function: "ta.ema", args: ["close", "21"] },
 *     { type: "Entry", side: "long", label: "Long", conditions: ["ta.crossover(fast, slow)"],
 *       conditionRaw: "ta.crossover(fast, slow)" },
 *     { type: "Exit", label: "Long", fromEntry: "Long", closeSignal: "ta.crossunder(fast, slow)" }
 *   ]
 */

/**
 * EXAMPLE 2 — RSI Mean Reversion with ATR Sizing
 *
 * Source:
 *   //@version=5
 *   strategy("RSI Reversion", overlay=false, initial_capital=10000,
 *            default_qty_type=strategy.percent_of_equity)
 *   rsi = ta.rsi(close, 14)
 *   atr14 = ta.atr(14)
 *   in_session = (hour >= 9) and (hour < 16)
 *   qty = math.floor(strategy.equity * 0.02 / (close * atr14))
 *   if rsi < 30 and in_session
 *       strategy.entry("Long", strategy.long, qty=qty)
 *   if rsi > 70 and in_session
 *       strategy.entry("Short", strategy.short, qty=qty)
 *   strategy.exit("Long TP/SL", "Long", stop=close - 2*atr14, limit=close + 3*atr14)
 *   strategy.exit("Short TP/SL", "Short", stop=close + 2*atr14, limit=close - 3*atr14)
 *
 * Expected blocks:
 *   [
 *     { type: "Indicator", variableName: "rsi",   function: "ta.rsi", args: ["close", "14"] },
 *     { type: "Indicator", variableName: "atr14", function: "ta.atr", args: ["14"] },
 *     { type: "Filter",    variableName: "in_session", expression: "(hour >= 9) and (hour < 16)" },
 *     { type: "Sizing",    label: "qty", method: "atr_based",
 *       expression: "math.floor(strategy.equity * 0.02 / (close * atr14))" },
 *     { type: "Entry", side: "long",  label: "Long",
 *       conditions: ["rsi < 30", "in_session"], conditionRaw: "rsi < 30 and in_session" },
 *     { type: "Entry", side: "short", label: "Short",
 *       conditions: ["rsi > 70", "in_session"], conditionRaw: "rsi > 70 and in_session" },
 *     { type: "Exit", label: "Long TP/SL",  fromEntry: "Long",
 *       stopExpr: "close - 2*atr14", limitExpr: "close + 3*atr14" },
 *     { type: "Exit", label: "Short TP/SL", fromEntry: "Short",
 *       stopExpr: "close + 2*atr14", limitExpr: "close - 3*atr14" }
 *   ]
 */

/**
 * EXAMPLE 3 — Multi-Filter Breakout with Regime Gate
 *
 * Source:
 *   //@version=5
 *   strategy("Breakout + Regime", overlay=true)
 *   ema200  = ta.ema(close, 200)
 *   atr     = ta.atr(14)
 *   adx_val = ta.dmi(14, 14).adx
 *   hh20    = ta.highest(high, 20)
 *   trend_ok   = close > ema200
 *   trending   = adx_val > 25
 *   breakout   = close > hh20[1]
 *   if trend_ok and trending and breakout
 *       strategy.entry("BO Long", strategy.long)
 *   strategy.exit("BO Long Exit", "BO Long",
 *                 stop=close - 2 * atr,
 *                 trail_price=close + 3 * atr,
 *                 trail_offset=atr)
 *
 * Expected blocks:
 *   [
 *     { type: "Indicator", variableName: "ema200",  function: "ta.ema" },
 *     { type: "Indicator", variableName: "atr",     function: "ta.atr" },
 *     { type: "Indicator", variableName: "adx_val", function: "ta.dmi" },
 *     { type: "Indicator", variableName: "hh20",    function: "ta.highest" },
 *     { type: "Filter", variableName: "trend_ok",  expression: "close > ema200" },
 *     { type: "Filter", variableName: "trending",  expression: "adx_val > 25" },
 *     { type: "Filter", variableName: "breakout",  expression: "close > hh20[1]" },
 *     { type: "Entry", side: "long", label: "BO Long",
 *       conditions: ["trend_ok", "trending", "breakout"] },
 *     { type: "Exit", label: "BO Long Exit", fromEntry: "BO Long",
 *       stopExpr: "close - 2 * atr", trailExpr: "close + 3 * atr" }
 *   ]
 */
