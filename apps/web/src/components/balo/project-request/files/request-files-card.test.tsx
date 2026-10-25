import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RequestFilesView } from '@/lib/request-files/load-request-files';
import type {
  ClientRequestFileView,
  ExpertRequestFileView,
} from '@/lib/request-files/request-file-audience-view';
import { MobileRequestSheet } from '../conversation/mobile-request-sheet';
import { RequestFilesCard } from './request-files-card';
import { RequestFilesProvider } from './request-files-provider';

const mocks = vi.hoisted(() => ({ download: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/get-request-file-download', () => ({
  getRequestFileDownloadAction: mocks.download,
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/revoke-request-file-grant', () => ({
  revokeRequestFileGrantAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/delete-request-file', () => ({
  deleteRequestFileAction: vi.fn(),
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
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const WEI = 'b0000000-0000-4000-8000-000000000002';

function clientFile(id: string, name: string): ClientRequestFileView {
  return {
    id,
    fileName: name,
    contentType: 'application/pdf',
    sizeBytes: 1024,
    source: 'client',
    uploadedByName: 'Sarah Chen @ Acme',
    createdAtIso: '2026-08-01T00:00:00.000Z',
    audience: { type: 'grants', grants: [{ relationshipId: WEI, trackName: 'Wei Zhang' }] },
    visibleToLiveTrackIds: [WEI],
    canDelete: true,
  };
}

const CLIENT_VIEW: RequestFilesView = {
  lens: 'client',
  files: [
    clientFile('f3', 'Third.pdf'),
    clientFile('f2', 'Second.pdf'),
    clientFile('f1', 'First.pdf'),
  ],
  liveTracks: [{ relationshipId: WEI, trackName: 'Wei Zhang' }],
  requestKind: 'matched',
};

const EXPERT_FILE: ExpertRequestFileView = {
  id: 'e1',
  fileName: 'Client-brief.pdf',
  contentType: 'application/pdf',
  sizeBytes: 10,
  source: 'client',
  uploadedByName: 'Acme Corp',
  createdAtIso: '2026-08-02T00:00:00.000Z',
  sharedBeforeYouJoined: true,
  canDelete: false,
};

function expertView(files: ExpertRequestFileView[]): RequestFilesView {
  return {
    lens: 'expert',
    files,
    requestKind: 'matched',
    clientPartyName: 'Acme',
    closedReason: null,
  };
}

function renderCard(view: RequestFilesView | null, variant: 'compact' | 'full' = 'compact'): void {
  render(
    <RequestFilesProvider requestId={REQUEST_ID} initialView={view} brief={<p>Sheet brief</p>}>
      <RequestFilesCard
        variant={variant}
        heading={<h3>Files</h3>}
        documents={<p>Brief.pdf</p>}
        documentCount={1}
        fallback={<p>Request documents (fallback)</p>}
      />
    </RequestFilesProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.download.mockResolvedValue({ success: true, url: 'https://r2/get', contentType: 'x' });
});

describe('RequestFilesCard', () => {
  it('renders today’s documents block unchanged when the viewer has no file lens', () => {
    renderCard(null);
    expect(screen.getByText('Request documents (fallback)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /All files/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Files' })).not.toBeInTheDocument();
  });

  /** AC7: brief + the two newest + "All files · n". */
  it('shows the brief, the two newest files and the combined count', () => {
    renderCard(CLIENT_VIEW);
    expect(screen.getByRole('heading', { name: 'Files' })).toBeInTheDocument();
    expect(screen.getByText('Brief.pdf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Third.pdf' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Second.pdf' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open First.pdf' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All files · 4' })).toBeInTheDocument();
    expect(screen.queryByText('Request documents (fallback)')).not.toBeInTheDocument();
  });

  it('shows the client the current audience on each recent file', () => {
    renderCard(CLIENT_VIEW);
    expect(screen.getAllByText('Wei Zhang only')).toHaveLength(2);
  });

  it('shows the expert no audience at all', () => {
    renderCard(expertView([EXPERT_FILE]));
    expect(screen.getByRole('button', { name: 'Open Client-brief.pdf' })).toBeInTheDocument();
    expect(screen.queryByText(/only$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/All interested experts/)).not.toBeInTheDocument();
  });

  it('closes the mobile request sheet before opening All files, so sheets never stack', async () => {
    const user = userEvent.setup();
    render(
      <RequestFilesProvider
        requestId={REQUEST_ID}
        initialView={CLIENT_VIEW}
        brief={<p>Sheet brief</p>}
      >
        <MobileRequestSheet title="CPQ implementation">
          <RequestFilesCard
            variant="compact"
            heading={<h3>Files</h3>}
            documents={<p>Brief.pdf</p>}
            documentCount={1}
            fallback={<p>fallback</p>}
          />
        </MobileRequestSheet>
      </RequestFilesProvider>
    );
    await user.click(
      screen.getByRole('button', { name: 'Request, kickoff and files: CPQ implementation' })
    );
    await user.click(await screen.findByRole('button', { name: 'All files · 4' }));
    expect(await screen.findByText('All files on this request')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText('Request, kickoff and files')).not.toBeInTheDocument()
    );
  });

  it('opens the All files sheet', async () => {
    const user = userEvent.setup();
    renderCard(CLIENT_VIEW);
    await user.click(screen.getByRole('button', { name: 'All files · 4' }));
    expect(await screen.findByText('All files on this request')).toBeInTheDocument();
  });

  it('previews a recent file from its name', async () => {
    const user = userEvent.setup();
    renderCard(CLIENT_VIEW);
    await user.click(screen.getByRole('button', { name: 'Open Third.pdf' }));
    expect(mocks.download).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      fileId: 'f3',
      purpose: 'preview',
    });
  });

  describe('empty states invite a share', () => {
    it('invites the client to share from the conversation or from All files', () => {
      renderCard({ ...CLIENT_VIEW, files: [] } as RequestFilesView);
      expect(
        screen.getByText(
          'Share a file from the conversation — or with several experts from All files.'
        )
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'All files · 1' })).toBeInTheDocument();
    });

    it('invites a client on a direct request to share from the conversation only', () => {
      renderCard({ ...CLIENT_VIEW, files: [], requestKind: 'direct' } as RequestFilesView);
      expect(screen.getByText('Share a file from the conversation.')).toBeInTheDocument();
      expect(screen.queryByText(/several experts/)).not.toBeInTheDocument();
    });

    it('invites a client with no live expert without pointing at a conversation', () => {
      renderCard({ ...CLIENT_VIEW, files: [], liveTracks: [] } as RequestFilesView);
      expect(
        screen.getByText('Files you share with experts will appear here.')
      ).toBeInTheDocument();
    });

    it('tells the expert a share goes to the client only', () => {
      renderCard(expertView([]));
      expect(
        screen.getByText('Share a file from the conversation. It goes to the client only.')
      ).toBeInTheDocument();
    });

    it('states plainly for the read-only admin that nothing has been shared', () => {
      renderCard({ lens: 'admin', files: [] });
      expect(
        screen.getByText('No files have been shared on this request yet.')
      ).toBeInTheDocument();
    });
  });

  it('lists admin files without offering to open them', () => {
    renderCard({
      lens: 'admin',
      files: [
        {
          id: 'a1',
          fileName: 'Audit.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1,
          side: 'client',
          audience: 'all_live_tracks',
          uploadedByName: 'Sarah',
          createdAtIso: '2026-08-01T00:00:00.000Z',
          visibleTo: [],
          deleted: false,
          deletedAtIso: null,
          deletedByName: null,
        },
      ],
    });
    expect(screen.getByText('Audit.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Audit.pdf' })).not.toBeInTheDocument();
  });

  it('puts the full variant inside its host card, not in a card of its own', () => {
    const { container } = render(
      <RequestFilesProvider requestId={REQUEST_ID} initialView={CLIENT_VIEW} brief={null}>
        <RequestFilesCard
          variant="full"
          heading={<h3>Files</h3>}
          documents={<p>Brief.pdf</p>}
          documentCount={1}
          fallback={null}
        />
      </RequestFilesProvider>
    );
    expect(container.firstElementChild?.className).toContain('mt-5');
    expect(container.firstElementChild?.className).not.toContain('border');
  });

  it('never nests one control inside another', () => {
    const { container } = render(
      <RequestFilesProvider requestId={REQUEST_ID} initialView={CLIENT_VIEW} brief={null}>
        <RequestFilesCard
          variant="compact"
          heading={<h3>Files</h3>}
          documents={<p>Brief.pdf</p>}
          documentCount={1}
          fallback={null}
        />
      </RequestFilesProvider>
    );
    expect(container.querySelector('button button, button input')).toBeNull();
  });
});
