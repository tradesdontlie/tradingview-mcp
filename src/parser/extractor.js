/**
 * AST → Block[] extractor.
 * Walks the Pine AST and emits typed Block objects.
 *
 * Classification rules:
 *  - StrategyCall(entry) inside IfBlock → EntryBlock (condition from parent IfBlock)
 *  - StrategyCall(exit | close) → ExitBlock
 *  - StrategyCall(order) with qty → SizingBlock + entry intent
 *  - Assignment where RHS contains ta.* → IndicatorBlock
 *  - Assignment where name appears in entry conditions → FilterBlock (inferred)
 *  - Standalone Assignment with sizing pattern → SizingBlock
 *  - IfBlock without strategy calls whose body is a condition expression → FilterBlock
 *  - Everything else → RawPineBlock
 */

import { BlockType, Side, makeId } from './schema.js';

// Pine built-in indicator functions
const TA_FUNCTIONS = new Set([
  'ta.ema', 'ta.sma', 'ta.rma', 'ta.wma', 'ta.vwma',
  'ta.rsi', 'ta.macd', 'ta.stoch', 'ta.cci', 'ta.mfi',
  'ta.bb', 'ta.bbw', 'ta.kc', 'ta.atr', 'ta.tr',
  'ta.crossover', 'ta.crossunder', 'ta.cross',
  'ta.highest', 'ta.lowest', 'ta.highestbars', 'ta.lowestbars',
  'ta.dmi', 'ta.adx', 'ta.supertrend', 'ta.pivothigh', 'ta.pivotlow',
  'ta.valuewhen', 'ta.barssince', 'ta.cum', 'ta.change', 'ta.mom',
  'ta.percentrank', 'ta.percentile_linear_interpolation',
  'ta.hma', 'ta.linreg', 'ta.swma', 'ta.alma',
]);

// Sizing keywords that suggest position sizing logic
const SIZING_PATTERNS = [
  /strategy\.equity/,
  /math\.floor\s*\(/,
  /math\.round\s*\(/,
  /atr\b/i,
  /risk_pct/i,
  /position_size/i,
  /lot_size/i,
  /qty\b/,
];

export function extractBlocks(astNodes) {
  const ctx = {
    blocks: [],
    counts: {},
    // Map from variable name → block it was assigned in
    varMap: {},
    // Set of variable names referenced in entry conditions (populated on second pass)
    entryConditionVars: new Set(),
  };

  // First pass: collect all nodes into blocks
  walkNodes(astNodes, null, ctx);

  // Second pass: promote assignments referenced by entry conditions to FilterBlocks
  promoteFilters(ctx);

  return ctx.blocks;
}

function nextId(ctx, type) {
  ctx.counts[type] = (ctx.counts[type] || 0);
  const id = makeId(type, ctx.counts[type]);
  ctx.counts[type]++;
  return id;
}

function walkNodes(nodes, parentIf, ctx) {
  for (const node of nodes) {
    switch (node.nodeType) {
      case 'IfBlock':
        handleIfBlock(node, ctx);
        break;
      case 'Assignment':
      case 'VarDecl':
        handleAssignment(node, ctx);
        break;
      case 'StrategyCall':
        handleStrategyCall(node, null, ctx);
        break;
      case 'FuncDef':
        // Don't descend into function definitions — they're utilities
        ctx.blocks.push({
          type: BlockType.RAW_PINE,
          id: nextId(ctx, BlockType.RAW_PINE),
          note: 'User-defined function',
          sourceLines: node.tok.lines,
          rawSource: node.tok.text,
        });
        break;
      case 'LoopBlock':
        ctx.blocks.push({
          type: BlockType.RAW_PINE,
          id: nextId(ctx, BlockType.RAW_PINE),
          note: `${node.loopType.toLowerCase()} loop`,
          sourceLines: node.tok.lines,
          rawSource: node.tok.text,
        });
        break;
      case 'ScriptDecl':
      case 'Version':
      case 'Import':
      case 'Other':
        // Skip metadata nodes
        break;
      default:
        break;
    }
  }
}

function handleIfBlock(node, ctx) {
  const strategyCalls = collectStrategyCalls(node.body);

  if (strategyCalls.length === 0) {
    // Pure condition block — may be a filter variable being computed inside if
    // Emit as filter if condition is an expression, else RawPine
    if (node.condition && !node.condition.includes('strategy.')) {
      ctx.blocks.push({
        type: BlockType.FILTER,
        id: nextId(ctx, BlockType.FILTER),
        label: truncate(node.condition, 60),
        variableName: null,
        expression: node.condition,
        sourceLines: node.lines || node.tok.lines,
        rawSource: node.tok.text,
      });
    } else {
      ctx.blocks.push({
        type: BlockType.RAW_PINE,
        id: nextId(ctx, BlockType.RAW_PINE),
        note: 'Conditional block without strategy calls',
        sourceLines: node.lines || node.tok.lines,
        rawSource: node.tok.text,
      });
    }
    return;
  }

  // Has strategy calls — emit Entry/Exit blocks with condition
  for (const call of strategyCalls) {
    handleStrategyCall(call, node.condition, ctx);
  }

  // Handle else branch
  if (node.elseBranch && node.elseBranch.length > 0) {
    walkNodes(node.elseBranch, null, ctx);
  }
}

function handleStrategyCall(node, parentCondition, ctx) {
  const { subtype, text, args, tok } = node;

  switch (subtype) {
    case 'entry': {
      const id = nextId(ctx, BlockType.ENTRY);
      const label = args.positional[0]?.replace(/['"]/g, '') || id;
      const directionArg = args.positional[1] || args.named.direction || '';
      const side = directionArg.includes('long') ? Side.LONG
        : directionArg.includes('short') ? Side.SHORT
        : Side.UNKNOWN;

      const qtyExpr = args.named.qty || args.named.quantity || null;

      const condRaw = parentCondition || null;
      const conditions = condRaw ? splitConditions(condRaw) : [];

      // Track variable names used in this condition
      if (condRaw) {
        extractVarNames(condRaw).forEach(v => ctx.entryConditionVars.add(v));
      }

      ctx.blocks.push({
        type: BlockType.ENTRY,
        id,
        side,
        label,
        conditions,
        conditionRaw: condRaw,
        qtyExpr,
        sourceLines: tok.lines,
        rawSource: tok.text,
      });

      // Promote qty expression to SizingBlock if non-trivial
      if (qtyExpr && isSizingExpression(qtyExpr)) {
        const sizingId = nextId(ctx, BlockType.SIZING);
        ctx.blocks.push({
          type: BlockType.SIZING,
          id: sizingId,
          label: `Qty for ${label}`,
          method: classifySizingMethod(qtyExpr),
          expression: qtyExpr,
          sourceLines: tok.lines,
          rawSource: qtyExpr,
        });
      }
      break;
    }

    case 'exit': {
      const id = nextId(ctx, BlockType.EXIT);
      const label = args.positional[0]?.replace(/['"]/g, '') || id;
      const fromEntry = args.positional[1]?.replace(/['"]/g, '') || args.named.from_entry?.replace(/['"]/g, '') || null;

      ctx.blocks.push({
        type: BlockType.EXIT,
        id,
        label,
        fromEntry,
        stopExpr: args.named.stop || null,
        limitExpr: args.named.limit || null,
        trailExpr: args.named.trail_price || args.named.trail_offset || null,
        closeSignal: parentCondition || null,
        sourceLines: tok.lines,
        rawSource: tok.text,
      });
      break;
    }

    case 'close': {
      const id = nextId(ctx, BlockType.EXIT);
      const label = args.positional[0]?.replace(/['"]/g, '') || 'close';
      ctx.blocks.push({
        type: BlockType.EXIT,
        id,
        label,
        fromEntry: label !== 'close' ? label : null,
        stopExpr: null,
        limitExpr: null,
        trailExpr: null,
        closeSignal: parentCondition || null,
        sourceLines: tok.lines,
        rawSource: tok.text,
      });
      break;
    }

    case 'order': {
      // strategy.order is a lower-level entry/exit — treat as entry if direction given
      const id = nextId(ctx, BlockType.ENTRY);
      const label = args.positional[0]?.replace(/['"]/g, '') || id;
      const dirArg = args.named.direction || args.positional[1] || '';
      const side = dirArg.includes('long') ? Side.LONG
        : dirArg.includes('short') ? Side.SHORT
        : Side.UNKNOWN;

      ctx.blocks.push({
        type: BlockType.ENTRY,
        id,
        side,
        label,
        conditions: parentCondition ? splitConditions(parentCondition) : [],
        conditionRaw: parentCondition || null,
        qtyExpr: args.named.qty || args.positional[2] || null,
        sourceLines: tok.lines,
        rawSource: tok.text,
      });
      break;
    }

    default: {
      ctx.blocks.push({
        type: BlockType.RAW_PINE,
        id: nextId(ctx, BlockType.RAW_PINE),
        note: `strategy.${subtype} call`,
        sourceLines: tok.lines,
        rawSource: tok.text,
      });
      break;
    }
  }
}

function handleAssignment(node, ctx) {
  const text = node.text;

  // Determine variable name
  const varMatch = text.match(/^(?:var(?:ip)?\s+)?([a-zA-Z_]\w*)\s*:?=/);
  const varName = varMatch ? varMatch[1] : null;

  // Check if RHS contains a ta.* function call
  const taFunc = findTaFunction(text);
  if (taFunc) {
    const id = nextId(ctx, BlockType.INDICATOR);
    const block = {
      type: BlockType.INDICATOR,
      id,
      variableName: varName || id,
      function: taFunc,
      args: extractTaArgs(text, taFunc),
      expression: text,
      sourceLines: node.tok.lines,
      rawSource: text,
    };
    ctx.blocks.push(block);
    if (varName) ctx.varMap[varName] = block;
    return;
  }

  // Check if it looks like a sizing expression
  if (varName && isSizingExpression(text)) {
    const id = nextId(ctx, BlockType.SIZING);
    const block = {
      type: BlockType.SIZING,
      id,
      label: varName,
      method: classifySizingMethod(text),
      expression: text.replace(/^[^=]+=\s*/, '').trim(),
      sourceLines: node.tok.lines,
      rawSource: text,
    };
    ctx.blocks.push(block);
    if (varName) ctx.varMap[varName] = block;
    return;
  }

  // Store for potential filter promotion
  if (varName) {
    ctx.varMap[varName] = {
      type: BlockType.RAW_PINE,
      varName,
      text,
      tok: node.tok,
    };
  }
}

/** Second pass: promote variable assignments referenced in entry conditions to FilterBlocks */
function promoteFilters(ctx) {
  const entryVars = ctx.entryConditionVars;
  for (const [varName, entry] of Object.entries(ctx.varMap)) {
    if (!entryVars.has(varName)) continue;
    if (entry.type && entry.type !== BlockType.RAW_PINE) continue; // already classified

    // Is this a boolean-ish filter expression?
    const expr = entry.text?.replace(/^[^=]+=\s*/, '').trim() || '';
    if (looksLikeBooleanExpr(expr)) {
      const id = nextId(ctx, BlockType.FILTER);
      ctx.blocks.push({
        type: BlockType.FILTER,
        id,
        label: varName,
        variableName: varName,
        expression: expr,
        sourceLines: entry.tok.lines,
        rawSource: entry.text,
      });
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function collectStrategyCalls(nodes) {
  const calls = [];
  for (const n of nodes) {
    if (n.nodeType === 'StrategyCall') calls.push(n);
    if (n.nodeType === 'IfBlock') calls.push(...collectStrategyCalls(n.body));
  }
  return calls;
}

function splitConditions(condText) {
  return condText
    .split(/\s+and\s+|\s+or\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function extractVarNames(expr) {
  const names = new Set();
  const m = expr.match(/\b([a-zA-Z_]\w*)\b/g) || [];
  const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false', 'na', 'if', 'else',
    'for', 'while', 'close', 'open', 'high', 'low', 'volume', 'time',
    'bar_index', 'strategy', 'ta', 'math', 'array', 'matrix', 'color',
    'timeframe', 'syminfo', 'request', 'ticker', 'chart', 'plot', 'plotshape']);
  for (const name of m) {
    if (!KEYWORDS.has(name)) names.add(name);
  }
  return names;
}

function findTaFunction(text) {
  for (const fn of TA_FUNCTIONS) {
    if (text.includes(fn + '(')) return fn;
  }
  return null;
}

function extractTaArgs(text, taFunc) {
  const m = text.match(new RegExp(taFunc.replace('.', '\\.') + '\\s*\\(([^)]*)\\)'));
  if (!m) return [];
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
}

function isSizingExpression(expr) {
  return SIZING_PATTERNS.some(p => p.test(expr));
}

function classifySizingMethod(expr) {
  if (/\batr/i.test(expr)) return 'atr_based'; // check atr first (atr14, atr_14, etc.)
  if (/strategy\.equity/.test(expr) && /%/.test(expr)) return 'pct_equity';
  if (/strategy\.equity/.test(expr)) return 'pct_equity';
  if (/^\s*\d+(\.\d+)?\s*$/.test(expr.replace(/^[^=]+=\s*/, ''))) return 'fixed';
  return 'expression';
}

function looksLikeBooleanExpr(expr) {
  return (
    /[<>=!]/.test(expr) ||
    /\band\b/.test(expr) ||
    /\bor\b/.test(expr) ||
    /\bnot\b/.test(expr) ||
    /ta\.(crossover|crossunder|cross)\b/.test(expr) ||
    /\bna\b/.test(expr)
  );
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
