'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationMessageView } from '@/lib/conversations/conversation-view-types';
import type { MeetingFileView } from '@/lib/meetings/meeting-file-view-types';
import type {
  MeetingGuestChatPanelActions,
  MeetingGuestFilePanelActions,
} from '@/lib/meetings/meeting-panels';
import { MeetingSidePanel } from './meeting-side-panel';
// ⚠⚠ F5/SUGGESTION-3 (fix-round-1) — imported from `./chat-thread-body`, NEVER `./chat-panel`.
// `chat-panel.tsx` module-level imports `ChatComposer`; importing from it would drag the
// composer (and `useMeetingFileUpload`) into this read-only surface's bundle for nothing ever
// called — the exact defect that also caused CRITICAL-6's flaky `waitFor` timeout.
import { ChatThreadBody } from './chat-thread-body';
import { mergeChatTimeline } from './chat-panel-list';

/**
 * BAL-445 — the GUEST Chat panel: READ-ONLY BY CONSTRUCTION.
 *
 * ⚠⚠ A SEPARATE COMPONENT, NOT A BRANCH INSIDE `ChatPanel`. `ChatPanel`'s composer footer is
 * gated on `isLoading` ONLY, with `writable` defaulting to `true` — the wrong direction for a
 * caller that must NEVER write. There is also no `postMessage` on
 * `MeetingGuestChatPanelActions` for a composer to call.
 *
 * ⚠ NO COMPOSER, ABSENT NOT DISABLED. No footer is passed to `MeetingSidePanel`.
 *
 * ⚠ NO `viewerUserId`. A guest has no `users.id`; `ChatPanelList` renders every bubble as
 * somebody else's, which is the honest answer.
 *
 * ⚠ THE FRESHNESS LINE IS NOT A DEGRADATION NOTICE. A guest has no Ably token in this PR, so
 * the thread is a snapshot at panel-open BY DESIGN. The line states that as a fact and names
 * the one action that refreshes it (`REALTIME_OFF_LINE`'s shape, not its words).
 *
 * ⚠ F4 (fix-round-1) — DELIBERATELY NO `onAnnounce` HERE, UNLIKE THE SIBLING FILES PANEL. The
 * member `ChatPanel`'s own `report`/`onAnnounce` wiring has exactly ONE call site —
 * `postMessage` failure (send) — and this panel has no `postMessage` on
 * `MeetingGuestChatPanelActions` for a guest to fail at. Both visible failure surfaces this
 * panel DOES have (the initial load's retry card, and `loadEarlier`'s inline `earlierFailed`
 * line) are unannounced in the MEMBER panel too, so wiring `onAnnounce` here without an actual
 * call site would be an unused prop, not parity. If a guest write path is ever added (slice 4),
 * add `onAnnounce` alongside it, mirroring `ChatPanel.onSend`'s `report('error', …)` exactly.
 */
export interface GuestChatPanelProps {
  readonly chat: MeetingGuestChatPanelActions;
  /** ⚠ READ-ONLY USE: the chat timeline's inline rows are a VIEW over the Files panel's list. */
  readonly files: MeetingGuestFilePanelActions;
  readonly onClose: () => void;
  readonly onOpenFiles: () => void;
}

const FRESHNESS_LINE =
  'This is the conversation as of when you opened this panel — reopen it to pull in anything new.';

interface GuestThreadState {
  readonly messages: readonly ConversationMessageView[];
  readonly hasEarlier: boolean;
}

function useGuestChatThread(chat: MeetingGuestChatPanelActions): {
  thread: GuestThreadState | null;
  hasFailed: boolean;
  isLoading: boolean;
  isLoadingEarlier: boolean;
  earlierFailed: boolean;
  load: () => Promise<void>;
  loadEarlier: () => void;
} {
  const [thread, setThread] = useState<GuestThreadState | null>(null);
  const [hasFailed, setHasFailed] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);
  const [earlierFailed, setEarlierFailed] = useState(false);
  const isMountedRef = useRef(true);

  /**
   * ⚠⚠ F8/WARNING-1 (fix-round-1) — WRAPPED IN A `try`/`catch`, mirroring the sibling Files
   * panel's `load`. `chat.fetchThread()` always RESOLVES with `{ success: false, … }` on every
   * handled failure, but a genuine transport-level rejection had no `.catch` anywhere on this
   * path — an unhandled rejection that left the panel on a PERMANENT skeleton.
   */
  const load = useCallback(async (): Promise<void> => {
    setHasFailed(false);
    setIsLoading(true);
    try {
      const result = await chat.fetchThread();
      if (!isMountedRef.current) return;
      setIsLoading(false);
      if (!result.success) {
        setHasFailed(true);
        return;
      }
      setThread({ messages: result.messages, hasEarlier: result.hasEarlier });
    } catch {
      if (!isMountedRef.current) return;
      setIsLoading(false);
      setHasFailed(true);
    }
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
      .fetchThread({ createdAtIso: oldest.createdAtIso, id: oldest.id })
      .then((result) => {
        if (!isMountedRef.current) return;
        if (!result.success) {
          setEarlierFailed(true);
          return;
        }
        setThread((current) =>
          current === null
            ? current
            : {
                messages: [...result.messages, ...current.messages],
                hasEarlier: result.hasEarlier,
              }
        );
      })
      .finally(() => {
        if (isMountedRef.current) setIsLoadingEarlier(false);
      });
  }, [chat, thread, isLoadingEarlier]);

  return { thread, hasFailed, isLoading, isLoadingEarlier, earlierFailed, load, loadEarlier };
}

/** No live feed for a guest — a single, one-shot list read, same as the Files panel's own. */
function useGuestChatFiles(files: MeetingGuestFilePanelActions): readonly MeetingFileView[] {
  const [loaded, setLoaded] = useState<readonly MeetingFileView[]>([]);
  useEffect(() => {
    let isMounted = true;
    void files.list().then((result) => {
      if (isMounted && result.success) setLoaded(result.files);
    });
    return () => {
      isMounted = false;
    };
  }, [files]);
  return loaded;
}

export function GuestChatPanel({
  chat,
  files,
  onClose,
  onOpenFiles,
}: Readonly<GuestChatPanelProps>): React.JSX.Element {
  const { thread, hasFailed, isLoading, isLoadingEarlier, earlierFailed, load, loadEarlier } =
    useGuestChatThread(chat);
  const chatFiles = useGuestChatFiles(files);

  const items = useMemo(
    () => mergeChatTimeline(thread?.messages ?? [], chatFiles),
    [thread, chatFiles]
  );

  return (
    <MeetingSidePanel title="Chat" onClose={onClose}>
      <ChatThreadBody
        statusLine={FRESHNESS_LINE}
        isLoading={isLoading}
        hasFailed={hasFailed}
        onRetry={() => {
          void load();
        }}
        errorBody="The call itself is fine. Try again in a moment."
        hasLoaded={thread !== null}
        items={items}
        emptyNode={
          <p className="text-muted-foreground px-4 py-6 text-center text-sm leading-relaxed">
            Nothing has been said in this conversation.
          </p>
        }
        viewerUserId={null}
        hasEarlier={thread?.hasEarlier ?? false}
        isLoadingEarlier={isLoadingEarlier}
        earlierFailed={earlierFailed}
        onLoadEarlier={loadEarlier}
        onOpenFiles={onOpenFiles}
      />
    </MeetingSidePanel>
  );
}
