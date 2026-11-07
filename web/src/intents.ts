// NEAR Intents through the 1Click API: pay a bet with any token on any supported chain, and send
// winnings out to any chain. Mainnet only (Intents has no testnet).
//
// Pay:   origin token (e.g. SOL on Solana) -> USDC on NEAR, delivered to the Logline contract with
//        ft_transfer_call and a {"buy": {...}} message (customRecipientMsg), so the swap lands as a bet.
// Payout: USDC on NEAR -> any token; the contract's claim(to = depositAddress) sends the winnings
//        straight into the swap.

import { CONTRACT_ID, NET, type Outcome } from '../../shared/near.ts';

export const ONECLICK = 'https://1click.chaindefuser.com';

/**
 * Intents has no testnet. On the testnet deployment the app still shows real 1Click mainnet quotes
 * (priced into wNEAR, since testnet bets are in NEAR) and places the bet or claim as a real testnet
 * transaction; only the cross-chain deposit and swap in between are simulated, and labeled so.
 */
export const SIMULATED = NET.id === 'testnet';
const SIM_ASSET = 'nep141:wrap.near';
/** An existing mainnet account, used only as the recipient of dry (price-only) quotes. */
const SIM_NEAR_ACCOUNT = 'intents.near';
/** The collateral as a 1Click asset: USDC on mainnet, wNEAR for testnet previews. */
const collateralAsset = () => NET.tokenAsset ?? SIM_ASSET;

export type Token = {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  contractAddress?: string;
};

export type Quote = {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd?: string;
  minAmountIn?: string;
  amountOut: string;
  amountOutFormatted: string;
  minAmountOut: string;
  deadline?: string;
  timeEstimate?: number;
};

export type QuoteResponse = { quote: Quote; quoteRequest: Record<string, unknown>; signature?: string; timestamp?: string };

export type SwapStatus = 'PENDING_DEPOSIT' | 'KNOWN_DEPOSIT_TX' | 'INCOMPLETE_DEPOSIT' | 'PROCESSING' | 'SUCCESS' | 'REFUNDED' | 'FAILED';

export type StatusResponse = {
  status: SwapStatus;
  updatedAt: string;
  swapDetails?: {
    nearTxHashes?: string[];
    amountOutFormatted?: string;
    originChainTxHashes?: { hash: string; explorerUrl: string }[];
    destinationChainTxHashes?: { hash: string; explorerUrl: string }[];
    refundedAmountFormatted?: string;
    refundReason?: string;
  };
};

export const CHAIN_NAMES: Record<string, string> = {
  sol: 'Solana',
  eth: 'Ethereum',
  base: 'Base',
  arb: 'Arbitrum',
  op: 'Optimism',
  pol: 'Polygon',
  bsc: 'BNB Chain',
  avax: 'Avalanche',
  btc: 'Bitcoin',
  near: 'NEAR',
  ton: 'TON',
  tron: 'Tron',
  sui: 'Sui',
  zec: 'Zcash',
  doge: 'Dogecoin',
  xrp: 'XRP',
  gnosis: 'Gnosis',
  bera: 'Berachain',
  aptos: 'Aptos',
  stellar: 'Stellar',
  starknet: 'Starknet',
  cardano: 'Cardano',
  ltc: 'Litecoin',
};
export const chainName = (c: string) => CHAIN_NAMES[c] ?? c.toUpperCase();

/** Chains whose addresses a user can paste for refunds/payouts; others work with a pasted address too. */
export const FEATURED: { chain: string; symbol: string }[] = [
  { chain: 'sol', symbol: 'SOL' },
  { chain: 'sol', symbol: 'USDC' },
  { chain: 'base', symbol: 'USDC' },
  { chain: 'base', symbol: 'ETH' },
  { chain: 'arb', symbol: 'USDC' },
  { chain: 'eth', symbol: 'ETH' },
  { chain: 'btc', symbol: 'BTC' },
  { chain: 'near', symbol: 'wNEAR' },
];

let tokensCache: Promise<Token[]> | null = null;
export function getTokens(): Promise<Token[]> {
  tokensCache ??= fetch(`${ONECLICK}/v0/tokens`)
    .then((r) => {
      if (!r.ok) throw new Error(`tokens: ${r.status}`);
      return r.json() as Promise<Token[]>;
    })
    .catch((e) => {
      tokensCache = null;
      throw e;
    });
  return tokensCache;
}

async function postQuote(body: Record<string, unknown>): Promise<QuoteResponse> {
  const r = await fetch(`${ONECLICK}/v0/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.message ?? `quote failed (${r.status})`);
  return j as QuoteResponse;
}

const deadline = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

/** The `ft_transfer_call` message that turns delivered USDC into a bet for `account`. */
export function betMsg(account: string, marketId: number, outcome: Outcome, minShares: bigint): string {
  return JSON.stringify({ buy: { market_id: marketId, outcome, min_shares: minShares.toString(), account } });
}

/**
 * Quote paying `amountIn` (origin base units) of `origin` for a bet: the swap output (collateral)
 * is delivered into the contract as the bet. `dry` quotes show the price without a deposit address.
 */
export function quoteBet(p: {
  origin: Token;
  amountIn: bigint;
  account: string;
  marketId: number;
  outcome: Outcome;
  minShares: bigint;
  refundTo: string;
  dry: boolean;
}): Promise<QuoteResponse> {
  return postQuote({
    dry: p.dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: p.origin.assetId,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: collateralAsset(),
    amount: p.amountIn.toString(),
    refundTo: p.refundTo,
    refundType: 'ORIGIN_CHAIN',
    recipient: SIMULATED ? SIM_NEAR_ACCOUNT : CONTRACT_ID,
    recipientType: 'DESTINATION_CHAIN',
    ...(SIMULATED ? {} : { customRecipientMsg: betMsg(p.account, p.marketId, p.outcome, p.minShares) }),
    deadline: deadline(30),
  });
}

/** Quote sending `amount` USDC (base units) of winnings out as `dest` to `recipient`. */
export function quotePayout(p: { dest: Token; amount: bigint; recipient: string; refundTo: string; dry: boolean }): Promise<QuoteResponse> {
  return postQuote({
    dry: p.dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: collateralAsset(),
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: p.dest.assetId,
    amount: p.amount.toString(),
    refundTo: SIMULATED ? SIM_NEAR_ACCOUNT : p.refundTo,
    refundType: 'ORIGIN_CHAIN',
    recipient: p.recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline: deadline(30),
  });
}

export async function swapStatus(depositAddress: string, depositMemo?: string): Promise<StatusResponse> {
  const q = new URLSearchParams({ depositAddress });
  if (depositMemo) q.set('depositMemo', depositMemo);
  const r = await fetch(`${ONECLICK}/v0/status?${q}`);
  if (!r.ok) throw new Error(`status: ${r.status}`);
  return r.json();
}

export const DONE: SwapStatus[] = ['SUCCESS', 'REFUNDED', 'FAILED'];

/** Syntactically valid addresses for dry (price-only) quotes before the user enters their own. */
export function placeholderAddress(t: Token): string {
  if (t.blockchain === 'sol') return 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  if (t.blockchain === 'btc') return 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
  if (t.blockchain === 'near') return SIM_NEAR_ACCOUNT;
  return '0x1111111111111111111111111111111111111111';
}

/** A wallet payment link for the deposit (Solana Pay, EIP-681, BIP-21), or the plain address. */
export function paymentUri(t: Token, to: string, amountIn: string): string {
  const human = (Number(BigInt(amountIn)) / 10 ** t.decimals).toString();
  if (t.blockchain === 'sol') {
    return `solana:${to}?amount=${human}${t.contractAddress ? `&spl-token=${t.contractAddress}` : ''}`;
  }
  const evm: Record<string, number> = { eth: 1, base: 8453, arb: 42161, op: 10, pol: 137, bsc: 56, avax: 43114, gnosis: 100 };
  if (evm[t.blockchain]) {
    const id = evm[t.blockchain];
    return t.contractAddress
      ? `ethereum:${t.contractAddress}@${id}/transfer?address=${to}&uint256=${amountIn}`
      : `ethereum:${to}@${id}?value=${amountIn}`;
  }
  if (t.blockchain === 'btc') return `bitcoin:${to}?amount=${human}`;
  return to;
}
