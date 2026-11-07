// Live reads of a market's underlying metric, straight from Ethereum in the browser.

import { useEffect, useState } from 'react';
import {
  blockAtOrAfter,
  countLogs,
  ethClient,
  getBlock,
  isWindowed,
  parseSource,
  readMorpho,
  sampleTimes,
  type Source,
} from '../../shared/metrics.ts';
import { metricNumber, type Market } from '../../shared/near.ts';
import { measureWindowed } from '../../shared/windowed.ts';

const eth = ethClient();

export type Point = { t: number; v: number };

export type MetricState = {
  source: Source;
  /** current or final value in base units */
  value: bigint | null;
  /** cumulative series (log count) or samples/readings (sampled) in display units */
  series: Point[];
  /** linear projection to window end, display units (log count only) */
  projected: number | null;
  /** for sampled sources: how many scheduled samples are due by now */
  samplesDue?: number;
  samplesTotal?: number;
  headBlock?: bigint;
  phase: 'before' | 'live' | 'ended';
  loading: boolean;
  error?: string;
};

const scale = (m: Market, v: bigint) => metricNumber(v, m.spec);

async function measure(m: Market, prev: Point[]): Promise<Omit<MetricState, 'loading'>> {
  const source = parseSource(m.spec.source);
  const start = Number(m.spec.window_start);
  const end = Number(m.spec.window_end);
  const head = await getBlock(eth);
  const phase = head.timestamp < start ? 'before' : head.timestamp < end ? 'live' : 'ended';
  const evidence = m.evidence ? safeJson(m.evidence) : null;

  if (source.kind === 'evm_log_count') {
    if (phase === 'before') return { source, value: null, series: [], projected: null, phase, headBlock: head.number };
    const from = evidence?.from ? BigInt(evidence.from.n) : (await blockAtOrAfter(eth, start, head))!.number;
    let to = head.number;
    let toTs = head.timestamp;
    if (evidence?.to) {
      to = BigInt(evidence.to.n);
      toTs = evidence.to.ts;
    } else if (phase === 'ended') {
      const after = await blockAtOrAfter(eth, end, head);
      if (after) {
        to = after.number - 1n;
        toTs = (await getBlock(eth, to)).timestamp;
      }
    }
    const fromTs = (await getBlock(eth, from)).timestamp;
    const c = await countLogs(eth, source, from, to);
    const perBlock = to > from ? (toTs - fromTs) / Number(to - from) : 12;
    const series: Point[] = [{ t: start, v: 0 }];
    c.blocks.forEach((b, i) => series.push({ t: fromTs + Number(b - from) * perBlock, v: i + 1 }));
    series.push({ t: Math.min(toTs, end), v: c.count });
    const elapsed = Math.max(1, Math.min(toTs, end) - start);
    // project only once a tenth of the window has passed; earlier the pace is mostly noise
    const projected = phase === 'live' && elapsed >= (end - start) / 10 ? (c.count / elapsed) * (end - start) : null;
    return { source, value: BigInt(c.count), series, projected, phase, headBlock: head.number };
  }

  if (isWindowed(source)) {
    if (phase === 'before') return { source, value: null, series: [], projected: null, phase, headBlock: head.number };
    const from = evidence?.from ? BigInt(evidence.from.n) : (await blockAtOrAfter(eth, start, head))!.number;
    let to = head.number;
    if (evidence?.to) to = BigInt(evidence.to.n);
    else if (phase === 'ended') {
      const after = await blockAtOrAfter(eth, end, head);
      if (after) to = after.number - 1n;
    }
    const [fromB, toB] = await Promise.all([getBlock(eth, from), getBlock(eth, to)]);
    const r = await measureWindowed(eth, source, from, to, false);
    const perBlock = to > from ? (toB.timestamp - fromB.timestamp) / Number(to - from) : 12;
    const t = (b: bigint) => fromB.timestamp + Number(b - from) * perBlock;
    // the chart shows the running value (what the market settles on), thinned to ~200 points
    const step = Math.max(1, Math.ceil(r.series.length / 200));
    const series = r.series.filter((_, i) => i % step === 0 || i === r.series.length - 1).map(([b, v]) => ({ t: t(b), v: scale(m, v) }));
    if (source.kind === 'erc20_net_mint') series.unshift({ t: start, v: 0 });
    const value = evidence?.value ? BigInt(evidence.value) : r.value;
    return { source, value, series, projected: null, phase, headBlock: head.number };
  }

  // sampled source (Morpho)
  const times = sampleTimes(source, start, end);
  if (evidence?.samples) {
    const series = (evidence.samples as [number, number, string][]).map(([t, , v]) => ({ t, v: scale(m, BigInt(v)) }));
    return {
      source,
      value: BigInt(evidence.value),
      series,
      projected: null,
      phase,
      samplesDue: times.length,
      samplesTotal: times.length,
      headBlock: head.number,
    };
  }
  const value = await readMorpho(eth, source, head.number);
  const reading = { t: head.timestamp, v: scale(m, value) };
  const series = [...prev.filter((p) => p.t !== reading.t), reading].slice(-120);
  return {
    source,
    value,
    series,
    projected: null,
    phase,
    samplesDue: times.filter((t) => t <= head.timestamp).length,
    samplesTotal: times.length,
    headBlock: head.number,
  };
}

function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function useMetric(m: Market | null, pollMs = 15_000): MetricState | null {
  const [state, setState] = useState<MetricState | null>(null);
  const key = m ? `${m.id}:${m.resolution ?? ''}` : '';
  useEffect(() => {
    if (!m) return;
    let stop = false;
    let series: Point[] = [];
    setState((s) => (s ? { ...s, loading: true } : null));
    const tick = async () => {
      try {
        const r = await measure(m, series);
        series = r.series;
        if (!stop) setState({ ...r, loading: false });
      } catch (e) {
        if (!stop) setState((s) => (s ? { ...s, loading: false, error: (e as Error).message } : null));
      }
    };
    tick();
    const id = m.resolution ? undefined : setInterval(tick, pollMs);
    return () => {
      stop = true;
      if (id) clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}
