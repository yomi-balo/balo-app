import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { dispatchMeetingsChanged } from '@/lib/meetings/meetings-changed-event';
import { useRefreshOnMeetingsChanged } from './use-refresh-on-meetings-changed';

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

beforeEach(() => {
  mockRefresh.mockClear();
});

describe('useRefreshOnMeetingsChanged', () => {
  it('mounting alone never refreshes', () => {
    renderHook(() => useRefreshOnMeetingsChanged());
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('refreshes once per meetings-changed signal, with no rate limit between signals', () => {
    renderHook(() => useRefreshOnMeetingsChanged());
    dispatchMeetingsChanged();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    dispatchMeetingsChanged();
    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });

  it('ignores focus — that is useRefreshOnFocus', () => {
    renderHook(() => useRefreshOnMeetingsChanged());
    globalThis.dispatchEvent(new Event('focus'));
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('stops listening once unmounted', () => {
    const { unmount } = renderHook(() => useRefreshOnMeetingsChanged());
    unmount();
    dispatchMeetingsChanged();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
