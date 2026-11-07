//! Logline: bets on the line, settled by the logs.
//!
//! Binary prediction markets whose outcome is an on-chain metric. Each market asks whether a
//! measured number (a count of EVM logs, a contract value, ...) will be above or below a
//! threshold over a time window. Shares are priced by an LMSR (logarithmic market scoring rule)
//! market maker funded by the market creator, so every market has liquidity from the first
//! trade. A winning share pays 1 unit of collateral.
//!
//! Collateral is set at init:
//! - `token: None`: native NEAR (the testnet deployment). Bets are `buy` with attached NEAR.
//! - `token: Some(usdc)`: a NEP-141 token (the mainnet deployment, USDC). Bets arrive through
//!   `ft_transfer_call` with a `{"buy": {...}}` message, either from the bettor's wallet or from
//!   NEAR Intents (1Click `customRecipientMsg`) after a cross-chain swap, e.g. SOL on Solana ->
//!   USDC on NEAR -> bet. Payouts can go to any account, including a 1Click deposit address, so
//!   winnings can leave as SOL on Solana or any other asset Intents supports.
//!
//! Resolution: the resolver account reports the measured value plus evidence (block range,
//! RPC, a hash of the data) and the contract applies the market's own rule
//! (`value <cmp> threshold`) to decide YES or NO. The resolver never picks the outcome.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue,
};

pub const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
/// Rounding margin applied against the trader on every trade, so float error can never
/// make the market maker insolvent.
const ROUNDING_EDGE: f64 = 1e-9;
const MAX_HISTORY: usize = 500;
/// After a market's window ends, the resolver has this long before anyone may void the market.
pub const VOID_GRACE_SECS: u64 = 3 * 24 * 3600;
/// NEP-145 storage deposit for registering a payout receiver on the token contract.
/// Refunded by the token contract when the receiver is already registered.
const FT_STORAGE_DEPOSIT: u128 = 1_250_000_000_000_000_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Outcome {
    Yes,
    No,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Resolution {
    Yes,
    No,
    Invalid,
}

/// The market resolves YES iff `value <comparator> threshold`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Comparator {
    Gt,
    Gte,
    Lt,
    Lte,
}

impl Comparator {
    fn holds(self, value: u128, threshold: u128) -> bool {
        match self {
            Comparator::Gt => value > threshold,
            Comparator::Gte => value >= threshold,
            Comparator::Lt => value < threshold,
            Comparator::Lte => value <= threshold,
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct MarketSpec {
    pub question: String,
    /// e.g. "Lending", "DEX"
    pub category: String,
    /// e.g. "Morpho Blue", "Uniswap v3"
    pub protocol: String,
    /// e.g. "ethereum"
    pub chain: String,
    /// Human description of the measured number.
    pub metric: String,
    /// Display unit of the metric, e.g. "swaps", "USDC".
    pub unit: String,
    /// Decimals of `threshold` and of the resolved value.
    pub decimals: u8,
    pub comparator: Comparator,
    pub threshold: U128,
    /// Machine-readable data source (JSON) that the resolver executes.
    pub source: String,
    /// Measurement window, unix seconds.
    pub window_start: U64,
    pub window_end: U64,
    /// Trading closes at this time (unix seconds), at the latest at `window_end`.
    pub close_time: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Market {
    pub id: u64,
    pub creator: AccountId,
    pub spec: MarketSpec,
    /// LMSR liquidity parameter, in collateral base units. Max market-maker loss is b*ln(2).
    pub b: U128,
    /// Outstanding shares, in collateral base units (one whole share pays one whole unit).
    pub q_yes: U128,
    pub q_no: U128,
    /// Collateral held for this market (subsidy + net trades).
    pub pool: U128,
    pub subsidy: U128,
    pub volume: U128,
    pub trades: u32,
    pub created_at: U64,
    pub resolution: Option<Resolution>,
    pub resolved_value: Option<U128>,
    pub evidence: Option<String>,
    pub resolved_at: Option<U64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Default, Debug)]
pub struct Position {
    pub yes: U128,
    pub no: U128,
    pub spent: U128,
    pub received: U128,
    pub claimed: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PricePoint {
    /// unix seconds
    pub t: U64,
    /// YES price in parts per million
    pub p: u32,
}

#[near(serializers = [json])]
pub struct MarketView {
    #[serde(flatten)]
    pub market: Market,
    pub status: String,
    pub price_yes: f64,
    pub price_no: f64,
}

#[near(serializers = [json])]
pub struct BuyQuote {
    pub shares: U128,
    pub avg_price: f64,
    pub price_before: f64,
    pub price_after: f64,
    pub max_payout: U128,
}

#[near(serializers = [json])]
pub struct SellQuote {
    pub payout: U128,
    pub price_before: f64,
    pub price_after: f64,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner: AccountId,
    pub resolver: AccountId,
    /// None: native NEAR. Some: NEP-141 token account.
    pub token: Option<AccountId>,
    pub decimals: u8,
    pub market_count: u64,
}

/// Messages accepted by `ft_on_transfer`.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
pub enum TransferMsg {
    /// Place a bet with the transferred tokens. `account` owns the position; it defaults to the
    /// sender and must be set when the tokens arrive through NEAR Intents (the sender is then
    /// the Intents contract, not the bettor).
    Buy {
        market_id: u64,
        outcome: Outcome,
        min_shares: Option<U128>,
        account: Option<AccountId>,
    },
    /// Open a market; the transferred tokens are the market maker's subsidy.
    CreateMarket { spec: MarketSpec, b: U128 },
}

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Markets,
    Positions,
    History,
    Owed,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    resolver: AccountId,
    token: Option<AccountId>,
    decimals: u8,
    markets: Vector<Market>,
    positions: LookupMap<(u64, AccountId), Position>,
    history: LookupMap<u64, Vec<PricePoint>>,
    /// Payouts whose transfer failed (e.g. unregistered receiver); withdrawable later.
    owed: LookupMap<AccountId, u128>,
}

// ---------- LMSR math (in whole collateral units, f64) ----------

/// ln(e^a + e^c), stable.
fn lse(a: f64, c: f64) -> f64 {
    let m = a.max(c);
    m + (-(a - c).abs()).exp().ln_1p()
}

fn price_yes(q_yes: f64, q_no: f64, b: f64) -> f64 {
    1.0 / (1.0 + ((q_no - q_yes) / b).exp())
}

/// Shares of the `own` side bought by spending `m`.
fn shares_for_spend(own: f64, other: f64, b: f64, m: f64) -> f64 {
    // Solve b*ln(e^((own+d)/b) + e^(other/b)) = C + m for d.
    let big_m = lse(own / b, other / b) + m / b;
    let d = b * (big_m + (-(other / b - big_m).exp()).ln_1p()) - own;
    d * (1.0 - ROUNDING_EDGE)
}

/// Collateral returned for selling `d` shares of the `own` side.
fn payout_for_sell(own: f64, other: f64, b: f64, d: f64) -> f64 {
    let p = b * (lse(own / b, other / b) - lse((own - d) / b, other / b));
    p * (1.0 - ROUNDING_EDGE)
}

fn now_secs() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

fn emit(event: &str, data: String) {
    log!(
        "EVENT_JSON:{{\"standard\":\"logline\",\"version\":\"1.0.0\",\"event\":\"{}\",\"data\":[{}]}}",
        event,
        data
    );
}

#[near]
impl Contract {
    /// `token: None` for native NEAR collateral, or a NEP-141 token with its `decimals`.
    #[init]
    pub fn new(owner: AccountId, resolver: AccountId, token: Option<AccountId>, decimals: Option<u8>) -> Self {
        let decimals = if token.is_some() {
            decimals.unwrap_or_else(|| env::panic_str("decimals required with a token"))
        } else {
            24
        };
        Self {
            owner,
            resolver,
            token,
            decimals,
            markets: Vector::new(StorageKey::Markets),
            positions: LookupMap::new(StorageKey::Positions),
            history: LookupMap::new(StorageKey::History),
            owed: LookupMap::new(StorageKey::Owed),
        }
    }

    // ---------- admin ----------

    pub fn set_resolver(&mut self, resolver: AccountId) {
        self.assert_owner();
        self.resolver = resolver;
    }

    /// Create a market with native NEAR (native-collateral deployments only). The attached
    /// deposit is the market maker's subsidy and must cover the LMSR worst-case loss b*ln(2).
    /// Whatever the market maker does not lose goes back to the creator at resolution.
    #[payable]
    pub fn create_market(&mut self, spec: MarketSpec, b: U128) -> u64 {
        require!(self.token.is_none(), "this deployment takes token collateral: use ft_transfer_call");
        let deposit = env::attached_deposit().as_yoctonear();
        self.open_market(env::predecessor_account_id(), spec, b, deposit)
    }

    // ---------- trading ----------

    /// Bet the attached NEAR on `outcome` (native-collateral deployments only). Fails if fewer
    /// than `min_shares` would be received.
    #[payable]
    pub fn buy(&mut self, market_id: u64, outcome: Outcome, min_shares: Option<U128>) -> U128 {
        require!(self.token.is_none(), "this deployment takes token collateral: use ft_transfer_call");
        let amount = env::attached_deposit().as_yoctonear();
        let account = env::predecessor_account_id();
        match self.place_bet(account, market_id, outcome, amount, min_shares) {
            Ok(shares) => U128(shares),
            Err(e) => env::panic_str(&e),
        }
    }

    /// NEP-141 receiver. Bets never bounce back to the sender: when a bet cannot be placed
    /// (market closed, slippage, ...) the tokens are refunded to the bettor's account instead,
    /// because the sender may be NEAR Intents rather than the bettor.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(
            self.token.as_ref() == Some(&env::predecessor_account_id()),
            "only the collateral token can call ft_on_transfer"
        );
        let parsed: TransferMsg = match serde_json::from_str(&msg) {
            Ok(m) => m,
            // Unknown message: hand the tokens back to the sender through the standard refund.
            Err(_) => return PromiseOrValue::Value(amount),
        };
        match parsed {
            TransferMsg::Buy { market_id, outcome, min_shares, account } => {
                let bettor = account.unwrap_or(sender_id);
                if let Err(reason) = self.place_bet(bettor.clone(), market_id, outcome, amount.0, min_shares) {
                    emit(
                        "bet_refunded",
                        format!(
                            "{{\"market_id\":{},\"account\":\"{}\",\"amount\":\"{}\",\"reason\":{}}}",
                            market_id,
                            bettor,
                            amount.0,
                            json!(reason)
                        ),
                    );
                    self.pay(bettor.clone(), amount.0, bettor);
                }
                PromiseOrValue::Value(U128(0))
            }
            TransferMsg::CreateMarket { spec, b } => {
                // panics here make the token contract refund the sender
                self.open_market(sender_id, spec, b, amount.0);
                PromiseOrValue::Value(U128(0))
            }
        }
    }

    /// Sell `shares` of `outcome` back to the market maker. Fails if the payout would be below
    /// `min_payout`.
    pub fn sell(&mut self, market_id: u64, outcome: Outcome, shares: U128, min_payout: Option<U128>) -> U128 {
        let account = env::predecessor_account_id();
        let mut market = self.market_or_panic(market_id);
        Self::assert_trading(&market);
        let key = (market_id, account.clone());
        let mut pos = self.positions.get(&key).cloned().unwrap_or_default();
        let held = match outcome {
            Outcome::Yes => pos.yes.0,
            Outcome::No => pos.no.0,
        };
        require!(shares.0 > 0 && shares.0 <= held, "not enough shares");

        let b = self.to_f(market.b.0);
        let (qy, qn) = (self.to_f(market.q_yes.0), self.to_f(market.q_no.0));
        let d = self.to_f(shares.0);
        let payout = match outcome {
            Outcome::Yes => self.to_units(payout_for_sell(qy, qn, b, d)),
            Outcome::No => self.to_units(payout_for_sell(qn, qy, b, d)),
        };
        let payout = payout.min(market.pool.0);
        if let Some(min) = min_payout {
            require!(payout >= min.0, "slippage: payout below min_payout");
        }

        match outcome {
            Outcome::Yes => {
                market.q_yes.0 -= shares.0;
                pos.yes.0 -= shares.0;
            }
            Outcome::No => {
                market.q_no.0 -= shares.0;
                pos.no.0 -= shares.0;
            }
        }
        market.pool.0 -= payout;
        market.volume.0 += payout;
        market.trades += 1;
        Self::assert_solvent(&market);
        pos.received.0 += payout;
        self.positions.insert(key, pos);

        let p = price_yes(self.to_f(market.q_yes.0), self.to_f(market.q_no.0), b);
        self.record_price(market_id, p);
        self.markets.replace(self.slot_or_panic(market_id), market);
        emit(
            "trade",
            format!(
                "{{\"market_id\":{},\"account\":\"{}\",\"side\":\"sell\",\"outcome\":\"{:?}\",\"amount\":\"{}\",\"shares\":\"{}\",\"price_yes\":{}}}",
                market_id, account, outcome, payout, shares.0, p
            ),
        );
        self.pay(account.clone(), payout, account);
        U128(payout)
    }

    // ---------- resolution ----------

    /// Report the measured value. The contract applies the market's rule to decide the
    /// outcome. The market maker's unused subsidy goes back to the creator.
    pub fn resolve(&mut self, market_id: u64, value: U128, evidence: String) -> Resolution {
        self.assert_resolver();
        let mut market = self.market_or_panic(market_id);
        require!(market.resolution.is_none(), "already resolved");
        require!(now_secs() >= market.spec.window_end.0, "window has not ended");
        let outcome = if market.spec.comparator.holds(value.0, market.spec.threshold.0) {
            Resolution::Yes
        } else {
            Resolution::No
        };
        self.finish(&mut market, outcome, Some(value), evidence);
        outcome
    }

    /// Void a market whose data could not be measured. Every share pays half a unit.
    /// The resolver can void at any time. If a market is still unresolved `VOID_GRACE_SECS` after
    /// its window ended, anyone can void it, so a stalled or missing resolver never locks stakes in.
    pub fn void_market(&mut self, market_id: u64, reason: String) {
        let mut market = self.market_or_panic(market_id);
        require!(market.resolution.is_none(), "already resolved");
        let caller = env::predecessor_account_id();
        let reason = if caller == self.resolver {
            reason
        } else {
            require!(
                now_secs() >= market.spec.window_end.0.saturating_add(VOID_GRACE_SECS),
                "resolver only until the void grace period has passed"
            );
            format!("unresolved {} days after the window ended; voided by {}", VOID_GRACE_SECS / 86_400, caller)
        };
        self.finish(&mut market, Resolution::Invalid, None, reason);
    }

    /// Pay out a resolved position, to the caller or to `to`. `to` lets winnings go straight to
    /// a NEAR Intents (1Click) deposit address, which swaps them and delivers them on another
    /// chain (e.g. SOL to a Solana address).
    pub fn claim(&mut self, market_id: u64, to: Option<AccountId>) -> U128 {
        let account = env::predecessor_account_id();
        let mut market = self.market_or_panic(market_id);
        let resolution = market.resolution.unwrap_or_else(|| env::panic_str("not resolved"));
        let key = (market_id, account.clone());
        let mut pos = self
            .positions
            .get(&key)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no position"));
        require!(!pos.claimed, "already claimed");
        let amount = match resolution {
            Resolution::Yes => pos.yes.0,
            Resolution::No => pos.no.0,
            Resolution::Invalid => (pos.yes.0 + pos.no.0) / 2,
        };
        let amount = amount.min(market.pool.0);
        pos.claimed = true;
        pos.received.0 += amount;
        self.positions.insert(key, pos);
        market.pool.0 -= amount;
        self.markets.replace(self.slot_or_panic(market_id), market);
        let receiver = to.unwrap_or_else(|| account.clone());
        emit(
            "claim",
            format!(
                "{{\"market_id\":{},\"account\":\"{}\",\"to\":\"{}\",\"amount\":\"{}\"}}",
                market_id, account, receiver, amount
            ),
        );
        // a failed payout is owed to the claimer, never to `to` (which may be a one-time 1Click
        // deposit address that nobody can withdraw from)
        self.pay(receiver, amount, account);
        U128(amount)
    }

    /// Retry payouts whose transfer failed earlier, to the caller or to `to`.
    pub fn withdraw_owed(&mut self, to: Option<AccountId>) -> U128 {
        let account = env::predecessor_account_id();
        let amount = self.owed.remove(&account).unwrap_or(0);
        require!(amount > 0, "nothing owed");
        self.pay(to.unwrap_or_else(|| account.clone()), amount, account);
        U128(amount)
    }

    /// Callback after a payout: a failed transfer is recorded as owed to `account` (the owner of
    /// the funds, not necessarily the receiver) instead of being lost.
    #[private]
    pub fn after_payout(&mut self, account: AccountId, amount: U128) {
        // transfers return no value; only success or failure matters
        let ok = env::promise_result_checked(0, 1024).is_ok();
        if !ok {
            let owed = self.owed.get(&account).copied().unwrap_or(0) + amount.0;
            self.owed.insert(account.clone(), owed);
            emit(
                "payout_failed",
                format!("{{\"account\":\"{}\",\"amount\":\"{}\"}}", account, amount.0),
            );
        }
    }

    // ---------- views ----------

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            resolver: self.resolver.clone(),
            token: self.token.clone(),
            decimals: self.decimals,
            market_count: self.markets.len() as u64,
        }
    }

    pub fn get_markets(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<MarketView> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(50);
        (from..from.saturating_add(limit).min(self.markets.len() as u64))
            .map(|i| self.view(self.markets.get(i as u32).unwrap().clone()))
            .collect()
    }

    pub fn get_market(&self, market_id: u64) -> Option<MarketView> {
        self.slot(market_id).and_then(|i| self.markets.get(i)).cloned().map(|m| self.view(m))
    }

    pub fn get_price_history(&self, market_id: u64) -> Vec<PricePoint> {
        self.history.get(&market_id).cloned().unwrap_or_default()
    }

    pub fn get_position(&self, market_id: u64, account_id: AccountId) -> Option<Position> {
        self.positions.get(&(market_id, account_id)).cloned()
    }

    /// All positions of an account, as (market_id, position).
    pub fn get_positions(&self, account_id: AccountId) -> Vec<(u64, Position)> {
        (0..self.markets.len() as u64)
            .filter_map(|i| self.positions.get(&(i, account_id.clone())).map(|p| (i, p.clone())))
            .collect()
    }

    pub fn get_owed(&self, account_id: AccountId) -> U128 {
        U128(self.owed.get(&account_id).copied().unwrap_or(0))
    }

    pub fn quote_buy(&self, market_id: u64, outcome: Outcome, amount: U128) -> BuyQuote {
        let market = self.market_or_panic(market_id);
        let b = self.to_f(market.b.0);
        let (qy, qn) = (self.to_f(market.q_yes.0), self.to_f(market.q_no.0));
        let m = self.to_f(amount.0);
        let (shares, py_after) = match outcome {
            Outcome::Yes => {
                let s = shares_for_spend(qy, qn, b, m);
                (s, price_yes(qy + s, qn, b))
            }
            Outcome::No => {
                let s = shares_for_spend(qn, qy, b, m);
                (s, price_yes(qy, qn + s, b))
            }
        };
        let side = |py: f64| if outcome == Outcome::Yes { py } else { 1.0 - py };
        BuyQuote {
            shares: U128(self.to_units(shares)),
            avg_price: if shares > 0.0 { m / shares } else { 0.0 },
            price_before: side(price_yes(qy, qn, b)),
            price_after: side(py_after),
            max_payout: U128(self.to_units(shares)),
        }
    }

    pub fn quote_sell(&self, market_id: u64, outcome: Outcome, shares: U128) -> SellQuote {
        let market = self.market_or_panic(market_id);
        let b = self.to_f(market.b.0);
        let (qy, qn) = (self.to_f(market.q_yes.0), self.to_f(market.q_no.0));
        let d = self.to_f(shares.0);
        let (payout, py_after) = match outcome {
            Outcome::Yes => (payout_for_sell(qy, qn, b, d), price_yes(qy - d, qn, b)),
            Outcome::No => (payout_for_sell(qn, qy, b, d), price_yes(qy, qn - d, b)),
        };
        let side = |py: f64| if outcome == Outcome::Yes { py } else { 1.0 - py };
        SellQuote {
            payout: U128(self.to_units(payout)),
            price_before: side(price_yes(qy, qn, b)),
            price_after: side(py_after),
        }
    }

    // ---------- internal ----------

    fn unit(&self) -> u128 {
        10u128.pow(self.decimals as u32)
    }

    fn to_f(&self, base: u128) -> f64 {
        base as f64 / self.unit() as f64
    }

    fn to_units(&self, x: f64) -> u128 {
        if x.is_finite() && x > 0.0 {
            (x * self.unit() as f64).floor() as u128
        } else {
            0
        }
    }

    fn open_market(&mut self, creator: AccountId, spec: MarketSpec, b: U128, deposit: u128) -> u64 {
        require!(
            creator == self.owner || creator == self.resolver,
            "only the owner or resolver can create markets"
        );
        require!(b.0 >= self.unit() / 10, "b must be at least 0.1 units");
        require!(spec.window_end.0 > spec.window_start.0, "empty window");
        require!(spec.close_time.0 <= spec.window_end.0, "trading must close by window end");
        require!(spec.close_time.0 > now_secs(), "close time is in the past");
        let min_subsidy = self.to_units(self.to_f(b.0) * std::f64::consts::LN_2) + 1;
        require!(
            deposit >= min_subsidy,
            format!("deposit must be at least b*ln2 = {} base units", min_subsidy)
        );

        let id = self.markets.len() as u64;
        self.markets.push(Market {
            id,
            creator,
            spec,
            b,
            q_yes: U128(0),
            q_no: U128(0),
            pool: U128(deposit),
            subsidy: U128(deposit),
            volume: U128(0),
            trades: 0,
            created_at: U64(now_secs()),
            resolution: None,
            resolved_value: None,
            evidence: None,
            resolved_at: None,
        });
        self.history.insert(id, vec![PricePoint { t: U64(now_secs()), p: 500_000 }]);
        emit("market_created", format!("{{\"market_id\":{}}}", id));
        id
    }

    /// Place a bet without panicking, so token deposits can be refunded on failure.
    fn place_bet(
        &mut self,
        account: AccountId,
        market_id: u64,
        outcome: Outcome,
        amount: u128,
        min_shares: Option<U128>,
    ) -> Result<u128, String> {
        if amount < self.unit() / 100 {
            return Err("minimum bet is 0.01 units".into());
        }
        let mut market = self.slot(market_id).and_then(|i| self.markets.get(i)).cloned().ok_or("no such market")?;
        if market.resolution.is_some() {
            return Err("market is resolved".into());
        }
        if now_secs() >= market.spec.close_time.0 {
            return Err("trading is closed".into());
        }

        let b = self.to_f(market.b.0);
        let (qy, qn) = (self.to_f(market.q_yes.0), self.to_f(market.q_no.0));
        let m = self.to_f(amount);
        let shares = match outcome {
            Outcome::Yes => self.to_units(shares_for_spend(qy, qn, b, m)),
            Outcome::No => self.to_units(shares_for_spend(qn, qy, b, m)),
        };
        if shares == 0 {
            return Err("trade too small".into());
        }
        if let Some(min) = min_shares {
            if shares < min.0 {
                return Err("slippage: fewer shares than min_shares".into());
            }
        }

        match outcome {
            Outcome::Yes => market.q_yes.0 += shares,
            Outcome::No => market.q_no.0 += shares,
        }
        market.pool.0 += amount;
        market.volume.0 += amount;
        market.trades += 1;
        if market.pool.0 < market.q_yes.0.max(market.q_no.0) {
            return Err("market maker would be insolvent".into());
        }

        let mut pos = self.positions.get(&(market_id, account.clone())).cloned().unwrap_or_default();
        match outcome {
            Outcome::Yes => pos.yes.0 += shares,
            Outcome::No => pos.no.0 += shares,
        }
        pos.spent.0 += amount;
        self.positions.insert((market_id, account.clone()), pos);

        let p = price_yes(self.to_f(market.q_yes.0), self.to_f(market.q_no.0), b);
        self.record_price(market_id, p);
        self.markets.replace(self.slot_or_panic(market_id), market);
        emit(
            "trade",
            format!(
                "{{\"market_id\":{},\"account\":\"{}\",\"side\":\"buy\",\"outcome\":\"{:?}\",\"amount\":\"{}\",\"shares\":\"{}\",\"price_yes\":{}}}",
                market_id, account, outcome, amount, shares, p
            ),
        );
        Ok(shares)
    }

    /// Send collateral to `to`. For a token, the receiver is registered first (storage deposit,
    /// refunded by the token if already registered). A failed transfer is recorded as owed to
    /// `owner`, the account entitled to the funds, who can retry with `withdraw_owed`.
    fn pay(&mut self, to: AccountId, amount: u128, owner: AccountId) {
        if amount == 0 {
            return;
        }
        let transfer = match &self.token {
            None => Promise::new(to.clone()).transfer(NearToken::from_yoctonear(amount)),
            Some(token) => Promise::new(token.clone())
                .function_call(
                    "storage_deposit",
                    json!({ "account_id": to, "registration_only": true }).to_string().into_bytes(),
                    NearToken::from_yoctonear(FT_STORAGE_DEPOSIT),
                    Gas::from_tgas(5),
                )
                .function_call(
                    "ft_transfer",
                    json!({ "receiver_id": to, "amount": U128(amount) }).to_string().into_bytes(),
                    NearToken::from_yoctonear(1),
                    Gas::from_tgas(10),
                ),
        };
        transfer
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(5))
                    .after_payout(owner, U128(amount)),
            )
            .detach();
    }

    fn finish(&mut self, market: &mut Market, outcome: Resolution, value: Option<U128>, evidence: String) {
        let liability = match outcome {
            Resolution::Yes => market.q_yes.0,
            Resolution::No => market.q_no.0,
            Resolution::Invalid => (market.q_yes.0 + market.q_no.0) / 2,
        };
        let surplus = market.pool.0.saturating_sub(liability);
        market.pool.0 -= surplus;
        market.resolution = Some(outcome);
        market.resolved_value = value;
        market.evidence = Some(evidence);
        market.resolved_at = Some(U64(now_secs()));
        let id = market.id;
        let creator = market.creator.clone();
        let final_p = match outcome {
            Resolution::Yes => 1.0,
            Resolution::No => 0.0,
            Resolution::Invalid => 0.5,
        };
        self.record_price(id, final_p);
        self.markets.replace(self.slot_or_panic(id), market.clone());
        emit(
            "market_resolved",
            format!(
                "{{\"market_id\":{},\"resolution\":\"{:?}\",\"value\":\"{}\",\"surplus\":\"{}\"}}",
                id,
                outcome,
                value.map(|v| v.0).unwrap_or(0),
                surplus
            ),
        );
        self.pay(creator.clone(), surplus, creator);
    }

    fn record_price(&mut self, market_id: u64, p: f64) {
        let mut h = self.history.get(&market_id).cloned().unwrap_or_default();
        h.push(PricePoint {
            t: U64(now_secs()),
            p: (p.clamp(0.0, 1.0) * 1_000_000.0).round() as u32,
        });
        if h.len() > MAX_HISTORY {
            h.remove(1); // keep the opening point
        }
        self.history.insert(market_id, h);
    }

    fn view(&self, market: Market) -> MarketView {
        let b = self.to_f(market.b.0);
        let py = match market.resolution {
            Some(Resolution::Yes) => 1.0,
            Some(Resolution::No) => 0.0,
            Some(Resolution::Invalid) => 0.5,
            None => price_yes(self.to_f(market.q_yes.0), self.to_f(market.q_no.0), b),
        };
        let status = if market.resolution.is_some() {
            "resolved"
        } else if now_secs() >= market.spec.close_time.0 {
            "closed"
        } else {
            "open"
        };
        MarketView { market, status: status.to_string(), price_yes: py, price_no: 1.0 - py }
    }

    /// The `markets` index of `market_id`, or None if there is no such market. Ids are u64 in the
    /// API but the vector is u32-indexed; an id of 2^32 or more must not wrap onto an existing market.
    fn slot(&self, market_id: u64) -> Option<u32> {
        u32::try_from(market_id).ok().filter(|&i| i < self.markets.len())
    }

    fn slot_or_panic(&self, market_id: u64) -> u32 {
        self.slot(market_id).unwrap_or_else(|| env::panic_str("no such market"))
    }

    fn market_or_panic(&self, market_id: u64) -> Market {
        self.markets[self.slot_or_panic(market_id)].clone()
    }

    fn assert_trading(market: &Market) {
        require!(market.resolution.is_none(), "market is resolved");
        require!(now_secs() < market.spec.close_time.0, "trading is closed");
    }

    /// The pool must always cover the larger side, which is the most it can ever owe.
    fn assert_solvent(market: &Market) {
        require!(
            market.pool.0 >= market.q_yes.0.max(market.q_no.0),
            "market maker would be insolvent"
        );
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    fn assert_resolver(&self) {
        require!(env::predecessor_account_id() == self.resolver, "resolver only");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, get_logs, VMContextBuilder};
    use near_sdk::{testing_env, PromiseResult};

    const T0: u64 = 1_800_000_000;
    const USDC: u128 = 1_000_000;

    fn ctx(who: usize, deposit: u128, now: u64) {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(accounts(who))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(now * 1_000_000_000)
            .account_balance(NearToken::from_near(10_000));
        testing_env!(b.build());
    }

    fn spec() -> MarketSpec {
        MarketSpec {
            question: "Will pool X emit more than 100 Swap events?".into(),
            category: "DEX".into(),
            protocol: "Uniswap v3".into(),
            chain: "ethereum".into(),
            metric: "Swap events".into(),
            unit: "swaps".into(),
            decimals: 0,
            comparator: Comparator::Gt,
            threshold: U128(100),
            source: "{}".into(),
            window_start: U64(T0 + 100),
            window_end: U64(T0 + 3700),
            close_time: U64(T0 + 3000),
        }
    }

    fn to_near(y: u128) -> f64 {
        y as f64 / 1e24
    }

    /// Native NEAR deployment. accounts(0) = owner, accounts(1) = resolver, 2.. = traders
    fn setup() -> (Contract, u64) {
        ctx(0, 0, T0);
        let mut c = Contract::new(accounts(0), accounts(1), None, None);
        ctx(1, 7 * ONE_NEAR, T0);
        let id = c.create_market(spec(), U128(10 * ONE_NEAR));
        (c, id)
    }

    /// USDC deployment: accounts(5) is the token contract.
    fn setup_ft() -> (Contract, u64) {
        ctx(0, 0, T0);
        let mut c = Contract::new(accounts(0), accounts(1), Some(accounts(5)), Some(6));
        ctx(5, 0, T0);
        let msg = json!({ "create_market": { "spec": spec(), "b": U128(10 * USDC) } }).to_string();
        let _ = c.ft_on_transfer(accounts(1), U128(7 * USDC), msg);
        (c, 0)
    }

    fn ft_buy(c: &mut Contract, sender: usize, account: Option<usize>, amount: u128, outcome: &str, now: u64) {
        ctx(5, 0, now);
        let mut buy = json!({ "market_id": 0, "outcome": outcome });
        if let Some(a) = account {
            buy["account"] = json!(accounts(a));
        }
        let _ = c.ft_on_transfer(accounts(sender), U128(amount), json!({ "buy": buy }).to_string());
    }

    #[test]
    fn opens_at_even_odds() {
        let (c, id) = setup();
        let m = c.get_market(id).unwrap();
        assert!((m.price_yes - 0.5).abs() < 1e-12);
        assert_eq!(m.status, "open");
    }

    #[test]
    #[should_panic(expected = "deposit must be at least")]
    fn subsidy_must_cover_worst_case() {
        ctx(0, 0, T0);
        let mut c = Contract::new(accounts(0), accounts(1), None, None);
        ctx(1, 6 * ONE_NEAR, T0); // 10*ln2 = 6.93
        c.create_market(spec(), U128(10 * ONE_NEAR));
    }

    #[test]
    fn buy_moves_price_and_quote_matches() {
        let (mut c, id) = setup();
        ctx(2, 0, T0 + 10);
        let q = c.quote_buy(id, Outcome::Yes, U128(2 * ONE_NEAR));
        ctx(2, 2 * ONE_NEAR, T0 + 10);
        let shares = c.buy(id, Outcome::Yes, Some(q.shares));
        assert_eq!(shares.0, q.shares.0);
        // 2 NEAR at ~0.5 buys a bit under 4 shares
        let s = to_near(shares.0);
        assert!(s > 3.5 && s < 4.0, "shares {s}");
        let m = c.get_market(id).unwrap();
        assert!(m.price_yes > 0.5);
        assert!((m.price_yes - q.price_after).abs() < 1e-9);
        assert_eq!(c.get_position(id, accounts(2)).unwrap().yes.0, shares.0);
    }

    #[test]
    fn buy_then_sell_round_trips_without_profit() {
        let (mut c, id) = setup();
        ctx(2, 3 * ONE_NEAR, T0 + 10);
        let shares = c.buy(id, Outcome::No, None);
        ctx(2, 0, T0 + 20);
        let back = c.sell(id, Outcome::No, shares, None);
        assert!(back.0 <= 3 * ONE_NEAR);
        assert!(back.0 > 3 * ONE_NEAR - ONE_NEAR / 1_000_000);
        assert!((c.get_market(id).unwrap().price_yes - 0.5).abs() < 1e-9);
    }

    #[test]
    fn stays_solvent_under_one_sided_flow() {
        let (mut c, id) = setup();
        for i in 0..40 {
            ctx(2 + (i % 3), 50 * ONE_NEAR, T0 + 10 + i as u64);
            c.buy(id, Outcome::Yes, None);
        }
        let m = c.get_market(id).unwrap();
        assert!(m.price_yes > 0.999);
        assert!(m.market.pool.0 >= m.market.q_yes.0);
    }

    #[test]
    fn resolves_by_rule_and_pays_winners() {
        let (mut c, id) = setup();
        ctx(2, 2 * ONE_NEAR, T0 + 10);
        let yes = c.buy(id, Outcome::Yes, None);
        ctx(3, 2 * ONE_NEAR, T0 + 11);
        c.buy(id, Outcome::No, None);

        ctx(1, 0, T0 + 3700);
        assert_eq!(c.resolve(id, U128(150), "blocks 1..2".into()), Resolution::Yes);
        let m = c.get_market(id).unwrap();
        assert_eq!(m.status, "resolved");
        // surplus returned to creator; pool holds exactly the YES liability
        assert_eq!(m.market.pool.0, m.market.q_yes.0);

        ctx(2, 0, T0 + 3800);
        assert_eq!(c.claim(id, None).0, yes.0);
        ctx(3, 0, T0 + 3800);
        assert_eq!(c.claim(id, None).0, 0);
    }

    #[test]
    fn lt_comparator_resolves_no_when_value_high() {
        ctx(0, 0, T0);
        let mut c = Contract::new(accounts(0), accounts(1), None, None);
        let mut s = spec();
        s.comparator = Comparator::Lt;
        ctx(1, 7 * ONE_NEAR, T0);
        let id = c.create_market(s, U128(10 * ONE_NEAR));
        ctx(1, 0, T0 + 3700);
        assert_eq!(c.resolve(id, U128(100), "".into()), Resolution::No);
    }

    #[test]
    fn void_pays_half_per_share() {
        let (mut c, id) = setup();
        ctx(2, 2 * ONE_NEAR, T0 + 10);
        let yes = c.buy(id, Outcome::Yes, None);
        ctx(1, 0, T0 + 20);
        c.void_market(id, "rpc unavailable".into());
        ctx(2, 0, T0 + 30);
        assert_eq!(c.claim(id, None).0, yes.0 / 2);
    }

    #[test]
    #[should_panic(expected = "trading is closed")]
    fn no_trading_after_close() {
        let (mut c, id) = setup();
        ctx(2, ONE_NEAR, T0 + 3000);
        c.buy(id, Outcome::Yes, None);
    }

    #[test]
    #[should_panic(expected = "window has not ended")]
    fn no_resolution_before_window_end() {
        let (mut c, id) = setup();
        ctx(1, 0, T0 + 3699);
        c.resolve(id, U128(1), "".into());
    }

    #[test]
    #[should_panic(expected = "resolver only")]
    fn only_resolver_resolves() {
        let (mut c, id) = setup();
        ctx(2, 0, T0 + 3700);
        c.resolve(id, U128(1), "".into());
    }

    #[test]
    #[should_panic(expected = "already claimed")]
    fn no_double_claim() {
        let (mut c, id) = setup();
        ctx(2, ONE_NEAR, T0 + 10);
        c.buy(id, Outcome::Yes, None);
        ctx(1, 0, T0 + 3700);
        c.resolve(id, U128(150), "".into());
        ctx(2, 0, T0 + 3800);
        c.claim(id, None);
        c.claim(id, None);
    }

    // ---------- token (USDC) collateral ----------

    #[test]
    fn ft_market_opens_from_transfer_and_prices_in_usdc() {
        let (c, id) = setup_ft();
        let m = c.get_market(id).unwrap();
        assert_eq!(m.market.pool.0, 7 * USDC);
        assert_eq!(c.get_config().decimals, 6);
        let q = c.quote_buy(id, Outcome::Yes, U128(2 * USDC));
        let s = q.shares.0 as f64 / 1e6;
        assert!(s > 3.5 && s < 4.0, "shares {s}");
    }

    #[test]
    fn ft_bet_via_intents_credits_the_named_account() {
        let (mut c, id) = setup_ft();
        // sender is the Intents contract (accounts(4)); the position belongs to accounts(2)
        ft_buy(&mut c, 4, Some(2), 2 * USDC, "Yes", T0 + 10);
        assert!(c.get_position(id, accounts(2)).unwrap().yes.0 > 0);
        assert!(c.get_position(id, accounts(4)).is_none());
        assert!(c.get_market(id).unwrap().price_yes > 0.5);
    }

    #[test]
    fn ft_bet_from_wallet_defaults_to_sender() {
        let (mut c, id) = setup_ft();
        ft_buy(&mut c, 3, None, USDC, "No", T0 + 10);
        assert!(c.get_position(id, accounts(3)).unwrap().no.0 > 0);
    }

    #[test]
    fn ft_failed_bet_is_refunded_to_bettor_not_bounced() {
        let (mut c, id) = setup_ft();
        // after close: the bet cannot be placed
        ft_buy(&mut c, 4, Some(2), 2 * USDC, "Yes", T0 + 3000);
        assert!(c.get_position(id, accounts(2)).is_none());
        assert_eq!(c.get_market(id).unwrap().market.pool.0, 7 * USDC);
        assert!(get_logs().iter().any(|l| l.contains("bet_refunded") && l.contains("trading is closed")));
    }

    #[test]
    fn ft_unknown_message_is_returned_to_sender() {
        let (mut c, _) = setup_ft();
        ctx(5, 0, T0 + 10);
        match c.ft_on_transfer(accounts(2), U128(USDC), "hello".into()) {
            PromiseOrValue::Value(v) => assert_eq!(v.0, USDC),
            _ => panic!("expected a value"),
        }
    }

    #[test]
    #[should_panic(expected = "only the collateral token")]
    fn ft_on_transfer_rejects_other_tokens() {
        let (mut c, _) = setup_ft();
        ctx(3, 0, T0 + 10);
        let _ = c.ft_on_transfer(accounts(2), U128(USDC), "{}".into());
    }

    #[test]
    #[should_panic(expected = "use ft_transfer_call")]
    fn ft_deployment_rejects_native_bets() {
        let (mut c, id) = setup_ft();
        ctx(2, ONE_NEAR, T0 + 10);
        c.buy(id, Outcome::Yes, None);
    }

    /// The (account, amount) of every after_payout callback scheduled so far.
    fn scheduled_payouts() -> Vec<(AccountId, U128)> {
        near_sdk::test_utils::get_created_receipts()
            .iter()
            .flat_map(|r| r.actions.iter())
            .filter_map(|a| match a {
                near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, .. } if method_name == b"after_payout" => {
                    let v: serde_json::Value = serde_json::from_slice(args).unwrap();
                    Some((v["account"].as_str().unwrap().parse().unwrap(), U128(v["amount"].as_str().unwrap().parse().unwrap())))
                }
                _ => None,
            })
            .collect()
    }

    /// Run the scheduled after_payout callback as the runtime would after the transfer failed.
    fn fail_payout(c: &mut Contract, (account, amount): (AccountId, U128), now: u64) {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(near_sdk::env::current_account_id()).block_timestamp(now * 1_000_000_000);
        testing_env!(b.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![PromiseResult::Failed]);
        c.after_payout(account, amount);
    }

    #[test]
    fn failed_claim_to_deposit_address_is_owed_to_claimer() {
        let (mut c, id) = setup_ft();
        ft_buy(&mut c, 4, Some(2), 2 * USDC, "Yes", T0 + 10);
        ctx(1, 0, T0 + 3700);
        c.resolve(id, U128(150), "".into());
        ctx(2, 0, T0 + 3800);
        let deposit_addr: AccountId = "b".repeat(64).parse().unwrap();
        let paid = c.claim(id, Some(deposit_addr.clone()));
        // the contract schedules exactly one callback, keyed to the claimer, for the claimed amount
        let cb = scheduled_payouts();
        assert_eq!(cb, vec![(accounts(2), paid)]);

        // replay that callback (whatever it names) with a failed transfer: the claimer is owed,
        // the deposit address is not, and the claimer can withdraw to an account of their choice
        fail_payout(&mut c, cb[0].clone(), T0 + 3801);
        assert_eq!(c.get_owed(accounts(2)).0, paid.0);
        assert_eq!(c.get_owed(deposit_addr).0, 0);
        ctx(2, 0, T0 + 3900);
        assert_eq!(c.withdraw_owed(Some(accounts(3))).0, paid.0);
        assert_eq!(c.get_owed(accounts(2)).0, 0);
        // the retry is keyed to the claimer too, even though it goes to accounts(3)
        assert_eq!(scheduled_payouts().last().cloned(), Some((accounts(2), paid)));
    }

    #[test]
    #[should_panic(expected = "resolver only until the void grace period")]
    fn stranger_cannot_void_during_grace() {
        let (mut c, id) = setup();
        ctx(3, 0, T0 + 3700 + VOID_GRACE_SECS - 1);
        c.void_market(id, "".into());
    }

    #[test]
    fn anyone_can_void_after_grace() {
        let (mut c, id) = setup();
        ctx(2, ONE_NEAR, T0 + 10);
        let yes = c.buy(id, Outcome::Yes, None);
        ctx(3, 0, T0 + 3700 + VOID_GRACE_SECS);
        c.void_market(id, "ignored".into());
        let m = c.get_market(id).unwrap().market;
        assert_eq!(m.resolution, Some(Resolution::Invalid));
        assert!(m.evidence.unwrap().contains("voided by"));
        ctx(2, 0, T0 + 3700 + VOID_GRACE_SECS + 1);
        assert_eq!(c.claim(id, None).0, yes.0 / 2);
    }

    #[test]
    #[should_panic(expected = "already resolved")]
    fn no_void_after_resolution() {
        let (mut c, id) = setup();
        ctx(1, 0, T0 + 3700);
        c.resolve(id, U128(150), "".into());
        ctx(3, 0, T0 + 3700 + VOID_GRACE_SECS);
        c.void_market(id, "".into());
    }

    #[test]
    fn ids_beyond_u32_do_not_alias() {
        let (mut c, id) = setup();
        let alias = id + (1u64 << 32);
        assert!(c.get_market(alias).is_none());
        ctx(2, ONE_NEAR, T0 + 10);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.buy(alias, Outcome::Yes, None)));
        assert!(r.is_err());
        assert!(c.get_positions(accounts(2)).is_empty());
    }

    #[test]
    fn successful_payout_owes_nothing() {
        let (mut c, _) = setup_ft();
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(near_sdk::env::current_account_id());
        testing_env!(b.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![PromiseResult::Successful(vec![])]);
        c.after_payout(accounts(2), U128(USDC));
        assert_eq!(c.get_owed(accounts(2)).0, 0);
    }

    #[test]
    fn ft_claim_can_go_to_another_account() {
        let (mut c, id) = setup_ft();
        ft_buy(&mut c, 4, Some(2), 2 * USDC, "Yes", T0 + 10);
        ctx(1, 0, T0 + 3700);
        c.resolve(id, U128(150), "".into());
        ctx(2, 0, T0 + 3800);
        let deposit_addr: AccountId = "a".repeat(64).parse().unwrap();
        let paid = c.claim(id, Some(deposit_addr.clone()));
        assert!(paid.0 > 3 * USDC);
        assert!(get_logs().iter().any(|l| l.contains("\"event\":\"claim\"") && l.contains(deposit_addr.as_str())));
    }
}
