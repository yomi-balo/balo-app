import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

vi.mock('@/lib/credit/actions', () => ({
  getWalletMandateStatusAction: vi.fn(),
  getTopUpCreditStatusAction: vi.fn(),
}));

import { getWalletMandateStatusAction } from '@/lib/credit/actions';
import {
  TOPUP_POLL_FAST_INTERVAL_MS,
  TOPUP_POLL_WINDOW_MS,
} from '@/components/billing/top-up/use-topup-credit-poll';
import { useMandateActivePoll } from './use-mandate-active-poll';

const read = vi.mocked(getWalletMandateStatusAction);

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(globalThis.document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  globalThis.document.dispatchEvent(new Event('visibilitychange'));
}

describe('useMandateActivePoll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    read.mockReset();
  });
  afterEach(() => {
    setVisibility('visible');
    vi.useRealTimers();
  });

  it('reads once immediately and is pending until the wallet answers', async () => {
    read.mockResolvedValue({ status: 'pending' });
    const { result } = renderHook(() => useMandateActivePoll());
    expect(result.current).toBe('pending');
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current).toBe('pending');
  });

  it('reports active only when the wallet says active, and stops asking', async () => {
    read.mockResolvedValueOnce({ status: 'pending' }).mockResolvedValue({ status: 'active' });
    const { result } = renderHook(() => useMandateActivePoll());
    await flush();
    expect(result.current).toBe('pending');
    await advance(TOPUP_POLL_FAST_INTERVAL_MS);
    expect(result.current).toBe('active');
    await advance(TOPUP_POLL_FAST_INTERVAL_MS * 3);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('is terminal on failed', async () => {
    read.mockResolvedValue({ status: 'failed' });
    const { result } = renderHook(() => useMandateActivePoll());
    await flush();
    expect(result.current).toBe('failed');
  });

  it('is unconfirmed, not active, on unauthorized', async () => {
    read.mockResolvedValue({ status: 'unauthorized' });
    const { result } = renderHook(() => useMandateActivePoll());
    await flush();
    expect(result.current).toBe('unconfirmed');
  });

  it('spends a tick on an error and on a rejected call, then recovers', async () => {
    read
      .mockResolvedValueOnce({ status: 'error' })
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ status: 'active' });
    const { result } = renderHook(() => useMandateActivePoll());
    await flush();
    await advance(TOPUP_POLL_FAST_INTERVAL_MS);
    expect(result.current).toBe('pending');
    await advance(TOPUP_POLL_FAST_INTERVAL_MS);
    expect(result.current).toBe('active');
  });

  it('gives up as unconfirmed when the window closes while pending', async () => {
    read.mockResolvedValue({ status: 'pending' });
    const { result } = renderHook(() => useMandateActivePoll());
    await flush();
    await advance(TOPUP_POLL_WINDOW_MS + 1_000);
    expect(result.current).toBe('unconfirmed');
  });

  it('pauses while the tab is hidden and reads at once on resume', async () => {
    read.mockResolvedValue({ status: 'pending' });
    renderHook(() => useMandateActivePoll());
    await flush();
    setVisibility('hidden');
    await advance(TOPUP_POLL_FAST_INTERVAL_MS * 3);
    expect(read).toHaveBeenCalledTimes(1);
    setVisibility('visible');
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
