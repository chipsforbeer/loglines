// A live strip of raw Ethereum events from the contracts the markets read.

import { useEffect, useRef, useState } from 'react';
import { numberToHex, toEventSelector, type Hex } from 'viem';
import { ethClient, MORPHO_BLUE, UNI_USDC_WETH_005 } from '../../shared/metrics.ts';

const eth = ethClient();

const MORPHO_EVENTS = [
  'Supply(bytes32,address,address,uint256,uint256)',
  'Withdraw(bytes32,address,address,address,uint256,uint256)',
  'Borrow(bytes32,address,address,address,uint256,uint256)',
  'Repay(bytes32,address,address,uint256,uint256)',
  'SupplyCollateral(bytes32,address,address,uint256)',
  'WithdrawCollateral(bytes32,address,address,address,uint256)',
  'Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)',
  'AccrueInterest(bytes32,uint256,uint256,uint256)',
  'FlashLoan(address,address,uint256)',
  'SetAuthorization(address,address,address,bool)',
  'IncrementNonce(address,address,uint256)',
];
const NAMES = new Map<string, string>([
  [UNI_USDC_WETH_005.topic0.toLowerCase(), 'Swap'],
  ...MORPHO_EVENTS.map((s) => [toEventSelector(s).toLowerCase(), s.slice(0, s.indexOf('('))] as [string, string]),
]);

type Item = { key: string; block: bigint; tx: Hex; src: 'uni' | 'morpho'; name: string };

const MAX_ITEMS = 80;

export function Ticker() {
  const [items, setItems] = useState<Item[]>([]);
  const [head, setHead] = useState<bigint | null>(null);

  useEffect(() => {
    let stop = false;
    let last: bigint | null = null;
    const tick = async () => {
      try {
        const h = await eth.getBlockNumber();
        if (stop) return;
        setHead(h);
        const from = last === null ? h - 4n : last + 1n;
        if (from > h) return;
        const logs = (await eth.request({
          method: 'eth_getLogs',
          params: [{ address: [UNI_USDC_WETH_005.address, MORPHO_BLUE], fromBlock: numberToHex(from), toBlock: numberToHex(h) }],
        })) as { address: Hex; topics: Hex[]; transactionHash: Hex; logIndex: Hex; blockNumber: Hex }[];
        last = h;
        if (stop || !logs.length) return;
        const fresh = logs.map((l) => ({
          key: `${l.transactionHash}:${l.logIndex}`,
          block: BigInt(l.blockNumber),
          tx: l.transactionHash,
          src: l.address.toLowerCase() === MORPHO_BLUE.toLowerCase() ? ('morpho' as const) : ('uni' as const),
          name: NAMES.get(l.topics[0]?.toLowerCase() ?? '') ?? `${l.topics[0]?.slice(0, 10)}…`,
        }));
        setItems((prev) => [...prev, ...fresh].slice(-MAX_ITEMS));
      } catch {
        // public RPC hiccup; try again next block
      }
    };
    tick();
    const id = setInterval(tick, 12_000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  // continuous scroll driven by rAF so new items append without restarting the strip
  const runRef = useRef<HTMLDivElement>(null);
  const paused = useRef(false);
  useEffect(() => {
    let x = 0;
    let raf = 0;
    let prev = performance.now();
    const step = (now: number) => {
      const el = runRef.current;
      const dt = Math.min(64, now - prev);
      prev = now;
      if (el && !paused.current) {
        const half = el.scrollWidth / 2;
        x -= dt * 0.05;
        if (half > 0 && -x >= half) x += half;
        el.style.transform = `translateX(${x}px)`;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  const row = (copy: number) =>
    items.map((it) => (
      <a key={`${copy}:${it.key}`} className="ticker-item" href={`https://etherscan.io/tx/${it.tx}`} target="_blank" rel="noreferrer">
        <span className={`tag ${it.src}`}>{it.src === 'uni' ? 'UNI-V3' : 'MORPHO'}</span>
        <span className="ev">{it.name}</span>
        <span>
          {it.tx.slice(0, 10)}…{it.tx.slice(-6)}
        </span>
        <span className="blk">blk {it.block.toString()}</span>
      </a>
    ));

  return (
    <div className="ticker" aria-label="Live Ethereum events">
      <div className="ticker-head">
        <span className="dot" />
        ETH {head !== null ? `#${head}` : 'connecting…'}
      </div>
      <div className="ticker-track" onMouseEnter={() => (paused.current = true)} onMouseLeave={() => (paused.current = false)}>
        {items.length === 0 ? (
          <div className="ticker-run">
            <span className="ticker-item">waiting for the next block…</span>
          </div>
        ) : (
          <div className="ticker-run" ref={runRef}>
            {row(0)}
            {row(1)}
          </div>
        )}
      </div>
    </div>
  );
}
