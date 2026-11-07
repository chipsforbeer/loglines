// Measuring "windowed" sources: values computed entirely from logs and block headers over the
// window's block range [from, to]. One function serves the resolver (final value + evidence), the
// verifier (recompute and compare) and the web app (running value for the live chart), so all
// three agree by construction. Logs and headers are served for any past block by public RPCs, so
// these markets can be re-checked later without an archive node.

import { concat, hexToBigInt, keccak256, numberToHex, pad, type Hex, type PublicClient } from 'viem';
import {
  ERC20_TRANSFER_TOPIC,
  getBlock,
  getLogs,
  MORPHO_ACCRUE_TOPIC,
  Unmeasurable,
  UNI_V3_SWAP_TOPIC,
  type BlockStatSource,
  type MorphoRateSource,
  type NetMintSource,
  type PoolPriceSource,
  type RawLog,
  type WindowedSource,
} from './metrics.ts';

/** The value can't be final yet (e.g. the rate for the window's last blocks is set by a later log). */
export class NotReady extends Error {}

export type WindowMeasure = {
  /** the market's value, in the spec's base units */
  value: bigint;
  /** source-specific evidence, recomputed and compared field by field by the verifier */
  detail: Record<string, string | number>;
  /** the running value after blocks where it changed, for charts */
  series: [block: bigint, value: bigint][];
};

const ZERO32 = pad('0x0', { size: 32 });
const BLOB_GAS_PER_BLOB = 131_072n;
const SECONDS_PER_YEAR = 31_536_000n;
const WAD = 10n ** 18n;
/** How far before the window to look for the price in effect at its first block. */
const LOOKBACK_CHUNKS = 50n;

const word = (data: Hex, i: number) => hexToBigInt(`0x${data.slice(2 + 64 * i, 2 + 64 * (i + 1))}` as Hex);
const signed256 = (x: bigint) => (x >= 1n << 255n ? x - (1n << 256n) : x);
const byChain = (a: RawLog, b: RawLog) => {
  const d = hexToBigInt(a.blockNumber) - hexToBigInt(b.blockNumber);
  return d !== 0n ? (d < 0n ? -1 : 1) : Number(hexToBigInt(a.logIndex) - hexToBigInt(b.logIndex));
};
/** keccak256 over (txHash || logIndex) of every log used, in chain order. */
const logsHash = (logs: RawLog[]) =>
  keccak256(logs.length ? concat(logs.flatMap((l) => [l.transactionHash, numberToHex(hexToBigInt(l.logIndex), { size: 32 })])) : '0x');

/**
 * Measure `src` over the inclusive block range [from, to]. With `final`, the result is what the
 * resolver posts (and may throw NotReady); without it, a best current estimate for live charts.
 */
export async function measureWindowed(
  client: PublicClient,
  src: WindowedSource,
  from: bigint,
  to: bigint,
  final: boolean,
): Promise<WindowMeasure> {
  switch (src.kind) {
    case 'erc20_net_mint':
      return netMint(client, src, from, to);
    case 'univ3_price':
      return poolPrice(client, src, from, to);
    case 'morpho_rate':
      return morphoRate(client, src, from, to, final);
    case 'block_stat':
      return blockStat(client, src, from, to);
  }
}

async function netMint(client: PublicClient, src: NetMintSource, from: bigint, to: bigint): Promise<WindowMeasure> {
  const [mints, burns] = await Promise.all([
    getLogs(client, { address: src.token, topics: [ERC20_TRANSFER_TOPIC, ZERO32] }, from, to),
    getLogs(client, { address: src.token, topics: [ERC20_TRANSFER_TOPIC, null, ZERO32] }, from, to),
  ]);
  const minted = mints.reduce((a, l) => a + word(l.data, 0), 0n);
  const burned = burns.reduce((a, l) => a + word(l.data, 0), 0n);
  const all = [...mints.map((l) => [l, 1n] as const), ...burns.map((l) => [l, -1n] as const)].sort((a, b) => byChain(a[0], b[0]));
  const offset = BigInt(src.offset);
  const series: [bigint, bigint][] = [];
  let net = 0n;
  for (const [l, sign] of all) {
    net += sign * word(l.data, 0);
    series.push([hexToBigInt(l.blockNumber), offset + net]);
  }
  return {
    value: offset + minted - burned,
    detail: {
      mints: mints.length,
      minted: minted.toString(),
      burns: burns.length,
      burned: burned.toString(),
      dataHash: logsHash(all.map(([l]) => l)),
    },
    series,
  };
}

/** Price (token1 per token0, x 10^priceDecimals) from a Swap log's sqrtPriceX96. */
function swapPrice(src: PoolPriceSource, l: RawLog): bigint {
  const sqrt = word(l.data, 2);
  const exp = src.priceDecimals + src.decimals0 - src.decimals1;
  const num = sqrt * sqrt * (exp >= 0 ? 10n ** BigInt(exp) : 1n);
  const p = num >> 192n;
  return exp >= 0 ? p : p / 10n ** BigInt(-exp);
}

async function poolPrice(client: PublicClient, src: PoolPriceSource, from: bigint, to: bigint): Promise<WindowMeasure> {
  const f = { address: src.pool, topics: [UNI_V3_SWAP_TOPIC] };
  // the price in effect at `from` is set by the last swap before it
  let opening: RawLog | undefined;
  for (let i = 1n; i <= LOOKBACK_CHUNKS && !opening; i++) {
    const hi = from - (i - 1n) * 1000n - 1n;
    opening = (await getLogs(client, f, hi - 999n, hi)).at(-1);
  }
  if (!opening) throw new Error(`no swap in the ${LOOKBACK_CHUNKS * 1000n} blocks before the window`);
  const swaps = await getLogs(client, f, from, to);

  // each block's price is the pool price at the end of that block
  let cur = swapPrice(src, opening);
  let at = from;
  let sum = 0n;
  const series: [bigint, bigint][] = [[from, cur]];
  for (let i = 0; i < swaps.length; i++) {
    const bk = hexToBigInt(swaps[i].blockNumber);
    if (i + 1 < swaps.length && hexToBigInt(swaps[i + 1].blockNumber) === bk) continue; // last swap in the block wins
    sum += cur * (bk - at);
    cur = swapPrice(src, swaps[i]);
    at = bk;
    series.push([bk, (sum + cur) / (bk - from + 1n)]);
  }
  sum += cur * (to - at + 1n);
  const value = sum / (to - from + 1n);
  series.push([to, value]);
  return {
    value,
    detail: {
      openingBlock: Number(hexToBigInt(opening.blockNumber)),
      openingPrice: swapPrice(src, opening).toString(),
      swaps: swaps.length,
      dataHash: logsHash([opening, ...swaps]),
    },
    series,
  };
}

/** Per-second borrow rate (WAD) to APR in basis points. */
const aprBps = (ratePerSec: bigint) => (ratePerSec * SECONDS_PER_YEAR * 10_000n) / WAD;

async function morphoRate(client: PublicClient, src: MorphoRateSource, from: bigint, to: bigint, final: boolean): Promise<WindowMeasure> {
  const f = { address: src.morpho, topics: [MORPHO_ACCRUE_TOPIC, src.marketId] };
  // AccrueInterest(id, prevBorrowRate, ...) reports the rate that applied since the previous
  // accrual, so each block's rate comes from the first accrual at or after it. The window's last
  // blocks are priced by the first accrual after `to`.
  const accruals = await getLogs(client, f, from, to);
  const head = await getBlock(client);
  let next: RawLog | undefined;
  for (let a = to + 1n; a <= head.number && !next; a += 1000n) {
    next = (await getLogs(client, f, a, a + 999n > head.number ? head.number : a + 999n))[0];
  }
  if (!next && final) throw new NotReady('waiting for the first AccrueInterest after the window');
  // live estimate for blocks not yet priced: the latest known rate
  let tail = next ? word(next.data, 0) : accruals.length ? word(accruals[accruals.length - 1].data, 0) : undefined;
  if (tail === undefined) {
    for (let i = 1n; i <= LOOKBACK_CHUNKS && tail === undefined; i++) {
      const hi = from - (i - 1n) * 1000n - 1n;
      const l = (await getLogs(client, f, hi - 999n, hi)).at(-1);
      if (l) tail = word(l.data, 0);
    }
    if (tail === undefined) throw new Error('no AccrueInterest found for this market');
  }

  let at = from;
  let sum = 0n;
  const series: [bigint, bigint][] = [];
  for (const l of accruals) {
    const bk = hexToBigInt(l.blockNumber);
    sum += word(l.data, 0) * (bk - at + 1n);
    at = bk + 1n;
    series.push([bk, aprBps(sum / (bk - from + 1n))]);
  }
  if (at <= to) sum += tail * (to - at + 1n);
  const value = aprBps(sum / (to - from + 1n));
  series.push([to, value]);
  return {
    value,
    detail: {
      accruals: accruals.length,
      nextBlock: next ? Number(hexToBigInt(next.blockNumber)) : -1,
      dataHash: logsHash(next ? [...accruals, next] : accruals),
    },
    series,
  };
}

async function blockStat(client: PublicClient, src: BlockStatSource, from: bigint, to: bigint): Promise<WindowMeasure> {
  const every = src.every ?? 1;
  if (!Number.isInteger(every) || every < 1 || every > 100_000) throw new Unmeasurable(`bad block_stat.every: ${src.every}`);
  const step = BigInt(every);
  const nums: bigint[] = [];
  for (let n = ((from + step - 1n) / step) * step; n <= to; n += step) nums.push(n);
  if (!nums.length) throw new Unmeasurable(`no block in ${from}..${to} is a multiple of ${every}`);
  const headers: Awaited<ReturnType<typeof getBlock>>[] = [];
  for (let i = 0; i < nums.length; i += 25) headers.push(...(await Promise.all(nums.slice(i, i + 25).map((n) => getBlock(client, n)))));
  const per = (b: (typeof headers)[number]) => (src.field === 'baseFee' ? b.baseFee! : (b.blobGasUsed! / BLOB_GAS_PER_BLOB) * 100n);
  let sum = 0n;
  const series: [bigint, bigint][] = [];
  headers.forEach((b, i) => {
    sum += per(b);
    series.push([b.number, sum / BigInt(i + 1)]);
  });
  return { value: sum / BigInt(headers.length), detail: { blocks: headers.length, sum: sum.toString() }, series };
}
