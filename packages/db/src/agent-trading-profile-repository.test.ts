import { describe, it, expect, vi } from 'vitest';
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
  it('reports a non-numeric capital through the callback so the baseline restart is not silent', () => {
    const onUnparseable = vi.fn();
    expect(capitalDiffers('abc', '100', onUnparseable)).toBe(true);
    expect(onUnparseable).toHaveBeenCalledTimes(1);
    expect(onUnparseable).toHaveBeenCalledWith('previous=abc next=100');
  });
  it('does not call the callback for numeric capital', () => {
    const onUnparseable = vi.fn();
    expect(capitalDiffers('100', '200', onUnparseable)).toBe(true);
    expect(capitalDiffers('100', '100.0', onUnparseable)).toBe(false);
    expect(onUnparseable).not.toHaveBeenCalled();
  });
});
