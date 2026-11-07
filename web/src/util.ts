import { useEffect, useRef, useState } from 'react';
import type { Market } from '../../shared/near.ts';

/** Poll an async function; re-runs when deps change. */
export function usePoll<T>(fn: () => Promise<T>, deps: unknown[], ms = 10_000): { data: T | undefined; error?: string; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [n, setN] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let stop = false;
    const run = () =>
      fnRef
        .current()
        .then((d) => !stop && (setData(d), setError(undefined)))
        .catch((e) => !stop && setError(String(e?.message ?? e)));
    run();
    const id = ms > 0 ? setInterval(run, ms) : undefined;
    return () => {
      stop = true;
      if (id) clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1) };
}

export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function dur(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function utc(ts: number | string, withDate = true): string {
  const d = new Date(Number(ts) * 1000);
  const t = d.toISOString().slice(11, 16);
  return withDate ? `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} ${t} UTC` : `${t} UTC`;
}

export function cents(p: number): string {
  const c = p * 100;
  if (c > 0 && c < 1) return '<1¢';
  if (c < 100 && c > 99) return '>99¢';
  return `${Math.round(c)}¢`;
}

export function statusLine(m: Market, now: number): { text: string; tone: 'live' | 'wait' | 'done' } {
  const close = Number(m.spec.close_time);
  const end = Number(m.spec.window_end);
  const start = Number(m.spec.window_start);
  if (m.resolution) return { text: `Resolved ${m.resolution.toUpperCase()}`, tone: 'done' };
  if (now < close) {
    if (now < start) return { text: `Window opens in ${dur(start - now)} · trading closes in ${dur(close - now)}`, tone: 'live' };
    return { text: `Live · trading closes in ${dur(close - now)}`, tone: 'live' };
  }
  if (now < end) return { text: `Trading closed · window ends in ${dur(end - now)}`, tone: 'wait' };
  return { text: 'Window ended · resolving', tone: 'wait' };
}

export const short = (a: string, n = 6) => (a.length > 2 * n + 2 ? `${a.slice(0, n + 2)}…${a.slice(-n)}` : a);
