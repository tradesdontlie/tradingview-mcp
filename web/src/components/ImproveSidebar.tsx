import { useState, type FC } from 'react';
import type { BenchmarkResult, Proposal } from '../types';
import { getImprovement } from '../api/client';
import { DiffReview } from './DiffReview';

interface Props {
  result: BenchmarkResult;
  benchmarkId: string;
  pineSource?: string;
  onApply: (proposal: Proposal) => void;
  onClose: () => void;
}

type State =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'proposals'; analysis: string; proposals: Proposal[]; selectedIdx: number | null }
  | { phase: 'reviewing'; proposal: Proposal; applyLoading: boolean }
  | { phase: 'error'; message: string };

export const ImproveSidebar: FC<Props> = ({ result, benchmarkId, pineSource, onApply, onClose }) => {
  const [state, setState] = useState<State>({ phase: 'idle' });

  async function handleGenerate() {
    setState({ phase: 'loading' });
    try {
      const data = await getImprovement({ benchmarkId, pineSource });
      setState({
        phase: 'proposals',
        analysis: (data as { analysis?: string }).analysis ?? '',
        proposals: data.proposals,
        selectedIdx: null,
      });
    } catch (err) {
      setState({ phase: 'error', message: (err as Error).message });
    }
  }

  function handleSelectProposal(proposal: Proposal) {
    setState({ phase: 'reviewing', proposal, applyLoading: false });
  }

  function handleAccept(proposal: Proposal) {
    onApply(proposal);
  }

  function handleBack() {
    if (state.phase === 'reviewing') {
      setState({ phase: 'idle' });
    } else {
      setState({ phase: 'idle' });
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-subtle">
        <span className="text-sm font-semibold">Improve</span>
        <button className="btn-ghost text-xs" onClick={onClose}>✕</button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">

        {state.phase === 'idle' && (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted">
              Claude will read the four scoring dimensions and propose 1–3 concrete Pine modifications targeting the weakest area. You pick one, then review the diff before applying.
            </p>
            <ScoreSummary result={result} />
            <button className="btn-primary text-sm w-full mt-2" onClick={handleGenerate}>
              Analyze &amp; propose improvements →
            </button>
          </div>
        )}

        {state.phase === 'loading' && (
          <div className="flex flex-col items-center gap-3 py-8 text-dim text-sm">
            <div className="animate-spin text-2xl">⟳</div>
            <div>Analyzing scores and generating proposals…</div>
          </div>
        )}

        {state.phase === 'error' && (
          <div className="flex flex-col gap-3">
            <div className="text-red-400 text-sm">{state.message}</div>
            <button className="btn-ghost text-xs" onClick={() => setState({ phase: 'idle' })}>
              ← back
            </button>
          </div>
        )}

        {state.phase === 'proposals' && (
          <div className="flex flex-col gap-4">
            {state.analysis && (
              <div className="bg-surface-2 rounded p-3 text-xs text-muted border border-subtle">
                {state.analysis}
              </div>
            )}
            <div className="text-xs text-dim">{state.proposals.length} proposal{state.proposals.length !== 1 ? 's' : ''} — pick one to review</div>
            {state.proposals.map((p, i) => (
              <ProposalCard
                key={p.id}
                proposal={p}
                onClick={() => handleSelectProposal(p)}
              />
            ))}
            <button className="btn-ghost text-xs mt-2" onClick={() => setState({ phase: 'idle' })}>
              ← start over
            </button>
          </div>
        )}

        {state.phase === 'reviewing' && (
          <div className="flex flex-col gap-4">
            <button className="btn-ghost text-xs self-start" onClick={handleBack}>
              ← back to proposals
            </button>
            <DiffReview
              proposal={state.proposal}
              onAccept={handleAccept}
              onReject={handleBack}
              loading={state.applyLoading}
            />
          </div>
        )}
      </div>
    </div>
  );
};

const ScoreSummary: FC<{ result: BenchmarkResult }> = ({ result }) => (
  <div className="grid grid-cols-2 gap-2">
    {(Object.entries(result.scores) as [string, { score: number }][]).map(([dim, s]) => (
      <div key={dim} className="bg-surface-2 rounded p-2 flex justify-between text-xs">
        <span className="text-dim capitalize">{dim}</span>
        <span className={scoreColor(s.score)}>{s.score}</span>
      </div>
    ))}
    <div className="col-span-2 bg-surface-2 rounded p-2 flex justify-between text-xs font-semibold">
      <span className="text-muted">Composite</span>
      <span className={scoreColor(result.compositeScore)}>{result.compositeScore}</span>
    </div>
  </div>
);

const ProposalCard: FC<{ proposal: Proposal; onClick: () => void }> = ({ proposal, onClick }) => (
  <button
    className="card text-left hover:border-accent-blue/50 transition-colors w-full"
    onClick={onClick}
  >
    <div className="text-sm font-medium">{proposal.title}</div>
    <div className="text-xs text-muted mt-1 line-clamp-2">{proposal.hypothesis}</div>
    <div className="flex gap-2 mt-2">
      <span className="text-xs text-dim capitalize">targets: {proposal.weakestDimension}</span>
      {proposal.predictedDelta.composite != null && (
        <span className={`text-xs ${proposal.predictedDelta.composite > 0 ? 'text-green-400' : 'text-red-400'}`}>
          {proposal.predictedDelta.composite > 0 ? '+' : ''}{proposal.predictedDelta.composite} composite
        </span>
      )}
    </div>
  </button>
);

function scoreColor(score: number) {
  if (score >= 70) return 'text-green-400';
  if (score >= 45) return 'text-yellow-400';
  return 'text-red-400';
}
