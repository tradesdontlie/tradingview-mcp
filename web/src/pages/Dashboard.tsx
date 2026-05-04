import { useEffect, useState, type FC } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import type { BenchmarkResult, Proposal } from '../types';
import { getBenchmark, listBenchmarks } from '../api/client';
import { ScoreGauge } from '../components/ScoreGauge';
import { DimensionCard } from '../components/DimensionCard';
import { EquityCurve } from '../components/EquityCurve';
import { ImproveSidebar } from '../components/ImproveSidebar';

type BenchmarkSummary = Awaited<ReturnType<typeof listBenchmarks>>[0];

export const Dashboard: FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [result, setResult] = useState<BenchmarkResult | null>(null);
  const [history, setHistory] = useState<BenchmarkSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showImprove, setShowImprove] = useState(false);

  useEffect(() => {
    listBenchmarks({ limit: 20 }).then(setHistory).catch(() => {});
  }, []);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    getBenchmark(id)
      .then(setResult)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  function handleApplyProposal(proposal: Proposal) {
    // The diff is surfaced to the user; Pine changes would go through MCP pine_set_source.
    // For now, copy the new source to clipboard as the human-in-the-loop step.
    if (proposal.pineDiff?.new) {
      navigator.clipboard.writeText(proposal.pineDiff.new).catch(() => {});
    }
    setShowImprove(false);
    alert(`Proposal "${proposal.title}" ready — new Pine snippet copied to clipboard. Paste into Pine Editor and run a new benchmark.`);
  }

  const equity = (result?.scores.returns.evidence as { equityCurve?: BenchmarkResult['scores']['returns']['evidence'][] })?.equityCurve as Parameters<typeof EquityCurve>[0]['equity'] | undefined;

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar history */}
      <div className="w-56 bg-surface-1 border-r border-subtle flex-shrink-0 flex flex-col overflow-hidden">
        <div className="px-3 py-3 border-b border-subtle text-xs text-dim uppercase tracking-wider">
          Recent Runs
        </div>
        <div className="flex-1 overflow-y-auto">
          {history.length === 0 && (
            <div className="px-3 py-4 text-xs text-dim">No runs yet</div>
          )}
          {history.map(h => (
            <Link
              key={h.id}
              to={`/dashboard/${h.id}`}
              className={`block px-3 py-2 border-b border-subtle hover:bg-surface-2 text-xs transition-colors ${
                h.id === id ? 'bg-surface-2 border-l-2 border-l-accent-blue' : ''
              }`}
            >
              <div className="text-gray-200 truncate">{h.symbol} {h.timeframe}</div>
              <div className="flex justify-between mt-0.5">
                <span className="text-dim">{h.date_start.slice(0, 10)}</span>
                <span className={scoreColor(h.composite_score)}>{h.composite_score}</span>
              </div>
            </Link>
          ))}
        </div>
        <div className="p-3 border-t border-subtle">
          <Link to="/" className="btn-ghost text-xs w-full block text-center">
            Block View
          </Link>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto">
        {!id && (
          <div className="flex items-center justify-center h-full text-dim text-sm">
            Select a run from the sidebar, or run a benchmark via <code className="ml-1 text-xs bg-surface-2 px-1 rounded">scripts/run_benchmark.js</code>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center h-full text-dim text-sm animate-pulse">
            Loading…
          </div>
        )}

        {error && (
          <div className="flex items-center justify-center h-full text-red-400 text-sm">{error}</div>
        )}

        {result && !loading && (
          <div className="p-4 flex flex-col gap-4 max-w-4xl">
            {/* Run header */}
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-lg font-semibold">{result.symbol} · {result.timeframe}</h1>
                <div className="text-xs text-dim mt-0.5">
                  {result.dateRange.start} → {result.dateRange.end}
                  {' · '}hash: <span className="font-mono">{result.algoHash.slice(0, 8)}</span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <ScoreGauge score={result.compositeScore} label="Composite" size={80} />
                <button
                  className="btn-primary text-sm"
                  onClick={() => setShowImprove(true)}
                >
                  Improve ✦
                </button>
              </div>
            </div>

            {/* Four dimension cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {(Object.entries(result.scores) as [string, BenchmarkResult['scores']['returns']][]).map(([dim, s]) => (
                <DimensionCard
                  key={dim}
                  dimension={dim as 'returns' | 'robustness' | 'cost' | 'regimes'}
                  result={s}
                  weight={result.weights[dim as keyof typeof result.weights]}
                />
              ))}
            </div>

            {/* Equity curve */}
            {equity && equity.length > 0 && (
              <div className="card">
                <div className="text-xs text-dim uppercase tracking-wider mb-3">Equity Curve &amp; Drawdown</div>
                <EquityCurve equity={equity} />
              </div>
            )}

            {/* Cost model info */}
            <div className="card text-xs">
              <div className="text-dim uppercase tracking-wider mb-2">Cost Model</div>
              <div className="flex gap-6">
                <span>Fee: {(result.costModel.fee_pct * 100).toFixed(2)}% / side</span>
                <span>Slippage: {(result.costModel.slippage_pct * 100).toFixed(2)}% / side</span>
                <span>Fill: {result.costModel.fill_model ?? 'worst'}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Improve sidebar */}
      {showImprove && result && id && (
        <div className="w-80 bg-surface-1 border-l border-subtle flex-shrink-0 overflow-hidden flex flex-col">
          <ImproveSidebar
            result={result}
            benchmarkId={id}
            onApply={handleApplyProposal}
            onClose={() => setShowImprove(false)}
          />
        </div>
      )}
    </div>
  );
};

function scoreColor(score: number) {
  if (score >= 70) return 'text-green-400';
  if (score >= 45) return 'text-yellow-400';
  return 'text-red-400';
}
