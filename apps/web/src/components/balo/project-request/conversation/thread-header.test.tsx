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
  fileCount?: number;
  filesOpen?: boolean;
  /** Non-null → the proposal slot renders enabled (client lens, A5). */
  onRequestProposal?: (() => void) | null;
  /** Non-null → the expert "Build proposal" CTA renders enabled (A6.2). */
  onBuildProposal?: (() => void) | null;
  /** Non-null → the "View proposal"/"View submitted" CTA renders enabled (A6.3). */
  onViewProposal?: (() => void) | null;
}): {
  onToggleFiles: ReturnType<typeof vi.fn>;
  onCall: ReturnType<typeof vi.fn>;
} {
  const lens = input.lens ?? 'client';
  const requestStatus = input.requestStatus ?? 'eoi_submitted';
  const t = thread(input.threadOverrides);
  const actions = deriveThreadActions({ lens, requestStatus, thread: t, nudgeIsProposal: false });
  const onToggleFiles = vi.fn();
  const onCall = vi.fn();
  render(
    <ThreadHeader
      thread={t}
      showYouSuffix={lens === 'expert'}
      fileCount={input.fileCount ?? 0}
      filesOpen={input.filesOpen ?? false}
      actions={actions}
      callPending={false}
      onToggleFiles={onToggleFiles}
      onCall={onCall}
      onRequestProposal={input.onRequestProposal ?? null}
      onBuildProposal={input.onBuildProposal ?? null}
      onViewProposal={input.onViewProposal ?? null}
    />
  );
  return { onToggleFiles, onCall };
}

describe('ThreadHeader', () => {
  it('shows the expert identity and the Files pill with its count', () => {
    renderHeader({ fileCount: 3 });
    expect(screen.getByText('Priya Nair')).toBeInTheDocument();
    const filesButton = screen.getByRole('button', { name: /Files/ });
    expect(filesButton).toHaveAttribute('aria-expanded', 'false');
    expect(filesButton).toHaveTextContent('3');
  });

  it('toggles the files panel', async () => {
    const user = userEvent.setup();
    const { onToggleFiles } = renderHeader({});
    await user.click(screen.getByRole('button', { name: /Files/ }));
    expect(onToggleFiles).toHaveBeenCalled();
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
});
