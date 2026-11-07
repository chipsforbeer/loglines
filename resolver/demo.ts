// Open one market per preset for a demo.
//
//   npm run markets:demo              # staggered short windows: the first settles about 15 minutes
//                                     # from now, the last runs about three hours. Run it right before recording.
//   npm run markets:long              # one market per log-based preset over a multi-day window
//                                     # (default 2026-11-15 00:00 to 2026-11-20 00:00 UTC), open for trading
//                                     # until then with nothing running; --start / --until change the window
//   add -- --dry-run to print the specs only. NEAR_NETWORK=mainnet selects mainnet.

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    long: { type: 'boolean' },
    start: { type: 'string', default: '2026-11-15T00:00:00Z' },
    until: { type: 'string', default: '2026-11-20T00:00:00Z' },
    'dry-run': { type: 'boolean' },
  },
});

function create(preset: string, args: string[]) {
  const all = [join(here, 'create.ts'), preset, ...args, '--b', '1'];
  if (values['dry-run']) all.push('--dry-run');
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...all], { stdio: 'inherit' });
}

if (values.long) {
  const start = Date.parse(values.start!);
  const minutes = Math.round((Date.parse(values.until!) - start) / 60_000);
  if (!(minutes > 0)) throw new Error('--until must be after --start');
  // Every source here is computed from logs and headers, so nothing has to run while the window is
  // open: the resolver only needs to run once after it ends. Morpho utilization is left out because
  // it is sampled while the window is open. Lines are calibrated on the last day (6 x 4 h).
  const common = ['--start', new Date(start).toISOString(), '--minutes', String(minutes), '--calibrate-minutes', '240'];
  const PLAN: [string, string[]][] = [
    ['usdc-supply', []],
    ['usdc-peg', []],
    ['morpho-rate', []],
    ['gas', ['--every', '100']], // ~1 block in 20 minutes: a few hundred headers over five days
    ['blobs', ['--every', '100']],
  ];
  for (const [preset, extra] of PLAN) {
    console.log(`\n== ${preset} (${values.start} to ${values.until})`);
    create(preset, [...common, ...extra]);
  }
} else {
  // [preset, window minutes]: short windows first, so something settles on camera
  const PLAN: [string, number][] = [
    ['usdc-peg', 10],
    ['gas', 15],
    ['blobs', 30],
    ['morpho-rate', 60],
    ['morpho-util', 120],
    ['usdc-supply', 180],
  ];
  for (const [preset, minutes] of PLAN) {
    console.log(`\n== ${preset} (${minutes} min window)`);
    create(preset, ['--minutes', String(minutes), '--start-in', '2']);
  }
}
