import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { ThreadHeader } from './thread-header';
import { deriveThreadActions } from './thread-actions';
import { thread } from '@/test/fixtures/conversation';
import type {
  ConversationThreadView,
  UpcomingCallView,
} from '@/lib/project-request/conversation-view-types';
import type { ProjectRequestStatus } from '@/lib/project-request/resolve-request-lens';
import type { ViewerClock } from '@/hooks/use-viewer-clock';

const NOW = new Date('2026-09-01T00:00:00.000Z');
const { clockRef } = vi.hoisted(() => ({ clockRef: { value: null as ViewerClock | null } }));
vi.mock('@/hooks/use-viewer-clock', () => ({ useViewerClock: () => clockRef.value }));

const IN_TWO_DAYS: UpcomingCallView = {
  meetingId: 'meeting-1',
  scheduledStartIso: '2026-09-03T04:00:00.000Z',
  contextType: 'request_interaction',
};
const IN_THREE_DAYS: UpcomingCallView = {
  meetingId: 'meeting-2',
  scheduledStartIso: '2026-09-04T04:00:00.000Z',
  contextType: 'project_call',
};

function renderHeader(input: {
  lens?: 'client' | 'expert';
  requestStatus?: ProjectRequestStatus;
  threadOverrides?: Partial<ConversationThreadView>;
  /** Non-null → the proposal slot renders enabled (client lens, A5). */
  onRequestProposal?: (() => void) | null;
  /** Non-null → the expert "Build proposal" CTA renders enabled (A6.2). */
  onBuildProposal?: (() => void) | null;
  /** Non-null → the "View proposal"/"View submitted proposal" CTA renders enabled (A6.3). */
  onViewProposal?: (() => void) | null;
  /** Non-null → the BAL-540 decline control renders enabled when the derived slot is non-null. */
  onDecline?: (() => void) | null;
  /** BAL-540 — threaded to `deriveThreadActions`. */
  canDecline?: boolean;
  profileBookingHref?: string | null;
  deliveryEngagementId?: string | null;
  /** BAL-616 — threaded to `deriveThreadActions`. */
  deliveryActive?: boolean;
}): {
  onCall: ReturnType<typeof vi.fn>;
  onBookAnother: ReturnType<typeof vi.fn>;
  onJoin: ReturnType<typeof vi.fn>;
} {
  const lens = input.lens ?? 'client';
  const requestStatus = input.requestStatus ?? 'eoi_submitted';
  const t = thread(input.threadOverrides);
  const actions = deriveThreadActions({
    lens,
    requestStatus,
    thread: t,
    nudgeIsProposal: false,
    canDecline: input.canDecline ?? false,
    deliveryActive: input.deliveryActive ?? true,
  });
  const onCall = vi.fn();
  const onBookAnother = vi.fn();
  const onJoin = vi.fn();
  render(
    <ThreadHeader
      thread={t}
      showYouSuffix={lens === 'expert'}
      actions={actions}
      callPending={false}
      profileBookingHref={input.profileBookingHref ?? null}
      deliveryEngagementId={input.deliveryEngagementId ?? null}
      joinPartyLabel={lens === 'expert' ? 'Northwind' : t.expertName}
      onCall={onCall}
      onBookAnother={onBookAnother}
      onJoin={onJoin}
      onRequestProposal={input.onRequestProposal ?? null}
      onBuildProposal={input.onBuildProposal ?? null}
      onViewProposal={input.onViewProposal ?? null}
      onDecline={input.onDecline ?? null}
    />
  );
  return { onCall, onBookAnother, onJoin };
}

describe('ThreadHeader', () => {
  it('shows the expert identity', () => {
    renderHeader({});
    expect(screen.getByText('Priya Nair')).toBeInTheDocument();
  });

  /**
   * ⚠ REPLACES the two deleted "Files pill" cases (BAL-431 / OSD-2). Those asserted the count
   * badge and the toggle callback of an affordance that no longer exists, so they were removed
   * as genuinely-gone behaviour rather than to silence a failure — and this NEGATIVE assertion
   * took their place so a re-introduced second file home on the request surface fails here.
   */
  it('renders NO files affordance — the request surface has one file home, and it is not this', () => {
    renderHeader({ threadOverrides: { fileCount: 3 } });
    expect(screen.queryByRole('button', { name: /Files/ })).not.toBeInTheDocument();
    expect(screen.queryByText('3')).not.toBeInTheDocument();
  });

  it('client lens without a handler: Book a call, and the Request proposal slot renders NOTHING', async () => {
    const user = userEvent.setup();
    const { onCall } = renderHeader({});
    await user.click(screen.getByRole('button', { name: 'Book a call' }));
    expect(onCall).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Request proposal' })).not.toBeInTheDocument();
  });

  it('client lens with a handler: Request proposal is ENABLED and fires it (A5)', async () => {
    const user = userEvent.setup();
    const onRequestProposal = vi.fn();
    renderHeader({ onRequestProposal });
    const proposal = screen.getByRole('button', { name: 'Request proposal' });
    expect(proposal).toBeEnabled();
    expect(proposal).not.toHaveAttribute('aria-disabled');
    expect(proposal.className).toContain('text-primary-foreground');
    expect(proposal.className).not.toContain('bg-gradient-to-r');
    await user.click(proposal);
    expect(onRequestProposal).toHaveBeenCalledTimes(1);
  });

  it('expert lens without a handler: Build proposal renders NOTHING (no opacity-60 stub)', () => {
    renderHeader({
      lens: 'expert',
      requestStatus: 'proposal_requested',
      threadOverrides: { relationshipStatus: 'proposal_requested' },
      onBuildProposal: null,
    });
    expect(screen.queryByRole('button', { name: 'Build proposal' })).not.toBeInTheDocument();
    expect(document.body.querySelector('.opacity-60')).toBeNull();
  });

  it('expert lens with a handler: Build proposal is ENABLED and fires it (A6.2)', async () => {
    const user = userEvent.setup();
    const onBuildProposal = vi.fn();
    renderHeader({
      lens: 'expert',
      requestStatus: 'proposal_requested',
      threadOverrides: { relationshipStatus: 'proposal_requested' },
      onBuildProposal,
    });
    const proposal = screen.getByRole('button', { name: 'Build proposal' });
    expect(proposal).toBeEnabled();
    expect(proposal).not.toHaveAttribute('aria-disabled');
    expect(proposal.className).toContain('text-primary-foreground');
    expect(proposal.className).not.toContain('bg-gradient-to-r');
    await user.click(proposal);
    expect(onBuildProposal).toHaveBeenCalledTimes(1);
  });

  it('expert lens: Propose times + Awaiting proposal request pill + (you)', () => {
    renderHeader({ lens: 'expert' });
    expect(screen.getByRole('button', { name: 'Propose times' })).toBeInTheDocument();
    expect(screen.getByText('Awaiting proposal request')).toBeInTheDocument();
    expect(screen.getByText('(you)')).toBeInTheDocument();
  });

  it('client + proposal_requested: warning pill, no proposal button', () => {
    renderHeader({
      requestStatus: 'proposal_requested',
      threadOverrides: { relationshipStatus: 'proposal_requested' },
    });
    expect(screen.getByText('Proposal requested')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request proposal' })).not.toBeInTheDocument();
  });

  it('proposal submitted without a handler: the View proposal slot renders NOTHING', () => {
    renderHeader({
      requestStatus: 'proposal_submitted',
      threadOverrides: { relationshipStatus: 'proposal_submitted' },
      onViewProposal: null,
    });
    expect(screen.queryByRole('button', { name: 'View proposal' })).not.toBeInTheDocument();
  });

  it('proposal submitted with a handler: View proposal is ENABLED and fires it (A6.3)', async () => {
    const user = userEvent.setup();
    const onViewProposal = vi.fn();
    renderHeader({
      requestStatus: 'proposal_submitted',
      threadOverrides: { relationshipStatus: 'proposal_submitted' },
      onViewProposal,
    });
    const cta = screen.getByRole('button', { name: 'View proposal' });
    expect(cta).toBeEnabled();
    expect(cta).not.toHaveAttribute('aria-disabled');
    await user.click(cta);
    expect(onViewProposal).toHaveBeenCalledTimes(1);
  });

  it('expert lens + proposal submitted: View submitted proposal is ENABLED and fires it (A6.3)', async () => {
    const user = userEvent.setup();
    const onViewProposal = vi.fn();
    renderHeader({
      lens: 'expert',
      requestStatus: 'proposal_submitted',
      threadOverrides: { relationshipStatus: 'proposal_submitted' },
      onViewProposal,
    });
    const cta = screen.getByRole('button', { name: 'View submitted proposal' });
    expect(cta).toBeEnabled();
    await user.click(cta);
    expect(onViewProposal).toHaveBeenCalledTimes(1);
  });

  it('keeps Book a call after kickoff on the won thread (BAL-616)', () => {
    renderHeader({
      requestStatus: 'kickoff_approved',
      threadOverrides: { relationshipStatus: 'accepted', stage: 'won' },
    });
    expect(screen.getByRole('button', { name: 'Book a call' })).toBeInTheDocument();
  });

  // ── BAL-283 — the callSlot states on the desktop header ─────────────────────────────────

  it("expert, availability_shared_at set: renders the quiet 'Availability shared' pill, not a button", () => {
    renderHeader({
      lens: 'expert',
      threadOverrides: { availabilitySharedAtIso: '2026-08-20T00:00:00.000Z' },
    });
    expect(screen.queryByRole('button', { name: 'Propose times' })).not.toBeInTheDocument();
    const pill = screen.getByText('Availability shared');
    expect(pill.closest('[aria-disabled="true"]')).not.toBeNull();
  });

  // ── BAL-616 — book / join / next call ────────────────────────────────────────────────────

  it('an upcoming call replaces Book a call with one Join slot and a Book another call button', async () => {
    const user = userEvent.setup();
    const { onBookAnother, onCall } = renderHeader({
      threadOverrides: { upcomingCalls: [IN_TWO_DAYS] },
    });
    expect(screen.queryByRole('button', { name: 'Book a call' })).not.toBeInTheDocument();
    expect(screen.getAllByTestId('join-countdown')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Book another call' }));
    expect(onBookAnother).toHaveBeenCalledTimes(1);
    expect(onCall).not.toHaveBeenCalled();
  });

  it('the expert lens sees the upcoming call but gets no Book another call button', () => {
    renderHeader({ lens: 'expert', threadOverrides: { upcomingCalls: [IN_TWO_DAYS] } });
    expect(screen.getByTestId('join-countdown')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Book another call' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Book a call' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Propose times' })).not.toBeInTheDocument();
  });

  it('the expert lens never gets a Book a call control in any state', () => {
    renderHeader({ lens: 'expert' });
    expect(screen.queryByRole('button', { name: /Book (a|another) call/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Propose times' })).toBeInTheDocument();
  });

  it('puts the next-call line under the name, with the +N more popover', async () => {
    const user = userEvent.setup();
    renderHeader({ threadOverrides: { upcomingCalls: [IN_TWO_DAYS, IN_THREE_DAYS] } });
    expect(screen.getByText(/Next call/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show 1 more upcoming call' }));
    expect(await screen.findByText('Upcoming calls')).toBeInTheDocument();
  });

  it('a thread the request moved on from links to the expert profile booking flow', async () => {
    const user = userEvent.setup();
    const { onCall } = renderHeader({
      requestStatus: 'accepted',
      threadOverrides: {
        stage: 'not_selected',
        relationshipStatus: 'declined',
        expertUsername: 'priya',
      },
      profileBookingHref: '/experts/priya?book=1&src=request_thread',
    });
    // jsdom cannot navigate; swallow the default action after React has handled the click.
    document.addEventListener('click', (event) => event.preventDefault(), { once: true });
    const link = screen.getByRole('link', { name: 'Book a call' });
    expect(link).toHaveAttribute('href', '/experts/priya?book=1&src=request_thread');
    expect(link).toHaveAttribute('title', "Opens Priya's profile to book a consultation");
    await user.click(link);
    expect(onCall).toHaveBeenCalledTimes(1);
  });

  it('a completed or cancelled project links the won thread to the expert profile, not the in-place dialog', () => {
    renderHeader({
      requestStatus: 'kickoff_approved',
      threadOverrides: { stage: 'won', relationshipStatus: 'accepted', expertUsername: 'priya' },
      profileBookingHref: '/experts/priya?book=1&src=request_thread',
      deliveryEngagementId: 'eng-1',
      deliveryActive: false,
    });
    expect(screen.getByRole('link', { name: 'Book a call' })).toHaveAttribute(
      'href',
      '/experts/priya?book=1&src=request_thread'
    );
    expect(screen.queryByRole('button', { name: 'Book a call' })).not.toBeInTheDocument();
  });

  it('an ended project keeps a booked call visible but hides Book another call', () => {
    renderHeader({
      requestStatus: 'kickoff_approved',
      threadOverrides: {
        stage: 'won',
        relationshipStatus: 'accepted',
        upcomingCalls: [IN_TWO_DAYS],
      },
      deliveryActive: false,
    });
    expect(screen.getByTestId('join-countdown')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Book another call' })).not.toBeInTheDocument();
  });

  it('shows no call control at all when the expert has no public profile to book through', () => {
    renderHeader({
      requestStatus: 'closed',
      threadOverrides: { stage: 'request_closed', expertUsername: null },
    });
    expect(screen.queryByRole('button', { name: /call/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /call/i })).not.toBeInTheDocument();
  });

  describe('with the viewer clock resolved', () => {
    it('renders the when-label and links a project call to the delivery workspace', () => {
      clockRef.value = { now: NOW, timeZone: 'UTC' };
      renderHeader({
        threadOverrides: { upcomingCalls: [IN_THREE_DAYS], stage: 'won' },
        requestStatus: 'kickoff_approved',
        deliveryEngagementId: 'eng-1',
      });
      const link = screen.getByRole('link', { name: 'Fri 4 Sep at 4:00 am' });
      expect(link).toHaveAttribute('href', '/engagements/eng-1?from=request_detail');
      clockRef.value = null;
    });

    it('a request-interaction call is plain text, never a link', () => {
      clockRef.value = { now: NOW, timeZone: 'UTC' };
      renderHeader({ threadOverrides: { upcomingCalls: [IN_TWO_DAYS] } });
      expect(screen.getByText('Thu 3 Sep at 4:00 am')).toBeInTheDocument();
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      clockRef.value = null;
    });

    it('inside the join window the Join slot is a live button and reports the click', async () => {
      const user = userEvent.setup();
      const assign = vi.fn();
      const realLocation = globalThis.location;
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: { href: realLocation.href, origin: realLocation.origin, assign },
      });
      clockRef.value = { now: new Date('2026-09-03T03:58:00.000Z'), timeZone: 'UTC' };
      const { onJoin } = renderHeader({ threadOverrides: { upcomingCalls: [IN_TWO_DAYS] } });
      const join = screen.getByRole('button', { name: /Join Priya Nair's meeting/ });
      expect(join).not.toHaveAttribute('aria-disabled');
      expect(screen.queryByTestId('join-countdown')).not.toBeInTheDocument();
      await user.click(join);
      expect(onJoin).toHaveBeenCalledWith(IN_TWO_DAYS);
      expect(assign).toHaveBeenCalledWith('/meetings/meeting-1/call');
      Object.defineProperty(globalThis, 'location', { configurable: true, value: realLocation });
      clockRef.value = null;
    });
  });

  // ── BAL-540 — the decline control ────────────────────────────────────────────────────────

  it('omits the decline control when canDecline is false, even on an active thread', () => {
    renderHeader({ canDecline: false, onDecline: vi.fn() });
    expect(
      screen.queryByRole('button', { name: /Decline|Withdraw invite/i })
    ).not.toBeInTheDocument();
  });

  it('shows the decline control when canDecline is true and the thread is active', async () => {
    const user = userEvent.setup();
    const onDecline = vi.fn();
    renderHeader({
      canDecline: true,
      onDecline,
      threadOverrides: { relationshipStatus: 'eoi_submitted', stage: 'active' },
    });
    const button = screen.getByRole('button', { name: /Decline Priya Nair/i });
    await user.click(button);
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it('uses "Withdraw invite" as the label verb when the relationship is still invited', () => {
    renderHeader({
      canDecline: true,
      onDecline: vi.fn(),
      threadOverrides: { relationshipStatus: 'invited', stage: 'active' },
    });
    expect(screen.getByRole('button', { name: /Withdraw invite Priya Nair/i })).toBeInTheDocument();
  });

  it('omits the decline control once the thread is decided, even with canDecline true', () => {
    renderHeader({
      canDecline: true,
      onDecline: vi.fn(),
      requestStatus: 'accepted',
      threadOverrides: { relationshipStatus: 'accepted', stage: 'won' },
    });
    expect(
      screen.queryByRole('button', { name: /Decline|Withdraw invite/i })
    ).not.toBeInTheDocument();
  });
});
