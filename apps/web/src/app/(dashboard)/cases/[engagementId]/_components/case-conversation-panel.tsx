'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import { SectionHead } from '@/components/balo/section/section-states';
import { MessageList, type ThreadDataState } from '@/components/balo/conversation/message-list';
import { MessageComposer } from '@/components/balo/conversation/message-composer';
import { useConversationRealtime } from '@/components/balo/conversation/use-conversation-realtime';
import type {
  ConversationFileView,
  ConversationMessageView,
} from '@/lib/conversations/conversation-view-types';
import type { CaseConversationView } from '@/lib/cases/case-view-types';
import { createCaseRealtimeTokenAction } from '../_actions/create-case-realtime-token';
import { fetchCaseThreadAction } from '../_actions/fetch-case-thread';
import { postCaseMessageAction } from '../_actions/post-case-message';
import { markCaseThreadReadAction } from '../_actions/mark-case-thread-read';
import { requestCaseFileUploadAction } from '../_actions/request-case-file-upload';
import { confirmCaseFileUploadAction } from '../_actions/confirm-case-file-upload';
import { getCaseFileDownloadAction } from '../_actions/get-case-file-download';

/**
 * BAL-421 — the case's conversation region. It LEADS the main column, because between calls
 * the conversation is the case.
 *
 * ⚠⚠ THIS IS A CASE-GRAIN COMPOSITION OF SHARED LEAVES, NOT A FORK OF `conversation-stage`.
 * That component (~1030 lines) imports seven project-request Server Actions, builds
 * `/projects/{requestId}` hrefs and renders proposal/relationship UI — none of which a case
 * has. What IS reused is every genuinely anchor-agnostic leaf: `MessageList`,
 * `MessageComposer` and `useConversationRealtime`, all of which BAL-421 generalised off their
 * relationship-shaped props so BOTH surfaces feed the same components.
 *
 * ⚠ `introHtml={null}`. A project thread pins the expert's expression of interest above the
 * first page; a case has no EOI and nothing to pin. That is exactly why `MessageList` now
 * takes three scalars instead of a `ConversationThreadView`.
 *
 * ⚠ A CLOSED CASE IS READ-ONLY BUT FULLY READABLE. `writable` was composed ONCE at the gate
 * from `engagementConversationIsWritable(status)`; the composer is disabled from that single
 * value, and `postCaseMessageAction` re-checks it server-side. The two cannot disagree.
 */
export function CaseConversationPanel({
  engagementId,
  conversation,
  lens,
  viewerUserId,
}: Readonly<{
  engagementId: string;
  conversation: CaseConversationView;
  lens: 'client' | 'expert';
  viewerUserId: string;
}>): React.JSX.Element {
  const [messages, setMessages] = useState<ConversationMessageView[]>(conversation.initialMessages);
  const [files, setFiles] = useState<ConversationFileView[]>(conversation.initialFiles);
  const [hasEarlier, setHasEarlier] = useState(conversation.initialHasEarlier);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [state, setState] = useState<ThreadDataState>('ready');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState<{ fileName: string; progress: number } | null>(null);
  const [downloadingFileId, setDownloadingFileId] = useState<string | null>(null);

  // ── realtime ────────────────────────────────────────────────────────────────────────────
  const handleRealtimeMessage = useCallback((incoming: ConversationMessageView) => {
    setMessages((current) =>
      current.some((message) => message.id === incoming.id) ? current : [...current, incoming]
    );
  }, []);

  const handleRealtimeFile = useCallback((incoming: ConversationFileView) => {
    setFiles((current) =>
      current.some((file) => file.id === incoming.id) ? current : [incoming, ...current]
    );
  }, []);

  // ⚠⚠ MEMOIZED DELIBERATELY. `fetchToken` is an effect dependency inside the hook, so an
  // inline arrow would tear down and re-subscribe the Ably channel on EVERY RENDER — which
  // presents as flapping connectivity rather than as a bug.
  const fetchRealtimeToken = useCallback(
    () => createCaseRealtimeTokenAction({ engagementId }),
    [engagementId]
  );

  // ⚠ MEMOIZED, NOT REF-STABILISED. The hook takes an ARRAY (a project request fans out to
  // many threads); a case has exactly one. A fresh `[id]` literal on every render would re-run
  // the subscription effect and tear down the Ably channel each time — the same hazard
  // `fetchRealtimeToken` carries. `useMemo` is the correct tool: the previous ref-mutating
  // helper WROTE TO A REF DURING RENDER, which React explicitly forbids (it makes the render
  // impure and misbehaves under StrictMode double-render and concurrent re-entry).
  const conversationIds = useMemo(
    () => [conversation.conversationId],
    [conversation.conversationId]
  );

  useConversationRealtime({
    enabled: conversation.realtimeEnabled,
    fetchToken: fetchRealtimeToken,
    conversationIds,
    onMessage: handleRealtimeMessage,
    onFile: handleRealtimeFile,
  });

  // ── read watermark ──────────────────────────────────────────────────────────────────────
  // Fire-and-forget on mount: opening the case IS reading its thread. A failure is silent —
  // a watermark hiccup must never surface as an error on a page the viewer just opened.
  const markedRef = useRef(false);
  useEffect(() => {
    if (markedRef.current) return;
    markedRef.current = true;
    void markCaseThreadReadAction({ engagementId }).catch(() => {});
  }, [engagementId]);

  // ── paging ──────────────────────────────────────────────────────────────────────────────
  const handleLoadEarlier = useCallback(async () => {
    const [oldest] = messages;
    if (oldest === undefined) return;
    setLoadingEarlier(true);
    try {
      const result = await fetchCaseThreadAction({
        engagementId,
        before: { createdAtIso: oldest.createdAtIso, id: oldest.id },
        includeFiles: false,
      });
      if (!result.success) {
        setState('error');
        return;
      }
      setMessages((current) => [...result.messages, ...current]);
      setHasEarlier(result.hasEarlier);
    } catch {
      setState('error');
    } finally {
      setLoadingEarlier(false);
    }
  }, [engagementId, messages]);

  const handleRetry = useCallback(async () => {
    setState('loading');
    try {
      const result = await fetchCaseThreadAction({ engagementId, includeFiles: true });
      if (!result.success) {
        setState('error');
        return;
      }
      setMessages(result.messages);
      setHasEarlier(result.hasEarlier);
      setFiles(result.files ?? []);
      setState('ready');
    } catch {
      setState('error');
    }
  }, [engagementId]);

  // ── sending ─────────────────────────────────────────────────────────────────────────────
  const handleSend = useCallback(
    async (text: string): Promise<boolean> => {
      setSending(true);
      try {
        const result = await postCaseMessageAction({ engagementId, body: text });
        if (!result.success) {
          toast.error(result.error);
          return false;
        }
        setMessages((current) =>
          current.some((message) => message.id === result.message.id)
            ? current
            : [...current, result.message]
        );
        return true;
      } catch {
        toast.error('Could not send your message. Please try again.');
        return false;
      } finally {
        setSending(false);
      }
    },
    [engagementId]
  );

  // ── attaching ───────────────────────────────────────────────────────────────────────────
  const handleAttach = useCallback(
    async (file: File) => {
      setUploading({ fileName: file.name, progress: 0 });
      try {
        const presigned = await requestCaseFileUploadAction({
          engagementId,
          contentType: file.type,
          fileName: file.name,
        });
        if (!presigned.success) {
          toast.error(presigned.error);
          return;
        }

        await putWithProgress(presigned.presignedUrl, file, (progress) => {
          setUploading({ fileName: file.name, progress });
        });

        const confirmed = await confirmCaseFileUploadAction({
          engagementId,
          key: presigned.key,
          fileName: file.name,
          contentType: file.type,
          sizeBytes: file.size,
        });
        if (!confirmed.success) {
          toast.error(confirmed.error);
          return;
        }
        setFiles((current) =>
          current.some((existing) => existing.id === confirmed.file.id)
            ? current
            : [confirmed.file, ...current]
        );
        toast.success('File shared.');
      } catch {
        toast.error('Could not share your file. Please try again.');
      } finally {
        setUploading(null);
      }
    },
    [engagementId]
  );

  // ── downloading ─────────────────────────────────────────────────────────────────────────
  const handleFileClick = useCallback(
    async (file: ConversationFileView) => {
      setDownloadingFileId(file.id);
      try {
        const result = await getCaseFileDownloadAction({
          engagementId,
          origin: 'conversation',
          fileId: file.id,
        });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        globalThis.location.assign(result.url);
      } catch {
        toast.error('Could not download this file. Please try again.');
      } finally {
        setDownloadingFileId(null);
      }
    },
    [engagementId]
  );

  return (
    <section className="bg-card border-border rounded-3xl border px-5 py-4">
      <SectionHead icon={MessageSquare} title="Conversation" meta="Free — between calls" />

      {/*
       * ⚠ THIS BOUND IS LOAD-BEARING, NOT COSMETIC. `MessageList` is `flex flex-1 flex-col
       * overflow-y-auto`, which only becomes a scroll region inside a BOUNDED FLEX COLUMN —
       * the project-request caller supplies `STAGE_CARD_CLASS` for exactly this reason.
       * Unbounded, `flex-1` is inert and `overflow-y-auto` never engages: the card grows to
       * the full height of the thread, pushing the consultations list and the entire rail
       * off screen, and `MessageList`'s scroll-to-bottom and load-earlier anchoring both
       * write `scrollTop` on a non-scrolling element — so a returning viewer silently lands
       * on the OLDEST message. `max-h` (not `h`) so a short thread still hugs its content.
       * Matches the design reference's v6 decision (`case-surface.jsx:751`, maxHeight 340).
       * The composer sits OUTSIDE this bound so it stays pinned below the scroll region.
       */}
      <div className="flex max-h-[340px] flex-col overflow-hidden">
        <MessageList
          // A case has ONE thread for life, so its conversation id is the stable scroll key.
          threadKey={conversation.conversationId}
          counterpartyFirstName={conversation.counterpartyFirstName}
          introHtml={null}
          lens={lens}
          viewerUserId={viewerUserId}
          state={state}
          messages={messages}
          files={files}
          hasEarlier={hasEarlier}
          loadingEarlier={loadingEarlier}
          downloadingFileId={downloadingFileId}
          onLoadEarlier={handleLoadEarlier}
          onRetry={handleRetry}
          onFileClick={handleFileClick}
        />
      </div>

      {conversation.writable ? (
        <div className="mt-2">
          <MessageComposer
            expertFirstName={conversation.counterpartyFirstName}
            sending={sending}
            uploading={uploading}
            value={draft}
            onChange={setDraft}
            onSend={handleSend}
            onAttach={handleAttach}
          />
          <p className="text-muted-foreground mt-2 text-xs">
            {lens === 'client'
              ? 'Messages are free. Book a consultation when you need time on a call.'
              : 'Messages are free and unbilled — only consultations are.'}
          </p>
        </div>
      ) : (
        <p className="text-muted-foreground mt-3 text-xs">
          This case is closed, so the conversation is read-only.
        </p>
      )}
    </section>
  );
}

/**
 * PUT the object to R2 with real upload progress.
 *
 * ⚠ XHR RATHER THAN `fetch`, DELIBERATELY: `fetch` still cannot report upload progress in any
 * shipping browser, and the composer renders a progress strip. Resolves on 2xx and rejects
 * otherwise, so the caller's `catch` covers a network failure and a rejected signature alike.
 */
async function putWithProgress(
  url: string,
  file: File,
  onProgress: (progress: number) => void
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', url);
    request.setRequestHeader('Content-Type', file.type);
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });
    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload failed with status ${request.status}`));
      }
    });
    request.addEventListener('error', () => {
      reject(new Error('Upload failed'));
    });
    request.send(file);
  });
}
