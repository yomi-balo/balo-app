import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import type { ConversationMessageView } from '@/lib/conversations/conversation-view-types';
import type { MeetingFileView } from '@/lib/meetings/meeting-file-view-types';
import type {
  MeetingChatPanelActions,
  MeetingFilePanelActions,
} from '@/lib/meetings/meeting-panels';
import { ChatPanel } from './chat-panel';
import { mergeChatTimeline } from './chat-panel-list';
import type { MeetingRealtimeStatus } from './use-meeting-realtime';

/**
 * BAL-437 — the in-call Chat slot.
 *
 * ── ⚠⚠ WHAT THIS FILE HOLDS ──────────────────────────────────────────────────────────────
 *
 *   1. **ALL FOUR STATES**, and the empty one is an INVITATION — it must NOT contain
 *      "No messages yet".
 *   2. **REALTIME IS ORTHOGONAL TO THE FOUR.** Chat works entirely over HTTP; a dead transport
 *      degrades only the RECEIVE path and says so in ONE persistent line.
 *   3. **MERGE BY ID.** The sender's own row (appended from the action result) and the same row
 *      arriving back over Ably collapse to ONE bubble. Chat needs no nonce — the persisted row
 *      has a real id.
 *   4. **THE READ-ONLY COMPOSER** on a closed thread, with the SHIPPED case-surface sentence.
 *   5. **THE INLINE FILE ROW IS `source: 'chat'` ONLY**, and it is a link into Files, NOT a
 *      download control.
 */

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const VIEWER_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_ID = '22222222-3333-4444-8555-666666666666';
const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const CONVERSATION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const MEETING_PROPS = { meeting_id: MEETING_ID };

function message(overrides: Partial<ConversationMessageView> & { id: string }) {
  return {
    conversationId: CONVERSATION_ID,
    bodyHtml: '<p>Hello there</p>',
    senderUserId: OTHER_ID,
    senderName: 'Priya Raman',
    createdAtIso: '2026-08-14T09:00:00.000Z',
    ...overrides,
  } satisfies ConversationMessageView;
}

function file(overrides: Partial<MeetingFileView> & { id: string }): MeetingFileView {
  return {
    meetingId: MEETING_ID,
    fileName: 'cpq-rules.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1_400_000,
    party: 'client',
    source: 'chat',
    uploadedByUserId: VIEWER_ID,
    createdAtIso: '2026-08-14T09:05:00.000Z',
    ...overrides,
  };
}

interface Fakes {
  readonly chat: MeetingChatPanelActions;
  readonly files: MeetingFilePanelActions;
  readonly fetchThread: ReturnType<typeof vi.fn>;
  readonly postMessage: ReturnType<typeof vi.fn>;
  readonly list: ReturnType<typeof vi.fn>;
}

function fakes(
  options: {
    messages?: ConversationMessageView[];
    files?: MeetingFileView[];
    writable?: boolean;
    hasEarlier?: boolean;
    failThread?: boolean;
  } = {}
): Fakes {
  const fetchThread = vi.fn().mockResolvedValue(
    options.failThread === true
      ? { success: false, error: 'Could not load this conversation. Please try again.' }
      : {
          success: true,
          messages: options.messages ?? [],
          hasEarlier: options.hasEarlier ?? false,
          viewerUserId: VIEWER_ID,
          writable: options.writable ?? true,
        }
  );
  const postMessage = vi
    .fn()
    .mockResolvedValue({ success: true, message: message({ id: 'sent-1' }) });
  const list = vi.fn().mockResolvedValue({ success: true, files: options.files ?? [] });

  return {
    fetchThread,
    postMessage,
    list,
    chat: {
      fetchThread,
      postMessage,
      requestUpload: vi.fn(),
      confirmUpload: vi.fn(),
    } as unknown as MeetingChatPanelActions,
    files: {
      list,
      requestUpload: vi.fn(),
      confirmUpload: vi.fn(),
      download: vi.fn(),
    } as unknown as MeetingFilePanelActions,
  };
}

function renderPanel(
  fake: Fakes,
  overrides: {
    realtimeStatus?: MeetingRealtimeStatus;
    chatFeed?: ConversationMessageView[];
    fileFeed?: MeetingFileView[];
    onOpenFiles?: () => void;
  } = {}
): HTMLElement {
  return render(
    <ChatPanel
      chat={fake.chat}
      files={fake.files}
      onClose={vi.fn()}
      onOpenFiles={overrides.onOpenFiles ?? vi.fn()}
      realtimeStatus={overrides.realtimeStatus ?? 'connected'}
      chatFeed={overrides.chatFeed ?? []}
      fileFeed={overrides.fileFeed ?? []}
      meetingProps={MEETING_PROPS}
      onAnnounce={vi.fn()}
    />
  ).container;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ChatPanel — ⚠⚠ all four states', () => {
  it('LOADING: a skeleton, and no composer until the thread answers', () => {
    const fake = fakes();
    // Never resolve EITHER read — the loading state is the state before any answer, and a
    // resolving file list would settle after the assertion and warn about an unwrapped update.
    fake.fetchThread.mockReturnValue(new Promise(() => {}));
    fake.list.mockReturnValue(new Promise(() => {}));

    const container = renderPanel(fake);

    expect(container.querySelector('[data-testid="panel-skeleton"]')).toBeInTheDocument();
    expect(screen.queryByLabelText('Send message')).not.toBeInTheDocument();
  });

  it('ERROR: an error card whose Try again re-reads', async () => {
    const fake = fakes({ failThread: true });

    renderPanel(fake);

    await screen.findByTestId('panel-error');
    expect(screen.getByText(/couldn't load the conversation/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(fake.fetchThread).toHaveBeenCalledTimes(2);
  });

  it('⚠⚠ ERROR: THE COMPOSER IS STILL THERE — the card says "carry on talking", so it must be', async () => {
    /**
     * ⚠⚠ THE DEFECT THIS PINS. The footer used to gate on `thread === null`, and a failed read
     * leaves `thread` null for ever — so the error state had NO composer while its own body
     * told the person to carry on talking. Reading the thread and posting to it are separate
     * questions with separate gates; a failed READ must not confiscate the WRITE.
     */
    renderPanel(fakes({ failThread: true }));

    await screen.findByTestId('panel-error');
    expect(screen.getByLabelText('Send message')).toBeInTheDocument();
    expect(screen.getByLabelText(/message everyone in the call/i)).toBeInTheDocument();
  });

  it('⚠ ERROR: a failed read does NOT assume read-only — the server is the authority', async () => {
    renderPanel(fakes({ failThread: true }));

    await screen.findByTestId('panel-error');
    // Assuming read-only would silently remove the composer from everyone whose read timed out.
    expect(
      screen.queryByText('This case is closed, so the conversation is read-only.')
    ).not.toBeInTheDocument();
  });

  it('⚠ Try again shows the SKELETON while it re-reads — a pressed button must look pressed', async () => {
    const fake = fakes({ failThread: true });
    const container = renderPanel(fake);

    await screen.findByTestId('panel-error');
    // A retry that never settles: the panel must be in its loading state, not still in error.
    fake.fetchThread.mockReturnValue(new Promise(() => {}));
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(container.querySelector('[data-testid="panel-skeleton"]')).toBeInTheDocument();
    expect(screen.queryByTestId('panel-error')).not.toBeInTheDocument();
  });

  it('⚠⚠ EMPTY: an INVITATION — and it does NOT say "No messages yet"', async () => {
    renderPanel(fakes());

    const invitation = await screen.findByText(/say hello/i);
    expect(invitation).toBeInTheDocument();
    expect(screen.queryByText(/no messages yet/i)).not.toBeInTheDocument();
  });

  it('⚠⚠ EMPTY + READ-ONLY: a RETROSPECTIVE line, never an invitation to a refused action', async () => {
    // The invitation would point at a composer replaced by "this conversation is read-only"
    // directly beneath it. CLAUDE.md's empty-state rule is conditional on being able to act.
    renderPanel(fakes({ writable: false }));

    expect(await screen.findByText(/nothing was said in this conversation/i)).toBeInTheDocument();
    expect(screen.queryByText(/say hello/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no messages yet/i)).not.toBeInTheDocument();
  });

  it('THREAD: renders the messages, with own-vs-other attribution', async () => {
    renderPanel(
      fakes({
        messages: [
          message({ id: 'm1', senderUserId: OTHER_ID, senderName: 'Priya Raman' }),
          message({ id: 'm2', senderUserId: VIEWER_ID, bodyHtml: '<p>On it</p>' }),
        ],
      })
    );

    expect(await screen.findByText('Priya Raman')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('On it')).toBeInTheDocument();
  });
});

describe('ChatPanel — ⚠ the realtime line is ORTHOGONAL to the four states', () => {
  it('`disabled` ⇒ a persistent "live updates are off" line, and the composer still works', async () => {
    renderPanel(fakes(), { realtimeStatus: 'disabled' });

    expect(await screen.findByText(/live updates are off/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Send message')).toBeInTheDocument();
  });

  it('⚠ `failed` ⇒ what still works AND what to DO about it', async () => {
    renderPanel(fakes(), { realtimeStatus: 'failed' });

    const line = await screen.findByText(/live updates are unavailable/i);
    expect(line).toHaveTextContent(/your messages still send/i);
    // ⚠⚠ A STATUS LINE WITH NO ACTION LEAVES THE PERSON HOLDING IT — they cannot tell whether
    // to wait, reload, or give up on chat for the rest of the call. Name the one thing that
    // actually recovers the receive path.
    expect(line).toHaveTextContent(/reopen this panel/i);
  });

  it('⚠⚠ `connecting` (FIRST connect) does NOT say "Reconnecting"', async () => {
    // Telling somebody in their first second on a call that we are RE-connecting claims
    // something already broke.
    renderPanel(fakes(), { realtimeStatus: 'connecting' });

    expect(await screen.findByText(/connecting live updates/i)).toBeInTheDocument();
    expect(screen.queryByText(/^reconnecting/i)).not.toBeInTheDocument();
  });

  it('⚠⚠ `reconnecting` (a drop AFTER a connect) is the one that says "Reconnecting…"', async () => {
    renderPanel(fakes(), { realtimeStatus: 'reconnecting' });

    expect(await screen.findByText(/^reconnecting/i)).toBeInTheDocument();
  });

  it('`connected` ⇒ NO line at all — a healthy transport says nothing', async () => {
    renderPanel(fakes(), { realtimeStatus: 'connected' });

    await screen.findByText(/say hello/i);
    expect(screen.queryByText(/live updates/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/connecting/i)).not.toBeInTheDocument();
  });
});

describe('ChatPanel — ⚠⚠ "Show earlier messages" (nothing tested this at all)', () => {
  /** Two pages: the loaded one, and the older page the button fetches. */
  function pagedFakes(): Fakes {
    const fake = fakes({
      messages: [message({ id: 'newest', createdAtIso: '2026-08-14T09:00:00.000Z' })],
      hasEarlier: true,
    });
    fake.fetchThread.mockImplementation((before?: { createdAtIso: string; id: string }) =>
      Promise.resolve(
        before === undefined
          ? {
              success: true,
              messages: [message({ id: 'newest', createdAtIso: '2026-08-14T09:00:00.000Z' })],
              hasEarlier: true,
              viewerUserId: VIEWER_ID,
              writable: true,
            }
          : {
              success: true,
              messages: [
                message({
                  id: 'older',
                  bodyHtml: '<p>Said earlier</p>',
                  createdAtIso: '2026-08-14T08:00:00.000Z',
                }),
              ],
              hasEarlier: false,
              viewerUserId: VIEWER_ID,
              writable: true,
            }
      )
    );
    return fake;
  }

  it('⚠⚠ pages from the OLDEST loaded message — the cursor, asserted', async () => {
    // ⚠ `fakes()` has threaded `hasEarlier` since day one and NO test ever passed it, so the
    // whole control was unexercised. Paging from the NEWEST message would re-fetch the page
    // already on screen for ever.
    const fake = pagedFakes();
    renderPanel(fake);

    await userEvent.click(await screen.findByRole('button', { name: /show earlier messages/i }));

    await waitFor(() => expect(fake.fetchThread).toHaveBeenCalledTimes(2));
    expect(fake.fetchThread).toHaveBeenLastCalledWith({
      createdAtIso: '2026-08-14T09:00:00.000Z',
      id: 'newest',
    });
  });

  it('⚠⚠ PREPENDS the older page — it lands ABOVE what was already on screen', async () => {
    const container = renderPanel(pagedFakes());

    await userEvent.click(await screen.findByRole('button', { name: /show earlier messages/i }));

    await screen.findByText('Said earlier');
    const bodies = [...container.querySelectorAll('p')].map((node) => node.textContent);
    expect(bodies.indexOf('Said earlier')).toBeLessThan(bodies.indexOf('Hello there'));
  });

  it('⚠ the button disappears once the server says there is nothing earlier', async () => {
    renderPanel(pagedFakes());

    await userEvent.click(await screen.findByRole('button', { name: /show earlier messages/i }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /show earlier messages/i })).toBeNull()
    );
  });

  it('⚠ a FAILED page says so inline, instead of a button that visibly does nothing', async () => {
    const fake = pagedFakes();
    fake.fetchThread.mockImplementationOnce(() =>
      Promise.resolve({
        success: true,
        messages: [message({ id: 'newest' })],
        hasEarlier: true,
        viewerUserId: VIEWER_ID,
        writable: true,
      })
    );
    fake.fetchThread.mockImplementationOnce(() =>
      Promise.resolve({ success: false, error: 'Could not load this conversation.' })
    );
    renderPanel(fake);

    await userEvent.click(await screen.findByRole('button', { name: /show earlier messages/i }));

    expect(await screen.findByText(/couldn't load the earlier messages/i)).toBeInTheDocument();
    // ⚠ AND THE THREAD SURVIVES — a failed PAGE is not a failed panel.
    expect(screen.getByText('Hello there')).toBeInTheDocument();
    expect(screen.queryByTestId('panel-error')).not.toBeInTheDocument();
  });
});

describe('ChatPanel — ⚠⚠ the merge is BY ID', () => {
  it('a realtime message appears once', async () => {
    renderPanel(fakes(), { chatFeed: [message({ id: 'live-1', bodyHtml: '<p>Live one</p>' })] });

    await waitFor(() => expect(screen.getAllByText('Live one')).toHaveLength(1));
  });

  it('⚠⚠ the sender’s OWN echo does NOT duplicate their row', async () => {
    const own = message({ id: 'dup-1', senderUserId: VIEWER_ID, bodyHtml: '<p>Only once</p>' });

    // The same id in BOTH the fetched page and the realtime feed — exactly what happens when
    // the action result and the Ably echo both arrive.
    renderPanel(fakes({ messages: [own] }), { chatFeed: [own] });

    await waitFor(() => expect(screen.getAllByText('Only once')).toHaveLength(1));
  });
});

describe('ChatPanel — the composer', () => {
  it('sends the trimmed draft and clears it on success', async () => {
    const fake = fakes();
    renderPanel(fake);

    const box = await screen.findByLabelText(/message everyone in the call/i);
    await userEvent.type(box, '  Hello team  ');
    await userEvent.click(screen.getByLabelText('Send message'));

    await waitFor(() => expect(fake.postMessage).toHaveBeenCalledWith('Hello team'));
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('⚠ the draft SURVIVES a failed send — it is the only copy of what they typed', async () => {
    const fake = fakes();
    fake.postMessage.mockResolvedValue({ success: false, error: 'Type a message first.' });
    renderPanel(fake);

    const box = await screen.findByLabelText(/message everyone in the call/i);
    await userEvent.type(box, 'Kept');
    await userEvent.click(screen.getByLabelText('Send message'));

    await waitFor(() => expect(fake.postMessage).toHaveBeenCalled());
    expect(box).toHaveValue('Kept');
  });

  it('⚠⚠ READ-ONLY on a closed thread — the SHIPPED case-surface sentence, no composer', async () => {
    renderPanel(fakes({ writable: false }));

    expect(
      await screen.findByText('This case is closed, so the conversation is read-only.')
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Send message')).not.toBeInTheDocument();
  });
});

describe('ChatPanel — ⚠⚠ the inline file row is a VIEW over meeting_files', () => {
  it('renders a `source: "chat"` file with its name and size', async () => {
    renderPanel(fakes({ files: [file({ id: 'f1', fileName: 'deck.pdf' })] }));

    expect(await screen.findByText('deck.pdf')).toBeInTheDocument();
  });

  it('⚠⚠ does NOT render a `source: "files_tab"` file — that was not SAID in the conversation', async () => {
    renderPanel(
      fakes({ files: [file({ id: 'f2', fileName: 'dropped.pdf', source: 'files_tab' })] })
    );

    await screen.findByText(/say hello/i);
    expect(screen.queryByText('dropped.pdf')).not.toBeInTheDocument();
  });

  it('⚠⚠ its control is "View in Files", NOT a download — one download path, one gate', async () => {
    const onOpenFiles = vi.fn();
    renderPanel(fakes({ files: [file({ id: 'f3', fileName: 'notes.pdf' })] }), { onOpenFiles });

    const control = await screen.findByRole('button', { name: /view notes\.pdf in files/i });
    expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument();

    await userEvent.click(control);
    expect(onOpenFiles).toHaveBeenCalledTimes(1);
  });

  it('⚠ a realtime file event prepends a chat row without a second read', async () => {
    const fake = fakes();
    renderPanel(fake, { fileFeed: [file({ id: 'f4', fileName: 'live.pdf' })] });

    expect(await screen.findByText('live.pdf')).toBeInTheDocument();
    expect(fake.list).toHaveBeenCalledTimes(1);
  });
});

describe('mergeChatTimeline — ⚠ deterministic ordering', () => {
  it('sorts by created_at ascending', () => {
    const items = mergeChatTimeline(
      [
        message({ id: 'later', createdAtIso: '2026-08-14T10:00:00.000Z' }),
        message({ id: 'earlier', createdAtIso: '2026-08-14T09:00:00.000Z' }),
      ],
      []
    );

    expect(items.map((item) => (item.kind === 'message' ? item.message.id : ''))).toEqual([
      'earlier',
      'later',
    ]);
  });

  it('⚠⚠ a FILE sorts AFTER a message sharing its exact instant — stable, so tests are not flaky', () => {
    const at = '2026-08-14T09:00:00.000Z';
    const items = mergeChatTimeline(
      [message({ id: 'm', createdAtIso: at })],
      [file({ id: 'f', createdAtIso: at })]
    );

    expect(items.map((item) => item.kind)).toEqual(['message', 'file']);
  });

  it('filters `files_tab` out at the merge, not at the render', () => {
    const items = mergeChatTimeline(
      [],
      [file({ id: 'a', source: 'chat' }), file({ id: 'b', source: 'files_tab' })]
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.kind === 'file' ? items[0].file.id : '').toBe('a');
  });
});

describe('ChatPanel — accessibility', () => {
  it('has no violations with a thread and a live composer', async () => {
    const container = renderPanel(
      fakes({ messages: [message({ id: 'm1' })], files: [file({ id: 'f1' })] })
    );

    await screen.findByText('Priya Raman');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations in the read-only state', async () => {
    const container = renderPanel(fakes({ writable: false }));

    await screen.findByText(/read-only/i);
    expect(await axe(container)).toHaveNoViolations();
  });
});
