// Independently re-check a resolved market from its on-chain evidence.
//
//   npm run verify -- <market_id> [--rpc https://your-archive-node]
//
// Log-count markets re-verify on any public RPC. Sampled (Morpho) markets need an archive RPC
// to re-read historical state. Without one the values can't be checked, and the result is
// UNVERIFIED (exit 2), never VERIFIED.
//
// Exit codes: 0 VERIFIED, 1 MISMATCH, 2 UNVERIFIED (nothing contradicts the evidence, but some of
// it could not be checked).

import { parseArgs } from 'node:util';
import { blockAtOrAfter, countLogs, ETH_RPCS, ethClient, getBlock, isWindowed, parseSource, readMorpho, sampleTimes } from '../shared/metrics.ts';
import { measureWindowed, NotReady } from '../shared/windowed.ts';
import { CMP_TEXT, fmtMetric, getMarket } from '../shared/near.ts';

const { positionals, values } = parseArgs({ allowPositionals: true, options: { rpc: { type: 'string' } } });
const id = Number(positionals[0]);
const m = await getMarket(id);
if (!m) throw new Error(`no market ${id}`);
if (!m.resolution || !m.evidence) throw new Error(`market ${id} is not resolved`);

const eth = ethClient(values.rpc ? [values.rpc] : ETH_RPCS);
const src = parseSource(m.spec.source);
const ev = JSON.parse(m.evidence);
let ok = true;
let unchecked = 0;
const check = (label: string, pass: boolean, detail = '') => {
  ok &&= pass;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
  return pass;
};
const hhmm = (t: number) => new Date(t * 1000).toISOString().slice(11, 16);

console.log(`#${id} ${m.spec.question}\nresolved ${m.resolution} with value ${fmtMetric(m.resolved_value ?? '0', m.spec)}\n`);
const head = await getBlock(eth);

if (src.kind === 'evm_log_count') {
  const start = Number(m.spec.window_start);
  const end = Number(m.spec.window_end);
  const first = await blockAtOrAfter(eth, start, head);
  const after = await blockAtOrAfter(eth, end, head);
  check('first block is the first at/after window start', first?.number === BigInt(ev.from.n), `block ${ev.from.n}`);
  check('last block is the last before window end', after?.number === BigInt(ev.to.n) + 1n, `block ${ev.to.n}`);
  const fromB = await getBlock(eth, BigInt(ev.from.n));
  const toB = await getBlock(eth, BigInt(ev.to.n));
  check('block hashes match (no reorg)', fromB.hash === ev.from.hash && toB.hash === ev.to.hash);
  const c = await countLogs(eth, src, BigInt(ev.from.n), BigInt(ev.to.n));
  check('log count matches', c.count === ev.count && String(c.count) === m.resolved_value, `${c.count} ${m.spec.unit}`);
  check('data hash matches', c.dataHash === ev.dataHash, c.dataHash);
} else if (isWindowed(src)) {
  // Computed from logs and headers: recompute over the same window and compare every field.
  const start = Number(m.spec.window_start);
  const end = Number(m.spec.window_end);
  const first = await blockAtOrAfter(eth, start, head);
  const after = await blockAtOrAfter(eth, end, head);
  check('first block is the first at/after window start', first?.number === BigInt(ev.from?.n ?? -1), `block ${ev.from?.n}`);
  check('last block is the last before window end', after?.number === BigInt(ev.to?.n ?? -2) + 1n, `block ${ev.to?.n}`);
  if (first && after) {
    const fromB = await getBlock(eth, first.number);
    const toB = await getBlock(eth, after.number - 1n);
    check('block hashes match (no reorg)', fromB.hash === ev.from?.hash && toB.hash === ev.to?.hash);
    try {
      const r = await measureWindowed(eth, src, fromB.number, toB.number, true);
      check('value matches', r.value.toString() === ev.value && ev.value === m.resolved_value, fmtMetric(r.value, m.spec));
      for (const [k, v] of Object.entries(r.detail)) check(`  ${k} matches`, String(ev[k]) === String(v), String(v).slice(0, 66));
    } catch (e) {
      if (!(e instanceof NotReady)) throw e;
      check('value can be recomputed', false, e.message);
    }
  }
} else {
  // The evidence must be the resolver's own schedule: one sample per scheduled time, no
  // duplicates, nothing off-schedule, and at least half the schedule taken (the voiding rule).
  const times = sampleTimes(src, Number(m.spec.window_start), Number(m.spec.window_end));
  const scheduled = new Set(times);
  const raw: unknown = ev.samples;
  const samples = Array.isArray(raw)
    ? raw.filter(
        (s): s is [number, number, string] =>
          Array.isArray(s) && s.length === 3 && Number.isSafeInteger(s[0]) && Number.isSafeInteger(s[1]) && /^\d+$/.test(String(s[2])),
      )
    : [];
  check('evidence is a list of [time, block, value] samples', Array.isArray(raw) && samples.length === raw.length && samples.length > 0);
  const seen = new Set<number>();
  const dupes = samples.filter(([t]) => seen.has(t) || !seen.add(t)).map(([t]) => t);
  check('no sample time appears twice', dupes.length === 0, dupes.length ? dupes.map(hhmm).join(', ') : '');
  const off = samples.filter(([t]) => !scheduled.has(t)).map(([t]) => t);
  check('every sample is at a scheduled time inside the window', off.length === 0, off.length ? off.map((t) => String(t)).join(', ') : `${times.length} scheduled`);
  check(
    'at least half of the scheduled samples were taken',
    seen.size * 2 >= times.length && seen.size <= times.length,
    `${seen.size}/${times.length}`,
  );
  check('evidence states the schedule size', ev.expected === times.length, `expected ${ev.expected}`);
  const missing = times.filter((t) => !seen.has(t));
  if (missing.length) console.log(`note ${missing.length} scheduled sample(s) reported missed: ${missing.map(hhmm).join(', ')}`);

  for (const [t, block, value] of samples) {
    const b = await blockAtOrAfter(eth, t, head);
    check(`sample @${hhmm(t)} uses block ${block}`, b?.number === BigInt(block));
    try {
      const v = await readMorpho(eth, src, BigInt(block));
      check(`  value at block ${block}`, v.toString() === value, fmtMetric(v, m.spec));
    } catch {
      unchecked++;
      console.log(`??   value at block ${block} not checked (needs an archive RPC: --rpc <url>)`);
    }
  }
  if (samples.length) {
    const mean = samples.reduce((a, s) => a + BigInt(s[2]), 0n) / BigInt(samples.length);
    check('average matches resolved value', mean.toString() === m.resolved_value);
  }
}

const v = BigInt(m.resolved_value ?? '0');
const t = BigInt(m.spec.threshold);
const holds = { Gt: v > t, Gte: v >= t, Lt: v < t, Lte: v <= t }[m.spec.comparator];
check(
  `rule ${fmtMetric(v, m.spec)} ${CMP_TEXT[m.spec.comparator]} ${fmtMetric(t, m.spec)} => ${holds ? 'Yes' : 'No'}`,
  (holds ? 'Yes' : 'No') === m.resolution,
);
if (!ok) {
  console.log('\nMISMATCH');
  process.exit(1);
}
if (unchecked) {
  console.log(`\nUNVERIFIED: ${unchecked} sample value(s) could not be read. Re-run with --rpc <archive node>.`);
  process.exit(2);
}
console.log('\nVERIFIED');
process.exit(0);
