/**
 * Pine v5 tokenizer.
 * Splits source into an array of Token objects, each representing one logical line.
 * Multi-line calls (unclosed parentheses) are joined into a single token.
 */

export const TK = {
  BLANK: 'BLANK',
  COMMENT: 'COMMENT',
  VERSION: 'VERSION',
  SCRIPT_DECL: 'SCRIPT_DECL',
  IMPORT: 'IMPORT',
  ASSIGNMENT: 'ASSIGNMENT',
  VAR_DECL: 'VAR_DECL',
  IF_STMT: 'IF_STMT',
  ELSE_STMT: 'ELSE_STMT',
  ELSE_IF_STMT: 'ELSE_IF_STMT',
  FOR_STMT: 'FOR_STMT',
  WHILE_STMT: 'WHILE_STMT',
  SWITCH_STMT: 'SWITCH_STMT',
  FUNC_DEF: 'FUNC_DEF',
  STRATEGY_ENTRY: 'STRATEGY_ENTRY',
  STRATEGY_EXIT: 'STRATEGY_EXIT',
  STRATEGY_CLOSE: 'STRATEGY_CLOSE',
  STRATEGY_ORDER: 'STRATEGY_ORDER',
  STRATEGY_RISK: 'STRATEGY_RISK',
  STRATEGY_OTHER: 'STRATEGY_OTHER',
  OTHER: 'OTHER',
};

/** @typedef {{ type: string, text: string, indent: number, lines: number[] }} Token */

/**
 * @param {string} source - Pine v5 source code
 * @returns {Token[]}
 */
export function tokenize(source) {
  const rawLines = source.split('\n');
  const joined = joinContinuations(rawLines);
  return joined
    .map(({ text, origLines }) => {
      const indent = leadingSpaces(text);
      const trimmed = text.trim();
      return {
        type: classifyLine(trimmed),
        text: trimmed,
        indent,
        lines: origLines,
      };
    })
    .filter(t => t.type !== TK.BLANK && t.type !== TK.COMMENT);
}

function leadingSpaces(line) {
  const m = line.match(/^(\s*)/);
  return m ? m[1].replace(/\t/g, '    ').length : 0;
}

/**
 * Join lines that are continuations of unclosed parentheses.
 * Returns array of { text: string, origLines: number[] }.
 */
function joinContinuations(lines) {
  const result = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const origLines = [i + 1];
    let depth = parenDepth(line);
    let combined = line;

    // Only join if the first line has non-trivial content and unclosed parens
    const trimmedFirst = line.trim();
    if (depth > 0 && trimmedFirst && !trimmedFirst.startsWith('//')) {
      while (depth > 0 && i + 1 < lines.length) {
        i++;
        const next = lines[i];
        combined += ' ' + next.trim();
        origLines.push(i + 1);
        depth += parenDepth(next);
      }
    }

    result.push({ text: combined, origLines });
    i++;
  }

  return result;
}

/**
 * Count net open parens in a line, ignoring string contents and comments.
 */
function parenDepth(line) {
  let depth = 0;
  let inStr = false;
  let strChar = '';

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; } // escape
      if (ch === strChar) inStr = false;
    } else if (ch === '"' || ch === "'") {
      inStr = true;
      strChar = ch;
    } else if (ch === '/' && line[i + 1] === '/') {
      break; // line comment
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    }
  }

  return depth;
}

function classifyLine(t) {
  if (!t) return TK.BLANK;

  // Comments
  if (t.startsWith('//@version')) return TK.VERSION;
  if (t.startsWith('//')) return TK.COMMENT;

  // Script declarations (may appear indented in some styles, but typically top-level)
  if (/^strategy\s*\(/.test(t)) return TK.SCRIPT_DECL;
  if (/^indicator\s*\(/.test(t)) return TK.SCRIPT_DECL;
  if (/^library\s*\(/.test(t)) return TK.SCRIPT_DECL;

  // Import
  if (/^import\s+/.test(t)) return TK.IMPORT;

  // Strategy sub-calls — check before generic ASSIGNMENT
  if (/^strategy\.entry\s*\(/.test(t)) return TK.STRATEGY_ENTRY;
  if (/^strategy\.exit\s*\(/.test(t)) return TK.STRATEGY_EXIT;
  if (/^strategy\.close_all\s*\(/.test(t)) return TK.STRATEGY_CLOSE;
  if (/^strategy\.close\s*\(/.test(t)) return TK.STRATEGY_CLOSE;
  if (/^strategy\.order\s*\(/.test(t)) return TK.STRATEGY_ORDER;
  if (/^strategy\.risk\./.test(t)) return TK.STRATEGY_RISK;
  if (/^strategy\./.test(t)) return TK.STRATEGY_OTHER;

  // Control flow
  if (/^if\s+/.test(t) || t === 'if') return TK.IF_STMT;
  if (/^else\s+if\b/.test(t)) return TK.ELSE_IF_STMT;
  if (/^else\b/.test(t)) return TK.ELSE_STMT;
  if (/^for\s+/.test(t)) return TK.FOR_STMT;
  if (/^while\s+/.test(t)) return TK.WHILE_STMT;
  if (/^switch\b/.test(t)) return TK.SWITCH_STMT;

  // Function definition: name(params) => or name(params) =>
  if (/^[a-zA-Z_]\w*\s*\([^)]*\)\s*=>/.test(t)) return TK.FUNC_DEF;

  // Variable declarations and assignments
  if (/^var(ip)?\s+[a-zA-Z_]/.test(t)) return TK.VAR_DECL;
  if (/^[a-zA-Z_]\w*(\.[a-zA-Z_]\w*)*\s*(:?=)/.test(t)) return TK.ASSIGNMENT;

  return TK.OTHER;
}
