import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { track, CONVERSATION_EVENTS, PROJECT_EVENTS } from '@/lib/analytics';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const VIEWER_ID = 'user-viewer';

vi.mock('server-only', () => ({}));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

const mockPush = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

// Tiptap-free viewer stand-in (EOI intro card only — bubbles never use it).
vi.mock('@/components/balo/rich-text-editor', () => ({
  RichTextViewer: ({ value }: { value: string }) => <div data-testid="rt-viewer">{value}</div>,
}));

const {
  mockPostMessage,
  mockMarkRead,
  mockFetchThread,
  mockRequestUpload,
  mockConfirmUpload,
  mockGetDownload,
  mockRequestCall,
  mockRequestProposal,
} = vi.hoisted(() => ({
  mockPostMessage: vi.fn(),
  mockMarkRead: vi.fn(),
  mockFetchThread: vi.fn(),
  mockRequestUpload: vi.fn(),
  mockConfirmUpload: vi.fn(),
  mockGetDownload: vi.fn(),
  mockRequestCall: vi.fn(),
  mockRequestProposal: vi.fn(),
}));

vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/post-conversation-message', () => ({
  postConversationMessageAction: (...args: unknown[]) => mockPostMessage(...args),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/mark-thread-read', () => ({
  markThreadReadAction: (...args: unknown[]) => mockMarkRead(...args),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/fetch-thread', () => ({
  fetchThreadAction: (...args: unknown[]) => mockFetchThread(...args),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/request-conversation-file-upload', () => ({
  requestConversationFileUploadAction: (...args: unknown[]) => mockRequestUpload(...args),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/confirm-conversation-file-upload', () => ({
  confirmConversationFileUploadAction: (...args: unknown[]) => mockConfirmUpload(...args),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/get-conversation-file-download', () => ({
  getConversationFileDownloadAction: (...args: unknown[]) => mockGetDownload(...args),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/request-conversation-call', () => ({
  requestConversationCallAction: (...args: unknown[]) => mockRequestCall(...args),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/request-proposal', () => ({
  requestProposalAction: (...args: unknown[]) => mockRequestProposal(...args),
}));

// XHR PUT seam — no sockets in jsdom.
const mockPutWithProgress = vi.hoisted(() => vi.fn());
vi.mock('@/components/balo/document-uploader/upload-file', () => ({
  formatBytes: (bytes: number) => `${bytes} B`,
  putWithProgress: (...args: unknown[]) => mockPutWithProgress(...args),
}));

// Capture the realtime wiring so tests can inject incoming events + status.
interface RealtimeInput {
  enabled: boolean;
  requestId: string;
  relationshipIds: string[];
  onMessage: (m: unknown) => void;
  onFile: (f: unknown) => void;
}
const realtimeCapture: { input: RealtimeInput | null; status: string } = {
  input: null,
  status: 'connected',
};
vi.mock('./use-conversation-realtime', () => ({
  useConversationRealtime: (input: RealtimeInput) => {
    realtimeCapture.input = input;
    return { status: realtimeCapture.status };
  },
}));

import { ConversationStage } from './conversation-stage';
import { thread as baseThread } from '@/test/fixtures/conversation';
import type {
  ConversationThreadView,
  ConversationView,
} from '@/lib/project-request/conversation-view-types';

const mockTrack = vi.mocked(track);
const mockToast = vi.mocked(toast);

/** This suite's default thread carries a published profile slug. */
function thread(overrides: Partial<ConversationThreadView> = {}): ConversationThreadView {
  return baseThread({ expertUsername: 'priya-nair', ...overrides });
}

function view(overrides: Partial<ConversationView> = {}): ConversationView {
  return {
    viewerUserId: VIEWER_ID,
    threads: [thread()],
    defaultThreadId: 'rel-1',
    initialMessages: [],
    initialHasEarlier: false,
    initialFiles: [],
    realtimeEnabled: true,
    ...overrides,
  };
}

function message(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    relationshipId: 'rel-1',
    bodyHtml: `<p>msg ${id}</p>`,
    senderUserId: 'user-expert',
    senderName: 'Priya Nair',
    createdAtIso: '2026-06-09T10:00:00.000Z',
    ...overrides,
  };
}

function fileView(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    relationshipId: 'rel-1',
    fileName: `${id}.pdf`,
    contentType: 'application/pdf',
    sizeBytes: 1234,
    uploadedByUserId: 'user-expert',
    uploadedByName: 'Priya Nair',
    createdAtIso: '2026-06-09T11:00:00.000Z',
    ...overrides,
  };
}

function renderStage(v: ConversationView, lens: 'client' | 'expert' = 'client'): void {
  render(
    <ConversationStage requestId={REQUEST_ID} lens={lens} requestStatus="eoi_submitted" view={v} />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  realtimeCapture.input = null;
  realtimeCapture.status = 'connected';
  mockMarkRead.mockResolvedValue({ success: true, lastReadAtIso: new Date().toISOString() });
  mockFetchThread.mockResolvedValue({ success: true, messages: [], hasEarlier: false, files: [] });
  mockPostMessage.mockResolvedValue({
    success: true,
    message: message('m-new', { senderUserId: VIEWER_ID }),
  });
  mockRequestCall.mockResolvedValue({
    success: true,
    mocked: true,
    confirmation: {
      message: 'Your call request is in — Balo will email you the details.',
      scheduledAtIso: null,
    },
  });
  mockRequestProposal.mockResolvedValue({
    success: true,
    transitioned: true,
    expertProfileId: 'exp-1',
    analytics: {
      proposalRequestCount: 1,
      timeFromFirstEoiMs: 5000,
      messageCount: 4,
      fileCount: 1,
    },
  });
});

describe('ConversationStage — default tab + mount behaviour', () => {
  it('honors the server-picked default tab and marks it read on mount', async () => {
    const v = view({
      threads: [
        thread(),
        thread({
          relationshipId: 'rel-2',
          expertFirstName: 'Marcus',
          expertInitials: 'MC',
          expertName: 'Marcus Chen',
        }),
      ],
      defaultThreadId: 'rel-2',
    });
    renderStage(v);
    // Exact name — the nudge's "Book a call with Marcus" also mentions him.
    expect(screen.getByRole('button', { name: 'Marcus' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() =>
      expect(mockMarkRead).toHaveBeenCalledWith({ requestId: REQUEST_ID, relationshipId: 'rel-2' })
    );
    expect(mockTrack).toHaveBeenCalledWith(
      CONVERSATION_EVENTS.CONVERSATION_THREAD_SELECTED,
      expect.objectContaining({ method: 'auto', relationship_id: 'rel-2', thread_count: 2 })
    );
  });

  it('shows the unread dot on non-active unread threads', () => {
    renderStage(
      view({
        threads: [
          thread(),
          thread({ relationshipId: 'rel-2', expertFirstName: 'Marcus', unread: true }),
        ],
        defaultThreadId: 'rel-1',
      })
    );
    expect(screen.getByText('Unread activity')).toBeInTheDocument();
  });

  it('subscribes realtime across ALL open threads, not just the active one', () => {
    renderStage(
      view({
        threads: [thread(), thread({ relationshipId: 'rel-2', expertFirstName: 'Marcus' })],
      })
    );
    expect(realtimeCapture.input?.enabled).toBe(true);
    expect(realtimeCapture.input?.relationshipIds).toEqual(['rel-1', 'rel-2']);
  });

  it('disables realtime when the server said so', () => {
    renderStage(view({ realtimeEnabled: false }));
    expect(realtimeCapture.input?.enabled).toBe(false);
  });
});

describe('ConversationStage — zero open threads', () => {
  it('client lens renders the invitation empty state with a disabled composer', () => {
    renderStage(view({ threads: [], defaultThreadId: null }));
    expect(screen.getByText('Your conversation lives here')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('expert lens explains the conversation opens after the EOI', () => {
    renderStage(view({ threads: [], defaultThreadId: null }), 'expert');
    expect(
      screen.getByText('Your conversation opens once you express interest')
    ).toBeInTheDocument();
    // Lens-aware disabled composer copy — never the client framing.
    expect(screen.getByRole('textbox', { name: 'Message them' })).toHaveAttribute(
      'placeholder',
      'Messaging opens once you express interest…'
    );
  });

  it('client lens disabled composer keeps the expert-framing copy', () => {
    renderStage(view({ threads: [], defaultThreadId: null }));
    expect(screen.getByRole('textbox', { name: 'Message them' })).toHaveAttribute(
      'placeholder',
      'Messaging opens once an expert expresses interest…'
    );
  });
});

describe('ConversationStage — tab switching (four states)', () => {
  it('fetches an unloaded thread, tracks the manual selection, and clears its dot', async () => {
    const user = userEvent.setup();
    mockFetchThread.mockResolvedValue({
      success: true,
      messages: [message('m-9', { relationshipId: 'rel-2' })],
      hasEarlier: false,
      files: [],
    });
    renderStage(
      view({
        threads: [
          thread(),
          thread({ relationshipId: 'rel-2', expertFirstName: 'Marcus', unread: true }),
        ],
      })
    );

    await user.click(screen.getByRole('button', { name: /Marcus/ }));
    expect(mockFetchThread).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      relationshipId: 'rel-2',
      includeFiles: true,
    });
    expect(mockTrack).toHaveBeenCalledWith(
      CONVERSATION_EVENTS.CONVERSATION_THREAD_SELECTED,
      expect.objectContaining({ method: 'manual', relationship_id: 'rel-2', was_unread: true })
    );
    expect(await screen.findByText('msg m-9')).toBeInTheDocument();
    expect(screen.queryByText('Unread activity')).not.toBeInTheDocument();
  });

  it('shows the per-thread error state with a working Retry', async () => {
    const user = userEvent.setup();
    mockFetchThread.mockResolvedValueOnce({ success: false, error: 'nope' });
    mockFetchThread.mockResolvedValueOnce({
      success: true,
      messages: [message('m-2', { relationshipId: 'rel-2' })],
      hasEarlier: false,
      files: [],
    });
    renderStage(
      view({ threads: [thread(), thread({ relationshipId: 'rel-2', expertFirstName: 'Marcus' })] })
    );

    await user.click(screen.getByRole('button', { name: /Marcus/ }));
    expect(await screen.findByText(/Couldn't load this conversation/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByText('msg m-2')).toBeInTheDocument();
  });

  it('renders the empty-thread invitation for a loaded-but-empty thread', () => {
    renderStage(view());
    expect(screen.getByText('Start the conversation with Priya')).toBeInTheDocument();
  });
});

describe('ConversationStage — composer send', () => {
  it('posts, appends, clears the draft, toasts, and tracks', async () => {
    const user = userEvent.setup();
    renderStage(view());
    const textarea = screen.getByRole('textbox', { name: 'Message Priya' });
    await user.type(textarea, 'Hello there{Enter}');

    await waitFor(() =>
      expect(mockPostMessage).toHaveBeenCalledWith({
        requestId: REQUEST_ID,
        relationshipId: 'rel-1',
        body: 'Hello there',
      })
    );
    expect(await screen.findByText('msg m-new')).toBeInTheDocument();
    expect(textarea).toHaveValue('');
    expect(mockToast.success).toHaveBeenCalledWith('Message sent');
    expect(mockTrack).toHaveBeenCalledWith(
      CONVERSATION_EVENTS.CONVERSATION_MESSAGE_SENT,
      expect.objectContaining({
        request_id: REQUEST_ID,
        relationship_id: 'rel-1',
        lens: 'client',
        is_first_message_in_thread: true,
      })
    );
  });

  it('keeps the draft and toasts on failure', async () => {
    const user = userEvent.setup();
    mockPostMessage.mockResolvedValue({ success: false, error: 'Could not send your message.' });
    renderStage(view());
    const textarea = screen.getByRole('textbox', { name: 'Message Priya' });
    await user.type(textarea, 'Important draft{Enter}');

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith('Could not send your message.')
    );
    expect(textarea).toHaveValue('Important draft');
  });
});

describe('ConversationStage — realtime ingestion', () => {
  it('appends an incoming message to the active thread and dedupes the echo', async () => {
    renderStage(view());
    act(() => realtimeCapture.input?.onMessage(message('m-77')));
    // The text shows in the bubble (and may echo in the nudge preview) —
    // dedupe means a SECOND identical event adds nothing.
    const occurrences = (await screen.findAllByText('msg m-77')).length;
    expect(occurrences).toBeGreaterThanOrEqual(1);
    act(() => realtimeCapture.input?.onMessage(message('m-77')));
    expect(screen.getAllByText('msg m-77')).toHaveLength(occurrences);
  });

  it('flags a NON-active thread unread on incoming activity', async () => {
    renderStage(
      view({ threads: [thread(), thread({ relationshipId: 'rel-2', expertFirstName: 'Marcus' })] })
    );
    expect(screen.queryByText('Unread activity')).not.toBeInTheDocument();
    act(() => realtimeCapture.input?.onMessage(message('m-88', { relationshipId: 'rel-2' })));
    expect(await screen.findByText('Unread activity')).toBeInTheDocument();
  });

  it('never flags own multi-device messages unread', () => {
    renderStage(
      view({ threads: [thread(), thread({ relationshipId: 'rel-2', expertFirstName: 'Marcus' })] })
    );
    act(() =>
      realtimeCapture.input?.onMessage(
        message('m-99', { relationshipId: 'rel-2', senderUserId: VIEWER_ID })
      )
    );
    expect(screen.queryByText('Unread activity')).not.toBeInTheDocument();
  });
});

describe('ConversationStage — files + call + EOI intro', () => {
  it('opens the files panel from the tab-strip button and tracks the surface', async () => {
    const user = userEvent.setup();
    renderStage(view({ threads: [thread({ fileCount: 2 })] }));
    await user.click(screen.getByRole('button', { name: /Open shared files/ }));
    expect(mockTrack).toHaveBeenCalledWith(
      CONVERSATION_EVENTS.CONVERSATION_FILES_OPENED,
      expect.objectContaining({ surface: 'tabstrip' })
    );
    expect(await screen.findByText('Shared in this conversation')).toBeInTheDocument();
    expect(screen.getByText('No files shared yet')).toBeInTheDocument();
  });

  it('fires the call analytics BEFORE the mock action and toasts its confirmation', async () => {
    const user = userEvent.setup();
    renderStage(view());
    // Desktop header call button (also reachable via nudge/rail).
    const [callButton] = screen.getAllByRole('button', { name: 'Book a call' });
    expect(callButton).toBeDefined();
    await user.click(callButton as HTMLElement);
    expect(mockTrack).toHaveBeenCalledWith(
      CONVERSATION_EVENTS.CONVERSATION_CALL_CTA_CLICKED,
      expect.objectContaining({ surface: 'header', lens: 'client' })
    );
    await waitFor(() =>
      expect(mockToast.success).toHaveBeenCalledWith(
        'Your call request is in — Balo will email you the details.'
      )
    );
    expect(mockRequestCall).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      relationshipId: 'rel-1',
    });
  });

  it('pins the client-lens EOI intro card at the top of the fully-loaded thread', () => {
    renderStage(view({ threads: [thread({ eoiHtml: '<p>My pitch</p>' })] }));
    expect(screen.getByText('Expression of interest')).toBeInTheDocument();
    expect(screen.getByTestId('rt-viewer')).toHaveTextContent('My pitch');
  });

  it('shows the mobile overflow trigger only when it has content', () => {
    renderStage(view({ threads: [thread({ expertUsername: null })] }));
    expect(screen.queryByRole('button', { name: 'More thread options' })).not.toBeInTheDocument();
  });

  it('opens the overflow sheet with the profile link when a username exists', async () => {
    const user = userEvent.setup();
    renderStage(view());
    await user.click(screen.getByRole('button', { name: 'More thread options' }));
    const profileLink = await screen.findByRole('link', { name: /View Priya's profile/ });
    expect(profileLink).toHaveAttribute('href', '/experts/priya-nair');
  });
});

describe('ConversationStage — file share (presign → PUT → confirm)', () => {
  const KEY = 'conversation-files/rel-1/user-viewer/abc';

  function pickFile(file: File): Promise<void> {
    const user = userEvent.setup({ applyAccept: false });
    const input = document.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    return user.upload(input as HTMLInputElement, file);
  }

  beforeEach(() => {
    mockRequestUpload.mockResolvedValue({
      success: true,
      presignedUrl: 'https://signed.example/put',
      key: KEY,
    });
    mockPutWithProgress.mockResolvedValue(undefined);
    mockConfirmUpload.mockResolvedValue({
      success: true,
      file: fileView('f-new', { uploadedByUserId: VIEWER_ID, uploadedByName: 'You' }),
    });
  });

  it('runs the full pipeline, appends the file bubble, bumps the badge, toasts + tracks', async () => {
    renderStage(view());
    await pickFile(new File(['x'], 'scope.pdf', { type: 'application/pdf' }));

    await waitFor(() =>
      expect(mockConfirmUpload).toHaveBeenCalledWith({
        requestId: REQUEST_ID,
        relationshipId: 'rel-1',
        key: KEY,
        fileName: 'scope.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      })
    );
    expect(mockRequestUpload).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      relationshipId: 'rel-1',
      contentType: 'application/pdf',
      fileName: 'scope.pdf',
    });
    expect(mockPutWithProgress).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://signed.example/put' })
    );
    expect(await screen.findByText('f-new.pdf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open shared files (1)' })).toBeInTheDocument();
    expect(mockToast.success).toHaveBeenCalledWith('File shared');
    expect(mockTrack).toHaveBeenCalledWith(
      CONVERSATION_EVENTS.CONVERSATION_FILE_SHARED,
      expect.objectContaining({ content_type: 'application/pdf', lens: 'client' })
    );
  });

  it('rejects an unsupported type client-side without presigning', async () => {
    renderStage(view());
    await pickFile(new File(['x'], 'virus.exe', { type: 'application/x-msdownload' }));
    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith("virus.exe isn't a supported file type.")
    );
    expect(mockRequestUpload).not.toHaveBeenCalled();
  });

  it('rejects an oversized file client-side', async () => {
    renderStage(view());
    const big = new File(['x'], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });
    await pickFile(big);
    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        expect.stringContaining('files must be 10 MB or smaller')
      )
    );
    expect(mockRequestUpload).not.toHaveBeenCalled();
  });

  it('surfaces presign failures (e.g. R2 unconfigured) as a toast', async () => {
    mockRequestUpload.mockResolvedValue({
      success: false,
      error: "File sharing isn't available right now.",
    });
    renderStage(view());
    await pickFile(new File(['x'], 'scope.pdf', { type: 'application/pdf' }));
    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith("File sharing isn't available right now.")
    );
    expect(mockConfirmUpload).not.toHaveBeenCalled();
  });

  it('surfaces confirm failures (e.g. duplicate share)', async () => {
    mockConfirmUpload.mockResolvedValue({
      success: false,
      error: 'This file was already shared.',
    });
    renderStage(view());
    await pickFile(new File(['x'], 'scope.pdf', { type: 'application/pdf' }));
    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith('This file was already shared.')
    );
  });

  it('maps an upload transport failure to the generic copy', async () => {
    mockPutWithProgress.mockRejectedValue(new Error('network'));
    renderStage(view());
    await pickFile(new File(['x'], 'scope.pdf', { type: 'application/pdf' }));
    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith('Could not share your file. Please try again.')
    );
  });
});

describe('ConversationStage — downloads + load earlier + realtime files', () => {
  it('presigns a file download from the bubble (same-tab navigation, no error)', async () => {
    const user = userEvent.setup();
    mockGetDownload.mockResolvedValue({ success: true, url: 'https://signed.example/get' });
    renderStage(
      view({ initialFiles: [fileView('f-1') as never], threads: [thread({ fileCount: 1 })] })
    );
    await user.click(screen.getByRole('button', { name: /f-1\.pdf/ }));
    await waitFor(() =>
      expect(mockGetDownload).toHaveBeenCalledWith({
        requestId: REQUEST_ID,
        relationshipId: 'rel-1',
        fileId: 'f-1',
      })
    );
    // Success path navigates via window.location.assign (Safari-safe — the
    // presigned GET forces attachment). jsdom's Location is unforgeable, so
    // assert the observable contract instead: no error toast, row re-enables.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /f-1\.pdf/ })).not.toBeDisabled()
    );
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it('toasts when the download presign fails', async () => {
    const user = userEvent.setup();
    mockGetDownload.mockResolvedValue({
      success: false,
      error: 'This file is no longer available.',
    });
    renderStage(view({ initialFiles: [fileView('f-1') as never] }));
    await user.click(screen.getByRole('button', { name: /f-1\.pdf/ }));
    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith('This file is no longer available.')
    );
  });

  it('loads earlier messages with the strict keyset cursor and prepends them', async () => {
    const user = userEvent.setup();
    mockFetchThread.mockResolvedValue({
      success: true,
      messages: [message('m-0', { createdAtIso: '2026-06-08T10:00:00.000Z' })],
      hasEarlier: false,
    });
    renderStage(view({ initialMessages: [message('m-1') as never], initialHasEarlier: true }));
    await user.click(screen.getByRole('button', { name: /Load earlier/ }));
    expect(mockFetchThread).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      relationshipId: 'rel-1',
      before: { createdAtIso: '2026-06-09T10:00:00.000Z', id: 'm-1' },
      includeFiles: false,
    });
    expect(await screen.findByText('msg m-0')).toBeInTheDocument();
    // Fully loaded now — the button collapses.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Load earlier/ })).not.toBeInTheDocument()
    );
  });

  it('appends an incoming realtime FILE, bumps the badge, and dedupes echoes', async () => {
    renderStage(view());
    act(() => realtimeCapture.input?.onFile(fileView('f-rt')));
    expect(await screen.findByText('f-rt.pdf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open shared files (1)' })).toBeInTheDocument();
    act(() => realtimeCapture.input?.onFile(fileView('f-rt')));
    expect(screen.getByRole('button', { name: 'Open shared files (1)' })).toBeInTheDocument();
    expect(screen.getAllByText('f-rt.pdf')).toHaveLength(1);
  });

  it('never double-counts two identical echoes batched into ONE render', async () => {
    renderStage(view());
    // Both arrive before React flushes — the queued updaters replay together.
    // Duplicate detection must happen BEFORE dispatch (pure updaters).
    act(() => {
      realtimeCapture.input?.onFile(fileView('f-batch'));
      realtimeCapture.input?.onFile(fileView('f-batch'));
    });
    expect(await screen.findByText('f-batch.pdf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open shared files (1)' })).toBeInTheDocument();
    expect(screen.getAllByText('f-batch.pdf')).toHaveLength(1);
  });

  it('flags a NON-active thread unread on an incoming file (file-only activity counts)', async () => {
    renderStage(
      view({ threads: [thread(), thread({ relationshipId: 'rel-2', expertFirstName: 'Marcus' })] })
    );
    act(() => realtimeCapture.input?.onFile(fileView('f-x', { relationshipId: 'rel-2' })));
    expect(await screen.findByText('Unread activity')).toBeInTheDocument();
  });
});

describe('ConversationStage — mobile action rail', () => {
  it('hides the rail while the composer is focused', async () => {
    const user = userEvent.setup();
    renderStage(view());
    // "Request proposal" stub renders twice: desktop header + mobile rail
    // (jsdom does not apply the responsive CSS that splits them).
    expect(screen.getAllByRole('button', { name: 'Request proposal' })).toHaveLength(2);
    await user.click(screen.getByRole('textbox', { name: 'Message Priya' }));
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Request proposal' })).toHaveLength(1)
    );
  });
});

describe('ConversationStage — per-thread composer drafts', () => {
  const TWO_THREADS = (): ConversationView =>
    view({
      threads: [thread(), thread({ relationshipId: 'rel-2', expertFirstName: 'Marcus' })],
    });

  it('preserves each thread’s draft across tab switches (Slack behaviour)', async () => {
    const user = userEvent.setup();
    renderStage(TWO_THREADS());

    await user.type(screen.getByRole('textbox', { name: 'Message Priya' }), 'Draft for Priya');
    await user.click(screen.getByRole('button', { name: 'Marcus' }));

    // Marcus's composer starts EMPTY — Priya's draft never leaks across.
    const marcusBox = screen.getByRole('textbox', { name: 'Message Marcus' });
    expect(marcusBox).toHaveValue('');

    await user.type(marcusBox, 'Draft for Marcus');
    await user.click(screen.getByRole('button', { name: 'Priya' }));
    expect(screen.getByRole('textbox', { name: 'Message Priya' })).toHaveValue('Draft for Priya');

    await user.click(screen.getByRole('button', { name: 'Marcus' }));
    expect(screen.getByRole('textbox', { name: 'Message Marcus' })).toHaveValue('Draft for Marcus');
  });

  it('never cross-sends: Enter posts the ACTIVE thread’s own draft only', async () => {
    const user = userEvent.setup();
    renderStage(TWO_THREADS());

    await user.type(screen.getByRole('textbox', { name: 'Message Priya' }), 'For Priya only');
    await user.click(screen.getByRole('button', { name: 'Marcus' }));
    await user.type(screen.getByRole('textbox', { name: 'Message Marcus' }), 'For Marcus{Enter}');

    await waitFor(() => expect(mockPostMessage).toHaveBeenCalledTimes(1));
    expect(mockPostMessage).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      relationshipId: 'rel-2',
      body: 'For Marcus',
    });
    // Sending cleared ONLY Marcus's draft — Priya's stays intact.
    await user.click(screen.getByRole('button', { name: 'Priya' }));
    expect(screen.getByRole('textbox', { name: 'Message Priya' })).toHaveValue('For Priya only');
    await user.click(screen.getByRole('button', { name: 'Marcus' }));
    expect(screen.getByRole('textbox', { name: 'Message Marcus' })).toHaveValue('');
  });

  it('keeps the failed thread’s draft after a rejected send', async () => {
    const user = userEvent.setup();
    mockPostMessage.mockResolvedValue({ success: false, error: 'nope' });
    renderStage(TWO_THREADS());

    await user.type(screen.getByRole('textbox', { name: 'Message Priya' }), 'Keep me{Enter}');
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('nope'));
    expect(screen.getByRole('textbox', { name: 'Message Priya' })).toHaveValue('Keep me');
  });
});

describe('ConversationStage — request proposal (BAL-272 / A5)', () => {
  /** Click the desktop-header CTA, then confirm inside the AlertDialog. */
  async function openAndConfirm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    const [headerCta] = screen.getAllByRole('button', { name: 'Request proposal' });
    expect(headerCta).toBeDefined();
    await user.click(headerCta as HTMLElement);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Request proposal' }));
  }

  it('CTA click fires the funnel event and opens the confirm beat (no action yet)', async () => {
    const user = userEvent.setup();
    renderStage(view());
    const [headerCta] = screen.getAllByRole('button', { name: 'Request proposal' });
    await user.click(headerCta as HTMLElement);

    expect(mockTrack).toHaveBeenCalledWith(CONVERSATION_EVENTS.CONVERSATION_PROPOSAL_CTA_CLICKED, {
      request_id: REQUEST_ID,
      relationship_id: 'rel-1',
      surface: 'header',
    });
    expect(await screen.findByText('Request a proposal from Priya?')).toBeInTheDocument();
    expect(mockRequestProposal).not.toHaveBeenCalled();
  });

  it('confirm runs the action, flips the thread to the requested pill, toasts, and fires both events', async () => {
    const user = userEvent.setup();
    renderStage(view());
    await openAndConfirm(user);

    await waitFor(() =>
      expect(mockRequestProposal).toHaveBeenCalledWith({
        requestId: REQUEST_ID,
        relationshipId: 'rel-1',
      })
    );
    // Local flip: warning pill in, gradient CTA out — no refetch needed.
    expect(await screen.findByText('Proposal requested')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request proposal' })).not.toBeInTheDocument();
    // The re-keyed thread nudge flips to the waiting cell.
    expect(screen.getByText('Priya is preparing the proposal')).toBeInTheDocument();

    expect(mockToast.success).toHaveBeenCalledWith('Proposal requested — Priya has been notified.');
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_PROPOSAL_REQUESTED, {
      request_id: REQUEST_ID,
      relationship_id: 'rel-1',
      expert_id: 'exp-1',
      actor: 'client',
      surface: 'header',
      proposal_request_count: 1,
      time_from_first_eoi_ms: 5000,
      message_count: 4,
      file_count: 1,
      thread_count: 1,
    });
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_REQUEST_STATUS_TRANSITIONED, {
      request_id: REQUEST_ID,
      from: 'eoi_submitted',
      to: 'proposal_requested',
      actor: 'client',
    });
  });

  it('omits the transition event (and the eoi timing when null) for a non-first request', async () => {
    const user = userEvent.setup();
    mockRequestProposal.mockResolvedValue({
      success: true,
      transitioned: false,
      expertProfileId: 'exp-1',
      analytics: {
        proposalRequestCount: 2,
        timeFromFirstEoiMs: null,
        messageCount: 0,
        fileCount: 0,
      },
    });
    renderStage(view());
    await openAndConfirm(user);

    await waitFor(() =>
      expect(mockTrack).toHaveBeenCalledWith(
        PROJECT_EVENTS.PROJECT_PROPOSAL_REQUESTED,
        expect.not.objectContaining({ time_from_first_eoi_ms: expect.anything() })
      )
    );
    expect(mockTrack).not.toHaveBeenCalledWith(
      PROJECT_EVENTS.PROJECT_REQUEST_STATUS_TRANSITIONED,
      expect.anything()
    );
  });

  it('already_requested (stale tab): reconciles the pill, toast.info, no commit events', async () => {
    const user = userEvent.setup();
    mockRequestProposal.mockResolvedValue({
      success: false,
      error: "You've already requested a proposal from this expert.",
      code: 'already_requested',
    });
    renderStage(view());
    await openAndConfirm(user);

    expect(await screen.findByText('Proposal requested')).toBeInTheDocument();
    expect(mockToast.info).toHaveBeenCalledWith(
      "You've already requested a proposal from this expert."
    );
    expect(mockTrack).not.toHaveBeenCalledWith(
      PROJECT_EVENTS.PROJECT_PROPOSAL_REQUESTED,
      expect.anything()
    );
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it('rail surface is tracked as rail', async () => {
    const user = userEvent.setup();
    renderStage(view());
    const [, railCta] = screen.getAllByRole('button', { name: 'Request proposal' });
    await user.click(railCta as HTMLElement);
    expect(mockTrack).toHaveBeenCalledWith(
      CONVERSATION_EVENTS.CONVERSATION_PROPOSAL_CTA_CLICKED,
      expect.objectContaining({ surface: 'rail' })
    );
  });

  it('expert lens: the "Build proposal" CTA navigates to the composer + fires the funnel event (A6.2)', async () => {
    const user = userEvent.setup();
    renderStage(
      view({ threads: [thread({ relationshipStatus: 'proposal_requested' })] }),
      'expert'
    );
    const [headerCta] = screen.getAllByRole('button', { name: 'Build proposal' });
    expect(headerCta).toBeDefined();
    expect(headerCta).toBeEnabled();
    await user.click(headerCta as HTMLElement);

    expect(mockTrack).toHaveBeenCalledWith(CONVERSATION_EVENTS.CONVERSATION_PROPOSAL_CTA_CLICKED, {
      request_id: REQUEST_ID,
      relationship_id: 'rel-1',
      surface: 'header',
    });
    expect(mockPush).toHaveBeenCalledWith(`/projects/${REQUEST_ID}/proposal/rel-1`);
    // It opens the composer, never the client's request-proposal confirm beat.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockRequestProposal).not.toHaveBeenCalled();
  });

  it('expert lens: the rail "Build proposal" CTA tracks the rail surface', async () => {
    const user = userEvent.setup();
    renderStage(
      view({ threads: [thread({ relationshipStatus: 'proposal_requested' })] }),
      'expert'
    );
    // DOM order is header → thread-nudge → mobile rail; the rail CTA is last.
    const ctas = screen.getAllByRole('button', { name: 'Build proposal' });
    const railCta = ctas.at(-1);
    expect(railCta).toBeDefined();
    await user.click(railCta as HTMLElement);
    expect(mockTrack).toHaveBeenCalledWith(
      CONVERSATION_EVENTS.CONVERSATION_PROPOSAL_CTA_CLICKED,
      expect.objectContaining({ surface: 'rail' })
    );
  });

  it('expert lens: every "Build proposal" CTA (header, rail, thread-nudge) is live and opens the composer', async () => {
    const user = userEvent.setup();
    renderStage(
      view({ threads: [thread({ relationshipStatus: 'proposal_requested' })] }),
      'expert'
    );
    // The thread nudge also surfaces its own live "Build proposal" primary.
    expect(screen.getByText('The client requested your proposal — build it')).toBeInTheDocument();

    const ctas = screen.getAllByRole('button', { name: 'Build proposal' });
    // Header + rail + thread-nudge primary = at least three live entry points.
    expect(ctas.length).toBeGreaterThanOrEqual(3);
    for (const cta of ctas) {
      mockPush.mockClear();
      expect(cta).toBeEnabled();
      await user.click(cta);
      expect(mockPush).toHaveBeenCalledWith(`/projects/${REQUEST_ID}/proposal/rel-1`);
    }
  });

  it("client + proposal_submitted: 'View proposal' is LIVE — pushes the review route + fires the funnel (A6.3)", async () => {
    const user = userEvent.setup();
    render(
      <ConversationStage
        requestId={REQUEST_ID}
        lens="client"
        requestStatus="proposal_submitted"
        view={view({ threads: [thread({ relationshipStatus: 'proposal_submitted' })] })}
      />
    );
    // Desktop header + mobile rail — both enabled now.
    const ctas = screen.getAllByRole('button', { name: 'View proposal' });
    expect(ctas.length).toBeGreaterThanOrEqual(2);
    for (const cta of ctas) {
      expect(cta).toBeEnabled();
      expect(cta).not.toHaveAttribute('aria-disabled');
    }

    const [headerCta] = ctas;
    await user.click(headerCta as HTMLElement);
    expect(mockTrack).toHaveBeenCalledWith(CONVERSATION_EVENTS.CONVERSATION_PROPOSAL_CTA_CLICKED, {
      request_id: REQUEST_ID,
      relationship_id: 'rel-1',
      surface: 'header',
    });
    expect(mockPush).toHaveBeenCalledWith(`/projects/${REQUEST_ID}/proposal/rel-1`);
    // It opens the review surface, never the client's request-proposal confirm beat.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockRequestProposal).not.toHaveBeenCalled();

    // The rail surface is tracked as 'rail'.
    const railCta = ctas.at(-1);
    await user.click(railCta as HTMLElement);
    expect(mockTrack).toHaveBeenCalledWith(
      CONVERSATION_EVENTS.CONVERSATION_PROPOSAL_CTA_CLICKED,
      expect.objectContaining({ surface: 'rail' })
    );
  });

  it("expert + proposal_submitted: 'View submitted' is LIVE — pushes the submitted route (A6.3)", async () => {
    const user = userEvent.setup();
    renderStage(
      view({ threads: [thread({ relationshipStatus: 'proposal_submitted' })] }),
      'expert'
    );
    const [headerCta] = screen.getAllByRole('button', { name: 'View submitted' });
    expect(headerCta).toBeDefined();
    expect(headerCta).toBeEnabled();
    await user.click(headerCta as HTMLElement);
    expect(mockPush).toHaveBeenCalledWith(`/projects/${REQUEST_ID}/proposal/rel-1`);
  });
});

describe('ConversationStage — realtime status chip', () => {
  it("shows the quiet 'Live updates paused' chip only when the connection failed", () => {
    realtimeCapture.status = 'failed';
    renderStage(view());
    expect(screen.getByText(/Live updates paused — refresh to catch up\./)).toBeInTheDocument();
  });

  it('renders no chip while connected', () => {
    renderStage(view());
    expect(screen.queryByText(/Live updates paused/)).not.toBeInTheDocument();
  });
});
