import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { track } from '@/lib/analytics';
import type { CloseRequestActionResult } from '@/app/(dashboard)/projects/[requestId]/_actions/close-request';
import type { CloseRequestAsAdminActionResult } from '@/app/(dashboard)/projects/[requestId]/_actions/close-request-as-admin';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const closeRequestAction = vi.fn<(input: unknown) => Promise<CloseRequestActionResult>>();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/close-request', () => ({
  closeRequestAction: (input: unknown) => closeRequestAction(input),
}));

const closeRequestAsAdminAction =
  vi.fn<(input: unknown) => Promise<CloseRequestAsAdminActionResult>>();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/close-request-as-admin', () => ({
  closeRequestAsAdminAction: (input: unknown) => closeRequestAsAdminAction(input),
}));

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

import { CloseRequestSheet } from './close-request-sheet';

const REQUEST_ID = '11111111-1111-1111-1111-111111111111';
const mockToast = vi.mocked(toast);
const mockTrack = vi.mocked(track);

const CLIENT_SUCCESS: CloseRequestActionResult = {
  success: true,
  analytics: {
    reason: 'withdrawn',
    actorKind: 'client',
    stageAtClose: 'proposal_submitted',
    openTracks: 2,
    openProposals: 1,
    tracksEnded: 2,
  },
};

const ADMIN_SUCCESS: CloseRequestAsAdminActionResult = {
  success: true,
  analytics: {
    reason: 'unfilled',
    actorKind: 'balo',
    stageAtClose: 'experts_invited',
    openTracks: 1,
    openProposals: 0,
    tracksEnded: 1,
  },
};

const TRACKS = [
  { expertName: 'Priya Nair', partyLabel: 'Priya Nair', stage: 'proposal_submitted' as const },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CloseRequestSheet — client variant', () => {
  it('names every live track in the consequence list and shows no reason picker', () => {
    render(
      <CloseRequestSheet
        open
        onOpenChange={vi.fn()}
        requestId={REQUEST_ID}
        requestTitle="CPQ implementation"
        companyName="Northwind Industrial"
        variant="client"
        liveTracks={TRACKS}
      />
    );
    expect(screen.getByText(/Priya Nair.?s proposal is withdrawn/)).toBeInTheDocument();
    expect(screen.queryByText('Why is Balo closing it?')).not.toBeInTheDocument();
    expect(screen.getByText(/recorded as withdrawn by Northwind Industrial/)).toBeInTheDocument();
  });

  it('confirm is enabled immediately (no reason required) and calls closeRequestAction', async () => {
    const user = userEvent.setup();
    closeRequestAction.mockResolvedValue(CLIENT_SUCCESS);
    const onOpenChange = vi.fn();
    render(
      <CloseRequestSheet
        open
        onOpenChange={onOpenChange}
        requestId={REQUEST_ID}
        requestTitle="CPQ implementation"
        companyName="Northwind Industrial"
        variant="client"
        liveTracks={TRACKS}
      />
    );
    const confirm = screen.getByRole('button', { name: /close request/i });
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(closeRequestAction).toHaveBeenCalledWith({ requestId: REQUEST_ID }));
    expect(mockTrack).toHaveBeenCalledWith(
      'project_request_closed',
      expect.objectContaining({ request_id: REQUEST_ID, reason: 'withdrawn', actor_kind: 'client' })
    );
    // TRACKS ENDED, not "experts told" — the action cannot know how many experts the
    // post-commit fan-out actually reached (Qodo #13).
    expect(mockToast.success).toHaveBeenCalledWith(expect.stringContaining('2 tracks ended'));
    expect(mockToast.success).not.toHaveBeenCalledWith(expect.stringContaining('told'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(refresh).toHaveBeenCalled();
  });

  it('shows the error toast and stays open on failure', async () => {
    const user = userEvent.setup();
    closeRequestAction.mockResolvedValue({ success: false, error: 'Nope.' });
    const onOpenChange = vi.fn();
    render(
      <CloseRequestSheet
        open
        onOpenChange={onOpenChange}
        requestId={REQUEST_ID}
        requestTitle="CPQ implementation"
        companyName="Northwind Industrial"
        variant="client"
        liveTracks={TRACKS}
      />
    );
    await user.click(screen.getByRole('button', { name: /close request/i }));
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('Nope.'));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe('CloseRequestSheet — admin variant', () => {
  it('confirm stays disabled until a reason is picked AND an 8-char note is entered', async () => {
    const user = userEvent.setup();
    render(
      <CloseRequestSheet
        open
        onOpenChange={vi.fn()}
        requestId={REQUEST_ID}
        requestTitle="CPQ implementation"
        companyName="Northwind Industrial"
        variant="admin"
        liveTracks={TRACKS}
      />
    );
    const confirm = screen.getByRole('button', { name: /close request/i });
    expect(confirm).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /^Unfilled/ }));
    expect(confirm).toBeDisabled(); // reason alone is not enough

    const note = screen.getByLabelText(/Balo-only note/i);
    await user.type(note, 'short');
    expect(confirm).toBeDisabled(); // under 8 chars

    await user.type(note, ' enough now');
    expect(confirm).toBeEnabled();
  });

  it('the reason picker announces selection PROGRAMMATICALLY, not by colour alone', async () => {
    const user = userEvent.setup();
    render(
      <CloseRequestSheet
        open
        onOpenChange={vi.fn()}
        requestId={REQUEST_ID}
        requestTitle="CPQ implementation"
        companyName="Northwind Industrial"
        variant="admin"
        liveTracks={TRACKS}
      />
    );
    const unfilled = screen.getByRole('button', { name: /^Unfilled/ });
    const superseded = screen.getByRole('button', { name: /^Superseded/ });

    // Nothing picked yet — every option is explicitly "not pressed", not merely un-styled.
    expect(unfilled).toHaveAttribute('aria-pressed', 'false');
    expect(superseded).toHaveAttribute('aria-pressed', 'false');

    await user.click(unfilled);
    expect(unfilled).toHaveAttribute('aria-pressed', 'true');
    // Single-select: picking one un-presses the others.
    expect(superseded).toHaveAttribute('aria-pressed', 'false');
  });

  it('the consequence-list intro is wired as the dialog description (announced on open)', () => {
    render(
      <CloseRequestSheet
        open
        onOpenChange={vi.fn()}
        requestId={REQUEST_ID}
        requestTitle="CPQ implementation"
        companyName="Northwind Industrial"
        variant="admin"
        liveTracks={TRACKS}
      />
    );
    // ⚠ This sheet renders a REAL `SheetDescription`, so it must NOT copy its siblings'
    // `aria-describedby={undefined}` override — that suppresses Radix's automatic wiring and a
    // screen reader never hears the "here is what happens" intro on a destructive confirm.
    const dialog = screen.getByRole('dialog');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(String(describedBy))?.textContent).toContain(
      'Here is what happens'
    );
  });

  it('calls closeRequestAsAdminAction with the picked reason and trimmed note', async () => {
    const user = userEvent.setup();
    closeRequestAsAdminAction.mockResolvedValue(ADMIN_SUCCESS);
    render(
      <CloseRequestSheet
        open
        onOpenChange={vi.fn()}
        requestId={REQUEST_ID}
        requestTitle="CPQ implementation"
        companyName="Northwind Industrial"
        variant="admin"
        liveTracks={TRACKS}
      />
    );
    await user.click(screen.getByRole('button', { name: /^Unfilled/ }));
    await user.type(screen.getByLabelText(/Balo-only note/i), 'Could not staff it in time.');
    await user.click(screen.getByRole('button', { name: /close request/i }));

    await waitFor(() =>
      expect(closeRequestAsAdminAction).toHaveBeenCalledWith({
        requestId: REQUEST_ID,
        reason: 'unfilled',
        note: 'Could not staff it in time.',
      })
    );
    expect(mockToast.success).toHaveBeenCalledWith(expect.stringContaining('1 track ended'));
  });

  it('shows the on-behalf mail-notice row (client is told the reason, never the note)', () => {
    render(
      <CloseRequestSheet
        open
        onOpenChange={vi.fn()}
        requestId={REQUEST_ID}
        requestTitle="CPQ implementation"
        companyName="Northwind Industrial"
        variant="admin"
        liveTracks={TRACKS}
      />
    );
    expect(
      screen.getByText(/Northwind Industrial is told the request was closed and why/)
    ).toBeInTheDocument();
  });
});
