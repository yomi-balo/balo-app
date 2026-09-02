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

  /**
   * ⚠ THE BADGE MUST NOT IMPLY THE FILE IS RECOVERABLE. Under Ruling 1 a delete removes the R2
   * OBJECT; what survives is the tombstone row and the `audit_events` entry. "record retained"
   * read as though the file itself were still there — "audit record kept" names what is
   * actually kept. And there is deliberately NO download control on a tombstone: the bytes are
   * gone, so nobody (the admin lens included) can fetch them.
   */
  it('admin lens: a tombstone is badged as an audit record and offers no download', () => {
    const view: RequestFilesView = {
      lens: 'admin',
      files: [
        {
          ...ADMIN_FILE,
          deleted: true,
          deletedAtIso: '2026-08-03T00:00:00.000Z',
          deletedByName: 'Sarah Chen',
          visibleTo: [],
        },
      ],
    };
    render(<RequestFilesPanel requestId={REQUEST_ID} initialView={view} />);

    expect(screen.getByText('Removed · audit record kept')).toBeInTheDocument();
    expect(screen.queryByText('Removed · record retained')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
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

  /**
   * ⚠ EVERY MUTATION'S FAILURE ARM. Each of these paths ends in a `toast.error` and, critically,
   * a NON-mutation of the optimistic island state. The bug they guard is the one optimistic UI
   * always invites: showing the user a success the server refused. Each case asserts BOTH that
   * the server's own copy is surfaced AND that the row/grant survived.
   */
  describe('failure arms leave the island state untouched', () => {
    it('download: surfaces the action’s error and opens nothing', async () => {
      const user = userEvent.setup();
      const openSpy = vi.spyOn(globalThis, 'open').mockImplementation(() => null);
      mockDownload.mockResolvedValue({
        success: false,
        error: 'This file is no longer available.',
      });
      const view: RequestFilesView = { lens: 'client', files: [CLIENT_FILE], liveTracks: [] };
      render(<RequestFilesPanel requestId={REQUEST_ID} initialView={view} />);

      await user.click(screen.getByRole('button', { name: 'Download Requirements.pdf' }));

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith('This file is no longer available.')
      );
      expect(openSpy).not.toHaveBeenCalled();
      openSpy.mockRestore();
    });

    it('delete: a refused delete keeps the row on screen', async () => {
      const user = userEvent.setup();
      mockDelete.mockResolvedValue({ success: false, error: 'This file is no longer available.' });
      const view: RequestFilesView = { lens: 'client', files: [CLIENT_FILE], liveTracks: [] };
      render(<RequestFilesPanel requestId={REQUEST_ID} initialView={view} />);

      await user.click(screen.getByRole('button', { name: 'Remove Requirements.pdf' }));
      await user.click(await screen.findByRole('button', { name: 'Remove file' }));

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith('This file is no longer available.')
      );
      expect(screen.getByText('Requirements.pdf')).toBeInTheDocument();
      expect(mockToastSuccess).not.toHaveBeenCalled();
    });

    it('revoke: a refused revoke keeps the grant badge', async () => {
      const user = userEvent.setup();
      mockRevoke.mockResolvedValue({ success: false, error: 'This file is no longer available.' });
      const view: RequestFilesView = { lens: 'client', files: [CLIENT_FILE], liveTracks: [] };
      render(<RequestFilesPanel requestId={REQUEST_ID} initialView={view} />);

      await user.click(screen.getByRole('button', { name: 'Remove access for Wei Zhang' }));

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith('This file is no longer available.')
      );
      expect(screen.getByText('Wei Zhang only')).toBeInTheDocument();
      expect(mockToastSuccess).not.toHaveBeenCalled();
    });
  });

  describe('client share failures', () => {
    const LIVE_VIEW: RequestFilesView = {
      lens: 'client',
      files: [],
      liveTracks: [
        { relationshipId: REL_ID, trackName: 'Wei Zhang' },
        { relationshipId: OTHER_REL_ID, trackName: 'Priya Raman' },
      ],
    };

    async function openSheetAndSubmit(): Promise<void> {
      const user = userEvent.setup();
      render(<RequestFilesPanel requestId={REQUEST_ID} initialView={LIVE_VIEW} />);
      await user.click(screen.getByRole('button', { name: /Share a file/ }));
      await user.upload(
        screen.getByLabelText('File'),
        new File(['x'], 'nda.pdf', { type: 'application/pdf' })
      );
      await user.click(screen.getByRole('button', { name: /^Share$/ }));
    }

    it('surfaces a presign refusal and never uploads any bytes', async () => {
      mockPresignUpload.mockResolvedValue({
        success: false,
        error: "File sharing isn't available right now.",
      });
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      await openSheetAndSubmit();

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith("File sharing isn't available right now.")
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockConfirmUpload).not.toHaveBeenCalled();
    });

    /**
     * ⚠ A FAILED PUT MUST NOT BE CONFIRMED. Confirming an upload whose bytes never landed would
     * create a share row pointing at a missing R2 object — a file everyone can see and nobody
     * can fetch.
     */
    it('does not confirm a share whose upload PUT failed', async () => {
      mockPresignUpload.mockResolvedValue({
        success: true,
        presignedUrl: 'https://signed',
        key: 'request-files/x/y/z',
      });
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;

      await openSheetAndSubmit();

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith('Could not share your file. Please try again.')
      );
      expect(mockConfirmUpload).not.toHaveBeenCalled();
    });

    it('surfaces a refused confirm and adds no row', async () => {
      mockPresignUpload.mockResolvedValue({
        success: true,
        presignedUrl: 'https://signed',
        key: 'request-files/x/y/z',
      });
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
      mockConfirmUpload.mockResolvedValue({
        success: false,
        error: 'That expert is no longer on this request.',
      });

      await openSheetAndSubmit();

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith('That expert is no longer on this request.')
      );
      expect(screen.queryByText('nda.pdf')).not.toBeInTheDocument();
      expect(mockToastSuccess).not.toHaveBeenCalled();
    });

    /** The everyone-invited toast states the reach, and pluralises on the LIVE track count. */
    it('an all-live-tracks share reports how many experts received it', async () => {
      const user = userEvent.setup();
      mockPresignUpload.mockResolvedValue({
        success: true,
        presignedUrl: 'https://signed',
        key: 'request-files/x/y/z',
      });
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
      mockConfirmUpload.mockResolvedValue({ success: true, view: CLIENT_FILE });

      render(<RequestFilesPanel requestId={REQUEST_ID} initialView={LIVE_VIEW} />);
      await user.click(screen.getByRole('button', { name: /Share a file/ }));
      await user.upload(
        screen.getByLabelText('File'),
        new File(['x'], 'reqs.pdf', { type: 'application/pdf' })
      );
      await user.click(screen.getByRole('button', { name: /^Share$/ }));

      await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Shared with 2 experts.'));
      expect(mockConfirmUpload).toHaveBeenCalledWith(
        expect.objectContaining({ share: { mode: 'all_live_tracks' } })
      );
    });

    it('uses the singular noun when exactly one track is live', async () => {
      const user = userEvent.setup();
      mockPresignUpload.mockResolvedValue({
        success: true,
        presignedUrl: 'https://signed',
        key: 'request-files/x/y/z',
      });
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
      mockConfirmUpload.mockResolvedValue({ success: true, view: CLIENT_FILE });
      const view: RequestFilesView = {
        lens: 'client',
        files: [],
        liveTracks: [{ relationshipId: REL_ID, trackName: 'Wei Zhang' }],
      };

      render(<RequestFilesPanel requestId={REQUEST_ID} initialView={view} />);
      await user.click(screen.getByRole('button', { name: /Share a file/ }));
      await user.upload(
        screen.getByLabelText('File'),
        new File(['x'], 'reqs.pdf', { type: 'application/pdf' })
      );
      await user.click(screen.getByRole('button', { name: /^Share$/ }));

      await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Shared with 1 expert.'));
    });

    /**
     * ⚠ THE GRANTS TOAST LISTS EVERY RECIPIENT, conjoined. `listNames` builds "A and B" / "A, B
     * and C"; naming only the first would misreport who can now read a sensitive document.
     */
    it('names both recipients of a two-track grants share', async () => {
      const user = userEvent.setup();
      mockPresignUpload.mockResolvedValue({
        success: true,
        presignedUrl: 'https://signed',
        key: 'request-files/x/y/z',
      });
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
      mockConfirmUpload.mockResolvedValue({ success: true, view: CLIENT_FILE });

      render(<RequestFilesPanel requestId={REQUEST_ID} initialView={LIVE_VIEW} />);
      await user.click(screen.getByRole('button', { name: /Share a file/ }));
      await user.upload(
        screen.getByLabelText('File'),
        new File(['x'], 'nda.pdf', { type: 'application/pdf' })
      );
      await user.click(screen.getByRole('button', { name: /Only specific experts/ }));
      await user.click(screen.getByRole('checkbox', { name: 'Wei Zhang' }));
      await user.click(screen.getByRole('checkbox', { name: 'Priya Raman' }));
      await user.click(screen.getByRole('button', { name: /^Share$/ }));

      await waitFor(() =>
        expect(mockToastSuccess).toHaveBeenCalledWith('Shared with Wei Zhang and Priya Raman.')
      );
    });
  });

  /**
   * ⚠ THE EXPERT UPLOAD PATH. It is a DIFFERENT function from the client share — no audience is
   * chosen and the server ignores the `share` field on this arm — so it needs its own coverage.
   * The toast is the expert's only confirmation of where the file went.
   */
  describe('expert upload', () => {
    const EXPERT_VIEW: RequestFilesView = {
      lens: 'expert',
      files: [],
      clientPartyName: CLIENT_PARTY,
      closedReason: null,
    };

    function expertFileInput(container: HTMLElement): HTMLInputElement {
      const input = container.querySelector('input[type="file"]');
      if (!(input instanceof HTMLInputElement)) throw new Error('no expert file input');
      return input;
    }

    it('uploads, prepends the new row and confirms it went to the client only', async () => {
      const user = userEvent.setup();
      mockPresignUpload.mockResolvedValue({
        success: true,
        presignedUrl: 'https://signed',
        key: 'request-files/x/y/z',
      });
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
      mockConfirmUpload.mockResolvedValue({ success: true, view: EXPERT_FILE });

      const { container } = render(
        <RequestFilesPanel requestId={REQUEST_ID} initialView={EXPERT_VIEW} />
      );
      await user.upload(
        expertFileInput(container),
        new File(['x'], 'Proposal-draft.pdf', { type: 'application/pdf' })
      );

      await waitFor(() =>
        expect(mockToastSuccess).toHaveBeenCalledWith('Uploaded. Visible to the client only.')
      );
      expect(await screen.findByText('Proposal-draft.pdf')).toBeInTheDocument();
      // The expert arm never offers an audience — the server ignores it, and the UI must not
      // imply one was chosen.
      expect(screen.queryByText(/Everyone invited/)).not.toBeInTheDocument();
    });

    it('surfaces a presign refusal and uploads nothing', async () => {
      const user = userEvent.setup();
      mockPresignUpload.mockResolvedValue({
        success: false,
        error: "File sharing isn't available right now.",
      });
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      const { container } = render(
        <RequestFilesPanel requestId={REQUEST_ID} initialView={EXPERT_VIEW} />
      );
      await user.upload(
        expertFileInput(container),
        new File(['x'], 'x.pdf', { type: 'application/pdf' })
      );

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith("File sharing isn't available right now.")
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockConfirmUpload).not.toHaveBeenCalled();
    });

    it('does not confirm an expert upload whose PUT failed', async () => {
      const user = userEvent.setup();
      mockPresignUpload.mockResolvedValue({
        success: true,
        presignedUrl: 'https://signed',
        key: 'request-files/x/y/z',
      });
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;

      const { container } = render(
        <RequestFilesPanel requestId={REQUEST_ID} initialView={EXPERT_VIEW} />
      );
      await user.upload(
        expertFileInput(container),
        new File(['x'], 'x.pdf', { type: 'application/pdf' })
      );

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith('Could not share your file. Please try again.')
      );
      expect(mockConfirmUpload).not.toHaveBeenCalled();
    });

    it('surfaces a refused confirm and adds no row', async () => {
      const user = userEvent.setup();
      mockPresignUpload.mockResolvedValue({
        success: true,
        presignedUrl: 'https://signed',
        key: 'request-files/x/y/z',
      });
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
      mockConfirmUpload.mockResolvedValue({
        success: false,
        error: 'This file type is not supported.',
      });

      const { container } = render(
        <RequestFilesPanel requestId={REQUEST_ID} initialView={EXPERT_VIEW} />
      );
      await user.upload(
        expertFileInput(container),
        new File(['x'], 'x.pdf', { type: 'application/pdf' })
      );

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith('This file type is not supported.')
      );
      expect(screen.queryByText('x.pdf')).not.toBeInTheDocument();
    });

    /**
     * ⚠ THE LOAD-BEARING `.catch()`. `handleExpertUpload` is try/finally with NO catch, so a
     * rejected action (a network failure, not a `{success:false}`) would otherwise reject
     * unhandled and the control would silently re-enable with no feedback at all.
     */
    it('reports a thrown upload rather than failing silently', async () => {
      const user = userEvent.setup();
      mockPresignUpload.mockRejectedValue(new Error('network down'));

      const { container } = render(
        <RequestFilesPanel requestId={REQUEST_ID} initialView={EXPERT_VIEW} />
      );
      await user.upload(
        expertFileInput(container),
        new File(['x'], 'x.pdf', { type: 'application/pdf' })
      );

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith('Could not share your file. Please try again.')
      );
    });

    /**
     * ⚠ THE PICKER IS CLEARED AFTER EVERY ATTEMPT. Without `e.target.value = ''` re-selecting
     * the SAME file fires no `change` event, so a retry after a failure would appear to do
     * nothing at all.
     */
    /**
     * ⚠ THE EXPERT DELETES THROUGH THE SAME CONFIRMATION AS THE CLIENT. Ruling 1 makes delete
     * destroy the R2 object and Ruling 3 makes the right party-level, so the expert's trash
     * icon must not be the point of no return either — one dialog, mounted by BOTH mutating
     * lenses.
     */
    it('confirms before removing an expert’s own upload, then drops the row', async () => {
      const user = userEvent.setup();
      mockDelete.mockResolvedValue({ success: true });
      const view: RequestFilesView = {
        lens: 'expert',
        files: [EXPERT_FILE],
        clientPartyName: CLIENT_PARTY,
        closedReason: null,
      };
      render(<RequestFilesPanel requestId={REQUEST_ID} initialView={view} />);

      await user.click(screen.getByRole('button', { name: 'Remove Proposal-draft.pdf' }));
      expect(mockDelete).not.toHaveBeenCalled();
      expect(await screen.findByText('Remove Proposal-draft.pdf?')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Remove file' }));

      await waitFor(() => expect(screen.queryByText('Proposal-draft.pdf')).not.toBeInTheDocument());
      expect(mockDelete).toHaveBeenCalledWith({ requestId: REQUEST_ID, fileId: FILE_ID });
      expect(mockToastSuccess).toHaveBeenCalledWith('File removed. No notification is sent.');
    });

    it('keeps the expert’s file when the confirmation is dismissed', async () => {
      const user = userEvent.setup();
      const view: RequestFilesView = {
        lens: 'expert',
        files: [EXPERT_FILE],
        clientPartyName: CLIENT_PARTY,
        closedReason: null,
      };
      render(<RequestFilesPanel requestId={REQUEST_ID} initialView={view} />);

      await user.click(screen.getByRole('button', { name: 'Remove Proposal-draft.pdf' }));
      await user.click(await screen.findByRole('button', { name: 'Keep file' }));

      expect(mockDelete).not.toHaveBeenCalled();
      expect(screen.getByText('Proposal-draft.pdf')).toBeInTheDocument();
    });

    /**
     * ⚠ A THROWN `fetch` IS NOT A SUCCESSFUL UPLOAD. The PUT goes straight to R2, so a DNS
     * failure, a CORS rejection or an offline browser REJECTS rather than resolving `ok:false`.
     * Without the try/catch around it that rejection would propagate and the confirm step would
     * never run — leaving the expert with a spinner and no error.
     */
    it('treats a thrown PUT as a failed upload, not a silent success', async () => {
      const user = userEvent.setup();
      mockPresignUpload.mockResolvedValue({
        success: true,
        presignedUrl: 'https://signed',
        key: 'request-files/x/y/z',
      });
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;

      const { container } = render(
        <RequestFilesPanel requestId={REQUEST_ID} initialView={EXPERT_VIEW} />
      );
      await user.upload(
        expertFileInput(container),
        new File(['x'], 'x.pdf', { type: 'application/pdf' })
      );

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith('Could not share your file. Please try again.')
      );
      expect(mockConfirmUpload).not.toHaveBeenCalled();
    });

    it('clears the picker so the same file can be retried', async () => {
      const user = userEvent.setup();
      mockPresignUpload.mockResolvedValue({
        success: true,
        presignedUrl: 'https://signed',
        key: 'request-files/x/y/z',
      });
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
      mockConfirmUpload.mockResolvedValue({ success: true, view: EXPERT_FILE });

      const { container } = render(
        <RequestFilesPanel requestId={REQUEST_ID} initialView={EXPERT_VIEW} />
      );
      const input = expertFileInput(container);
      await user.upload(input, new File(['x'], 'again.pdf', { type: 'application/pdf' }));

      await waitFor(() => expect(mockConfirmUpload).toHaveBeenCalled());
      expect(input.value).toBe('');
    });
  });
});
