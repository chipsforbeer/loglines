// Cross-chain payment and payout through NEAR Intents.
//
// Mainnet: real 1Click swaps. A bet paid in SOL is swapped to USDC and delivered into the contract
// with the bet message; winnings are claimed straight into a 1Click deposit address.
// Testnet (SIMULATED): real 1Click quotes, real testnet bet/claim; the swap in between is simulated.

import QRCode from 'qrcode';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { EXPLORER, fmtAmt, NET, quoteBuy, SYMBOL, type Market, type Outcome } from '../../shared/near.ts';
import { useApp } from './App.tsx';
import {
  chainName,
  DONE,
  FEATURED,
  getTokens,
  paymentUri,
  placeholderAddress,
  quoteBet,
  quotePayout,
  SIMULATED,
  swapStatus,
  type QuoteResponse,
  type StatusResponse,
  type SwapStatus,
  type Token,
} from './intents.ts';
import { connectPhantom, phantom, sendWithPhantom } from './phantom.ts';
export { connectPhantom, phantom };
import { short } from './util.ts';

const STATUS_TEXT: Record<string, string> = {
  PENDING_DEPOSIT: 'Waiting for your deposit',
  KNOWN_DEPOSIT_TX: 'Deposit seen, waiting for confirmations',
  INCOMPLETE_DEPOSIT: 'Deposit is less than required',
  PROCESSING: 'Swapping through NEAR Intents',
  SUCCESS: 'Done',
  REFUNDED: 'Refunded',
  FAILED: 'Failed',
};

export function useTokens() {
  const [tokens, setTokens] = useState<Token[]>([]);
  useEffect(() => {
    getTokens().then(setTokens).catch(() => setTokens([]));
  }, []);
  return tokens;
}

/** Token select: featured first, then every supported token grouped by chain. */
export function TokenPicker({
  id,
  tokens,
  value,
  onChange,
  exclude,
  extra,
}: {
  id?: string;
  tokens: Token[];
  value: string;
  onChange(v: string): void;
  exclude?: string | null;
  extra?: { value: string; label: string };
}) {
  const featured = FEATURED.map((f) => tokens.find((t) => t.blockchain === f.chain && t.symbol === f.symbol)).filter(
    (t): t is Token => !!t && t.assetId !== exclude,
  );
  const byChain = useMemo(() => {
    const m = new Map<string, Token[]>();
    for (const t of tokens) {
      if (t.assetId === exclude) continue;
      m.set(t.blockchain, [...(m.get(t.blockchain) ?? []), t]);
    }
    return [...m.entries()].sort((a, b) => chainName(a[0]).localeCompare(chainName(b[0])));
  }, [tokens, exclude]);
  return (
    <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      {extra && <option value={extra.value}>{extra.label}</option>}
      {!tokens.length && !extra && <option value={value}>Loading tokens…</option>}
      {featured.length > 0 && (
        <optgroup label="Popular">
          {featured.map((t) => (
            <option key={`f-${t.assetId}`} value={t.assetId}>
              {t.symbol} on {chainName(t.blockchain)}
            </option>
          ))}
        </optgroup>
      )}
      {byChain.map(([chain, ts]) => (
        <optgroup key={chain} label={chainName(chain)}>
          {[...ts]
            .sort((a, b) => a.symbol.localeCompare(b.symbol))
            .map((t) => (
              <option key={t.assetId} value={t.assetId}>
                {t.symbol} on {chainName(chain)}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}

function Qr({ text }: { text: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    QRCode.toDataURL(text, { margin: 1, width: 168, color: { dark: '#0a0a0a', light: '#ffffff' } })
      .then(setSrc)
      .catch(() => setSrc(''));
  }, [text]);
  return src ? <img className="qr" src={src} alt="Deposit QR code" width={168} height={168} /> : null;
}

/** Poll 1Click for the swap's status until it is final. */
function useSwapStatus(depositAddress: string | undefined, memo: string | undefined, onFinal?: (s: StatusResponse) => void) {
  const [st, setSt] = useState<StatusResponse | null>(null);
  useEffect(() => {
    if (!depositAddress) return setSt(null);
    let stop = false;
    let id: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const s = await swapStatus(depositAddress, memo);
        if (stop) return;
        setSt(s);
        if (DONE.includes(s.status)) return onFinal?.(s);
      } catch {
        // keep polling
      }
      if (!stop) id = setTimeout(tick, 4000);
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depositAddress, memo]);
  return st;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const status = (s: SwapStatus): StatusResponse => ({ status: s, updatedAt: new Date().toISOString() });

function StatusBox({ st, label, simulated, tx }: { st: StatusResponse | null; label: string; simulated?: boolean; tx?: string }) {
  const s = st?.status ?? 'PENDING_DEPOSIT';
  const d = st?.swapDetails;
  const tone = s === 'SUCCESS' ? 'ok' : s === 'REFUNDED' || s === 'FAILED' || s === 'INCOMPLETE_DEPOSIT' ? 'bad' : 'run';
  return (
    <div className={`swapstatus ${tone}`}>
      <div className="row gap">
        {tone === 'run' && <span className="spinner" />}
        <b>{s === 'SUCCESS' ? label : (STATUS_TEXT[s] ?? s)}</b>
        {simulated && <span className="pill sim">simulated</span>}
      </div>
      {d?.originChainTxHashes?.map((h) => (
        <a key={h.hash} href={h.explorerUrl} target="_blank" rel="noreferrer" className="mono small">
          origin tx {short(h.hash, 6)} ↗
        </a>
      ))}
      {d?.nearTxHashes?.slice(-1).map((h) => (
        <a key={h} href={`${EXPLORER}/txns/${h}`} target="_blank" rel="noreferrer" className="mono small">
          NEAR tx {short(h, 6)} ↗
        </a>
      ))}
      {d?.destinationChainTxHashes?.map((h) => (
        <a key={h.hash} href={h.explorerUrl} target="_blank" rel="noreferrer" className="mono small">
          destination tx {short(h.hash, 6)} ↗
        </a>
      ))}
      {tx && (
        <a href={`${EXPLORER}/txns/${tx}`} target="_blank" rel="noreferrer" className="mono small">
          {NET.id} tx {short(tx, 6)} ↗ (real)
        </a>
      )}
      {d?.refundReason && <div className="small">Refund: {d.refundReason}</div>}
    </div>
  );
}

const SimNote = ({ children }: { children: ReactNode }) => (
  <div className="simnote small">
    <b>Testnet preview.</b> {children}
  </div>
);

export const EXCLUDE = NET.tokenAsset ?? 'nep141:wrap.near';

// ---------- pay for a bet with any token ----------

export type Checkout = {
  token: Token;
  /** origin base units */
  amountIn: bigint;
  /** dry-quoted collateral the swap delivers, i.e. the bet size */
  betUnits: bigint;
  /** origin-chain address for refunds (mainnet) */
  refundTo: string;
};

/** After "Buy": the deposit address and swap status (mainnet), or the labeled simulation (testnet). */
export function IntentsCheckout({ m, side, c, onClose }: { m: Market; side: Outcome; c: Checkout; onClose(): void }) {
  const { session, toast, bump } = useApp();
  const [real, setReal] = useState<QuoteResponse | null>(null);
  const [sim, setSim] = useState<{ st: StatusResponse; tx?: string } | null>(null);
  const [err, setErr] = useState('');
  const bet = `${side.toUpperCase()} ${fmtAmt(c.betUnits)} ${SYMBOL}`;
  const paid = `${fmtUnits(c.amountIn, c.token.decimals)} ${c.token.symbol}`;

  useEffect(() => {
    if (!session) return;
    let stop = false;
    (async () => {
      try {
        if (SIMULATED) {
          // walk through the swap states, then place the bet as a real testnet transaction
          setSim({ st: status('PENDING_DEPOSIT') });
          await wait(1200);
          if (stop) return;
          setSim({ st: status('KNOWN_DEPOSIT_TX') });
          await wait(1200);
          if (stop) return;
          setSim({ st: status('PROCESSING') });
          const q = await quoteBuy(m.id, side, c.betUnits);
          const r = await session.send({
            methodName: 'buy',
            args: { market_id: m.id, outcome: side, min_shares: ((BigInt(q.shares) * 98n) / 100n).toString() },
            deposit: c.betUnits,
          });
          setSim({ st: status('SUCCESS'), tx: r.hash });
          toast({ text: `Bet placed: ${bet}, paid with ${paid} (swap simulated)`, tone: 'ok', href: `${EXPLORER}/txns/${r.hash}` });
          bump();
        } else {
          // the bet must still buy 97% of the shares the worst-case swap output buys today when
          // the swap lands; otherwise the contract refunds the USDC to the bettor's NEAR account
          const dry = await quoteBet({ origin: c.token, amountIn: c.amountIn, account: session.accountId, marketId: m.id, outcome: side, minShares: 0n, refundTo: c.refundTo, dry: true });
          const worst = BigInt(dry.quote.minAmountOut);
          const q = await quoteBuy(m.id, side, worst);
          const minShares = (BigInt(q.shares) * 97n) / 100n;
          const r = await quoteBet({ origin: c.token, amountIn: c.amountIn, account: session.accountId, marketId: m.id, outcome: side, minShares, refundTo: c.refundTo, dry: false });
          if (!r.quote.depositAddress) throw new Error('no deposit address in quote');
          if (!stop) setReal(r);
        }
      } catch (e) {
        if (stop) return;
        setErr((e as Error).message);
        setSim((s) => (s ? { st: status('FAILED') } : s));
        toast({ text: `${SIMULATED ? 'Bet' : 'NEAR Intents'} failed: ${(e as Error).message}`, tone: 'err' });
      }
    })();
    return () => {
      stop = true;
    };
    // run once per checkout
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const st = useSwapStatus(real?.quote.depositAddress, real?.quote.depositMemo, (s) => {
    if (s.status === 'SUCCESS') toast({ text: `Bet placed: ${bet} via NEAR Intents`, tone: 'ok' });
    else toast({ text: `Swap ${s.status.toLowerCase()}`, tone: 'err' });
    bump();
  });

  async function payPhantom() {
    if (!real) return;
    try {
      const sig = await sendWithPhantom(c.token, real.quote.depositAddress!, real.quote.amountIn);
      toast({ text: 'Deposit sent from Phantom', tone: 'ok', href: `https://solscan.io/tx/${sig}` });
    } catch (e) {
      toast({ text: `Phantom: ${(e as Error).message}`, tone: 'err' });
    }
  }

  const back = (
    <button className="btn block ghost" onClick={onClose}>
      {sim?.st.status === 'SUCCESS' || st?.status === 'SUCCESS' ? 'Place another bet' : 'Back'}
    </button>
  );

  if (SIMULATED)
    return (
      <div className="stack">
        <div className="checkout-head mono small">
          {paid} <span className="dim">→</span> {bet}
        </div>
        <StatusBox st={sim?.st ?? status('PENDING_DEPOSIT')} simulated tx={sim?.tx} label={`Bet placed: ${bet}`} />
        {err && <div className="err small">{err}</div>}
        <SimNote>
          On mainnet you send {paid} to a one-time 1Click deposit address, and NEAR Intents swaps it and delivers it into the contract as this bet. Here the
          bet is a real testnet transaction and the swap is simulated.
        </SimNote>
        {sim && DONE.includes(sim.st.status) && back}
      </div>
    );

  if (!real)
    return (
      <div className="stack">
        {err ? <div className="err small">{err}</div> : <div className="swapstatus run"><div className="row gap"><span className="spinner" /><b>Getting a deposit address…</b></div></div>}
        {err && back}
      </div>
    );

  const q = real.quote;
  const finished = st && DONE.includes(st.status);
  return (
    <div className="stack">
      <div className="deposit">
        <div className="label">Send exactly</div>
        <div className="big-s mono">
          {q.amountInFormatted} {c.token.symbol} <span className="dim small">on {chainName(c.token.blockchain)}</span>
        </div>
        <div className="label">to</div>
        <button className="addr mono" onClick={() => navigator.clipboard?.writeText(q.depositAddress!)} title="Copy">
          {q.depositAddress} ⧉
        </button>
        {q.depositMemo && <div className="mono small">memo: {q.depositMemo}</div>}
        <Qr text={paymentUri(c.token, q.depositAddress!, q.amountIn)} />
        {c.token.blockchain === 'sol' && phantom() && !finished && (
          <button className="btn block primary" onClick={payPhantom}>
            Send with Phantom
          </button>
        )}
        {q.deadline && (
          <div className="dim small">
            Quote valid until {new Date(q.deadline).toISOString().slice(11, 16)} UTC. If the swap fails, your {c.token.symbol} goes back to {short(c.refundTo, 6)}; if
            the bet can't be placed, the {SYMBOL} goes to your NEAR account.
          </div>
        )}
      </div>
      <StatusBox st={st} label={`Bet placed: ${bet}`} />
      {(finished || !st || st.status === 'PENDING_DEPOSIT') && back}
    </div>
  );
}

/** Base units to a short decimal string. */
export function fmtUnits(v: bigint, decimals: number): string {
  const n = Number(v) / 10 ** decimals;
  return n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : n.toPrecision(4).replace(/\.?0+$/, '');
}

// ---------- send winnings to any chain ----------

export function ClaimOut({ m, payout, onPlainClaim, busy }: { m: Market; payout: bigint; onPlainClaim(): void; busy: boolean }) {
  const { session, toast, bump } = useApp();
  const tokens = useTokens();
  const [dest, setDest] = useState('here');
  const [recipient, setRecipient] = useState('');
  const [preview, setPreview] = useState<QuoteResponse | null>(null);
  const [previewErr, setPreviewErr] = useState('');
  const [active, setActive] = useState<QuoteResponse | null>(null);
  const [sim, setSim] = useState<{ st: StatusResponse; tx?: string } | null>(null);
  const [sending, setSending] = useState(false);
  const token = tokens.find((t) => t.assetId === dest);
  const where = chainName(token?.blockchain ?? '');

  useEffect(() => {
    setPreview(null);
    setPreviewErr('');
    if (!token || payout <= 0n || !session) return;
    quotePayout({ dest: token, amount: payout, recipient: placeholderAddress(token), refundTo: session.accountId, dry: true })
      .then(setPreview)
      .catch((e) => setPreviewErr((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dest, payout, token?.assetId]);

  const st = useSwapStatus(active?.quote.depositAddress, active?.quote.depositMemo, (s) => {
    toast({ text: s.status === 'SUCCESS' ? `Winnings delivered as ${token?.symbol} on ${where}` : `Payout swap ${s.status.toLowerCase()}`, tone: s.status === 'SUCCESS' ? 'ok' : 'err' });
  });

  async function claimOut() {
    if (!token || !session) return;
    setSending(true);
    try {
      const q = await quotePayout({ dest: token, amount: payout, recipient, refundTo: session.accountId, dry: false });
      if (!q.quote.depositAddress) throw new Error('no deposit address in quote');
      // the contract sends the winnings straight into the swap
      const r = await session.send({ methodName: 'claim', args: { market_id: m.id, to: q.quote.depositAddress } });
      setActive(q);
      toast({ text: `Claimed ${fmtAmt(payout)} ${SYMBOL} into NEAR Intents`, tone: 'ok', href: `${EXPLORER}/txns/${r.hash}` });
      bump();
    } catch (e) {
      toast({ text: `Claim failed: ${(e as Error).message}`, tone: 'err' });
    } finally {
      setSending(false);
    }
  }

  /** Testnet: claim to this account for real, then walk through the payout swap states. */
  async function simulate() {
    if (!session) return;
    setSending(true);
    try {
      const r = await session.send({ methodName: 'claim', args: { market_id: m.id } });
      setSim({ st: status('PROCESSING'), tx: r.hash });
      await wait(2000);
      setSim({ st: status('SUCCESS'), tx: r.hash });
      toast({ text: `Claimed ${fmtAmt(payout)} ${SYMBOL} (payout swap simulated)`, tone: 'ok', href: `${EXPLORER}/txns/${r.hash}` });
    } catch (e) {
      toast({ text: `Claim failed: ${(e as Error).message}`, tone: 'err' });
    } finally {
      setSending(false);
    }
  }

  if (sim)
    return (
      <div className="stack">
        <StatusBox st={sim.st} simulated tx={sim.tx} label={`Delivered ≈ ${preview?.quote.amountOutFormatted} ${token?.symbol} on ${where}`} />
        <SimNote>
          The claim is a real testnet transaction paid to this account. On mainnet the contract pays the winnings into a 1Click deposit address, and NEAR Intents
          delivers them as {token?.symbol} on {where}.
        </SimNote>
        {sim.st.status === 'SUCCESS' && (
          <button className="btn block ghost" onClick={bump}>
            Done
          </button>
        )}
      </div>
    );
  if (active) return <StatusBox st={st} label={`Delivered ${active.quote.amountOutFormatted} ${token?.symbol} on ${where}`} />;

  return (
    <div className="stack">
      <label className="label">Receive as</label>
      <TokenPicker tokens={tokens} value={dest} onChange={setDest} exclude={EXCLUDE} extra={{ value: 'here', label: `${SYMBOL} on NEAR (this account)` }} />
      {dest === 'here' ? (
        <button className="btn block primary" disabled={busy || payout === 0n} onClick={onPlainClaim}>
          {payout === 0n ? 'Nothing to claim' : busy ? 'Claiming…' : `Claim ${fmtAmt(payout, 3)} ${SYMBOL}`}
        </button>
      ) : (
        <>
          {preview && (
            <dl className="kv quote">
              <dt>You receive</dt>
              <dd className="mono">
                ≈ {preview.quote.amountOutFormatted} {token?.symbol}
              </dd>
              <dt>On</dt>
              <dd className="mono">{where}</dd>
            </dl>
          )}
          {previewErr && <div className="err small">{previewErr}</div>}
          {SIMULATED ? (
            <>
              <button className="btn block primary" disabled={sending || !preview || payout === 0n} onClick={simulate}>
                {sending ? 'Claiming…' : `Claim to ${where} (simulated)`}
              </button>
              <SimNote>The quote is live from 1Click mainnet. The claim is real on testnet; the payout swap is simulated.</SimNote>
            </>
          ) : (
            <>
              <input className="text mono" value={recipient} onChange={(e) => setRecipient(e.target.value.trim())} placeholder={`your ${where} address`} />
              {token?.blockchain === 'sol' && phantom() && (
                <button className="btn tiny" onClick={() => connectPhantom().then(setRecipient).catch(() => {})}>
                  Use Phantom address
                </button>
              )}
              <button className="btn block primary" disabled={sending || !recipient || !preview || payout === 0n} onClick={claimOut}>
                {sending ? 'Claiming…' : `Claim to ${where}`}
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
