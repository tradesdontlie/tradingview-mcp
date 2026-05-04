import { useState, type FC } from 'react';
import type { Block } from '../types';

interface Props {
  block: Block;
  highlight?: boolean;
  onEdit?: (block: Block, newSource: string) => void;
}

const TYPE_COLORS: Record<string, string> = {
  Entry:     'bg-green-900/40 text-green-400 border-green-800',
  Exit:      'bg-red-900/40 text-red-400 border-red-800',
  Filter:    'bg-blue-900/40 text-blue-400 border-blue-800',
  Sizing:    'bg-purple-900/40 text-purple-400 border-purple-800',
  Indicator: 'bg-yellow-900/40 text-yellow-400 border-yellow-800',
  RawPine:   'bg-gray-800/40 text-gray-400 border-gray-700',
};

export const BlockCard: FC<Props> = ({ block, highlight, onEdit }) => {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editSource, setEditSource] = useState(block.rawSource);

  const colorClass = TYPE_COLORS[block.type] ?? TYPE_COLORS.RawPine;
  const lines = block.sourceLines;
  const lineRange = Array.isArray(lines) && lines.length === 2
    ? `L${lines[0]}–${lines[1]}`
    : lines?.length ? `L${lines[0]}` : '';

  function handleSave() {
    onEdit?.(block, editSource);
    setEditing(false);
  }

  return (
    <div
      className={`border rounded-lg overflow-hidden transition-all ${
        highlight ? 'ring-1 ring-accent-blue' : ''
      } ${colorClass}`}
    >
      {/* Header */}
      <button
        className="w-full flex items-center justify-between px-3 py-2 text-left"
        onClick={() => setExpanded(v => !v)}
      >
        <div className="flex items-center gap-2">
          <span className={`badge border ${colorClass} text-xs`}>{block.type}</span>
          <span className="text-sm font-medium">{blockTitle(block)}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-dim">
          {lineRange && <span>{lineRange}</span>}
          <span>{expanded ? '▲' : '▼'}</span>
        </div>
      </button>

      {/* Body */}
      {expanded && (
        <div className="px-3 pb-3 border-t border-current/20 bg-surface-0/40">
          {/* Block-specific detail */}
          <div className="pt-2 text-xs space-y-1">
            {renderDetails(block)}
          </div>

          {/* Source */}
          <div className="mt-3">
            {editing ? (
              <div className="flex flex-col gap-2">
                <textarea
                  className="w-full bg-surface-2 border border-subtle rounded p-2 font-mono text-xs text-gray-200 resize-y min-h-[80px]"
                  value={editSource}
                  onChange={e => setEditSource(e.target.value)}
                />
                <div className="flex gap-2 justify-end">
                  <button className="btn-ghost text-xs" onClick={() => setEditing(false)}>cancel</button>
                  <button className="btn-primary text-xs" onClick={handleSave}>generate diff →</button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <pre className="bg-surface-2 rounded p-2 text-xs overflow-x-auto text-gray-300 whitespace-pre-wrap">
                  {block.rawSource}
                </pre>
                {onEdit && (
                  <button
                    className="btn-ghost text-xs self-end"
                    onClick={() => { setEditSource(block.rawSource); setEditing(true); }}
                  >
                    edit block…
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

function blockTitle(block: Block): string {
  switch (block.type) {
    case 'Entry':     return `${block.label} (${block.side})`;
    case 'Exit':      return block.label + (block.fromEntry ? ` ← ${block.fromEntry}` : '');
    case 'Filter':    return block.variableName ?? block.label;
    case 'Sizing':    return `${block.label} [${block.method}]`;
    case 'Indicator': return `${block.variableName} = ${block.function}(${block.args.join(', ')})`;
    case 'RawPine':   return block.note;
    default:          return (block as Block).id;
  }
}

function renderDetails(block: Block) {
  switch (block.type) {
    case 'Entry':
      return (
        <>
          {block.conditions.length > 0 && (
            <div>
              <span className="text-dim">conditions:</span>
              <ul className="mt-1 space-y-0.5">
                {block.conditions.map((c, i) => (
                  <li key={i} className="pl-2 border-l-2 border-current/30">{c}</li>
                ))}
              </ul>
            </div>
          )}
          {block.qtyExpr && (
            <div><span className="text-dim">qty: </span>{block.qtyExpr}</div>
          )}
        </>
      );
    case 'Exit':
      return (
        <>
          {block.stopExpr  && <div><span className="text-dim">stop: </span>{block.stopExpr}</div>}
          {block.limitExpr && <div><span className="text-dim">limit: </span>{block.limitExpr}</div>}
          {block.trailExpr && <div><span className="text-dim">trail: </span>{block.trailExpr}</div>}
          {block.closeSignal && <div><span className="text-dim">signal: </span>{block.closeSignal}</div>}
        </>
      );
    case 'Filter':
      return <div><span className="text-dim">expr: </span>{block.expression}</div>;
    case 'Sizing':
      return (
        <>
          <div><span className="text-dim">method: </span>{block.method}</div>
          <div><span className="text-dim">expr: </span>{block.expression}</div>
        </>
      );
    case 'Indicator':
      return (
        <>
          <div><span className="text-dim">function: </span>{block.function}</div>
          <div><span className="text-dim">args: </span>{block.args.join(', ')}</div>
        </>
      );
    default:
      return null;
  }
}
