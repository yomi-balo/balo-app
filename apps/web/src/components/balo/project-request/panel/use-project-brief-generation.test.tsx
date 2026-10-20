import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('server-only', () => ({}));

const mockStart = vi.fn();
const mockStartCase = vi.fn();
const mockPoll = vi.fn();
const mockCaptureException = vi.fn();

vi.mock('@/lib/project-request/actions/start-project-brief-parse', () => ({
  startProjectBriefParseAction: (...args: unknown[]) => mockStart(...args),
}));
// BAL-589 — the case arm's start action, mocked the same way as the documents arm's.
vi.mock('@/app/(dashboard)/cases/[engagementId]/_actions/start-case-brief-parse', () => ({
  startCaseBriefParseAction: (...args: unknown[]) => mockStartCase(...args),
}));
vi.mock('@/lib/project-request/actions/get-project-brief-parse', () => ({
  getProjectBriefParseAction: (...args: unknown[]) => mockPoll(...args),
}));
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import {
  useProjectBriefGeneration,
  reportUnexpectedBriefError,
} from './use-project-brief-generation';

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
      await result.current.start({ kind: 'documents', documents: DOCS });
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
      await result.current.start({ kind: 'documents', documents: DOCS });
    });

    expect(result.current.phase).toBe('failed');
    expect(result.current.failureReason).toBe('enqueue_failed');
  });

  // X4c — the action's own `error` string survives onto the hook as `startError`.
  it('a failed start() exposes the action error as `startError`', async () => {
    mockStart.mockResolvedValue({ success: false, error: 'nope' });

    const { result } = renderHook(() => useProjectBriefGeneration({ onSucceeded: vi.fn() }));
    await act(async () => {
      await result.current.start({ kind: 'documents', documents: DOCS });
    });

    expect(result.current.startError).toBe('nope');
  });

  it('startError is null before any start and is cleared by a fresh start()', async () => {
    const { result } = renderHook(() => useProjectBriefGeneration({ onSucceeded: vi.fn() }));
    expect(result.current.startError).toBeNull();

    mockStart.mockResolvedValue({ success: false, error: 'nope' });
    await act(async () => {
      await result.current.start({ kind: 'documents', documents: DOCS });
    });
    expect(result.current.startError).toBe('nope');

    mockStart.mockResolvedValue({ success: true, parseId: 'p1' });
    mockPoll.mockResolvedValue({ status: 'pending' });
    await act(async () => {
      await result.current.start({ kind: 'documents', documents: DOCS });
    });
    expect(result.current.startError).toBeNull();
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
      await result.current.start({ kind: 'documents', documents: DOCS });
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
      await result.current.start({ kind: 'documents', documents: DOCS });
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
      await result.current.start({ kind: 'documents', documents: DOCS });
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
      await result.current.start({ kind: 'documents', documents: DOCS });
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
      await result.current.start({ kind: 'documents', documents: DOCS });
    });

    expect(result.current.phase).toBe('failed');
    expect(result.current.failureReason).toBe('unknown');
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('a thrown start action never leaves the hook `generating`', async () => {
    mockStart.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useProjectBriefGeneration({ onSucceeded: vi.fn() }));
    await act(async () => {
      await result.current.start({ kind: 'documents', documents: DOCS });
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
      await result.current.start({ kind: 'documents', documents: DOCS });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mockPoll).toHaveBeenCalledWith({ parseId: 'p1' });

    // Retry / regenerate — generation 2 starts while generation 1's poll is still in flight.
    await act(async () => {
      await result.current.start({ kind: 'documents', documents: DOCS });
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
      await result.current.start({ kind: 'documents', documents: DOCS });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await act(async () => {
      await result.current.start({ kind: 'documents', documents: DOCS });
    });
    await act(async () => {
      rejectStalePoll(new Error('stale network error'));
      await Promise.resolve();
    });

    expect(result.current.phase).toBe('generating');
    expect(result.current.failureReason).toBeNull();
  });

  // ── W2 — cancel() abandons the generation, not merely its phase ─────────────────────────
  describe('cancel (BAL-254 W2)', () => {
    /** start() a generation and let exactly ONE poll fire. Shared by both cancel tests. */
    async function startAndPollOnce(
      onSucceeded: () => void
    ): Promise<
      ReturnType<typeof renderHook<ReturnType<typeof useProjectBriefGeneration>, unknown>>
    > {
      mockStart.mockResolvedValue({ success: true, parseId: 'p1' });
      const rendered = renderHook(() => useProjectBriefGeneration({ onSucceeded }));
      await act(async () => {
        await rendered.result.current.start({ kind: 'documents', documents: DOCS });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(mockPoll).toHaveBeenCalledTimes(1);
      return rendered;
    }

    it('stops the interval and returns the hook to idle', async () => {
      mockPoll.mockResolvedValue({ status: 'pending' });
      const { result } = await startAndPollOnce(vi.fn());

      act(() => result.current.cancel());
      expect(result.current.phase).toBe('idle');
      expect(result.current.failureReason).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(mockPoll).toHaveBeenCalledTimes(1);
    });

    /**
     * ⚠⚠ THE ASSERTION THAT MATTERS. Clearing the interval alone is not enough: the poll whose
     * promise was ALREADY in flight when the user walked away still resolves. Cancelling clears
     * `parseIdRef`, which is what makes that resolution a no-op — the same generation-identity
     * mechanism `start` relies on (fix round F4).
     */
    it('⚠ a poll already IN FLIGHT at cancel() time cannot call onSucceeded', async () => {
      let releasePoll: ((value: unknown) => void) | undefined;
      mockPoll.mockReturnValueOnce(
        new Promise((resolve) => {
          releasePoll = resolve;
        })
      );
      const onSucceeded = vi.fn();
      const { result } = await startAndPollOnce(onSucceeded);

      act(() => result.current.cancel());

      await act(async () => {
        releasePoll?.({
          status: 'succeeded',
          draft: {
            title: 'T',
            descriptionHtml: '<p>d</p>',
            tagIds: [],
            productIds: [],
            unmatchedTagLabels: [],
            unmatchedProductLabels: [],
          },
        });
        await Promise.resolve();
      });

      expect(onSucceeded).not.toHaveBeenCalled();
      expect(result.current.phase).toBe('idle');
    });
  });

  // cancel() doesn't invalidate a start() whose ACTION call is still pending.
  it('⚠ open, close (cancel), then reopen (start again) while the first start is pending leaves exactly one interval and no forced timed_out', async () => {
    let resolveFirstStart: (value: { success: true; parseId: string }) => void = () => {};
    mockStart
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstStart = resolve;
          })
      )
      .mockResolvedValueOnce({ success: true, parseId: 'p2' });
    mockPoll.mockResolvedValue({ status: 'pending' });

    const { result } = renderHook(() => useProjectBriefGeneration({ onSucceeded: vi.fn() }));

    // Open: kick off the first start — its action call never resolves yet.
    let firstStartSettled = false;
    act(() => {
      result.current
        .start({ kind: 'documents', documents: DOCS })
        .then(() => {
          firstStartSettled = true;
        })
        .catch(() => {});
    });

    // Close: cancel while the first start's action is still in flight.
    act(() => result.current.cancel());

    // Reopen: start again — resolves immediately with a DIFFERENT parseId.
    await act(async () => {
      await result.current.start({ kind: 'documents', documents: DOCS });
    });
    expect(mockPoll).not.toHaveBeenCalled();

    // NOW the first (cancelled) start's action resolves, late.
    await act(async () => {
      resolveFirstStart({ success: true, parseId: 'p1' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(firstStartSettled).toBe(true);

    // Only ONE interval exists — the second start's — and it polls p2, never the stale p1.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mockPoll).toHaveBeenCalledTimes(1);
    expect(mockPoll).toHaveBeenCalledWith({ parseId: 'p2' });

    // An ORPHANED second interval would double every subsequent tick's poll count (and so
    // reach MAX_POLLS — and `timed_out` — in HALF the wall-clock time). Five more ticks must
    // add exactly five more calls, and the hook must still be cleanly `generating`.
    mockPoll.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000 * 5);
    });
    expect(mockPoll).toHaveBeenCalledTimes(5);
    expect(result.current.phase).toBe('generating');
    expect(result.current.failureReason).toBeNull();
  });

  it('dismissFailure resets to idle', async () => {
    mockStart.mockResolvedValue({ success: false, error: 'nope' });
    const { result } = renderHook(() => useProjectBriefGeneration({ onSucceeded: vi.fn() }));
    await act(async () => {
      await result.current.start({ kind: 'documents', documents: DOCS });
    });
    expect(result.current.phase).toBe('failed');

    act(() => result.current.dismissFailure());
    expect(result.current.phase).toBe('idle');
    expect(result.current.failureReason).toBeNull();
  });

  // BAL-589 — the case arm calls the CASE start action, not the documents one, and polling is
  // otherwise identical.
  describe('the case source (BAL-589)', () => {
    const CASE_ID = '22222222-2222-2222-2222-222222222222';

    it('calls startCaseBriefParseAction with the case id, never the documents action', async () => {
      mockStartCase.mockResolvedValue({ success: true, parseId: 'p-case' });
      mockPoll.mockResolvedValue({ status: 'pending' });

      const { result } = renderHook(() => useProjectBriefGeneration({ onSucceeded: vi.fn() }));
      await act(async () => {
        await result.current.start({ kind: 'case', caseId: CASE_ID });
      });

      expect(mockStartCase).toHaveBeenCalledWith({ caseId: CASE_ID });
      expect(mockStart).not.toHaveBeenCalled();
      expect(result.current.phase).toBe('generating');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(mockPoll).toHaveBeenCalledWith({ parseId: 'p-case' });
    });

    it('a failed case start goes straight to failed', async () => {
      mockStartCase.mockResolvedValue({ success: false, error: 'denied' });

      const { result } = renderHook(() => useProjectBriefGeneration({ onSucceeded: vi.fn() }));
      await act(async () => {
        await result.current.start({ kind: 'case', caseId: CASE_ID });
      });

      expect(result.current.phase).toBe('failed');
      expect(result.current.failureReason).toBe('enqueue_failed');
      expect(result.current.startError).toBe('denied');
    });

    it('a thrown case start lands on failed and reports to Sentry', async () => {
      mockStartCase.mockRejectedValue(new Error('session expired'));

      const { result } = renderHook(() => useProjectBriefGeneration({ onSucceeded: vi.fn() }));
      await act(async () => {
        await result.current.start({ kind: 'case', caseId: CASE_ID });
      });

      expect(result.current.phase).toBe('failed');
      expect(result.current.failureReason).toBe('unknown');
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
    });

    it('a case generation that succeeds calls onSucceeded with the draft', async () => {
      mockStartCase.mockResolvedValue({ success: true, parseId: 'p-case' });
      const draft = {
        title: 'From case',
        descriptionHtml: '<p>summary</p>',
        tagIds: [],
        productIds: [],
        unmatchedTagLabels: [],
        unmatchedProductLabels: [],
      };
      mockPoll.mockResolvedValue({ status: 'succeeded', draft });
      const onSucceeded = vi.fn();

      const { result } = renderHook(() => useProjectBriefGeneration({ onSucceeded }));
      await act(async () => {
        await result.current.start({ kind: 'case', caseId: CASE_ID });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(onSucceeded).toHaveBeenCalledWith(draft);
      expect(result.current.phase).toBe('idle');
    });
  });

  // The one caller-side reporting helper for a `start()` that rejects anyway.
  describe('reportUnexpectedBriefError', () => {
    it('reports to Sentry when a caller `.catch`es an unexpectedly rejecting `start`', () => {
      const error = new Error('unexpected');
      reportUnexpectedBriefError(error);
      expect(mockCaptureException).toHaveBeenCalledWith(error);
    });
  });
});
