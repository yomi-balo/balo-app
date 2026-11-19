import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockUseIsMobile = vi.fn();
vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: (...args: unknown[]) => mockUseIsMobile(...args),
}));

import { CALL_NOW_MOBILE_BREAKPOINT, useCallNowSurface } from './use-call-now-surface';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useCallNowSurface', () => {
  it('is mobile below the dialog breakpoint', () => {
    mockUseIsMobile.mockReturnValue(true);
    const { result } = renderHook(() => useCallNowSurface());
    expect(result.current).toBe('mobile');
    expect(mockUseIsMobile).toHaveBeenCalledWith(CALL_NOW_MOBILE_BREAKPOINT);
  });

  it('is desktop otherwise', () => {
    mockUseIsMobile.mockReturnValue(false);
    const { result } = renderHook(() => useCallNowSurface());
    expect(result.current).toBe('desktop');
  });

  it('uses the 768px breakpoint the confirm layout switches at', () => {
    expect(CALL_NOW_MOBILE_BREAKPOINT).toBe(768);
  });
});
