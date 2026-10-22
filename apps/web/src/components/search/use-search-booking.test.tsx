import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const { mockPush, mockRefresh, mockAuthOpen, mockLoad, mockCapture } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockRefresh: vi.fn(),
  mockAuthOpen: vi.fn(),
  mockLoad: vi.fn(),
  mockCapture: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
}));
vi.mock('@/hooks/use-auth-modal', () => ({ useAuthModal: () => ({ open: mockAuthOpen }) }));
vi.mock('@/lib/booking/actions/load-search-booking', () => ({
  loadSearchBookingAction: (...args: unknown[]) => mockLoad(...args),
}));
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCapture(...args),
}));

import { useSearchBooking } from './use-search-booking';

const LOADED = {
  ok: true as const,
  expert: { expertProfileId: 'p1', name: 'Anil Pilania' },
  context: { arm: 'onboarding_required' as const },
  viewerEmailDomain: 'northwind.com',
};

beforeEach(() => vi.clearAllMocks());

describe('useSearchBooking', () => {
  it('loads the booking for the username, then opens it', async () => {
    mockLoad.mockResolvedValue(LOADED);
    const { result } = renderHook(() => useSearchBooking());

    act(() => result.current.book('anil'));
    expect(result.current.pendingUsername).toBe('anil');
    expect(result.current.open).toBe(false);

    await waitFor(() => expect(result.current.open).toBe(true));
    expect(mockLoad).toHaveBeenCalledWith({ username: 'anil' });
    expect(result.current.launch).toEqual({
      expert: LOADED.expert,
      context: LOADED.context,
      viewerEmailDomain: 'northwind.com',
    });
    expect(result.current.pendingUsername).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('ignores a second click while a load is in flight', async () => {
    let resolve: (value: typeof LOADED) => void = () => {};
    mockLoad.mockReturnValue(new Promise((r) => (resolve = r)));
    const { result } = renderHook(() => useSearchBooking());

    act(() => result.current.book('anil'));
    act(() => result.current.book('freda'));
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(result.current.pendingUsername).toBe('anil');

    await act(async () => resolve(LOADED));
    expect(result.current.open).toBe(true);
  });

  it('closes without dropping the launch, so the dialog can animate out', async () => {
    mockLoad.mockResolvedValue(LOADED);
    const { result } = renderHook(() => useSearchBooking());
    act(() => result.current.book('anil'));
    await waitFor(() => expect(result.current.open).toBe(true));

    act(() => result.current.close());
    expect(result.current.open).toBe(false);
    expect(result.current.launch).not.toBeNull();
  });

  it('asks a signed-out visitor to sign in, then reruns the load and opens', async () => {
    mockLoad.mockResolvedValueOnce({ ok: false, reason: 'signed_out' });
    const { result } = renderHook(() => useSearchBooking());

    act(() => result.current.book('anil'));
    await waitFor(() => expect(mockAuthOpen).toHaveBeenCalledTimes(1));
    expect(result.current.open).toBe(false);
    await waitFor(() => expect(result.current.pendingUsername).toBeNull());

    mockLoad.mockResolvedValueOnce(LOADED);
    const [[options]] = mockAuthOpen.mock.calls as [[{ onSuccess: () => void }]];
    act(() => options.onSuccess());
    expect(mockRefresh).toHaveBeenCalled();

    await waitFor(() => expect(result.current.open).toBe(true));
    expect(mockLoad).toHaveBeenCalledTimes(2);
  });

  it('falls back to the profile deep link when the booking is unavailable here', async () => {
    mockLoad.mockResolvedValue({ ok: false, reason: 'unavailable' });
    const { result } = renderHook(() => useSearchBooking());

    act(() => result.current.book('anil'));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/experts/anil?book=1&src=search'));
    expect(result.current.open).toBe(false);
    expect(result.current.pendingUsername).toBeNull();
  });

  it('reports a failed load and falls back to the profile deep link', async () => {
    const error = new Error('Failed to find Server Action');
    mockLoad.mockRejectedValue(error);
    const { result } = renderHook(() => useSearchBooking());

    act(() => result.current.book('anil'));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/experts/anil?book=1&src=search'));
    expect(mockCapture).toHaveBeenCalledWith(error, {
      tags: { feature: 'booking', step: 'search_launch' },
    });
    expect(result.current.pendingUsername).toBeNull();
  });
});
