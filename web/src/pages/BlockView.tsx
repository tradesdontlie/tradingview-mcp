import { useState, type FC } from 'react';
import type { Block, ParsedScript, Proposal } from '../types';
import { parsePine } from '../api/client';
import { BlockCard } from '../components/BlockCard';
import { Link } from 'react-router-dom';

export const BlockView: FC = () => {
  const [source, setSource] = useState('');
  const [parsed, setParsed] = useState<ParsedScript | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDiff, setPendingDiff] = useState<{ block: Block; newSource: string } | null>(null);

  async function handleParse() {
    if (!source.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await parsePine(source);
      setParsed(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function handleEdit(block: Block, newSource: string) {
    setPendingDiff({ block, newSource });
  }

  function handleAcceptDiff() {
    if (!pendingDiff || !source) return;
    // Replace the old raw source with the new source in the Pine text
    const updated = source.replace(pendingDiff.block.rawSource, pendingDiff.newSource);
    setSource(updated);
    setPendingDiff(null);
    // Re-parse
    parsePine(updated).then(setParsed).catch(() => {});
  }

  const BLOCK_ORDER: Block['type'][] = ['Indicator', 'Filter', 'Sizing', 'Entry', 'Exit', 'RawPine'];

  const sortedBlocks = parsed
    ? [...parsed.blocks].sort((a, b) =>
        BLOCK_ORDER.indexOf(a.type) - BLOCK_ORDER.indexOf(b.type)
      )
    : [];

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Left: source editor */}
      <div className="w-1/2 flex flex-col border-r border-subtle">
        <div className="flex items-center justify-between px-4 py-3 border-b border-subtle">
          <span className="text-sm font-semibold">Pine Script Source</span>
          <Link to="/dashboard" className="btn-ghost text-xs">Dashboard →</Link>
        </div>
        <textarea
          className="flex-1 bg-surface-0 text-gray-200 font-mono text-xs p-4 resize-none focus:outline-none"
          placeholder={PLACEHOLDER}
          value={source}
          onChange={e => setSource(e.target.value)}
          spellCheck={false}
        />
        <div className="flex items-center gap-2 px-4 py-3 border-t border-subtle">
          <button
            className="btn-primary text-sm"
            onClick={handleParse}
            disabled={loading || !source.trim()}
          >
            {loading ? 'Parsing…' : 'Parse → Blocks'}
          </button>
          {parsed && (
            <span className="text-xs text-dim">
              {parsed.blockCount} blocks · {parsed.scriptType} "{parsed.name}"
            </span>
          )}
          {error && <span className="text-xs text-red-400">{error}</span>}
        </div>
      </div>

      {/* Right: block view */}
      <div className="w-1/2 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-subtle text-sm font-semibold">Block View</div>
        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
          {!parsed && (
            <div className="text-dim text-xs text-center py-12">
              Paste a Pine v5 strategy and click Parse
            </div>
          )}

          {/* Pending diff review */}
          {pendingDiff && (
            <div className="card border-accent-blue/50 mb-2">
              <div className="text-xs font-semibold mb-2">Pending edit — {pendingDiff.block.id}</div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <div className="text-red-400 mb-1">— before</div>
                  <pre className="bg-red-950/20 p-2 rounded overflow-x-auto text-red-200 whitespace-pre-wrap">
                    {pendingDiff.block.rawSource}
                  </pre>
                </div>
                <div>
                  <div className="text-green-400 mb-1">+ after</div>
                  <pre className="bg-green-950/20 p-2 rounded overflow-x-auto text-green-200 whitespace-pre-wrap">
                    {pendingDiff.newSource}
                  </pre>
                </div>
              </div>
              <div className="flex gap-2 justify-end mt-3">
                <button className="btn-ghost text-xs" onClick={() => setPendingDiff(null)}>discard</button>
                <button className="btn-primary text-xs" onClick={handleAcceptDiff}>apply to source</button>
              </div>
            </div>
          )}

          {sortedBlocks.map(block => (
            <BlockCard
              key={block.id}
              block={block}
              onEdit={handleEdit}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

const PLACEHOLDER = `//@version=5
strategy("My Strategy", overlay=true, initial_capital=10000)

// Paste your Pine v5 strategy here...`;
