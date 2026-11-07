// Send a Solana deposit (SOL or an SPL token) with Phantom. The Solana libraries are loaded only
// when this is used, so they do not weigh on the rest of the app.

import type { Token } from './intents.ts';

const SOLANA_RPC = 'https://solana-rpc.publicnode.com';

type PhantomProvider = {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect(): Promise<{ publicKey: { toString(): string } }>;
  signAndSendTransaction(tx: unknown): Promise<{ signature: string }>;
};

export function phantom(): PhantomProvider | null {
  const w = window as unknown as { phantom?: { solana?: PhantomProvider }; solana?: PhantomProvider };
  return w.phantom?.solana ?? (w.solana?.isPhantom ? w.solana : null);
}

export async function connectPhantom(): Promise<string> {
  const p = phantom();
  if (!p) throw new Error('Phantom is not installed');
  const r = await p.connect();
  return r.publicKey.toString();
}

/** Transfer `amountIn` (base units) of `token` on Solana to `to`. Returns the signature. */
export async function sendWithPhantom(token: Token, to: string, amountIn: string): Promise<string> {
  const p = phantom();
  if (!p) throw new Error('Phantom is not installed');
  const { Buffer } = await import('buffer');
  (globalThis as { Buffer?: unknown }).Buffer ??= Buffer;
  const web3 = await import('@solana/web3.js');
  const conn = new web3.Connection(SOLANA_RPC, 'confirmed');
  const from = new web3.PublicKey((await p.connect()).publicKey.toString());
  const toPk = new web3.PublicKey(to);
  const amount = BigInt(amountIn);
  const tx = new web3.Transaction();

  if (!token.contractAddress) {
    tx.add(web3.SystemProgram.transfer({ fromPubkey: from, toPubkey: toPk, lamports: amount }));
  } else {
    const spl = await import('@solana/spl-token');
    const mint = new web3.PublicKey(token.contractAddress);
    const mintInfo = await conn.getAccountInfo(mint);
    if (!mintInfo) throw new Error('token mint not found');
    const programId = mintInfo.owner; // SPL Token or Token-2022
    const fromAta = spl.getAssociatedTokenAddressSync(mint, from, false, programId);
    const toAta = spl.getAssociatedTokenAddressSync(mint, toPk, true, programId);
    tx.add(spl.createAssociatedTokenAccountIdempotentInstruction(from, toAta, toPk, mint, programId));
    tx.add(spl.createTransferCheckedInstruction(fromAta, mint, toAta, from, amount, token.decimals, [], programId));
  }
  tx.feePayer = from;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const { signature } = await p.signAndSendTransaction(tx);
  return signature;
}
