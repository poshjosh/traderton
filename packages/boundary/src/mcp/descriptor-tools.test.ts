// Phase 3 T2.2 — projecting a signed descriptor wrapper into the tools/list shape.
// Uses the shared T0.4 conformance fixtures so traderton's projection and
// herobids' verification agree on the same bytes.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { projectDescriptorTools } from './descriptor-tools.js';

function readFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../__fixtures__/descriptor-conformance/${name}`, import.meta.url), 'utf8'),
  );
}

describe('projectDescriptorTools', () => {
  it('projects the union of descriptor tools across source skills', () => {
    const result = projectDescriptorTools(readFixture('valid.json'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((t) => t.name).sort()).toEqual(['echo_text', 'reverse_text']);
  });

  it('drops category and keeps name, description and inputSchema', () => {
    const result = projectDescriptorTools(readFixture('valid.json'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const echo = result.data.find((t) => t.name === 'echo_text');
    expect(echo).toBeDefined();
    expect(Object.keys(echo ?? {}).sort()).toEqual(['description', 'inputSchema', 'name']);
    expect(echo?.description).toBe('Returns the given text unchanged.');
    expect(echo?.inputSchema['type']).toBe('object');
    expect(echo).not.toHaveProperty('category');
  });

  it('rejects duplicate tool names whose definitions disagree', () => {
    const wrapper = {
      descriptor: {
        backendId: 'b',
        sourceSkills: [
          {
            ref: 'a',
            tools: [
              { name: 'dup', description: 'one', inputSchema: { type: 'object' }, category: 'read-config' },
            ],
          },
          {
            ref: 'b',
            tools: [
              { name: 'dup', description: 'TWO', inputSchema: { type: 'object' }, category: 'read-config' },
            ],
          },
        ],
      },
      signature: 's',
      keyId: 'k',
    };
    const result = projectDescriptorTools(wrapper);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('mcp.descriptor_tool_conflict');
  });

  it('accepts a duplicate tool name whose definitions are identical', () => {
    const tool = { name: 'dup', description: 'same', inputSchema: { type: 'object' }, category: 'read-config' };
    const wrapper = {
      descriptor: {
        backendId: 'b',
        sourceSkills: [
          { ref: 'a', tools: [tool] },
          { ref: 'b', tools: [{ ...tool }] },
        ],
      },
      signature: 's',
      keyId: 'k',
    };
    const result = projectDescriptorTools(wrapper);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
  });

  it('rejects a tool whose inputSchema root is not an object schema', () => {
    const wrapper = {
      descriptor: {
        backendId: 'b',
        sourceSkills: [
          {
            ref: 'a',
            tools: [{ name: 't', description: 'd', inputSchema: { type: 'string' }, category: 'read-config' }],
          },
        ],
      },
      signature: 's',
      keyId: 'k',
    };
    const result = projectDescriptorTools(wrapper);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('mcp.descriptor_schema_not_object');
  });

  it('rejects a malformed wrapper', () => {
    const result = projectDescriptorTools({ not: 'a descriptor' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('mcp.descriptor_invalid');
  });
});
