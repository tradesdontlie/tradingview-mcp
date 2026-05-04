import type { FC } from 'react';
import type { Proposal } from '../types';

interface Props {
  proposal: Proposal;
  onAccept: (proposal: Proposal) => void;
  onReject: () => void;
  loading?: boolean;
}

export const DiffReview: FC<Props> = ({ proposal, onAccept, onReject, loading }) => {
  const diff = proposal.pineDiff;

  return (
    <div className="card flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">{proposal.title}</div>
          <div className="text-xs text-muted mt-1">{proposal.hypothesis}</div>
        </div>
        <div className="flex-shrink-0 flex flex-col items-end gap-1">
          <DeltaBadge delta={proposal.predictedDelta.composite ?? 0} label="composite" />
          <DeltaBadge delta={proposal.predictedDelta[proposal.weakestDimension] ?? 0} label={proposal.weakestDimension} />
        </div>
      </div>

      {diff && (
        <div className="flex flex-col gap-2">
          <div className="text-xs text-dim">{diff.description}</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {diff.old != null && (
              <div>
                <div className="text-xs text-red-400 mb-1">— remove</div>
                <pre className="bg-red-950/30 border border-red-900/40 rounded p-2 text-xs overflow-x-auto text-red-200 whitespace-pre-wrap">
                  {diff.old}
                </pre>
              </div>
            )}
            <div>
              <div className="text-xs text-green-400 mb-1">+ add</div>
              <pre className="bg-green-950/30 border border-green-900/40 rounded p-2 text-xs overflow-x-auto text-green-200 whitespace-pre-wrap">
                {diff.new}
              </pre>
            </div>
          </div>
        </div>
      )}

      <div className="flex gap-2 justify-end">
        <button className="btn-ghost text-xs" onClick={onReject} disabled={loading}>
          reject
        </button>
        <button
          className="btn-primary text-xs"
          onClick={() => onAccept(proposal)}
          disabled={loading}
        >
          {loading ? 'applying…' : 'accept → apply to Pine'}
        </button>
      </div>
    </div>
  );
};

const DeltaBadge: FC<{ delta: number; label: string }> = ({ delta, label }) => {
  const positive = delta > 0;
  const zero = delta === 0;
  const color = zero
    ? 'text-gray-400'
    : positive
    ? 'text-green-400'
    : 'text-red-400';

  return (
    <span className={`text-xs ${color}`}>
      {positive ? '+' : ''}{delta} {label}
    </span>
  );
};
