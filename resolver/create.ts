// Create markets from presets. Each preset reads recent on-chain history to set the line, so
// the market opens close to 50/50. Every metric can move both ways within the window.
//
//   npm run markets:create -- usdc-supply --minutes 180 --start-in 5   # Stablecoins
//   npm run markets:create -- usdc-peg    --minutes 60                 # Stablecoins
//   npm run markets:create -- morpho-util --minutes 120                # Lending
//   npm run markets:create -- morpho-rate --minutes 120                # Lending
//   npm run markets:create -- gas         --minutes 60                 # Network
//   npm run markets:create -- blobs       --minutes 60                 # Network
//
//   --start <ISO> or --start-in <min> sets the window start (default: next 5-minute mark after 5 min)
//   --threshold <x> sets the line in display units (USDC, USDT, %, gwei, blobs) instead of calibrating
//   --calibrate-minutes <m> calibrates the line on windows of this length (default: the market's own);
//     for multi-day markets, so the line comes from the last day instead of weeks of history
//   --every <n> (gas, blobs) averages only blocks whose number is a multiple of n, for multi-day windows
//   --b <x> sets LMSR liquidity in collateral (NEAR on testnet, USDC on mainnet); --dry-run prints the spec
//   NEAR_NETWORK=mainnet selects mainnet

import { parseArgs } from 'node:util';
import {
  ETH_BASE_FEE,
  ETH_BLOBS,
  ethClient,
  getBlock,
  MORPHO_BLUE,
  MORPHO_CBBTC_USDC,
  MORPHO_CBBTC_USDC_RATE,
  readMorpho,
  UNI_USDC_USDT_001,
  USDC_NET_MINT,
  windowBlocks,
  type BlockStatSource,
  type MorphoSource,
  type WindowedSource,
} from '../shared/metrics.ts';
import { measureWindowed } from '../shared/windowed.ts';
import { CONTRACT_ID, fmtMetric, NET, ONE, parseAmt, parseUnits, SYMBOL, view, type MarketSpec } from '../shared/near.ts';
import { call, loadAccount } from './signer.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    minutes: { type: 'string' },
    'start-in': { type: 'string' },
    start: { type: 'string' },
    at: { type: 'string' },
    'twap-minutes': { type: 'string' },
    'sample-every': { type: 'string' },
    'calibrate-minutes': { type: 'string' },
    every: { type: 'string' },
    'close-at-start': { type: 'boolean' },
    threshold: { type: 'string' },
    b: { type: 'string', default: '2' },
    'dry-run': { type: 'boolean' },
  },
});

const eth = ethClient();
const now = () => Math.floor(Date.now() / 1000);
const MIN = 60;

function hhmm(ts: number) {
  return new Date(ts * 1000).toISOString().slice(11, 16);
}
function dayLabel(ts: number) {
  return new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
/** start time: --start ISO, or now + --start-in minutes rounded up to 5 minutes */
function startTime(): number {
  if (values.start) return Math.floor(Date.parse(values.start) / 1000);
  const t = now() + Number(values['start-in'] ?? 5) * MIN;
  return Math.ceil(t / (5 * MIN)) * 5 * MIN;
}
function median(xs: bigint[]): bigint {
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2n;
}
const roundTo = (x: bigint, step: bigint) => ((x + step / 2n) / step) * step;

type Window = { start: number; end: number; minutes: number; span: string; close: number };
function windowFrom(defaultMinutes: number): Window {
  const minutes = Number(values.minutes ?? defaultMinutes);
  const start = startTime();
  const end = start + minutes * MIN;
  return {
    start,
    end,
    minutes,
    span:
      dayLabel(start) === dayLabel(end)
        ? `between ${hhmm(start)} and ${hhmm(end)} UTC on ${dayLabel(start)}`
        : `between ${hhmm(start)} UTC on ${dayLabel(start)} and ${hhmm(end)} UTC on ${dayLabel(end)}`,
    close: end - Math.max(MIN, Math.floor((minutes * MIN) / 10)),
  };
}

/** The source's value over each of the last `k` completed calibration windows (--calibrate-minutes, default the market's length). */
async function trailing(src: WindowedSource, marketMinutes: number, k = 6): Promise<bigint[]> {
  const len = calMinutes(marketMinutes) * MIN;
  const head = await getBlock(eth);
  const lastEnd = Math.floor(head.timestamp / len) * len;
  const out: bigint[] = [];
  for (let i = k; i >= 1; i--) {
    const w = await windowBlocks(eth, lastEnd - i * len, lastEnd - (i - 1) * len, head);
    out.push((await measureWindowed(eth, src, w!.from.number, w!.to.number, false)).value);
  }
  return out;
}

const calMinutes = (marketMinutes: number) => Number(values['calibrate-minutes'] ?? marketMinutes);

/** A block-header source, optionally sampled every --every blocks; and how the metric reads. */
function headerSource(base: BlockStatSource, what: string): [BlockStatSource, string] {
  if (!values.every) return [base, `${what}, averaged over every block`];
  const every = Number(values.every);
  if (!Number.isInteger(every) || every < 1) throw new Error('--every must be a positive integer');
  return [{ ...base, every }, `${what}, averaged over every block whose number is a multiple of ${every}`];
}

/** The line: --threshold in display units, or the calibrated value. */
function line(calibrated: bigint, spec: Pick<MarketSpec, 'decimals' | 'unit'> & { source?: string }, offset = 0n): bigint {
  if (!values.threshold) return calibrated;
  const t = values.threshold.trim();
  const neg = t.startsWith('-');
  const v = parseUnits(neg ? t.slice(1) : t, spec.decimals);
  return offset + (neg ? -v : v);
}

function windowed(
  w: Window,
  src: WindowedSource,
  p: Pick<MarketSpec, 'question' | 'category' | 'protocol' | 'metric' | 'unit' | 'decimals'>,
  threshold: bigint,
): MarketSpec {
  return {
    ...p,
    chain: 'ethereum',
    comparator: 'Gt',
    threshold: threshold.toString(),
    source: JSON.stringify(src),
    window_start: String(w.start),
    window_end: String(w.end),
    close_time: String(values['close-at-start'] ? w.start : w.close),
  };
}

// ---------- Stablecoins ----------

async function usdcSupply(): Promise<MarketSpec> {
  const w = windowFrom(180);
  const offset = BigInt(USDC_NET_MINT.offset);
  const fmt = { decimals: 6, unit: 'USDC', source: JSON.stringify(USDC_NET_MINT) };
  const recent = await trailing(USDC_NET_MINT, w.minutes);
  console.log(`trailing ${calMinutes(w.minutes)}m net supply changes: ${recent.map((v) => fmtMetric(v, fmt)).join(', ')}`);
  const t = line(offset, fmt, offset);
  const what = t === offset ? 'grow' : `grow by more than ${fmtMetric(t, fmt).replace('+', '')}`;
  return windowed(
    w,
    USDC_NET_MINT,
    {
      question: `Will USDC's supply on Ethereum ${what} ${w.span}?`,
      category: 'Stablecoins',
      protocol: 'Circle USDC',
      metric: 'USDC minted minus USDC burned (Transfer from/to 0x0)',
      unit: 'USDC',
      decimals: 6,
    },
    t,
  );
}

async function usdcPeg(): Promise<MarketSpec> {
  const w = windowFrom(60);
  const fmt = { decimals: 8, unit: 'USDT' };
  const recent = await trailing(UNI_USDC_USDT_001, w.minutes, 1);
  const t = line(roundTo(recent[0], 100n), fmt);
  console.log(`last ${calMinutes(w.minutes)}m average ${fmtMetric(recent[0], fmt)} -> line ${fmtMetric(t, fmt)}`);
  return windowed(
    w,
    UNI_USDC_USDT_001,
    {
      question: `Will USDC average above ${fmtMetric(t, fmt)} on Uniswap's USDC/USDT 0.01% pool ${w.span}?`,
      category: 'Stablecoins',
      protocol: 'Uniswap v3',
      metric: 'USDC price in USDT, averaged over every block',
      unit: 'USDT',
      decimals: 8,
    },
    t,
  );
}

// ---------- Lending ----------

function morphoSource(field: MorphoSource['field'], every: number): MorphoSource {
  return {
    kind: 'morpho_market',
    chainId: 1,
    morpho: MORPHO_BLUE,
    marketId: MORPHO_CBBTC_USDC,
    field,
    sampleEverySec: every,
    label: 'Morpho Blue cbBTC/USDC (86% LLTV)',
  };
}

async function morphoUtil(): Promise<MarketSpec> {
  const w = windowFrom(120);
  const src = morphoSource('utilization', Number(values['sample-every'] ?? 10) * MIN);
  const head = await getBlock(eth);
  const current = await readMorpho(eth, src, head.number);
  const spec = { decimals: 2, unit: '%' };
  const t = line(current, spec);
  console.log(`current utilization ${fmtMetric(current, spec)} -> line ${fmtMetric(t, spec)}`);
  return {
    question: `Will Morpho Blue's cbBTC/USDC market average above ${fmtMetric(t, spec)} utilization ${w.span}?`,
    category: 'Lending',
    protocol: 'Morpho Blue',
    chain: 'ethereum',
    metric: `Utilization (borrow / supply), averaged over samples every ${src.sampleEverySec / MIN} min`,
    unit: '%',
    decimals: 2,
    comparator: 'Gt',
    threshold: t.toString(),
    source: JSON.stringify(src),
    window_start: String(w.start),
    window_end: String(w.end),
    close_time: String(w.close),
  };
}

async function morphoRate(): Promise<MarketSpec> {
  const w = windowFrom(120);
  const spec = { decimals: 2, unit: '%' };
  const recent = await trailing(MORPHO_CBBTC_USDC_RATE, w.minutes);
  const t = line(median(recent), spec);
  console.log(`trailing ${calMinutes(w.minutes)}m borrow APRs: ${recent.map((v) => fmtMetric(v, spec)).join(', ')} -> line ${fmtMetric(t, spec)}`);
  return windowed(
    w,
    MORPHO_CBBTC_USDC_RATE,
    {
      question: `Will the borrow rate on Morpho Blue's cbBTC/USDC market average above ${fmtMetric(t, spec)} APR ${w.span}?`,
      category: 'Lending',
      protocol: 'Morpho Blue',
      metric: 'Borrow APR from AccrueInterest, averaged over every block',
      unit: '%',
      decimals: 2,
    },
    t,
  );
}

// ---------- Network ----------

async function gas(): Promise<MarketSpec> {
  const w = windowFrom(60);
  const spec = { decimals: 9, unit: 'gwei' };
  const [src, metric] = headerSource(ETH_BASE_FEE, 'Base fee per gas');
  const recent = await trailing(src, w.minutes);
  const m = median(recent);
  // round to the precision shown: 0.0001 gwei below 0.1, 0.001 below 1, else 0.01
  const t = line(roundTo(m, m < 10n ** 8n ? 10n ** 5n : m < 10n ** 9n ? 10n ** 6n : 10n ** 7n), spec);
  console.log(`trailing ${calMinutes(w.minutes)}m base fees: ${recent.map((v) => fmtMetric(v, spec)).join(', ')} -> line ${fmtMetric(t, spec)}`);
  return windowed(
    w,
    src,
    {
      question: `Will Ethereum's base fee average above ${fmtMetric(t, spec)} ${w.span}?`,
      category: 'Network',
      protocol: 'Ethereum',
      metric,
      unit: 'gwei',
      decimals: 9,
    },
    t,
  );
}

async function blobs(): Promise<MarketSpec> {
  const w = windowFrom(60);
  const spec = { decimals: 2, unit: 'blobs/block' };
  const [src, metric] = headerSource(ETH_BLOBS, 'Blobs per block (rollup data posted to Ethereum)');
  const recent = await trailing(src, w.minutes);
  const t = line(median(recent), spec);
  console.log(`trailing ${calMinutes(w.minutes)}m blobs per block: ${recent.map((v) => fmtMetric(v, spec)).join(', ')} -> line ${fmtMetric(t, spec)}`);
  return windowed(
    w,
    src,
    {
      question: `Will Ethereum blocks average more than ${fmtMetric(t, spec).replace(' blobs/block', '')} blobs ${w.span}?`,
      category: 'Network',
      protocol: 'Ethereum',
      metric,
      unit: 'blobs/block',
      decimals: 2,
    },
    t,
  );
}

const presets: Record<string, () => Promise<MarketSpec>> = {
  'usdc-supply': usdcSupply,
  'usdc-peg': usdcPeg,
  'morpho-util': morphoUtil,
  'morpho-rate': morphoRate,
  gas,
  blobs,
};

const name = positionals[0];
if (!presets[name]) {
  console.error(`usage: create.ts <${Object.keys(presets).join('|')}> [options]`);
  process.exit(1);
}
const spec = await presets[name]();
const b = parseAmt(values.b!);
// subsidy must cover the LMSR worst case b*ln(2); round up a little
const subsidy = (b * 693_148n) / 1_000_000n + ONE / 1000n;
console.log(JSON.stringify(spec, null, 2));
console.log(`${NET.id}: b = ${values.b} ${SYMBOL}, subsidy = ${Number(subsidy) / Number(ONE)} ${SYMBOL}`);
if (values['dry-run']) process.exit(0);

const account = loadAccount();
if (!NET.token) {
  const id = await call<number>(account, 'create_market', { spec, b: b.toString() }, subsidy);
  console.log(`created market #${id}`);
} else {
  // token collateral: the subsidy is sent with ft_transfer_call and the message opens the market
  const msg = JSON.stringify({ create_market: { spec, b: b.toString() } });
  await call(account, 'ft_transfer_call', { receiver_id: CONTRACT_ID, amount: subsidy.toString(), msg }, 1n, 150_000_000_000_000n, NET.token);
  const cfg = await view<{ market_count: number }>('get_config');
  console.log(`created market #${cfg.market_count - 1}`);
}
