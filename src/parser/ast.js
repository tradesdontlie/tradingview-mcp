/**
 * Lightweight AST builder for Pine v5.
 * Converts a flat token array (from tokenizer) into a nested node tree
 * using indentation to determine block ownership.
 *
 * Node types:
 *   Version | ScriptDecl | Import | IfBlock | ElseBlock | ForBlock | WhileBlock
 *   FuncDef | Assignment | VarDecl | StrategyCall | Other
 */

import { TK } from './tokenizer.js';

export function buildAst(tokens) {
  const { nodes } = parseBlock(tokens, 0, -1);
  return nodes;
}

/**
 * Parse tokens starting at `start`, collecting nodes whose indent > `parentIndent`.
 * Returns { nodes, end } where end is the index of the first token NOT consumed.
 */
function parseBlock(tokens, start, parentIndent) {
  const nodes = [];
  let i = start;

  while (i < tokens.length) {
    const tok = tokens[i];

    // Stop if we've de-indented back to or below the parent level
    if (tok.indent <= parentIndent && parentIndent >= 0) break;

    switch (tok.type) {
      case TK.VERSION: {
        const m = tok.text.match(/\/\/@version\s*=\s*(\d+)/);
        nodes.push({ nodeType: 'Version', version: m ? parseInt(m[1], 10) : 5, tok });
        i++;
        break;
      }

      case TK.SCRIPT_DECL: {
        const kind = tok.text.startsWith('strategy') ? 'strategy'
          : tok.text.startsWith('indicator') ? 'indicator' : 'library';
        nodes.push({ nodeType: 'ScriptDecl', scriptType: kind, tok, params: parseCallArgs(tok.text) });
        i++;
        break;
      }

      case TK.IMPORT: {
        nodes.push({ nodeType: 'Import', tok });
        i++;
        break;
      }

      case TK.IF_STMT: {
        const condition = tok.text.replace(/^if\s+/, '').replace(/\s*$/, '');
        const { nodes: body, end } = parseBlock(tokens, i + 1, tok.indent);
        const { nodes: elseBranch, end: end2 } = consumeElse(tokens, end, tok.indent);
        nodes.push({
          nodeType: 'IfBlock',
          condition,
          body,
          elseBranch,
          tok,
          lines: collectLines(tok, body),
        });
        i = end2;
        break;
      }

      case TK.ELSE_IF_STMT: {
        // Treat as a sibling if; stop here and let parent consumeElse handle it
        break;
      }

      case TK.ELSE_STMT: {
        // Should be consumed by consumeElse, but if we see it here skip
        i++;
        break;
      }

      case TK.FOR_STMT:
      case TK.WHILE_STMT: {
        const { nodes: body, end } = parseBlock(tokens, i + 1, tok.indent);
        nodes.push({ nodeType: 'LoopBlock', loopType: tok.type, header: tok.text, body, tok });
        i = end;
        break;
      }

      case TK.FUNC_DEF: {
        const { nodes: body, end } = parseBlock(tokens, i + 1, tok.indent);
        nodes.push({ nodeType: 'FuncDef', header: tok.text, body, tok });
        i = end;
        break;
      }

      case TK.ASSIGNMENT: {
        nodes.push({ nodeType: 'Assignment', text: tok.text, tok });
        i++;
        break;
      }

      case TK.VAR_DECL: {
        nodes.push({ nodeType: 'VarDecl', text: tok.text, tok });
        i++;
        break;
      }

      case TK.STRATEGY_ENTRY:
      case TK.STRATEGY_EXIT:
      case TK.STRATEGY_CLOSE:
      case TK.STRATEGY_ORDER:
      case TK.STRATEGY_RISK:
      case TK.STRATEGY_OTHER: {
        const sub = tok.type.replace('STRATEGY_', '').toLowerCase();
        nodes.push({
          nodeType: 'StrategyCall',
          subtype: sub,
          text: tok.text,
          args: parseCallArgs(tok.text),
          tok,
        });
        i++;
        break;
      }

      default: {
        nodes.push({ nodeType: 'Other', text: tok.text, tok });
        i++;
        break;
      }
    }

    if (tok.type === TK.ELSE_IF_STMT) break; // propagate up
  }

  return { nodes, end: i };
}

function consumeElse(tokens, start, ifIndent) {
  if (start >= tokens.length) return { nodes: [], end: start };
  const tok = tokens[start];
  if (tok.indent !== ifIndent) return { nodes: [], end: start };
  if (tok.type === TK.ELSE_STMT) {
    const { nodes, end } = parseBlock(tokens, start + 1, ifIndent);
    return { nodes, end };
  }
  if (tok.type === TK.ELSE_IF_STMT) {
    const condition = tok.text.replace(/^else\s+if\s+/, '');
    const { nodes: body, end } = parseBlock(tokens, start + 1, ifIndent);
    const { nodes: elseBranch, end: end2 } = consumeElse(tokens, end, ifIndent);
    return {
      nodes: [{ nodeType: 'IfBlock', condition, body, elseBranch, tok, lines: collectLines(tok, body) }],
      end: end2,
    };
  }
  return { nodes: [], end: start };
}

function collectLines(tok, body) {
  const all = [...tok.lines];
  for (const n of body) {
    if (n.tok?.lines) all.push(...n.tok.lines);
  }
  return [Math.min(...all), Math.max(...all)];
}

/**
 * Extract positional and named arguments from a function call string.
 * Returns { positional: string[], named: Record<string, string> }
 */
export function parseCallArgs(callText) {
  const m = callText.match(/\((.+)\)\s*$/s);
  if (!m) return { positional: [], named: {} };

  const argsStr = m[1].trim();
  const parts = splitArgs(argsStr);

  const positional = [];
  const named = {};

  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq > 0 && /^[a-zA-Z_]\w*$/.test(part.slice(0, eq).trim())) {
      named[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    } else {
      positional.push(part.trim());
    }
  }

  return { positional, named };
}

/**
 * Split a comma-separated argument string respecting nested parens and strings.
 */
function splitArgs(str) {
  const parts = [];
  let depth = 0;
  let inStr = false;
  let strChar = '';
  let start = 0;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === strChar) inStr = false;
    } else if (ch === '"' || ch === "'") {
      inStr = true;
      strChar = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      parts.push(str.slice(start, i));
      start = i + 1;
    }
  }

  if (start < str.length) parts.push(str.slice(start));
  return parts.map(p => p.trim()).filter(Boolean);
}
