# Mainnet runbook

The same contract runs on both networks. On testnet, bets are native NEAR and NEAR Intents is simulated (Intents has no testnet). On mainnet, bets are USDC and cross-chain payments and payouts go through NEAR Intents (1Click) for real.

**Status:** the mainnet deployment is not live. The account `loglines.near` is reserved but unfunded and has no contract. The hackathon demo runs on testnet: real 1Click quotes and real testnet bets and claims, with the cross-chain swap step simulated and labeled in the UI. This runbook is how the mainnet build would go live.

Every step below signs mainnet transactions and spends real funds.

## What it costs

| Item | Amount |
| --- | --- |
| `loglines.near`, contract storage (~261 KB wasm + state) | ~3 NEAR |
| `resolver.loglines.near`, gas for resolve calls | ~0.5 NEAR |
| USDC storage registration for the contract | 0.00125 NEAR |
| Spare NEAR on the contract for payout storage deposits (0.00125 NEAR per new receiver) | ~0.1 NEAR |
| Subsidy per market, `b = 2` USDC (worst-case LMSR loss b·ln2, mostly returned at resolution) | ~1.39 USDC |
| One test bet paid in SOL through NEAR Intents | about $1 of SOL |

## Steps

1. Fund `loglines.near` and create the sub-account `resolver.loglines.near` from it (only `loglines.near` can create it). Fund both and import their keys into the legacy keychain (`~/.near-credentials/mainnet/`).

2. Deploy and initialize with USDC collateral:

   ```sh
   npm run contract:deploy:mainnet
   ```

   This runs `new(owner: loglines.near, resolver: resolver.loglines.near, token: <USDC>, decimals: 6)`.

3. Register the contract on the USDC token, so it can receive bets and 1Click deliveries:

   ```sh
   near contract call-function as-transaction 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 storage_deposit \
     json-args '{"account_id":"loglines.near","registration_only":true}' prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' \
     sign-as resolver.loglines.near network-config mainnet sign-with-legacy-keychain send
   ```

4. Send about 0.1 NEAR to `loglines.near` to cover payout storage deposits.

5. Fund `resolver.loglines.near` with USDC for market subsidies, then open markets. They are sent as `ft_transfer_call` with a `create_market` message:

   ```sh
   NEAR_NETWORK=mainnet npm run markets:demo                      # all six templates, staggered windows
   NEAR_NETWORK=mainnet npm run markets:create -- usdc-supply --minutes 180
   ```

6. Run the resolver against mainnet:

   ```sh
   NEAR_NETWORK=mainnet npm run resolver
   ```

7. Open the app with `?net=mainnet` (or use the header switch). Connect a NEAR wallet, open a market, pick **SOL on Solana** under **Pay with**, enter the amount in SOL, and pay from Phantom or by QR. The status box follows the swap through 1Click until the bet lands; the NEAR transaction shows `ft_transfer_call` → `ft_on_transfer` → `trade` event. After resolution, **Receive as** SOL claims the winnings straight into a 1Click deposit address.

## How the Intents flow works

```
Pay:     SOL (Solana) ──1Click──▶ USDC on NEAR ──ft_transfer_call(msg = {"buy": {market_id, outcome, min_shares, account}})──▶ loglines.near
Payout:  loglines.near.claim(market_id, to = <1Click deposit address>) ──USDC──▶ 1Click ──▶ SOL (Solana)
```

- The bet message names the bettor's NEAR `account`, because the tokens arrive from the Intents contract, not from the bettor.
- If a bet can't be placed when the swap lands (the market closed, or the price moved past `min_shares`), the contract does not bounce the tokens back to Intents. It pays the USDC to the bettor's NEAR account and logs `bet_refunded`.
- Payouts register the receiver on the token first. A failed transfer is recorded under `get_owed`, keyed to the claimer (never to a 1Click deposit address), and the app shows a **Withdraw** button for it.
- If the resolver stalls, anyone can void a market once it is still unresolved 3 days after its window ended (`VOID_GRACE_SECS`). Every share then pays half a unit.

## Open before mainnet

These came out of the audit and matter only with real funds. None is fixed yet.

- **Storage is paid by the contract (H3).** Each new position, history entry and payout receiver's USDC registration (0.00125 NEAR) comes out of the contract's NEAR balance, so it can be drained cheaply. Once drained, claims and resolves fail until someone tops it up, and 1Click bets bounce back to `intents.near` instead of the bettor. Fix: a per-user storage deposit, or charge storage against the bet.
- **Bet `account` is optional (H9).** `ft_on_transfer` falls back to the sender when the message has no `account`; for a 1Click delivery that is `intents.near`. Make it required.
- **Templates are cheap to move (H7).** About $5 of swaps adds 50 to a Uniswap swap count, a 90% Morpho utilization line sits on the IRM's own target, and a Morpho borrow line can be nudged with a few dollars of interest. There is no open-interest cap. Before real money: cap open interest per market and pick lines away from levels a single actor can reach.
- **Payout gas is measured, not guaranteed (H5).** 10 Tgas for `ft_transfer` and 5 Tgas for the callback were measured against the current USDC code. Re-measure if its code hash changes.
- **Trust.** The resolver is trusted for values (the verifier lets anyone check them), and the owner is the contract account, which can redeploy.
