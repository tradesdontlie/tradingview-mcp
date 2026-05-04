import type { FC } from 'react';
import {
  ResponsiveContainer, ComposedChart, Line, Area,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend, ReferenceLine,
} from 'recharts';
import type { EquityPoint } from '../types';

interface Props {
  equity: EquityPoint[];
  initialEquity?: number;
}

interface ChartPoint {
  time: string;
  equity: number;
  drawdown: number;
  buyhold?: number;
}

export const EquityCurve: FC<Props> = ({ equity, initialEquity }) => {
  if (!equity.length) {
    return <div className="text-dim text-sm text-center py-8">No equity data</div>;
  }

  const initial = initialEquity ?? equity[0].equity;
  const data: ChartPoint[] = equity.map(pt => ({
    time: formatTime(pt.time),
    equity: Math.round(pt.equity * 100) / 100,
    drawdown: pt.drawdown != null ? -Math.abs(pt.drawdown) * 100 : 0, // negative %
  }));

  const minEq = Math.min(...data.map(d => d.equity));
  const maxEq = Math.max(...data.map(d => d.equity));
  const minDd = Math.min(...data.map(d => d.drawdown));

  return (
    <div className="flex flex-col gap-1">
      {/* Equity line */}
      <div className="h-40">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="2 4" stroke="#1f2937" vertical={false} />
            <XAxis dataKey="time" tick={{ fontSize: 10, fill: '#6b7280' }} minTickGap={60} />
            <YAxis
              domain={[minEq * 0.98, maxEq * 1.02]}
              tick={{ fontSize: 10, fill: '#6b7280' }}
              width={60}
              tickFormatter={v => `$${(v / 1000).toFixed(0)}k`}
            />
            <Tooltip content={<EquityTooltip />} />
            <ReferenceLine y={initial} stroke="#374151" strokeDasharray="4 2" />
            <Area
              type="monotone" dataKey="equity"
              stroke="#3b82f6" strokeWidth={1.5}
              fill="url(#eqGrad)"
              dot={false} isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Drawdown */}
      <div className="h-20">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 0, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="ddGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#ef4444" stopOpacity={0.5} />
                <stop offset="95%" stopColor="#ef4444" stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="2 4" stroke="#1f2937" vertical={false} />
            <XAxis dataKey="time" tick={false} height={0} />
            <YAxis
              domain={[minDd * 1.1, 0]}
              tick={{ fontSize: 10, fill: '#6b7280' }}
              width={60}
              tickFormatter={v => `${v.toFixed(0)}%`}
            />
            <Tooltip content={<DrawdownTooltip />} />
            <ReferenceLine y={0} stroke="#374151" />
            <Area
              type="monotone" dataKey="drawdown"
              stroke="#ef4444" strokeWidth={1}
              fill="url(#ddGrad)"
              dot={false} isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

const EquityTooltip: FC<{ active?: boolean; payload?: { value: number }[]; label?: string }> = ({
  active, payload, label,
}) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-surface-2 border border-subtle px-2 py-1 text-xs rounded">
      <div className="text-dim mb-1">{label}</div>
      <div className="text-accent-blue">${payload[0].value.toLocaleString()}</div>
    </div>
  );
};

const DrawdownTooltip: FC<{ active?: boolean; payload?: { value: number }[]; label?: string }> = ({
  active, payload, label,
}) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-surface-2 border border-subtle px-2 py-1 text-xs rounded">
      <div className="text-dim mb-1">{label}</div>
      <div className="text-accent-red">{payload[0].value.toFixed(1)}%</div>
    </div>
  );
};

function formatTime(t: string | number) {
  const d = typeof t === 'number' ? new Date(t) : new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
