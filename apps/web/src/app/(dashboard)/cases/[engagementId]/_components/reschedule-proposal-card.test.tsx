import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { RescheduleProposalCard } from './reschedule-proposal-card';

/**
 * BAL-411 — unit tests for the LIVE reschedule proposal, both lenses. The nudge above is
 * purely informational (`case-nudge.test.tsx` owns that); this is where accept / decline /
 * withdraw actually fire, so this file owns the four-state + toast + analytics coverage.
 */

const mockAcceptAction = vi.fn();
const mockDeclineAction = vi.fn();
vi.mock('../_actions/respond-to-reschedule-proposal', () => ({
  acceptRescheduleProposalAction: (...a: unknown[]) => mockAcceptAction(...a),
  declineRescheduleProposalAction: (...a: unknown[]) => mockDeclineAction(...a),
}));

const mockWithdrawAction = vi.fn();
vi.mock('../_actions/propose-reschedule', () => ({
  withdrawRescheduleProposalAction: (...a: unknown[]) => mockWithdrawAction(...a),
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics', () => ({
  track: (...a: unknown[]) => mockTrack(...a),
  BOOKING_EVENTS: {
    RESCHEDULED: 'booking_rescheduled',
    RESCHEDULE_PROPOSAL_ANSWERED: 'reschedule_proposal_answered',
    RESCHEDULE_PROPOSAL_SLOT_LOST: 'reschedule_proposal_slot_lost',
  },
}));

const mockCaptureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...a: unknown[]) => mockCaptureException(...a),
}));

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => mockToastSuccess(...a),
    error: (...a: unknown[]) => mockToastError(...a),
  },
}));

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';

const CLIENT_NUDGE = {
  kind: 'reschedule_proposal' as const,
  proposalId: 'proposal-1',
  meetingId: 'm1',
  optionCount: 2,
  originalScheduledStartIso: '2026-09-01T10:00:00.000Z',
  expiresAtIso: '2026-08-31T10:00:00.000Z',
  proposedAtIso: '2026-08-25T10:00:00.000Z',
  options: [
    { optionId: 'opt-1', scheduledStartIso: '2026-09-02T10:00:00.000Z' },
    { optionId: 'opt-2', scheduledStartIso: '2026-09-03T10:00:00.000Z' },
  ],
};

const EXPERT_NUDGE = {
  ...CLIENT_NUDGE,
  kind: 'reschedule_proposal_pending' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAcceptAction.mockResolvedValue({
    success: true,
    proposalId: 'proposal-1',
    scheduledStart: '2026-09-02T10:00:00.000Z',
    scheduledEnd: '2026-09-02T10:30:00.000Z',
  });
  mockDeclineAction.mockResolvedValue({ success: true, proposalId: 'proposal-1' });
  mockWithdrawAction.mockResolvedValue({ success: true, proposalId: 'proposal-1' });
});

describe('RescheduleProposalCard — CLIENT lens', () => {
  it('lists every option and disables Accept until one is chosen', () => {
    render(
      <RescheduleProposalCard
        engagementId={ENGAGEMENT_ID}
        lens="client"
        nudge={CLIENT_NUDGE}
        counterpartyLabel="Amara"
        onChanged={vi.fn()}
        canManageReschedule={true}
      />
    );
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Accept' })).toBeDisabled();
  });

  // Item 14 — the NUDGE (`case-nudge.tsx`) owns the headline and the deadline; this card owns
  // only the options and CTAs, so it must render neither a second copy of the nudge's headline
  // sentence nor its own "Reply by" deadline line.
  it('renders a heading distinct from the nudge, and no duplicate "Reply by" deadline', () => {
    render(
      <RescheduleProposalCard
        engagementId={ENGAGEMENT_ID}
        lens="client"
        nudge={CLIENT_NUDGE}
        counterpartyLabel="Amara"
        onChanged={vi.fn()}
        canManageReschedule={true}
      />
    );
    expect(screen.getByRole('heading', { name: 'Pick a new time' })).toBeInTheDocument();
    expect(screen.queryByText(/Amara suggested some new times/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Reply by/)).not.toBeInTheDocument();
  });

  it('accepts the selected option and reports success', async () => {
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(
      <RescheduleProposalCard
        engagementId={ENGAGEMENT_ID}
        lens="client"
        nudge={CLIENT_NUDGE}
        counterpartyLabel="Amara"
        onChanged={onChanged}
        canManageReschedule={true}
      />
    );

    const [firstRadio] = screen.getAllByRole('radio');
    if (firstRadio === undefined) throw new Error('expected a radio option');
    await user.click(firstRadio);
    await user.click(screen.getByRole('button', { name: 'Accept' }));

    expect(mockAcceptAction).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      meetingId: 'm1',
      proposalId: 'proposal-1',
      optionId: 'opt-1',
    });
    expect(mockToastSuccess).toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      'reschedule_proposal_answered',
      expect.objectContaining({ proposal_id: 'proposal-1', outcome: 'accepted', option_count: 2 })
    );
    expect(mockTrack).toHaveBeenCalledWith(
      'booking_rescheduled',
      expect.objectContaining({ initiated_by: 'expert' })
    );
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  // Item 8 — `hours_before_start` must measure notice given against the EXISTING start
  // (`originalScheduledStartIso`), never the NEW start the meeting is moving to. The fixture's
  // two starts are a day apart, so a wrong implementation reading `result.scheduledStart`
  // would be off by ~24h from the correct value.
  it('fires hours_before_start against the ORIGINAL start, not the new one', async () => {
    // `shouldAdvanceTime: true` — without it, fake timers freeze the internals RTL/userEvent
    // themselves rely on (the `notification-bell.test.tsx` precedent), and the test hangs.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // CLIENT_NUDGE.originalScheduledStartIso is 2026-09-01T10:00:00.000Z; "now" is 2h before.
      vi.setSystemTime(new Date('2026-09-01T08:00:00.000Z'));
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(
        <RescheduleProposalCard
          engagementId={ENGAGEMENT_ID}
          lens="client"
          nudge={CLIENT_NUDGE}
          counterpartyLabel="Amara"
          onChanged={vi.fn()}
          canManageReschedule={true}
        />
      );
      const [firstRadio] = screen.getAllByRole('radio');
      if (firstRadio === undefined) throw new Error('expected a radio option');
      await user.click(firstRadio);
      await user.click(screen.getByRole('button', { name: 'Accept' }));
    } finally {
      vi.useRealTimers();
    }

    expect(mockTrack).toHaveBeenCalledWith(
      'booking_rescheduled',
      // 2h before the ORIGINAL start — mockAcceptAction resolves scheduledStart a day later,
      // which would read ~24h if the wrong field were used.
      expect.objectContaining({ initiated_by: 'expert', hours_before_start: 2 })
    );
  });

  // Item 12 — `proposedAtIso: null` is the loader's honest type for a detail read that raced
  // the proposal resolving out from under it; structurally unreachable in normal use, but the
  // card must still degrade to `hours_to_respond: 0` rather than crash or fabricate a value.
  it('degrades hours_to_respond to 0 rather than crashing when proposedAtIso is null', async () => {
    const nudgeWithoutDetail = { ...CLIENT_NUDGE, proposedAtIso: null };
    const user = userEvent.setup();
    render(
      <RescheduleProposalCard
        engagementId={ENGAGEMENT_ID}
        lens="client"
        nudge={nudgeWithoutDetail}
        counterpartyLabel="Amara"
        onChanged={vi.fn()}
        canManageReschedule={true}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Keep my time' }));
    expect(mockTrack).toHaveBeenCalledWith(
      'reschedule_proposal_answered',
      expect.objectContaining({ hours_to_respond: 0 })
    );
  });

  it('declines (keeps the original time) and reports success — no option selection needed', async () => {
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(
      <RescheduleProposalCard
        engagementId={ENGAGEMENT_ID}
        lens="client"
        nudge={CLIENT_NUDGE}
        counterpartyLabel="Amara"
        onChanged={onChanged}
        canManageReschedule={true}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Keep my time' }));

    expect(mockDeclineAction).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      meetingId: 'm1',
      proposalId: 'proposal-1',
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Your original time stands.');
    expect(mockTrack).toHaveBeenCalledWith(
      'reschedule_proposal_answered',
      expect.objectContaining({ outcome: 'declined' })
    );
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  /** §D7 — the slot-lost re-prompt: SOME options remain. Client-side state only. */
  it('a slot_unavailable accept disables the dead option and keeps the others pickable', async () => {
    mockAcceptAction.mockResolvedValue({
      success: false,
      code: 'slot_unavailable',
      error: 'That time was just taken.',
    });
    const user = userEvent.setup();
    render(
      <RescheduleProposalCard
        engagementId={ENGAGEMENT_ID}
        lens="client"
        nudge={CLIENT_NUDGE}
        counterpartyLabel="Amara"
        onChanged={vi.fn()}
        canManageReschedule={true}
      />
    );

    const [firstRadio] = screen.getAllByRole('radio');
    if (firstRadio === undefined) throw new Error('expected a radio option');
    await user.click(firstRadio);
    await user.click(screen.getByRole('button', { name: 'Accept' }));

    expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining('other suggested times'));
    expect(mockTrack).toHaveBeenCalledWith(
      'reschedule_proposal_slot_lost',
      expect.objectContaining({ proposal_id: 'proposal-1' })
    );
    // The dead radio is now disabled; the other option is still live.
    const [deadRadio, liveRadio] = screen.getAllByRole('radio');
    if (deadRadio === undefined || liveRadio === undefined) {
      throw new Error('expected two radio options');
    }
    expect(deadRadio).toBeDisabled();
    expect(liveRadio).not.toBeDisabled();
  });

  // CONSIDER item — §D7: once every option is dead, Accept must be ABSENT, not merely disabled
  // — "an absent action beats a dead one" (`case-nudge.test.tsx`'s own rule).
  it('hides Accept entirely once every option is dead — only Keep my time remains', async () => {
    const [firstOption] = CLIENT_NUDGE.options;
    if (firstOption === undefined) throw new Error('expected a fixture option');
    const ONE_OPTION_NUDGE = { ...CLIENT_NUDGE, options: [firstOption] };
    mockAcceptAction.mockResolvedValue({
      success: false,
      code: 'slot_unavailable',
      error: 'That time was just taken.',
    });
    const user = userEvent.setup();
    render(
      <RescheduleProposalCard
        engagementId={ENGAGEMENT_ID}
        lens="client"
        nudge={ONE_OPTION_NUDGE}
        counterpartyLabel="Amara"
        onChanged={vi.fn()}
        canManageReschedule={true}
      />
    );

    const [firstRadio] = screen.getAllByRole('radio');
    if (firstRadio === undefined) throw new Error('expected a radio option');
    await user.click(firstRadio);
    await user.click(screen.getByRole('button', { name: 'Accept' }));

    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep my time' })).toBeInTheDocument();
    expect(screen.getByText(/Those times are no longer free/)).toBeInTheDocument();
    // CONSIDER item — §D7's copy carries the DATE ("Your original time on {date} still
    // stands"), not just the bare claim. CLIENT_NUDGE.originalScheduledStartIso is
    // 2026-09-01T10:00:00.000Z → "1 Sep" under TZ=UTC.
    expect(screen.getByText(/Your original time on 1 Sep still stands/)).toBeInTheDocument();
  });

  it('reports a generic non-terminal failure without disabling any option or refreshing', async () => {
    mockAcceptAction.mockResolvedValue({
      success: false,
      code: 'rate_limited',
      error: 'Too many changes just now — try again shortly.',
    });
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(
      <RescheduleProposalCard
        engagementId={ENGAGEMENT_ID}
        lens="client"
        nudge={CLIENT_NUDGE}
        counterpartyLabel="Amara"
        onChanged={onChanged}
        canManageReschedule={true}
      />
    );
    const [firstRadio] = screen.getAllByRole('radio');
    if (firstRadio === undefined) throw new Error('expected a radio option');
    await user.click(firstRadio);
    await user.click(screen.getByRole('button', { name: 'Accept' }));

    expect(mockToastError).toHaveBeenCalledWith('Too many changes just now — try again shortly.');
    const [radioAfter] = screen.getAllByRole('radio');
    if (radioAfter === undefined) throw new Error('expected a radio option');
    expect(radioAfter).not.toBeDisabled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  // Item 3 — BAL-409's `closeOnAcknowledge` precedent, carried over: a TERMINAL failure means
  // the card was rendered from state that no longer exists, so it must refresh via `onChanged`
  // rather than re-offer a dead Accept.
  it('a TERMINAL accept failure (proposal_not_answerable) toasts AND refreshes via onChanged', async () => {
    mockAcceptAction.mockResolvedValue({
      success: false,
      code: 'proposal_not_answerable',
      error: 'This proposal has already been answered.',
    });
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(
      <RescheduleProposalCard
        engagementId={ENGAGEMENT_ID}
        lens="client"
        nudge={CLIENT_NUDGE}
        counterpartyLabel="Amara"
        onChanged={onChanged}
        canManageReschedule={true}
      />
    );
    const [firstRadio] = screen.getAllByRole('radio');
    if (firstRadio === undefined) throw new Error('expected a radio option');
    await user.click(firstRadio);
    await user.click(screen.getByRole('button', { name: 'Accept' }));

    expect(mockToastError).toHaveBeenCalledWith('This proposal has already been answered.');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('a TERMINAL decline failure (proposal_stale) toasts AND refreshes via onChanged', async () => {
    mockDeclineAction.mockResolvedValue({
      success: false,
      code: 'proposal_stale',
      error: 'This proposal no longer matches the booking — refresh the page.',
    });
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(
      <RescheduleProposalCard
        engagementId={ENGAGEMENT_ID}
        lens="client"
        nudge={CLIENT_NUDGE}
        counterpartyLabel="Amara"
        onChanged={onChanged}
        canManageReschedule={true}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Keep my time' }));

    expect(mockToastError).toHaveBeenCalledWith(
      'This proposal no longer matches the booking — refresh the page.'
    );
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('a non-terminal decline failure (rate_limited) toasts but does not refresh', async () => {
    mockDeclineAction.mockResolvedValue({
      success: false,
      code: 'rate_limited',
      error: 'Too many changes just now — try again shortly.',
    });
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(
      <RescheduleProposalCard
        engagementId={ENGAGEMENT_ID}
        lens="client"
        nudge={CLIENT_NUDGE}
        counterpartyLabel="Amara"
        onChanged={onChanged}
        canManageReschedule={true}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Keep my time' }));

    expect(mockToastError).toHaveBeenCalledWith('Too many changes just now — try again shortly.');
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('RescheduleProposalCard — EXPERT lens', () => {
  it('lists every offered time read-only, with no radios', () => {
    render(
      <RescheduleProposalCard
        engagementId={ENGAGEMENT_ID}
        lens="expert"
        nudge={EXPERT_NUDGE}
        counterpartyLabel="Northwind Industrial"
        onChanged={vi.fn()}
        canManageReschedule={true}
      />
    );
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.getByText(/Waiting on Northwind Industrial/i)).toBeInTheDocument();
  });

  // Item 18 (security LOW) — an agency member with role `expert` legitimately reads this
  // surface (`lens === 'expert'`) but is deliberately and permanently NOT a `manage_engagement`
  // holder (ADR-1046 §7), so Withdraw must be ABSENT for them, not merely disabled — "an absent
  // action beats a dead one" (§D7's own rule).
  it('hides Withdraw entirely when canManageReschedule is false, even though lens is expert', () => {
    render(
      <RescheduleProposalCard
        engagementId={ENGAGEMENT_ID}
        lens="expert"
        nudge={EXPERT_NUDGE}
        counterpartyLabel="Northwind Industrial"
        onChanged={vi.fn()}
        canManageReschedule={false}
      />
    );
    expect(screen.queryByRole('button', { name: 'Withdraw' })).not.toBeInTheDocument();
  });

  it('withdraws and reports success — publishes no client-visible accept/decline copy', async () => {
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(
      <RescheduleProposalCard
        engagementId={ENGAGEMENT_ID}
        lens="expert"
        nudge={EXPERT_NUDGE}
        counterpartyLabel="Northwind Industrial"
        onChanged={onChanged}
        canManageReschedule={true}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Withdraw' }));

    expect(mockWithdrawAction).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      meetingId: 'm1',
      proposalId: 'proposal-1',
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Proposal withdrawn.');
    expect(mockTrack).toHaveBeenCalledWith(
      'reschedule_proposal_answered',
      expect.objectContaining({ outcome: 'withdrawn' })
    );
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('a TERMINAL withdraw failure toasts the server copy AND refreshes via onChanged', async () => {
    mockWithdrawAction.mockResolvedValue({
      success: false,
      code: 'proposal_not_answerable',
      error: 'This proposal has already been answered.',
    });
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(
      <RescheduleProposalCard
        engagementId={ENGAGEMENT_ID}
        lens="expert"
        nudge={EXPERT_NUDGE}
        counterpartyLabel="Northwind Industrial"
        onChanged={onChanged}
        canManageReschedule={true}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Withdraw' }));
    expect(mockToastError).toHaveBeenCalledWith('This proposal has already been answered.');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('a non-terminal withdraw failure (rate_limited) toasts but does not refresh', async () => {
    mockWithdrawAction.mockResolvedValue({
      success: false,
      code: 'rate_limited',
      error: 'Too many changes just now — try again shortly.',
    });
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(
      <RescheduleProposalCard
        engagementId={ENGAGEMENT_ID}
        lens="expert"
        nudge={EXPERT_NUDGE}
        counterpartyLabel="Northwind Industrial"
        onChanged={onChanged}
        canManageReschedule={true}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Withdraw' }));
    expect(mockToastError).toHaveBeenCalledWith('Too many changes just now — try again shortly.');
    expect(onChanged).not.toHaveBeenCalled();
  });
});
