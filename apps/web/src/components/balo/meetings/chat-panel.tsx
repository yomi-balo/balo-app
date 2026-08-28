'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { MEETING_PANEL_EVENTS, track } from '@/lib/analytics';
import type { ConversationMessageView } from '@/lib/conversations/conversation-view-types';
import type { MeetingFileView } from '@/lib/meetings/meeting-file-view-types';
import type {
  MeetingChatPanelActions,
  MeetingFilePanelActions,
} from '@/lib/meetings/meeting-panels';
import { MeetingSidePanel } from './meeting-side-panel';
import { ChatComposer } from './chat-composer';
import { mergeChatTimeline } from './chat-panel-list';
import type { MeetingRealtimeStatus } from './use-meeting-realtime';
import { ChatThreadBody } from './chat-thread-body';
export { ChatThreadBody, type ChatThreadBodyProps } from './chat-thread-body';

/**
 * BAL-437 — the in-call Chat slot.
 *
 * ── ⚠⚠ IT WRITES INTO THE **ENGAGEMENT'S** THREAD, NOT A PER-CALL ROOM ──────────────────
 *
 * A participant opening this panel sees the whole engagement conversation — the same thread the
 * dashboard case surface renders — with each in-call message additionally stamped
 * `sent_during_meeting_id`. There is no per-meeting conversation and there must never be one:
 * BAL-424's context seam is 1:1 precisely so "two threads for one case" is unrepresentable.
 *
 * ── ⚠⚠ THE GUEST SEAM — BAL-445 OPENED READ-ONLY, THIS COMPONENT IS MEMBER-ONLY ──────────
 *
 * A guest now gets a READ-ONLY transcript, rendered by the SEPARATE `GuestChatPanel` component
 * (`guest-chat-panel.tsx`) — never by this one. This component keeps its `MeetingChatPanelActions`
 * (`postMessage`, `requestUpload`, `confirmUpload`) and is reached ONLY through the member
 * mount's `panels.audience === 'member'` arm in `meeting-frame-impl.tsx`'s `FramePanel`. The
 * two panels share the read-only list rendering via `ChatThreadBody` (now its own module,
 * `chat-thread-body.tsx`, re-exported here — see that file's docblock for why: importing it
 * FROM this file would drag `ChatComposer` and `useMeetingFileUpload` into the guest bundle),
 * so the two components cannot drift on skeleton / error / empty / row logic.
 *
 * `conversation_messages.sender_user_id` is STILL `notNull` with an FK to `users.id` — a guest
 * still **cannot author a message at all** without a migration. That is the one remaining
 * block, and it is slice 4's (a split-out ticket, guest authorship). ⚠ Do NOT call
 * `guestMayReadMeeting` here — it is called from the GATE (`meeting-chat-anchor.ts`), never
 * from a component.
 *
 * ── ⚠ THE FOUR STATES, AND THE FIFTH LINE THAT IS NOT A STATE ───────────────────────────
 *
 * Skeleton / error+retry / INVITATION empty / thread. The realtime line is orthogonal to all
 * four: chat works entirely over HTTP, so a dead transport degrades the RECEIVE path only and
 * is said in one persistent line rather than by disabling anything.
 *
 * ⚠⚠ **THE COMPOSER IS PRESENT IN THREE OF THE FOUR** — everything except the skeleton, and
 * that includes the ERROR state. Reading the thread and posting to it are separate questions
 * with separate gates; a failed READ must not confiscate the WRITE, least of all under an error
 * card that says "carry on talking". See the footer's docblock.
 *
 * ⚠ THE EMPTY STATE IS AN INVITATION, NEVER "No messages yet" — unless the thread is READ-ONLY,
 * where an invitation would point at a composer that refuses. See {@link EmptyThreadLine}.
 */

/**
 * ⚠ Live-transport copy. Each says what still works, because everything still does.
 *
 * ⚠⚠ THE FAILED LINE ENDS WITH SOMETHING TO **DO**. "Live updates are unavailable" on its own
 * states a fact and leaves the person holding it: they cannot tell whether to sit and wait,
 * reload, or give up on chat for the rest of the call. Naming the one action that actually
 * recovers it — reopening the panel re-reads the thread over HTTP — turns a status line into an
 * instruction.
 *
 * ⚠⚠ `connecting` AND `reconnecting` ARE **TWO DIFFERENT SENTENCES**, because they are two
 * different facts. Everybody used to be told "Reconnecting…" during their first second on the
 * call, before there had ever been a connection to re-establish — which reads as "something
 * already broke" on a surface where the person is simultaneously working out whether their
 * camera is on. See `MeetingRealtimeStatus`.
 */
const REALTIME_OFF_LINE = 'Live updates are off — reopen this panel to see new messages.';
const REALTIME_FAILED_LINE =
  'Live updates are unavailable. Your messages still send — reopen this panel to pull in anything you missed.';
const REALTIME_CONNECTING_LINE = 'Connecting live updates…';
const REALTIME_RECONNECTING_LINE = 'Reconnecting…';

export interface ChatPanelProps {
  readonly chat: MeetingChatPanelActions;
  /** ⚠ READ-ONLY USE: the chat timeline's inline rows are a VIEW over the Files panel's list. */
  readonly files: MeetingFilePanelActions;
  readonly onClose: () => void;
  /** Opens the Files slot. The panel is single-slot, so this is a swap. */
  readonly onOpenFiles: () => void;
  readonly realtimeStatus: MeetingRealtimeStatus;
  /** Inbound messages buffered by the frame while this panel was unmounted. */
  readonly chatFeed: readonly ConversationMessageView[];
  /** Inbound `meeting_files` rows, same buffering. Filtered to `source: 'chat'` on render. */
  readonly fileFeed: readonly MeetingFileView[];
  readonly meetingProps: Readonly<{ meeting_id?: string }>;
  readonly onAnnounce: (message: string) => void;
}

/**
 * The empty base for the merge when no page has loaded.
 *
 * ⚠ A MODULE CONSTANT so the `useMemo` below does not see a fresh `[]` on every render.
 *
 * ⚠⚠ IT IS **NOT** WHAT KEEPS THE COMPOSER ALIVE IN THE ERROR STATE, and an earlier version of
 * this comment claimed it was ("a null-object fallback so a failed thread read still renders a
 * usable composer state"). It never did: the footer gated on `thread === null`, which a failed
 * read never leaves. The composer's real gate is `isLoading` — see the footer's own docblock.
 */
const NO_MESSAGES: readonly ConversationMessageView[] = [];

interface ThreadState {
  readonly messages: readonly ConversationMessageView[];
  readonly hasEarlier: boolean;
  readonly viewerUserId: string;
  readonly writable: boolean;
}

/**
 * The thread read + its paging.
 *
 * ⚠ EXTRACTED SO `ChatPanel`'s OWN BODY STAYS UNDER SonarCloud's COGNITIVE-COMPLEXITY LIMIT of
 * 15 — the repo's precedent is to extract, never to disable the rule.
 */
function useChatThread(chat: MeetingChatPanelActions): {
  thread: ThreadState | null;
  hasFailed: boolean;
  isLoading: boolean;
  isLoadingEarlier: boolean;
  earlierFailed: boolean;
  load: () => Promise<void>;
  loadEarlier: () => void;
  appendLocal: (message: ConversationMessageView) => void;
} {
  const [thread, setThread] = useState<ThreadState | null>(null);
  const [hasFailed, setHasFailed] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);
  const [earlierFailed, setEarlierFailed] = useState(false);
  const isMountedRef = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    // ⚠⚠ CLEAR THE FAILURE AND ARM THE SPINNER **BEFORE** THE AWAIT. Without this, pressing
    // "Try again" left the error card sitting there, unchanged, for the whole round trip — so
    // the only feedback for the press was nothing at all, and people press it again.
    setHasFailed(false);
    setIsLoading(true);
    const result = await chat.fetchThread();
    if (!isMountedRef.current) return;
    setIsLoading(false);
    if (!result.success) {
      setHasFailed(true);
      return;
    }
    setThread({
      messages: result.messages,
      hasEarlier: result.hasEarlier,
      viewerUserId: result.viewerUserId,
      writable: result.writable,
    });
  }, [chat]);

  useEffect(() => {
    isMountedRef.current = true;
    void load();
    return () => {
      isMountedRef.current = false;
    };
  }, [load]);

  const loadEarlier = useCallback((): void => {
    const [oldest] = thread?.messages ?? [];
    if (oldest === undefined || isLoadingEarlier) return;
    setIsLoadingEarlier(true);
    setEarlierFailed(false);
    void chat
      // ⚠⚠ THE CURSOR IS THE **OLDEST** LOADED MESSAGE. The timeline is ascending, so `[0]` is
      // the oldest — paging back from the newest would re-fetch the page already on screen for
      // ever. `fetchMeetingThreadAction`'s keyset is strict `(created_at, id) <`.
      .fetchThread({ createdAtIso: oldest.createdAtIso, id: oldest.id })
      .then((result) => {
        if (!isMountedRef.current) return;
        if (!result.success) {
          // ⚠ AN INLINE LINE, NOT SILENCE. Returning here used to leave the button looking
          // untouched — a control that visibly does nothing reads as broken, not as failed.
          setEarlierFailed(true);
          return;
        }
        setThread((current) =>
          current === null
            ? current
            : // ⚠ PREPEND. The page is older than everything already held, and the merge
              // below dedupes by id anyway.
              {
                ...current,
                messages: [...result.messages, ...current.messages],
                hasEarlier: result.hasEarlier,
              }
        );
      })
      .finally(() => {
        if (isMountedRef.current) setIsLoadingEarlier(false);
      });
  }, [chat, thread, isLoadingEarlier]);

  const appendLocal = useCallback((message: ConversationMessageView): void => {
    setThread((current) =>
      current === null || current.messages.some((item) => item.id === message.id)
        ? current
        : { ...current, messages: [...current.messages, message] }
    );
  }, []);

  return {
    thread,
    hasFailed,
    isLoading,
    isLoadingEarlier,
    earlierFailed,
    load,
    loadEarlier,
    appendLocal,
  };
}

/**
 * The chat-shared file rows.
 *
 * ⚠ IT READS THE **FILES PANEL'S** ACTION AND FILTERS CLIENT-SIDE. There is deliberately no
 * chat-scoped list action: one read, one authorization path, one store. A failure here is
 * SILENT — the thread is the point of this panel and an unavailable file row is not worth an
 * error card over a live conversation.
 */
function useChatFiles(
  files: MeetingFilePanelActions,
  fileFeed: readonly MeetingFileView[]
): { chatFiles: readonly MeetingFileView[]; addLocal: (file: MeetingFileView) => void } {
  const [loaded, setLoaded] = useState<readonly MeetingFileView[]>([]);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    void files.list().then((result) => {
      if (isMountedRef.current && result.success) setLoaded(result.files);
    });
    return () => {
      isMountedRef.current = false;
    };
  }, [files]);

  const addLocal = useCallback((file: MeetingFileView): void => {
    setLoaded((current) =>
      current.some((item) => item.id === file.id) ? current : [...current, file]
    );
  }, []);

  // ⚠ MERGED BY ID, so the sharer's own optimistic row and the Ably echo collapse into one.
  const chatFiles = useMemo(() => {
    const byId = new Map(loaded.map((file) => [file.id, file]));
    for (const file of fileFeed) byId.set(file.id, file);
    return [...byId.values()];
  }, [loaded, fileFeed]);

  return { chatFiles, addLocal };
}

/**
 * The persistent transport line, or `null` when the transport is healthy.
 *
 * ⚠ A LOOKUP, NOT A TERNARY CHAIN — five states is well past where a chained `?:` stops being
 * readable, and SonarCloud reads nested ternaries as a defect anyway.
 */
const REALTIME_LINES: Readonly<Record<MeetingRealtimeStatus, string | null>> = {
  disabled: REALTIME_OFF_LINE,
  failed: REALTIME_FAILED_LINE,
  connecting: REALTIME_CONNECTING_LINE,
  reconnecting: REALTIME_RECONNECTING_LINE,
  /** ⚠ A HEALTHY TRANSPORT SAYS NOTHING. Silence is the success state. */
  connected: null,
};

function realtimeLineFor(status: MeetingRealtimeStatus): string | null {
  return REALTIME_LINES[status];
}

/**
 * The empty thread.
 *
 * ⚠⚠ CLAUDE.md's EMPTY-STATE RULE IS **CONDITIONAL ON BEING ABLE TO ACT**, and an earlier
 * version applied only its first half. "Say hello, or drop in a link" is the right copy for
 * somebody who has a composer; shown on a CLOSED case's read-only thread it invites an action
 * the very next element refuses — the composer is replaced by "this conversation is read-only"
 * directly underneath it. So the writable arm is an INVITATION and the read-only arm is
 * RETROSPECTIVE: it reports a fact about a thread that is finished, which is exactly the
 * carve-out the rule makes for data the person cannot act on.
 *
 * ⚠ NEITHER ARM SAYS "No messages yet".
 */
function EmptyThreadLine({ writable }: Readonly<{ writable: boolean }>): React.JSX.Element {
  return (
    <p className="text-muted-foreground px-4 py-6 text-center text-sm leading-relaxed">
      {writable
        ? 'Say hello, or drop in a link everyone should see.'
        : 'Nothing was said in this conversation.'}
    </p>
  );
}

export function ChatPanel({
  chat,
  files,
  onClose,
  onOpenFiles,
  realtimeStatus,
  chatFeed,
  fileFeed,
  meetingProps,
  onAnnounce,
}: Readonly<ChatPanelProps>): React.JSX.Element {
  const {
    thread,
    hasFailed,
    isLoading,
    isLoadingEarlier,
    earlierFailed,
    load,
    loadEarlier,
    appendLocal,
  } = useChatThread(chat);
  const { chatFiles, addLocal } = useChatFiles(files, fileFeed);

  /** ⚠ Toast **and** the frame's one §16 live region, in one call. Same sentence in both. */
  const report = useCallback(
    (kind: 'success' | 'info' | 'error', message: string): void => {
      toast[kind](message);
      onAnnounce(message);
    },
    [onAnnounce]
  );

  const onSend = useCallback(
    async (body: string): Promise<boolean> => {
      const result = await chat.postMessage(body);
      if (!result.success) {
        // ⚠ `rejected` vs `failed` — a validation refusal the person can fix is not an outage.
        const isRejection = result.error !== 'Could not send your message. Please try again.';
        track(MEETING_PANEL_EVENTS.MESSAGE_SENT, {
          ...meetingProps,
          outcome: isRejection ? 'rejected' : 'failed',
        });
        report('error', result.error);
        return false;
      }
      // The sender's own row, appended from the ACTION RESULT rather than waiting on Ably —
      // which is also why the panel merges by id: the echo collapses onto this row.
      appendLocal(result.message);
      track(MEETING_PANEL_EVENTS.MESSAGE_SENT, { ...meetingProps, outcome: 'ok' });
      return true;
    },
    [chat, meetingProps, appendLocal, report]
  );

  // ⚠ MERGED BY **ID**, not by arrival. The optimistic row and the realtime row for the same
  // message collapse to one — chat needs no nonce because the persisted row has a real id.
  const messages = useMemo(() => {
    const base = thread?.messages ?? NO_MESSAGES;
    const byId = new Map(base.map((message) => [message.id, message]));
    for (const message of chatFeed) {
      if (!byId.has(message.id)) byId.set(message.id, message);
    }
    return [...byId.values()];
  }, [thread, chatFeed]);

  const items = useMemo(() => mergeChatTimeline(messages, chatFiles), [messages, chatFiles]);
  const realtimeLine = realtimeLineFor(realtimeStatus);

  return (
    <MeetingSidePanel
      title="Chat"
      onClose={onClose}
      footer={
        /**
         * ⚠⚠ THE COMPOSER IS GATED ON **LOADING ONLY**, NEVER ON `thread === null`.
         *
         * A failed read leaves `thread` null for ever (`load` sets `hasFailed` and returns), so
         * gating on it meant the ERROR STATE HAD NO COMPOSER — while the error card's own body
         * said *"carry on talking — nothing is lost"*. It was an instruction to use a control
         * that was not on screen. Sending is a WRITE and does not depend on the read having
         * succeeded: `postMeetingMessageAction` re-runs the whole gate itself.
         *
         * ⚠ `writable` FALLS BACK TO `true` WHEN THE THREAD IS UNKNOWN, and that is deliberate
         * rather than optimistic. The server is the authority: a post into a closed thread is
         * refused with the exact read-only sentence, which the panel surfaces as an error. The
         * alternative — assuming read-only — silently removes the composer from everyone whose
         * read merely timed out, which is the far more common case and the worse failure.
         */
        isLoading ? null : (
          <ChatComposer
            actions={chat}
            writable={thread?.writable ?? true}
            onSend={onSend}
            onFileShared={addLocal}
            meetingProps={meetingProps}
            report={report}
          />
        )
      }
    >
      <ChatThreadBody
        statusLine={realtimeLine}
        isLoading={isLoading}
        hasFailed={hasFailed}
        onRetry={() => {
          void load();
        }}
        errorBody="The call itself is fine. Try again, or carry on talking — nothing is lost."
        hasLoaded={thread !== null}
        items={items}
        emptyNode={<EmptyThreadLine writable={thread?.writable ?? true} />}
        viewerUserId={thread?.viewerUserId ?? null}
        hasEarlier={thread?.hasEarlier ?? false}
        isLoadingEarlier={isLoadingEarlier}
        earlierFailed={earlierFailed}
        onLoadEarlier={loadEarlier}
        onOpenFiles={onOpenFiles}
      />
    </MeetingSidePanel>
  );
}
