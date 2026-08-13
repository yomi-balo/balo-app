import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import userEvent from '@testing-library/user-event';
import { act, render, screen, waitFor } from '@/test/utils';
import { toast } from 'sonner';
import type { CaseConversationView } from '@/lib/cases/case-view-types';
import type {
  ConversationFileView,
  ConversationMessageView,
} from '@/lib/conversations/conversation-view-types';

/**
 * BAL-421 — the case's conversation region, with the CLOSED-case read-only contract as the
 * centrepiece.
 *
 * ⚠⚠ A CLOSED CASE IS READ-ONLY BUT FULLY READABLE, AND THOSE ARE TWO SEPARATE ASSERTIONS.
 * `writable` is composed ONCE at the gate from `engagementConversationIsWritable(status)`, and
 * `postCaseMessageAction` re-checks it server-side — so a component that merely HID the
 * composer while leaving history unreachable, or that left the composer mounted, would each be
 * a different failure. Both are tested below.
 */

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';
const CONVERSATION_ID = 'v0000000-0000-4000-8000-000000000002';
const VIEWER_ID = 'u0000000-0000-4000-8000-000000000003';

vi.mock('server-only', () => ({}));

vi.mock('motion/react', () => ({
  motion: {
    div: (props: Record<string, unknown>) => (
      <div className={props.className as string}>{props.children as React.ReactNode}</div>
    ),
  },
  useReducedMotion: () => true,
  AnimatePresence: (props: Record<string, unknown>) => <>{props.children as React.ReactNode}</>,
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// The realtime hook opens an Ably channel; nothing here is about transport.
const mockUseRealtime = vi.fn();
vi.mock('@/components/balo/conversation/use-conversation-realtime', () => ({
  useConversationRealtime: (...a: unknown[]) => mockUseRealtime(...a),
}));

// ⚠ EVERY ACTION IS AN ARROW OVER A REACHABLE `vi.fn()`, NOT A BARE `vi.fn()` IN THE FACTORY.
// A factory-local `vi.fn()` is unreachable from the test body, which is why every interactive
// callback on this panel went untested. The arrow defers the lookup to CALL time, so the
// `const` below is initialised long before it is read (a factory that closed over the const
// EAGERLY would hit the TDZ, because `vi.mock` is hoisted above these declarations).
const mockMarkRead = vi.fn();
const mockFetchThread = vi.fn();
const mockPostMessage = vi.fn();
const mockRequestUpload = vi.fn();
const mockConfirmUpload = vi.fn();
const mockGetDownload = vi.fn();

vi.mock('../_actions/create-case-realtime-token', () => ({
  createCaseRealtimeTokenAction: vi.fn(),
}));
vi.mock('../_actions/fetch-case-thread', () => ({
  fetchCaseThreadAction: (...a: unknown[]) => mockFetchThread(...a),
}));
vi.mock('../_actions/post-case-message', () => ({
  postCaseMessageAction: (...a: unknown[]) => mockPostMessage(...a),
}));
vi.mock('../_actions/mark-case-thread-read', () => ({
  markCaseThreadReadAction: (...a: unknown[]) => mockMarkRead(...a),
}));
vi.mock('../_actions/request-case-file-upload', () => ({
  requestCaseFileUploadAction: (...a: unknown[]) => mockRequestUpload(...a),
}));
vi.mock('../_actions/confirm-case-file-upload', () => ({
  confirmCaseFileUploadAction: (...a: unknown[]) => mockConfirmUpload(...a),
}));
vi.mock('../_actions/get-case-file-download', () => ({
  getCaseFileDownloadAction: (...a: unknown[]) => mockGetDownload(...a),
}));

import { CaseConversationPanel } from './case-conversation-panel';

/** The one message every render starts with, addressed by its rendered text below. */
const OPENING_TEXT = 'Here is the flow you asked about.';
const OPENING_ISO = '2026-07-01T10:00:00Z';

function messageView(
  id: string,
  over: Partial<ConversationMessageView> = {}
): ConversationMessageView {
  return {
    id,
    conversationId: CONVERSATION_ID,
    bodyHtml: `<p>Body of ${id}</p>`,
    senderUserId: 'u-other',
    senderName: 'Amara',
    createdAtIso: OPENING_ISO,
    ...over,
  };
}

function fileView(id: string, over: Partial<ConversationFileView> = {}): ConversationFileView {
  return {
    id,
    conversationId: CONVERSATION_ID,
    fileName: `${id}.pdf`,
    contentType: 'application/pdf',
    sizeBytes: 2048,
    uploadedByUserId: 'u-other',
    uploadedByName: 'Amara',
    createdAtIso: OPENING_ISO,
    ...over,
  };
}

function conversation(over: Partial<CaseConversationView> = {}): CaseConversationView {
  return {
    conversationId: CONVERSATION_ID,
    writable: true,
    counterpartyFirstName: 'Amara',
    counterpartyName: 'Amara Okafor',
    initialMessages: [messageView('msg-1', { bodyHtml: `<p>${OPENING_TEXT}</p>` })],
    initialHasEarlier: false,
    initialFiles: [],
    realtimeEnabled: false,
    ...over,
  };
}

function renderPanel(
  over: Partial<CaseConversationView> = {},
  lens: 'client' | 'expert' = 'client'
) {
  return render(
    <CaseConversationPanel
      engagementId={ENGAGEMENT_ID}
      conversation={conversation(over)}
      lens={lens}
      viewerUserId={VIEWER_ID}
    />
  );
}

type User = ReturnType<typeof userEvent.setup>;

/** Drive the REAL composer DOM — textarea by its aria-label role, then the send button. */
async function sendDraft(user: User, text: string): Promise<void> {
  await user.type(screen.getByRole('textbox'), text);
  await user.click(screen.getByRole('button', { name: 'Send message' }));
}

/** The composer's file input is `hidden` + `aria-hidden`, so it has no queryable role. */
async function pickFile(file: File): Promise<void> {
  const user = userEvent.setup({ applyAccept: false });
  const input = document.querySelector('input[type="file"]');
  expect(input).toBeInstanceOf(HTMLInputElement);
  await user.upload(input as HTMLInputElement, file);
}

async function clickLoadEarlier(user: User): Promise<void> {
  await user.click(screen.getByRole('button', { name: /Load earlier/ }));
}

/** The list's error state — the apostrophe is an HTML entity in the source. */
const LIST_ERROR = /Couldn.t load this conversation/;

/**
 * The two ways any of these Server Actions can fail, as ONE table. A `{ success: false }`
 * refusal and a thrown/rejected call travel different code paths in the component (the early
 * return vs. the `catch`), so both are driven — but they are asserted from a single body
 * rather than two near-identical `it`s.
 */
const REFUSAL_COPY = 'This case is no longer available.';

const FAILURE_MODES: ReadonlyArray<{ label: string; arm: (action: Mock) => void }> = [
  {
    label: 'refuses',
    arm: (action): void => {
      action.mockResolvedValueOnce({ success: false, error: REFUSAL_COPY });
    },
  },
  {
    label: 'throws',
    arm: (action): void => {
      action.mockRejectedValueOnce(new Error('offline'));
    },
  },
];

interface RealtimeArgs {
  enabled: boolean;
  conversationIds: string[];
  onMessage: (incoming: ConversationMessageView) => void;
  onFile: (incoming: ConversationFileView) => void;
}

/** The live handler pair the panel handed the (mocked) Ably hook on its latest render. */
function realtimeArgs(): RealtimeArgs {
  const [args] = mockUseRealtime.mock.calls.at(-1) ?? [];
  if (args === undefined) throw new Error('useConversationRealtime was never called');
  return args as RealtimeArgs;
}

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` clears CALLS but keeps implementations, so a resolved value set by one
  // test would otherwise leak into the next describe as a silent default.
  mockFetchThread.mockReset();
  mockPostMessage.mockReset();
  mockRequestUpload.mockReset();
  mockConfirmUpload.mockReset();
  mockGetDownload.mockReset();
  mockMarkRead.mockResolvedValue({ success: true });
});

describe('CaseConversationPanel — a CLOSED case is read-only but fully readable', () => {
  it('removes the composer entirely and says why', () => {
    renderPanel({ writable: false });
    expect(
      screen.getByText('This case is closed, so the conversation is read-only.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('STILL RENDERS THE HISTORY — read access and write access are separate questions', () => {
    renderPanel({ writable: false });
    expect(screen.getByText('Here is the flow you asked about.')).toBeInTheDocument();
  });

  it('offers no attach affordance on a closed case', () => {
    renderPanel({ writable: false });
    expect(screen.queryByRole('button', { name: /attach/i })).not.toBeInTheDocument();
  });

  it('drops the free-messages footnote — it invites an action the surface just refused', () => {
    renderPanel({ writable: false });
    expect(screen.queryByText(/Messages are free/i)).not.toBeInTheDocument();
  });

  it('renders the composer and the lens-appropriate footnote while OPEN', () => {
    const { unmount } = renderPanel({ writable: true }, 'client');
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(
      screen.getByText('Messages are free. Book a consultation when you need time on a call.')
    ).toBeInTheDocument();
    unmount();

    renderPanel({ writable: true }, 'expert');
    expect(
      screen.getByText('Messages are free and unbilled — only consultations are.')
    ).toBeInTheDocument();
  });
});

describe('CaseConversationPanel — the read watermark', () => {
  it('marks the thread read ONCE on mount — opening the case IS reading its thread', async () => {
    renderPanel();
    await waitFor(() => {
      expect(mockMarkRead).toHaveBeenCalledWith({ engagementId: ENGAGEMENT_ID });
    });
    expect(mockMarkRead).toHaveBeenCalledTimes(1);
  });

  it('swallows a watermark failure — it must never surface on a page just opened', async () => {
    mockMarkRead.mockRejectedValue(new Error('offline'));
    renderPanel();
    await waitFor(() => {
      expect(mockMarkRead).toHaveBeenCalled();
    });
    expect(screen.getByText('Here is the flow you asked about.')).toBeInTheDocument();
  });

  it('marks read on a CLOSED case too — a closed thread is still being read', async () => {
    renderPanel({ writable: false });
    await waitFor(() => {
      expect(mockMarkRead).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * ⚠⚠ THE ARRAY IDENTITY IS LOAD-BEARING. `conversationIds` is an effect dependency inside
 * `useConversationRealtime`, so a fresh literal on every render would tear down and
 * re-subscribe the Ably channel continuously — presenting as flapping connectivity rather than
 * as a bug. It is `useMemo`d (NOT a ref mutated during render, which React forbids and which
 * misbehaves under StrictMode's double render).
 */
describe('CaseConversationPanel — a stable conversationIds identity across re-renders', () => {
  it('hands the hook the SAME array instance when nothing changed', () => {
    const view = conversation();
    const { rerender } = render(
      <CaseConversationPanel
        engagementId={ENGAGEMENT_ID}
        conversation={view}
        lens="client"
        viewerUserId={VIEWER_ID}
      />
    );
    const first = mockUseRealtime.mock.calls.at(-1)?.[0] as { conversationIds: string[] };

    rerender(
      <CaseConversationPanel
        engagementId={ENGAGEMENT_ID}
        conversation={{ ...view }}
        lens="client"
        viewerUserId={VIEWER_ID}
      />
    );
    const second = mockUseRealtime.mock.calls.at(-1)?.[0] as { conversationIds: string[] };

    expect(second.conversationIds).toEqual([CONVERSATION_ID]);
    // Identity, not equality — an `toEqual` here would pass on a fresh literal every render.
    expect(second.conversationIds).toBe(first.conversationIds);
  });

  it('produces a NEW array when the conversation id genuinely changes', () => {
    const { rerender } = renderPanel();
    const first = mockUseRealtime.mock.calls.at(-1)?.[0] as { conversationIds: string[] };

    rerender(
      <CaseConversationPanel
        engagementId={ENGAGEMENT_ID}
        conversation={conversation({ conversationId: 'other-conversation' })}
        lens="client"
        viewerUserId={VIEWER_ID}
      />
    );
    const second = mockUseRealtime.mock.calls.at(-1)?.[0] as { conversationIds: string[] };

    expect(second.conversationIds).toEqual(['other-conversation']);
    expect(second.conversationIds).not.toBe(first.conversationIds);
  });

  it('passes the gate-composed realtimeEnabled straight through', () => {
    renderPanel({ realtimeEnabled: false });
    expect(mockUseRealtime).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });
});

/**
 * ⚠⚠ THE DRAFT IS THE ASSERTION THAT MATTERS HERE, NOT THE BUBBLE. `MessageComposer` is
 * CONTROLLED — it owns no draft state at all, and its `onSend` contract is "resolve `true` and
 * I will assume YOU cleared the draft; resolve `false` and the writer's text must survive".
 * A surface that toasted the error but ALSO dropped the text would lose a message the writer
 * cannot get back, which is why every failure arm below re-reads the textarea's value.
 */
describe('CaseConversationPanel — sending a message', () => {
  it('posts the trimmed body and appends the returned message', async () => {
    const user = userEvent.setup();
    // ⚠ The returned bodyHtml is deliberately NOT the typed string: the server sanitises the
    // plain text into HTML, and the bubble must render the RETURNED row, not an optimistic
    // echo of the draft. Distinct text also keeps this query off the textarea's own value.
    mockPostMessage.mockResolvedValue({
      success: true,
      message: messageView('msg-2', {
        senderUserId: VIEWER_ID,
        createdAtIso: '2026-07-01T11:00:00Z',
      }),
    });
    renderPanel();

    await sendDraft(user, 'Thanks for the walkthrough.');

    await waitFor(() =>
      expect(mockPostMessage).toHaveBeenCalledWith({
        engagementId: ENGAGEMENT_ID,
        body: 'Thanks for the walkthrough.',
      })
    );
    expect(await screen.findByText('Body of msg-2')).toBeInTheDocument();
  });

  /**
   * ⚠⚠ THE REGRESSION TEST FOR A REAL DEFECT THIS SUITE FOUND (BAL-421 coverage pass).
   * `handleSend` returned `true` on success but never called `setDraft('')`, and the composer
   * is CONTROLLED by that exact state — so the sent text stayed in the box with the send button
   * still enabled, and one more Enter posted it a SECOND time. `ConversationStage.handleSend`
   * (the sibling caller of the same leaf) always cleared its draft; the case panel did not.
   * Fixed in `case-conversation-panel.tsx`; this test is what stops it coming back.
   */
  it('clears the draft once the send succeeds', async () => {
    const user = userEvent.setup();
    mockPostMessage.mockResolvedValue({
      success: true,
      message: messageView('msg-2', { senderUserId: VIEWER_ID }),
    });
    renderPanel();

    await sendDraft(user, 'Thanks for the walkthrough.');

    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''));
  });

  it('KEEPS THE DRAFT and toasts verbatim when the action refuses', async () => {
    const user = userEvent.setup();
    mockPostMessage.mockResolvedValue({ success: false, error: 'This case is closed.' });
    renderPanel();

    await sendDraft(user, 'One more question.');

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('This case is closed.'));
    expect(screen.getByRole('textbox')).toHaveValue('One more question.');
    expect(screen.queryByText('Body of msg-2')).not.toBeInTheDocument();
  });

  it('KEEPS THE DRAFT and toasts the generic copy when the action throws', async () => {
    const user = userEvent.setup();
    mockPostMessage.mockRejectedValue(new Error('network down'));
    renderPanel();

    await sendDraft(user, 'One more question.');

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not send your message. Please try again.')
    );
    expect(screen.getByRole('textbox')).toHaveValue('One more question.');
  });

  it('does not append a message whose id is already in the thread', async () => {
    const user = userEvent.setup();
    // A realtime echo can land before the action resolves; the id is the dedupe key.
    mockPostMessage.mockResolvedValue({
      success: true,
      message: messageView('msg-1', { bodyHtml: `<p>${OPENING_TEXT}</p>` }),
    });
    renderPanel();

    await sendDraft(user, 'Anything');

    await waitFor(() => expect(mockPostMessage).toHaveBeenCalled());
    await waitFor(() => expect(screen.getAllByText(OPENING_TEXT)).toHaveLength(1));
  });
});

describe('CaseConversationPanel — "Load earlier" paging', () => {
  it('pages with the strict keyset cursor off the OLDEST loaded message', async () => {
    const user = userEvent.setup();
    mockFetchThread.mockResolvedValue({
      success: true,
      messages: [messageView('msg-0', { createdAtIso: '2026-06-30T09:00:00Z' })],
      hasEarlier: false,
    });
    renderPanel({ initialHasEarlier: true });

    await clickLoadEarlier(user);

    expect(mockFetchThread).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      before: { createdAtIso: OPENING_ISO, id: 'msg-1' },
      includeFiles: false,
    });
    expect(await screen.findByText('Body of msg-0')).toBeInTheDocument();
    // `hasEarlier: false` came back, so the control retires — the thread is fully loaded.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Load earlier/ })).not.toBeInTheDocument()
    );
  });

  it('keeps the control alive when the server says there is still more', async () => {
    const user = userEvent.setup();
    mockFetchThread.mockResolvedValue({
      success: true,
      messages: [messageView('msg-0', { createdAtIso: '2026-06-30T09:00:00Z' })],
      hasEarlier: true,
    });
    renderPanel({ initialHasEarlier: true });

    await clickLoadEarlier(user);

    expect(await screen.findByText('Body of msg-0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Load earlier/ })).toBeInTheDocument();
  });

  // Both arms land in the SAME place by design: a refusal and a transport failure are one
  // recoverable condition to the viewer, and neither is worth a toast — the inline retry IS
  // the message.
  it.each(FAILURE_MODES)(
    'drops the whole list into its error state when the page $label',
    async ({ arm }) => {
      const user = userEvent.setup();
      arm(mockFetchThread);
      renderPanel({ initialHasEarlier: true });

      await clickLoadEarlier(user);

      expect(await screen.findByText(LIST_ERROR)).toBeInTheDocument();
      expect(toast.error).not.toHaveBeenCalled();
    }
  );

  it('never calls the action when there is no message to page back from', () => {
    renderPanel({ initialMessages: [], initialHasEarlier: true });
    // An empty thread renders the invitation, not the pager — there is no cursor to send.
    expect(screen.queryByRole('button', { name: /Load earlier/ })).not.toBeInTheDocument();
    expect(mockFetchThread).not.toHaveBeenCalled();
  });
});

describe('CaseConversationPanel — retrying a failed thread load', () => {
  /** Reach the list's error state the only way a viewer can: a failed page. */
  async function failIntoErrorState(user: User): Promise<void> {
    mockFetchThread.mockResolvedValueOnce({ success: false, error: 'nope' });
    renderPanel({ initialHasEarlier: true, initialFiles: [fileView('stale')] });
    await clickLoadEarlier(user);
    expect(await screen.findByText(LIST_ERROR)).toBeInTheDocument();
  }

  it('refetches WITH files, replaces both collections, and returns to ready', async () => {
    const user = userEvent.setup();
    await failIntoErrorState(user);

    mockFetchThread.mockResolvedValueOnce({
      success: true,
      messages: [messageView('msg-9')],
      hasEarlier: false,
      files: [fileView('fresh')],
    });
    await user.click(screen.getByRole('button', { name: /Retry/ }));

    expect(mockFetchThread).toHaveBeenLastCalledWith({
      engagementId: ENGAGEMENT_ID,
      includeFiles: true,
    });
    expect(await screen.findByText('Body of msg-9')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fresh\.pdf/ })).toBeInTheDocument();
    // Replaced, not merged — the pre-error thread and its files are gone.
    expect(screen.queryByText(OPENING_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /stale\.pdf/ })).not.toBeInTheDocument();
    expect(screen.queryByText(LIST_ERROR)).not.toBeInTheDocument();
  });

  it('treats an omitted files array as an EMPTY one, not as "leave them alone"', async () => {
    const user = userEvent.setup();
    await failIntoErrorState(user);

    mockFetchThread.mockResolvedValueOnce({
      success: true,
      messages: [messageView('msg-9')],
      hasEarlier: false,
    });
    await user.click(screen.getByRole('button', { name: /Retry/ }));

    expect(await screen.findByText('Body of msg-9')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /stale\.pdf/ })).not.toBeInTheDocument();
  });

  it.each(FAILURE_MODES)('stays in the error state when the retry $label', async ({ arm }) => {
    const user = userEvent.setup();
    await failIntoErrorState(user);

    arm(mockFetchThread);
    await user.click(screen.getByRole('button', { name: /Retry/ }));

    // Two calls: the page that failed, then the retry that failed again.
    await waitFor(() => expect(mockFetchThread).toHaveBeenCalledTimes(2));
    expect(screen.getByText(LIST_ERROR)).toBeInTheDocument();
  });
});

/**
 * ⚠ THE PUT IS AN `XMLHttpRequest`, NOT `fetch`, BECAUSE THE COMPOSER RENDERS A PROGRESS
 * STRIP AND `fetch` STILL CANNOT REPORT UPLOAD PROGRESS. So the transport has to be stubbed at
 * the XHR seam — which also lets each arm of `putWithProgress` (2xx resolve, non-2xx reject,
 * `error` event reject) be driven independently of the two Server Actions around it.
 */
type ProgressListener = (event: ProgressEvent) => void;

let xhrOutcome: 'ok' | 'http-500' | 'transport-error' = 'ok';

class MockXhr {
  public status = 200;
  public readonly open = vi.fn();
  public readonly setRequestHeader = vi.fn();

  private readonly loadListeners: Array<() => void> = [];
  private readonly errorListeners: Array<() => void> = [];
  private readonly progressListeners: ProgressListener[] = [];

  public readonly upload = {
    addEventListener: (type: string, listener: ProgressListener): void => {
      if (type === 'progress') this.progressListeners.push(listener);
    },
  };

  public addEventListener(type: string, listener: () => void): void {
    if (type === 'load') this.loadListeners.push(listener);
    if (type === 'error') this.errorListeners.push(listener);
  }

  public send(): void {
    for (const listener of this.progressListeners) {
      listener({ lengthComputable: true, loaded: 64, total: 128 } as ProgressEvent);
    }
    if (xhrOutcome === 'transport-error') {
      for (const listener of this.errorListeners) listener();
      return;
    }
    this.status = xhrOutcome === 'http-500' ? 500 : 200;
    for (const listener of this.loadListeners) listener();
  }
}

describe('CaseConversationPanel — attaching a file (presign → PUT → confirm)', () => {
  const PDF = (): File => new File(['x'], 'scope.pdf', { type: 'application/pdf' });
  const KEY = 'conversation-files/c/u/k';
  const realXhr = globalThis.XMLHttpRequest;

  beforeEach(() => {
    xhrOutcome = 'ok';
    globalThis.XMLHttpRequest = MockXhr as unknown as typeof XMLHttpRequest;
    mockRequestUpload.mockResolvedValue({
      success: true,
      presignedUrl: 'https://signed.example/put',
      key: KEY,
    });
    mockConfirmUpload.mockResolvedValue({
      success: true,
      file: fileView('shared', { fileName: 'scope.pdf' }),
    });
  });

  afterEach(() => {
    globalThis.XMLHttpRequest = realXhr;
  });

  it('presigns, PUTs, confirms with the real file metadata, and shows the file', async () => {
    renderPanel();

    await pickFile(PDF());

    await waitFor(() =>
      expect(mockConfirmUpload).toHaveBeenCalledWith({
        engagementId: ENGAGEMENT_ID,
        key: KEY,
        fileName: 'scope.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      })
    );
    expect(mockRequestUpload).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      contentType: 'application/pdf',
      fileName: 'scope.pdf',
    });
    expect(await screen.findByRole('button', { name: /scope\.pdf/ })).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('File shared.');
  });

  it('stops at a presign refusal — it toasts verbatim and never confirms', async () => {
    mockRequestUpload.mockResolvedValue({
      success: false,
      error: 'This case is closed, so files cannot be shared.',
    });
    renderPanel();

    await pickFile(PDF());

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('This case is closed, so files cannot be shared.')
    );
    expect(mockConfirmUpload).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /scope\.pdf/ })).not.toBeInTheDocument();
  });

  it('toasts a confirm refusal verbatim and shows no file', async () => {
    mockConfirmUpload.mockResolvedValue({ success: false, error: 'That upload never landed.' });
    renderPanel();

    await pickFile(PDF());

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('That upload never landed.'));
    expect(screen.queryByRole('button', { name: /scope\.pdf/ })).not.toBeInTheDocument();
  });

  // `putWithProgress` rejects on BOTH a non-2xx response and an `error` event, so the caller's
  // `catch` is the only thing between a half-finished upload and a phantom confirmed row.
  it.each(['http-500', 'transport-error'] as const)(
    'maps a %s PUT to the generic copy and never confirms',
    async (outcome) => {
      xhrOutcome = outcome;
      renderPanel();

      await pickFile(PDF());

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith('Could not share your file. Please try again.')
      );
      expect(mockConfirmUpload).not.toHaveBeenCalled();
    }
  );

  it('ignores a confirmed file whose id is already on the thread', async () => {
    mockConfirmUpload.mockResolvedValue({
      success: true,
      file: fileView('already', { fileName: 'scope.pdf' }),
    });
    renderPanel({ initialFiles: [fileView('already', { fileName: 'scope.pdf' })] });

    await pickFile(PDF());

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('File shared.'));
    expect(screen.getAllByRole('button', { name: /scope\.pdf/ })).toHaveLength(1);
  });
});

/**
 * ⚠ jsdom's `Location` exposes `assign` as a NON-CONFIGURABLE own property, so it cannot be
 * spied. `window.location` ITSELF is configurable, so the whole object is swapped for the
 * duration of these tests and restored after — otherwise a real `assign` throws jsdom's
 * "Not implemented: navigation" and the success arm can only be asserted by absence.
 */
describe('CaseConversationPanel — downloading a file', () => {
  const realLocation = globalThis.location;
  let assign: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    assign = vi.fn();
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { href: realLocation.href, origin: realLocation.origin, assign },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: realLocation });
  });

  it('presigns with the conversation origin and navigates same-tab to the signed URL', async () => {
    const user = userEvent.setup();
    mockGetDownload.mockResolvedValue({ success: true, url: 'https://signed.example/get' });
    renderPanel({ initialFiles: [fileView('brief')] });

    await user.click(screen.getByRole('button', { name: /brief\.pdf/ }));

    await waitFor(() =>
      expect(mockGetDownload).toHaveBeenCalledWith({
        engagementId: ENGAGEMENT_ID,
        origin: 'conversation',
        fileId: 'brief',
      })
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://signed.example/get'));
  });

  // A refusal is surfaced VERBATIM (the action already chose the one non-enumerating copy);
  // a thrown call falls back to the generic line. Neither may navigate.
  it.each(
    FAILURE_MODES.map((mode) => ({
      ...mode,
      copy:
        mode.label === 'refuses' ? REFUSAL_COPY : 'Could not download this file. Please try again.',
    }))
  )('toasts and does NOT navigate when the presign $label', async ({ arm, copy }) => {
    const user = userEvent.setup();
    arm(mockGetDownload);
    renderPanel({ initialFiles: [fileView('brief')] });

    await user.click(screen.getByRole('button', { name: /brief\.pdf/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(copy));
    expect(assign).not.toHaveBeenCalled();
  });

  it('re-enables the row after the download settles', async () => {
    const user = userEvent.setup();
    mockGetDownload.mockResolvedValue({ success: true, url: 'https://signed.example/get' });
    renderPanel({ initialFiles: [fileView('brief')] });

    await user.click(screen.getByRole('button', { name: /brief\.pdf/ }));

    await waitFor(() => expect(screen.getByRole('button', { name: /brief\.pdf/ })).toBeEnabled());
  });
});

/**
 * ⚠ THE HOOK IS MOCKED, SO THE HANDLERS ARE READ BACK OFF ITS ARGUMENTS AND INVOKED DIRECTLY.
 * That is the only way to exercise the inbound half of the channel without an Ably transport,
 * and it is exactly what the panel would receive on a live `message` / `file` event.
 */
describe('CaseConversationPanel — realtime arrivals', () => {
  it('appends an incoming message AFTER the loaded thread', () => {
    renderPanel();
    const { onMessage } = realtimeArgs();

    act(() => {
      onMessage(
        messageView('msg-live', {
          bodyHtml: '<p>Just pushed the fix.</p>',
          createdAtIso: '2026-07-01T12:00:00Z',
        })
      );
    });

    const opening = screen.getByText(OPENING_TEXT);
    const arrival = screen.getByText('Just pushed the fix.');
    // Document order, not mere presence — an arrival rendered above the history would be wrong.
    const relation = opening.compareDocumentPosition(arrival);
    expect(relation & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
  });

  it('ignores an echo of a message already on the thread', () => {
    renderPanel();
    const { onMessage } = realtimeArgs();

    act(() => {
      onMessage(messageView('msg-1', { bodyHtml: `<p>${OPENING_TEXT}</p>` }));
    });

    expect(screen.getAllByText(OPENING_TEXT)).toHaveLength(1);
  });

  it('adds an incoming file to the thread', () => {
    renderPanel({ initialFiles: [fileView('brief')] });
    const { onFile } = realtimeArgs();

    act(() => {
      onFile(fileView('handover', { createdAtIso: '2026-07-01T12:00:00Z' }));
    });

    expect(screen.getByRole('button', { name: /handover\.pdf/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /brief\.pdf/ })).toBeInTheDocument();
  });

  it('ignores an echo of a file already on the thread', () => {
    renderPanel({ initialFiles: [fileView('brief')] });
    const { onFile } = realtimeArgs();

    act(() => {
      onFile(fileView('brief'));
    });

    expect(screen.getAllByRole('button', { name: /brief\.pdf/ })).toHaveLength(1);
  });

  it('keeps a realtime arrival on a CLOSED, read-only case — reading never stops', () => {
    renderPanel({ writable: false });
    const { onMessage } = realtimeArgs();

    act(() => {
      onMessage(
        messageView('msg-live', {
          bodyHtml: '<p>One last note.</p>',
          createdAtIso: '2026-07-01T12:00:00Z',
        })
      );
    });

    expect(screen.getByText('One last note.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
