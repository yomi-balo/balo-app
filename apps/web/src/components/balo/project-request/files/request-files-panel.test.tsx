import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { RequestFilesPanel } from './request-files-panel';
import type { RequestFilesView } from '@/lib/request-files/load-request-files';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const OTHER_REL_ID = 'b0000000-0000-4000-8000-000000000003';
const FILE_ID = 'd0000000-0000-4000-8000-000000000007';

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

const mockDownload = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/get-request-file-download', () => ({
  getRequestFileDownloadAction: (...args: unknown[]) => mockDownload(...args),
}));

const mockDelete = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/delete-request-file', () => ({
  deleteRequestFileAction: (...args: unknown[]) => mockDelete(...args),
}));

const mockRevoke = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/revoke-request-file-grant', () => ({
  revokeRequestFileGrantAction: (...args: unknown[]) => mockRevoke(...args),
}));

const mockPresignUpload = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/request-shared-file-upload', () => ({
  requestSharedFileUploadAction: (...args: unknown[]) => mockPresignUpload(...args),
}));
const mockConfirmUpload = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/confirm-request-file-upload', () => ({
  confirmRequestFileUploadAction: (...args: unknown[]) => mockConfirmUpload(...args),
}));

const CLIENT_FILE = {
  id: FILE_ID,
  fileName: 'Requirements.pdf',
  contentType: 'application/pdf',
  sizeBytes: 2048,
  source: 'client' as const,
  uploadedByName: 'Sarah Chen @ Acme Corp',
  createdAtIso: '2026-08-01T00:00:00.000Z',
  audience: {
    type: 'grants' as const,
    grants: [{ relationshipId: REL_ID, trackName: 'Wei Zhang' }],
  },
  canDelete: true,
};

const CLIENT_PARTY = 'Acme Corp';

/** A CLIENT-uploaded file as the EXPERT lens serializes it — the arm that must stay bare. */
const CLIENT_FILE_AS_EXPERT_SEES_IT = {
  id: FILE_ID,
  fileName: 'Requirements.pdf',
  contentType: 'application/pdf',
  sizeBytes: 2048,
  source: 'client' as const,
  uploadedByName: CLIENT_PARTY,
  createdAtIso: '2026-08-01T00:00:00.000Z',
  sharedBeforeYouJoined: false,
  canDelete: false,
};

const EXPERT_FILE = {
  id: FILE_ID,
  fileName: 'Proposal-draft.pdf',
  contentType: 'application/pdf',
  sizeBytes: 512,
  source: 'you' as const,
  uploadedByName: 'You',
  createdAtIso: '2026-08-02T00:00:00.000Z',
  sharedBeforeYouJoined: false,
  canDelete: true,
};

const ADMIN_FILE = {
  id: FILE_ID,
  fileName: 'Requirements.pdf',
  contentType: 'application/pdf',
  sizeBytes: 2048,
  side: 'client' as const,
  audience: 'all_live_tracks' as const,
  uploadedByName: 'Sarah Chen',
  createdAtIso: '2026-08-01T00:00:00.000Z',
  visibleTo: [{ relationshipId: REL_ID, trackName: 'Wei Zhang', via: 'all_live_tracks' as const }],
  deleted: false,
  deletedAtIso: null,
  deletedByName: null,
};

describe('RequestFilesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('client lens: the share sheet’s picker restricts the selectable types', async () => {
    const user = userEvent.setup();
    const view: RequestFilesView = { lens: 'client', files: [], liveTracks: [] };
    render(<RequestFilesPanel requestId={REQUEST_ID} initialView={view} />);
    await user.click(screen.getByRole('button', { name: /Share a file/ }));
    expect(await screen.findByLabelText('File')).toHaveAttribute('accept');
  });

  it('client lens: renders an invitation-framed empty state, not an absence one', () => {
    const view: RequestFilesView = { lens: 'client', files: [], liveTracks: [] };
    render(<RequestFilesPanel requestId={REQUEST_ID} initialView={view} />);
    expect(screen.getByText('Share a file with the experts on this request')).toBeInTheDocument();
  });

  it('client lens: renders audience badges and revoke removes a grant', async () => {
    const user = userEvent.setup();
    const view: RequestFilesView = { lens: 'client', files: [CLIENT_FILE], liveTracks: [] };
    render(<RequestFilesPanel requestId={REQUEST_ID} initialView={view} />);
    expect(screen.getByText('Wei Zhang only')).toBeInTheDocument();

    mockRevoke.mockResolvedValue({ success: true });
    await user.click(screen.getByRole('button', { name: 'Remove access for Wei Zhang' }));

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    expect(mockRevoke).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      fileId: FILE_ID,
      relationshipId: REL_ID,
    });
  });

  /**
   * ⚠ DELETE IS CONFIRMED FIRST. Ruling 1 made it destroy the R2 object and Ruling 3 made the
   * right party-level, so the trash icon must NOT be the point of no return. The dialog names
   * the file.
   */
  it('client lens: delete asks for confirmation naming the file, then removes the row', async () => {
    const user = userEvent.setup();
    const view: RequestFilesView = { lens: 'client', files: [CLIENT_FILE], liveTracks: [] };
    render(<RequestFilesPanel requestId={REQUEST_ID} initialView={view} />);
    mockDelete.mockResolvedValue({ success: true });

    await user.click(screen.getByRole('button', { name: 'Remove Requirements.pdf' }));

    // The action has NOT fired yet — the dialog is the gate.
    expect(mockDelete).not.toHaveBeenCalled();
    expect(await screen.findByText('Remove Requirements.pdf?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove file' }));

    await waitFor(() => expect(screen.queryByText('Requirements.pdf')).not.toBeInTheDocument());
    expect(mockDelete).toHaveBeenCalledWith({ requestId: REQUEST_ID, fileId: FILE_ID });
    expect(mockToastSuccess).toHaveBeenCalledWith('File removed. No notification is sent.');
  });

  it('client lens: cancelling the confirmation destroys nothing', async () => {
    const user = userEvent.setup();
    const view: RequestFilesView = { lens: 'client', files: [CLIENT_FILE], liveTracks: [] };
    render(<RequestFilesPanel requestId={REQUEST_ID} initialView={view} />);

    await user.click(screen.getByRole('button', { name: 'Remove Requirements.pdf' }));
    await user.click(await screen.findByRole('button', { name: 'Keep file' }));

    expect(mockDelete).not.toHaveBeenCalled();
    expect(screen.getByText('Requirements.pdf')).toBeInTheDocument();
  });

  /** ⚠ THE GRANTS TOAST NAMES THE RECIPIENTS (design ref), not "the selected experts". */
  it('client lens: a grants-mode share toast names who received the file', async () => {
    const user = userEvent.setup();
    const view: RequestFilesView = {
      lens: 'client',
      files: [],
      liveTracks: [
        { relationshipId: REL_ID, trackName: 'Wei Zhang' },
        { relationshipId: OTHER_REL_ID, trackName: 'Priya Raman' },
      ],
    };
    mockPresignUpload.mockResolvedValue({
      success: true,
      presignedUrl: 'https://signed',
      key: 'request-files/x/y/z',
    });
    mockConfirmUpload.mockResolvedValue({ success: true, view: CLIENT_FILE });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

    render(<RequestFilesPanel requestId={REQUEST_ID} initialView={view} />);
    await user.click(screen.getByRole('button', { name: /Share a file/ }));

    await user.upload(
      screen.getByLabelText('File'),
      new File(['x'], 'nda.pdf', { type: 'application/pdf' })
    );
    await user.click(screen.getByRole('button', { name: /Only specific experts/ }));
    await user.click(screen.getByRole('checkbox', { name: 'Wei Zhang' }));
    await user.click(screen.getByRole('button', { name: /^Share/ }));

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Shared with Wei Zhang.'));
  });

  /**
   * ⚠ THE CONCEALMENT RESTATEMENT, RE-ANCHORED. This used to fixture only an OWN upload and
   * assert that no `/only$/` badge rendered — which passed for the wrong reason: the badge
   * condition was inverted, so the own-upload arm was the one that rendered NOTHING. It is
   * fixtured on a CLIENT file here, the arm that must stay bare, and the own-upload badge gets
   * its own positive case below.
   */
  it('expert lens: renders NO audience badge on a CLIENT file — the DOM-level concealment restatement', () => {
    const view: RequestFilesView = {
      lens: 'expert',
      files: [CLIENT_FILE_AS_EXPERT_SEES_IT],
      clientPartyName: CLIENT_PARTY,
      closedReason: null,
    };
    render(<RequestFilesPanel requestId={REQUEST_ID} initialView={view} />);
    expect(screen.queryByText(/Everyone invited/)).not.toBeInTheDocument();
    expect(screen.queryByText(/only$/)).not.toBeInTheDocument();
    expect(screen.queryByText('Visible now to:')).not.toBeInTheDocument();
  });

  /**
   * ⚠ THE REASSURANCE THE FEATURE OWES THE EXPERT (ADR-1048 §1) — and it must name the CLIENT
   * PARTY, never `uploadedByName`, which for an own upload is literally "You". Fails if the
   * badge condition is flipped back to `source === 'client'`.
   */
  it('expert lens: an OWN upload carries "Visible to {client} only", naming the client party', () => {
    const view: RequestFilesView = {
      lens: 'expert',
      files: [EXPERT_FILE],
      clientPartyName: CLIENT_PARTY,
      closedReason: null,
    };
    render(<RequestFilesPanel requestId={REQUEST_ID} initialView={view} />);
    expect(screen.getByText(`Visible to ${CLIENT_PARTY} only`)).toBeInTheDocument();
    expect(screen.queryByText('Visible to You only')).not.toBeInTheDocument();
  });

  it('expert lens: shows an invitation-framed empty state and the upload affordance', () => {
    const view: RequestFilesView = {
      lens: 'expert',
      files: [],
      clientPartyName: CLIENT_PARTY,
      closedReason: null,
    };
    render(<RequestFilesPanel requestId={REQUEST_ID} initialView={view} />);
    expect(screen.getByText('Share a file with the client')).toBeInTheDocument();
    expect(screen.getByText('Upload to this conversation')).toBeInTheDocument();
  });

  it('expert lens: a live track shows NO closure banner at all', () => {
    const view: RequestFilesView = {
      lens: 'expert',
      files: [],
      clientPartyName: CLIENT_PARTY,
      closedReason: null,
    };
    const { container } = render(<RequestFilesPanel requestId={REQUEST_ID} initialView={view} />);
    expect(screen.queryByText(/stay available/)).not.toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).not.toBeDisabled();
  });

  it('expert lens: a declined track shows the DECLINED banner and disables upload', () => {
    const view: RequestFilesView = {
      lens: 'expert',
      files: [],
      clientPartyName: CLIENT_PARTY,
      closedReason: 'declined',
    };
    const { container } = render(<RequestFilesPanel requestId={REQUEST_ID} initialView={view} />);
    expect(screen.getByText(/You declined this invitation/)).toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).toBeDisabled();
  });

  /**
   * ⚠ THE ONLY CASE THAT ACTUALLY REACHES THIS BANNER IN PRODUCTION (OSD-3: a genuinely
   * DECLINED expert cannot load the page at all), and it used to be told they had declined.
   * The two assertions are a pair — the second is what makes this fail if the reason is ever
   * collapsed back to a boolean.
   */
  it('expert lens: a NOT-SELECTED track is never told they declined', () => {
    const view: RequestFilesView = {
      lens: 'expert',
      files: [],
      clientPartyName: CLIENT_PARTY,
      closedReason: 'not_selected',
    };
    const { container } = render(<RequestFilesPanel requestId={REQUEST_ID} initialView={view} />);
    expect(screen.getByText(/went to another expert/)).toBeInTheDocument();
    expect(screen.queryByText(/You declined/)).not.toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).toBeDisabled();
  });

  it('expert lens: both file pickers restrict the selectable types', () => {
    const view: RequestFilesView = {
      lens: 'expert',
      files: [],
      clientPartyName: CLIENT_PARTY,
      closedReason: null,
    };
    const { container } = render(<RequestFilesPanel requestId={REQUEST_ID} initialView={view} />);
    expect(container.querySelector('input[type="file"]')).toHaveAttribute('accept');
  });

  it('admin lens: renders the read-only list with visibleTo chips and no mutation controls', () => {
    const view: RequestFilesView = { lens: 'admin', files: [ADMIN_FILE] };
    render(<RequestFilesPanel requestId={REQUEST_ID} initialView={view} />);
    expect(screen.getByText('All files on this request')).toBeInTheDocument();
    expect(screen.getByText('Wei Zhang')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
  });

  it('admin lens: empty state is factual, kept rather than hidden', () => {
    const view: RequestFilesView = { lens: 'admin', files: [] };
    render(<RequestFilesPanel requestId={REQUEST_ID} initialView={view} />);
    expect(screen.getByText('No files have been shared on this request yet.')).toBeInTheDocument();
  });

  it('client lens: download mints a URL and opens it', async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(globalThis, 'open').mockImplementation(() => null);
    mockDownload.mockResolvedValue({ success: true, url: 'https://signed' });
    const view: RequestFilesView = { lens: 'client', files: [CLIENT_FILE], liveTracks: [] };
    render(<RequestFilesPanel requestId={REQUEST_ID} initialView={view} />);

    await user.click(screen.getByRole('button', { name: 'Download Requirements.pdf' }));

    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith('https://signed', '_blank', 'noopener,noreferrer')
    );
    openSpy.mockRestore();
  });

  it('is axe-clean in the client lens', async () => {
    const view: RequestFilesView = { lens: 'client', files: [CLIENT_FILE], liveTracks: [] };
    const { container } = render(<RequestFilesPanel requestId={REQUEST_ID} initialView={view} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
