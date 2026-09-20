import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axe } from 'jest-axe';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@/test/utils';
import { GUEST_ACTION_COPY, rateLimitedCopy } from '@/lib/meetings/guests-copy';
import { InviteColleagueDialog } from './invite-colleague-dialog';

// jsdom does not implement `window.matchMedia`; the house pattern mocks the hook directly.
const { mockIsMobile } = vi.hoisted(() => ({ mockIsMobile: { value: false } }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mockIsMobile.value }));

const mockInviteConsultationGuestsAction = vi.fn();
vi.mock('@/app/(dashboard)/cases/[engagementId]/_actions/invite-consultation-guests', () => ({
  inviteConsultationGuestsAction: (...a: unknown[]) => mockInviteConsultationGuestsAction(...a),
}));

const mockCaptureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...a: unknown[]) => mockCaptureException(...a),
}));

const mockToastSuccess = vi.fn();
vi.mock('sonner', () => ({
  toast: { success: (...a: unknown[]) => mockToastSuccess(...a), error: vi.fn() },
}));

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';

function renderDialog(
  over: {
    onClose?: () => void;
    onInvited?: () => void;
    existingGuestCount?: number;
    lens?: 'client' | 'expert';
  } = {}
) {
  return render(
    <InviteColleagueDialog
      open
      onClose={over.onClose ?? vi.fn()}
      onInvited={over.onInvited ?? vi.fn()}
      meetingId={MEETING_ID}
      caseTitle="Flow interview loop"
      scheduledStartIso="2026-08-04T04:00:00.000Z"
      ordinal={2}
      existingGuestCount={over.existingGuestCount ?? 0}
      clientCompanyName="Northwind Industrial"
      caseScopeDomains={['northwind.test']}
      lens={over.lens ?? 'client'}
    />
  );
}

async function addDraft(user: ReturnType<typeof userEvent.setup>, email: string): Promise<void> {
  await user.type(screen.getByLabelText('Guest email address'), email);
  await user.click(screen.getByRole('button', { name: 'Add guest' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsMobile.value = false;
  mockInviteConsultationGuestsAction.mockResolvedValue({
    success: true,
    invitedCount: 1,
    participantCount: 3,
    participantCap: 10,
  });
});

describe('InviteColleagueDialog — empty state', () => {
  it('disables Send with no drafts', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Send invites' })).toBeDisabled();
  });
});

describe('InviteColleagueDialog — F1, lens gates COPY only, never authorization', () => {
  it('does NOT render the "what you pay" clause on the EXPERT lens — an expert pays nothing here', () => {
    renderDialog({ lens: 'expert' });
    expect(screen.getByText('2 of 10')).toBeInTheDocument();
    expect(screen.queryByText(/what you pay/i)).not.toBeInTheDocument();
  });

  it('renders the "what you pay" clause on the CLIENT lens', () => {
    renderDialog({ lens: 'client' });
    expect(screen.getByText("2 of 10 · guests don't change what you pay")).toBeInTheDocument();
  });
});

describe('InviteColleagueDialog — F2, the cap is advisory only (the count is a page-render snapshot)', () => {
  /**
   * ⚠ MUTATION PROOF: drop `capAdvisoryOnly` from the `GuestInviteComposer` call and this test
   * goes red — `existingGuestCount: 8` alone (`RESERVED_BASE_PARTICIPANTS(2) + 8 = 10`) already
   * reads as at-cap with zero drafts, which is exactly the stale-count lockout this closes.
   */
  it('the guest input stays enabled even when the page-rendered count already reads at-cap', () => {
    renderDialog({ existingGuestCount: 8 });
    expect(screen.getByLabelText('Guest email address')).toBeEnabled();
  });

  it('a guest can still be added at that same stale at-cap count', async () => {
    const user = userEvent.setup();
    renderDialog({ existingGuestCount: 8 });
    await addDraft(user, 'dana@northwind.test');
    expect(screen.getByText('dana@northwind.test')).toBeInTheDocument();
  });
});

describe('InviteColleagueDialog — AC 6, Send is NEVER pre-emptively disabled by the cap', () => {
  /**
   * ⚠ MUTATION PROOF: add a `total >= cap` term to the Send button's `disabled` expression and
   * this test goes red. Eight drafts plus `existingGuestCount: 0` already reaches the 10-cap
   * (`RESERVED_BASE_PARTICIPANTS(2) + 8`); the seat count is then grown to 18 via a prop update —
   * mirroring the real race `countLiveByMeeting`'s own docblock names, where the server's count
   * moves between render and send — to prove Send answers to NEITHER quantity.
   */
  it('with 8 drafts and the seat count grown past the cap (total 18), Send is ENABLED', async () => {
    const user = userEvent.setup();
    const { rerender } = renderDialog({ existingGuestCount: 0 });

    for (let i = 0; i < 8; i++) {
      await addDraft(user, `guest${i}@example.com`);
    }
    expect(screen.getByRole('button', { name: 'Send invites' })).toBeEnabled();

    rerender(
      <InviteColleagueDialog
        open
        onClose={vi.fn()}
        onInvited={vi.fn()}
        meetingId={MEETING_ID}
        caseTitle="Flow interview loop"
        scheduledStartIso="2026-08-04T04:00:00.000Z"
        ordinal={2}
        existingGuestCount={8}
        clientCompanyName="Northwind Industrial"
        caseScopeDomains={['northwind.test']}
        lens="client"
      />
    );

    expect(screen.getByRole('button', { name: 'Send invites' })).toBeEnabled();
  });
});

describe('InviteColleagueDialog — loading', () => {
  it('Send reads "Sending…" and disables while in flight; the dismiss control stays ENABLED', async () => {
    const user = userEvent.setup();
    let resolveInvite: (value: unknown) => void = () => {};
    mockInviteConsultationGuestsAction.mockReturnValue(
      new Promise((resolve) => {
        resolveInvite = resolve;
      })
    );
    renderDialog();
    await addDraft(user, 'dana@northwind.test');

    await user.click(screen.getByRole('button', { name: 'Send invites' }));

    expect(await screen.findByRole('button', { name: 'Sending…' })).toBeDisabled();
    // The composer's own inputs disable while submitting (a `<fieldset disabled>` wrapper).
    expect(screen.getByLabelText('Guest email address')).toBeDisabled();
    // ⚠ memory `reference_usetransition_pending_disables_cancel_ci_only` — dismissal must never
    // be gated on the in-flight state.
    expect(screen.getByRole('button', { name: /close/i })).toBeEnabled();

    resolveInvite({ success: true, invitedCount: 1, participantCount: 3, participantCap: 10 });
    // Flush the resulting state update inside `act()` so the test doesn't leak a dangling
    // update into the next one.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send invites' })).toBeInTheDocument()
    );
  });
});

describe('InviteColleagueDialog — success', () => {
  it('calls the action with {meetingId, emails} for THIS row; toast fires; onInvited fires', async () => {
    const user = userEvent.setup();
    const onInvited = vi.fn();
    renderDialog({ onInvited });
    await addDraft(user, 'dana@northwind.test');

    await user.click(screen.getByRole('button', { name: 'Send invites' }));

    await waitFor(() => expect(onInvited).toHaveBeenCalledTimes(1));
    expect(mockInviteConsultationGuestsAction).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      emails: ['dana@northwind.test'],
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Invite sent.');
  });

  it('pluralises the success toast for more than one invite', async () => {
    const user = userEvent.setup();
    mockInviteConsultationGuestsAction.mockResolvedValue({
      success: true,
      invitedCount: 2,
      participantCount: 4,
      participantCap: 10,
    });
    renderDialog();
    await addDraft(user, 'dana@northwind.test');
    await addDraft(user, 'sam@northwind.test');

    await user.click(screen.getByRole('button', { name: 'Send invites' }));

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Invites sent.'));
  });
});

describe('InviteColleagueDialog — refusals render their own copy, dialog stays open, drafts survive', () => {
  it('participant_cap_reached ⇒ GUEST_ACTION_COPY.participant_cap_reached verbatim', async () => {
    const user = userEvent.setup();
    mockInviteConsultationGuestsAction.mockResolvedValue({
      success: false,
      error: GUEST_ACTION_COPY.participant_cap_reached,
      outcome: 'cap_reached',
    });
    renderDialog();
    await addDraft(user, 'dana@northwind.test');

    await user.click(screen.getByRole('button', { name: 'Send invites' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      GUEST_ACTION_COPY.participant_cap_reached
    );
    // The dialog is still open and the draft is still there.
    expect(screen.getByText('dana@northwind.test')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send invites' })).toBeInTheDocument();
  });

  it('guest_already_invited ⇒ its own, DISTINCT copy', async () => {
    const user = userEvent.setup();
    mockInviteConsultationGuestsAction.mockResolvedValue({
      success: false,
      error: GUEST_ACTION_COPY.guest_already_invited,
      outcome: 'already_invited',
    });
    renderDialog();
    await addDraft(user, 'dana@northwind.test');

    await user.click(screen.getByRole('button', { name: 'Send invites' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      GUEST_ACTION_COPY.guest_already_invited
    );
    expect(GUEST_ACTION_COPY.guest_already_invited).not.toBe(
      GUEST_ACTION_COPY.participant_cap_reached
    );
  });

  it('rate limiting ⇒ rateLimitedCopy(120) verbatim, distinct from the other two', async () => {
    const user = userEvent.setup();
    mockInviteConsultationGuestsAction.mockResolvedValue({
      success: false,
      error: rateLimitedCopy(120),
      outcome: 'rate_limited',
    });
    renderDialog();
    await addDraft(user, 'dana@northwind.test');

    await user.click(screen.getByRole('button', { name: 'Send invites' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(rateLimitedCopy(120));
    expect(rateLimitedCopy(120)).not.toBe(GUEST_ACTION_COPY.guest_already_invited);
    expect(rateLimitedCopy(120)).not.toBe(GUEST_ACTION_COPY.participant_cap_reached);
  });

  it('an unmapped/unknown outcome reports to Sentry', async () => {
    const user = userEvent.setup();
    mockInviteConsultationGuestsAction.mockResolvedValue({
      success: false,
      error: GUEST_ACTION_COPY.request_failed,
      outcome: 'failed',
    });
    renderDialog();
    await addDraft(user, 'dana@northwind.test');

    await user.click(screen.getByRole('button', { name: 'Send invites' }));

    await screen.findByRole('alert');
    expect(mockCaptureException).toHaveBeenCalled();
  });

  it('an expired session does NOT report to Sentry — it is an expected condition, not an exception', async () => {
    const user = userEvent.setup();
    mockInviteConsultationGuestsAction.mockResolvedValue({
      success: false,
      error: GUEST_ACTION_COPY.unauthenticated,
      outcome: 'failed',
    });
    renderDialog();
    await addDraft(user, 'dana@northwind.test');

    await user.click(screen.getByRole('button', { name: 'Send invites' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(GUEST_ACTION_COPY.unauthenticated);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});

describe('InviteColleagueDialog — accessibility', () => {
  it('has no violations, open, with drafts and with an error rendered', async () => {
    const user = userEvent.setup();
    mockInviteConsultationGuestsAction.mockResolvedValue({
      success: false,
      error: GUEST_ACTION_COPY.guest_already_invited,
      outcome: 'already_invited',
    });
    const { baseElement } = renderDialog();
    await addDraft(user, 'dana@northwind.test');
    await user.click(screen.getByRole('button', { name: 'Send invites' }));
    await screen.findByRole('alert');

    expect(await axe(baseElement)).toHaveNoViolations();
  });
});
