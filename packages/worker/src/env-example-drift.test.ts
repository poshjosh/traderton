/**
 * Mechanical drift guards — keep the committed self-documenting sources of truth
 * in lockstep with the code that reads them. These caught (and now prevent) two
 * real omissions: `.env.example` missing the entire ENV_OVERRIDES key set, and
 * `default.yaml` missing schema-defaulted trading blocks (tokenSafety/scrapfly/
 * forexFactory). See docs/best-practices/configuration.md.
 *
 * Guard 1 — `.env.example` ⊇ every env var the code reads:
 *   (a) every ENV_OVERRIDES key in config.ts, AND
 *   (b) every `process.env['X']` literal across packages (ex-tests).
 * Guard 2 — `config/default.yaml` has a value for (near enough) every leaf the
 *   code documents, i.e. the ENV_OVERRIDES target paths resolve to a present key.
 * Guard 3 — `.env.ops.*.example` files are in lockstep with each other and with
 *   their documented var set (validator secrets + testnet creds + dup'd runtime
 *   keys), and do not commit real secret values.
 *
 * The "every new .env variant must have a committed .example twin" rule is
 * enforced by the `.gitignore` negation rules:
 *   .env
 *   .env.*
 *   !.env.example
 *   !.env.ops.dev.example
 *   !.env.ops.staging.example
 *   !.env.ops.production.example
 * Any future `.env.foo` real file is ignored unless its `.env.foo.example` twin
 * is explicitly un-ignored — so a future author must extend BOTH `.gitignore`
 * (add the negation line) AND this test (add the path constant + expected keys).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

// packages/worker/src → repo root is ../../..
const REPO_ROOT = resolve(new URL('.', import.meta.url).pathname, '../../..');
const ENV_EXAMPLE = resolve(REPO_ROOT, '.env.example');
const OPS_DEV_EXAMPLE = resolve(REPO_ROOT, '.env.ops.dev.example');
const OPS_STAGING_EXAMPLE = resolve(REPO_ROOT, '.env.ops.staging.example');
const OPS_PROD_EXAMPLE = resolve(REPO_ROOT, '.env.ops.production.example');
const CONFIG_TS = resolve(REPO_ROOT, 'packages/worker/src/config.ts');
const DEFAULT_YAML = resolve(REPO_ROOT, 'config/default.yaml');
const PACKAGES_DIR = resolve(REPO_ROOT, 'packages');

/** Env vars the drift guard intentionally does NOT require in .env.example. */
const IGNORED_ENV_VARS = new Set<string>([
  // Dynamic loop variable in applyEnvOverrides (`process.env[envVar]`), not a literal.
  'envVar',
  // Only read inside _deferred-authoring (not a live boundary/worker path yet).
  'DATASETS_DIR',
  // Venue-launch validators (scripts/ts/validate-*-launch.ts): operator-run
  // scripts outside packages/, documented in .env.example as placeholders but
  // never read by the live packages.
  'ONEINCH_PRIVATE_KEY',
  'SOLANA_WALLET_PRIVATE_KEY',
  'SOLANA_RPC_URL',
  'JUPITER_WALLET_ADDRESS',
  'JUPITER_PRIVATE_KEY',
  'SWAP_AMOUNT',
  'SLIPPAGE_BPS',
  // Test-only / dev-only entry points (integration-db, boundary-e2e) are excluded
  // by the ex-tests walk + the dev/ filter below, but list here defensively.
]);

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue;
      out.push(...walkTsFiles(p));
    } else if (
      name.endsWith('.ts') &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.d.ts')
    ) {
      // Skip dev-only / test-helper entry points that read their own dev env vars.
      if (p.includes('/dev/') || p.includes('/test-helpers/') || p.includes('/_deferred-')) continue;
      out.push(p);
    }
  }
  return out;
}

/** Extract every ENV_OVERRIDES key name from config.ts. */
function envOverrideKeys(): string[] {
  const src = readFileSync(CONFIG_TS, 'utf8');
  // Match lines like: `  FOO_BAR: { path: '...' , type: '...' },`
  const keys = new Set<string>();
  const re = /^\s{2}([A-Z][A-Z0-9_]+):\s*\{\s*path:/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) keys.add(m[1]!);
  return [...keys];
}

/** Extract every distinct `process.env['X']` literal across the live packages. */
function processEnvLiterals(): string[] {
  const keys = new Set<string>();
  const re = /process\.env\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g;
  for (const file of walkTsFiles(PACKAGES_DIR)) {
    const src = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) keys.add(m[1]!);
  }
  return [...keys];
}

/** Env var names documented in an example file (both active `KEY=` and commented `# KEY=`). */
function envExampleKeys(file: string = ENV_EXAMPLE): Set<string> {
  const src = readFileSync(file, 'utf8');
  const keys = new Set<string>();
  const re = /^\s*#?\s*([A-Z][A-Z0-9_]+)=/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) keys.add(m[1]!);
  return keys;
}

/** Env var name → value (value after `=`, inline comment stripped) from an example file. */
function envExampleValues(file: string): Map<string, string> {
  const src = readFileSync(file, 'utf8');
  const values = new Map<string, string>();
  const re = /^\s*#?\s*([A-Z][A-Z0-9_]+)=(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let value = m[2]!;
    // Strip any inline `# comment` (whitespace-prefixed) before trimming, so the
    // trailing spaces in `KEY=                    # comment` don't survive.
    const hash = value.search(/\s+#/);
    if (hash !== -1) value = value.slice(0, hash);
    values.set(m[1]!, value.trim());
  }
  return values;
}

describe('.env.example is in lockstep with the code that reads env vars', () => {
  it('documents every ENV_OVERRIDES key from config.ts', () => {
    const documented = envExampleKeys();
    const missing = envOverrideKeys()
      .filter((k) => !IGNORED_ENV_VARS.has(k))
      .filter((k) => !documented.has(k));
    expect(missing, `ENV_OVERRIDES keys missing from .env.example: ${missing.join(', ')}`).toEqual([]);
  });

  it('documents every process.env[...] literal read by the live packages', () => {
    const documented = envExampleKeys();
    const missing = processEnvLiterals()
      .filter((k) => !IGNORED_ENV_VARS.has(k))
      .filter((k) => !documented.has(k));
    expect(missing, `process.env[...] literals missing from .env.example: ${missing.join(', ')}`).toEqual([]);
  });

  it('does not document env vars the code never reads (no stale entries)', () => {
    const codeVars = new Set<string>([...envOverrideKeys(), ...processEnvLiterals()]);
    // Names that legitimately appear in .env.example but are not `process.env[...]`
    // literals nor ENV_OVERRIDES keys: the boundary-config vars read via destructured
    // helpers are still `process.env['X']` literals, so they ARE in codeVars. Anything
    // else documented-but-unread is drift.
    const stale = [...envExampleKeys()].filter((k) => !codeVars.has(k) && !IGNORED_ENV_VARS.has(k));
    expect(stale, `Env vars documented in .env.example but never read by the code: ${stale.join(', ')}`).toEqual([]);
  });
});

describe('config/default.yaml has a value for every ENV_OVERRIDES target (self-documenting)', () => {
  // Per docs/best-practices/configuration.md rule: even SCHEMA-DEFAULTED config
  // must appear in default.yaml so the file is the documentation. Each such
  // ENV_OVERRIDES path (e.g. `marketData.birdeye.apiKey`) must resolve to a
  // present leaf key.
  //
  // EXCLUDED: paths that are `.optional()` in the schema with NO `.default()` —
  // these have no canonical baseline value (e.g. `venues.hyperliquid.testnet`,
  // `venues.1inch.routerAddress`), herobids' own default.yaml omits them too, and
  // inventing a value would encode a behavior choice. They are set only per
  // deployment via the env override. The rule targets defaulted config, not
  // genuinely-optional-no-default overrides.
  const OPTIONAL_NO_DEFAULT_PATHS = new Set<string>([
    'venues.hyperliquid.testnet',
    'venues.bybit.testnet',
    'venues.1inch.routerAddress',
  ]);
  const yaml = readFileSync(DEFAULT_YAML, 'utf8');

  function pathPresent(dotted: string): boolean {
    // Cheap structural check: the final key segment must appear as a `key:` line,
    // nested under its parent chain. We verify the LEAF key token exists in the file
    // AND every ancestor segment exists as a key somewhere (sufficient for this flat
    // 2-space YAML; the loadConfig parse test is the authoritative deep check).
    const segments = dotted.split('.');
    return segments.every((seg) => new RegExp(`(^|\\n)\\s*${escapeRe(seg)}:`, 'm').test(yaml));
  }
  function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  it('every ENV_OVERRIDES target path is present in default.yaml', () => {
    const src = readFileSync(CONFIG_TS, 'utf8');
    const re = /path:\s*['"]([a-zA-Z0-9_.]+)['"]/g;
    const paths = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) paths.add(m[1]!);
    const missing = [...paths]
      .filter((p) => !OPTIONAL_NO_DEFAULT_PATHS.has(p))
      .filter((p) => !pathPresent(p));
    expect(missing, `ENV_OVERRIDES target paths missing a value in default.yaml: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('.env.ops.*.example files are in lockstep with each other and their docs', () => {
  // The operator/test/validator examples carry credentials that are NOT all read
  // as `process.env['X']` literals in packages/ (validators live under scripts/ts/,
  // integration tests use describe.skipIf), so they can't be guarded by the literal
  // walk — we assert them against an explicit expected key set instead.
  const OPS_EXAMPLES = [
    ['dev', OPS_DEV_EXAMPLE],
    ['staging', OPS_STAGING_EXAMPLE],
    ['production', OPS_PROD_EXAMPLE],
  ] as const;

  // Union of validator secrets + Tier5/6 testnet creds + runtime keys duplicated
  // into ops. Mirrors the Variable Mapping Table in
  // docs/features/2026/09/24/001-env-rationalization-implementation/010-env-file-design-and-variable-mapping.md.
  const EXPECTED_OPS_KEYS = [
    'ONEINCH_PRIVATE_KEY',
    'SOLANA_WALLET_PRIVATE_KEY',
    'SOLANA_RPC_URL',
    'JUPITER_WALLET_ADDRESS',
    'JUPITER_PRIVATE_KEY',
    'SWAP_AMOUNT',
    'SLIPPAGE_BPS',
    'HYPERLIQUID_TESTNET_API_KEY',
    'HYPERLIQUID_TESTNET_SECRET',
    'HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS',
    'BYBIT_TESTNET_API_KEY',
    'BYBIT_TESTNET_SECRET',
    'BASE_RPC_URL',
    'ONEINCH_API_URL',
    'ONEINCH_API_KEY',
    'JUPITER_API_KEY',
    'JUPITER_API_URL',
    'ONEINCH_CHAIN_ID',
    'ONEINCH_ROUTER_ADDRESS',
    'NODE_ENV',
    'LOG_FORMAT',
  ];

  // Secret-shaped var names — must be left blank/placeholder in committed examples.
  // Non-secret vars (URLs, chain id, NODE_ENV, LOG_FORMAT, amounts, bps) MAY have defaults.
  const SECRET_VAR_RE = /(_PRIVATE_KEY|_SECRET|_API_KEY|_SIGNING_SECRET|_ENCRYPTION_KEY)$/;

  it('documents the same key set across all three ops examples', () => {
    const baseline = [...envExampleKeys(OPS_DEV_EXAMPLE)].sort();
    for (const [label, file] of OPS_EXAMPLES) {
      if (label === 'dev') continue; // skip self-comparison of the baseline
      const keys = [...envExampleKeys(file)].sort();
      const missing = baseline.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !baseline.includes(k));
      expect(
        { missing, extra },
        `.env.ops.${label}.example diverges from .env.ops.dev.example ` +
          `(missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`,
      ).toEqual({ missing: [], extra: [] });
    }
  });

  it('documents every expected ops var in every example', () => {
    for (const [label, file] of OPS_EXAMPLES) {
      const documented = envExampleKeys(file);
      const missing = EXPECTED_OPS_KEYS.filter((k) => !documented.has(k));
      const extra = [...documented].filter((k) => !EXPECTED_OPS_KEYS.includes(k));
      expect(
        missing,
        `Expected ops vars missing from .env.ops.${label}.example: ${missing.join(', ') || 'none'}`,
      ).toEqual([]);
      expect(
        extra,
        `Ops vars in .env.ops.${label}.example not listed in EXPECTED_OPS_KEYS: ${extra.join(', ') || 'none'}`,
      ).toEqual([]);
    }
  });

  it('does not commit real secret values (secret-shaped vars left blank)', () => {
    for (const [label, file] of OPS_EXAMPLES) {
      const values = envExampleValues(file);
      const leaked = [...values.entries()]
        .filter(([key, value]) => SECRET_VAR_RE.test(key) && value !== '')
        .map(([key, value]) => `${key}=${value}`);
      expect(
        leaked,
        `Secret-shaped vars with non-empty values committed in .env.ops.${label}.example: ${leaked.join(', ')}`,
      ).toEqual([]);
    }
  });
});
