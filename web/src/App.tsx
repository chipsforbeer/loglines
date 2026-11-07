import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { collateralBalance, CONTRACT_ID, EXPLORER, fmtAmt, NET, SYMBOL, type NetworkId } from '../../shared/near.ts';
import { Home } from './Home.tsx';
import { MarketPage } from './MarketPage.tsx';
import { Ticker } from './Ticker.tsx';
import { usePoll } from './util.ts';
import { createDemo, forgetDemo, getConnector, restoreDemo, walletSession, type Session } from './wallet.ts';

// ---------- session + toasts ----------

type Toast = { id: number; text: string; href?: string; tone: 'ok' | 'err' | 'info' };

type Ctx = {
  session: Session | null;
  balance: bigint | null;
  connecting: boolean;
  connectWallet(): Promise<void>;
  connectDemo(): Promise<void>;
  signOut(): Promise<void>;
  toast(t: Omit<Toast, 'id'>): void;
  /** bump to refetch chain state after a transaction */
  version: number;
  bump(): void;
};

const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

function useRoute(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => {
      setHash(location.hash);
      window.scrollTo(0, 0);
    };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export function App() {
  const [session, setSession] = useState<Session | null>(() => restoreDemo());
  const [connecting, setConnecting] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const route = useRoute();

  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { ...t, id }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), t.tone === 'err' ? 9000 : 6000);
  }, []);

  // NEAR Connect: restore a connected wallet and follow sign-in/out
  useEffect(() => {
    const c = getConnector();
    const onIn = async (t: { accounts: { accountId: string }[] }) => {
      setSession(await walletSession(t.accounts[0].accountId));
      setConnecting(false);
    };
    const onOut = () => setSession((s) => (s?.kind === 'wallet' ? null : s));
    c.on('wallet:signIn', onIn as never);
    c.on('wallet:signOut', onOut);
    (async () => {
      try {
        const w = await c.wallet();
        const accts = await w.getAccounts();
        if (accts[0] && !restoreDemo()) setSession(await walletSession(accts[0].accountId));
      } catch {
        // not connected
      }
    })();
    return () => {
      c.off?.('wallet:signIn', onIn as never);
      c.off?.('wallet:signOut', onOut);
    };
  }, []);

  const { data: balance } = usePoll(
    () => (session ? collateralBalance(session.accountId).catch(() => 0n) : Promise.resolve(null)),
    [session?.accountId, version],
    15_000,
  );

  const ctx: Ctx = {
    session,
    balance: balance ?? null,
    connecting,
    version,
    bump,
    toast,
    async connectWallet() {
      setConnecting(true);
      try {
        const c = getConnector();
        await c.whenManifestLoaded;
        await c.connect();
      } catch (e) {
        toast({ text: `Wallet: ${(e as Error).message}`, tone: 'err' });
      } finally {
        setConnecting(false);
      }
    },
    async connectDemo() {
      setConnecting(true);
      try {
        const s = await createDemo();
        setSession(s);
        toast({ text: `Demo wallet ready: ${s.accountId} (funded by the testnet faucet)`, tone: 'ok', href: `${EXPLORER}/address/${s.accountId}` });
      } catch (e) {
        toast({ text: `Demo wallet: ${(e as Error).message}`, tone: 'err' });
      } finally {
        setConnecting(false);
      }
    },
    async signOut() {
      if (session?.kind === 'demo') forgetDemo();
      await session?.signOut();
      setSession(null);
    },
  };

  const marketId = /^#\/market\/(\d+)/.exec(route)?.[1];

  return (
    <AppCtx.Provider value={ctx}>
      <Header />
      <main className="wrap">{marketId !== undefined ? <MarketPage id={Number(marketId)} /> : <Home />}</main>
      <footer className="wrap footer">
        <span>
          Contract{' '}
          <a href={`${EXPLORER}/address/${CONTRACT_ID}`} target="_blank" rel="noreferrer">
            {CONTRACT_ID}
          </a>{' '}
          on NEAR {NET.id} · data read live from Ethereum mainnet{NET.id === 'testnet' ? ' · cross-chain payments via NEAR Intents are simulated on testnet' : ' · cross-chain payments via NEAR Intents'}
        </span>
      </footer>
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            <span>{t.text}</span>
            {t.href && (
              <a href={t.href} target="_blank" rel="noreferrer">
                view ↗
              </a>
            )}
          </div>
        ))}
      </div>
    </AppCtx.Provider>
  );
}

function Header() {
  const { session, balance, connecting, connectWallet, connectDemo, signOut } = useApp();
  const [open, setOpen] = useState(false);
  return (
    <div className="top">
    <header className="header">
      <div className="wrap header-row">
        <a href="#/" className="brand">
          <span className="brand-mark">
            <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden>
              <path d="M5 24l7-9 6 5 9-12" stroke="var(--ink)" strokeWidth="4" fill="none" strokeLinecap="square" />
            </svg>
          </span>
          <span>Logline</span>
        </a>
        <NetSwitch />
        <div className="grow" />
        {session ? (
          <div className="acct">
            <button className="btn ghost" onClick={() => setOpen((o) => !o)}>
              <span className="mono">{balance != null ? `${fmtAmt(balance)} ${SYMBOL}` : '…'}</span>
              <span className="acct-id">{session.accountId}</span>
            </button>
            {open && (
              <div className="menu" onMouseLeave={() => setOpen(false)}>
                <div className="menu-note">{session.kind === 'demo' ? 'Demo wallet (key stored in this browser)' : 'Connected wallet'}</div>
                <a href={`${EXPLORER}/address/${session.accountId}`} target="_blank" rel="noreferrer">
                  View on explorer ↗
                </a>
                <button onClick={() => (setOpen(false), signOut())}>{session.kind === 'demo' ? 'Discard demo wallet' : 'Disconnect'}</button>
              </div>
            )}
          </div>
        ) : (
          <div className="row gap">
            {NET.id === 'testnet' && (
              <button className="btn ghost hide-mobile" disabled={connecting} onClick={connectDemo} title="Creates a funded NEAR testnet account in this browser">
                {connecting ? 'Working…' : 'Try a demo wallet'}
              </button>
            )}
            <button className="btn primary" disabled={connecting} onClick={connectWallet}>
              Connect wallet
            </button>
          </div>
        )}
      </div>
    </header>
    <Ticker />
    </div>
  );
}

/** Testnet (NEAR, free demo wallet) or mainnet (USDC, real NEAR Intents). Switching reloads. */
function NetSwitch() {
  const go = (id: NetworkId) => {
    if (id === NET.id) return;
    try {
      localStorage.setItem('logline.net', id);
    } catch {
      // private mode: the query string still carries the choice
    }
    const u = new URL(location.href);
    u.searchParams.set('net', id);
    u.searchParams.delete('contract'); // a custom deployment belongs to one network
    location.href = u.toString();
  };
  return (
    <div className="netswitch" role="group" aria-label="Network">
      {(['testnet', 'mainnet'] as const).map((id) => (
        <button key={id} className={id === NET.id ? 'on' : ''} onClick={() => go(id)} title={id === 'testnet' ? 'NEAR testnet, bets in NEAR' : 'NEAR mainnet, bets in USDC'}>
          {id}
        </button>
      ))}
    </div>
  );
}
