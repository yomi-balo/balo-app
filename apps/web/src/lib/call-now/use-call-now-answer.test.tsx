import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { CALL_NOW_EVENTS } from '@balo/analytics/events';
import { track } from '@/lib/analytics';
import { markAnswerIntent } from './answer-intent';
import { CALL_NOW_COPY, START_FAILURE_COPY } from './call-now-copy';

const { mockAnswerAction, mockReadAnswerView, mockPush, mockToast, mockToastError } = vi.hoisted(
  () => ({
    mockAnswerAction: vi.fn(),
    mockReadAnswerView: vi.fn(),
    mockPush: vi.fn(),
    mockToast: vi.fn(),
    mockToastError: vi.fn(),
  })
);

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));
vi.mock('sonner', () => ({ toast: Object.assign(mockToast, { error: mockToastError }) }));
vi.mock('@/app/(call)/meetings/[meetingId]/call/_actions/answer-call-now-ring', () => ({
  answerCallNowRingAction: mockAnswerAction,
}));
vi.mock('@/app/(call)/meetings/[meetingId]/call/_actions/read-call-now-answer-view', () => ({
  readCallNowAnswerViewAction: mockReadAnswerView,
}));

import { useCallNowAnswer } from './use-call-now-answer';

const RING_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const ENGAGEMENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EXPERT_PROFILE_ID = '88888888-8888-4888-8888-888888888888';
const GRANT = { roomUrl: 'https://balo.daily.co/x', token: 'jwt', isOwner: false };

const FUNDING_REFUSAL = {
  ok: false,
  code: 'funding',
  fundingCode: 'booking_reserved',
  engagementId: ENGAGEMENT_ID,
  expertProfileId: EXPERT_PROFILE_ID,
};

function setup() {
  const options = {
    meetingId: MEETING_ID,
    onOpened: vi.fn(),
    onFunding: vi.fn(),
    onRequired: vi.fn(),
    onAwaitConnect: vi.fn(),
    onConnecting: vi.fn(),
    onUnavailable: vi.fn(),
  };
  const hook = renderHook(() => useCallNowAnswer(options));
  return { ...hook, options };
}

function gateEvents(): unknown[][] {
  return vi
    .mocked(track)
    .mock.calls.filter(([event]) => event === CALL_NOW_EVENTS.FUNDING_GATE_RESOLVED);
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.sessionStorage.clear();
  mockReadAnswerView.mockResolvedValue({ kind: 'answer', callerName: 'Dana', rateLine: null });
});

describe('useCallNowAnswer — who is offered Answer', () => {
  it('the ring’s callee gets the notice facts and the Answer notice', async () => {
    mockReadAnswerView.mockResolvedValue({
      kind: 'answer',
      callerName: 'Dana',
      rateLine: 'From A$3.75/min · 15-minute minimum',
    });
    const { result, options } = setup();

    await act(async () => result.current.offerAnswer(RING_ID));

    expect(mockReadAnswerView).toHaveBeenCalledWith({ ringId: RING_ID, meetingId: MEETING_ID });
    expect(result.current.answerRingId).toBe(RING_ID);
    expect(result.current.answerNotice).toEqual({
      callerName: 'Dana',
      rateLine: 'From A$3.75/min · 15-minute minimum',
    });
    expect(options.onRequired).toHaveBeenCalledTimes(1);
    expect(options.onAwaitConnect).not.toHaveBeenCalled();
    expect(mockAnswerAction).not.toHaveBeenCalled();
  });

  it('⚠ anyone else waits: no ring is armed, no notice, nothing committed', async () => {
    mockReadAnswerView.mockResolvedValue({ kind: 'wait' });
    const { result, options } = setup();

    await act(async () => result.current.offerAnswer(RING_ID));

    expect(options.onAwaitConnect).toHaveBeenCalledTimes(1);
    expect(options.onRequired).not.toHaveBeenCalled();
    expect(result.current.answerRingId).toBeNull();
    expect(result.current.answerNotice).toBeNull();
    result.current.handleAnswer();
    expect(mockAnswerAction).not.toHaveBeenCalled();
  });

  it('⚠ a failed read is the neutral connecting wait, never "someone else’s call"', async () => {
    mockReadAnswerView.mockResolvedValue({ kind: 'retry' });
    const { result, options } = setup();

    await act(async () => result.current.offerAnswer(RING_ID));

    expect(options.onConnecting).toHaveBeenCalledTimes(1);
    expect(options.onAwaitConnect).not.toHaveBeenCalled();
    expect(options.onRequired).not.toHaveBeenCalled();
    expect(result.current.answerRingId).toBeNull();
  });

  it('⚠ a read that throws is the neutral connecting wait as well', async () => {
    mockReadAnswerView.mockRejectedValue(new Error('transport'));
    const { result, options } = setup();

    await act(async () => result.current.offerAnswer(RING_ID));

    expect(options.onConnecting).toHaveBeenCalledTimes(1);
    expect(options.onAwaitConnect).not.toHaveBeenCalled();
    expect(options.onUnavailable).not.toHaveBeenCalled();
  });

  it('asks again on the next attempt, so a real callee recovers to Answer', async () => {
    mockReadAnswerView.mockResolvedValueOnce({ kind: 'retry' });
    const { result, options } = setup();

    await act(async () => result.current.offerAnswer(RING_ID));
    await act(async () => result.current.offerAnswer(RING_ID));

    expect(mockReadAnswerView).toHaveBeenCalledTimes(2);
    expect(options.onConnecting).toHaveBeenCalledTimes(1);
    expect(options.onRequired).toHaveBeenCalledTimes(1);
    expect(result.current.answerNotice).toEqual({ callerName: 'Dana', rateLine: null });
  });

  it('a join that named no ring is unavailable, and asks nothing', () => {
    const { result, options } = setup();

    result.current.offerAnswer(undefined);

    expect(options.onUnavailable).toHaveBeenCalledTimes(1);
    expect(mockReadAnswerView).not.toHaveBeenCalled();
  });
});

describe('useCallNowAnswer — the funding gate', () => {
  it('⚠ a funding refusal names the RING to the pre-flight — never a meeting id — and carries the api’s code', async () => {
    mockAnswerAction.mockResolvedValue(FUNDING_REFUSAL);
    const { result, options } = setup();

    let opened = true;
    await act(async () => {
      opened = await result.current.commitAnswer(RING_ID);
    });

    expect(opened).toBe(false);
    expect(options.onFunding).toHaveBeenCalledTimes(1);
    expect(result.current.answerFunding).toMatchObject({
      ringId: RING_ID,
      engagementId: ENGAGEMENT_ID,
      fundingCode: 'booking_reserved',
      request: {
        expertProfileId: EXPERT_PROFILE_ID,
        ringId: RING_ID,
        caseChoice: { kind: 'existing', engagementId: ENGAGEMENT_ID },
      },
    });
  });

  it('⚠ the funding state carries no api figure and no meeting id', async () => {
    mockAnswerAction.mockResolvedValue(FUNDING_REFUSAL);
    const { result } = setup();

    await act(async () => {
      await result.current.commitAnswer(RING_ID);
    });

    expect(result.current.answerFunding).not.toHaveProperty('suggestedTopUpMinor');
    expect(result.current.answerFunding?.request).not.toHaveProperty('excludeMeetingId');
  });

  it('a top-up that lets the answer through reports the gate resolved once, as top_up', async () => {
    mockAnswerAction.mockResolvedValueOnce(FUNDING_REFUSAL);
    mockAnswerAction.mockResolvedValueOnce({ ok: true, grant: GRANT });
    const { result, options } = setup();

    await act(async () => {
      await result.current.commitAnswer(RING_ID);
    });
    await act(async () => {
      await result.current.commitAnswer(RING_ID);
    });

    expect(options.onOpened).toHaveBeenCalledWith(GRANT);
    expect(result.current.answerFunding).toBeNull();
    expect(gateEvents()).toEqual([[CALL_NOW_EVENTS.FUNDING_GATE_RESOLVED, { via: 'top_up' }]]);
  });
});

describe('useCallNowAnswer — transient failures (R7)', () => {
  it.each(['failed', 'rate_limited', 'funding_unavailable'] as const)(
    '⚠ %s toasts and changes nothing: no phase callback, no navigation, no gate report',
    async (code) => {
      mockAnswerAction.mockResolvedValue({ ok: false, code });
      const { result, options } = setup();

      let opened = true;
      await act(async () => {
        opened = await result.current.commitAnswer(RING_ID);
      });

      expect(opened).toBe(false);
      expect(mockToastError).toHaveBeenCalledWith(START_FAILURE_COPY[code]);
      expect(options.onUnavailable).not.toHaveBeenCalled();
      expect(options.onFunding).not.toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalled();
      expect(gateEvents()).toEqual([]);
    }
  );

  it('⚠ a failure while the gate is open leaves it open, and a later real exit still reports it once', async () => {
    mockAnswerAction.mockResolvedValueOnce(FUNDING_REFUSAL);
    mockAnswerAction.mockResolvedValueOnce({ ok: false, code: 'failed' });
    const { result } = setup();

    await act(async () => {
      await result.current.commitAnswer(RING_ID);
    });
    await act(async () => {
      await result.current.commitAnswer(RING_ID);
    });
    expect(gateEvents()).toEqual([]);

    act(() => result.current.handleFundingBack());

    expect(gateEvents()).toEqual([[CALL_NOW_EVENTS.FUNDING_GATE_RESOLVED, { via: 'abandoned' }]]);
    expect(mockPush).toHaveBeenCalledWith(`/cases/${ENGAGEMENT_ID}`);
  });
});

describe('useCallNowAnswer — the true exits', () => {
  it('a ring no longer ringing names the caller in the toast and goes back to the case', async () => {
    mockAnswerAction.mockResolvedValue({
      ok: false,
      code: 'ring_not_ringing',
      engagementId: ENGAGEMENT_ID,
    });
    const { result } = setup();
    await act(async () => result.current.offerAnswer(RING_ID));

    await act(async () => {
      await result.current.commitAnswer(RING_ID);
    });

    expect(mockToast).toHaveBeenCalledWith(CALL_NOW_COPY.answerEndedToast('Dana'));
    expect(mockPush).toHaveBeenCalledWith(`/cases/${ENGAGEMENT_ID}`);
    expect(document.body.textContent ?? '').not.toMatch(/Your expert/);
    expect(gateEvents()).toEqual([]);
  });

  it('⚠ a ring that lapses during a top-up resolves the gate as top_up and says the credit was added', async () => {
    mockAnswerAction.mockResolvedValueOnce(FUNDING_REFUSAL);
    mockAnswerAction.mockResolvedValueOnce({
      ok: false,
      code: 'ring_not_ringing',
      engagementId: ENGAGEMENT_ID,
    });
    const { result } = setup();
    await act(async () => result.current.offerAnswer(RING_ID));

    await act(async () => {
      await result.current.commitAnswer(RING_ID);
    });
    await act(async () => {
      await result.current.commitAnswer(RING_ID);
    });

    expect(gateEvents()).toEqual([[CALL_NOW_EVENTS.FUNDING_GATE_RESOLVED, { via: 'top_up' }]]);
    expect(mockToast).toHaveBeenCalledWith(CALL_NOW_COPY.answerEndedAfterTopUpToast('Dana'));
    expect(mockToast).not.toHaveBeenCalledWith(CALL_NOW_COPY.answerEndedToast('Dana'));
    expect(mockPush).toHaveBeenCalledWith(`/cases/${ENGAGEMENT_ID}`);
  });

  it.each(['unavailable', 'impersonation_refused', 'session_expired', 'invalid'] as const)(
    '%s is the unavailable card',
    async (code) => {
      mockAnswerAction.mockResolvedValue({ ok: false, code });
      const { result, options } = setup();

      await act(async () => {
        await result.current.commitAnswer(RING_ID);
      });

      expect(options.onUnavailable).toHaveBeenCalledTimes(1);
    }
  );

  it('the Answer click commits the armed ring once and shows it is answering meanwhile', async () => {
    mockAnswerAction.mockResolvedValue({ ok: true, grant: GRANT });
    const { result, options } = setup();
    await act(async () => result.current.offerAnswer(RING_ID));

    await act(async () => {
      result.current.handleAnswer();
    });

    expect(mockAnswerAction).toHaveBeenCalledWith({ ringId: RING_ID });
    expect(options.onOpened).toHaveBeenCalledWith(GRANT);
    expect(result.current.answering).toBe(false);
  });

  it('a commit that throws is the unavailable card', async () => {
    mockAnswerAction.mockRejectedValue(new Error('boom'));
    const { result, options } = setup();
    await act(async () => result.current.offerAnswer(RING_ID));

    await act(async () => {
      result.current.handleAnswer();
    });

    expect(options.onUnavailable).toHaveBeenCalledTimes(1);
  });

  it('funding "Book a time" goes to the case with the booking open', async () => {
    mockAnswerAction.mockResolvedValue(FUNDING_REFUSAL);
    const { result } = setup();
    await act(async () => {
      await result.current.commitAnswer(RING_ID);
    });

    act(() => result.current.handleFundingBook());

    expect(mockPush).toHaveBeenCalledWith(`/cases/${ENGAGEMENT_ID}?book=1`);
  });
});

describe('useCallNowAnswer — the toast Join answer intent', () => {
  it('a matching intent commits the answer without the Answer click', async () => {
    mockAnswerAction.mockResolvedValue({ ok: true, grant: GRANT });
    markAnswerIntent({ meetingId: MEETING_ID, ringId: RING_ID });
    const { result, options } = setup();

    await act(async () => result.current.offerAnswer(RING_ID));

    expect(mockAnswerAction).toHaveBeenCalledTimes(1);
    expect(mockAnswerAction).toHaveBeenCalledWith({ ringId: RING_ID });
    expect(options.onOpened).toHaveBeenCalledWith(GRANT);
  });

  it('keeps offerAnswer stable across a rerender with new onOpened and onFunding', () => {
    const options = {
      meetingId: MEETING_ID,
      onOpened: vi.fn(),
      onFunding: vi.fn(),
      onRequired: vi.fn(),
      onAwaitConnect: vi.fn(),
      onConnecting: vi.fn(),
      onUnavailable: vi.fn(),
    };
    const { result, rerender } = renderHook((props) => useCallNowAnswer(props), {
      initialProps: options,
    });
    const first = result.current.offerAnswer;
    rerender({ ...options, onOpened: vi.fn(), onFunding: vi.fn() });
    expect(result.current.offerAnswer).toBe(first);
  });

  it('an intent for another ring leaves the Answer notice and commits nothing', async () => {
    markAnswerIntent({ meetingId: MEETING_ID, ringId: 'another-ring' });
    const { result, options } = setup();

    await act(async () => result.current.offerAnswer(RING_ID));

    expect(mockAnswerAction).not.toHaveBeenCalled();
    expect(options.onRequired).toHaveBeenCalledTimes(1);
    expect(result.current.answerRingId).toBe(RING_ID);
  });

  it('an expired intent leaves the Answer notice and commits nothing', async () => {
    markAnswerIntent({ meetingId: MEETING_ID, ringId: RING_ID }, Date.now() - 120_000);
    const { result } = setup();

    await act(async () => result.current.offerAnswer(RING_ID));

    expect(mockAnswerAction).not.toHaveBeenCalled();
    expect(result.current.answerNotice).not.toBeNull();
  });

  it('a commit that throws on the intent path is the unavailable card', async () => {
    mockAnswerAction.mockRejectedValue(new Error('boom'));
    markAnswerIntent({ meetingId: MEETING_ID, ringId: RING_ID });
    const { result, options } = setup();

    await act(async () => result.current.offerAnswer(RING_ID));

    expect(options.onUnavailable).toHaveBeenCalledTimes(1);
  });
});
