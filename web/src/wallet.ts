// Two ways to sign: a real NEAR wallet through NEAR Connect, or a one-click demo wallet (a key made
// in this browser, with a testnet account created and funded by the NEAR testnet faucet).

import { NearConnector } from '@hot-labs/near-connect';
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from 'near-api-js';
import { CONTRACT_ID, NEAR_RPC, NETWORK } from '../../shared/near.ts';

/** A function call on the Logline contract, or on `receiverId` (e.g. the USDC token for ft_transfer_call). */
export type Call = { methodName: string; args: object; deposit?: bigint; gas?: bigint; receiverId?: string };
export type CallResult = { hash: string; value: unknown };

export type Session = {
  accountId: string;
  kind: 'wallet' | 'demo';
  send(call: Call): Promise<CallResult>;
  signOut(): Promise<void>;
};

const GAS = 100_000_000_000_000n;
const DEMO_KEY = 'pmdata.demo-wallet';

function decodeOutcome(outcome: any): CallResult {
  const failure =
    outcome?.status?.Failure ?? outcome?.receipts_outcome?.find((r: any) => r.outcome?.status?.Failure)?.outcome.status.Failure;
  if (failure) {
    const msg = JSON.stringify(failure);
    const panic = /"(?:panic_msg|ExecutionError)":"([^"]+)"/.exec(msg)?.[1];
    throw new Error(panic ?? msg);
  }
  const v = outcome?.status?.SuccessValue;
  let value: unknown;
  try {
    value = v ? JSON.parse(atob(v)) : undefined;
  } catch {
    value = undefined;
  }
  return { hash: outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id ?? '', value };
}

// ---------- NEAR Connect ----------

let connector: NearConnector | null = null;
export function getConnector(): NearConnector {
  connector ??= new NearConnector({
    network: NETWORK,
    features: { testnet: NETWORK === 'testnet', signAndSendTransaction: true },
    footerBranding: null,
  });
  return connector;
}

export async function walletSession(accountId: string): Promise<Session> {
  const c = getConnector();
  return {
    accountId,
    kind: 'wallet',
    async send({ methodName, args, deposit = 0n, gas = GAS, receiverId = CONTRACT_ID }) {
      const wallet = await c.wallet();
      const out = await wallet.signAndSendTransaction({
        receiverId,
        actions: [
          { type: 'FunctionCall', params: { methodName, args, gas: gas.toString(), deposit: deposit.toString() } },
        ],
      });
      return decodeOutcome(out);
    },
    async signOut() {
      await c.disconnect();
    },
  };
}

// ---------- demo wallet ----------

type DemoKey = { accountId: string; key: KeyPairString };

function readDemo(): DemoKey | null {
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    return raw ? (JSON.parse(raw) as DemoKey) : null;
  } catch {
    return null;
  }
}

function demoSessionFrom(d: DemoKey): Session {
  const account = new Account(d.accountId, new JsonRpcProvider({ url: NEAR_RPC }), d.key);
  return {
    accountId: d.accountId,
    kind: 'demo',
    async send({ methodName, args, deposit = 0n, gas = GAS, receiverId = CONTRACT_ID }) {
      const out = await account.callFunctionRaw({
        contractId: receiverId,
        methodName,
        args,
        deposit,
        gas,
        waitUntil: 'EXECUTED_OPTIMISTIC',
      });
      return decodeOutcome(out);
    },
    async signOut() {
      // The key stays in this browser so the same demo account comes back next time.
    },
  };
}

export function restoreDemo(): Session | null {
  if (NETWORK !== 'testnet') return null; // demo wallets are faucet-funded testnet accounts
  const d = readDemo();
  return d ? demoSessionFrom(d) : null;
}

/** Create (or reuse) a faucet-funded testnet account whose key lives in this browser. */
export async function createDemo(): Promise<Session> {
  const existing = readDemo();
  if (existing) return demoSessionFrom(existing);
  const kp = KeyPair.fromRandom('ed25519');
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(16).padStart(2, '0')).join('');
  const accountId = `pmd-${rand}.testnet`;
  const res = await fetch('https://helper.nearprotocol.com/account', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: kp.getPublicKey().toString() }),
  });
  if (!res.ok) throw new Error(`faucet: ${res.status} ${await res.text()}`);
  const d: DemoKey = { accountId, key: kp.toString() as KeyPairString };
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(d));
  } catch {
    // storage blocked: the session still works until the page is closed
  }
  // the account appears a moment after the faucet answers
  for (let i = 0; i < 20; i++) {
    const r = await fetch(NEAR_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'query',
        params: { request_type: 'view_account', finality: 'optimistic', account_id: accountId },
      }),
    }).then((x) => x.json());
    if (r.result) break;
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  return demoSessionFrom(d);
}

export function forgetDemo() {
  try {
    localStorage.removeItem(DEMO_KEY);
  } catch {
    // ignore
  }
}
