import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConversationMessageView } from '@/lib/conversations/conversation-view-types';
import type { RequestFilesView } from '@/lib/request-files/load-request-files';
import type { RequestThreadFileCard } from '@/lib/request-files/request-file-audience-view';
import { RequestFilesProvider } from './request-files-provider';
import { ThreadFileCard } from './thread-file-card';

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

const VIEW: RequestFilesView = {
  lens: 'client',
  files: [],
  liveTracks: [{ relationshipId: WEI, trackName: 'Wei Zhang' }],
  requestKind: 'matched',
};

const CLIENT_CARD: RequestThreadFileCard = {
  kind: 'client',
  file: {
    id: 'f1',
    fileName: 'Requirements.pdf',
    contentType: 'application/pdf',
    sizeBytes: 2048,
    source: 'client',
    uploadedByName: 'Sarah Chen @ Acme',
    createdAtIso: '2026-08-01T00:00:00.000Z',
    audience: { type: 'grants', grants: [{ relationshipId: WEI, trackName: 'Wei Zhang' }] },
    visibleToLiveTrackIds: [WEI],
    canDelete: true,
  },
};

const EXPERT_CARD: RequestThreadFileCard = {
  kind: 'expert',
  file: {
    id: 'f1',
    fileName: 'Requirements.pdf',
    contentType: 'application/pdf',
    sizeBytes: 2048,
    source: 'client',
    uploadedByName: 'Acme Corp',
    createdAtIso: '2026-08-01T00:00:00.000Z',
    sharedBeforeYouJoined: false,
    canDelete: false,
  },
};

function message(card: RequestThreadFileCard | undefined, bodyHtml = ''): ConversationMessageView {
  return {
    id: 'm1',
    conversationId: 'c1',
    bodyHtml,
    senderUserId: 'u1',
    senderName: 'Sarah',
    createdAtIso: '2026-08-01T00:00:00.000Z',
    requestSharedFile: card,
  };
}

function renderCard(
  msg: ConversationMessageView,
  mine = false,
  withProvider = true
): ReturnType<typeof render> {
  const card = <ThreadFileCard message={msg} mine={mine} />;
  if (!withProvider) return render(card);
  return render(
    <RequestFilesProvider requestId={REQUEST_ID} initialView={VIEW} brief={null}>
      {card}
    </RequestFilesProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.download.mockResolvedValue({ success: true, url: 'https://r2/get', contentType: 'x' });
});

describe('ThreadFileCard', () => {
  it('renders nothing for a message that carries no card', () => {
    const { container } = renderCard(message(undefined));
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the file, its size and the sharer’s note', () => {
    renderCard(message(CLIENT_CARD, '<p>Here is the NDA</p>'));
    expect(screen.getByRole('button', { name: 'Open Requirements.pdf' })).toBeInTheDocument();
    expect(screen.getByText('2048 B')).toBeInTheDocument();
    expect(screen.getByText('Here is the NDA')).toBeInTheDocument();
  });

  it('shows the client the file’s current audience', () => {
    renderCard(message(CLIENT_CARD));
    expect(screen.getByText('Wei Zhang only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove access/ })).not.toBeInTheDocument();
  });

  it('leaves the note out when the file was shared without one', () => {
    const { container } = renderCard(message(CLIENT_CARD, ''));
    expect(container.querySelector('p')).toBeNull();
  });

  /** AC4: the expert's card has nothing audience-shaped to render. */
  it('shows the expert the file with no audience vocabulary', () => {
    const { container } = renderCard(message(EXPERT_CARD, '<p>Note</p>'));
    expect(screen.getByRole('button', { name: 'Open Requirements.pdf' })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/only|All interested|Their conversation|Wei Zhang/);
  });

  it('previews through the provider when the file is clicked', async () => {
    const user = userEvent.setup();
    renderCard(message(CLIENT_CARD));
    await user.click(screen.getByRole('button', { name: 'Open Requirements.pdf' }));
    expect(mocks.download).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      fileId: 'f1',
      purpose: 'preview',
    });
  });

  it('disables the file while its preview is being minted', async () => {
    let resolve: (value: unknown) => void = () => {};
    mocks.download.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      })
    );
    const user = userEvent.setup();
    renderCard(message(CLIENT_CARD));
    await user.click(screen.getByRole('button', { name: 'Open Requirements.pdf' }));
    expect(screen.getByRole('button', { name: 'Open Requirements.pdf' })).toBeDisabled();
    resolve({ success: false, error: 'Gone.' });
  });

  it('is inert outside a files provider', () => {
    renderCard(message(CLIENT_CARD), false, false);
    expect(screen.getByRole('button', { name: 'Open Requirements.pdf' })).toBeDisabled();
  });

  it('puts the sender’s own card on the right in the primary tint, and theirs on the left', () => {
    const own = renderCard(message(CLIENT_CARD), true);
    expect(own.container.firstElementChild?.className).toContain('items-end');
    own.unmount();
    const theirs = renderCard(message(CLIENT_CARD), false);
    expect(theirs.container.firstElementChild?.className).toContain('items-start');
  });

  /** AC8: the file row is the only control, and nothing sits inside another control. */
  it('nests no control inside another', () => {
    const { container } = renderCard(message(CLIENT_CARD, '<p>Note</p>'));
    expect(container.querySelector('button button, button input, button a')).toBeNull();
  });

  describe('a file removed after it was shared', () => {
    it('shows the name struck through with "Removed" and offers no action', () => {
      renderCard(message({ kind: 'client_removed', fileName: 'Old.pdf' }));
      expect(screen.getByText('Old.pdf').className).toContain('line-through');
      expect(screen.getByText('Removed')).toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
  });
});
