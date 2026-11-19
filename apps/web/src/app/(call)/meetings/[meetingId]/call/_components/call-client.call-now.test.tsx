import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CALL_NOW_EVENTS } from '@balo/analytics/events';
import { track } from '@/lib/analytics';
import { CALL_NOW_COPY, START_FAILURE_COPY } from '@/lib/call-now/call-now-copy';
import type { CallNowCallerView } from '@/lib/call-now/call-now-types';
import { MEMBER_JOIN_UNAVAILABLE_TITLE } from '@/lib/meetings/lobby';
import { useMeetingRoute } from '@/lib/meetings/meeting-route-context';

/**
 * BAL-651 — the call room's Call now seams: the caller's "Calling" view, its two end states, the
 * Stop action, and the client's answer commit (the join click IS the answer on an expert-started
 * ring). The ordinary join path stays in `call-client.test.tsx`.
 */

const {
  mockJoinAsMemberAction,
  mockAnswerCallNowRingAction,
  mockReadAnswerView,
  mockUseCallNowRing,
  mockStop,
  mockPush,
  mockToast,
  mockToastSuccess,
  mockToastError,
  mockRouter,
} = vi.hoisted(() => {
  const push = vi.fn();
  return {
    mockPush: push,
    // One identity for every render: an effect keyed on the router must not re-fire per render.
    mockRouter: { push, replace: vi.fn() },
    mockJoinAsMemberAction: vi.fn(),
    mockAnswerCallNowRingAction: vi.fn(),
    mockReadAnswerView: vi.fn(),
    mockUseCallNowRing: vi.fn(),
    mockStop: vi.fn(),
    mockToast: vi.fn(),
    mockToastSuccess: vi.fn(),
    mockToastError: vi.fn(),
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
}));
vi.mock('sonner', () => ({
  toast: Object.assign(mockToast, { success: mockToastSuccess, error: mockToastError }),
}));
vi.mock('@/app/join/_actions/join-as-member', () => ({
  joinAsMemberAction: mockJoinAsMemberAction,
}));
vi.mock('../_actions/answer-call-now-ring', () => ({
  answerCallNowRingAction: mockAnswerCallNowRingAction,
}));
vi.mock('../_actions/read-call-now-answer-view', () => ({
  readCallNowAnswerViewAction: mockReadAnswerView,
}));
vi.mock('@/lib/call-now/use-call-now-surface', () => ({
  useCallNowSurface: () => 'desktop',
}));
vi.mock('@/lib/call-now/use-call-now-ring', () => ({
  useCallNowRing: (ring: unknown) => mockUseCallNowRing(ring),
}));
vi.mock('@/components/balo/meetings/meeting-frame', () => ({ preloadMeetingFrame: vi.fn() }));
vi.mock('../_actions/get-meeting-state', () => ({
  getMeetingStateAction: vi.fn().mockResolvedValue({ success: false, retryable: false }),
}));
vi.mock('../_actions/get-meeting-drawdown-state', () => ({
  getMeetingDrawdownStateAction: vi.fn().mockResolvedValue({ success: true, state: null }),
}));

/** The surface stands in as a route-context probe, as in `call-client.test.tsx`. */
vi.mock('@/components/balo/meetings/meeting-call-surface', () => ({
  MeetingCallSurface: (props: Record<string, unknown>) => {
    const route = useMeetingRoute();
    return (
      <div
        data-testid="surface"
        data-room-url={String(props.roomUrl)}
        data-calling={route.calling === null ? 'none' : 'present'}
        data-calling-arm={route.calling?.copyArm ?? ''}
        data-calling-label={route.calling?.calleeLabel ?? ''}
        data-calling-reached-by={route.calling?.reachedBy ?? ''}
        data-calling-seconds={String(route.calling?.remainingSeconds ?? '')}
      >
        <button type="button" onClick={route.calling?.onStop}>
          probe stop
        </button>
      </div>
    );
  },
}));

vi.mock('@/components/balo/call-now/call-now-funding-step', () => ({
  CallNowFundingStep: (props: {
    callerLens: string;
    fundingCode: string;
    context?: string;
    request: {
      expertProfileId: string;
      ringId?: string;
      caseChoice: { kind: string; engagementId?: string };
    };
    onFunded: () => Promise<boolean>;
    onBack: () => void;
    onBookInstead: (() => void) | null;
  }) => (
    <div
      data-testid="funding-step"
      data-caller-lens={props.callerLens}
      data-funding-code={props.fundingCode}
      data-context={props.context ?? ''}
      data-ring={props.request.ringId ?? ''}
      data-has-suggested={String('suggestedTopUpMinor' in props)}
      data-has-exclude={String('excludeMeetingId' in props.request)}
      data-expert={props.request.expertProfileId}
      data-engagement={props.request.caseChoice.engagementId ?? ''}
    >
      <button
        type="button"
        onClick={() => {
          props.onFunded().catch(() => undefined);
        }}
      >
        funded
      </button>
      <button type="button" onClick={props.onBack}>
        funding back
      </button>
      <button type="button" onClick={() => props.onBookInstead?.()}>
        funding book
      </button>
    </div>
  ),
}));

import { CallClient } from './call-client';

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const RING_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const ENGAGEMENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EXPERT_PROFILE_ID = '88888888-8888-4888-8888-888888888888';
const ATTEMPT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const AWAIT_RETRY_MS = 5_000;
const RATE_LINE = 'From A$3.75/min · 15-minute minimum';
const ANSWER_VIEW = { kind: 'answer', callerName: 'Dana', rateLine: RATE_LINE };

const GRANT = {
  roomUrl: 'https://balo.daily.co/x',
  token: 'daily.jwt',
  isOwner: false,
  expiresAt: '2026-09-02T11:00:00.000Z',
  participantId: 'u0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d',
};

const CALLER: CallNowCallerView = {
  ringId: RING_ID,
  engagementId: ENGAGEMENT_ID,
  meetingId: MEETING_ID,
  calleeLabel: 'Dana',
  copyArm: 'client',
  bookInPage: true,
  status: 'ringing',
  expiresAtIso: '2026-09-02T10:00:45.000Z',
  reachedBy: 'sms',
  attemptId: ATTEMPT_ID,
  calleePresence: 'online',
};

interface RingState {
  status: string | null;
  remainingSeconds: number | null;
  lost: boolean;
  stopping: boolean;
}

function ringState(overrides: Partial<RingState> = {}): void {
  mockUseCallNowRing.mockReturnValue({
    status: 'ringing',
    remainingSeconds: 31,
    lost: false,
    stopping: false,
    stop: mockStop,
    ...overrides,
  });
}

function renderClient(callNowCaller: CallNowCallerView | null = null): void {
  render(
    <CallClient
      meetingId={MEETING_ID}
      viewerName="Dana Okoro"
      joinLinkUrl={`https://balo.test/join/m/${MEETING_ID}`}
      hasChat={false}
      isRealtimeEnabled={false}
      chatChannelName={null}
      typingChannelName={null}
      hasBalance={false}
      callNowCaller={callNowCaller}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockJoinAsMemberAction.mockResolvedValue({ success: true, grant: GRANT });
  mockStop.mockResolvedValue({ ok: true, status: 'stopped' });
  mockReadAnswerView.mockResolvedValue(ANSWER_VIEW);
  ringState({ status: null, remainingSeconds: null });
});

describe('CallClient — the caller’s ring (BAL-651)', () => {
  it('seeds the ring hook from the verified caller view', async () => {
    ringState();
    renderClient(CALLER);

    await screen.findByTestId('surface');
    expect(mockUseCallNowRing).toHaveBeenCalledWith({
      ringId: RING_ID,
      status: 'ringing',
      expiresAtIso: CALLER.expiresAtIso,
    });
  });

  it('hands the stage a calling view while the ring is out', async () => {
    ringState({ remainingSeconds: 31 });
    renderClient(CALLER);

    const surface = await screen.findByTestId('surface');
    expect(surface).toHaveAttribute('data-calling', 'present');
    expect(surface).toHaveAttribute('data-calling-arm', 'client');
    expect(surface).toHaveAttribute('data-calling-label', 'Dana');
    expect(surface).toHaveAttribute('data-calling-reached-by', 'sms');
    expect(surface).toHaveAttribute('data-calling-seconds', '31');
  });

  it('drops the calling view once the ring connects', async () => {
    ringState({ status: 'connected', remainingSeconds: null });
    renderClient(CALLER);

    expect(await screen.findByTestId('surface')).toHaveAttribute('data-calling', 'none');
  });

  it('⚠ an ordinary join has no calling view and no ring', async () => {
    renderClient(null);

    expect(await screen.findByTestId('surface')).toHaveAttribute('data-calling', 'none');
    expect(mockUseCallNowRing).toHaveBeenCalledWith(null);
  });
});

describe('CallClient — Stop calling', () => {
  it('a real stop toasts, tracks the abandon and never claims a charge', async () => {
    ringState();
    renderClient(CALLER);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'probe stop' }));

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith(CALL_NOW_COPY.stoppedToast));
    expect(track).toHaveBeenCalledWith(CALL_NOW_EVENTS.ABANDONED, {
      attempt_id: ATTEMPT_ID,
      lens: 'client',
      callee_presence: 'online',
      step: 'calling',
      via: 'stop_calling',
      surface: 'desktop',
    });
  });

  it('a ring with no persisted attempt id stops without an abandon event', async () => {
    ringState();
    renderClient({ ...CALLER, attemptId: null });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'probe stop' }));

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith(CALL_NOW_COPY.stoppedToast));
    expect(track).not.toHaveBeenCalledWith(CALL_NOW_EVENTS.ABANDONED, expect.anything());
  });

  it('⚠ a stop that loses a race to a connect says nothing and stays in the room', async () => {
    mockStop.mockResolvedValue({ ok: true, status: 'connected' });
    ringState();
    renderClient(CALLER);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'probe stop' }));

    await waitFor(() => expect(mockStop).toHaveBeenCalledTimes(1));
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalledWith(CALL_NOW_EVENTS.ABANDONED, expect.anything());
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('a failed stop toasts the generic failure and stays', async () => {
    mockStop.mockResolvedValue({ ok: false });
    ringState();
    renderClient(CALLER);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'probe stop' }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(START_FAILURE_COPY.failed));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('a stopped ring leaves for the case', async () => {
    ringState({ status: 'stopped', remainingSeconds: null });
    renderClient(CALLER);

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/cases/${ENGAGEMENT_ID}`));
  });

  it('⚠ a ring the room lost track of toasts once and leaves for the case, never sits on Calling', async () => {
    ringState({ lost: true });
    renderClient(CALLER);

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/cases/${ENGAGEMENT_ID}`));
    expect(mockToastError).toHaveBeenCalledWith(CALL_NOW_COPY.ringLostToast);
    expect(mockToastError).toHaveBeenCalledTimes(1);
  });

  it('does not leave while the ring is still being read', async () => {
    ringState({ lost: false });
    renderClient(CALLER);

    await screen.findByTestId('surface');
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
  });
});

describe('CallClient — the ring ends without a call', () => {
  it('⚠ unanswered shows the end card in place of the frame, ahead of the join', async () => {
    mockJoinAsMemberAction.mockReturnValue(new Promise(() => {}));
    ringState({ status: 'unanswered', remainingSeconds: null });
    renderClient(CALLER);

    expect(
      await screen.findByRole('heading', { name: CALL_NOW_COPY.noAnswerTitle('Dana') })
    ).toBeInTheDocument();
    expect(screen.queryByTestId('surface')).toBeNull();
    expect(screen.getByText(CALL_NOW_COPY.noAnswerClient('Dana'))).toBeInTheDocument();
  });

  it('declined shows its own title', async () => {
    ringState({ status: 'declined', remainingSeconds: null });
    renderClient(CALLER);

    expect(
      await screen.findByRole('heading', { name: CALL_NOW_COPY.declinedTitle('Dana') })
    ).toBeInTheDocument();
    expect(screen.queryByTestId('surface')).toBeNull();
  });

  it('offers Book a time (client, bookable) and the way back to the case', async () => {
    ringState({ status: 'unanswered', remainingSeconds: null });
    renderClient(CALLER);

    expect(await screen.findByRole('link', { name: CALL_NOW_COPY.bookInstead })).toHaveAttribute(
      'href',
      `/cases/${ENGAGEMENT_ID}?book=1`
    );
    expect(screen.getByRole('link', { name: CALL_NOW_COPY.backToCase })).toHaveAttribute(
      'href',
      `/cases/${ENGAGEMENT_ID}`
    );
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
  });
});

function resolvedGateEvents(): unknown[][] {
  return vi
    .mocked(track)
    .mock.calls.filter(([event]) => event === CALL_NOW_EVENTS.FUNDING_GATE_RESOLVED);
}

const FUNDING_REFUSAL = {
  ok: false,
  code: 'funding',
  fundingCode: 'booking_unfunded',
  engagementId: ENGAGEMENT_ID,
  expertProfileId: EXPERT_PROFILE_ID,
};

describe('CallClient — the answer commit', () => {
  const ANSWER_REQUIRED = { success: false, reason: 'answer_required', ringId: RING_ID };

  async function clickAnswer(): Promise<void> {
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: CALL_NOW_COPY.answerAction }));
  }

  it('⚠⚠ answer_required alone commits nothing: the Answer notice waits for a click', async () => {
    mockJoinAsMemberAction.mockResolvedValue(ANSWER_REQUIRED);
    renderClient();

    expect(
      await screen.findByRole('heading', { name: CALL_NOW_COPY.answerTitle('Dana') })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: CALL_NOW_COPY.answerAction })).toBeEnabled();
    expect(mockAnswerCallNowRingAction).not.toHaveBeenCalled();
    expect(screen.queryByTestId('surface')).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('⚠ the Answer notice names the caller, quotes the rate and the minimum, and never says "Your expert"', async () => {
    mockJoinAsMemberAction.mockResolvedValue(ANSWER_REQUIRED);
    renderClient();

    await screen.findByRole('heading', { name: CALL_NOW_COPY.answerTitle('Dana') });

    expect(mockReadAnswerView).toHaveBeenCalledWith({ ringId: RING_ID, meetingId: MEETING_ID });
    expect(screen.getByText(CALL_NOW_COPY.clientTerms(RATE_LINE))).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/Your expert/);
  });

  it('a rate that cannot be quoted still shows the timer line', async () => {
    mockJoinAsMemberAction.mockResolvedValue(ANSWER_REQUIRED);
    mockReadAnswerView.mockResolvedValue({ kind: 'answer', callerName: 'Dana', rateLine: null });
    renderClient();

    expect(await screen.findByText(CALL_NOW_COPY.clientTermsNoRate)).toBeInTheDocument();
  });

  it('⚠ the Answer click commits the ring once and opens the room — never the case', async () => {
    mockJoinAsMemberAction.mockResolvedValue(ANSWER_REQUIRED);
    mockAnswerCallNowRingAction.mockResolvedValue({ ok: true, grant: GRANT });
    renderClient();

    await clickAnswer();

    expect(await screen.findByTestId('surface')).toHaveAttribute('data-room-url', GRANT.roomUrl);
    expect(mockAnswerCallNowRingAction).toHaveBeenCalledTimes(1);
    expect(mockAnswerCallNowRingAction).toHaveBeenCalledWith({ ringId: RING_ID });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('a refusal for credit opens the funding step for the expert-started ring', async () => {
    mockJoinAsMemberAction.mockResolvedValue(ANSWER_REQUIRED);
    mockAnswerCallNowRingAction.mockResolvedValue({
      ok: false,
      code: 'funding',
      fundingCode: 'booking_unfunded',
      engagementId: ENGAGEMENT_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });
    renderClient();
    await clickAnswer();

    const step = await screen.findByTestId('funding-step');
    expect(step).toHaveAttribute('data-caller-lens', 'expert');
    expect(step).toHaveAttribute('data-expert', EXPERT_PROFILE_ID);
    expect(step).toHaveAttribute('data-engagement', ENGAGEMENT_ID);
    expect(screen.queryByTestId('surface')).toBeNull();
  });

  it('⚠ the funding step speaks answering and names the ring, never a meeting or a figure', async () => {
    mockJoinAsMemberAction.mockResolvedValue(ANSWER_REQUIRED);
    mockAnswerCallNowRingAction.mockResolvedValue({
      ok: false,
      code: 'funding',
      fundingCode: 'booking_reserved',
      engagementId: ENGAGEMENT_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });
    renderClient();
    await clickAnswer();

    const step = await screen.findByTestId('funding-step');
    expect(step).toHaveAttribute('data-funding-code', 'booking_reserved');
    expect(step).toHaveAttribute('data-context', 'answer');
    expect(step).toHaveAttribute('data-ring', RING_ID);
    expect(step).toHaveAttribute('data-has-suggested', 'false');
    expect(step).toHaveAttribute('data-has-exclude', 'false');
  });

  it('funded re-answers and opens the room', async () => {
    mockJoinAsMemberAction.mockResolvedValue(ANSWER_REQUIRED);
    mockAnswerCallNowRingAction.mockResolvedValueOnce({
      ok: false,
      code: 'funding',
      fundingCode: 'account_on_hold',
      engagementId: ENGAGEMENT_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });
    mockAnswerCallNowRingAction.mockResolvedValueOnce({ ok: true, grant: GRANT });
    renderClient();
    await clickAnswer();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'funded' }));

    expect(await screen.findByTestId('surface')).toHaveAttribute('data-room-url', GRANT.roomUrl);
    expect(mockAnswerCallNowRingAction).toHaveBeenCalledTimes(2);
  });

  it('⚠ a top-up that lets the re-answer through resolves the funding gate once, as top_up', async () => {
    mockJoinAsMemberAction.mockResolvedValue(ANSWER_REQUIRED);
    mockAnswerCallNowRingAction.mockResolvedValueOnce(FUNDING_REFUSAL);
    mockAnswerCallNowRingAction.mockResolvedValueOnce({ ok: true, grant: GRANT });
    renderClient();
    await clickAnswer();

    await userEvent.setup().click(await screen.findByRole('button', { name: 'funded' }));
    await screen.findByTestId('surface');

    expect(resolvedGateEvents()).toEqual([
      [CALL_NOW_EVENTS.FUNDING_GATE_RESOLVED, { via: 'top_up' }],
    ]);
  });

  it('⚠ the call room never emits the gate-shown event (the step owns it)', async () => {
    mockJoinAsMemberAction.mockResolvedValue(ANSWER_REQUIRED);
    mockAnswerCallNowRingAction.mockResolvedValue(FUNDING_REFUSAL);
    renderClient();
    await clickAnswer();
    await screen.findByTestId('funding-step');

    expect(track).not.toHaveBeenCalledWith(CALL_NOW_EVENTS.FUNDING_GATE_SHOWN, expect.anything());
  });

  it('funding Back and Book a time go to the case', async () => {
    mockJoinAsMemberAction.mockResolvedValue(ANSWER_REQUIRED);
    mockAnswerCallNowRingAction.mockResolvedValue(FUNDING_REFUSAL);
    renderClient();
    await clickAnswer();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'funding back' }));
    expect(mockPush).toHaveBeenLastCalledWith(`/cases/${ENGAGEMENT_ID}`);

    await user.click(screen.getByRole('button', { name: 'funding book' }));
    expect(mockPush).toHaveBeenLastCalledWith(`/cases/${ENGAGEMENT_ID}?book=1`);
  });

  it('⚠ leaving the funding gate reports it abandoned — once, not per exit', async () => {
    mockJoinAsMemberAction.mockResolvedValue(ANSWER_REQUIRED);
    mockAnswerCallNowRingAction.mockResolvedValue(FUNDING_REFUSAL);
    renderClient();
    await clickAnswer();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'funding back' }));
    await user.click(screen.getByRole('button', { name: 'funding book' }));

    expect(resolvedGateEvents()).toEqual([
      [CALL_NOW_EVENTS.FUNDING_GATE_RESOLVED, { via: 'abandoned' }],
    ]);
  });

  it('⚠ a ring that is no longer ringing says so, then goes back to the case', async () => {
    mockJoinAsMemberAction.mockResolvedValue(ANSWER_REQUIRED);
    mockAnswerCallNowRingAction.mockResolvedValue({
      ok: false,
      code: 'ring_not_ringing',
      engagementId: ENGAGEMENT_ID,
    });
    renderClient();
    await clickAnswer();

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/cases/${ENGAGEMENT_ID}`));
    expect(mockToast).toHaveBeenCalledWith(CALL_NOW_COPY.answerEndedToast('Dana'));
  });

  it('⚠ a ring that ended while the top-up ran says the credit was added, and reports the gate resolved as top_up', async () => {
    mockJoinAsMemberAction.mockResolvedValue(ANSWER_REQUIRED);
    mockAnswerCallNowRingAction.mockResolvedValueOnce(FUNDING_REFUSAL);
    mockAnswerCallNowRingAction.mockResolvedValueOnce({
      ok: false,
      code: 'ring_not_ringing',
      engagementId: ENGAGEMENT_ID,
    });
    renderClient();
    await clickAnswer();

    await userEvent.setup().click(await screen.findByRole('button', { name: 'funded' }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/cases/${ENGAGEMENT_ID}`));
    expect(mockToast).toHaveBeenCalledWith(CALL_NOW_COPY.answerEndedAfterTopUpToast('Dana'));
    expect(resolvedGateEvents()).toEqual([
      [CALL_NOW_EVENTS.FUNDING_GATE_RESOLVED, { via: 'top_up' }],
    ]);
  });

  it.each([
    ['an unreadable ring_not_ringing', { ok: false, code: 'ring_not_ringing' }],
    ['an unavailable answer', { ok: false, code: 'unavailable' }],
    ['a refused session', { ok: false, code: 'impersonation_refused' }],
  ])('%s ends on the member unavailable card', async (_label, answer) => {
    mockJoinAsMemberAction.mockResolvedValue(ANSWER_REQUIRED);
    mockAnswerCallNowRingAction.mockResolvedValue(answer);
    renderClient();
    await clickAnswer();

    expect(
      await screen.findByRole('heading', { name: MEMBER_JOIN_UNAVAILABLE_TITLE })
    ).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('answer_required without a ring id is unavailable and calls nothing', async () => {
    mockJoinAsMemberAction.mockResolvedValue({ success: false, reason: 'answer_required' });
    renderClient();

    expect(
      await screen.findByRole('heading', { name: MEMBER_JOIN_UNAVAILABLE_TITLE })
    ).toBeInTheDocument();
    expect(mockAnswerCallNowRingAction).not.toHaveBeenCalled();
  });
});

describe('CallClient — a transient failure on Answer (R7)', () => {
  const ANSWER_REQUIRED = { success: false, reason: 'answer_required', ringId: RING_ID };

  it.each(['failed', 'rate_limited', 'funding_unavailable'] as const)(
    '⚠ %s toasts, keeps the Answer notice for a retry and never reports the gate abandoned',
    async (code) => {
      mockJoinAsMemberAction.mockResolvedValue(ANSWER_REQUIRED);
      mockAnswerCallNowRingAction.mockResolvedValueOnce({ ok: false, code });
      mockAnswerCallNowRingAction.mockResolvedValueOnce({ ok: true, grant: GRANT });
      renderClient();
      const user = userEvent.setup();

      await user.click(await screen.findByRole('button', { name: CALL_NOW_COPY.answerAction }));

      await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(START_FAILURE_COPY[code]));
      expect(
        screen.getByRole('heading', { name: CALL_NOW_COPY.answerTitle('Dana') })
      ).toBeVisible();
      expect(screen.queryByRole('heading', { name: MEMBER_JOIN_UNAVAILABLE_TITLE })).toBeNull();
      expect(resolvedGateEvents()).toEqual([]);
      expect(mockPush).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: CALL_NOW_COPY.answerAction }));
      expect(await screen.findByTestId('surface')).toBeInTheDocument();
    }
  );

  it('⚠ a transient failure on the funded retry keeps the funding gate open, unreported', async () => {
    mockJoinAsMemberAction.mockResolvedValue(ANSWER_REQUIRED);
    mockAnswerCallNowRingAction.mockResolvedValueOnce(FUNDING_REFUSAL);
    mockAnswerCallNowRingAction.mockResolvedValueOnce({ ok: false, code: 'failed' });
    renderClient();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: CALL_NOW_COPY.answerAction }));

    await user.click(await screen.findByRole('button', { name: 'funded' }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(START_FAILURE_COPY.failed));
    expect(screen.getByTestId('funding-step')).toBeInTheDocument();
    expect(resolvedGateEvents()).toEqual([]);
  });
});

describe('CallClient — a colleague waits for someone else’s call (R4)', () => {
  const ANSWER_REQUIRED = { success: false, reason: 'answer_required', ringId: RING_ID };

  /**
   * The 5 s re-attempt timers, captured instead of run: fake timers would starve Testing Library's
   * own waits. Every other timer is the real one.
   */
  let awaitTimers: Array<() => void> = [];

  beforeEach(() => {
    awaitTimers = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === AWAIT_RETRY_MS && typeof handler === 'function') {
        awaitTimers.push(() => handler());
        return 0;
      }
      return realSetTimeout(handler, delay, ...args);
    }) as typeof setTimeout);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function fireAwaitTimer(): Promise<void> {
    const fire = awaitTimers.shift();
    expect(fire).toBeDefined();
    await act(async () => {
      fire?.();
    });
  }

  it('⚠ a wait answer shows the wait notice with no Answer button, re-attempts the join, then joins', async () => {
    mockJoinAsMemberAction.mockResolvedValueOnce(ANSWER_REQUIRED);
    mockJoinAsMemberAction.mockResolvedValueOnce({ success: true, grant: GRANT });
    mockReadAnswerView.mockResolvedValue({ kind: 'wait' });
    renderClient();

    expect(
      await screen.findByRole('heading', { name: CALL_NOW_COPY.waitConnectTitle })
    ).toBeInTheDocument();
    expect(screen.getByText(CALL_NOW_COPY.waitConnectBody)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: CALL_NOW_COPY.answerAction })).toBeNull();
    expect(mockJoinAsMemberAction).toHaveBeenCalledTimes(1);
    expect(mockAnswerCallNowRingAction).not.toHaveBeenCalled();

    await fireAwaitTimer();

    expect(await screen.findByTestId('surface')).toHaveAttribute('data-room-url', GRANT.roomUrl);
    expect(mockJoinAsMemberAction).toHaveBeenCalledTimes(2);
    expect(mockAnswerCallNowRingAction).not.toHaveBeenCalled();
  });

  it('⚠ each retry asks again: after a wait the real callee sees Answer', async () => {
    mockJoinAsMemberAction.mockResolvedValue(ANSWER_REQUIRED);
    mockReadAnswerView.mockResolvedValueOnce({ kind: 'wait' });
    mockReadAnswerView.mockResolvedValueOnce(ANSWER_VIEW);
    renderClient();
    await screen.findByRole('heading', { name: CALL_NOW_COPY.waitConnectTitle });

    await fireAwaitTimer();

    expect(
      await screen.findByRole('heading', { name: CALL_NOW_COPY.answerTitle('Dana') })
    ).toBeInTheDocument();
    expect(mockReadAnswerView).toHaveBeenCalledTimes(2);
  });

  it('keeps waiting across consecutive wait answers', async () => {
    mockJoinAsMemberAction.mockResolvedValue(ANSWER_REQUIRED);
    mockReadAnswerView.mockResolvedValue({ kind: 'wait' });
    renderClient();
    await screen.findByRole('heading', { name: CALL_NOW_COPY.waitConnectTitle });

    await fireAwaitTimer();
    await fireAwaitTimer();

    expect(mockJoinAsMemberAction).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('heading', { name: CALL_NOW_COPY.waitConnectTitle })).toBeVisible();
  });

  it('a ring that ended while waiting falls into the unavailable card', async () => {
    mockJoinAsMemberAction.mockResolvedValueOnce(ANSWER_REQUIRED);
    mockJoinAsMemberAction.mockResolvedValueOnce({ success: false, reason: 'unavailable' });
    mockReadAnswerView.mockResolvedValue({ kind: 'wait' });
    renderClient();
    await screen.findByRole('heading', { name: CALL_NOW_COPY.waitConnectTitle });

    await fireAwaitTimer();

    expect(
      await screen.findByRole('heading', { name: MEMBER_JOIN_UNAVAILABLE_TITLE })
    ).toBeInTheDocument();
  });

  it('⚠ the answer-view action throwing is the NEUTRAL connecting wait — never "someone else’s call"', async () => {
    mockJoinAsMemberAction.mockResolvedValue(ANSWER_REQUIRED);
    mockReadAnswerView.mockRejectedValue(new Error('transport'));
    renderClient();

    // The body is unique to this wait; the title alone is shared with the join's own card.
    expect(await screen.findByText(CALL_NOW_COPY.connectingBody)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: CALL_NOW_COPY.connectingTitle })).toBeVisible();
    expect(screen.queryByText(CALL_NOW_COPY.waitConnectBody)).toBeNull();
    expect(screen.queryByRole('button', { name: CALL_NOW_COPY.answerAction })).toBeNull();
  });

  it('⚠ a failed read retries on the next join attempt, and the real callee recovers to Answer', async () => {
    mockJoinAsMemberAction.mockResolvedValue(ANSWER_REQUIRED);
    mockReadAnswerView.mockResolvedValueOnce({ kind: 'retry' });
    mockReadAnswerView.mockResolvedValueOnce(ANSWER_VIEW);
    renderClient();
    await screen.findByText(CALL_NOW_COPY.connectingBody);

    await fireAwaitTimer();

    expect(
      await screen.findByRole('heading', { name: CALL_NOW_COPY.answerTitle('Dana') })
    ).toBeInTheDocument();
    expect(mockJoinAsMemberAction).toHaveBeenCalledTimes(2);
    expect(mockReadAnswerView).toHaveBeenCalledTimes(2);
  });
});
