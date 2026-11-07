// Small SVG charts: a step/line chart with an optional threshold line, and a sparkline.

import { useMemo, useState } from 'react';

export type Pt = { t: number; v: number };

type LineChartProps = {
  points: Pt[];
  xDomain: [number, number];
  yDomain?: [number, number];
  threshold?: number;
  thresholdLabel?: string;
  projected?: number | null;
  step?: boolean;
  dots?: boolean;
  fmtY: (v: number) => string;
  /** shorter labels for the y axis; defaults to fmtY */
  fmtAxis?: (v: number) => string;
  height?: number;
  color?: string;
  now?: number;
};

const W = 640;

function hhmm(t: number) {
  return new Date(t * 1000).toISOString().slice(11, 16);
}

export function LineChart({
  points,
  xDomain,
  yDomain,
  threshold,
  thresholdLabel,
  projected,
  step,
  dots,
  fmtY,
  fmtAxis = fmtY,
  height = 220,
  color = 'var(--accent)',
  now,
}: LineChartProps) {
  const [hover, setHover] = useState<Pt | null>(null);
  const pad = { l: 8, r: 64, t: 14, b: 24 };
  const H = height;
  const [x0, x1] = xDomain;
  const [y0, y1] = useMemo(() => {
    if (yDomain) return yDomain;
    const vs = points.map((p) => p.v);
    if (threshold !== undefined) vs.push(threshold);
    if (projected != null) vs.push(projected);
    if (!vs.length) return [0, 1];
    let lo = Math.min(...vs);
    let hi = Math.max(...vs);
    if (hi === lo) {
      hi += Math.abs(hi) * 0.01 || 1;
      lo -= Math.abs(lo) * 0.01 || 1;
    }
    const m = (hi - lo) * 0.12;
    return [Math.max(lo - m, lo >= 0 && lo - m < 0 ? 0 : lo - m), hi + m];
  }, [points, threshold, projected, yDomain]);

  const X = (t: number) => pad.l + ((t - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
  const Y = (v: number) => pad.t + (1 - (v - y0) / (y1 - y0 || 1)) * (H - pad.t - pad.b);

  let d = '';
  points.forEach((p, i) => {
    const x = X(p.t).toFixed(1);
    const y = Y(p.v).toFixed(1);
    if (i === 0) d += `M${x},${y}`;
    else if (step) d += `H${x}V${y}`;
    else d += `L${x},${y}`;
  });
  const last = points[points.length - 1];
  const area = last ? `${d}V${H - pad.b}H${X(points[0].t).toFixed(1)}Z` : '';
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => x0 + f * (x1 - x0));
  // skip y labels that would collide with the threshold label
  const yTicks = [0, 0.5, 1]
    .map((f) => y0 + f * (y1 - y0))
    .filter((v) => threshold === undefined || Math.abs(Y(v) - Y(threshold)) > 24);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!points.length) return;
    const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const t = x0 + (((e.clientX - r.left) / r.width) * W - pad.l) / (W - pad.l - pad.r) * (x1 - x0);
    let best = points[0];
    for (const p of points) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    setHover(best);
  };

  return (
    <svg
      className="chart"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
      role="img"
    >
      {yTicks.map((v, i) => (
        <g key={i}>
          <line x1={pad.l} x2={W - pad.r} y1={Y(v)} y2={Y(v)} className="grid" />
          <text x={W - pad.r + 6} y={Y(v) + 4} className="axis">
            {fmtAxis(v)}
          </text>
        </g>
      ))}
      {ticks.map((t, i) => (
        <text key={i} x={X(t)} y={H - 6} className="axis" textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}>
          {hhmm(t)}
        </text>
      ))}
      {now && now > x0 && now < x1 && <line x1={X(now)} x2={X(now)} y1={pad.t} y2={H - pad.b} className="now" />}
      {threshold !== undefined && (
        <g>
          <line x1={pad.l} x2={W - pad.r} y1={Y(threshold)} y2={Y(threshold)} className="threshold" />
          <text x={W - pad.r + 6} y={Y(threshold) - 4} className="threshold-label">
            {thresholdLabel ?? fmtAxis(threshold)}
          </text>
        </g>
      )}
      {area && <path d={area} fill={color} opacity={0.08} />}
      {d && <path d={d} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />}
      {projected != null && last && (
        <line
          x1={X(last.t)}
          y1={Y(last.v)}
          x2={X(x1)}
          y2={Y(projected)}
          stroke={color}
          strokeWidth={1.5}
          strokeDasharray="4 4"
          opacity={0.6}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {dots && points.map((p, i) => <circle key={i} cx={X(p.t)} cy={Y(p.v)} r={3} fill={color} />)}
      {hover && (
        <g>
          <line x1={X(hover.t)} x2={X(hover.t)} y1={pad.t} y2={H - pad.b} className="crosshair" />
          <circle cx={X(hover.t)} cy={Y(hover.v)} r={4} fill={color} stroke="var(--bg)" strokeWidth={2} />
          <text
            x={Math.min(X(hover.t) + 8, W - pad.r - 110)}
            y={pad.t + 12}
            className="tip"
          >{`${hhmm(hover.t)} · ${fmtY(hover.v)}`}</text>
        </g>
      )}
    </svg>
  );
}

export function Sparkline({ points, width = 120, height = 32, color = 'var(--accent)' }: { points: Pt[]; width?: number; height?: number; color?: string }) {
  if (points.length < 2) {
    return (
      <svg width={width} height={height}>
        <line x1={0} x2={width} y1={height / 2} y2={height / 2} stroke={color} strokeWidth={1.5} opacity={0.5} />
      </svg>
    );
  }
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t || t0 + 1;
  const X = (t: number) => ((t - t0) / (t1 - t0 || 1)) * width;
  const Y = (v: number) => 2 + (1 - v) * (height - 4);
  let d = '';
  points.forEach((p, i) => {
    d += i === 0 ? `M${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}` : `H${X(p.t).toFixed(1)}V${Y(p.v).toFixed(1)}`;
  });
  return (
    <svg width={width} height={height}>
      <line x1={0} x2={width} y1={Y(0.5)} y2={Y(0.5)} stroke="var(--line)" strokeDasharray="2 3" />
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}
