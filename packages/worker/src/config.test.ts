import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './config.js';
import { resolve } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Traderton note (Phase 9b, item A): this is the herobids config.test.ts trimmed
// to trading-only (fused-file line-trim, line-traceable to source; NOT byte-diffable
// since herobids has no trading-only variant). Every surviving test/line is verbatim
// from herobids modulo the platform removals. Removed WHOLE platform describe/it
// blocks: `throws when agentRuntime.defaultBudgets is missing`, `applies SES email
// env overrides`, `LLM runtime env overrides`, `worker config defaults and YAML`,
// `llm retry, scout, and thinking config`, `agentRuntime config defaults`. Trimmed
// `BASE_YAML` (dropped the platform `agentRuntime.defaultBudgets` block) and the
// `overlays NODE_ENV-specific config` overlay (dropped platform `billing.*`, kept the
// `database.url` assertion it exercises). See archive/features/013-9b-authoring-plan.md.

// Minimal required fields for AppConfigSchema
const BASE_YAML = `
app:
  port: 3000
database:
  url: postgres://localhost/test
redis:
  url: redis://localhost:6379
execution:
  defaultSlippageBps: 50
risk:
  globalMaxDrawdownPct: 20
`;

const MINIMAL_MARKET_DATA_YAML = `
marketData:
  dexscreener:
    baseUrl: https://api.dexscreener.com
    search:
      requestsPerMinute: 35
    discovery:
      requestsPerMinute: 25
  binance:
    baseUrl: https://api.binance.com
    requestsPerMinute: 200
  geckoterminal:
    baseUrl: https://api.geckoterminal.com
    candles:
      requestsPerMinute: 12
    discovery:
      requestsPerMinute: 8
  hyperliquid:
    baseUrl: https://api.hyperliquid.xyz
    intelligencePath: /info
    intelligence:
      requestsPerMinute: 100
  bybit:
    baseUrl: https://api.bybit.com
    longShortRatioPath: /v5/market/account-ratio
    intelligence:
      requestsPerMinute: 90
  birdeye:
    enabled: false
    baseUrl: https://public-api.birdeye.so
    requestsPerMinute: 60
    apiKey: ''
  coinMarketCap:
    enabled: false
    baseUrl: https://pro-api.coinmarketcap.com
    requestsPerMinute: 25
    apiKey: ''
  timeoutMs: 5000
  tokenSafety:
    enabled: true
`;

describe('loadConfig', () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'traderton-config-test-'));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads and parses default.yaml', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
venues:
  hyperliquid:
    baseUrl: https://api.hyperliquid.xyz
`);

    const config = loadConfig(tmpDir);

    expect(config.database.url).toBe('postgres://localhost/test');
    expect(config.venues['hyperliquid']?.baseUrl).toBe('https://api.hyperliquid.xyz');
  });

  it('throws when default.yaml is missing', () => {
    expect(() => loadConfig(tmpDir)).toThrow('Config file not found');
  });

  it('overlays NODE_ENV-specific config', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);
    writeFileSync(resolve(tmpDir, 'production.yaml'), `
database:
  url: postgres://prod-host/traderton
`);
    process.env['NODE_ENV'] = 'production';

    const config = loadConfig(tmpDir);

    expect(config.database.url).toBe('postgres://prod-host/traderton');
  });

  it('applies DATABASE_URL env override', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);
    process.env['DATABASE_URL'] = 'postgres://override-host/overridden';

    const config = loadConfig(tmpDir);

    expect(config.database.url).toBe('postgres://override-host/overridden');
  });

  it('applies BIRDEYE_API_KEY env override without clobbering YAML defaults', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + MINIMAL_MARKET_DATA_YAML);
    process.env['BIRDEYE_API_KEY'] = 'birdeye-env-key';

    const config = loadConfig(tmpDir);

    expect(config.marketData?.birdeye.apiKey).toBe('birdeye-env-key');
    expect(config.marketData?.birdeye.enabled).toBe(false);
  });

  it('preserves YAML Birdeye apiKey when the env override is empty', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
marketData:
  birdeye:
    enabled: false
    baseUrl: https://public-api.birdeye.so
    requestsPerMinute: 60
    apiKey: yaml-birdeye-key
`);
    process.env['BIRDEYE_API_KEY'] = '';

    const config = loadConfig(tmpDir);

    expect(config.marketData?.birdeye.apiKey).toBe('yaml-birdeye-key');
    expect(config.marketData?.birdeye.enabled).toBe(false);
  });

  it('applies COINMARKETCAP_API_KEY env override without clobbering YAML defaults', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + MINIMAL_MARKET_DATA_YAML);
    process.env['COINMARKETCAP_API_KEY'] = 'cmc-env-key';

    const config = loadConfig(tmpDir);

    expect(config.marketData?.coinMarketCap.apiKey).toBe('cmc-env-key');
    expect(config.marketData?.coinMarketCap.enabled).toBe(false);
  });

  it('preserves YAML CoinMarketCap apiKey when the env override is empty', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
marketData:
  coinMarketCap:
    enabled: false
    baseUrl: https://pro-api.coinmarketcap.com
    requestsPerMinute: 30
    apiKey: yaml-cmc-key
`);
    process.env['COINMARKETCAP_API_KEY'] = '';

    const config = loadConfig(tmpDir);

    expect(config.marketData?.coinMarketCap.apiKey).toBe('yaml-cmc-key');
    expect(config.marketData?.coinMarketCap.enabled).toBe(false);
  });

  it('COINMARKETCAP_API_KEY overrides YAML apiKey when coinMarketCap is enabled', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
marketData:
  coinMarketCap:
    enabled: true
    baseUrl: https://pro-api.coinmarketcap.com
    requestsPerMinute: 30
    apiKey: yaml-cmc-key
`);
    process.env['COINMARKETCAP_API_KEY'] = 'env-cmc-key';

    const config = loadConfig(tmpDir);

    expect(config.marketData?.coinMarketCap.apiKey).toBe('env-cmc-key');
    expect(config.marketData?.coinMarketCap.enabled).toBe(true);
  });

  it('env overlay deep-merges without clobbering sibling keys', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
reconciliation:
  intervalMs: 30000
  driftAlertOnly: true
`);
    writeFileSync(resolve(tmpDir, 'development.yaml'), `
reconciliation:
  intervalMs: 5000
`);
    process.env['NODE_ENV'] = 'development';

    const config = loadConfig(tmpDir);

    expect(config.reconciliation.intervalMs).toBe(5000);
    expect(config.reconciliation.driftAlertOnly).toBe(true);
  });

  it('applies Zod defaults for missing sections', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);

    const config = loadConfig(tmpDir);

    expect(config.reconciliation.intervalMs).toBe(30000);
    expect(config.reconciliation.driftAlertOnly).toBe(true);
    expect(config.streams.private.reconnectBaseMs).toBe(1000);
    expect(config.streams.public.reconnectBaseMs).toBe(1000);
    expect(config.marking.stalenessThresholdMs).toBe(300000);
    expect(config.marketData).toBeUndefined();
  });

  it('loads marketData when explicitly configured', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
marketData:
  dexscreener:
    baseUrl: https://api.dexscreener.com
    search:
      requestsPerMinute: 35
      cacheTtlMs: 15000
    discovery:
      requestsPerMinute: 25
  binance:
    baseUrl: https://api.binance.com
    requestsPerMinute: 200
  geckoterminal:
    baseUrl: https://api.geckoterminal.com
    candles:
      requestsPerMinute: 12
    discovery:
      requestsPerMinute: 8
  hyperliquid:
    baseUrl: https://api.hyperliquid.xyz
    intelligencePath: /info
    intelligence:
      requestsPerMinute: 100
  bybit:
    baseUrl: https://api.bybit.com
    longShortRatioPath: /v5/market/account-ratio
    intelligence:
      requestsPerMinute: 90
  birdeye:
    enabled: false
    baseUrl: https://public-api.birdeye.so
    requestsPerMinute: 60
    apiKey: ''
  coinMarketCap:
    enabled: true
    baseUrl: https://pro-api.coinmarketcap.com
    requestsPerMinute: 25
    apiKey: cmc-key
  timeoutMs: 5000
`);

    const config = loadConfig(tmpDir);

    expect(config.marketData?.dexscreener.baseUrl).toBe('https://api.dexscreener.com');
    expect(config.marketData?.dexscreener.search.requestsPerMinute).toBe(35);
    expect(config.marketData?.dexscreener.discovery.requestsPerMinute).toBe(25);
    expect(config.marketData?.geckoterminal.discovery.requestsPerMinute).toBe(8);
    expect(config.marketData?.hyperliquid.intelligence.requestsPerMinute).toBe(100);
    expect(config.marketData?.bybit.longShortRatioPath).toBe('/v5/market/account-ratio');
    expect(config.marketData?.coinMarketCap.enabled).toBe(true);
    expect(config.marketData?.binance.requestsPerMinute).toBe(200);
    expect(config.marketData?.timeoutMs).toBe(5000);
  });

  it('deep-merges marketData overlays without clobbering sibling budgets', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
marketData:
  dexscreener:
    baseUrl: https://api.dexscreener.com
    search:
      requestsPerMinute: 30
    discovery:
      requestsPerMinute: 20
  geckoterminal:
    baseUrl: https://api.geckoterminal.com
    candles:
      requestsPerMinute: 15
    discovery:
      requestsPerMinute: 10
`);
    writeFileSync(resolve(tmpDir, 'development.yaml'), `
marketData:
  dexscreener:
    discovery:
      requestsPerMinute: 12
`);
    process.env['NODE_ENV'] = 'development';

    const config = loadConfig(tmpDir);

    expect(config.marketData?.dexscreener.search.requestsPerMinute).toBe(30);
    expect(config.marketData?.dexscreener.discovery.requestsPerMinute).toBe(12);
    expect(config.marketData?.geckoterminal.candles.requestsPerMinute).toBe(15);
  });

  it('ignores missing NODE_ENV overlay file gracefully', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);
    process.env['NODE_ENV'] = 'staging';

    const config = loadConfig(tmpDir);

    expect(config.database.url).toBe('postgres://localhost/test');
  });

  it('rejects invalid stalenessThresholdMs below minimum', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
marking:
  stalenessThresholdMs: 1000
`);

    expect(() => loadConfig(tmpDir)).toThrow();
  });

  it('rejects invalid boolean env values instead of silently coercing to false', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);
    process.env['RECONCILIATION_DRIFT_ALERT_ONLY'] = 'treu';

    expect(() => loadConfig(tmpDir)).toThrow('Invalid boolean env value');
  });

  it('accepts valid boolean env values true, false, 1, 0', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);
    process.env['RECONCILIATION_DRIFT_ALERT_ONLY'] = 'false';
    process.env['RECONCILIATION_AUTO_CORRECT'] = '1';

    const config = loadConfig(tmpDir);

    expect(config.reconciliation.driftAlertOnly).toBe(false);
    expect(config.reconciliation.autoCorrect).toBe(true);
  });

  describe('liveRollout config', () => {
    it('applies Zod defaults when liveRollout is omitted', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);

      const config = loadConfig(tmpDir);

      expect(config.liveRollout.enabled).toBe(false);
      expect(config.liveRollout.allowedVenues).toEqual(['hyperliquid']);
      expect(config.liveRollout.requireDbCredentials).toBe(true);
      expect(config.liveRollout.maxInitialOrderNotionalUsd).toBe('50');
      expect(config.liveRollout.maxConsecutiveVenueErrors).toBe(3);
      expect(config.liveRollout.slippageAlertBps).toBe(50);
      expect(config.liveRollout.limitOrderTimeoutMs).toBe(120000);
      expect(config.liveRollout.marketOrderTimeoutMs).toBe(30000);
      expect(config.liveRollout.timeoutCheckIntervalMs).toBe(10000);
      expect(config.liveRollout.crashPolicy).toBe('alert_manual_intervention');
    });

    it('loads explicit liveRollout from YAML', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
liveRollout:
  enabled: true
  allowedVenues:
    - hyperliquid
  maxInitialOrderNotionalUsd: "100"
`);

      const config = loadConfig(tmpDir);

      expect(config.liveRollout.enabled).toBe(true);
      expect(config.liveRollout.allowedVenues).toEqual(['hyperliquid']);
      expect(config.liveRollout.maxInitialOrderNotionalUsd).toBe('100');
    });

    it('applies LIVE_ROLLOUT_ENABLED env override', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);
      process.env['LIVE_ROLLOUT_ENABLED'] = 'true';

      const config = loadConfig(tmpDir);

      expect(config.liveRollout.enabled).toBe(true);
    });

    it('applies LIVE_ROLLOUT_MAX_ORDER_NOTIONAL_USD env override', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);
      process.env['LIVE_ROLLOUT_MAX_ORDER_NOTIONAL_USD'] = '25';

      const config = loadConfig(tmpDir);

      expect(config.liveRollout.maxInitialOrderNotionalUsd).toBe('25');
    });

    it('rejects non-numeric maxInitialOrderNotionalUsd', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
liveRollout:
  maxInitialOrderNotionalUsd: "fifty"
`);

      expect(() => loadConfig(tmpDir)).toThrow();
    });

    it('rejects zero maxInitialOrderNotionalUsd', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
liveRollout:
  maxInitialOrderNotionalUsd: "0"
`);

      expect(() => loadConfig(tmpDir)).toThrow();
    });

    it('rejects Infinity maxInitialOrderNotionalUsd', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
liveRollout:
  maxInitialOrderNotionalUsd: "Infinity"
`);

      expect(() => loadConfig(tmpDir)).toThrow();
    });

    it('rejects whitespace-padded maxInitialOrderNotionalUsd', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
liveRollout:
  maxInitialOrderNotionalUsd: " 50 "
`);

      expect(() => loadConfig(tmpDir)).toThrow();
    });

    it('rejects unsupported venues in allowedVenues', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
liveRollout:
  allowedVenues:
    - kraken
`);

      expect(() => loadConfig(tmpDir)).toThrow();
    });
  });

  describe('1inch token safety config', () => {
    it('rejects unsupported 1inch chainId without tokenSafetyNetwork when token safety is enabled', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + MINIMAL_MARKET_DATA_YAML + `
venues:
  1inch:
    baseUrl: https://api.1inch.dev/swap/v6.0/43114
    rpcUrl: https://api.avax.network/ext/bc/C/rpc
    chainId: 43114
`);

      expect(() => loadConfig(tmpDir)).toThrow('venues.1inch.chainId 43114 requires venues.1inch.tokenSafetyNetwork');
    });

    it('accepts explicit tokenSafetyNetwork for unsupported 1inch chainId when token safety is enabled', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + MINIMAL_MARKET_DATA_YAML + `
venues:
  1inch:
    baseUrl: https://api.1inch.dev/swap/v6.0/43114
    rpcUrl: https://api.avax.network/ext/bc/C/rpc
    chainId: 43114
    tokenSafetyNetwork: avalanche
`);

      const config = loadConfig(tmpDir);

      expect(config.venues['1inch']?.tokenSafetyNetwork).toBe('avalanche');
    });

    it('rejects invalid tokenSafetyNetwork values', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + MINIMAL_MARKET_DATA_YAML + `
venues:
  1inch:
    baseUrl: https://api.1inch.dev/swap/v6.0/43114
    rpcUrl: https://api.avax.network/ext/bc/C/rpc
    chainId: 43114
    tokenSafetyNetwork: avalanchee
`);

      expect(() => loadConfig(tmpDir)).toThrow();
    });
  });

  describe('generated wallet venue configuration', () => {
    it('applies the 1inch operator API key override', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
venues:
  1inch:
    baseUrl: https://api.1inch.dev/swap/v6.0/8453
`);
      process.env['ONEINCH_API_KEY'] = 'oneinch-operator-key';

      const config = loadConfig(tmpDir);

      expect(config.venues['1inch']?.apiKey).toBe('oneinch-operator-key');
      expect(config.venues['1inch']?.walletGeneration.enabled).toBe(false);
    });

    it('rejects enabled 1inch wallet generation without an operator key', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
venues:
  1inch:
    baseUrl: https://api.1inch.dev/swap/v6.0/8453
    walletGeneration:
      enabled: true
`);

      expect(() => loadConfig(tmpDir)).toThrow('venues.1inch.apiKey is required');
    });
  });

  describe('venue public stream config', () => {
    it('preserves Bybit testnet public stream URL from YAML', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
venues:
  bybit:
    baseUrl: https://api.bybit.com
    wsPublicUrl: wss://stream.bybit.com/v5/public/linear
    wsTestnetPublicUrl: wss://stream-testnet.bybit.com/v5/public/linear
`);

      const config = loadConfig(tmpDir);

      expect(config.venues['bybit']?.wsPublicUrl).toBe('wss://stream.bybit.com/v5/public/linear');
      expect(config.venues['bybit']?.wsTestnetPublicUrl).toBe('wss://stream-testnet.bybit.com/v5/public/linear');
    });
  });

  describe('backtesting config', () => {
    it('applies Zod default for backtesting.concurrency when omitted', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);

      const config = loadConfig(tmpDir);

      expect(config.backtesting.concurrency).toBe(2);
    });

    it('loads explicit backtesting.concurrency from YAML', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
backtesting:
  concurrency: 4
`);

      const config = loadConfig(tmpDir);

      expect(config.backtesting.concurrency).toBe(4);
    });
  });

  describe('execution shadow config', () => {
    it('applies Zod defaults for shadowPollIntervalMs and shadowQuoteSlippageBps', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);

      const config = loadConfig(tmpDir);

      expect(config.execution.shadowPollIntervalMs).toBe(2000);
      expect(config.execution.shadowQuoteSlippageBps).toBe(50);
    });

    it('loads explicit shadow execution config from YAML', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), `
app:
  port: 3000
database:
  url: postgres://localhost/test
redis:
  url: redis://localhost:6379
execution:
  defaultSlippageBps: 50
  shadowPollIntervalMs: 3000
  shadowQuoteSlippageBps: 100
risk:
  globalMaxDrawdownPct: 20
`);

      const config = loadConfig(tmpDir);

      expect(config.execution.shadowPollIntervalMs).toBe(3000);
      expect(config.execution.shadowQuoteSlippageBps).toBe(100);
    });
  });

  describe('marking oracle config', () => {
    it('applies Zod defaults for oracleTimeoutMs and oracleVsCurrency', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);

      const config = loadConfig(tmpDir);

      expect(config.marking.oracleTimeoutMs).toBe(10000);
      expect(config.marking.oracleVsCurrency).toBe('usd');
    });

    it('loads explicit oracle config from YAML', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
marking:
  oracleTimeoutMs: 5000
  oracleVsCurrency: eur
`);

      const config = loadConfig(tmpDir);

      expect(config.marking.oracleTimeoutMs).toBe(5000);
      expect(config.marking.oracleVsCurrency).toBe('eur');
    });
  });

  describe('marketData fail-fast validation', () => {
    it('rejects birdeye enabled without apiKey', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
marketData:
  birdeye:
    enabled: true
    baseUrl: https://public-api.birdeye.so
    requestsPerMinute: 60
    apiKey: ''
`);

      expect(() => loadConfig(tmpDir)).toThrow();
    });

    it('accepts birdeye with enabled: false and no apiKey', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
marketData:
  birdeye:
    enabled: false
    baseUrl: https://public-api.birdeye.so
    requestsPerMinute: 60
    apiKey: ''
`);

      const config = loadConfig(tmpDir);

      expect(config.marketData?.birdeye?.enabled).toBe(false);
    });

    it('rejects coinMarketCap enabled without apiKey', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
marketData:
  coinMarketCap:
    enabled: true
    baseUrl: https://pro-api.coinmarketcap.com
    requestsPerMinute: 25
    apiKey: ''
`);

      expect(() => loadConfig(tmpDir)).toThrow();
    });

    it('accepts coinMarketCap with valid apiKey when enabled', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
marketData:
  coinMarketCap:
    enabled: true
    baseUrl: https://pro-api.coinmarketcap.com
    requestsPerMinute: 25
    apiKey: valid-key-123
`);

      const config = loadConfig(tmpDir);

      expect(config.marketData?.coinMarketCap?.enabled).toBe(true);
    });
  });
});
