import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const mockList = vi.fn();
// ⚠⚠ RELATIVE — matching the component's own relative import exactly, so the mock resolves to
// the SAME module specifier `guest-recap-files.tsx` uses.
vi.mock('../../../_actions/list-guest-meeting-files', () => ({
  listGuestMeetingFilesAction: (...a: unknown[]) => mockList(...a),
}));

const mockDownload = vi.fn();
vi.mock('../../../_actions/get-guest-meeting-file-download', () => ({
  getGuestMeetingFileDownloadAction: (...a: unknown[]) => mockDownload(...a),
}));

import { toast } from 'sonner';
import { GuestRecapFiles } from './guest-recap-files';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const GUEST_TOKEN = 'k7Qm2ZtXpA9wLd3Vc1Rb8YvNhKsE0uJt';

const FILE = {
  id: 'file-1',
  meetingId: MEETING_ID,
  fileName: 'deck.pdf',
  contentType: 'application/pdf',
  sizeBytes: 1024,
  party: 'client',
  source: 'files_tab',
  uploadedByUserId: 'u-1',
  createdAtIso: '2026-08-01T10:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GuestRecapFiles', () => {
  it('shows the skeleton on mount, before the list resolves', async () => {
    let resolveList: (value: unknown) => void = () => undefined;
    mockList.mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve;
      })
    );

    render(<GuestRecapFiles meetingId={MEETING_ID} guestToken={GUEST_TOKEN} />);
    expect(screen.getByTestId('panel-skeleton')).toBeInTheDocument();

    resolveList({ success: true, files: [] });
    await waitFor(() => expect(screen.queryByTestId('panel-skeleton')).not.toBeInTheDocument());
  });

  it('renders an error card with a WORKING Retry on `{success:false}`', async () => {
    mockList.mockResolvedValueOnce({ success: false, error: 'Nope' });
    mockList.mockResolvedValueOnce({ success: true, files: [] });
    const user = userEvent.setup();

    render(<GuestRecapFiles meetingId={MEETING_ID} guestToken={GUEST_TOKEN} />);
    await waitFor(() => expect(screen.getByTestId('panel-error')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() =>
      expect(screen.getByText('Nothing was shared on this call.')).toBeInTheDocument()
    );
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it('renders the honest, ABSENCE-FRAMED empty line on `[]` — R9`s documented exception', async () => {
    mockList.mockResolvedValue({ success: true, files: [] });

    render(<GuestRecapFiles meetingId={MEETING_ID} guestToken={GUEST_TOKEN} />);

    await waitFor(() =>
      expect(screen.getByText('Nothing was shared on this call.')).toBeInTheDocument()
    );
  });

  it('renders rows on data', async () => {
    mockList.mockResolvedValue({ success: true, files: [FILE] });

    render(<GuestRecapFiles meetingId={MEETING_ID} guestToken={GUEST_TOKEN} />);

    await waitFor(() => expect(screen.getByText('deck.pdf')).toBeInTheDocument());
  });

  it('downloads through the GUEST action, called with `{ meetingId, guestToken, fileId }`', async () => {
    mockList.mockResolvedValue({ success: true, files: [FILE] });
    mockDownload.mockResolvedValue({ success: true, url: 'https://r2.example/deck.pdf' });
    const user = userEvent.setup();

    render(<GuestRecapFiles meetingId={MEETING_ID} guestToken={GUEST_TOKEN} />);
    await waitFor(() => expect(screen.getByText('deck.pdf')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /download deck\.pdf/i }));

    expect(mockDownload).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      guestToken: GUEST_TOKEN,
      fileId: 'file-1',
    });
  });

  it('⚠ F8/WARNING-1 — a REJECTED list() promise does NOT leave a permanent skeleton', async () => {
    mockList.mockRejectedValue(new Error('network down'));

    render(<GuestRecapFiles meetingId={MEETING_ID} guestToken={GUEST_TOKEN} />);

    await waitFor(() => expect(screen.getByTestId('panel-error')).toBeInTheDocument());
    expect(screen.queryByTestId('panel-skeleton')).not.toBeInTheDocument();
  });

  it('a failed download toasts the error — no `onAnnounce` prop, Sonner owns its own live region', async () => {
    mockList.mockResolvedValue({ success: true, files: [FILE] });
    mockDownload.mockResolvedValue({ success: false, error: 'Link expired' });
    const user = userEvent.setup();

    render(<GuestRecapFiles meetingId={MEETING_ID} guestToken={GUEST_TOKEN} />);
    await waitFor(() => expect(screen.getByText('deck.pdf')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /download deck\.pdf/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Link expired'));
  });

  /**
   * ⚠⚠ fix-round-1 / MUST-1 — a REJECTED `getGuestMeetingFileDownloadAction()` promise (a
   * transport-level failure, distinct from its handled `{ success: false }` resolution) used
   * to have no `.catch()` anywhere on this path: `.finally` still cleared the spinner, so the
   * row silently reverted with NO feedback at all, alongside an unhandled promise rejection.
   */
  it('⚠⚠ MUST-1 — a REJECTED download promise toasts and clears the pending state', async () => {
    mockList.mockResolvedValue({ success: true, files: [FILE] });
    mockDownload.mockRejectedValue(new Error('network down'));
    const user = userEvent.setup();

    render(<GuestRecapFiles meetingId={MEETING_ID} guestToken={GUEST_TOKEN} />);
    await waitFor(() => expect(screen.getByText('deck.pdf')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /download deck\.pdf/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "We couldn't start that download. Try again in a moment."
      )
    );
    // ⚠ THE PENDING STATE IS STILL CLEARED — `.finally` still runs after the `.catch()`. The
    // row's spinner (rendered in place of the download button while pending) clears, and the
    // download button comes back rather than the row being left permanently mid-download.
    await waitFor(() => expect(screen.queryByTestId('file-row-spinner')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /download deck\.pdf/i })).toBeInTheDocument();
  });

  it('⚠⚠ NO UPLOAD AFFORDANCE OF ANY KIND — no footer, no drop target, no disabled button', async () => {
    mockList.mockResolvedValue({ success: true, files: [FILE] });

    render(<GuestRecapFiles meetingId={MEETING_ID} guestToken={GUEST_TOKEN} />);
    await waitFor(() => expect(screen.getByText('deck.pdf')).toBeInTheDocument());

    expect(screen.queryByLabelText(/upload|share a file/i)).not.toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: /upload/i })).toHaveLength(0);
  });
});
