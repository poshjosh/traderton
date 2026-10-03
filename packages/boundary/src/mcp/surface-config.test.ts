// Phase 3 T2.2 — `resolveMcpSurfaceConfig` entry-point fail-fast behaviour.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveMcpSurfaceConfig } from './surface-config.js';

const VALID_DESCRIPTOR = new URL('../__fixtures__/descriptor-conformance/valid.json', import.meta.url)
  .pathname;

/** A readFile that must never be called (asserts no file access on the disabled paths). */
const forbiddenReadFile = (): string => {
  throw new Error('readFile must not be called');
};

describe('resolveMcpSurfaceConfig', () => {
  it('stays unmounted when BOUNDARY_MCP_ENABLED is unset or false', () => {
    expect(resolveMcpSurfaceConfig({}, forbiddenReadFile)).toBeUndefined();
    expect(resolveMcpSurfaceConfig({ enabled: 'false' }, forbiddenReadFile)).toBeUndefined();
  });

  it('mounts with an empty tool list when enabled without a descriptor', () => {
    expect(resolveMcpSurfaceConfig({ enabled: 'true' }, forbiddenReadFile)).toEqual({ tools: [] });
    expect(resolveMcpSurfaceConfig({ enabled: 'true', descriptorPath: '' }, forbiddenReadFile)).toEqual({
      tools: [],
    });
  });

  it('rejects a non-boolean BOUNDARY_MCP_ENABLED', () => {
    expect(() => resolveMcpSurfaceConfig({ enabled: 'yes' }, forbiddenReadFile)).toThrow(
      /must be 'true' or 'false'/,
    );
  });

  it('rejects a descriptor path while MCP is disabled', () => {
    expect(() =>
      resolveMcpSurfaceConfig({ enabled: 'false', descriptorPath: VALID_DESCRIPTOR }, forbiddenReadFile),
    ).toThrow(/BOUNDARY_MCP_ENABLED is not true/);
  });

  it('fails fast on an unreadable or invalid descriptor file', () => {
    expect(() =>
      resolveMcpSurfaceConfig({ enabled: 'true', descriptorPath: '/no/such/descriptor.json' }, (p) =>
        readFileSync(p, 'utf8'),
      ),
    ).toThrow(/failed to read/);

    expect(() =>
      resolveMcpSurfaceConfig({ enabled: 'true', descriptorPath: 'x' }, () => 'not json'),
    ).toThrow(/not valid JSON/);

    expect(() =>
      resolveMcpSurfaceConfig({ enabled: 'true', descriptorPath: 'x' }, () => '{"nope":true}'),
    ).toThrow(/not a serviceable descriptor/);
  });

  it('serves the descriptor tools when enabled with a valid descriptor file', () => {
    const config = resolveMcpSurfaceConfig(
      { enabled: 'true', descriptorPath: VALID_DESCRIPTOR },
      (p) => readFileSync(p, 'utf8'),
    );
    expect(config?.tools.map((t) => t.name).sort()).toEqual(['echo_text', 'reverse_text']);
  });
});
