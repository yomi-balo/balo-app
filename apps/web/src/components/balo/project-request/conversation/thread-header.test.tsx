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

  it('expert lens: Build proposal stays a disabled stub (the stage passes null — A6 wires it)', () => {
    renderHeader({
      lens: 'expert',
      requestStatus: 'proposal_requested',
      threadOverrides: { relationshipStatus: 'proposal_requested' },
      onRequestProposal: null,
    });
    const proposal = screen.getByRole('button', { name: 'Build proposal' });
    expect(proposal).toBeDisabled();
    expect(proposal).toHaveAttribute('aria-disabled', 'true');
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

  it('proposal submitted: disabled View proposal stub', () => {
    renderHeader({
      requestStatus: 'proposal_submitted',
      threadOverrides: { relationshipStatus: 'proposal_submitted' },
    });
    expect(screen.getByRole('button', { name: 'View proposal' })).toBeDisabled();
  });

  it('hides the call CTA once the request reaches kickoff', () => {
    renderHeader({
      requestStatus: 'kickoff_approved',
      threadOverrides: { relationshipStatus: 'accepted', stage: 'won' },
    });
    expect(screen.queryByRole('button', { name: 'Book a call' })).not.toBeInTheDocument();
  });
});
