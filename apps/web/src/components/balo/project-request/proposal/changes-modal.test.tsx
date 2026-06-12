import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import type { RequestProposalChangesResult } from '@/app/(dashboard)/projects/[requestId]/_actions/request-proposal-changes';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const requestProposalChangesAction =
  vi.fn<(input: unknown) => Promise<RequestProposalChangesResult>>();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/request-proposal-changes', () => ({
  requestProposalChangesAction: (input: unknown) => requestProposalChangesAction(input),
}));

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}));

import { ChangesModal } from './changes-modal';

const REQUEST_ID = '11111111-1111-1111-1111-111111111111';
const RELATIONSHIP_ID = '22222222-2222-2222-2222-222222222222';
const PROPOSAL_ID = '33333333-3333-3333-3333-333333333333';
const EXPERT_PROFILE_ID = '44444444-4444-4444-4444-444444444444';

const mockToast = vi.mocked(toast);
const mockTrack = vi.mocked(track);

// Radix Select drives the open/select interaction through Pointer Capture APIs
// jsdom doesn't implement — stub them so the section listbox can open.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn();
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

function renderModal(open = true): {
  onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;
  rerender: (open: boolean) => void;
} {
  const onOpenChange = vi.fn<(open: boolean) => void>();
  const ui = (isOpen: boolean): React.JSX.Element => (
    <ChangesModal
      open={isOpen}
      onOpenChange={onOpenChange}
      requestId={REQUEST_ID}
      relationshipId={RELATIONSHIP_ID}
      proposalId={PROPOSAL_ID}
      expertFirstName="Priya"
    />
  );
  const { rerender } = render(ui(open));
  return { onOpenChange, rerender: (next: boolean) => rerender(ui(next)) };
}

function sendButton(): HTMLElement {
  return screen.getByRole('button', { name: /Send request/ });
}

describe('ChangesModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('frames the request with the expert name and revise/independence copy', () => {
    renderModal();
    expect(screen.getByText('Request changes from Priya')).toBeInTheDocument();
    expect(screen.getByText(/will revise and resubmit as a new version/)).toBeInTheDocument();
    expect(screen.getByText(/other proposal isn't affected/)).toBeInTheDocument();
  });

  it('defaults the section Select to General', () => {
    renderModal();
    // The trigger renders the current SelectValue text — General by default.
    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveTextContent('General');
  });

  it('associates the note label with the textarea (a11y)', () => {
    renderModal();
    expect(screen.getByLabelText('Your note')).toBeInTheDocument();
  });

  it('keeps Send request disabled until the note has non-whitespace content', async () => {
    const user = userEvent.setup();
    renderModal();
    expect(sendButton()).toBeDisabled();

    const note = screen.getByLabelText('Your note');
    // Whitespace-only stays disabled.
    await user.type(note, '   ');
    expect(sendButton()).toBeDisabled();

    await user.type(note, 'Please lower the price');
    expect(sendButton()).toBeEnabled();
  });

  it('does nothing on Send while the note is empty (disabled — handler never runs)', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(sendButton());
    expect(requestProposalChangesAction).not.toHaveBeenCalled();
  });

  it('on send calls the action with the trimmed note + default section, fires analytics (with the action-returned expert id), toasts, closes, refreshes', async () => {
    const user = userEvent.setup();
    requestProposalChangesAction.mockResolvedValue({
      success: true,
      expertProfileId: EXPERT_PROFILE_ID,
    });
    const { onOpenChange } = renderModal();

    await user.type(screen.getByLabelText('Your note'), '  Please add a discovery milestone  ');
    await user.click(sendButton());

    await waitFor(() =>
      expect(requestProposalChangesAction).toHaveBeenCalledWith({
        requestId: REQUEST_ID,
        relationshipId: RELATIONSHIP_ID,
        proposalId: PROPOSAL_ID,
        section: 'general',
        note: 'Please add a discovery milestone',
      })
    );
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.CHANGES_REQUESTED, {
      request_id: REQUEST_ID,
      relationship_id: RELATIONSHIP_ID,
      expert_id: EXPERT_PROFILE_ID,
      section: 'general',
      actor: 'client',
    });
    expect(mockToast.success).toHaveBeenCalledWith('Change request sent to Priya');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(refresh).toHaveBeenCalled();
  });

  it('sends the chosen section when the client picks a different area', async () => {
    const user = userEvent.setup();
    requestProposalChangesAction.mockResolvedValue({
      success: true,
      expertProfileId: EXPERT_PROFILE_ID,
    });
    renderModal();

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'Pricing' }));
    await user.type(screen.getByLabelText('Your note'), 'Too high');
    await user.click(sendButton());

    await waitFor(() =>
      expect(requestProposalChangesAction).toHaveBeenCalledWith(
        expect.objectContaining({ section: 'pricing', note: 'Too high' })
      )
    );
    expect(mockTrack).toHaveBeenCalledWith(
      PROJECT_EVENTS.CHANGES_REQUESTED,
      expect.objectContaining({ section: 'pricing' })
    );
  });

  it('toasts the returned error and stays open on a failure result (retryable)', async () => {
    const user = userEvent.setup();
    requestProposalChangesAction.mockResolvedValue({
      success: false,
      error: 'This proposal has already moved on. Refresh to see the latest.',
    });
    const { onOpenChange } = renderModal();

    await user.type(screen.getByLabelText('Your note'), 'Tweak the timeline');
    await user.click(sendButton());

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        'This proposal has already moved on. Refresh to see the latest.'
      )
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('toasts a generic error and stays open when the action throws (catch path)', async () => {
    const user = userEvent.setup();
    requestProposalChangesAction.mockRejectedValue(new Error('boom'));
    const { onOpenChange } = renderModal();

    await user.type(screen.getByLabelText('Your note'), 'Adjust scope');
    await user.click(sendButton());

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        'Could not send your change request. Please try again.'
      )
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('Cancel closes the modal without calling the action', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderModal();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(requestProposalChangesAction).not.toHaveBeenCalled();
  });

  it('resets the note when the modal is reopened (no stale draft carries over)', async () => {
    const user = userEvent.setup();
    const { rerender } = renderModal(true);

    await user.type(screen.getByLabelText('Your note'), 'Old draft');
    expect(sendButton()).toBeEnabled();

    // Close then reopen — the note effect clears on open.
    rerender(false);
    rerender(true);

    expect(screen.getByLabelText('Your note')).toHaveValue('');
    expect(sendButton()).toBeDisabled();
  });
});
