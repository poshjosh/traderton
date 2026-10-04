import { describe, expect, it } from 'vitest';
import {
  AGENT_TECHNICAL_STRATEGY_TYPES,
  applyPresetToAgent,
  type StyleKey,
} from './presets.js';
import { getPreset } from './presets-loader.js';
import herobidsFixture from './__fixtures__/herobids-preset-resolution.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// Parity oracle: herobids-preset-resolution.json captures the resolved split
// (presetBehaviorVersion + technical + risk + execution) that herobids'
// `apps/api/src/agents/strategy-preset-resolver.ts` produces for every
// supported preset × style tier. Generated ONCE from herobids
// (@herobids/domain applyPresetToAgent + getPreset) at commit
// b7a3cde2c010cb16c12d00ca30d7051c7766e987. Content was rephrased for compliance
// with licensing restrictions.
//
// Traderton must resolve each (preset, styleTier) to the IDENTICAL split, so the
// scan loop runs the same technical config herobids would have sent. The preset
// YAML catalog and presets.ts are byte-identical across both repos, so this
// guards against future drift in either copy. The plan (003 T1) requires: "Fix
// drift in the source before relying on it."
// ---------------------------------------------------------------------------

const STYLES: StyleKey[] = ['economy', 'standard', 'premium'];

describe('agent strategy preset resolution parity with herobids', () => {
  it('resolves every supported preset × style tier to the same split herobids produced', () => {
    const resolved: Record<string, unknown> = {};
    for (const style of STYLES) {
      for (const presetKey of AGENT_TECHNICAL_STRATEGY_TYPES) {
        const preset = getPreset(presetKey, style);
        if (!preset) continue;
        const split = applyPresetToAgent(presetKey, preset, style, 'hybrid');
        resolved[`${presetKey}:${style}`] = {
          presetKey: split.presetKey,
          presetStyle: split.presetStyle,
          presetBehaviorVersion: split.presetBehaviorVersion,
          technical: split.technical,
          risk: split.risk,
          execution: split.execution,
        };
      }
    }

    expect(resolved).toEqual(herobidsFixture);
  });

  it('covers every preset × style tier that herobids documented', () => {
    expect(Object.keys(herobidsFixture).sort()).toEqual(
      STYLES.flatMap((style) => AGENT_TECHNICAL_STRATEGY_TYPES.map((key) => `${key}:${style}`)).sort(),
    );
  });
});
