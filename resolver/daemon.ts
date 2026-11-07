// The resolver: samples sampled sources while their window is open, and resolves every market
// whose window has ended, posting the measured value and reproducible evidence on NEAR.
//
//   npm run resolver            # loop forever
//   npm run resolver -- --once  # one pass

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  blockAtOrAfter,
  countLogs,
  ETH_RPCS,
  ethClient,
  getBlock,
  isWindowed,
  parseSource,
  readMorpho,
  sampleTimes,
  Unmeasurable,
  windowBlocks,
  type Block,
  type LogCountSource,
  type MorphoSource,
  type WindowedSource,
} from '../shared/metrics.ts';
import { measureWindowed, NotReady } from '../shared/windowed.ts';
import { CONTRACT_ID, fmtMetric, getMarkets, type Market } from '../shared/near.ts';
import { call, loadAccount } from './signer.ts';

const CONFIRMATIONS = BigInt(process.env.CONFIRMATIONS ?? 12);
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 15_000);
/** Past this many blocks, a public (non-archive) RPC can no longer read historical state. */
const STATE_HORIZON = 100n;
/**
 * When to stop retrying a market and void it, after GIVE_UP_ATTEMPTS failed passes in a row:
 * - at once if the failure is deterministic (`Unmeasurable`: the source can't be parsed or is of
 *   an unknown kind); retrying can never succeed.
 * - otherwise (RPC outages, rate limits, anything that might clear up) only GIVE_UP_SECS after
 *   the window ended. That is the contract's own grace period, after which anyone may void, so
 *   an outage never voids a market that could still be measured.
 */
const GIVE_UP_SECS = Number(process.env.GIVE_UP_SECS ?? 3 * 24 * 3600);
const GIVE_UP_ATTEMPTS = Number(process.env.GIVE_UP_ATTEMPTS ?? 20);
const failures = new Map<number, number>();

const here = dirname(fileURLToPath(import.meta.url));
// one state file per contract, so daemons for different deployments never share samples
const STATE_FILE = join(here, '.state', `samples-${CONTRACT_ID}.json`);

type Sample = { block: string; hash: string; value: string } | { missed: true; reason: string };
type State = Record<string, Record<string, Sample>>;

function loadState(): State {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
}
function saveState(s: State) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

const eth = ethClient();
const account = loadAccount();
const ts = () => new Date().toISOString().slice(11, 19);

async function sampleMorpho(m: Market, src: MorphoSource, head: Block, state: State) {
  const start = Number(m.spec.window_start);
  const end = Number(m.spec.window_end);
  const mine = (state[m.id] ??= {});
  for (const t of sampleTimes(src, start, end)) {
    if (mine[t] || t > head.timestamp) continue;
    const blk = await blockAtOrAfter(eth, t, head);
    if (!blk) continue;
    if (head.number - blk.number > STATE_HORIZON) {
      mine[t] = { missed: true, reason: `sampler offline; block ${blk.number} beyond state horizon` };
      console.log(`[${ts()}] #${m.id} sample @${t} missed`);
      continue;
    }
    try {
      const value = await readMorpho(eth, src, blk.number);
      mine[t] = { block: blk.number.toString(), hash: blk.hash, value: value.toString() };
      console.log(`[${ts()}] #${m.id} sample @${new Date(t * 1000).toISOString().slice(11, 16)} block ${blk.number}: ${fmtMetric(value, m.spec)}`);
    } catch (e) {
      console.log(`[${ts()}] #${m.id} sample @${t} read failed, will retry: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  saveState(state);
}

async function resolveLogCount(m: Market, src: LogCountSource, head: Block) {
  const w = await windowBlocks(eth, Number(m.spec.window_start), Number(m.spec.window_end), head);
  if (!w || head.number < w.to.number + CONFIRMATIONS) return;
  const c = await countLogs(eth, src, w.from.number, w.to.number);
  const evidence = {
    v: 1,
    kind: src.kind,
    rpc: ETH_RPCS[0],
    from: { n: Number(w.from.number), hash: w.from.hash, ts: w.from.timestamp },
    to: { n: Number(w.to.number), hash: w.to.hash, ts: w.to.timestamp },
    count: c.count,
    dataHash: c.dataHash,
  };
  console.log(`[${ts()}] #${m.id} measured ${c.count} ${m.spec.unit} in blocks ${w.from.number}..${w.to.number}`);
  const r = await call<string>(account, 'resolve', { market_id: m.id, value: String(c.count), evidence: JSON.stringify(evidence) });
  console.log(`[${ts()}] #${m.id} resolved ${r}`);
}

/** Sources computed from logs and headers over the window: measure once confirmed, then resolve. */
async function resolveWindowed(m: Market, src: WindowedSource, head: Block) {
  const w = await windowBlocks(eth, Number(m.spec.window_start), Number(m.spec.window_end), head);
  if (!w || head.number < w.to.number + CONFIRMATIONS) return;
  let r;
  try {
    r = await measureWindowed(eth, src, w.from.number, w.to.number, true);
  } catch (e) {
    if (e instanceof NotReady) return;
    throw e;
  }
  const evidence = {
    v: 1,
    kind: src.kind,
    rpc: ETH_RPCS[0],
    from: { n: Number(w.from.number), hash: w.from.hash, ts: w.from.timestamp },
    to: { n: Number(w.to.number), hash: w.to.hash, ts: w.to.timestamp },
    value: r.value.toString(),
    ...r.detail,
  };
  console.log(`[${ts()}] #${m.id} measured ${fmtMetric(r.value, m.spec)} over blocks ${w.from.number}..${w.to.number}`);
  const res = await call<string>(account, 'resolve', { market_id: m.id, value: r.value.toString(), evidence: JSON.stringify(evidence) });
  console.log(`[${ts()}] #${m.id} resolved ${res}`);
}

async function resolveMorpho(m: Market, src: MorphoSource, head: Block, state: State) {
  const times = sampleTimes(src, Number(m.spec.window_start), Number(m.spec.window_end));
  const mine = state[m.id] ?? {};
  if (times.some((t) => !mine[t])) return; // still sampling
  const last = mine[times[times.length - 1]];
  if ('block' in last && head.number < BigInt(last.block) + CONFIRMATIONS) return;
  const taken = times.flatMap((t) => {
    const s = mine[t];
    return 'block' in s ? [[t, Number(s.block), s.value] as [number, number, string]] : [];
  });
  if (taken.length * 2 < times.length) {
    console.log(`[${ts()}] #${m.id} only ${taken.length}/${times.length} samples; voiding`);
    await call(account, 'void_market', { market_id: m.id, reason: `only ${taken.length}/${times.length} samples taken` });
    return;
  }
  const value = taken.reduce((a, [, , v]) => a + BigInt(v), 0n) / BigInt(taken.length);
  const evidence = { v: 1, kind: src.kind, field: src.field, agg: 'mean', expected: times.length, samples: taken, value: value.toString() };
  console.log(`[${ts()}] #${m.id} mean of ${taken.length} samples: ${fmtMetric(value, m.spec)}`);
  const r = await call<string>(account, 'resolve', { market_id: m.id, value: value.toString(), evidence: JSON.stringify(evidence) });
  console.log(`[${ts()}] #${m.id} resolved ${r}`);
}

async function pass() {
  const markets = (await getMarkets()).filter((m) => !m.resolution);
  if (!markets.length) return;
  const head = await getBlock(eth);
  const state = loadState();
  for (const m of markets) {
    try {
      let src: ReturnType<typeof parseSource>;
      try {
        src = parseSource(m.spec.source);
      } catch {
        throw new Unmeasurable('market source is not valid JSON');
      }
      if (src.kind !== 'morpho_market' && src.kind !== 'evm_log_count' && !isWindowed(src)) {
        throw new Unmeasurable(`unknown source kind ${(src as { kind?: string }).kind}`);
      }
      const ended = head.timestamp >= Number(m.spec.window_end);
      if (src.kind === 'morpho_market') {
        await sampleMorpho(m, src, head, state);
        if (ended) await resolveMorpho(m, src, head, state);
      } else if (src.kind === 'evm_log_count' && ended) {
        await resolveLogCount(m, src, head);
      } else if (isWindowed(src) && ended) {
        await resolveWindowed(m, src, head);
      }
      failures.delete(m.id);
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      const n = (failures.get(m.id) ?? 0) + 1;
      failures.set(m.id, n);
      console.error(`[${ts()}] #${m.id} error (${n} in a row): ${msg}`);
      const deterministic = e instanceof Unmeasurable;
      const giveUpAt = Number(m.spec.window_end) + (deterministic ? 0 : GIVE_UP_SECS);
      if (n >= GIVE_UP_ATTEMPTS && head.timestamp >= giveUpAt) {
        console.log(`[${ts()}] #${m.id} ${deterministic ? 'cannot be measured' : `still failing ${GIVE_UP_SECS / 3600}h after its window`}; voiding`);
        try {
          await call(account, 'void_market', { market_id: m.id, reason: `could not be measured: ${msg.slice(0, 200)}` });
          failures.delete(m.id);
        } catch (e2) {
          console.error(`[${ts()}] #${m.id} void failed: ${(e2 as Error).message.slice(0, 300)}`);
        }
      }
    }
  }
}

const once = process.argv.includes('--once');
console.log(`resolver ${account.accountId} for ${CONTRACT_ID}, ${CONFIRMATIONS} confirmations, every ${INTERVAL_MS / 1000}s`);
do {
  try {
    await pass();
  } catch (e) {
    console.error(`[${ts()}] pass failed: ${(e as Error).message.slice(0, 300)}`);
  }
  if (!once) await new Promise((r) => setTimeout(r, INTERVAL_MS));
} while (!once);
