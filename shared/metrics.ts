// Measuring on-chain metrics for market resolution. Shared by the resolver (Node) and the web app.
// Everything here is deterministic given an RPC: block ranges come from timestamps, and the
// measured value comes from logs or contract state at fixed blocks.

import {
  concat,
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  fallback,
  http,
  keccak256,
  numberToHex,
  type Hex,
  type PublicClient,
} from 'viem';
import { mainnet } from 'viem/chains';

export const ETH_RPCS = ['https://ethereum-rpc.publicnode.com', 'https://rpc.mevblocker.io'];

/** Count of logs emitted by `address` with `topic0` in the window. */
export type LogCountSource = {
  kind: 'evm_log_count';
  chainId: 1;
  address: Hex;
  topic0: Hex;
  /** Human-readable event signature, e.g. Swap(address,address,int256,int256,uint160,uint128,int24) */
  event: string;
  /** Display name of the contract, e.g. "USDC/WETH 0.05% pool" */
  label: string;
};

/** A Morpho Blue market's state, sampled at fixed times across the window and averaged. */
export type MorphoSource = {
  kind: 'morpho_market';
  chainId: 1;
  morpho: Hex;
  marketId: Hex;
  /** totalBorrowAssets in loan-token base units, or utilization in basis points (decimals 2 => %) */
  field: 'totalBorrowAssets' | 'utilization';
  sampleEverySec: number;
  label: string;
};

/**
 * Net supply change of an ERC-20 over the window: amount minted (Transfer from 0x0) minus amount
 * burned (Transfer to 0x0). The contract compares unsigned numbers, so the value is reported as
 * `offset + net`; a line of `offset` means "did supply grow".
 */
export type NetMintSource = {
  kind: 'erc20_net_mint';
  chainId: 1;
  token: Hex;
  symbol: string;
  label: string;
  offset: string;
};

/** A Uniswap v3 pool's price (token1 per token0, x 10^priceDecimals), averaged over every block of the window. */
export type PoolPriceSource = {
  kind: 'univ3_price';
  chainId: 1;
  pool: Hex;
  label: string;
  base: string;
  quote: string;
  decimals0: number;
  decimals1: number;
  priceDecimals: number;
};

/** A Morpho Blue market's borrow APR in basis points, averaged over every block of the window (AccrueInterest logs). */
export type MorphoRateSource = {
  kind: 'morpho_rate';
  chainId: 1;
  morpho: Hex;
  marketId: Hex;
  label: string;
};

/**
 * A block header field averaged over the window's blocks: base fee (wei), or blobs per block (x 100).
 * With `every`, only blocks whose number is a multiple of it count (for windows of days, so the
 * value stays cheap to recompute from any RPC); without it, every block counts.
 */
export type BlockStatSource = {
  kind: 'block_stat';
  chainId: 1;
  field: 'baseFee' | 'blobs';
  every?: number;
  label: string;
};

/** Sources measured entirely from logs and block headers, so any public RPC can re-check them later. */
export type WindowedSource = NetMintSource | PoolPriceSource | MorphoRateSource | BlockStatSource;
export const WINDOWED_KINDS = ['erc20_net_mint', 'univ3_price', 'morpho_rate', 'block_stat'] as const;
export const isWindowed = (s: Source): s is WindowedSource => (WINDOWED_KINDS as readonly string[]).includes(s.kind);

export type Source = LogCountSource | MorphoSource | WindowedSource;

export type Block = { number: bigint; timestamp: number; hash: Hex; baseFee?: bigint; blobGasUsed?: bigint };

export function ethClient(rpcs: string[] = ETH_RPCS): PublicClient {
  return createPublicClient({
    chain: mainnet,
    transport: fallback(rpcs.map((u) => http(u, { retryCount: 2, timeout: 20_000 }))),
  }) as PublicClient;
}

const blockCache = new Map<bigint, Block>();
/** Highest head seen by getBlock(), so log chunks well below it can be cached. */
let knownHead = 0n;
/** Blocks below the head after which a chunk of logs is treated as final and cached. */
const CACHE_DEPTH = 64n;

export async function getBlock(client: PublicClient, number?: bigint): Promise<Block> {
  if (number !== undefined && blockCache.has(number)) return blockCache.get(number)!;
  const b = number === undefined ? await client.getBlock() : await client.getBlock({ blockNumber: number });
  if (number === undefined && b.number! > knownHead) knownHead = b.number!;
  const out: Block = {
    number: b.number!,
    timestamp: Number(b.timestamp),
    hash: b.hash!,
    baseFee: b.baseFeePerGas ?? 0n,
    blobGasUsed: b.blobGasUsed ?? 0n,
  };
  blockCache.set(out.number, out);
  return out;
}

/** The first block with timestamp >= ts, or null if the chain has not reached ts yet. */
export async function blockAtOrAfter(client: PublicClient, ts: number, head?: Block): Promise<Block | null> {
  head ??= await getBlock(client);
  if (head.timestamp < ts) return null;
  // Ethereum slots are 12s; start from an estimate and widen until the target is bracketed.
  const est = head.number - BigInt(Math.max(0, Math.floor((head.timestamp - ts) / 12)));
  let lo = est - 8n;
  let hi = est + 8n > head.number ? head.number : est + 8n;
  let span = 16n;
  while ((await getBlock(client, lo)).timestamp >= ts) {
    hi = lo;
    lo -= span;
    span *= 2n;
  }
  span = 16n;
  while ((await getBlock(client, hi)).timestamp < ts) {
    lo = hi;
    hi = hi + span > head.number ? head.number : hi + span;
    span *= 2n;
  }
  // invariant: ts(lo) < ts <= ts(hi)
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await getBlock(client, mid)).timestamp >= ts) hi = mid;
    else lo = mid;
  }
  return getBlock(client, hi);
}

/** Inclusive block range [from, to] covering timestamps [start, end). Null until `end` is reached. */
export async function windowBlocks(
  client: PublicClient,
  start: number,
  end: number,
  head?: Block,
): Promise<{ from: Block; to: Block } | null> {
  head ??= await getBlock(client);
  const from = await blockAtOrAfter(client, start, head);
  const after = await blockAtOrAfter(client, end, head);
  if (!from || !after) return null;
  return { from, to: await getBlock(client, after.number - 1n) };
}

export type LogCount = {
  count: number;
  /** keccak256 over (txHash ‖ logIndex) of every counted log, in chain order. */
  dataHash: Hex;
  /** block number of each counted log, for charting */
  blocks: bigint[];
};

/** A market that can never be measured as specified, as opposed to a transient RPC failure. */
export class Unmeasurable extends Error {}

/**
 * RPC errors that mean "too many results or too wide a range", which a narrower query fixes.
 * Only specific cap phrases: a bare "exceeded" also appears in timeouts ("context deadline
 * exceeded"), which must be retried, not split.
 */
const RESULT_CAP =
  /more than \d+ results|response size (exceeded|is larger)|log response size|(maximum|max) block range|block range (is )?too (large|wide)|range too (large|wide)|too many (results|logs)|exceeds defined limit|-32005/i;
const TRANSIENT = /rate|429|too many requests|timeout|timed out|deadline|retries|header/i;
function isResultCap(e: unknown): boolean {
  const text = [(e as Error)?.message, (e as { details?: string })?.details].filter(Boolean).join(' ');
  return RESULT_CAP.test(text) && !TRANSIENT.test(text);
}

export type RawLog = { transactionHash: Hex; logIndex: Hex; blockNumber: Hex; data: Hex; topics: Hex[] };
export type LogFilter = { address: Hex; topics: (Hex | null)[] };

/**
 * eth_getLogs over [a, b]. If the RPC refuses the range for its size, split it in half and retry,
 * so stuffing one chunk with logs can't make a market unmeasurable. Results stay in chain order.
 * A single block can't realistically exceed a cap (a pool's swaps fill at most a few hundred logs
 * per block), so a "cap" there is treated as a transient RPC fault, not as Unmeasurable.
 */
async function getLogsRange(client: PublicClient, f: LogFilter, a: bigint, b: bigint): Promise<RawLog[]> {
  try {
    return (await client.request({
      method: 'eth_getLogs',
      params: [{ address: f.address, topics: f.topics, fromBlock: numberToHex(a), toBlock: numberToHex(b) }],
    } as never)) as RawLog[];
  } catch (e) {
    if (!isResultCap(e)) throw e;
    if (a === b) throw new Error(`RPC refused the logs of block ${a} as too large: ${(e as Error).message.slice(0, 160)}`);
    const mid = (a + b) / 2n;
    return [...(await getLogsRange(client, f, a, mid)), ...(await getLogsRange(client, f, mid + 1n, b))];
  }
}

const logCache = new Map<string, RawLog[]>();
const LOG_CONCURRENCY = 4;

/**
 * All logs matching `f` in [from, to], in chain order, fetched in chunks (a few at a time).
 * Chunks at least CACHE_DEPTH blocks below the latest head are kept in memory, so polling a
 * window that spans days refetches only its recent end.
 */
export async function getLogs(client: PublicClient, f: LogFilter, from: bigint, to: bigint, chunk = 1000n): Promise<RawLog[]> {
  const ranges: [bigint, bigint][] = [];
  for (let a = from; a <= to; a += chunk) ranges.push([a, a + chunk - 1n > to ? to : a + chunk - 1n]);
  const parts: RawLog[][] = new Array(ranges.length);
  let next = 0;
  const worker = async () => {
    while (next < ranges.length) {
      const i = next++;
      const [a, b] = ranges[i];
      const key = `${f.address}|${f.topics.join(',')}|${a}|${b}`;
      const hit = logCache.get(key);
      if (hit) {
        parts[i] = hit;
        continue;
      }
      parts[i] = await getLogsRange(client, f, a, b);
      if (b + CACHE_DEPTH <= knownHead) logCache.set(key, parts[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOG_CONCURRENCY, ranges.length) }, worker));
  return parts.flat();
}

export async function countLogs(
  client: PublicClient,
  src: LogCountSource,
  from: bigint,
  to: bigint,
  chunk = 1000n,
): Promise<LogCount> {
  const parts: Hex[] = [];
  const blocks: bigint[] = [];
  for (let a = from; a <= to; a += chunk) {
    const b = a + chunk - 1n > to ? to : a + chunk - 1n;
    for (const l of await getLogsRange(client, { address: src.address, topics: [src.topic0] }, a, b)) {
      parts.push(l.transactionHash, numberToHex(BigInt(l.logIndex), { size: 32 }));
      blocks.push(BigInt(l.blockNumber));
    }
  }
  return { count: blocks.length, dataHash: keccak256(parts.length ? concat(parts) : '0x'), blocks };
}

const MORPHO_ABI = [
  {
    type: 'function',
    name: 'market',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      { name: 'totalSupplyAssets', type: 'uint128' },
      { name: 'totalSupplyShares', type: 'uint128' },
      { name: 'totalBorrowAssets', type: 'uint128' },
      { name: 'totalBorrowShares', type: 'uint128' },
      { name: 'lastUpdate', type: 'uint128' },
      { name: 'fee', type: 'uint128' },
    ],
  },
] as const;

/** The source's value at a block (state as recorded on-chain at that block). */
export async function readMorpho(client: PublicClient, src: MorphoSource, block: bigint): Promise<bigint> {
  const data = encodeFunctionData({ abi: MORPHO_ABI, functionName: 'market', args: [src.marketId] });
  const ret = await client.call({ to: src.morpho, data, blockNumber: block });
  const [supply, , borrow] = decodeFunctionResult({ abi: MORPHO_ABI, functionName: 'market', data: ret.data! });
  if (src.field === 'totalBorrowAssets') return borrow;
  return supply === 0n ? 0n : (borrow * 10_000n) / supply;
}

/** Scheduled sample times for a sampled source: start, start+every, ... < end. */
export function sampleTimes(src: MorphoSource, start: number, end: number): number[] {
  const out: number[] = [];
  for (let t = start; t < end; t += src.sampleEverySec) out.push(t);
  return out;
}

export const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as Hex;
export const MORPHO_ACCRUE_TOPIC = '0x9d9bd501d0657d7dfe415f779a620a62b78bc508ddc0891fbbd8b7ac0f8fce87' as Hex;

export function parseSource(json: string): Source {
  return JSON.parse(json) as Source;
}

// ---------- presets (real Ethereum mainnet contracts) ----------

export const UNI_V3_SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67' as Hex;

export const UNI_USDC_WETH_005: LogCountSource = {
  kind: 'evm_log_count',
  chainId: 1,
  address: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',
  topic0: UNI_V3_SWAP_TOPIC,
  event: 'Swap(address,address,int256,int256,uint160,uint128,int24)',
  label: 'Uniswap v3 USDC/WETH 0.05% pool',
};

export const MORPHO_BLUE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as Hex;
export const MORPHO_CBBTC_USDC = '0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64' as Hex;

export const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Hex;

/** USDC minted minus burned on Ethereum; reported as offset + net (offset = 1e20 base units = 100T USDC). */
export const USDC_NET_MINT: NetMintSource = {
  kind: 'erc20_net_mint',
  chainId: 1,
  token: USDC_ETH,
  symbol: 'USDC',
  label: 'USDC (Circle) on Ethereum',
  offset: (10n ** 20n).toString(),
};

/** USDC/USDT on Uniswap v3 (0.01%): token0 USDC, token1 USDT, price in USDT per USDC x 1e8. */
export const UNI_USDC_USDT_001: PoolPriceSource = {
  kind: 'univ3_price',
  chainId: 1,
  pool: '0x3416cF6C708Da44DB2624D63ea0AAef7113527C6',
  label: 'Uniswap v3 USDC/USDT 0.01% pool',
  base: 'USDC',
  quote: 'USDT',
  decimals0: 6,
  decimals1: 6,
  priceDecimals: 8,
};

export const MORPHO_CBBTC_USDC_RATE: MorphoRateSource = {
  kind: 'morpho_rate',
  chainId: 1,
  morpho: MORPHO_BLUE,
  marketId: MORPHO_CBBTC_USDC,
  label: 'Morpho Blue cbBTC/USDC (86% LLTV)',
};

export const ETH_BASE_FEE: BlockStatSource = { kind: 'block_stat', chainId: 1, field: 'baseFee', label: 'Ethereum base fee' };
export const ETH_BLOBS: BlockStatSource = { kind: 'block_stat', chainId: 1, field: 'blobs', label: 'Ethereum blobs per block' };
