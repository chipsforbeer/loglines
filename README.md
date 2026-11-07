# Logline

Bets on the line, settled by the logs.

Logline is a prediction market on NEAR whose markets settle on a number read from a blockchain. Examples:

- **Stablecoins.** *Will USDC's supply on Ethereum grow between 06:50 and 09:50 UTC on Nov 7?* *Will USDC average
  above 1.001081 USDT on Uniswap's USDC/USDT 0.01% pool between 06:50 and 07:00 UTC?*
- **Lending.** *Will the borrow rate on Morpho Blue's cbBTC/USDC market average above 5.71% APR between 06:50 and 07:50
  UTC?* *Will that market average above 91.88% utilization between 06:50 and 08:50 UTC?*
- **Network.** *Will Ethereum's base fee average above 0.0367 gwei between 06:50 and 07:05 UTC?* *Will Ethereum blocks
  average more than 4.74 blobs between 06:50 and 07:20 UTC?*

Every one of these can move up or down until its window closes: they are flows, prices, rates and averages, not
counters that only go up. Each line is set from recent history, so markets open close to 50/50.

**Problem.** Most prediction markets settle when someone decides what happened. A market on an on-chain metric does not
need that: the answer is in the chain's logs and state. Logline posts the measured value together with the blocks and
hashes it came from. The contract applies the market's rule to that value, and anyone with an Ethereum RPC can recompute
the result. Because the outcome is mechanical, markets can be generated from a template, and the threshold is calibrated
from recent history so each one opens close to 50/50.

**Use cases.** Hedge a Morpho borrow position against the borrow rate rising. Hedge a bot's or a rollup's costs against
gas and blob fees spiking. Take a view on a stablecoin's supply or peg, or any protocol metric, without holding a token.

## What runs where

| Part | Network | Status |
| --- | --- | --- |
| Contract [`loglines.testnet`](https://testnet.nearblocks.io/address/loglines.testnet) | NEAR testnet | Live. Native NEAR collateral. |
| Resolver [`loglines-resolver.testnet`](https://testnet.nearblocks.io/address/loglines-resolver.testnet) | NEAR testnet | Runs `resolver/daemon.ts`. |
| Market data | Ethereum mainnet | Read live: USDC `Transfer` mints and burns, Uniswap v3 `Swap` prices, Morpho Blue `AccrueInterest` rates and `market(id)` state, block headers (base fee, blobs). |
| NEAR Intents (1Click): pay with any token, receive winnings on any chain | NEAR mainnet only | Built and wired into the UI. Intents has no testnet, so on testnet the app requests **real 1Click quotes** and places a **real testnet bet or claim**, and the cross-chain deposit and swap between them is **simulated and labeled "sim"** in the UI. |
| Contract on mainnet `loglines.near`, USDC collateral | NEAR mainnet | Same code, built and tested. **Not deployed.** Runbook: [`docs/MAINNET.md`](docs/MAINNET.md). |

**Markets for judging.** Markets #6–#10 on `loglines.testnet` (USDC supply, USDC peg, Morpho borrow rate, base fee,
blobs) measure **Nov 15 00:00 to Nov 20 00:00 UTC** and take trades until Nov 19 12:00 UTC. They are computed only from
Ethereum logs and headers, so nothing has to run while they are open: the resolver settles them once after Nov 20.
Markets #0–#5 are short ones that have already settled and can be checked with `npm run verify`.

`npm run markets:demo` opens one market per template with staggered windows: the first settles about 15 minutes later,
the last runs about three hours. An earlier deployment, `logline.testnet`, holds the first markets built (swap counts and
Morpho borrow), kept as history.

## Try it

Requirements: Node 23+. Rust and `cargo-near` ≥ 0.23 are needed only for the contract.

```bash
npm install
npm run e2e        # the whole cycle on a contract of your own, about 10 minutes (below)
npm run dev        # http://localhost:5173, uses the deployed testnet contract
```

**`npm run e2e`** needs no keys, wallet or Rust. It creates two testnet accounts with the NEAR faucet, deploys
`contract/res/logline.wasm` (it checks the code hash matches `loglines.testnet`), opens two 3-minute markets on
Ethereum's base fee and USDC's Uniswap price, buys YES and NO on both, runs the resolver until both settle, claims, and
runs the verifier on both. Every step prints its testnet transaction link, and it ends with `PASSED` (exit 0) and a link
to open that contract in the app (`?contract=<account>`). Keys stay in `resolver/.state/e2e/`, which git ignores.

Then the app:

1. **Open http://localhost:5173.** You see markets under three tabs, Stablecoins, Lending and Network, each with
   protocol, chain, the rule (for example `Base fee per gas > 0.0367 gwei`), the YES price and a countdown. Resolved
   markets show their outcome. Markets #6–#10 stay open for trading until Nov 19 12:00 UTC (see above). For a
   deployment with markets settling within minutes, run `npm run e2e` and open the link it prints.
2. **Click _Try a demo wallet_ in the header.** The browser creates a key, and the NEAR testnet faucet creates and funds
   an account for it. The header shows the account and its NEAR balance. No extension needed. **Connect wallet** works
   with any testnet wallet through NEAR Connect.
3. **Open the USDC supply market.** The chart shows USDC minted minus burned on Ethereum so far in the window,
   updated every 15 seconds, against the line at $0. It goes up and down as Circle mints and burns. The base fee, blob,
   peg and borrow-rate markets chart their running average the same way.
4. **Buy YES for 0.5 NEAR.** The quote shows shares, average price and the price after the trade. Click **Buy YES**. A
   toast links the NEAR transaction. In the explorer, the receipt logs a `trade` event (NEP-297). The YES price
   and the price chart move.
5. **Pay with another token.** Under **Pay with**, pick **SOL on Solana**, or **USDC on Base**. The **You pay** box
   now shows that token, and the quote has two rows: the swap (a real 1Click quote into wNEAR) and the bet it buys.
   Click **Buy YES with SOL**. The status box walks through deposit → processing → success, marked **simulated**, and
   then places the bet as a real testnet transaction, which it links.
6. **Sell the position.** The position panel lists your shares and their marked value. **Sell all YES** returns NEAR
   at the LMSR price, with a 2% slippage guard.
7. **Open a resolved market,** such as the 10-minute peg market once it settles. The page shows the measured value
   against the line, the evidence (block range, swap count, opening price, data hash) and the outcome. If you hold a
   winning position, **Claim** pays it.
   **Receive as** can send the winnings through 1Click to another chain (simulated on testnet).
8. **Recompute the result yourself:**

   ```bash
   npm run verify -- <market id>
   ```

   The script reads Ethereum again and prints one `ok` or `FAIL` line per check. It ends with `VERIFIED` (exit 0),
   `MISMATCH` (exit 1), or `UNVERIFIED` (exit 2: some evidence could not be read, for example historical Morpho state
   without an archive RPC; pass `--rpc <url>`).
9. **Switch to mainnet view** with the **testnet / mainnet** switch in the header (or `?net=mainnet`). The app shows
   that `loglines.near` is not deployed. On mainnet, bets are USDC and 1Click deposits are real.

## How it works

```text
          Ethereum mainnet: logs (USDC, Uniswap, Morpho), block headers, Morpho state
                 │ eth_getLogs / eth_call                  │ (the browser reads the same data for charts)
                 ▼                                         ▼
  resolver/ (Node)                                     web/ (React)
  create.ts  calibrates a threshold, opens a market    markets, live metric vs line, trade, sell, claim
  daemon.ts  samples during the window, then posts     NEAR Connect wallets or a faucet demo wallet
             value + evidence; voids what it can't     1Click: pay with any token, payout to any chain
             measure
  verify.ts  recomputes a resolved market
                 │                                         │
                 ▼                                         ▼
          contract/ (Rust, near-sdk 5.30): LMSR market maker, positions, resolution rule, payouts
```

### Contract (`contract/src/lib.rs`)

- **Markets.** Binary YES/NO markets. A winning share pays one unit of collateral. Collateral is native NEAR (`token:
  None`, 24 decimals) or one NEP-141 token (`token: Some(usdc)`, 6 decimals), chosen at `new`.
- **Pricing.** An LMSR (logarithmic market scoring rule) market maker, with cost `C = b·ln(e^{q_yes/b} + e^{q_no/b})`.
  The creator deposits the worst-case loss `b·ln2`, so the market has liquidity from the first trade. Every trade is
  rounded against the trader, and after every trade the contract asserts `pool ≥ max(q_yes, q_no)`, so it can always
  pay the winning side.
- **Trading.**
  - `buy` (with a `min_shares` slippage guard) and `sell` (with `min_payout`).
  - Quotes come from the `quote_buy` and `quote_sell` views.
  - In token mode, bets and new markets arrive through `ft_transfer_call` with message
    `{"buy":{market_id,outcome,min_shares,account}}` or `{"create_market":{spec,b}}`.
  - The `account` field is how a 1Click swap credits the bettor: the tokens come from the Intents contract, not the
    bettor. A bet that can't be placed when the swap lands (market closed, price moved past `min_shares`) is refunded
    to the bettor's NEAR account and logged as `bet_refunded`. It is not bounced back to Intents.
- **Resolution.**
  - The resolver reports a number, not an outcome: `resolve(market_id, value, evidence)`, and the contract applies the
    market's rule (`value > threshold`, etc.).
  - `void_market` pays half a unit per share. The resolver can void at any time. Anyone can void a market that is
    still unresolved 3 days after its window ended, so a missing resolver can't lock stakes in.
  - The unused subsidy goes back to the market's creator.
- **Payouts.**
  - `claim(market_id, to?)` can send winnings to another account, such as a 1Click deposit address that swaps them to
    SOL on Solana.
  - In token mode a payout first registers the receiver on the token.
  - If the transfer fails, the amount is recorded under `get_owed`, keyed to the claimer (never to a deposit
    address). The claimer can withdraw it with `withdraw_owed` or the **Withdraw** button in the app.
- **Events.** Every state change emits an NEP-297 `EVENT_JSON` log (standard `logline`): `market_created`, `trade`,
  `market_resolved`, `claim`, `bet_refunded`.

### Data sources (`shared/metrics.ts`, `shared/windowed.ts`)

Each window is mapped to an inclusive block range by binary search on block timestamps. Most sources are then computed
only from logs and block headers in that range, which any public RPC serves for any past block, so anyone can recompute
them later. One function (`measureWindowed`) produces the value for the resolver, the verifier and the live charts.

| Template | Source kind | Value |
| --- | --- | --- |
| `usdc-supply` | `erc20_net_mint` | USDC minted (`Transfer` from 0x0) minus burned (`Transfer` to 0x0). Stored as `offset + net`, because the contract compares unsigned numbers; the line `offset` means "supply grew". |
| `usdc-peg` | `univ3_price` | Each block's closing price in the USDC/USDT 0.01% pool, from `Swap.sqrtPriceX96`, averaged over every block. The opening price comes from the last swap before the window. |
| `morpho-rate` | `morpho_rate` | The borrow APR in effect at each block, from `AccrueInterest.prevBorrowRate`, averaged over every block. The window's last blocks are priced by the first accrual after it, so resolution waits for that log. |
| `gas` | `block_stat` | `baseFeePerGas` averaged over every block, or for multi-day windows over every block whose number is a multiple of `every` (100 for the judging markets: 360 headers over five days). |
| `blobs` | `block_stat` | `blobGasUsed / 131072` (blobs per block) averaged the same way. |
| `morpho-util` | `morpho_market` | Utilization sampled every 10 minutes and averaged (see below). |

Evidence records the block range, both block hashes, the value, and source-specific fields (counts, sums, the opening
swap, a `keccak256` over every log used).

Two more source kinds are supported:

- `evm_log_count`: the number of logs from a contract with a given `topic0`, in the blocks whose timestamps fall in the
  window.
  - The window is mapped to blocks by binary search on timestamps.
  - Evidence records the block range, both block hashes, the count, and `keccak256` over every counted
    `(txHash, logIndex)`.
  - A query the RPC refuses as too large is split in half until it fits, so the count can't be blocked by stuffing one
    range with logs.
- `morpho_market`: `totalBorrowAssets` or utilization (borrow ÷ supply).
  - It is sampled at the first block at or after each scheduled time (every 5 or 10 minutes) and averaged. A
    time-weighted average is expensive to move for a single block, for example with a flash loan.
  - Evidence lists every `(time, block, value)`.
  - If fewer than half of the scheduled samples were taken, the resolver voids the market.

### Resolver (`resolver/daemon.ts`) and verifier (`resolver/verify.ts`)

- **Daemon.** It reads every market page by page, takes utilization samples while their windows are open, and resolves
  after 12 confirmations.
- **Failures.** A failure that can never clear (an unreadable source) voids the market. Any other failure, such as an
  RPC outage or a rate limit, is retried for up to 3 days, after which anyone may void the market through the contract
  anyway.
- **Verifier, log and header markets.** It checks the block boundaries and the block hashes (to catch reorgs), then
  recomputes the value with the same code and compares it and every evidence field, then the rule.
- **Verifier, Morpho markets.** It rebuilds the sample schedule and requires the evidence to match it: no duplicate or
  off-schedule samples, at least half taken, the right block for each sample, each value, and the average.

## Develop

Create markets. The threshold is calibrated from recent history unless `--threshold` is given:

```bash
npm run markets:demo                                         # all six, staggered windows (15 min to 3 h)
npm run markets:long                                         # five log-based ones, Nov 15–20 (--start / --until)
npm run markets:create -- usdc-supply --minutes 180 --start-in 5
npm run markets:create -- usdc-peg --minutes 60
npm run markets:create -- morpho-rate --minutes 120
npm run markets:create -- morpho-util --minutes 120
npm run markets:create -- gas --minutes 60 --start 2026-11-08T14:00:00Z
npm run markets:create -- blobs --minutes 60 --threshold 5
# --dry-run prints the spec without sending it. --b sets LMSR liquidity (subsidy = b·ln2).
# --threshold sets the line in display units (USDC, USDT, %, gwei, blobs).
# --calibrate-minutes sets the length of the trailing windows used for the line (multi-day markets use 240).
# --every N (gas, blobs) averages only blocks whose number is a multiple of N.
```

Run the resolver. It needs the resolver account's key in `~/.near-credentials/testnet/`, or in `NEAR_PRIVATE_KEY`:

```bash
npm run resolver            # loop; add -- --once for one pass
```

Contract:

```bash
npm run contract:test       # 26 unit tests: pricing, slippage, solvency, resolution, void and grace period,
                            # token mode, Intents bets and refunds, failed-payout accounting, id bounds
npm run contract:wasm       # build and copy to contract/res/logline.wasm (committed; used by npm run e2e)
cd contract && cargo near deploy build-non-reproducible-wasm --env "RUSTFLAGS=-C link-arg=-s --remap-path-prefix=$HOME=~" <account> with-init-call new \
  json-args '{"owner":"<owner>","resolver":"<resolver>"}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-legacy-keychain send
```

- **Network.** Selected by `?net=testnet|mainnet` in the app (remembered in `localStorage`) or `NEAR_NETWORK` for the
  scripts.
- **Your own deployment.** Open the app with `?contract=<account>`; point the scripts at it with `LOGLINE_CONTRACT`
  and `LOGLINE_RESOLVER`; or edit `NETWORKS` in `shared/near.ts`.
- **Layout.**
  - `contract/`: the Rust contract.
  - `shared/`: NEAR views and network config (`near.ts`), and the Ethereum readers (`metrics.ts`).
  - `resolver/`: create, demo (preset sets), daemon, verify, e2e, signer.
  - `contract/res/logline.wasm`: the deployed build (sha256 `9842bef6…4e21`, code hash
    `BFN12kP1wcY2jZ8pp2omBHAkzdqodumQC4yJ7Q2AntcG` on `loglines.testnet`). The build scripts pass
    `--remap-path-prefix=$HOME=~`, so the wasm does not embed the builder's home directory.
  - `web/src/`: the React app. `intents.ts` and `Pay.tsx` hold the 1Click flows, `phantom.ts` the Solana wallet
    deposit.

## Security review

An independent review of the contract and resolver found these issues, all fixed and re-checked by the reviewer:

- A failed payout to a deposit address was recorded under that address, so nobody could withdraw it. It is now keyed
  to the claimer.
- Markets past id 99 were never resolved.
- The verifier accepted fabricated Morpho evidence.
- A market whose data could not be read was retried forever.
- Market ids of 2^32 and above aliased existing markets.

Issues that matter only with real funds are listed under "Open before mainnet" in [`docs/MAINNET.md`](docs/MAINNET.md):

- storage paid by the contract
- an optional bet `account`
- the cost of moving template metrics
- payout gas margins

## Limits

- **Trust.** The resolver is a single account. Its reports can be checked afterwards (`verify`) but are not enforced
  on-chain. Next steps: a dispute window with a bond; a resolver in a TEE (trusted execution environment) that signs
  results, such as NEAR Shade Agents; or several resolvers with a quorum.
- **Manipulation and inside information.** Averages over every block are expensive to move, but not impossible: a
  base-fee average can be pushed by paying for full blocks, and a pool price by trading against the pool. Circle knows
  its own mint and burn plans, so a USDC supply market favors it. There is no cap on open interest yet.
- **The utilization market** is the only one that needs the resolver online during its window, because public RPCs
  serve only recent state. Rebuilding utilization from Morpho's `Supply`, `Withdraw`, `Borrow`, `Repay` and `Liquidate`
  logs would remove that.
- **Intents** have run only as real quotes with a simulated swap. No real 1Click deposit has been delivered to the
  contract.

## Hackathon disclosures

- **Built in the window.** Everything in this directory was written during the hackathon, starting 2026-11-06. There is
  no pre-hackathon baseline.
- **AI code.** Written with Claude Code (Anthropic). The contract and resolver were also reviewed by a separate Claude
  Code session acting as an auditor.
- **Libraries.**
  - Contract: `near-sdk` 5.30.
  - App and scripts: `react` 19, `vite` 8, `viem` 2 (Ethereum RPC), `near-api-js` 7, `@hot-labs/near-connect`
    (wallets), `@solana/web3.js` 1.99 and `@solana/spl-token` 0.4 (Phantom deposits), `qrcode`, `buffer`.
  - Services: the NEAR Intents 1Click API (`1click.chaindefuser.com`), the NEAR testnet faucet, and public Ethereum
    and NEAR RPCs.
- **Other project by the same person (Q-015).** Logline is a solo project by
  [chipsforbeer](https://github.com/chipsforbeer), who is also on a second, independent NEAR HACKATHON team:
  [**Supply**](https://github.com/chipsforbeer/near-supply-mcp), purchasing records an AI assistant works through,
  with supplier payments in USDC on NEAR. The two projects share no code.
- **License.** MIT, see [`LICENSE`](LICENSE).
