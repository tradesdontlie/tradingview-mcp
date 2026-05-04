import { useState, type FC } from 'react';
import type { DimensionResult, ReturnsComponents, RobustnessComponents, CostComponents, RegimesComponents } from '../types';
import { ScoreGauge } from './ScoreGauge';

interface Props {
  dimension: 'returns' | 'robustness' | 'cost' | 'regimes';
  result: DimensionResult;
  weight: number;
}

const LABELS: Record<string, string> = {
  returns: 'Returns',
  robustness: 'Robustness',
  cost: 'Cost',
  regimes: 'Regimes',
};

export const DimensionCard: FC<Props> = ({ dimension, result, weight }) => {
  const [open, setOpen] = useState(false);

  return (
    <div className="card flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ScoreGauge score={result.score} label={LABELS[dimension]} size={80} />
          <div>
            <div className="text-xs text-dim">weight: {Math.round(weight * 100)}%</div>
            <div className="text-xs text-muted mt-1">{topLine(dimension, result.components)}</div>
          </div>
        </div>
        <button
          className="btn-ghost text-xs"
          onClick={() => setOpen(v => !v)}
        >
          {open ? 'hide evidence ↑' : 'show evidence ↓'}
        </button>
      </div>

      {/* Evidence table */}
      {open && (
        <div className="border-t border-subtle pt-3">
          <EvidenceTable dimension={dimension} components={result.components} evidence={result.evidence} />
        </div>
      )}
    </div>
  );
};

function topLine(dim: string, c: DimensionResult['components']): string {
  const r = c as ReturnsComponents;
  const ro = c as RobustnessComponents;
  const co = c as CostComponents;
  const re = c as RegimesComponents;

  switch (dim) {
    case 'returns':
      return `Sharpe ${fmt(r.sharpe)} · MDD ${pct(r.maxDrawdown)} · CAGR ${pct(r.cagr)}`;
    case 'robustness':
      return `WFE ${fmt(ro.wfe)} · MC P5 ${fmt(ro.mcP5)}× · Ruin ${pct(ro.mcRuinProbability)}`;
    case 'cost':
      return `Net/gross ${pct(co.netReturnRatio)} · BEF ${pct(co.breakEvenFee)}`;
    case 'regimes': {
      const regimes = re.regimes;
      if (!regimes) return 'No data';
      const parts = Object.entries(regimes)
        .filter(([, s]) => s.tradeCount > 0)
        .map(([r, s]) => `${r} ${pct(s.winRate ?? 0)}`);
      return parts.join(' · ');
    }
    default:
      return '';
  }
}

const EvidenceTable: FC<{
  dimension: string;
  components: DimensionResult['components'];
  evidence: Record<string, unknown>;
}> = ({ dimension, components }) => {
  const rows = buildRows(dimension, components);

  return (
    <table className="w-full text-xs">
      <tbody>
        {rows.map(([label, value, note]) => (
          <tr key={label} className="border-b border-subtle last:border-0">
            <td className="py-1 text-dim w-1/2">{label}</td>
            <td className="py-1 font-medium text-right">{value}</td>
            {note && <td className="py-1 pl-3 text-dim text-right hidden sm:table-cell">{note}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

function buildRows(dim: string, c: DimensionResult['components']): [string, string, string?][] {
  const r = c as ReturnsComponents;
  const ro = c as RobustnessComponents;
  const co = c as CostComponents;
  const re = c as RegimesComponents;

  switch (dim) {
    case 'returns':
      return [
        ['Sharpe Ratio',   fmt(r.sharpe),      r.sharpe >= 2 ? '✓ excellent' : r.sharpe >= 1 ? '✓ good' : '⚠ weak'],
        ['Sortino Ratio',  fmt(r.sortino)],
        ['CAGR',           pct(r.cagr)],
        ['Max Drawdown',   pct(r.maxDrawdown), r.maxDrawdown > 0.3 ? '⚠ high' : undefined],
        ['Calmar Ratio',   fmt(r.calmar)],
        ['Win Rate',       pct(r.winRate)],
        ['Profit Factor',  fmt(r.profitFactor)],
        ['Avg Win',        pct(r.avgWinPct)],
        ['Avg Loss',       pct(r.avgLossPct)],
        ['Trade Count',    String(r.tradeCount)],
      ];
    case 'robustness':
      return [
        ['Walk-forward Efficiency', fmt(ro.wfe), ro.wfe >= 0.5 ? '✓ good' : '⚠ overfit risk'],
        ['Monte Carlo P5',          `${fmt(ro.mcP5)}×`],
        ['Monte Carlo P50',         `${fmt(ro.mcP50)}×`],
        ['Monte Carlo P95',         `${fmt(ro.mcP95)}×`],
        ['Ruin Probability',        pct(ro.mcRuinProbability), ro.mcRuinProbability > 0.1 ? '⚠ high' : undefined],
        ['Monthly Consistency',     pct(ro.consistencyRatio)],
      ];
    case 'cost':
      return [
        ['Net / Gross Return',   pct(co.netReturnRatio)],
        ['Fee Impact',           pct(co.feeImpact)],
        ['Slippage Impact',      pct(co.slippageImpact)],
        ['Break-even Fee',       pct(co.breakEvenFee)],
        ['Avg Cost / Trade',     pct(co.avgCostPerTrade)],
        ['3× Stress Net Ratio',  pct(co.stressNetReturnRatio)],
      ];
    case 'regimes':
      if (!re.regimes) return [['No data', '—']];
      return Object.entries(re.regimes).flatMap(([regime, s]) => [
        [`${regime.toUpperCase()} — trades`, String(s.tradeCount)],
        [`${regime.toUpperCase()} — win rate`, pct(s.winRate ?? 0)],
        [`${regime.toUpperCase()} — avg return`, pct(s.avgReturn)],
      ]);
    default:
      return [];
  }
}

function fmt(v: number | undefined | null) {
  if (v == null) return '—';
  return Number.isFinite(v) ? v.toFixed(2) : '∞';
}

function pct(v: number | undefined | null) {
  if (v == null) return '—';
  return `${(v * 100).toFixed(1)}%`;
}
