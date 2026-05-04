import type { FC } from 'react';

interface Props {
  score: number;
  label: string;
  size?: number;
}

const COLORS = {
  high:   '#22c55e',
  mid:    '#eab308',
  low:    '#ef4444',
  track:  '#1f2937',
};

function scoreColor(score: number) {
  if (score >= 70) return COLORS.high;
  if (score >= 45) return COLORS.mid;
  return COLORS.low;
}

export const ScoreGauge: FC<Props> = ({ score, label, size = 96 }) => {
  const r = (size - 12) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;

  // Use 75% of circle (270 deg), starting at 135 deg (bottom-left)
  const arcLength = circumference * 0.75;
  const fill = arcLength * Math.min(100, Math.max(0, score)) / 100;

  const startAngle = 135; // degrees
  const toRad = (d: number) => (d * Math.PI) / 180;

  // SVG arc: strokeDasharray trick
  // Offset the start to 135 deg by rotating the whole SVG element
  const color = scoreColor(score);

  return (
    <div className="flex flex-col items-center gap-1">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ transform: `rotate(${startAngle}deg)` }}
      >
        {/* Track */}
        <circle
          cx={cx} cy={cy} r={r}
          fill="none"
          stroke={COLORS.track}
          strokeWidth={8}
          strokeDasharray={`${arcLength} ${circumference - arcLength}`}
          strokeLinecap="round"
        />
        {/* Fill */}
        <circle
          cx={cx} cy={cy} r={r}
          fill="none"
          stroke={color}
          strokeWidth={8}
          strokeDasharray={`${fill} ${circumference - fill}`}
          strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 0.5s ease' }}
        />
      </svg>
      {/* Score number overlaid */}
      <div
        className="absolute flex flex-col items-center justify-center pointer-events-none"
        style={{ width: size, height: size, marginTop: -(size) }}
      >
        <span className="text-xl font-semibold" style={{ color }}>{score}</span>
      </div>
      <span className="text-xs text-dim uppercase tracking-wider">{label}</span>
    </div>
  );
};
