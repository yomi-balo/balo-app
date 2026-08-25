'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Ellipsis, MessageSquare, Paperclip, WifiOff } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { track, CONVERSATION_EVENTS, PROJECT_EVENTS } from '@/lib/analytics';
import { formatBytes, putWithProgress } from '@/components/balo/document-uploader/upload-file';
import {
  CONVERSATION_ALLOWED_CONTENT_TYPES,
  MAX_CONVERSATION_FILE_BYTES,
} from '@/lib/storage/conversation-file-constraints';
import type { ProjectRequestStatus } from '@/lib/project-request/resolve-request-lens';
import {
  previewOfHtml,
  type ConversationFileView,
  type ConversationMessageView,
  type ConversationThreadView,
  type ConversationView,
} from '@/lib/project-request/conversation-view-types';
import { threadNudgeFor } from '@/lib/project-request/thread-nudge-content';
import { RequestCard } from '../request-card';
import { postConversationMessageAction } from '@/app/(dashboard)/projects/[requestId]/_actions/post-conversation-message';
import { markThreadReadAction } from '@/app/(dashboard)/projects/[requestId]/_actions/mark-thread-read';
import { fetchThreadAction } from '@/app/(dashboard)/projects/[requestId]/_actions/fetch-thread';
import { requestConversationFileUploadAction } from '@/app/(dashboard)/projects/[requestId]/_actions/request-conversation-file-upload';
import { confirmConversationFileUploadAction } from '@/app/(dashboard)/projects/[requestId]/_actions/confirm-conversation-file-upload';
import { getConversationFileDownloadAction } from '@/app/(dashboard)/projects/[requestId]/_actions/get-conversation-file-download';
import { shareAvailabilityAction } from '@/app/(dashboard)/projects/[requestId]/_actions/share-availability';
import {
  IntroCallBookingDialog,
  type IntroCallBookedSummary,
} from '@/components/booking/intro-call';
import {
  requestProposalAction,
  type RequestProposalResult,
} from '@/app/(dashboard)/projects/[requestId]/_actions/request-proposal';
import { createConversationRealtimeTokenAction } from '@/app/(dashboard)/projects/[requestId]/_actions/create-conversation-realtime-token';
// BAL-421 — the five ANCHOR-AGNOSTIC leaves moved to `components/balo/conversation/`; the
// case surface is their second consumer. Pure path move, no behaviour change.
import { useConversationRealtime } from '@/components/balo/conversation/use-conversation-realtime';
import { MessageList, type ThreadDataState } from '@/components/balo/conversation/message-list';
import { MessageComposer } from '@/components/balo/conversation/message-composer';
import { ThreadFilesPanel } from '@/components/balo/conversation/thread-files-panel';
import { deriveThreadActions } from './thread-actions';
import { ThreadTabs } from './thread-tabs';
import { ThreadHeader } from './thread-header';
import { ThreadNudge } from './thread-nudge';
import { MobileActionRail } from './mobile-action-rail';
import { MobileOverflowSheet, hasOverflowContent } from './mobile-overflow-sheet';
import { ProposalRequestDialog } from './proposal-request-dialog';

interface ConversationStageProps {
  requestId: string;
  lens: 'client' | 'expert';
  requestStatus: ProjectRequestStatus;
  view: ConversationView;
  /** BAL-283 (D12) — prop-drilled from the page, NOT added to the conversation view-model:
   *  the confirm step's "Intro call for {requestTitle}" context strip. */
  requestTitle: string;
  /** BAL-283 (D12) — for `GuestInviteComposer`'s "Outside {company}" copy. */
  clientCompanyName: string;
  /** BAL-283 (D12) — the VIEWER's OWN email domain (never a counterparty's — ADR-1044 is not
   *  engaged), for the guest composer's "same company as you" disclosure. */
  viewerEmailDomain: string | null;
}

interface ThreadData {
  state: ThreadDataState;
  messages: ConversationMessageView[];
  /** Newest first (Files panel order; the timeline re-sorts chronologically). */
  files: ConversationFileView[];
  hasEarlier: boolean;
  loadingEarlier: boolean;
}

const EMPTY_THREAD_DATA: ThreadData = {
  state: 'loading',
  messages: [],
  files: [],
  hasEarlier: false,
  loadingEarlier: false,
};

/** Min interval between mark-read Server Action calls per thread (correction 8). */
const MARK_READ_MIN_INTERVAL_MS = 3000;
const STAGE_CARD_CLASS = 'flex h-[min(78dvh,760px)] min-h-[520px] flex-col overflow-hidden p-0';

/** Relationship statuses at which the read-only "View proposal" surface opens. */
const PROPOSAL_VIEW_STATUSES = new Set<string>(['proposal_submitted', 'accepted']);

/** Pure list transform: bump one thread's file badge (confirm path). */
function withBumpedFileCount(
  threads: ConversationThreadView[],
  threadId: string
): ConversationThreadView[] {
  return threads.map((t) =>
    t.relationshipId === threadId ? { ...t, fileCount: t.fileCount + 1 } : t
  );
}

/** Pure thread transform: prepend a deduped earlier-messages page. */
function withEarlierMessages(
  current: ThreadData,
  earlierPage: ConversationMessageView[],
  hasEarlier: boolean
): ThreadData {
  const known = new Set(current.messages.map((m) => m.id));
  const earlier = earlierPage.filter((m) => !known.has(m.id));
  return {
    ...current,
    messages: [...earlier, ...current.messages],
    hasEarlier,
    loadingEarlier: false,
  };
}

/** The post-guard derived render model for the active thread (pure). */
interface StageRenderModel {
  nudge: ReturnType<typeof threadNudgeFor>;
  actions: ReturnType<typeof deriveThreadActions>;
  single: boolean;
  showYouSuffix: boolean;
  profileHref: string | null;
  showProposalPill: boolean;
  showOverflow: boolean;
}

/**
 * Pure deriver for the active thread's render model — the chrome flags the JSX
 * reads (nudge, action matrix, single-thread strip, profile link, proposal pill,
 * overflow). Extracted so the component body stays branch-light; identical to the
 * prior inline computation.
 */
function deriveStageRender(input: {
  lens: 'client' | 'expert';
  requestStatus: ProjectRequestStatus;
  activeThread: ConversationThreadView;
  threadCount: number;
  /** The CLIENT PARTY's name — prospective expert-lens copy names the party (CLAUDE.md). */
  clientCompanyName: string | null;
}): StageRenderModel {
  const { lens, requestStatus, activeThread, threadCount, clientCompanyName } = input;
  const nudge = threadNudgeFor(lens, requestStatus, activeThread, clientCompanyName);
  const nudgeIsProposal = Boolean(nudge?.primary && /proposal/i.test(nudge.primary.label));
  const actions = deriveThreadActions({
    lens,
    requestStatus,
    thread: activeThread,
    nudgeIsProposal,
  });
  const profileHref =
    lens === 'client' && activeThread.expertUsername !== null
      ? `/experts/${activeThread.expertUsername}`
      : null;
  const showProposalPill =
    lens === 'client' && activeThread.relationshipStatus === 'proposal_requested';
  return {
    nudge,
    actions,
    single: threadCount === 1,
    showYouSuffix: lens === 'expert',
    profileHref,
    showProposalPill,
    showOverflow: hasOverflowContent({ profileHref, showProposalPill }),
  };
}

const noopSend = (): Promise<boolean> => Promise.resolve(false);
const noopAttach = (): void => {
  // Disabled composer — nothing to attach to.
};
const noopDraftChange = (): void => {
  // Disabled composer — no draft to keep.
};

/**
 * Fire the proposal-CTA-click funnel event for a header/rail surface. The nudge
 * surface passes `undefined` and navigates without re-firing the event. Extracted
 * to module scope so the build/view navigation callbacks stay branch-light.
 */
function trackProposalCtaClick(
  surface: 'header' | 'rail' | undefined,
  requestId: string,
  relationshipId: string
): void {
  if (surface === undefined) return;
  track(CONVERSATION_EVENTS.CONVERSATION_PROPOSAL_CTA_CLICKED, {
    request_id: requestId,
    relationship_id: relationshipId,
    surface,
  });
}

/**
 * Open the expert proposal composer for `threadId`. No-op unless the thread is at
 * `proposal_requested` (defence-in-depth — the Build CTA only renders then). At
 * module scope so the `handleBuildProposal` callback stays branch-free.
 */
function openProposalComposer(args: {
  push: (href: string) => void;
  requestId: string;
  threadId: string | null;
  status: string | undefined;
  surface?: 'header' | 'rail';
}): void {
  const { push, requestId, threadId, status, surface } = args;
  if (threadId === null || status !== 'proposal_requested') return;
  trackProposalCtaClick(surface, requestId, threadId);
  push(`/projects/${requestId}/proposal/${threadId}`);
}

/**
 * Open the read-only proposal surface for `threadId` (client review / expert &
 * admin submitted view — the route dispatches by lens). No-op unless the thread is
 * submitted/accepted. Module scope keeps the `handleViewProposal` callback branch-free.
 */
function openProposalSurface(args: {
  push: (href: string) => void;
  requestId: string;
  threadId: string | null;
  status: string | undefined;
  surface?: 'header' | 'rail';
}): void {
  const { push, requestId, threadId, status, surface } = args;
  if (threadId === null || !PROPOSAL_VIEW_STATUSES.has(status ?? '')) return;
  trackProposalCtaClick(surface, requestId, threadId);
  push(`/projects/${requestId}/proposal/${threadId}`);
}

interface LensProposalHandlers {
  onHeaderRequestProposal: (() => void) | null;
  onHeaderBuildProposal: (() => void) | null;
  onNudgeBuild: (() => void) | undefined;
  onRailProposal: (() => void) | null;
  onRailBuildProposal: (() => void) | null;
}

/**
 * Resolve the lens-gated proposal-CTA handlers for the active thread: a handler is
 * wired only for the lens that owns that CTA (the wrong lens gets `null`/`undefined`
 * → a disabled stub). Pure + module-scope so the component body stays branch-light
 * (keeps `ConversationStage` under the cognitive-complexity limit).
 */
function resolveLensProposalHandlers(args: {
  lens: 'client' | 'expert';
  railProposalKind: string | undefined;
  headerRequestProposal: () => void;
  headerBuild: () => void;
  nudgeBuild: () => void;
  railProposal: () => void;
  railBuild: () => void;
}): LensProposalHandlers {
  const isClient = args.lens === 'client';
  const isExpert = args.lens === 'expert';
  return {
    onHeaderRequestProposal: isClient ? args.headerRequestProposal : null,
    onHeaderBuildProposal: isExpert ? args.headerBuild : null,
    onNudgeBuild: isExpert ? args.nudgeBuild : undefined,
    onRailProposal: isClient && args.railProposalKind === 'request' ? args.railProposal : null,
    onRailBuildProposal: isExpert ? args.railBuild : null,
  };
}

/** Zero-open-threads stage — invitation framing, never a blank panel. */
function EmptyConversationStage({
  lens,
}: Readonly<{ lens: 'client' | 'expert' }>): React.JSX.Element {
  const headline =
    lens === 'expert'
      ? 'Your conversation opens once you express interest'
      : 'Your conversation lives here';
  const sub =
    lens === 'expert'
      ? "Submit your expression of interest and you'll talk with the client right here — messages, files, and calls in one place."
      : "Once experts express interest, you'll message them directly to scope the work, share files, and line up a call — all in one place.";

  return (
    <RequestCard className={STAGE_CARD_CLASS}>
      <div className="border-border bg-muted/40 flex items-center gap-2 border-b px-4 py-3">
        <span className="bg-primary/10 text-primary flex h-7 w-7 items-center justify-center rounded-md">
          <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <span className="text-foreground text-sm font-semibold">Conversation</span>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
        <span className="bg-muted mb-4 flex h-12 w-12 items-center justify-center rounded-xl">
          <MessageSquare className="text-muted-foreground h-5 w-5" aria-hidden="true" />
        </span>
        <p className="text-foreground text-sm font-semibold">{headline}</p>
        <p className="text-muted-foreground mt-1.5 max-w-sm text-sm leading-relaxed">{sub}</p>
      </div>
      <MessageComposer
        expertFirstName="them"
        disabled
        disabledPlaceholder={
          lens === 'expert'
            ? 'Messaging opens once you express interest…'
            : 'Messaging opens once an expert expresses interest…'
        }
        sending={false}
        uploading={null}
        value=""
        onChange={noopDraftChange}
        onSend={noopSend}
        onAttach={noopAttach}
      />
    </RequestCard>
  );
}

/**
 * THE Phase-2 client island (BAL-271 / A4): tabbed multi-expert threads
 * (smart unread-aware default), per-thread nudges, realtime via Ably
 * (subscribe-only), thread-scoped files, plain-text composer. Tab ORDER is
 * `view.threads` verbatim — selection, never order, reacts to activity.
 * BAL-212 guard: the ONLY message write path is the composer submit.
 */
export function ConversationStage({
  requestId,
  lens,
  requestStatus,
  view,
  requestTitle,
  clientCompanyName,
  viewerEmailDomain,
}: Readonly<ConversationStageProps>): React.JSX.Element {
  const { viewerUserId } = view;
  const router = useRouter();
  const [threads, setThreads] = useState<ConversationThreadView[]>(view.threads);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(view.defaultThreadId);
  const [threadData, setThreadData] = useState<Record<string, ThreadData>>(() =>
    view.defaultThreadId === null
      ? {}
      : {
          [view.defaultThreadId]: {
            state: 'ready',
            messages: view.initialMessages,
            files: view.initialFiles,
            hasEarlier: view.initialHasEarlier,
            loadingEarlier: false,
          },
        }
  );
  const [filesOpen, setFilesOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState<{ fileName: string; progress: number } | null>(null);
  const [callPending, setCallPending] = useState(false);
  const [introCallDialogOpen, setIntroCallDialogOpen] = useState(false);
  const [introCallSurface, setIntroCallSurface] = useState<'header' | 'rail' | 'nudge'>('header');
  const [proposalDialogOpen, setProposalDialogOpen] = useState(false);
  const [downloadingFileId, setDownloadingFileId] = useState<string | null>(null);
  // Per-thread composer drafts (Slack behaviour): a reply typed for expert A
  // survives a tab switch and can never be Enter-sent to expert B.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const activeThreadIdRef = useRef(activeThreadId);
  useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);
  const lastMarkAtRef = useRef<Record<string, number>>({});
  const composerContainerRef = useRef<HTMLDivElement>(null);

  // Known file ids per thread, maintained at EVERY append/seed site so
  // duplicate detection happens BEFORE state dispatch — React updaters must
  // stay pure (queued updaters replay in hook-declaration order, so a flag
  // mutated inside one updater and read in another races under batching).
  const knownFileIdsRef = useRef<Map<string, Set<string>>>(new Map());
  const seededKnownFilesRef = useRef(false);
  if (!seededKnownFilesRef.current) {
    seededKnownFilesRef.current = true;
    if (view.defaultThreadId !== null) {
      knownFileIdsRef.current.set(
        view.defaultThreadId,
        new Set(view.initialFiles.map((f) => f.id))
      );
    }
  }
  /** Registers a file id; returns true when it was NOT known yet. */
  const rememberFile = useCallback((threadId: string, fileId: string): boolean => {
    let known = knownFileIdsRef.current.get(threadId);
    if (known === undefined) {
      known = new Set();
      knownFileIdsRef.current.set(threadId, known);
    }
    if (known.has(fileId)) return false;
    known.add(fileId);
    return true;
  }, []);

  /**
   * BAL-424 — Ably payloads carry a `conversationId`; the island's thread identity is still
   * the RELATIONSHIP id. This is the ONE place the two are reconciled. Built from `view` (the
   * server-rendered prop), not from `threads` state, so the mapping is stable across every
   * optimistic update.
   */
  const threadIdByConversationId = useMemo(
    () => new Map(view.threads.map((t) => [t.conversationId, t.relationshipId])),
    [view.threads]
  );

  /**
   * The forward direction, for the analytics anchor. Every BAL-424 conversation event carries
   * `conversation_id` + `context_type`; on THIS surface the anchor is always `relationship`
   * (the Case surface is BAL-421's), and `request_id` / `relationship_id` remain present.
   */
  const conversationIdByThreadId = useMemo(
    () => new Map(view.threads.map((t) => [t.relationshipId, t.conversationId])),
    [view.threads]
  );
  const conversationIdOf = useCallback(
    (relationshipId: string): string => conversationIdByThreadId.get(relationshipId) ?? '',
    [conversationIdByThreadId]
  );

  const activeThread = threads.find((t) => t.relationshipId === activeThreadId) ?? null;
  const activeData: ThreadData =
    (activeThreadId === null ? undefined : threadData[activeThreadId]) ?? EMPTY_THREAD_DATA;
  const activeFileCount =
    activeData.state === 'ready' ? activeData.files.length : (activeThread?.fileCount ?? 0);

  // ── Read-state plumbing ────────────────────────────────────────────────
  const markReadSafe = useCallback(
    (threadId: string): void => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - (lastMarkAtRef.current[threadId] ?? 0) < MARK_READ_MIN_INTERVAL_MS) return;
      lastMarkAtRef.current[threadId] = now;
      markThreadReadAction({ requestId, relationshipId: threadId }).catch(() => {
        // Watermark is best-effort; unread re-derives on next load.
      });
    },
    [requestId]
  );

  const clearUnread = useCallback((threadId: string): void => {
    setThreads((prev) =>
      prev.map((t) => (t.relationshipId === threadId && t.unread ? { ...t, unread: false } : t))
    );
  }, []);

  // ── Thread loading ─────────────────────────────────────────────────────
  const fetchThread = useCallback(
    (threadId: string): void => {
      setThreadData((prev) => ({ ...prev, [threadId]: { ...EMPTY_THREAD_DATA } }));
      fetchThreadAction({ requestId, relationshipId: threadId, includeFiles: true })
        .then((result) => {
          if (result.success) {
            for (const file of result.files ?? []) rememberFile(threadId, file.id);
          }
          setThreadData((prev) => ({
            ...prev,
            [threadId]: result.success
              ? {
                  state: 'ready',
                  messages: result.messages,
                  files: result.files ?? [],
                  hasEarlier: result.hasEarlier,
                  loadingEarlier: false,
                }
              : { ...EMPTY_THREAD_DATA, state: 'error' },
          }));
        })
        .catch(() => {
          setThreadData((prev) => ({
            ...prev,
            [threadId]: { ...EMPTY_THREAD_DATA, state: 'error' },
          }));
        });
    },
    [requestId, rememberFile]
  );

  const selectThread = useCallback(
    (threadId: string, method: 'auto' | 'manual'): void => {
      const thread = threads.find((t) => t.relationshipId === threadId);
      track(CONVERSATION_EVENTS.CONVERSATION_THREAD_SELECTED, {
        request_id: requestId,
        relationship_id: threadId,
        conversation_id: conversationIdOf(threadId),
        method,
        was_unread: thread?.unread ?? false,
        thread_count: threads.length,
      });
      setActiveThreadId(threadId);
      // Close the files panel on tab switch (design line 1515).
      setFilesOpen(false);
      setOverflowOpen(false);
      clearUnread(threadId);
      markReadSafe(threadId);
      if (threadData[threadId] === undefined) {
        fetchThread(threadId);
      }
    },
    [threads, threadData, requestId, clearUnread, markReadSafe, fetchThread, conversationIdOf]
  );

  const handleTabSelect = useCallback(
    (threadId: string): void => selectThread(threadId, 'manual'),
    [selectThread]
  );

  const handleRetry = useCallback((): void => {
    if (activeThreadId !== null) fetchThread(activeThreadId);
  }, [activeThreadId, fetchThread]);

  // Default-tab analytics + initial mark-read, once per mount.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (mountedRef.current || view.defaultThreadId === null) return;
    mountedRef.current = true;
    const defaultThread = view.threads.find((t) => t.relationshipId === view.defaultThreadId);
    track(CONVERSATION_EVENTS.CONVERSATION_THREAD_SELECTED, {
      request_id: requestId,
      relationship_id: view.defaultThreadId,
      conversation_id: defaultThread?.conversationId ?? '',
      method: 'auto',
      was_unread: defaultThread?.unread ?? false,
      thread_count: view.threads.length,
    });
    clearUnread(view.defaultThreadId);
    markReadSafe(view.defaultThreadId);
  }, [view, requestId, clearUnread, markReadSafe]);

  // Returning to a visible tab marks the active thread read.
  useEffect(() => {
    const onVisibility = (): void => {
      const threadId = activeThreadIdRef.current;
      if (document.visibilityState === 'visible' && threadId !== null) {
        clearUnread(threadId);
        markReadSafe(threadId);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [clearUnread, markReadSafe]);

  // ── Realtime (subscribe-only; optimistic echoes deduped by id) ─────────
  // Both handlers keep their state updaters PURE: any dedupe decision is made
  // BEFORE dispatching (the message updaters are idempotent by construction;
  // the file handler decides via `rememberFile`). Never mutate a closure
  // variable inside one updater and read it in another — queued updaters
  // replay per hook in declaration order under batching.
  const handleRealtimeMessage = useCallback(
    (message: ConversationMessageView): void => {
      const threadId = threadIdByConversationId.get(message.conversationId);
      if (threadId === undefined) return;
      const fromViewer = message.senderUserId === viewerUserId;
      const activeVisible =
        threadId === activeThreadIdRef.current && document.visibilityState === 'visible';

      setThreadData((prev) => {
        const data = prev[threadId];
        if (data === undefined || data.state !== 'ready') return prev;
        if (data.messages.some((m) => m.id === message.id)) return prev;
        return { ...prev, [threadId]: { ...data, messages: [...data.messages, message] } };
      });
      setThreads((prev) =>
        prev.map((t) => {
          if (t.relationshipId !== threadId) return t;
          let unread = t.unread;
          if (!fromViewer) unread = !activeVisible;
          return {
            ...t,
            latestMessagePreview: previewOfHtml(message.bodyHtml),
            latestMessageAtIso: message.createdAtIso,
            latestMessageFromViewer: fromViewer,
            latestInboundActivityAtIso: fromViewer
              ? t.latestInboundActivityAtIso
              : message.createdAtIso,
            unread,
          };
        })
      );
      if (!fromViewer && activeVisible) markReadSafe(threadId);
    },
    [viewerUserId, markReadSafe, threadIdByConversationId]
  );

  const handleRealtimeFile = useCallback(
    (file: ConversationFileView): void => {
      const threadId = threadIdByConversationId.get(file.conversationId);
      if (threadId === undefined) return;
      const fromViewer = file.uploadedByUserId === viewerUserId;
      const activeVisible =
        threadId === activeThreadIdRef.current && document.visibilityState === 'visible';

      // Decide duplication BEFORE dispatching: our own confirm (or a previous
      // echo) already registered the id. Two echoes batched into one render
      // can therefore never double-increment the Files badge.
      const isNew = rememberFile(threadId, file.id);

      if (isNew) {
        setThreadData((prev) => {
          const data = prev[threadId];
          if (data === undefined || data.state !== 'ready') return prev;
          return { ...prev, [threadId]: { ...data, files: [file, ...data.files] } };
        });
      }
      setThreads((prev) =>
        prev.map((t) => {
          if (t.relationshipId !== threadId) return t;
          let unread = t.unread;
          if (!fromViewer) unread = !activeVisible;
          return {
            ...t,
            fileCount: isNew ? t.fileCount + 1 : t.fileCount,
            latestInboundActivityAtIso: fromViewer
              ? t.latestInboundActivityAtIso
              : file.createdAtIso,
            unread,
          };
        })
      );
      if (!fromViewer && activeVisible) markReadSafe(threadId);
    },
    [viewerUserId, markReadSafe, rememberFile, threadIdByConversationId]
  );

  // BAL-424 — channels are keyed on the CONVERSATION, so a Case (which has no relationship)
  // and a thread that carries over at kickoff both keep one stable channel for life.
  const conversationIds = useMemo(() => view.threads.map((t) => t.conversationId), [view.threads]);
  // ⚠ MEMOIZED DELIBERATELY (BAL-421). `fetchToken` is an effect dependency inside the hook,
  // so an inline arrow would re-subscribe every channel on every render.
  const fetchRealtimeToken = useCallback(
    () => createConversationRealtimeTokenAction({ requestId }),
    [requestId]
  );
  const { status: realtimeStatus } = useConversationRealtime({
    enabled: view.realtimeEnabled && conversationIds.length > 0,
    fetchToken: fetchRealtimeToken,
    conversationIds,
    onMessage: handleRealtimeMessage,
    onFile: handleRealtimeFile,
  });

  // ── Composer: per-thread drafts + send ─────────────────────────────────
  const activeDraft = activeThreadId === null ? '' : (drafts[activeThreadId] ?? '');
  const handleDraftChange = useCallback(
    (text: string): void => {
      if (activeThreadId === null) return;
      setDrafts((prev) => ({ ...prev, [activeThreadId]: text }));
    },
    [activeThreadId]
  );

  const handleSend = useCallback(
    async (text: string): Promise<boolean> => {
      if (activeThreadId === null) return false;
      const threadId = activeThreadId;
      setSending(true);
      try {
        const result = await postConversationMessageAction({
          requestId,
          relationshipId: threadId,
          body: text,
        });
        if (!result.success) {
          toast.error(result.error);
          return false;
        }
        // Clear ONLY the sent thread's draft (keyed by the id captured at send
        // start — a mid-send tab switch can't clear another thread's draft).
        setDrafts((prev) => ({ ...prev, [threadId]: '' }));
        const wasFirst = (threadData[threadId]?.messages.length ?? 0) === 0;
        const { message } = result;
        setThreadData((prev) => {
          const data = prev[threadId];
          if (data === undefined || data.state !== 'ready') return prev;
          if (data.messages.some((m) => m.id === message.id)) return prev;
          return { ...prev, [threadId]: { ...data, messages: [...data.messages, message] } };
        });
        setThreads((prev) =>
          prev.map((t) =>
            t.relationshipId === threadId
              ? {
                  ...t,
                  latestMessagePreview: previewOfHtml(message.bodyHtml),
                  latestMessageAtIso: message.createdAtIso,
                  latestMessageFromViewer: true,
                }
              : t
          )
        );
        // The action already advanced the watermark server-side.
        lastMarkAtRef.current[threadId] = Date.now();
        track(CONVERSATION_EVENTS.CONVERSATION_MESSAGE_SENT, {
          request_id: requestId,
          relationship_id: threadId,
          conversation_id: conversationIdOf(threadId),
          context_type: 'relationship',
          lens,
          body_length: text.trim().length,
          thread_count: threads.length,
          is_first_message_in_thread: wasFirst,
          // This composer is the project-request stage, never the in-call panel (BAL-132).
          during_meeting: false,
        });
        toast.success('Message sent');
        return true;
      } catch {
        toast.error('Could not send your message. Please try again.');
        return false;
      } finally {
        setSending(false);
      }
    },
    [activeThreadId, requestId, lens, threads.length, threadData, conversationIdOf]
  );

  // ── Composer: attach (presign → XHR PUT → confirm) ─────────────────────
  const handleAttach = useCallback(
    (file: File): void => {
      if (activeThreadId === null || uploading !== null) return;
      const threadId = activeThreadId;
      if (!CONVERSATION_ALLOWED_CONTENT_TYPES.has(file.type)) {
        toast.error(`${file.name} isn't a supported file type.`);
        return;
      }
      if (file.size > MAX_CONVERSATION_FILE_BYTES) {
        toast.error(`${file.name} is ${formatBytes(file.size)} — files must be 10 MB or smaller.`);
        return;
      }
      setUploading({ fileName: file.name, progress: 0 });

      const run = async (): Promise<void> => {
        const presign = await requestConversationFileUploadAction({
          requestId,
          relationshipId: threadId,
          contentType: file.type,
          fileName: file.name,
        });
        if (!presign.success) {
          toast.error(presign.error);
          return;
        }
        await putWithProgress({
          url: presign.presignedUrl,
          file,
          onProgress: (pct) => setUploading({ fileName: file.name, progress: pct }),
        });
        const confirm = await confirmConversationFileUploadAction({
          requestId,
          relationshipId: threadId,
          key: presign.key,
          fileName: file.name,
          contentType: file.type,
          sizeBytes: file.size,
        });
        if (!confirm.success) {
          toast.error(confirm.error);
          return;
        }
        const shared = confirm.file;
        // The Ably echo may have raced this confirm — only a genuinely new id
        // appends and bumps the badge (decided BEFORE dispatch; pure updaters).
        const isNew = rememberFile(threadId, shared.id);
        if (isNew) {
          setThreadData((prev) => {
            const data = prev[threadId];
            if (data === undefined || data.state !== 'ready') return prev;
            return { ...prev, [threadId]: { ...data, files: [shared, ...data.files] } };
          });
          setThreads((prev) => withBumpedFileCount(prev, threadId));
        }
        lastMarkAtRef.current[threadId] = Date.now();
        track(CONVERSATION_EVENTS.CONVERSATION_FILE_SHARED, {
          request_id: requestId,
          relationship_id: threadId,
          conversation_id: conversationIdOf(threadId),
          context_type: 'relationship',
          lens,
          content_type: file.type,
          size_bytes: file.size,
        });
        toast.success('File shared');
      };

      run()
        .catch(() => {
          toast.error('Could not share your file. Please try again.');
        })
        .finally(() => setUploading(null));
    },
    [activeThreadId, uploading, requestId, lens, rememberFile, conversationIdOf]
  );

  // ── Call CTA (BAL-283) ───────────────────────────────────────────────────
  //
  // Lens-specific from here: the CLIENT opens the live-availability dialog (no server call on
  // click — plan §12.5 step 2); the EXPERT fires `shareAvailabilityAction` directly (no dialog,
  // no picker — Ruling 3, plan §12.6 step 2).
  //
  // ⚠⚠ BOTH PATHS FLIP LOCAL STATE, AND `router.refresh()` ALONE IS NOT ENOUGH (round-1 C1).
  // `threads` is seeded ONCE from `view.threads`; a refresh PRESERVES client component state by
  // design (the sibling comment on `<ConversationStage key={view.id}>` in
  // `request-detail-shell.tsx` says so verbatim) and the key is the REQUEST id, which does not
  // change on a refresh. Without these flips the entire post-action half of BAL-283 was dead on
  // BOTH lenses: the expert's "Availability shared" pill never appeared and "Propose times"
  // stayed a live primary CTA that re-stamped the row on every click (with the 24h rule
  // silently suppressing the notification the toast implied was sent), and the client's booked
  // CTA never disappeared, letting them immediately book a second call. Same precedent as
  // `flipThreadToProposalRequested` below.

  /** Local flip: stamp `availabilitySharedAtIso` so the pill/nudge re-derive instantly. */
  const flipThreadToAvailabilityShared = useCallback(
    (threadId: string, sharedAtIso: string): void => {
      setThreads((prev) =>
        prev.map((t) =>
          t.relationshipId === threadId ? { ...t, availabilitySharedAtIso: sharedAtIso } : t
        )
      );
    },
    []
  );

  /** Local flip: record the booked call so the CTA becomes the "booked" done cell instantly. */
  const flipThreadToBooked = useCallback(
    (threadId: string, booked: { meetingId: string; scheduledStartIso: string }): void => {
      setThreads((prev) =>
        prev.map((t) => (t.relationshipId === threadId ? { ...t, bookedCall: booked } : t))
      );
    },
    []
  );

  const handleCall = useCallback(
    (surface: 'header' | 'rail' | 'nudge'): void => {
      if (activeThreadId === null || callPending) return;
      track(CONVERSATION_EVENTS.CONVERSATION_CALL_CTA_CLICKED, {
        request_id: requestId,
        relationship_id: activeThreadId,
        lens,
        surface,
      });

      if (lens === 'client') {
        setIntroCallSurface(surface);
        setIntroCallDialogOpen(true);
        return;
      }

      setCallPending(true);
      shareAvailabilityAction({ requestId, relationshipId: activeThreadId, surface })
        .then((result) => {
          if (!result.ok) {
            const message =
              result.code === 'not_permitted'
                ? 'This request has moved on — sharing availability isn’t needed anymore.'
                : 'Could not share your availability. Please try again.';
            toast.error(message);
            return;
          }
          track(CONVERSATION_EVENTS.CONVERSATION_AVAILABILITY_SHARED, {
            request_id: requestId,
            relationship_id: activeThreadId,
            surface,
            is_reshare: result.isReshare,
          });
          // ⚠ THE CLIENT PARTY, NOT `expertFirstName` (round-1 CRITICAL). This branch runs ONLY
          // for `lens === 'expert'`, and `expertFirstName` IS THE VIEWER — so Priya clicked
          // "Propose times" and was told "Priya can now pick a time from your calendar." The
          // right value was already a prop on this component and already threaded into
          // `IntroCallBookingDialog`.
          const description = result.calendarConnected
            ? `${clientCompanyName ?? 'The client'} can now pick a time from your calendar.`
            : 'Connect your calendar so clients can see your open slots.';
          toast.success(result.isReshare ? 'Availability shared again' : 'Availability shared', {
            description,
          });
          // Local flip FIRST (see the block comment above — the refresh cannot do this), then
          // the refresh to reconcile everything else the server render owns.
          flipThreadToAvailabilityShared(activeThreadId, result.sharedAtIso);
          router.refresh();
        })
        .catch(() => toast.error('Could not share your availability. Please try again.'))
        .finally(() => setCallPending(false));
    },
    [
      activeThreadId,
      callPending,
      requestId,
      lens,
      router,
      clientCompanyName,
      flipThreadToAvailabilityShared,
    ]
  );

  const handleIntroCallBooked = useCallback(
    (booked: IntroCallBookedSummary): void => {
      // ⚠ The thread the DIALOG booked against, captured from the dialog's own props — not
      // `activeThreadId`, which a tab switch could have moved while the request was in flight.
      flipThreadToBooked(booked.relationshipId, {
        meetingId: booked.meetingId,
        scheduledStartIso: booked.scheduledStartIso,
      });
      router.refresh();
    },
    [router, flipThreadToBooked]
  );
  const handleHeaderCall = useCallback((): void => handleCall('header'), [handleCall]);
  const handleRailCall = useCallback((): void => handleCall('rail'), [handleCall]);
  const handleNudgeCall = useCallback((): void => handleCall('nudge'), [handleCall]);

  // ── Request proposal (BAL-272 / A5 — client lens only) ─────────────────
  // Surface + thread captured at CTA-click time; the modal blocks tab switches
  // while the confirm beat is up, but the ref keeps the commit race-proof.
  const proposalContextRef = useRef<{ threadId: string; surface: 'header' | 'rail' } | null>(null);

  /**
   * Local flip → `deriveThreadActions`/nudge/pills re-derive instantly.
   * FORWARD only (`eoi_submitted → proposal_requested`): an `already_requested`
   * reconcile must never regress a thread already at `proposal_submitted`/`accepted`.
   */
  const flipThreadToProposalRequested = useCallback((threadId: string): void => {
    setThreads((prev) =>
      prev.map((t) =>
        t.relationshipId === threadId && t.relationshipStatus === 'eoi_submitted'
          ? { ...t, relationshipStatus: 'proposal_requested' }
          : t
      )
    );
  }, []);

  const handleRequestProposal = useCallback(
    (surface: 'header' | 'rail'): void => {
      if (activeThreadId === null) return;
      // Belt-and-braces: the CTA only renders at `eoi_submitted` (kind:'request'),
      // but never let a stale surface open the commit beat past that state.
      if (activeThread?.relationshipStatus !== 'eoi_submitted') return;
      track(CONVERSATION_EVENTS.CONVERSATION_PROPOSAL_CTA_CLICKED, {
        request_id: requestId,
        relationship_id: activeThreadId,
        surface,
      });
      proposalContextRef.current = { threadId: activeThreadId, surface };
      setProposalDialogOpen(true);
    },
    [activeThreadId, activeThread?.relationshipStatus, requestId]
  );
  const handleHeaderProposal = useCallback(
    (): void => handleRequestProposal('header'),
    [handleRequestProposal]
  );
  const handleRailProposal = useCallback(
    (): void => handleRequestProposal('rail'),
    [handleRequestProposal]
  );

  // ── Build proposal (BAL-288 / A6.2 — expert lens only) ─────────────────
  // Opens the proposal composer for the active thread. Gated to the expert
  // lens AND a `proposal_requested` relationship (defence-in-depth: the Build
  // CTA only renders at that state). `surface` (`header`/`rail`) feeds the
  // existing CONVERSATION_PROPOSAL_CTA_CLICKED funnel; the nudge surface (no
  // matching surface value on that event) navigates without re-firing it.
  const handleBuildProposal = useCallback(
    (surface?: 'header' | 'rail'): void => {
      openProposalComposer({
        push: (href) => router.push(href),
        requestId,
        threadId: activeThreadId,
        status: activeThread?.relationshipStatus,
        surface,
      });
    },
    [activeThreadId, activeThread?.relationshipStatus, requestId, router]
  );
  const handleHeaderBuild = useCallback(
    (): void => handleBuildProposal('header'),
    [handleBuildProposal]
  );
  const handleRailBuild = useCallback(
    (): void => handleBuildProposal('rail'),
    [handleBuildProposal]
  );
  const handleNudgeBuild = useCallback((): void => handleBuildProposal(), [handleBuildProposal]);

  // ── View proposal (BAL-289 / A6.3 — BOTH lenses) ───────────────────────────
  // Opens the read-only proposal surface for the active thread. The route
  // dispatches by lens (client → review, expert/admin → submitted view), so the
  // same push serves both. Gated to a submitted/accepted relationship (defence-
  // in-depth: the View CTA only renders at those states). `surface`
  // (`header`/`rail`) feeds the existing CONVERSATION_PROPOSAL_CTA_CLICKED funnel.
  const handleViewProposal = useCallback(
    (surface?: 'header' | 'rail'): void => {
      openProposalSurface({
        push: (href) => router.push(href),
        requestId,
        threadId: activeThreadId,
        status: activeThread?.relationshipStatus,
        surface,
      });
    },
    [activeThreadId, activeThread?.relationshipStatus, requestId, router]
  );
  const handleHeaderView = useCallback(
    (): void => handleViewProposal('header'),
    [handleViewProposal]
  );
  const handleRailView = useCallback((): void => handleViewProposal('rail'), [handleViewProposal]);

  const handleProposalConfirm = useCallback(async (): Promise<RequestProposalResult> => {
    const context = proposalContextRef.current;
    if (context === null) {
      return { success: false, error: 'Could not request the proposal. Please try again.' };
    }
    const result = await requestProposalAction({ requestId, relationshipId: context.threadId });
    if (!result.success && result.code === 'already_requested') {
      // Stale local state (another tab/session won the race) — reconcile so the
      // "Proposal requested" pill shows; the dialog closes without an error toast.
      flipThreadToProposalRequested(context.threadId);
      toast.info(result.error);
    }
    return result;
  }, [requestId, flipThreadToProposalRequested]);

  const handleProposalConfirmed = useCallback(
    (result: Extract<RequestProposalResult, { success: true }>): void => {
      const context = proposalContextRef.current;
      if (context === null) return;
      const confirmedThread = threads.find((t) => t.relationshipId === context.threadId);
      flipThreadToProposalRequested(context.threadId);
      track(PROJECT_EVENTS.PROJECT_PROPOSAL_REQUESTED, {
        request_id: requestId,
        relationship_id: context.threadId,
        expert_id: result.expertProfileId,
        actor: 'client',
        surface: context.surface,
        proposal_request_count: result.analytics.proposalRequestCount,
        ...(result.analytics.timeFromFirstEoiMs === null
          ? {}
          : { time_from_first_eoi_ms: result.analytics.timeFromFirstEoiMs }),
        message_count: result.analytics.messageCount,
        file_count: result.analytics.fileCount,
        thread_count: threads.length,
      });
      if (result.transitioned) {
        // Keeps the canonical transition stream complete (expert-invite precedent).
        track(PROJECT_EVENTS.PROJECT_REQUEST_STATUS_TRANSITIONED, {
          request_id: requestId,
          from: 'eoi_submitted',
          to: 'proposal_requested',
          actor: 'client',
        });
      }
      toast.success(
        `Proposal requested — ${confirmedThread?.expertFirstName ?? 'the expert'} has been notified.`
      );
    },
    [threads, requestId, flipThreadToProposalRequested]
  );

  // ── Files panel + downloads ────────────────────────────────────────────
  const openFiles = useCallback(
    (surface: 'header' | 'tabstrip'): void => {
      if (activeThreadId === null) return;
      track(CONVERSATION_EVENTS.CONVERSATION_FILES_OPENED, {
        request_id: requestId,
        relationship_id: activeThreadId,
        conversation_id: conversationIdOf(activeThreadId),
        surface,
        file_count: activeFileCount,
      });
      setFilesOpen(true);
    },
    [activeThreadId, requestId, activeFileCount, conversationIdOf]
  );
  const handleHeaderFilesToggle = useCallback((): void => {
    if (filesOpen) setFilesOpen(false);
    else openFiles('header');
  }, [filesOpen, openFiles]);
  const handleTabstripFiles = useCallback((): void => openFiles('tabstrip'), [openFiles]);

  const handleDownload = useCallback(
    (file: ConversationFileView): void => {
      // BAL-424: `ConversationFileView` is an Ably wire payload and no longer carries a
      // relationship id. The Files panel only ever renders the ACTIVE thread's files, so the
      // thread the action must validate against is the active one.
      if (activeThreadId === null) return;
      setDownloadingFileId(file.id);
      getConversationFileDownloadAction({
        requestId,
        relationshipId: activeThreadId,
        fileId: file.id,
      })
        .then((result) => {
          // Same-tab navigation: the presigned GET forces Content-Disposition
          // attachment, and Safari/iOS block window.open after an await.
          if (result.success) globalThis.location.assign(result.url);
          else toast.error(result.error);
        })
        .catch(() => toast.error('Could not download this file. Please try again.'))
        .finally(() => setDownloadingFileId(null));
    },
    [requestId, activeThreadId]
  );

  // ── Load earlier (keyset) ──────────────────────────────────────────────
  const handleLoadEarlier = useCallback((): void => {
    if (activeThreadId === null) return;
    const threadId = activeThreadId;
    const data = threadData[threadId];
    if (data === undefined || data.loadingEarlier) return;
    const [oldest] = data.messages;
    if (oldest === undefined) return;

    setThreadData((prev) => {
      const current = prev[threadId];
      if (current === undefined) return prev;
      return { ...prev, [threadId]: { ...current, loadingEarlier: true } };
    });
    fetchThreadAction({
      requestId,
      relationshipId: threadId,
      before: { createdAtIso: oldest.createdAtIso, id: oldest.id },
      includeFiles: false,
    })
      .then((result) => {
        setThreadData((prev) => {
          const current = prev[threadId];
          if (current === undefined) return prev;
          if (!result.success)
            return { ...prev, [threadId]: { ...current, loadingEarlier: false } };
          return {
            ...prev,
            [threadId]: withEarlierMessages(current, result.messages, result.hasEarlier),
          };
        });
        if (!result.success) toast.error(result.error);
      })
      .catch(() => {
        setThreadData((prev) => {
          const current = prev[threadId];
          if (current === undefined) return prev;
          return { ...prev, [threadId]: { ...current, loadingEarlier: false } };
        });
        toast.error('Could not load earlier messages. Please try again.');
      });
  }, [activeThreadId, threadData, requestId]);

  const focusComposer = useCallback((): void => {
    composerContainerRef.current?.querySelector('textarea')?.focus();
  }, []);

  // BAL-283 — the calendar's `emptyAction` escape ("Message {expert} instead"): closes the
  // dialog and focuses the composer, reusing the SAME `focusComposer` wiring already used by
  // the nudge/pill's reply action, per the design's "never a dead end" rule.
  const handleIntroCallMessage = useCallback((): void => {
    setIntroCallDialogOpen(false);
    focusComposer();
  }, [focusComposer]);

  // ── Zero open threads — invitation, never a blank panel ────────────────
  if (threads.length === 0 || activeThread === null) {
    return <EmptyConversationStage lens={lens} />;
  }

  const { nudge, actions, single, showYouSuffix, profileHref, showProposalPill, showOverflow } =
    deriveStageRender({
      lens,
      requestStatus,
      activeThread,
      threadCount: threads.length,
      clientCompanyName,
    });

  // Lens-gated handler wiring (pure helper — keeps the component body branch-light).
  const {
    onHeaderRequestProposal,
    onHeaderBuildProposal,
    onNudgeBuild,
    onRailProposal,
    onRailBuildProposal,
  } = resolveLensProposalHandlers({
    lens,
    railProposalKind: actions.railProposal?.kind,
    headerRequestProposal: handleHeaderProposal,
    headerBuild: handleHeaderBuild,
    nudgeBuild: handleNudgeBuild,
    railProposal: handleRailProposal,
    railBuild: handleRailBuild,
  });
  // The `kind:'view'` review/submitted link is live for BOTH lenses (the route
  // dispatches by lens). Always wired; the slot only renders at submitted/accepted.
  const composerExpertName = lens === 'expert' ? 'the client' : activeThread.expertFirstName;

  return (
    <RequestCard className={STAGE_CARD_CLASS}>
      {/* Strip row: tabs (mobile always; desktop hidden when single) + pinned mobile controls */}
      <div
        className={cn(
          'border-border bg-muted/40 flex items-stretch border-b',
          single && 'lg:hidden'
        )}
      >
        <ThreadTabs
          threads={threads}
          activeThreadId={activeThreadId}
          showYouSuffix={showYouSuffix}
          onSelect={handleTabSelect}
        />
        <div className="flex shrink-0 items-center gap-1.5 px-2 py-1.5 lg:hidden">
          <button
            type="button"
            onClick={handleTabstripFiles}
            aria-label={`Open shared files (${activeFileCount})`}
            className="border-border bg-card text-muted-foreground focus-visible:ring-ring relative flex h-11 w-11 items-center justify-center rounded-[9px] border focus-visible:ring-2 focus-visible:outline-none"
          >
            <Paperclip className="h-4 w-4" aria-hidden="true" />
            {activeFileCount > 0 && (
              <span className="bg-primary border-card absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full border-2 px-1 text-[10px] font-bold text-white">
                {activeFileCount}
              </span>
            )}
          </button>
          {showOverflow && (
            <button
              type="button"
              onClick={() => setOverflowOpen(true)}
              aria-label="More thread options"
              className="border-border bg-card text-muted-foreground focus-visible:ring-ring flex h-11 w-11 items-center justify-center rounded-[9px] border focus-visible:ring-2 focus-visible:outline-none"
            >
              <Ellipsis className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* Desktop header — identity, Files pill, call CTA, proposal slot */}
      <div className="hidden lg:block">
        <ThreadHeader
          thread={activeThread}
          showYouSuffix={showYouSuffix}
          fileCount={activeFileCount}
          filesOpen={filesOpen}
          actions={actions}
          callPending={callPending}
          onToggleFiles={handleHeaderFilesToggle}
          onCall={handleHeaderCall}
          onRequestProposal={onHeaderRequestProposal}
          onBuildProposal={onHeaderBuildProposal}
          onViewProposal={handleHeaderView}
        />
      </div>

      {/* Realtime down (configured but the connection died) — quiet, non-blocking */}
      {realtimeStatus === 'failed' && (
        <div className="border-border bg-muted/40 text-muted-foreground flex items-center gap-2 border-b px-3.5 py-1.5 text-xs">
          <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Live updates paused — refresh to catch up.
        </div>
      )}

      {/* Per-thread nudge — the live edge at the top */}
      {nudge && (
        <div className="px-3.5 pt-3">
          <ThreadNudge
            nudge={nudge}
            callPending={callPending}
            onReply={focusComposer}
            onCall={handleNudgeCall}
            onBuild={onNudgeBuild}
          />
        </div>
      )}

      <MessageList
        threadKey={activeThread.relationshipId}
        counterpartyFirstName={activeThread.expertFirstName}
        introHtml={activeThread.eoiHtml}
        lens={lens}
        viewerUserId={viewerUserId}
        state={activeData.state}
        messages={activeData.messages}
        files={activeData.files}
        hasEarlier={activeData.hasEarlier}
        loadingEarlier={activeData.loadingEarlier}
        downloadingFileId={downloadingFileId}
        onLoadEarlier={handleLoadEarlier}
        onRetry={handleRetry}
        onFileClick={handleDownload}
      />

      <div ref={composerContainerRef}>
        <MessageComposer
          expertFirstName={composerExpertName}
          placeholder={nudge?.composerPlaceholder}
          sending={sending}
          uploading={uploading}
          value={activeDraft}
          onChange={handleDraftChange}
          onSend={handleSend}
          onAttach={handleAttach}
          onFocusChange={setComposerFocused}
        />
      </div>

      <MobileActionRail
        visible={!composerFocused}
        callSlot={actions.callSlot}
        callPending={callPending}
        proposalCta={actions.railProposal}
        onCall={handleRailCall}
        onProposal={onRailProposal}
        onBuildProposal={onRailBuildProposal}
        onViewProposal={handleRailView}
      />

      <ThreadFilesPanel
        open={filesOpen}
        onOpenChange={setFilesOpen}
        state={activeData.state}
        files={activeData.files}
        downloadingFileId={downloadingFileId}
        onDownload={handleDownload}
        onRetry={handleRetry}
      />

      <MobileOverflowSheet
        open={overflowOpen}
        onOpenChange={setOverflowOpen}
        thread={activeThread}
        showProposalPill={showProposalPill}
        profileHref={profileHref}
      />

      {/* A5 confirm beat — committing action gets friction proportional to consequence. */}
      <ProposalRequestDialog
        open={proposalDialogOpen}
        onOpenChange={setProposalDialogOpen}
        expertFirstName={activeThread.expertFirstName}
        onConfirm={handleProposalConfirm}
        onConfirmed={handleProposalConfirmed}
      />

      {/* BAL-283 — the CLIENT lens's live-availability booking dialog. Mounted for the ACTIVE
          thread only; a tab switch while open would otherwise book against the wrong
          relationship. */}
      {lens === 'client' && (
        <IntroCallBookingDialog
          open={introCallDialogOpen}
          onOpenChange={setIntroCallDialogOpen}
          requestId={requestId}
          relationshipId={activeThread.relationshipId}
          expertProfileId={activeThread.expertProfileId}
          expertName={activeThread.expertName}
          expertFirstName={activeThread.expertFirstName}
          expertInitials={activeThread.expertInitials}
          requestTitle={requestTitle}
          clientCompanyName={clientCompanyName}
          viewerEmailDomain={viewerEmailDomain}
          viewerTimezone={Intl.DateTimeFormat().resolvedOptions().timeZone}
          surface={introCallSurface}
          onBooked={handleIntroCallBooked}
          onMessage={handleIntroCallMessage}
        />
      )}
    </RequestCard>
  );
}
