import { describe, it, expect } from 'vitest';
import { capitalDiffers } from './agent-trading-profile-repository.js';

describe('capitalDiffers', () => {
  it('treats numerically equal capital as unchanged', () => {
    expect(capitalDiffers('100', '100.0')).toBe(false);
  });
  it('detects a changed amount', () => {
    expect(capitalDiffers('100', '200')).toBe(true);
  });
  it('treats null to null as unchanged', () => {
    expect(capitalDiffers(null, null)).toBe(false);
  });
  it('counts null to value and value to null as an edit', () => {
    expect(capitalDiffers(null, '100')).toBe(true);
    expect(capitalDiffers('100', null)).toBe(true);
  });
  it('treats a non-numeric stored capital as differing instead of throwing', () => {
    expect(capitalDiffers('abc', '100')).toBe(true);
    expect(capitalDiffers('100', 'abc')).toBe(true);
  });
});
