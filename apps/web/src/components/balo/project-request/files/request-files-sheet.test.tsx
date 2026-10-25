import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RequestFilesView } from '@/lib/request-files/load-request-files';
import type {
  AdminRequestFileView,
  ClientRequestFileView,
  ExpertRequestFileView,
} from '@/lib/request-files/request-file-audience-view';
import { RequestFilesProvider, useRequestFiles } from './request-files-provider';

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  revoke: vi.fn(),
  remove: vi.fn(),
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
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const WEI = 'b0000000-0000-4000-8000-000000000002';
const PRIYA = 'b0000000-0000-4000-8000-000000000003';
const TRACKS = [
  { relationshipId: WEI, trackName: 'Wei Zhang' },
  { relationshipId: PRIYA, trackName: 'Priya Raman' },
];

function clientFile(id: string, name: string, visibleTo: string[]): ClientRequestFileView {
  return {
    id,
    fileName: name,
    contentType: 'application/pdf',
    sizeBytes: 1024,
    source: 'client',
    uploadedByName: 'Sarah Chen @ Acme',
    createdAtIso: '2026-08-01T00:00:00.000Z',
    audience: {
      type: 'grants',
      grants: TRACKS.filter((t) => visibleTo.includes(t.relationshipId)),
    },
    visibleToLiveTrackIds: visibleTo,
    canDelete: true,
  };
}

const WEI_FILE = clientFile('f-wei', 'For-Wei.pdf', [WEI]);
const PRIYA_FILE = clientFile('f-priya', 'For-Priya.pdf', [PRIYA]);
const BOTH_FILE = clientFile('f-both', 'For-Both.pdf', [WEI, PRIYA]);

function client(
  overrides: Partial<Extract<RequestFilesView, { lens: 'client' }>> = {}
): RequestFilesView {
  return {
    lens: 'client',
    files: [WEI_FILE, PRIYA_FILE, BOTH_FILE],
    liveTracks: TRACKS,
    requestKind: 'matched',
    ...overrides,
  };
}

const EXPERT_FILES: ExpertRequestFileView[] = [
  {
    id: 'e-own',
    fileName: 'My-approach.pdf',
    contentType: 'application/pdf',
    sizeBytes: 10,
    source: 'you',
    uploadedByName: 'You',
    createdAtIso: '2026-08-02T00:00:00.000Z',
    sharedBeforeYouJoined: false,
    canDelete: true,
  },
  {
    id: 'e-client',
    fileName: 'Client-brief.pdf',
    contentType: 'application/pdf',
    sizeBytes: 10,
    source: 'client',
    uploadedByName: 'Acme Corp',
    createdAtIso: '2026-07-30T00:00:00.000Z',
    sharedBeforeYouJoined: true,
    canDelete: false,
  },
];

function expert(closedReason: 'declined' | 'not_selected' | null = null): RequestFilesView {
  return {
    lens: 'expert',
    files: EXPERT_FILES,
    requestKind: 'matched',
    clientPartyName: 'Acme Corp',
    closedReason,
  };
}

const ADMIN_FILE: AdminRequestFileView = {
  id: 'a1',
  fileName: 'Admin-visible.pdf',
  contentType: 'application/pdf',
  sizeBytes: 10,
  side: 'client',
  audience: 'all_live_tracks',
  uploadedByName: 'Sarah Chen',
  createdAtIso: '2026-08-01T00:00:00.000Z',
  visibleTo: [{ relationshipId: WEI, trackName: 'Wei Zhang', via: 'all_live_tracks' }],
  deleted: false,
  deletedAtIso: null,
  deletedByName: null,
};

function OpenSheet(): React.JSX.Element {
  const files = useRequestFiles();
  return (
    <button type="button" onClick={files?.openAllFiles}>
      open all
    </button>
  );
}

async function openSheet(view: RequestFilesView): Promise<HTMLElement> {
  const user = userEvent.setup();
  render(
    <RequestFilesProvider
      requestId={REQUEST_ID}
      initialView={view}
      brief={<p data-testid="brief">Brief.pdf</p>}
    >
      <OpenSheet />
    </RequestFilesProvider>
  );
  await user.click(screen.getByRole('button', { name: 'open all' }));
  return screen.findByRole('dialog');
}

const rowNames = (sheet: HTMLElement): string[] =>
  within(sheet)
    .getAllByRole('button', { name: /^Open / })
    .map((b) => b.getAttribute('aria-label') ?? '');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.download.mockResolvedValue({ success: true, url: 'https://r2/get', contentType: 'x' });
  mocks.revoke.mockResolvedValue({ success: true });
  mocks.remove.mockResolvedValue({ success: true });
});

describe('RequestFilesSheet — client', () => {
  it('titles the sheet and says what each side sees', async () => {
    const sheet = await openSheet(client());
    expect(within(sheet).getByText('All files on this request')).toBeInTheDocument();
    expect(
      within(sheet).getByText('You see every file. Experts see only what is shared with them.')
    ).toBeInTheDocument();
  });

  it('lists the brief first, then every shared file', async () => {
    const sheet = await openSheet(client());
    const items = within(sheet).getAllByRole('listitem');
    expect(items[0]).toContainElement(screen.getByTestId('brief'));
    expect(rowNames(sheet)).toEqual([
      'Open For-Wei.pdf',
      'Open For-Priya.pdf',
      'Open For-Both.pdf',
    ]);
  });

  /** AC12: the chips filter by the server-computed visibility set, nothing re-derived. */
  it('filters to what one expert can see, with "All" restoring the list', async () => {
    const user = userEvent.setup();
    const sheet = await openSheet(client());
    const chips = within(
      within(sheet).getByRole('radiogroup', { name: 'Show files' })
    ).getAllByRole('radio');
    expect(chips.map((c) => c.textContent)).toEqual(['All', 'Wei can see', 'Priya can see']);
    expect(chips[0]).toHaveAttribute('aria-checked', 'true');

    await user.click(chips[1] as HTMLElement);
    expect(rowNames(sheet)).toEqual(['Open For-Wei.pdf', 'Open For-Both.pdf']);
    expect(chips[1]).toHaveAttribute('aria-checked', 'true');

    await user.click(chips[2] as HTMLElement);
    expect(rowNames(sheet)).toEqual(['Open For-Priya.pdf', 'Open For-Both.pdf']);

    await user.click(chips[0] as HTMLElement);
    expect(rowNames(sheet)).toHaveLength(3);
  });

  it('invites a share when the filter matches nothing', async () => {
    const user = userEvent.setup();
    const sheet = await openSheet(client({ files: [WEI_FILE] }));
    await user.click(within(sheet).getByRole('radio', { name: 'Priya can see' }));
    expect(
      within(sheet).getByText(
        'Nothing is shared with Priya yet. Share a file from their conversation.'
      )
    ).toBeInTheDocument();
  });

  it('shows no filter with a single live expert', async () => {
    const sheet = await openSheet(client({ liveTracks: [TRACKS[0] as (typeof TRACKS)[number]] }));
    expect(within(sheet).queryByRole('radiogroup', { name: 'Show files' })).not.toBeInTheDocument();
  });

  it('offers "Share with several experts" on a matched request', async () => {
    const sheet = await openSheet(client());
    expect(
      within(sheet).getByRole('button', { name: 'Share with several experts' })
    ).toBeInTheDocument();
  });

  it('shows no filter and no broadcast on a direct request', async () => {
    const sheet = await openSheet(client({ requestKind: 'direct' }));
    expect(within(sheet).queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(
      within(sheet).queryByRole('button', { name: 'Share with several experts' })
    ).not.toBeInTheDocument();
    expect(rowNames(sheet)).toHaveLength(3);
  });

  it('invites a first share when nothing has been shared', async () => {
    const sheet = await openSheet(client({ files: [] }));
    expect(
      within(sheet).getByText('Share a file from the conversation, or with several experts below.')
    ).toBeInTheDocument();
  });

  it('invites a share from the conversation alone on a direct request', async () => {
    const sheet = await openSheet(client({ files: [], requestKind: 'direct' }));
    expect(within(sheet).getByText('Share a file from the conversation.')).toBeInTheDocument();
  });

  it('invites a first share without a conversation when no expert is live', async () => {
    const sheet = await openSheet(client({ files: [], liveTracks: [] }));
    expect(
      within(sheet).getByText('Files you share with experts will appear here.')
    ).toBeInTheDocument();
  });

  it('shows each file’s audience badges with a revoke control', async () => {
    const user = userEvent.setup();
    const sheet = await openSheet(client({ files: [WEI_FILE] }));
    expect(within(sheet).getByText('Wei Zhang only')).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Remove access for Wei Zhang' }));
    expect(mocks.revoke).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      fileId: 'f-wei',
      relationshipId: WEI,
    });
  });

  it('confirms before removing a file', async () => {
    const user = userEvent.setup();
    const sheet = await openSheet(client({ files: [WEI_FILE] }));
    await user.click(within(sheet).getByRole('button', { name: 'Remove For-Wei.pdf' }));
    expect(await screen.findByText('Remove For-Wei.pdf?')).toBeInTheDocument();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('previews through the row’s name', async () => {
    const user = userEvent.setup();
    const sheet = await openSheet(client({ files: [WEI_FILE] }));
    await user.click(within(sheet).getByRole('button', { name: 'Open For-Wei.pdf' }));
    expect(mocks.download).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      fileId: 'f-wei',
      purpose: 'preview',
    });
  });
});

describe('RequestFilesSheet — expert', () => {
  it('is titled "Files" with no audience vocabulary, filter or broadcast', async () => {
    const sheet = await openSheet(expert());
    expect(within(sheet).getByRole('heading', { name: 'Files' })).toBeInTheDocument();
    expect(within(sheet).queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(within(sheet).queryByText('Share with several experts')).not.toBeInTheDocument();
    expect(sheet.textContent).not.toMatch(/All interested experts|Their conversation only/);
  });

  it('keeps the shipped "only" and "before you joined" badges', async () => {
    const sheet = await openSheet(expert());
    expect(within(sheet).getByText('Visible to Acme Corp only')).toBeInTheDocument();
    expect(within(sheet).getByText('Shared before you joined')).toBeInTheDocument();
  });

  it('lets the expert remove only their own upload', async () => {
    const sheet = await openSheet(expert());
    expect(
      within(sheet).getByRole('button', { name: 'Remove My-approach.pdf' })
    ).toBeInTheDocument();
    expect(
      within(sheet).queryByRole('button', { name: 'Remove Client-brief.pdf' })
    ).not.toBeInTheDocument();
  });

  it('says why the track is closed', async () => {
    const sheet = await openSheet(expert('not_selected'));
    expect(within(sheet).getByText(/This project went to another expert/)).toBeInTheDocument();
  });

  it('says the invitation was declined, and never the not-selected wording', async () => {
    const sheet = await openSheet(expert('declined'));
    expect(within(sheet).getByText(/You declined this invitation/)).toBeInTheDocument();
    expect(within(sheet).queryByText(/went to another expert/)).not.toBeInTheDocument();
  });

  it('shows no closure banner on a live track', async () => {
    const sheet = await openSheet(expert());
    expect(within(sheet).queryByText(/stay available/)).not.toBeInTheDocument();
  });

  it('invites a first share to the client only', async () => {
    const sheet = await openSheet({ ...expert(), files: [] } as RequestFilesView);
    expect(
      within(sheet).getByText('Share a file from the conversation. It goes to the client only.')
    ).toBeInTheDocument();
  });
});

describe('RequestFilesSheet — admin', () => {
  it('is read-only: audit rows, no controls beyond closing', async () => {
    const sheet = await openSheet({ lens: 'admin', files: [ADMIN_FILE] });
    expect(within(sheet).getByRole('heading', { name: 'Files' })).toBeInTheDocument();
    expect(within(sheet).getByText('Admin-visible.pdf')).toBeInTheDocument();
    expect(within(sheet).getByText('Visible now to:')).toBeInTheDocument();
    expect(
      within(sheet).queryByRole('button', { name: /^(Open|Remove|Download)/ })
    ).not.toBeInTheDocument();
    expect(within(sheet).queryByText('Share with several experts')).not.toBeInTheDocument();
  });

  it('states plainly that nothing has been shared', async () => {
    const sheet = await openSheet({ lens: 'admin', files: [] });
    expect(
      within(sheet).getByText('No files have been shared on this request yet.')
    ).toBeInTheDocument();
  });
});
