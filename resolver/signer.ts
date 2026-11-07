// Signing with a key from ~/.near-credentials/<network>/ (testnet keys are written by `cargo near create-dev-account`), or NEAR_PRIVATE_KEY.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Account, JsonRpcProvider, type KeyPairString } from 'near-api-js';
import { CONTRACT_ID, EXPLORER, NEAR_RPC, NETWORK, RESOLVER_ID } from '../shared/near.ts';

export function loadAccount(accountId = process.env.NEAR_ACCOUNT ?? RESOLVER_ID): Account {
  const key =
    (process.env.NEAR_PRIVATE_KEY as KeyPairString | undefined) ??
    (JSON.parse(readFileSync(join(homedir(), '.near-credentials', NETWORK, `${accountId}.json`), 'utf8'))
      .private_key as KeyPairString);
  return new Account(accountId, new JsonRpcProvider({ url: NEAR_RPC }), key);
}

export async function call<T>(
  account: Account,
  methodName: string,
  args: object,
  deposit: bigint = 0n,
  gas: bigint = 100_000_000_000_000n,
  contractId: string = CONTRACT_ID,
): Promise<T> {
  const res = await account.callFunctionRaw({ contractId, methodName, args, deposit, gas, waitUntil: 'FINAL' });
  const status = res.status as { SuccessValue?: string; Failure?: unknown };
  if (status.Failure) throw new Error(`${methodName} failed: ${JSON.stringify(status.Failure)}`);
  // A panic in the function call receipt appears in receipts_outcome even when the tx succeeded.
  for (const r of res.receipts_outcome) {
    const s = r.outcome.status as { Failure?: unknown };
    if (s.Failure) throw new Error(`${methodName} failed: ${JSON.stringify(s.Failure)}`);
  }
  console.log(`  ${methodName}: ${EXPLORER}/txns/${res.transaction.hash}`);
  const v = status.SuccessValue;
  return (v ? JSON.parse(Buffer.from(v, 'base64').toString()) : undefined) as T;
}
