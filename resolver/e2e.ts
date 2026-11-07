// The whole Logline cycle on a contract of your own, on NEAR testnet, in about ten minutes.
// Needs only Node and internet: no keys, no Rust, no wallet.
//
//   npm run e2e
//
//  1. Two new testnet accounts from the NEAR faucet: one for the contract (also its owner and
//     resolver) and one for the bettor.
//  2. Deploy contract/res/logline.wasm, the same build as loglines.testnet (the code hashes are
//     compared), and initialize it with native NEAR collateral.
//  3. Open two 3-minute markets starting about a minute from now: Ethereum's base fee, and USDC's
//     price on Uniswap's USDC/USDT pool. The lines are calibrated from recent blocks.
//  4. The bettor buys YES and NO on both, so one side wins either way.
//  5. Run the resolver until both settle (window end + 12 Ethereum confirmations).
//  6. Claim the winnings.
//  7. Run the verifier on both: it reads Ethereum again and must print VERIFIED.
//
// Keys are written to resolver/.state/e2e/ (ignored by git) and never printed.

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, actions, JsonRpcProvider, KeyPair, type KeyPairString } from 'near-api-js';
import { fmtMetric, type Market } from '../shared/near.ts';

const here = dirname(fileURLToPath(import.meta.url));
const RPC = 'https://test.rpc.fastnear.com'; // same endpoint as the app
const EXPLORER = 'https://testnet.nearblocks.io';
const FAUCET = 'https://helper.nearprotocol.com/account';
const LIVE_CONTRACT = 'loglines.testnet';
const WASM = join(here, '..', 'contract', 'res', 'logline.wasm');
const NODE = [process.execPath, '--disable-warning=ExperimentalWarning'];
const ONE_NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;

const t0 = Date.now();
const elapsed = () => `${Math.round((Date.now() - t0) / 1000)}s`.padStart(5);
const step = (n: number, s: string) => console.log(`\n[${elapsed()}] ${n}. ${s}`);
const ok = (s: string) => console.log(`        ok  ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const near = (y: bigint) => `${(Number(y) / 1e24).toFixed(4)} NEAR`;

async function rpc<T>(method: string, params: object): Promise<T> {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((x) => x.json());
  if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error).slice(0, 300)}`);
  return r.result as T;
}
const viewAccount = (id: string) =>
  rpc<{ amount: string; code_hash: string }>('query', { request_type: 'view_account', finality: 'final', account_id: id });
async function view<T>(contract: string, method: string, args: object): Promise<T> {
  const r = await rpc<{ result: number[] }>('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  return JSON.parse(Buffer.from(r.result).toString());
}

/** A new faucet-funded testnet account, with its key saved under resolver/.state/e2e/. */
async function faucetAccount(name: string): Promise<{ id: string; key: KeyPairString; account: Account }> {
  const kp = KeyPair.fromRandom('ed25519');
  const res = await fetch(FAUCET, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: name, newAccountPublicKey: kp.getPublicKey().toString() }),
  });
  if (!res.ok) throw new Error(`faucet refused ${name}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const key = kp.toString() as KeyPairString;
  const dir = join(here, '.state', 'e2e');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({ account_id: name, private_key: key }), { mode: 0o600 });
  for (let i = 0; i < 30; i++) {
    try {
      await viewAccount(name);
      break;
    } catch {
      await sleep(1000);
    }
  }
  return { id: name, key, account: new Account(name, new JsonRpcProvider({ url: RPC }), key) };
}

/** Send a function call and fail loudly if any receipt failed. Returns the decoded return value. */
async function send<T>(from: Account, contract: string, method: string, args: object, deposit = 0n, gas = 100n * TGAS): Promise<T> {
  const res = await from.callFunctionRaw({ contractId: contract, methodName: method, args, deposit, gas, waitUntil: 'FINAL' });
  const status = res.status as { SuccessValue?: string; Failure?: unknown };
  const failed = [status.Failure, ...res.receipts_outcome.map((r) => (r.outcome.status as { Failure?: unknown }).Failure)].find(Boolean);
  if (failed) throw new Error(`${method} failed: ${JSON.stringify(failed).slice(0, 300)}`);
  console.log(`            ${method}: ${EXPLORER}/txns/${res.transaction.hash}`);
  return (status.SuccessValue ? JSON.parse(Buffer.from(status.SuccessValue, 'base64').toString()) : undefined) as T;
}

// ---------------------------------------------------------------------------

const tag = randomBytes(4).toString('hex');
console.log('Logline end-to-end test on NEAR testnet (about ten minutes)');

step(1, 'Create two testnet accounts with the NEAR faucet');
const owner = await faucetAccount(`logline-e2e-${tag}.testnet`);
const bettor = await faucetAccount(`logline-e2e-${tag}-bettor.testnet`);
ok(`contract, owner and resolver: ${owner.id}  (${near(BigInt((await viewAccount(owner.id)).amount))})`);
ok(`bettor: ${bettor.id}  (${near(BigInt((await viewAccount(bettor.id)).amount))})`);

step(2, 'Deploy the contract and initialize it');
const code = readFileSync(WASM);
const sha = createHash('sha256').update(code).digest('hex');
console.log(`            ${WASM.replace(join(here, '..') + '/', '')}: ${code.length} bytes, sha256 ${sha}`);
const dep = await owner.account.signAndSendTransaction({
  receiverId: owner.id,
  actions: [actions.deployContract(code), actions.functionCall('new', { owner: owner.id, resolver: owner.id }, 30n * TGAS, 0n)],
  waitUntil: 'FINAL',
});
if ((dep.status as { Failure?: unknown }).Failure) throw new Error(`deploy failed: ${JSON.stringify(dep.status)}`);
console.log(`            deploy + new: ${EXPLORER}/txns/${dep.transaction.hash}`);
const [mine, live] = await Promise.all([viewAccount(owner.id), viewAccount(LIVE_CONTRACT)]);
ok(`code hash ${mine.code_hash}${mine.code_hash === live.code_hash ? `, the same code as ${LIVE_CONTRACT}` : ` (${LIVE_CONTRACT} runs ${live.code_hash})`}`);

// child processes run the repo's own scripts against this contract, signing as its resolver
const env = {
  ...process.env,
  NEAR_NETWORK: 'testnet',
  LOGLINE_CONTRACT: owner.id,
  LOGLINE_RESOLVER: owner.id,
  NEAR_ACCOUNT: owner.id,
  NEAR_PRIVATE_KEY: owner.key,
};

step(3, 'Open two 3-minute markets on Ethereum metrics');
const start = new Date(Math.ceil((Date.now() + 90_000) / 60_000) * 60_000).toISOString();
for (const preset of ['gas', 'usdc-peg']) {
  const out = execFileSync(NODE[0], [NODE[1], join(here, 'create.ts'), preset, '--start', start, '--minutes', '3', '--b', '1'], { env, encoding: 'utf8' });
  const q = out.match(/"question": "(.*)"/)?.[1];
  const id = out.match(/created market #(\d+)/)?.[1];
  if (!id) throw new Error(`create ${preset} failed:\n${out}`);
  ok(`#${id}: ${q}`);
}
const markets = await view<Market[]>(owner.id, 'get_markets', {});

step(4, 'The bettor buys YES and NO on both markets (0.5 NEAR each)');
for (const m of markets) {
  for (const outcome of ['Yes', 'No'] as const) {
    const shares = await send<string>(bettor.account, owner.id, 'buy', { market_id: m.id, outcome }, ONE_NEAR / 2n);
    ok(`#${m.id} ${outcome}: ${(Number(shares) / 1e24).toFixed(4)} shares`);
  }
}

step(5, `Run the resolver until both settle (window ends ${new Date(Date.parse(start) + 180_000).toISOString().slice(11, 19)} UTC, then 12 confirmations)`);
const daemon = spawn(NODE[0], [NODE[1], join(here, 'daemon.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const relay = (b: Buffer) =>
  b
    .toString()
    .split('\n')
    .filter((l) => /measured|resolved|error|void/.test(l))
    .forEach((l) => console.log(`            ${l.trim()}`));
daemon.stdout.on('data', relay);
daemon.stderr.on('data', relay);
let settled: Market[] = [];
try {
  for (let i = 0; ; i++) {
    settled = await view<Market[]>(owner.id, 'get_markets', {});
    if (settled.every((m) => m.resolution)) break;
    if (i > 120) throw new Error('markets did not settle within 20 minutes');
    await sleep(10_000);
  }
} finally {
  daemon.kill();
}
for (const m of settled) ok(`#${m.id} resolved ${m.resolution}: value ${fmtMetric(BigInt(m.resolved_value!), m.spec)} vs line ${fmtMetric(BigInt(m.spec.threshold), m.spec)}`);

step(6, 'Claim the winnings');
for (const m of settled) {
  const before = BigInt((await viewAccount(bettor.id)).amount);
  const paid = await send<string>(bettor.account, owner.id, 'claim', { market_id: m.id }, 0n, 100n * TGAS);
  const after = BigInt((await viewAccount(bettor.id)).amount);
  ok(`#${m.id}: claimed ${near(BigInt(paid))}; bettor balance ${near(before)} -> ${near(after)}`);
}

step(7, 'Verify both results independently from Ethereum');
let failed = 0;
for (const m of settled) {
  try {
    const out = execFileSync(NODE[0], [NODE[1], join(here, 'verify.ts'), String(m.id)], { env, encoding: 'utf8' });
    out.split('\n').filter((l) => /^(ok|FAIL)/.test(l)).forEach((l) => console.log(`            ${l}`));
    ok(`#${m.id} VERIFIED`);
  } catch (e) {
    failed++;
    console.log((e as { stdout?: string }).stdout ?? e);
    console.log(`        FAIL #${m.id} did not verify`);
  }
}

console.log(`\n[${elapsed()}] ${failed ? 'FAILED' : 'PASSED'}: deployed, traded, resolved, claimed and verified on ${owner.id}`);
console.log(`  Explorer: ${EXPLORER}/address/${owner.id}`);
console.log(`  In the app (npm run dev): http://localhost:5173/?contract=${owner.id}`);
console.log(`  Keys: resolver/.state/e2e/`);
process.exit(failed ? 1 : 0);
