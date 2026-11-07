import { useState } from 'react';
import { CMP_TEXT, CONTRACT_ID, EXPLORER, fmtAmt, NET, fmtMetric, getHistory, getMarkets, getOwed, getPositions, ONE, SYMBOL, type Market, type PricePoint } from '../../shared/near.ts';
import { useApp } from './App.tsx';
import { Sparkline } from './charts.tsx';
import { cents, statusLine, useNow, usePoll, utc } from './util.ts';

const ICON: Record<string, string> = { Stablecoins: '$', Lending: '◎', Network: '⬡', DEX: '⇄' };

const USES = [
  {
    tag: 'hedge',
    title: 'Hedge your Morpho loan',
    text: 'Borrowing USDC against cbBTC? Buy YES on the borrow rate. If rates spike, the payout offsets the extra interest.',
  },
  {
    tag: 'hedge',
    title: 'Hedge your gas bill',
    text: 'Running a bot, a bridge or a rollup? Buy YES on base fee or blob demand. When fees jump, the payout covers part of the bill.',
  },
  {
    tag: 'call it',
    title: 'Back the number, not the token',
    text: 'Think USDC supply will grow or the peg will slip this afternoon? Take a side on the metric itself.',
  },
  {
    tag: 'any chain',
    title: 'If it emits logs, it is a market',
    text: 'Liquidations on Base, Solana program calls, NEAR staking, bridge flows: anything with an RPC can settle a market.',
  },
];

export function Home() {
  const { session, version } = useApp();
  const [cat, setCat] = useState('All');
  const { data: markets, error } = usePoll(getMarkets, [version], 10_000);
  const { data: histories } = usePoll(
    async () => {
      const ms = markets ?? [];
      const hs = await Promise.all(ms.map((m) => getHistory(m.id)));
      return Object.fromEntries(ms.map((m, i) => [m.id, hs[i]])) as Record<number, PricePoint[]>;
    },
    [markets?.map((m) => `${m.id}:${m.trades}`).join(',')],
    0,
  );
  const { data: positions } = usePoll(
    () => (session ? getPositions(session.accountId) : Promise.resolve([])),
    [session?.accountId, version],
    15_000,
  );
  const now = useNow(1000);

  const cats = ['All', ...new Set((markets ?? []).map((m) => m.spec.category))];
  const shown = (markets ?? [])
    .filter((m) => cat === 'All' || m.spec.category === cat)
    .sort((a, b) => rank(a) - rank(b) || Number(a.spec.window_end) - Number(b.spec.window_end));

  return (
    <>
      <section className="hero">
        <h1>
          Bets on the <mark>line</mark>, settled by the <mark>logs</mark>.
        </h1>
        <p>
          If a chain can count it, you can bet on it. A Logline market is a number read from on-chain data (a token's net supply, a pool price, a
          lending rate, a block's base fee) and a line to beat. Every one can move up or down until the window closes. Today's markets read
          stablecoins, lending and the network itself on Ethereum; the same pattern works for NEAR, Solana, Base or any chain with a public RPC. An LMSR market maker on NEAR quotes every trade, and anyone can recompute the result from the evidence posted
          on-chain.
        </p>
        <div className="uses">
          {USES.map((u) => (
            <div key={u.title} className="use">
              <div className="use-tag mono">{u.tag}</div>
              <b>{u.title}</b>
              <span>{u.text}</span>
            </div>
          ))}
        </div>
      </section>

      {session && <Owed account={session.accountId} />}
      {session && positions && positions.length > 0 && markets && <Portfolio positions={positions} markets={markets} />}

      <div className="tabs">
        {cats.map((c) => (
          <button key={c} className={c === cat ? 'tab on' : 'tab'} onClick={() => setCat(c)}>
            {ICON[c] ? `${ICON[c]} ` : ''}
            {c}
          </button>
        ))}
      </div>

      {error &&
        (NET.id === 'mainnet' && /does not exist|UNKNOWN_ACCOUNT|CodeDoesNotExist|doesn't exist/i.test(String(error)) ? (
          <div className="card">
            <b>The mainnet contract ({CONTRACT_ID}) is not deployed yet.</b> The mainnet build (USDC collateral, real NEAR Intents payments and payouts) is in the
            repo; switch to <a href="?net=testnet">testnet</a> to try Logline now.
          </div>
        ) : (
          <div className="card err">Could not load markets: {error}</div>
        ))}
      {!markets && !error && <div className="card muted">Loading markets…</div>}

      <div className="grid">
        {shown.map((m) => {
          const st = statusLine(m, now);
          const hist = (histories?.[m.id] ?? []).map((p) => ({ t: Number(p.t), v: p.p / 1e6 }));
          return (
            <a key={m.id} href={`#/market/${m.id}`} className={`card market-card ${m.resolution ? 'resolved' : ''}`}>
              <div className="hexbar">
                <span>
                  <b>#{String(m.id).padStart(3, '0')}</b> {sourceHex(m.spec.source)}
                </span>
                <span>{m.spec.chain}</span>
              </div>
              <div className="body">
              <div className="row gap-s">
                <span className="chip cat">{m.spec.category}</span>
                <span className="chip">{m.spec.protocol}</span>
              </div>
              <h3>{m.spec.question}</h3>
              <div className="rule mono">
                {m.spec.metric.split(',')[0]} {CMP_TEXT[m.spec.comparator]} {fmtMetric(m.spec.threshold, m.spec)}
              </div>
              <div className="card-foot">
                <div>
                  {m.resolution ? (
                    <div className={`badge ${m.resolution === 'Yes' ? 'yes' : m.resolution === 'No' ? 'no' : 'void'}`}>{m.resolution.toUpperCase()}</div>
                  ) : (
                    <div className="big">
                      <span className="yes">{cents(m.price_yes)}</span>
                      <span className="dim small"> YES</span>
                    </div>
                  )}
                  <div className={`status ${st.tone}`}>{st.text}</div>
                </div>
                <div className="right">
                  <Sparkline points={hist} color={m.resolution === 'No' ? 'var(--no)' : 'var(--yes)'} />
                  <div className="dim small mono">
                    {fmtAmt(m.volume, 1)} {SYMBOL} vol · ends {utc(m.spec.window_end, false)}
                  </div>
                </div>
              </div>
              </div>
            </a>
          );
        })}
      </div>
    </>
  );
}

/** the raw identifier a market reads, shown as texture: contract + topic0 or market id */
function sourceHex(json: string): string {
  try {
    const s = JSON.parse(json);
    const a = (h: string, n = 4) => `${h.slice(0, n + 2)}…${h.slice(-n)}`;
    if (s.kind === 'evm_log_count') return `${a(s.address)} · topic0 ${a(s.topic0, 6)}`;
    if (s.kind === 'morpho_market' || s.kind === 'morpho_rate') return `${a(s.morpho)} · id ${a(s.marketId, 6)}`;
    if (s.kind === 'erc20_net_mint') return `${a(s.token)} · mint/burn`;
    if (s.kind === 'univ3_price') return `${a(s.pool)} · sqrtPriceX96`;
    if (s.kind === 'block_stat') return `block headers · ${s.field === 'baseFee' ? 'baseFeePerGas' : 'blobGasUsed'}`;
    return '';
  } catch {
    return '';
  }
}

function rank(m: Market) {
  return m.status === 'open' ? 0 : m.status === 'closed' ? 1 : 2;
}

/** Collateral from a payout that failed to transfer (the contract keeps it under get_owed). */
function Owed({ account }: { account: string }) {
  const { session, version, toast, bump } = useApp();
  const [busy, setBusy] = useState(false);
  const { data: owed } = usePoll(() => getOwed(account), [account, version], 30_000);
  if (!owed) return null;
  async function withdraw() {
    setBusy(true);
    try {
      const r = await session!.send({ methodName: 'withdraw_owed', args: {} });
      toast({ text: `Withdrew ${fmtAmt(owed!, 3)} ${SYMBOL}`, tone: 'ok', href: `${EXPLORER}/txns/${r.hash}` });
      bump();
    } catch (e) {
      toast({ text: `Withdraw failed: ${(e as Error).message}`, tone: 'err' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card owed">
      <div>
        <div className="label">Owed to you</div>
        <div className="mono big-s yes">
          {fmtAmt(owed, 3)} {SYMBOL}
        </div>
      </div>
      <span className="dim">A payout to you could not be delivered, so the contract is holding it. Withdraw it to your NEAR account.</span>
      <button className="btn primary" disabled={busy} onClick={withdraw}>
        {busy ? 'Withdrawing…' : 'Withdraw'}
      </button>
    </div>
  );
}

function Portfolio({ positions, markets }: { positions: [number, import('../../shared/near.ts').Position][]; markets: Market[] }) {
  const byId = new Map(markets.map((m) => [m.id, m]));
  let value = 0;
  let spent = 0;
  let claimable = 0;
  for (const [id, p] of positions) {
    const m = byId.get(id);
    if (!m) continue;
    const y = Number(BigInt(p.yes)) / Number(ONE);
    const n = Number(BigInt(p.no)) / Number(ONE);
    spent += Number(BigInt(p.spent)) / Number(ONE) - Number(BigInt(p.received)) / Number(ONE);
    if (m.resolution && !p.claimed) {
      const pay = m.resolution === 'Yes' ? y : m.resolution === 'No' ? n : (y + n) / 2;
      claimable += pay;
      value += pay;
    } else if (!m.resolution) value += y * m.price_yes + n * m.price_no;
  }
  return (
    <div className="card portfolio">
      <div>
        <div className="label">Your positions</div>
        <div className="mono big-s">{positions.length} markets</div>
      </div>
      <div>
        <div className="label">Marked value</div>
        <div className="mono big-s">{value.toFixed(2)} {SYMBOL}</div>
      </div>
      <div>
        <div className="label">Net cost</div>
        <div className="mono big-s">{spent.toFixed(2)} {SYMBOL}</div>
      </div>
      <div>
        <div className="label">Claimable</div>
        <div className={`mono big-s ${claimable > 0 ? 'yes' : ''}`}>{claimable.toFixed(2)} {SYMBOL}</div>
      </div>
    </div>
  );
}
