import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('server-only', () => ({}));

const mockStart = vi.fn();
const mockPoll = vi.fn();
const mockCaptureException = vi.fn();

vi.mock('@/lib/project-request/actions/start-project-brief-parse', () => ({
  startProjectBriefParseAction: (...args: unknown[]) => mockStart(...args),
}));
vi.mock('@/lib/project-request/actions/get-project-brief-parse', () => ({
  getProjectBriefParseAction: (...args: unknown[]) => mockPoll(...args),
}));
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import { useProjectBriefGeneration } from './use-project-brief-generation';

const DOCS = [
  { r2Key: 'k', fileName: 'a.pdf', contentType: 'application/pdf' as const, sizeBytes: 10 },
];

describe('useProjectBriefGeneration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() moves to `generating`, then polls at 2s intervals', async () => {
    mockStart.mockResolvedValue({ success: true, parseId: 'p1' });
    mockPoll.mockResolvedValue({ status: 'pending' });

    const { result } = renderHook(() => useProjectBriefGeneration({ onSucceeded: vi.fn() }));

    await act(async () => {
      await result.current.start(DOCS);
    });
    expect(result.current.phase).toBe('generating');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mockPoll).toHaveBeenCalledWith({ parseId: 'p1' });
  });

  it('a failed start() (no parseId) goes straight to `failed`', async () => {
    mockStart.mockResolvedValue({ success: false, error: 'nope' });

    const { result } = renderHook(() => useProjectBriefGeneration({ onSucceeded: vi.fn() }));
    await act(async () => {
      await result.current.start(DOCS);
    });

    expect(result.current.phase).toBe('failed');
    expect(result.current.failureReason).toBe('enqueue_failed');
  });

  it('stops polling and calls onSucceeded when the poll reports succeeded', async () => {
    mockStart.mockResolvedValue({ success: true, parseId: 'p1' });
    const draft = {
      title: 'T',
      descriptionHtml: '<p>d</p>',
      tagIds: [],
      productIds: [],
      unmatchedTagLabels: [],
      unmatchedProductLabels: [],
    };
    mockPoll.mockResolvedValue({ status: 'succeeded', draft });
    const onSucceeded = vi.fn();

    const { result } = renderHook(() => useProjectBriefGeneration({ onSucceeded }));
    await act(async () => {
      await result.current.start(DOCS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(onSucceeded).toHaveBeenCalledWith(draft);
    expect(result.current.phase).toBe('idle');

    mockPoll.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(mockPoll).not.toHaveBeenCalled();
  });

  it('stops polling and sets `failed` with the reason when the poll reports failed', async () => {
    mockStart.mockResolvedValue({ success: true, parseId: 'p1' });
    mockPoll.mockResolvedValue({ status: 'failed', failureReason: 'unreadable' });

    const { result } = renderHook(() => useProjectBriefGeneration({ onSucceeded: vi.fn() }));
    await act(async () => {
      await result.current.start(DOCS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.phase).toBe('failed');
    expect(result.current.failureReason).toBe('unreadable');
  });

  it('stops at MAX_POLLS (60) with `timed_out`', async () => {
    mockStart.mockResolvedValue({ success: true, parseId: 'p1' });
    mockPoll.mockResolvedValue({ status: 'pending' });

    const { result } = renderHook(() => useProjectBriefGeneration({ onSucceeded: vi.fn() }));
    await act(async () => {
      await result.current.start(DOCS);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000 * 61);
    });

    expect(result.current.phase).toBe('failed');
    expect(result.current.failureReason).toBe('timed_out');
  });

  it('clears the interval on unmount', async () => {
    mockStart.mockResolvedValue({ success: true, parseId: 'p1' });
    mockPoll.mockResolvedValue({ status: 'pending' });

    const { result, unmount } = renderHook(() =>
      useProjectBriefGeneration({ onSucceeded: vi.fn() })
    );
    await act(async () => {
      await result.current.start(DOCS);
    });
    unmount();
    mockPoll.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(mockPoll).not.toHaveBeenCalled();
  });

  // ── F3 — a THROWN start action must land on a terminal phase, never spin forever ──────────
  it('⚠ a start action that THROWS lands on `failed`, reports to Sentry, and never rejects', async () => {
    // `withAuth` throws on an expired session; a repository write throws on a DB error. Before
    // the fix `phase` stayed `generating` forever — no interval existed, so MAX_POLLS could
    // never rescue it.
    mockStart.mockRejectedValue(new Error('session expired'));

    const { result } = renderHook(() => useProjectBriefGeneration({ onSucceeded: vi.fn() }));
    await act(async () => {
      await result.current.start(DOCS);
    });

    expect(result.current.phase).toBe('failed');
    expect(result.current.failureReason).toBe('unknown');
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('a thrown start action never leaves the hook `generating`', async () => {
    mockStart.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useProjectBriefGeneration({ onSucceeded: vi.fn() }));
    await act(async () => {
      await result.current.start(DOCS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000 * 61);
    });
    expect(result.current.phase).not.toBe('generating');
    expect(mockPoll).not.toHaveBeenCalled();
  });

  // ── F4 — a stale poll from a previous generation must not clobber the new one ─────────────
  it('⚠ a poll left over from a PREVIOUS generation neither clears the new interval nor writes fields', async () => {
    const staleDraft = {
      title: 'STALE',
      descriptionHtml: '<p>stale</p>',
      tagIds: [],
      productIds: [],
      unmatchedTagLabels: [],
      unmatchedProductLabels: [],
    };

    mockStart
      .mockResolvedValueOnce({ success: true, parseId: 'p1' })
      .mockResolvedValueOnce({ success: true, parseId: 'p2' });

    // The first generation's poll never settles until this test says so.
    let resolveStalePoll: (value: unknown) => void = () => {};
    mockPoll.mockImplementation((input: { parseId: string }) => {
      if (input.parseId === 'p1') {
        return new Promise((resolve) => {
          resolveStalePoll = resolve;
        });
      }
      return Promise.resolve({ status: 'pending' });
    });

    const onSucceeded = vi.fn();
    const { result } = renderHook(() => useProjectBriefGeneration({ onSucceeded }));

    await act(async () => {
      await result.current.start(DOCS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mockPoll).toHaveBeenCalledWith({ parseId: 'p1' });

    // Retry / regenerate — generation 2 starts while generation 1's poll is still in flight.
    await act(async () => {
      await result.current.start(DOCS);
    });

    // …and NOW the old promise resolves, successfully, with the old draft.
    await act(async () => {
      resolveStalePoll({ status: 'succeeded', draft: staleDraft });
      await Promise.resolve();
    });

    // It wrote nothing, and it did not settle the hook.
    expect(onSucceeded).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('generating');

    // And the NEW interval is still alive — this is the half that `clearPolling()` used to kill.
    mockPoll.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mockPoll).toHaveBeenCalledWith({ parseId: 'p2' });
  });

  it('a stale poll that FAILS also cannot settle the new generation', async () => {
    mockStart
      .mockResolvedValueOnce({ success: true, parseId: 'p1' })
      .mockResolvedValueOnce({ success: true, parseId: 'p2' });

    let rejectStalePoll: (reason: unknown) => void = () => {};
    mockPoll.mockImplementation((input: { parseId: string }) => {
      if (input.parseId === 'p1') {
        return new Promise((_resolve, reject) => {
          rejectStalePoll = reject;
        });
      }
      return Promise.resolve({ status: 'pending' });
    });

    const { result } = renderHook(() => useProjectBriefGeneration({ onSucceeded: vi.fn() }));
    await act(async () => {
      await result.current.start(DOCS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await act(async () => {
      await result.current.start(DOCS);
    });
    await act(async () => {
      rejectStalePoll(new Error('stale network error'));
      await Promise.resolve();
    });

    expect(result.current.phase).toBe('generating');
    expect(result.current.failureReason).toBeNull();
  });

  it('dismissFailure resets to idle', async () => {
    mockStart.mockResolvedValue({ success: false, error: 'nope' });
    const { result } = renderHook(() => useProjectBriefGeneration({ onSucceeded: vi.fn() }));
    await act(async () => {
      await result.current.start(DOCS);
    });
    expect(result.current.phase).toBe('failed');

    act(() => result.current.dismissFailure());
    expect(result.current.phase).toBe('idle');
    expect(result.current.failureReason).toBeNull();
  });
});
