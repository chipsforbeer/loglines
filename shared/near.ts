// NEAR contract types and read-only calls over plain JSON-RPC (browser and Node).
//
// Two deployments of the same contract:
// - testnet: collateral is native NEAR. Free to try (faucet-funded demo wallet).
// - mainnet: collateral is USDC. Bets can be paid with any token on any chain NEAR Intents
//   supports (1Click swaps it to USDC and delivers it into the contract as a bet), and winnings
//   can be paid out to any chain the same way.

export type NetworkId = 'testnet' | 'mainnet';

export type NetworkConfig = {
  id: NetworkId;
  rpc: string;
  contract: string;
  resolver: string;
  explorer: string;
  /** NEP-141 collateral token, or null for native NEAR */
  token: string | null;
  /** 1Click asset id of the collateral (mainnet only) */
  tokenAsset: string | null;
  decimals: number;
  symbol: string;
};

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  testnet: {
    id: 'testnet',
    rpc: 'https://test.rpc.fastnear.com',
    contract: 'loglines.testnet',
    resolver: 'loglines-resolver.testnet',
    explorer: 'https://testnet.nearblocks.io',
    token: null,
    tokenAsset: null,
    decimals: 24,
    symbol: 'NEAR',
  },
  mainnet: {
    id: 'mainnet',
    rpc: 'https://rpc.mainnet.fastnear.com',
    contract: 'loglines.near',
    resolver: 'resolver.loglines.near',
    explorer: 'https://nearblocks.io',
    // native Circle USDC on NEAR
    token: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
    tokenAsset: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
    decimals: 6,
    symbol: 'USDC',
  },
};

/**
 * Browser: ?net=mainnet or the saved choice, and ?contract=<account> for another deployment.
 * Node: NEAR_NETWORK, with LOGLINE_CONTRACT / LOGLINE_RESOLVER overriding the account ids.
 */
function pickNetwork(): NetworkConfig {
  let id: string | undefined;
  let contract: string | undefined;
  const g = globalThis as { process?: { env?: Record<string, string | undefined> }; location?: Location; localStorage?: Storage };
  const env = g.process?.env;
  if (env) id = env.NEAR_NETWORK;
  else {
    try {
      const q = new URLSearchParams(g.location?.search ?? '');
      id = q.get('net') ?? g.localStorage?.getItem('logline.net') ?? undefined;
      contract = q.get('contract') ?? undefined;
    } catch {
      id = undefined;
    }
  }
  const base = NETWORKS[id === 'mainnet' ? 'mainnet' : 'testnet'];
  return {
    ...base,
    contract: env?.LOGLINE_CONTRACT ?? contract ?? base.contract,
    resolver: env?.LOGLINE_RESOLVER ?? base.resolver,
  };
}

export const NET = pickNetwork();
export const NETWORK = NET.id;
export const NEAR_RPC = NET.rpc;
export const CONTRACT_ID = NET.contract;
export const RESOLVER_ID = NET.resolver;
export const EXPLORER = NET.explorer;
export const ONE_NEAR = 10n ** 24n;
/** one whole unit of collateral (1 NEAR or 1 USDC) in base units */
export const ONE = 10n ** BigInt(NET.decimals);
export const SYMBOL = NET.symbol;

export type Outcome = 'Yes' | 'No';
export type Resolution = 'Yes' | 'No' | 'Invalid';
export type Comparator = 'Gt' | 'Gte' | 'Lt' | 'Lte';

export type MarketSpec = {
  question: string;
  category: string;
  protocol: string;
  chain: string;
  metric: string;
  unit: string;
  decimals: number;
  comparator: Comparator;
  threshold: string;
  source: string;
  window_start: string;
  window_end: string;
  close_time: string;
};

export type Market = {
  id: number;
  creator: string;
  spec: MarketSpec;
  b: string;
  q_yes: string;
  q_no: string;
  pool: string;
  subsidy: string;
  volume: string;
  trades: number;
  created_at: string;
  resolution: Resolution | null;
  resolved_value: string | null;
  evidence: string | null;
  resolved_at: string | null;
  status: 'open' | 'closed' | 'resolved';
  price_yes: number;
  price_no: number;
};

export type Position = { yes: string; no: string; spent: string; received: string; claimed: boolean };
export type PricePoint = { t: string; p: number };
export type BuyQuote = { shares: string; avg_price: number; price_before: number; price_after: number; max_payout: string };
export type SellQuote = { payout: string; price_before: number; price_after: number };

export async function view<T>(method: string, args: object = {}, contractId = CONTRACT_ID, rpc = NEAR_RPC): Promise<T> {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'pm',
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'optimistic',
        account_id: contractId,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  if (j.result?.error) throw new Error(`${method}: ${j.result.error}`);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result))) as T;
}

export async function accountBalance(accountId: string, rpc = NEAR_RPC): Promise<bigint> {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'pm',
      method: 'query',
      params: { request_type: 'view_account', finality: 'optimistic', account_id: accountId },
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return BigInt(j.result.amount);
}

const PAGE = 100;
/** Every market, read page by page (one get_markets call returns at most PAGE). */
export async function getMarkets(): Promise<Market[]> {
  const out: Market[] = [];
  for (;;) {
    const page = await view<Market[]>('get_markets', { from_index: out.length, limit: PAGE });
    out.push(...page);
    if (page.length < PAGE) return out;
  }
}
export const getMarket = (id: number) => view<Market | null>('get_market', { market_id: id });
export const getHistory = (id: number) => view<PricePoint[]>('get_price_history', { market_id: id });
/** Collateral owed to an account after a failed payout, withdrawable with `withdraw_owed`. */
export const getOwed = (account: string) => view<string>('get_owed', { account_id: account }).then(BigInt);
export const getPositions = (account: string) => view<[number, Position][]>('get_positions', { account_id: account });
export const quoteBuy = (id: number, outcome: Outcome, amount: bigint) =>
  view<BuyQuote>('quote_buy', { market_id: id, outcome, amount: amount.toString() });
export const quoteSell = (id: number, outcome: Outcome, shares: bigint) =>
  view<SellQuote>('quote_sell', { market_id: id, outcome, shares: shares.toString() });

// ---------- formatting ----------

/** NEAR amount (yocto string/bigint) to a short decimal string. */
export function fmtNear(yocto: string | bigint, digits = 2): string {
  const v = Number(BigInt(yocto)) / 1e24;
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function parseNear(s: string): bigint {
  return parseUnits(s, 24);
}

export function parseUnits(s: string, decimals: number): bigint {
  const [i, f = ''] = s.trim().split('.');
  return BigInt(i || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

/** Collateral amount (base units) to a short decimal string, e.g. "1.50". */
export function fmtAmt(base: string | bigint, digits = 2): string {
  const v = Number(BigInt(base)) / 10 ** NET.decimals;
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Collateral amount typed by a user to base units. */
export function parseAmt(s: string): bigint {
  return parseUnits(s, NET.decimals);
}

/** Collateral balance of an account: NEAR on testnet, the token's balance on mainnet. */
export async function collateralBalance(accountId: string): Promise<bigint> {
  if (!NET.token) return accountBalance(accountId);
  const b = await view<string>('ft_balance_of', { account_id: accountId }, NET.token);
  return BigInt(b);
}

type MetricFormat = Pick<MarketSpec, 'decimals' | 'unit'> & { source?: string };

/** Signed sources report `offset + value` (the contract compares unsigned numbers). */
function metricOffset(spec: MetricFormat): bigint {
  if (!spec.source?.includes('"offset"')) return 0n;
  try {
    return BigInt(JSON.parse(spec.source).offset ?? 0);
  } catch {
    return 0n;
  }
}
const isSigned = (spec: MetricFormat) => metricOffset(spec) !== 0n;

/** A metric value in base units as a plain number in display units (offset removed). */
export function metricNumber(value: string | bigint, spec: MetricFormat): number {
  return Number(BigInt(value) - metricOffset(spec)) / 10 ** spec.decimals;
}

/** A metric in display units, formatted. */
export function fmtMetricNum(v: number, spec: MetricFormat): string {
  const sign = isSigned(spec) ? (v > 0 ? '+' : v < 0 ? '−' : '') : v < 0 ? '−' : '';
  const a = Math.abs(v);
  if (spec.unit === '%') return `${sign}${a.toFixed(2)}%`;
  if (spec.unit === 'USDC' || spec.unit === 'USD') {
    if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(3)}B`;
    if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
    return `${sign}$${a.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  }
  if (spec.unit === 'gwei') return `${sign}${a < 0.1 ? a.toFixed(4) : a < 1 ? a.toFixed(3) : a.toFixed(2)} gwei`;
  // prices: 8 decimals, trimmed to no fewer than 6, so a value just past a 6-decimal line reads as such
  if (spec.unit === 'USDT') return `${sign}${a.toFixed(8).replace(/0{1,2}$/, '')} USDT`;
  return `${sign}${a.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${spec.unit}`;
}

/** A metric value in base units with `decimals`, formatted for display. */
export function fmtMetric(value: string | bigint, spec: MetricFormat): string {
  return fmtMetricNum(metricNumber(value, spec), spec);
}

export const CMP_TEXT: Record<Comparator, string> = { Gt: '>', Gte: '≥', Lt: '<', Lte: '≤' };
