import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const { mockUseReducedMotion } = vi.hoisted(() => ({
  mockUseReducedMotion: vi.fn<() => boolean | null>(),
}));

vi.mock('motion/react', () => ({
  useReducedMotion: () => mockUseReducedMotion(),
}));

import { useMarketingReducedMotion } from './use-reduced-motion';

describe('useMarketingReducedMotion', () => {
  it('normalizes true to true', () => {
    mockUseReducedMotion.mockReturnValue(true);
    const { result } = renderHook(() => useMarketingReducedMotion());
    expect(result.current).toBe(true);
  });

  it('normalizes false to false', () => {
    mockUseReducedMotion.mockReturnValue(false);
    const { result } = renderHook(() => useMarketingReducedMotion());
    expect(result.current).toBe(false);
  });

  it('normalizes null (unresolved, e.g. first client render) to false', () => {
    mockUseReducedMotion.mockReturnValue(null);
    const { result } = renderHook(() => useMarketingReducedMotion());
    expect(result.current).toBe(false);
  });
});
