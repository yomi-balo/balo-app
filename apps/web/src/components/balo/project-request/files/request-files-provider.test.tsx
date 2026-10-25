import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { track, REQUEST_FILE_EVENTS } from '@/lib/analytics';
import type { RequestFilesView } from '@/lib/request-files/load-request-files';
import type {
  ClientRequestFileView,
  ExpertRequestFileView,
} from '@/lib/request-files/request-file-audience-view';
import {
  RequestFilesProvider,
  deriveThreadShare,
  useRegisterThreadMessageSink,
  useRequestFiles,
  type ThreadMessageSink,
} from './request-files-provider';
import type { ShareCompleted } from './use-request-file-share';

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  revoke: vi.fn(),
  remove: vi.fn(),
  capture: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/get-request-file-download', () => ({
  getRequestFileDownloadAction: mocks.download,
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/revoke-request-file-grant', () => ({
  revokeRequestFileGrantAction: mocks.revoke,
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/delete-request-file', () => ({
  deleteRequestFileAction: mocks.remove,
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/request-shared-file-upload', () => ({
  requestSharedFileUploadAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/confirm-request-file-upload', () => ({
  confirmRequestFileUploadAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/discard-request-file-upload', () => ({
  discardRequestFileUploadAction: vi.fn(() => Promise.resolve({ success: true })),
}));
vi.mock('@/components/balo/document-uploader/upload-file', () => ({
  putWithProgress: vi.fn(),
  formatBytes: (n: number) => `${n} B`,
}));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.capture }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_A = 'b0000000-0000-4000-8000-000000000002';
const REL_B = 'b0000000-0000-4000-8000-000000000003';

function clientFile(overrides: Partial<ClientRequestFileView> = {}): ClientRequestFileView {
  return {
    id: 'f1',
    fileName: 'Requirements.pdf',
    contentType: 'application/pdf',
    sizeBytes: 2048,
    source: 'client',
    uploadedByName: 'Sarah Chen @ Acme',
    createdAtIso: '2026-08-01T00:00:00.000Z',
    audience: {
      type: 'grants',
      grants: [
        { relationshipId: REL_A, trackName: 'Wei Zhang' },
        { relationshipId: REL_B, trackName: 'Priya Raman' },
      ],
    },
    visibleToLiveTrackIds: [REL_A, REL_B],
    canDelete: true,
    ...overrides,
  };
}

const LIVE_TRACKS = [
  { relationshipId: REL_A, trackName: 'Wei Zhang' },
  { relationshipId: REL_B, trackName: 'Priya Raman' },
];

function clientView(
  overrides: Partial<Extract<RequestFilesView, { lens: 'client' }>> = {}
): RequestFilesView {
  return {
    lens: 'client',
    files: [clientFile()],
    liveTracks: LIVE_TRACKS,
    requestKind: 'matched',
    ...overrides,
  };
}

const EXPERT_FILE: ExpertRequestFileView = {
  id: 'e1',
  fileName: 'Approach.pdf',
  contentType: 'application/pdf',
  sizeBytes: 100,
  source: 'you',
  uploadedByName: 'You',
  createdAtIso: '2026-08-02T00:00:00.000Z',
  sharedBeforeYouJoined: false,
  canDelete: true,
};

function expertView(closedReason: 'declined' | 'not_selected' | null = null): RequestFilesView {
  return {
    lens: 'expert',
    files: [EXPERT_FILE],
    requestKind: 'matched',
    clientPartyName: 'Acme Corp',
    closedReason,
  };
}

function Probe({ sink }: Readonly<{ sink?: ThreadMessageSink }>): React.JSX.Element {
  const files = useRequestFiles();
  useRegisterThreadMessageSink(sink ?? null);
  if (files === null) return <p>no file lens</p>;
  return (
    <div>
      <ul aria-label="files">
        {files.view.files.map((f) => (
          <li key={f.id}>{f.fileName}</li>
        ))}
      </ul>
      <output data-testid="busy">
        {files.downloadingId ?? files.deletingId ?? files.revokingRelationshipId ?? 'idle'}
      </output>
      <button type="button" onClick={() => files.download('f1')}>
        download
      </button>
      <button type="button" onClick={() => files.requestRemove('f1')}>
        remove
      </button>
      <button type="button" onClick={() => files.revoke('f1', REL_A, 'Wei Zhang')}>
        revoke
      </button>
      <button type="button" onClick={files.openAllFiles}>
        open all
      </button>
      <button
        type="button"
        onClick={() =>
          files.completeShare({
            success: true,
            view: clientFile({ id: 'f2', fileName: 'New.pdf' }),
            threadMessages: [{ relationshipId: REL_A, message: { id: 'm1' } as never }],
          } as ShareCompleted)
        }
      >
        complete client share
      </button>
      <button
        type="button"
        onClick={() =>
          files.completeShare({
            success: true,
            view: EXPERT_FILE,
            threadMessages: [],
          } as unknown as ShareCompleted)
        }
      >
        complete expert share
      </button>
    </div>
  );
}

function setup(view: RequestFilesView | null, sink?: ThreadMessageSink): void {
  render(
    <RequestFilesProvider
      requestId={REQUEST_ID}
      initialView={view}
      brief={<p>Brief document list</p>}
    >
      <Probe sink={sink} />
    </RequestFilesProvider>
  );
}

const assign = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('location', { assign });
  mocks.download.mockResolvedValue({ success: true, url: 'https://r2/get', contentType: 'x' });
  mocks.revoke.mockResolvedValue({ success: true });
  mocks.remove.mockResolvedValue({ success: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('deriveThreadShare', () => {
  it('lets a client share into a live track’s thread, with the options on a matched request', () => {
    expect(deriveThreadShare(clientView(), REL_A)).toEqual({
      allowed: true,
      options: 'thread',
      recipients: { side: 'client', liveTracks: LIVE_TRACKS },
    });
  });

  it('offers no options on a direct request', () => {
    expect(deriveThreadShare(clientView({ requestKind: 'direct' }), REL_A)).toMatchObject({
      allowed: true,
      options: 'none',
    });
  });

  it('refuses a thread whose track is not live', () => {
    expect(deriveThreadShare(clientView(), 'closed-track').allowed).toBe(false);
  });

  it('lets an expert share while their track is open, with no options and the client party as recipient', () => {
    expect(deriveThreadShare(expertView(), REL_A)).toEqual({
      allowed: true,
      options: 'none',
      recipients: { side: 'expert', clientPartyName: 'Acme Corp' },
    });
  });

  it('refuses an expert whose track has closed', () => {
    expect(deriveThreadShare(expertView('not_selected'), REL_A).allowed).toBe(false);
  });

  it('never lets the read-only admin lens share', () => {
    expect(deriveThreadShare({ lens: 'admin', files: [] }, REL_A).allowed).toBe(false);
  });
});

describe('RequestFilesProvider', () => {
  it('adds nothing when the viewer has no file lens', () => {
    setup(null);
    expect(screen.getByText('no file lens')).toBeInTheDocument();
  });

  it('provides the loaded files to its children', () => {
    setup(clientView());
    expect(screen.getByRole('list', { name: 'files' })).toHaveTextContent('Requirements.pdf');
  });

  describe('download', () => {
    it('downloads in place through the download action', async () => {
      const user = userEvent.setup();
      setup(clientView());
      await user.click(screen.getByRole('button', { name: 'download' }));
      await waitFor(() => expect(assign).toHaveBeenCalledWith('https://r2/get'));
      expect(mocks.download).toHaveBeenCalledWith({ requestId: REQUEST_ID, fileId: 'f1' });
      await waitFor(() => expect(screen.getByTestId('busy')).toHaveTextContent('idle'));
    });

    it('toasts the server’s reason when the download is refused', async () => {
      mocks.download.mockResolvedValueOnce({ success: false, error: 'Not available.' });
      const user = userEvent.setup();
      setup(clientView());
      await user.click(screen.getByRole('button', { name: 'download' }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not available.'));
      expect(assign).not.toHaveBeenCalled();
    });

    it('reports a rejected call to Sentry', async () => {
      mocks.download.mockRejectedValueOnce(new Error('offline'));
      const user = userEvent.setup();
      setup(clientView());
      await user.click(screen.getByRole('button', { name: 'download' }));
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith('Could not download this file. Please try again.')
      );
      expect(mocks.capture).toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('asks first, naming the file, and removes nothing on "Keep file"', async () => {
      const user = userEvent.setup();
      setup(clientView());
      await user.click(screen.getByRole('button', { name: 'remove' }));
      expect(screen.getByText('Remove Requirements.pdf?')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Keep file' }));
      expect(mocks.remove).not.toHaveBeenCalled();
      expect(screen.getByRole('list', { name: 'files' })).toHaveTextContent('Requirements.pdf');
    });

    it('removes the file, drops it from the list and toasts when confirmed', async () => {
      const user = userEvent.setup();
      setup(clientView());
      await user.click(screen.getByRole('button', { name: 'remove' }));
      await user.click(screen.getByRole('button', { name: 'Remove file' }));
      await waitFor(() =>
        expect(screen.getByRole('list', { name: 'files' })).toBeEmptyDOMElement()
      );
      expect(mocks.remove).toHaveBeenCalledWith({ requestId: REQUEST_ID, fileId: 'f1' });
      expect(toast.success).toHaveBeenCalledWith('File removed. No notification is sent.');
    });

    it('keeps the file and toasts when the server refuses', async () => {
      mocks.remove.mockResolvedValueOnce({ success: false, error: 'Not yours to remove.' });
      const user = userEvent.setup();
      setup(clientView());
      await user.click(screen.getByRole('button', { name: 'remove' }));
      await user.click(screen.getByRole('button', { name: 'Remove file' }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not yours to remove.'));
      expect(screen.getByRole('list', { name: 'files' })).toHaveTextContent('Requirements.pdf');
    });

    it('does nothing for the read-only admin lens', async () => {
      const user = userEvent.setup();
      setup({ lens: 'admin', files: [] });
      expect(screen.queryByRole('button', { name: 'remove' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'remove' }));
      expect(screen.queryByText(/^Remove /)).not.toBeInTheDocument();
    });

    it('reports a rejected delete to Sentry', async () => {
      mocks.remove.mockRejectedValueOnce(new Error('offline'));
      const user = userEvent.setup();
      setup(clientView());
      await user.click(screen.getByRole('button', { name: 'remove' }));
      await user.click(screen.getByRole('button', { name: 'Remove file' }));
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith('Could not remove this file. Please try again.')
      );
      expect(mocks.capture).toHaveBeenCalled();
    });
  });

  describe('revoke', () => {
    it('drops that expert from the grants and from who can see the file, and toasts', async () => {
      const user = userEvent.setup();
      let seen: RequestFilesView | null = null;
      function Spy(): null {
        seen = useRequestFiles()?.view ?? null;
        return null;
      }
      render(
        <RequestFilesProvider requestId={REQUEST_ID} initialView={clientView()} brief={null}>
          <Probe />
          <Spy />
        </RequestFilesProvider>
      );
      await user.click(screen.getByRole('button', { name: 'revoke' }));
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith('Access removed. Wei Zhang is not notified.')
      );
      expect(mocks.revoke).toHaveBeenCalledWith({
        requestId: REQUEST_ID,
        fileId: 'f1',
        relationshipId: REL_A,
      });
      const file = (seen as RequestFilesView | null)?.files[0] as ClientRequestFileView;
      expect(file.audience).toEqual({
        type: 'grants',
        grants: [{ relationshipId: REL_B, trackName: 'Priya Raman' }],
      });
      expect(file.visibleToLiveTrackIds).toEqual([REL_B]);
    });

    it('leaves the grants alone and toasts when the server refuses', async () => {
      mocks.revoke.mockResolvedValueOnce({ success: false, error: 'Could not.' });
      const user = userEvent.setup();
      setup(clientView());
      await user.click(screen.getByRole('button', { name: 'revoke' }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not.'));
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('reports a rejected revoke to Sentry', async () => {
      mocks.revoke.mockRejectedValueOnce(new Error('offline'));
      const user = userEvent.setup();
      setup(clientView());
      await user.click(screen.getByRole('button', { name: 'revoke' }));
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith('Could not remove access. Please try again.')
      );
      expect(mocks.capture).toHaveBeenCalled();
    });
  });

  describe('completeShare', () => {
    it('puts a newly shared file first and hands its thread cards to the open conversation', async () => {
      const user = userEvent.setup();
      const sink = vi.fn();
      setup(clientView(), sink);
      await user.click(screen.getByRole('button', { name: 'complete client share' }));
      const items = screen.getAllByRole('listitem').map((li) => li.textContent);
      expect(items).toEqual(['New.pdf', 'Requirements.pdf']);
      expect(sink).toHaveBeenCalledWith([{ relationshipId: REL_A, message: { id: 'm1' } }]);
    });

    it('adds an expert’s own upload to the expert list', async () => {
      const user = userEvent.setup();
      setup(expertView());
      await user.click(screen.getByRole('button', { name: 'complete expert share' }));
      expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
        'Approach.pdf',
        'Approach.pdf',
      ]);
    });

    it('ignores a result whose shape does not match the viewer’s lens', async () => {
      const user = userEvent.setup();
      setup(clientView());
      await user.click(screen.getByRole('button', { name: 'complete expert share' }));
      expect(screen.getAllByRole('listitem')).toHaveLength(1);
    });

    it('stops delivering once the conversation unregisters its handler', async () => {
      const user = userEvent.setup();
      const sink = vi.fn();
      const { rerender } = render(
        <RequestFilesProvider requestId={REQUEST_ID} initialView={clientView()} brief={null}>
          <Probe sink={sink} />
        </RequestFilesProvider>
      );
      rerender(
        <RequestFilesProvider requestId={REQUEST_ID} initialView={clientView()} brief={null}>
          <Probe />
        </RequestFilesProvider>
      );
      await user.click(screen.getByRole('button', { name: 'complete client share' }));
      expect(sink).not.toHaveBeenCalled();
    });
  });

  describe('All files', () => {
    it('opens the sheet with the brief and the files', async () => {
      const user = userEvent.setup();
      setup(clientView());
      await user.click(screen.getByRole('button', { name: 'open all' }));
      expect(await screen.findByText('All files on this request')).toBeInTheDocument();
      expect(screen.getByText('Brief document list')).toBeInTheDocument();
    });

    it('opens the share dialog in All-files mode from "Share with several experts"', async () => {
      const user = userEvent.setup();
      setup(clientView());
      await user.click(screen.getByRole('button', { name: 'open all' }));
      await user.click(await screen.findByRole('button', { name: 'Share with several experts' }));
      expect(await screen.findByRole('heading', { name: 'Share a file' })).toBeInTheDocument();
      expect(screen.getByLabelText('File')).toBeInTheDocument();
      expect(screen.queryByText('All files on this request')).not.toBeInTheDocument();
      expect(track).toHaveBeenCalledWith(REQUEST_FILE_EVENTS.SHARE_DIALOG_OPENED, {
        entry_point: 'all_files',
      });
    });

    it('closes the dialog and records the cancel when Cancel is pressed', async () => {
      const user = userEvent.setup();
      setup(clientView());
      await user.click(screen.getByRole('button', { name: 'open all' }));
      await user.click(await screen.findByRole('button', { name: 'Share with several experts' }));
      await user.click(await screen.findByRole('button', { name: 'Cancel' }));
      await waitFor(() =>
        expect(screen.queryByRole('heading', { name: 'Share a file' })).not.toBeInTheDocument()
      );
      expect(track).toHaveBeenCalledWith(REQUEST_FILE_EVENTS.SHARE_DIALOG_CANCELLED, {
        entry_point: 'all_files',
        upload_complete: false,
      });
    });
  });
});
