import { useEffect, useState } from 'react';
import { isWindowed, parseSource, type Source } from '../../shared/metrics.ts';
import {
  CMP_TEXT,
  CONTRACT_ID,
  EXPLORER,
  fmtMetric,
  fmtMetricNum,
  fmtAmt,
  metricNumber,
  ONE,
  SYMBOL,
  NET,
  getHistory,
  getMarket,
  parseUnits,
  quoteBuy,
  quoteSell,
  view,
  type BuyQuote,
  type Market,
  type Outcome,
  type Position,
} from '../../shared/near.ts';
import { useApp } from './App.tsx';
import { LineChart } from './charts.tsx';
import { betMsg, chainName, placeholderAddress, quoteBet, SIMULATED, type QuoteResponse } from './intents.ts';
import { useMetric } from './metric.ts';
import { ClaimOut, connectPhantom, EXCLUDE, IntentsCheckout, phantom, TokenPicker, useTokens, type Checkout } from './Pay.tsx';
import { cents, dur, short, statusLine, useNow, usePoll, utc } from './util.ts';

const ETHERSCAN = 'https://etherscan.io';

export function MarketPage({ id }: { id: number }) {
  const { version } = useApp();
  const { data: m, error } = usePoll(() => getMarket(id), [id, version], 8_000);
  const now = useNow(1000);
  if (error) return <div className="card err">Could not load market: {error}</div>;
  if (m === undefined) return <div className="card muted">Loading…</div>;
  if (m === null) return <div className="card err">No market #{id}</div>;
  const st = statusLine(m, now);
  return (
    <>
      <a href="#/" className="back">
        ← All markets
      </a>
      <div className="row gap-s">
        <span className="chip cat">{m.spec.category}</span>
        <span className="chip">{m.spec.protocol}</span>
        <span className="chip ghost">{m.spec.chain}</span>
        <span className="chip ghost">#{String(m.id).padStart(3, '0')}</span>
      </div>
      <h1 className="q">{m.spec.question}</h1>
      <div className="idline">{rawSource(m)}</div>
      <div className={`status ${st.tone}`}>{st.text}</div>

      <div className="layout">
        <div className="col">
          <MetricPanel m={m} now={now} />
          <PricePanel m={m} />
          <SourcePanel m={m} />
          {m.resolution && <ResolutionPanel m={m} />}
        </div>
        <div className="col side">
          <TradePanel m={m} now={now} />
          <PositionPanel m={m} />
          <PoolPanel m={m} />
        </div>
      </div>
    </>
  );
}

/** full raw identifiers of what the market reads */
function rawSource(m: Market): string {
  const src = parseSource(m.spec.source);
  switch (src.kind) {
    case 'evm_log_count':
      return `eth:${src.address} · topic0:${src.topic0}`;
    case 'morpho_market':
    case 'morpho_rate':
      return `eth:${src.morpho} · market:${src.marketId}`;
    case 'erc20_net_mint':
      return `eth:${src.token} · Transfer from/to 0x0`;
    case 'univ3_price':
      return `eth:${src.pool} · Swap.sqrtPriceX96`;
    case 'block_stat':
      return `eth:block headers${src.every ? ` (every ${src.every}th block)` : ''} · ${src.field === 'baseFee' ? 'baseFeePerGas' : 'blobGasUsed / 131072'}`;
  }
}

// ---------- metric ----------

function MetricPanel({ m, now }: { m: Market; now: number }) {
  const metric = useMetric(m);
  const spec = m.spec;
  const start = Number(spec.window_start);
  const end = Number(spec.window_end);
  const threshold = metricNumber(spec.threshold, spec);
  const fmtY = (v: number) => fmtMetricNum(v, spec);
  // axis labels drop long units so they fit the margin (the headline shows the unit)
  const fmtAxis = (v: number) => fmtY(v).replace(/ (USDT|gwei|blobs\/block)$/, '');
  const sampled = metric?.source.kind === 'morpho_market';
  const win = metric ? isWindowed(metric.source) : false;
  const net = metric?.source.kind === 'erc20_net_mint';
  const value = metric?.value != null ? fmtMetric(metric.value, spec) : '—';
  const above = metric?.value != null && compare(metric.value, BigInt(spec.threshold), spec.comparator);

  let headline = 'Measured value';
  if (metric?.phase === 'before') headline = `Window opens in ${dur(start - now)}`;
  else if (sampled && !m.resolution) headline = 'Current value (live)';
  else if (win && !m.resolution && metric?.phase === 'live') headline = net ? 'Net change so far (live)' : 'Average so far (live)';
  else if (!m.resolution && metric?.phase === 'live') headline = 'So far this window';
  else if (m.resolution) headline = sampled ? 'Average of samples (resolved)' : win ? 'Measured value (resolved)' : 'Final count (resolved)';

  const xDomain: [number, number] = sampled && !m.resolution && metric?.series.length ? [Math.min(metric.series[0].t, now - 300), Math.max(now, metric.series[0].t + 600)] : [start, end];

  return (
    <section className="card">
      <div className="panel-head">
        <div>
          <div className="label">{headline}</div>
          <div className="metric-row">
            <span className={`metric ${metric?.value != null ? (above ? 'yes' : 'no') : ''}`}>{metric?.loading && !metric.value ? '…' : value}</span>
            <span className="dim">
              vs {CMP_TEXT[spec.comparator]} {fmtMetric(spec.threshold, spec)}
            </span>
          </div>
          {metric?.projected != null && (
            <div className="dim small">
              Pace projects <b className="mono">{fmtY(metric.projected)}</b> by {utc(end, false)}
            </div>
          )}
          {sampled && metric?.samplesTotal != null && !m.resolution && (
            <div className="dim small">
              {metric.samplesDue}/{metric.samplesTotal} scheduled samples taken by the resolver · the market settles on their average
            </div>
          )}
        </div>
        <div className="right dim small mono">
          {metric?.headBlock != null && (
            <a href={`${ETHERSCAN}/block/${metric.headBlock}`} target="_blank" rel="noreferrer">
              eth block {metric.headBlock.toString()}
            </a>
          )}
          <div>{metric?.loading ? 'updating…' : 'live from Ethereum'}</div>
        </div>
      </div>
      {metric?.error && <div className="err small">RPC: {metric.error.slice(0, 160)}</div>}
      {metric && metric.phase !== 'before' && metric.series.length > 0 ? (
        <LineChart
          points={metric.series}
          xDomain={xDomain}
          threshold={threshold}
          thresholdLabel={`${CMP_TEXT[spec.comparator]} ${fmtAxis(threshold)}`}
          projected={metric.projected}
          step={!sampled && !win}
          dots={sampled}
          fmtY={fmtY}
          fmtAxis={fmtAxis}
          now={now}
          color={above ? 'var(--yes)' : 'var(--no)'}
        />
      ) : (
        <div className="chart-empty">
          {metric?.phase === 'before'
            ? `Measurement starts ${utc(start)}. Trading is open now.`
            : 'Reading the chain…'}
        </div>
      )}
    </section>
  );
}

function compare(v: bigint, t: bigint, c: Market['spec']['comparator']) {
  return { Gt: v > t, Gte: v >= t, Lt: v < t, Lte: v <= t }[c];
}

// ---------- price ----------

function PricePanel({ m }: { m: Market }) {
  const { version } = useApp();
  const { data: hist } = usePoll(() => getHistory(m.id), [m.id, m.trades, m.resolution, version], 0);
  const now = Math.floor(Date.now() / 1000);
  const pts = (hist ?? []).map((p) => ({ t: Number(p.t), v: p.p / 1e6 }));
  if (pts.length && !m.resolution) pts.push({ t: now, v: m.price_yes });
  const x0 = pts[0]?.t ?? Number(m.created_at);
  const x1 = m.resolution ? Math.max(Number(m.resolved_at), x0 + 60) : Math.max(now, x0 + 60);
  return (
    <section className="card">
      <div className="panel-head">
        <div>
          <div className="label">Chance of YES</div>
          <div className="metric-row">
            <span className="metric yes">{(m.price_yes * 100).toFixed(1)}%</span>
            <span className="dim small">{m.trades} trades</span>
          </div>
        </div>
      </div>
      <LineChart points={pts} xDomain={[x0, x1]} yDomain={[0, 1]} step fmtY={(v) => `${Math.round(v * 100)}%`} height={160} color="var(--yes)" />
    </section>
  );
}

// ---------- source ----------

function SourcePanel({ m }: { m: Market }) {
  const src = parseSource(m.spec.source);
  return (
    <section className="card">
      <div className="label">How this market resolves</div>
      <p className="rule-text">
        <b>YES</b> if <span className="mono">{m.spec.metric}</span> is{' '}
        <b className="mono">
          {CMP_TEXT[m.spec.comparator]} {fmtMetric(m.spec.threshold, m.spec)}
        </b>{' '}
        over {utc(m.spec.window_start)} → {utc(m.spec.window_end, false)}. Otherwise <b>NO</b>. The resolver only reports the number; the
        contract applies the rule.
      </p>
      <dl className="kv">
        <dt>Chain</dt>
        <dd>Ethereum mainnet</dd>
        <SourceRows src={src} />
        <dt>Trading</dt>
        <dd>closes {utc(m.spec.close_time)}</dd>
      </dl>
    </section>
  );
}

function SourceRows({ src }: { src: Source }) {
  const addr = (a: string, label: string, tab = '') => (
    <a href={`${ETHERSCAN}/address/${a}${tab}`} target="_blank" rel="noreferrer" className="mono">
      {label} · {short(a)}
    </a>
  );
  const everyBlock = 'averaged over every block in the window; computed from logs and headers, so any public RPC can recompute it later';
  switch (src.kind) {
    case 'evm_log_count':
      return (
        <>
          <dt>Contract</dt>
          <dd>{addr(src.address, src.label, '#events')}</dd>
          <dt>Event</dt>
          <dd className="mono">{src.event}</dd>
          <dt>topic0</dt>
          <dd className="mono">{short(src.topic0, 10)}</dd>
          <dt>Measure</dt>
          <dd>count of matching logs in blocks whose timestamp falls inside the window</dd>
        </>
      );
    case 'morpho_market':
      return (
        <>
          <dt>Contract</dt>
          <dd>{addr(src.morpho, 'Morpho Blue', '#readContract')}</dd>
          <dt>Market</dt>
          <dd>
            <a href={`https://app.morpho.org/ethereum/market/${src.marketId}`} target="_blank" rel="noreferrer" className="mono">
              {src.label} · {short(src.marketId, 8)}
            </a>
          </dd>
          <dt>Read</dt>
          <dd className="mono">market(id).{src.field === 'utilization' ? 'totalBorrowAssets / totalSupplyAssets' : 'totalBorrowAssets'}</dd>
          <dt>Sampling</dt>
          <dd>
            every {src.sampleEverySec / 60} min at the first block on or after each mark, averaged (a time-weighted average makes the number
            expensive to push)
          </dd>
        </>
      );
    case 'erc20_net_mint':
      return (
        <>
          <dt>Token</dt>
          <dd>{addr(src.token, src.label, '#events')}</dd>
          <dt>Event</dt>
          <dd className="mono">Transfer(from, to, value)</dd>
          <dt>Measure</dt>
          <dd>sum of transfers from 0x0 (minted) minus sum of transfers to 0x0 (burned), over the window's blocks</dd>
        </>
      );
    case 'univ3_price':
      return (
        <>
          <dt>Pool</dt>
          <dd>{addr(src.pool, src.label, '#events')}</dd>
          <dt>Read</dt>
          <dd className="mono">Swap.sqrtPriceX96 → price of {src.base} in {src.quote}</dd>
          <dt>Measure</dt>
          <dd>each block's closing pool price, {everyBlock}</dd>
        </>
      );
    case 'morpho_rate':
      return (
        <>
          <dt>Contract</dt>
          <dd>{addr(src.morpho, 'Morpho Blue', '#events')}</dd>
          <dt>Market</dt>
          <dd>
            <a href={`https://app.morpho.org/ethereum/market/${src.marketId}`} target="_blank" rel="noreferrer" className="mono">
              {src.label} · {short(src.marketId, 8)}
            </a>
          </dd>
          <dt>Read</dt>
          <dd className="mono">AccrueInterest.prevBorrowRate × seconds per year</dd>
          <dt>Measure</dt>
          <dd>the borrow rate in effect at each block, {everyBlock}</dd>
        </>
      );
    case 'block_stat':
      return (
        <>
          <dt>Read</dt>
          <dd className="mono">{src.field === 'baseFee' ? 'block.baseFeePerGas' : 'block.blobGasUsed / 131072 (one blob = 128 KiB)'}</dd>
          <dt>Measure</dt>
          <dd>
            {src.every
              ? `the average over the window's blocks whose number is a multiple of ${src.every} (about one every ${Math.round((src.every * 12) / 60)} min); computed from headers, so any public RPC can recompute it later`
              : everyBlock}
          </dd>
        </>
      );
  }
}

function ResolutionPanel({ m }: { m: Market }) {
  let ev: any = null;
  try {
    ev = JSON.parse(m.evidence ?? '');
  } catch {
    // free-text reason (void)
  }
  return (
    <section className="card">
      <div className="label">Resolution evidence (stored on NEAR)</div>
      <div className="metric-row">
        <span className={`badge ${m.resolution === 'Yes' ? 'yes' : m.resolution === 'No' ? 'no' : 'void'}`}>{m.resolution?.toUpperCase()}</span>
        {m.resolved_value && <span className="dim">measured {fmtMetric(m.resolved_value, m.spec)}</span>}
      </div>
      {ev?.kind === 'evm_log_count' && (
        <dl className="kv">
          <dt>Blocks</dt>
          <dd className="mono">
            <a href={`${ETHERSCAN}/block/${ev.from.n}`} target="_blank" rel="noreferrer">
              {ev.from.n}
            </a>{' '}
            →{' '}
            <a href={`${ETHERSCAN}/block/${ev.to.n}`} target="_blank" rel="noreferrer">
              {ev.to.n}
            </a>
          </dd>
          <dt>Logs</dt>
          <dd className="mono">{ev.count}</dd>
          <dt>Data hash</dt>
          <dd className="mono">{short(ev.dataHash, 12)}</dd>
        </dl>
      )}
      {ev && ['erc20_net_mint', 'univ3_price', 'morpho_rate', 'block_stat'].includes(ev.kind) && (
        <dl className="kv">
          <dt>Blocks</dt>
          <dd className="mono">
            <a href={`${ETHERSCAN}/block/${ev.from.n}`} target="_blank" rel="noreferrer">
              {ev.from.n}
            </a>{' '}
            →{' '}
            <a href={`${ETHERSCAN}/block/${ev.to.n}`} target="_blank" rel="noreferrer">
              {ev.to.n}
            </a>
          </dd>
          {ev.kind === 'erc20_net_mint' && (
            <>
              <dt>Minted</dt>
              <dd className="mono">
                {fmtMetricNum(Number(ev.minted) / 1e6, { decimals: 6, unit: 'USDC' })} in {ev.mints} transfers
              </dd>
              <dt>Burned</dt>
              <dd className="mono">
                {fmtMetricNum(Number(ev.burned) / 1e6, { decimals: 6, unit: 'USDC' })} in {ev.burns} transfers
              </dd>
            </>
          )}
          {ev.kind === 'univ3_price' && (
            <>
              <dt>Swaps</dt>
              <dd className="mono">
                {ev.swaps} in the window, opening price from block {ev.openingBlock}
              </dd>
            </>
          )}
          {ev.kind === 'morpho_rate' && (
            <>
              <dt>Accruals</dt>
              <dd className="mono">
                {ev.accruals} in the window, last blocks priced by block {ev.nextBlock}
              </dd>
            </>
          )}
          {ev.kind === 'block_stat' && (
            <>
              <dt>Blocks read</dt>
              <dd className="mono">{ev.blocks}</dd>
            </>
          )}
          {ev.dataHash && (
            <>
              <dt>Data hash</dt>
              <dd className="mono">{short(ev.dataHash, 12)}</dd>
            </>
          )}
        </dl>
      )}
      {ev?.kind === 'morpho_market' && (
        <dl className="kv">
          <dt>Samples</dt>
          <dd className="mono">
            {ev.samples.length}/{ev.expected} at blocks {ev.samples[0]?.[1]} … {ev.samples[ev.samples.length - 1]?.[1]}
          </dd>
          <dt>Average</dt>
          <dd className="mono">{fmtMetric(ev.value, m.spec)}</dd>
        </dl>
      )}
      {!ev && m.evidence && <p className="dim">{m.evidence}</p>}
      <div className="code">npm run verify -- {m.id}</div>
      <div className="dim small">Recomputes the result from Ethereum and checks it against this evidence.</div>
    </section>
  );
}

// ---------- trading ----------

const NATIVE = 'native';
const NATIVE_QUICK = ['0.1', '0.5', '1', '2'];
const USD_QUICK = [1, 5, 10, 25];

/** A decimal string for `usd` worth of a token, with about 3 significant digits. */
function usdToAmount(usd: number, price: number): string {
  const x = usd / price;
  return x >= 1000 ? Math.round(x).toString() : Number(x.toPrecision(3)).toString();
}

function TradePanel({ m, now }: { m: Market; now: number }) {
  const { session, connectDemo, connectWallet, connecting, toast, bump } = useApp();
  const tokens = useTokens();
  const [side, setSide] = useState<Outcome>('Yes');
  const [payWith, setPayWith] = useState(NATIVE);
  const [amount, setAmount] = useState('1');
  const [refundTo, setRefundTo] = useState('');
  const [quoted, setQuoted] = useState<{ key: string; q: BuyQuote } | null>(null);
  const [swap, setSwap] = useState<{ key: string; q?: QuoteResponse; err?: string } | null>(null);
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [busy, setBusy] = useState(false);
  const open = !m.resolution && now < Number(m.spec.close_time);

  const token = payWith === NATIVE ? null : (tokens.find((t) => t.assetId === payWith) ?? null);
  const viaIntents = payWith !== NATIVE;
  const paySymbol = token?.symbol ?? SYMBOL;
  const nativeLabel = NET.token ? `${SYMBOL} on NEAR` : 'NEAR';

  // what the user types, in the token they pay with
  let amountIn = 0n;
  try {
    amountIn = parseUnits(amount || '0', token ? token.decimals : NET.decimals);
  } catch {
    amountIn = 0n;
  }

  // paying with another token: a dry 1Click quote turns it into the bet size (collateral)
  const swapKey = `${payWith}:${amountIn}`;
  const swapQuote = viaIntents && swap?.key === swapKey ? swap : null;
  useEffect(() => {
    if (!viaIntents || !token || amountIn <= 0n || !open) return;
    const t = setTimeout(() => {
      quoteBet({ origin: token, amountIn, account: session?.accountId ?? 'intents.near', marketId: m.id, outcome: side, minShares: 0n, refundTo: placeholderAddress(token), dry: true })
        .then((q) => setSwap({ key: swapKey, q }))
        .catch((e) => setSwap({ key: swapKey, err: (e as Error).message }));
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swapKey, open]);

  const betUnits = viaIntents ? (swapQuote?.q ? BigInt(swapQuote.q.quote.amountOut) : 0n) : amountIn;

  // a share quote is only usable for the exact side, bet size and pool state it was computed for
  const key = `${m.id}:${side}:${betUnits}:${m.trades}`;
  const quote = quoted?.key === key ? quoted.q : null;
  useEffect(() => {
    if (!open || betUnits <= 0n) return setQuoted(null);
    const t = setTimeout(
      () =>
        quoteBuy(m.id, side, betUnits)
          .then((q) => setQuoted({ key, q }))
          .catch(() => setQuoted(null)),
      200,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, open]);

  const shares = quote ? Number(BigInt(quote.shares)) / Number(ONE) : 0;
  const spend = Number(betUnits) / Number(ONE);
  const tooSmall = betUnits < ONE / 100n;

  function choosePay(v: string) {
    setPayWith(v);
    setSwap(null);
    if (v === NATIVE) return setAmount('1');
    const t = tokens.find((x) => x.assetId === v);
    setAmount(t?.price ? usdToAmount(5, t.price) : '');
  }

  async function buyDirect() {
    if (!session || !quote) return;
    setBusy(true);
    try {
      const min = (BigInt(quote.shares) * 98n) / 100n;
      if (NET.token) {
        // token collateral: transfer USDC to the contract with the bet as the message
        const r = await session.send({
          receiverId: NET.token,
          methodName: 'ft_transfer_call',
          args: { receiver_id: CONTRACT_ID, amount: betUnits.toString(), msg: betMsg(session.accountId, m.id, side, min) },
          deposit: 1n,
          gas: 150_000_000_000_000n,
        });
        toast({ text: `Bet ${spend} ${SYMBOL} on ${side.toUpperCase()}`, tone: 'ok', href: `${EXPLORER}/txns/${r.hash}` });
      } else {
        const r = await session.send({ methodName: 'buy', args: { market_id: m.id, outcome: side, min_shares: min.toString() }, deposit: betUnits });
        const got = r.value ? Number(BigInt(r.value as string)) / Number(ONE) : shares;
        toast({ text: `Bought ${got.toFixed(2)} ${side.toUpperCase()} shares for ${spend} ${SYMBOL}`, tone: 'ok', href: `${EXPLORER}/txns/${r.hash}` });
      }
      bump();
    } catch (e) {
      toast({ text: `Trade failed: ${(e as Error).message}`, tone: 'err' });
    } finally {
      setBusy(false);
    }
  }

  function buy() {
    if (!viaIntents) return buyDirect();
    if (token && quote) setCheckout({ token, amountIn, betUnits, refundTo });
  }

  const sideSeg = (
    <div className="seg">
      <button className={side === 'Yes' ? 'on yes' : ''} onClick={() => setSide('Yes')} disabled={!!checkout}>
        Yes <span className="mono">{cents(m.price_yes)}</span>
      </button>
      <button className={side === 'No' ? 'on no' : ''} onClick={() => setSide('No')} disabled={!!checkout}>
        No <span className="mono">{cents(m.price_no)}</span>
      </button>
    </div>
  );

  if (checkout)
    return (
      <section className="card trade">
        {sideSeg}
        <IntentsCheckout m={m} side={side} c={checkout} onClose={() => setCheckout(null)} />
      </section>
    );

  const needRefund = viaIntents && !SIMULATED;
  const canBuy = !!session && !busy && !!quote && !tooSmall && (!needRefund || !!refundTo);

  return (
    <section className="card trade">
      {sideSeg}

      <label className="label" htmlFor="paywith">
        Pay with
      </label>
      <div className="paywith-row">
        <TokenPicker
          id="paywith"
          tokens={tokens}
          value={payWith}
          onChange={choosePay}
          exclude={EXCLUDE}
          extra={{ value: NATIVE, label: `${nativeLabel} · from your NEAR wallet` }}
        />
        <span className={`via mono ${viaIntents ? 'on' : ''}`}>{viaIntents ? 'via Intents' : 'direct'}</span>
      </div>

      <label className="label" htmlFor="amt">
        You pay
      </label>
      <div className="amount">
        <input id="amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} disabled={!open} />
        <span className="unit">
          {paySymbol}
          {token && <small> on {chainName(token.blockchain)}</small>}
        </span>
      </div>
      <div className="row gap-s quick">
        {token
          ? USD_QUICK.map((usd) => (
              <button key={usd} className="btn tiny" onClick={() => setAmount(usdToAmount(usd, token.price))} disabled={!open || !token.price}>
                ${usd}
              </button>
            ))
          : NATIVE_QUICK.map((a) => (
              <button key={a} className="btn tiny" onClick={() => setAmount(a)} disabled={!open}>
                {a}
              </button>
            ))}
      </div>

      {open && viaIntents && swapQuote?.err && <div className="err small">{swapQuote.err}</div>}
      {open && viaIntents && amountIn > 0n && !swapQuote && <div className="dim small">Quoting the swap…</div>}

      {quote && open && (
        <dl className="kv quote">
          {viaIntents && swapQuote?.q && (
            <>
              <dt>Swap</dt>
              <dd className="mono">
                {amount} {paySymbol} → {fmtAmt(betUnits)} {SYMBOL}
              </dd>
              <dt>Bet</dt>
              <dd className="mono">
                {fmtAmt(betUnits)} {SYMBOL} on {side.toUpperCase()}
              </dd>
            </>
          )}
          <dt>Shares</dt>
          <dd className="mono">{shares.toFixed(3)}</dd>
          <dt>Avg price</dt>
          <dd className="mono">{cents(quote.avg_price)}</dd>
          <dt>Price after</dt>
          <dd className="mono">
            {cents(quote.price_before)} → {cents(quote.price_after)}
          </dd>
          <dt>Payout if {side.toUpperCase()}</dt>
          <dd className="mono yes">
            {shares.toFixed(2)} {SYMBOL} <span className="dim">(+{spend > 0 ? (((shares - spend) / spend) * 100).toFixed(0) : 0}%)</span>
          </dd>
        </dl>
      )}

      {open && needRefund && token && session && (
        <>
          <label className="label" htmlFor="refund">
            Your {chainName(token.blockchain)} address (refunds)
          </label>
          <div className="row gap-s">
            <input id="refund" className="text mono grow" value={refundTo} onChange={(e) => setRefundTo(e.target.value.trim())} placeholder="address" />
            {token.blockchain === 'sol' && phantom() && (
              <button className="btn tiny" onClick={() => connectPhantom().then(setRefundTo).catch(() => {})}>
                Phantom
              </button>
            )}
          </div>
        </>
      )}

      {!open ? (
        <button className="btn block" disabled>
          {m.resolution ? 'Market resolved' : 'Trading closed'}
        </button>
      ) : session ? (
        <button className={`btn block ${side === 'Yes' ? 'yes-bg' : 'no-bg'}`} disabled={!canBuy} onClick={buy}>
          {busy ? 'Confirming…' : `Buy ${side.toUpperCase()} with ${paySymbol}`}
          {viaIntents && SIMULATED && !busy && <span className="pill sim btn-pill">sim</span>}
        </button>
      ) : (
        <div className="stack">
          {NET.id === 'testnet' && (
            <button className="btn block primary" disabled={connecting} onClick={connectDemo}>
              {connecting ? 'Creating demo wallet…' : 'Try with a demo wallet'}
            </button>
          )}
          <button className="btn block ghost" disabled={connecting} onClick={connectWallet}>
            Connect a NEAR wallet
          </button>
        </div>
      )}

      {viaIntents ? (
        SIMULATED ? (
          <div className="simnote small">
            <b>Testnet preview.</b> NEAR Intents has no testnet. The swap quote is live from 1Click mainnet; the swap is simulated and the bet is placed on
            testnet in NEAR.
          </div>
        ) : (
          <div className="dim small">
            NEAR Intents swaps your {paySymbol} to {SYMBOL} and delivers it into the market as your bet. Each winning share pays 1 {SYMBOL}.
          </div>
        )
      ) : (
        <div className="dim small">
          Each winning share pays 1 {SYMBOL}. Minimum 0.01 {SYMBOL}.
        </div>
      )}
    </section>
  );
}

function PositionPanel({ m }: { m: Market }) {
  const { session, version, toast, bump } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const { data: pos } = usePoll(
    () => (session ? view<Position | null>('get_position', { market_id: m.id, account_id: session.accountId }) : Promise.resolve(null)),
    [session?.accountId, m.id, version, m.trades],
    0,
  );
  if (!session || !pos) return null;
  const yes = BigInt(pos.yes);
  const no = BigInt(pos.no);
  if (yes === 0n && no === 0n && !pos.claimed) return null;
  const open = m.status === 'open';
  const payout = m.resolution === 'Yes' ? yes : m.resolution === 'No' ? no : m.resolution === 'Invalid' ? (yes + no) / 2n : 0n;

  async function sell(outcome: Outcome, shares: bigint) {
    setBusy(outcome);
    try {
      const q = await quoteSell(m.id, outcome, shares);
      const min = (BigInt(q.payout) * 98n) / 100n;
      const r = await session!.send({ methodName: 'sell', args: { market_id: m.id, outcome, shares: shares.toString(), min_payout: min.toString() } });
      toast({ text: `Sold ${outcome.toUpperCase()} for ${fmtAmt((r.value as string) ?? q.payout, 3)} ${SYMBOL}`, tone: 'ok', href: `${EXPLORER}/txns/${r.hash}` });
      bump();
    } catch (e) {
      toast({ text: `Sell failed: ${(e as Error).message}`, tone: 'err' });
    } finally {
      setBusy(null);
    }
  }
  async function claim() {
    setBusy('claim');
    try {
      const r = await session!.send({ methodName: 'claim', args: { market_id: m.id } });
      toast({ text: `Claimed ${fmtAmt((r.value as string) ?? payout.toString(), 3)} ${SYMBOL}`, tone: 'ok', href: `${EXPLORER}/txns/${r.hash}` });
      bump();
    } catch (e) {
      toast({ text: `Claim failed: ${(e as Error).message}`, tone: 'err' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card">
      <div className="label">Your position</div>
      <dl className="kv">
        {yes > 0n && (
          <>
            <dt>
              <span className="yes">YES</span> shares
            </dt>
            <dd className="mono">
              {fmtAmt(yes, 3)} <span className="dim">≈ {(Number(yes) / Number(ONE) * m.price_yes).toFixed(2)} {SYMBOL}</span>
            </dd>
          </>
        )}
        {no > 0n && (
          <>
            <dt>
              <span className="no">NO</span> shares
            </dt>
            <dd className="mono">
              {fmtAmt(no, 3)} <span className="dim">≈ {(Number(no) / Number(ONE) * m.price_no).toFixed(2)} {SYMBOL}</span>
            </dd>
          </>
        )}
        <dt>Spent / received</dt>
        <dd className="mono">
          {fmtAmt(pos.spent, 2)} / {fmtAmt(pos.received, 2)} {SYMBOL}
        </dd>
      </dl>
      {open && (
        <div className="row gap-s">
          {yes > 0n && (
            <button className="btn small ghost" disabled={!!busy} onClick={() => sell('Yes', yes)}>
              {busy === 'Yes' ? 'Selling…' : 'Sell all YES'}
            </button>
          )}
          {no > 0n && (
            <button className="btn small ghost" disabled={!!busy} onClick={() => sell('No', no)}>
              {busy === 'No' ? 'Selling…' : 'Sell all NO'}
            </button>
          )}
        </div>
      )}
      {m.resolution &&
        (pos.claimed ? (
          <div className="dim">Claimed.</div>
        ) : (
          <ClaimOut m={m} payout={payout} onPlainClaim={claim} busy={!!busy} />
        ))}
    </section>
  );
}

function PoolPanel({ m }: { m: Market }) {
  const b = Number(BigInt(m.b)) / Number(ONE);
  return (
    <section className="card">
      <div className="label">Market maker (LMSR)</div>
      <dl className="kv">
        <dt>Liquidity b</dt>
        <dd className="mono">
          {b.toLocaleString('en-US', { maximumFractionDigits: 4 })} {SYMBOL}
        </dd>
        <dt>Pool</dt>
        <dd className="mono">{fmtAmt(m.pool)} {SYMBOL}</dd>
        <dt>Outstanding</dt>
        <dd className="mono">
          <span className="yes">{fmtAmt(m.q_yes, 1)}</span> / <span className="no">{fmtAmt(m.q_no, 1)}</span>
        </dd>
        <dt>Volume</dt>
        <dd className="mono">{fmtAmt(m.volume)} {SYMBOL}</dd>
        <dt>Max MM loss</dt>
        <dd className="mono">{(b * Math.LN2).toFixed(3)} {SYMBOL}</dd>
      </dl>
    </section>
  );
}
