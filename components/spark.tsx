import React from 'react';

/** Tiny inline trend line. Green when the series ends above where it started. */
export const Sparkline: React.FC<{ values: number[]; width?: number; height?: number }> = ({ values, width = 120, height = 28 }) => {
  if (values.length < 2) return <svg width={width} height={height} />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * (width - 2) + 1},${height - 1 - ((v - min) / range) * (height - 4)}`)
    .join(' ');
  const up = values[values.length - 1] >= values[0];
  return (
    <svg width={width} height={height} className="cp-spark">
      <polyline points={pts} fill="none" stroke={up ? 'var(--good)' : 'var(--bad)'} strokeWidth="1.5" />
    </svg>
  );
};
