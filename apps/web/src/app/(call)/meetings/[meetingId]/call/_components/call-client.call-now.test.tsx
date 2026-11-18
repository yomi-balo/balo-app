import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
  mockUseCallNowRing,
  mockStop,
  mockPush,
  mockToast,
  mockToastSuccess,
  mockToastError,
} = vi.hoisted(() => ({
  mockJoinAsMemberAction: vi.fn(),
  mockAnswerCallNowRingAction: vi.fn(),
  mockUseCallNowRing: vi.fn(),
  mockStop: vi.fn(),
  mockPush: vi.fn(),
  mockToast: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
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
    request: { expertProfileId: string; caseChoice: { kind: string; engagementId?: string } };
    onFunded: () => Promise<boolean>;
    onBack: () => void;
    onBookInstead: (() => void) | null;
  }) => (
    <div
      data-testid="funding-step"
      data-caller-lens={props.callerLens}
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
    expect(track).toHaveBeenCalledWith(CALL_NOW_EVENTS.ATTEMPT_ABANDONED, { step: 'calling' });
  });

  it('⚠ a stop that loses a race to a connect says nothing and stays in the room', async () => {
    mockStop.mockResolvedValue({ ok: true, status: 'connected' });
    ringState();
    renderClient(CALLER);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'probe stop' }));

    await waitFor(() => expect(mockStop).toHaveBeenCalledTimes(1));
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalledWith(CALL_NOW_EVENTS.ATTEMPT_ABANDONED, expect.anything());
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
      await screen.findByRole('heading', { name: CALL_NOW_COPY.answerTitle('Your expert') })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: CALL_NOW_COPY.answerAction })).toBeEnabled();
    expect(mockAnswerCallNowRingAction).not.toHaveBeenCalled();
    expect(screen.queryByTestId('surface')).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
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
    mockAnswerCallNowRingAction.mockResolvedValueOnce({
      ok: false,
      code: 'funding',
      engagementId: ENGAGEMENT_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });
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
    mockAnswerCallNowRingAction.mockResolvedValue({
      ok: false,
      code: 'funding',
      engagementId: ENGAGEMENT_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });
    renderClient();
    await clickAnswer();
    await screen.findByTestId('funding-step');

    expect(track).not.toHaveBeenCalledWith(CALL_NOW_EVENTS.FUNDING_GATE_SHOWN, expect.anything());
  });

  it('funding Back and Book a time go to the case', async () => {
    mockJoinAsMemberAction.mockResolvedValue(ANSWER_REQUIRED);
    mockAnswerCallNowRingAction.mockResolvedValue({
      ok: false,
      code: 'funding',
      engagementId: ENGAGEMENT_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });
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
    mockAnswerCallNowRingAction.mockResolvedValue({
      ok: false,
      code: 'funding',
      engagementId: ENGAGEMENT_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });
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
    expect(mockToast).toHaveBeenCalledWith(CALL_NOW_COPY.answerEndedToast('Your expert'));
  });

  it('⚠ a ring that ended while the top-up ran says so too, and reports the gate abandoned', async () => {
    mockJoinAsMemberAction.mockResolvedValue(ANSWER_REQUIRED);
    mockAnswerCallNowRingAction.mockResolvedValueOnce({
      ok: false,
      code: 'funding',
      engagementId: ENGAGEMENT_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });
    mockAnswerCallNowRingAction.mockResolvedValueOnce({
      ok: false,
      code: 'ring_not_ringing',
      engagementId: ENGAGEMENT_ID,
    });
    renderClient();
    await clickAnswer();

    await userEvent.setup().click(await screen.findByRole('button', { name: 'funded' }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/cases/${ENGAGEMENT_ID}`));
    expect(mockToast).toHaveBeenCalledWith(CALL_NOW_COPY.answerEndedToast('Your expert'));
    expect(resolvedGateEvents()).toEqual([
      [CALL_NOW_EVENTS.FUNDING_GATE_RESOLVED, { via: 'abandoned' }],
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
