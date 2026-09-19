import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(new URL('.', import.meta.url).pathname, '..');
const herobidsRoot = process.env.HEROBIDS_ROOT ?? resolve(root, '..', 'herobids');
const protectedMode = process.env.PARITY_DRIFT_CI === '1';

if (!existsSync(herobidsRoot)) {
  console.log(`parity-drift: ${protectedMode ? 'FAILED' : 'SKIPPED'}`);
  if (protectedMode) console.error('parity-drift: sibling checkout is missing');
  process.exitCode = protectedMode ? 1 : 0;
} else {
  const checker = resolve(herobidsRoot, 'scripts/check-parity-drift.mjs');
  const result = spawnSync(process.execPath, [checker], {
    env: {
      ...process.env,
      HEROBIDS_ROOT: herobidsRoot,
      TRADERTON_ROOT: process.env.TRADERTON_ROOT ?? root,
      PARITY_MANIFEST: process.env.PARITY_MANIFEST ?? resolve(herobidsRoot, 'scripts/parity-drift-manifest.json'),
    },
    stdio: 'inherit',
  });
  process.exitCode = result.status ?? 1;
}