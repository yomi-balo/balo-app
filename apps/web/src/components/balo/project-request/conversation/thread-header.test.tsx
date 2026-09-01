import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { ThreadHeader } from './thread-header';
import { deriveThreadActions } from './thread-actions';
import { thread } from '@/test/fixtures/conversation';
import type { ConversationThreadView } from '@/lib/project-request/conversation-view-types';
import type { ProjectRequestStatus } from '@/lib/project-request/resolve-request-lens';

function renderHeader(input: {
  lens?: 'client' | 'expert';
  requestStatus?: ProjectRequestStatus;
  threadOverrides?: Partial<ConversationThreadView>;
  /** Non-null → the proposal slot renders enabled (client lens, A5). */
  onRequestProposal?: (() => void) | null;
  /** Non-null → the expert "Build proposal" CTA renders enabled (A6.2). */
  onBuildProposal?: (() => void) | null;
  /** Non-null → the "View proposal"/"View submitted" CTA renders enabled (A6.3). */
  onViewProposal?: (() => void) | null;
}): {
  onCall: ReturnType<typeof vi.fn>;
} {
  const lens = input.lens ?? 'client';
  const requestStatus = input.requestStatus ?? 'eoi_submitted';
  const t = thread(input.threadOverrides);
  const actions = deriveThreadActions({ lens, requestStatus, thread: t, nudgeIsProposal: false });
  const onCall = vi.fn();
  render(
    <ThreadHeader
      thread={t}
      showYouSuffix={lens === 'expert'}
      actions={actions}
      callPending={false}
      onCall={onCall}
      onRequestProposal={input.onRequestProposal ?? null}
      onBuildProposal={input.onBuildProposal ?? null}
      onViewProposal={input.onViewProposal ?? null}
    />
  );
  return { onCall };
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

  it('client lens without a handler: Book a call + disabled Request proposal stub', async () => {
    const user = userEvent.setup();
    const { onCall } = renderHeader({});
    await user.click(screen.getByRole('button', { name: 'Book a call' }));
    expect(onCall).toHaveBeenCalled();
    const proposal = screen.getByRole('button', { name: 'Request proposal' });
    expect(proposal).toBeDisabled();
    expect(proposal).toHaveAttribute('aria-disabled', 'true');
  });

  it('client lens with a handler: Request proposal is ENABLED and fires it (A5)', async () => {
    const user = userEvent.setup();
    const onRequestProposal = vi.fn();
    renderHeader({ onRequestProposal });
    const proposal = screen.getByRole('button', { name: 'Request proposal' });
    expect(proposal).toBeEnabled();
    expect(proposal).not.toHaveAttribute('aria-disabled');
    await user.click(proposal);
    expect(onRequestProposal).toHaveBeenCalledTimes(1);
  });

  it('expert lens without a handler: Build proposal renders as a disabled stub', () => {
    renderHeader({
      lens: 'expert',
      requestStatus: 'proposal_requested',
      threadOverrides: { relationshipStatus: 'proposal_requested' },
      onBuildProposal: null,
    });
    const proposal = screen.getByRole('button', { name: 'Build proposal' });
    expect(proposal).toBeDisabled();
    expect(proposal).toHaveAttribute('aria-disabled', 'true');
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

  it('proposal submitted without a handler: disabled View proposal stub (defensive)', () => {
    renderHeader({
      requestStatus: 'proposal_submitted',
      threadOverrides: { relationshipStatus: 'proposal_submitted' },
      onViewProposal: null,
    });
    const stub = screen.getByRole('button', { name: 'View proposal' });
    expect(stub).toBeDisabled();
    expect(stub).toHaveAttribute('aria-disabled', 'true');
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

  it('expert lens + proposal submitted: View submitted is ENABLED and fires it (A6.3)', async () => {
    const user = userEvent.setup();
    const onViewProposal = vi.fn();
    renderHeader({
      lens: 'expert',
      requestStatus: 'proposal_submitted',
      threadOverrides: { relationshipStatus: 'proposal_submitted' },
      onViewProposal,
    });
    const cta = screen.getByRole('button', { name: 'View submitted' });
    expect(cta).toBeEnabled();
    await user.click(cta);
    expect(onViewProposal).toHaveBeenCalledTimes(1);
  });

  it('hides the call CTA once the request reaches kickoff', () => {
    renderHeader({
      requestStatus: 'kickoff_approved',
      threadOverrides: { relationshipStatus: 'accepted', stage: 'won' },
    });
    expect(screen.queryByRole('button', { name: 'Book a call' })).not.toBeInTheDocument();
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

  it('a booked call removes the call CTA slot entirely, for either lens', () => {
    const bookedCall = { meetingId: 'meeting-1', scheduledStartIso: '2026-09-01T04:00:00.000Z' };
    renderHeader({ lens: 'client', threadOverrides: { bookedCall } });
    expect(screen.queryByRole('button', { name: 'Book a call' })).not.toBeInTheDocument();
    expect(screen.queryByText('Availability shared')).not.toBeInTheDocument();
  });
});
