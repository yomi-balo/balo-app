'use client';

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { ChevronUp, FileText, Loader2, MessageSquare, RotateCcw, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { RichTextViewer } from '@/components/balo/rich-text-editor';
import { formatBytes } from '@/components/balo/document-uploader/upload-file';
import type {
  ConversationFileView,
  ConversationMessageView,
  ConversationThreadView,
} from '@/lib/project-request/conversation-view-types';
import { MessageBubbleHtml } from './message-bubble-html';

export type ThreadDataState = 'loading' | 'error' | 'ready';

interface MessageListProps {
  thread: ConversationThreadView;
  lens: 'client' | 'expert';
  viewerUserId: string;
  state: ThreadDataState;
  messages: ConversationMessageView[];
  files: ConversationFileView[];
  hasEarlier: boolean;
  loadingEarlier: boolean;
  downloadingFileId: string | null;
  onLoadEarlier: () => void;
  onRetry: () => void;
  onFileClick: (file: ConversationFileView) => void;
}

type TimelineItem =
  | { kind: 'message'; at: string; id: string; message: ConversationMessageView }
  | { kind: 'file'; at: string; id: string; file: ConversationFileView };

function buildTimeline(
  messages: ConversationMessageView[],
  files: ConversationFileView[]
): TimelineItem[] {
  const items: TimelineItem[] = [
    ...messages.map((message) => ({
      kind: 'message' as const,
      at: message.createdAtIso,
      id: message.id,
      message,
    })),
    ...files.map((file) => ({ kind: 'file' as const, at: file.createdAtIso, id: file.id, file })),
  ];
  return items.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

const SCROLL_STICK_THRESHOLD_PX = 96;

/**
 * Merged chronological timeline of message + file bubbles. Own activity is
 * right-aligned (primary tint) for BOTH lenses; the other party sits left
 * (muted). The client-lens EOI intro card pins at the very top of the FULLY
 * loaded thread (it is rendered FROM the live EOI row — never a message row).
 * Auto-scrolls to the bottom on thread switch + append unless the user has
 * scrolled up. Four states: loading skeleton / inline error + retry / empty
 * invitation / the timeline.
 */
export function MessageList({
  thread,
  lens,
  viewerUserId,
  state,
  messages,
  files,
  hasEarlier,
  loadingEarlier,
  downloadingFileId,
  onLoadEarlier,
  onRetry,
  onFileClick,
}: Readonly<MessageListProps>): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  // Scroll anchoring for "Load earlier": height + offset captured at click so
  // prepended messages don't shove the viewport (scrollTop is re-offset by the
  // height delta right after the prepend commits, before paint).
  const anchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const items = buildTimeline(messages, files);

  const handleScroll = useCallback((): void => {
    const el = containerRef.current;
    if (el === null) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_STICK_THRESHOLD_PX;
  }, []);

  const handleLoadEarlierClick = useCallback((): void => {
    const el = containerRef.current;
    if (el !== null) {
      anchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
    }
    onLoadEarlier();
  }, [onLoadEarlier]);

  // Restore the anchored viewport once the earlier page has landed (or the
  // fetch settled without one — delta 0 restores the captured position).
  const itemCount = items.length;
  useLayoutEffect(() => {
    if (loadingEarlier) return;
    const el = containerRef.current;
    const anchor = anchorRef.current;
    if (el !== null && anchor !== null) {
      el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
    }
    anchorRef.current = null;
  }, [loadingEarlier, itemCount]);

  // Jump to the bottom on thread switch; follow appends while stuck to bottom.
  useEffect(() => {
    const el = containerRef.current;
    if (el !== null && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [thread.relationshipId, itemCount]);
  useEffect(() => {
    // A fresh thread always starts pinned to its live edge.
    stickToBottomRef.current = true;
    const el = containerRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [thread.relationshipId]);

  if (state === 'loading') {
    return (
      <div className="flex flex-1 flex-col gap-3 overflow-hidden px-4 py-4" aria-busy="true">
        <div className="bg-muted h-12 w-3/5 animate-pulse self-start rounded-2xl rounded-bl-sm" />
        <div className="bg-muted h-9 w-2/5 animate-pulse self-end rounded-2xl rounded-br-sm" />
        <div className="bg-muted h-14 w-1/2 animate-pulse self-start rounded-2xl rounded-bl-sm" />
        <span className="sr-only">Loading conversation…</span>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
        <p className="text-foreground text-sm font-semibold">
          Couldn&apos;t load this conversation
        </p>
        <p className="text-muted-foreground max-w-xs text-sm leading-relaxed">
          Your other threads are untouched — try this one again.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="border-border bg-card text-foreground focus-visible:ring-ring inline-flex min-h-11 items-center gap-1.5 rounded-[10px] border px-4 text-[13px] font-semibold focus-visible:ring-2 focus-visible:outline-none"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          Retry
        </button>
      </div>
    );
  }

  const showEoiIntro = lens === 'client' && thread.eoiHtml !== null && !hasEarlier;
  const isEmpty = items.length === 0 && !showEoiIntro;

  if (isEmpty) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
        <span className="bg-muted mb-3 flex h-11 w-11 items-center justify-center rounded-xl">
          <MessageSquare className="text-muted-foreground h-5 w-5" aria-hidden="true" />
        </span>
        <p className="text-foreground text-sm font-semibold">
          Start the conversation with {lens === 'expert' ? 'the client' : thread.expertFirstName}
        </p>
        <p className="text-muted-foreground mt-1.5 max-w-sm text-sm leading-relaxed">
          Share context, ask a question, or drop a file — they&apos;ll be notified right away.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-4"
    >
      {showEoiIntro && thread.eoiHtml !== null && (
        <div className="border-primary/20 bg-primary/5 rounded-xl border p-3.5">
          <div className="mb-1.5 flex items-center gap-1.5">
            <Sparkles className="text-primary h-3.5 w-3.5" aria-hidden="true" />
            <span className="text-primary text-[10.5px] font-bold tracking-wider uppercase">
              Expression of interest
            </span>
          </div>
          <RichTextViewer value={thread.eoiHtml} className="text-sm" />
        </div>
      )}

      {hasEarlier && (
        <button
          type="button"
          onClick={handleLoadEarlierClick}
          disabled={loadingEarlier}
          className="border-border bg-card text-muted-foreground hover:text-foreground focus-visible:ring-ring mx-auto inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3.5 text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60 lg:min-h-9"
        >
          {loadingEarlier ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          Load earlier
        </button>
      )}

      {items.map((item) => {
        const isOwn =
          item.kind === 'message'
            ? item.message.senderUserId === viewerUserId
            : item.file.uploadedByUserId === viewerUserId;

        if (item.kind === 'message') {
          return (
            <div
              key={item.id}
              className={cn(
                'max-w-[82%] rounded-2xl px-3.5 py-2.5',
                isOwn
                  ? 'border-primary/25 bg-primary/10 self-end rounded-br-sm border'
                  : 'bg-muted self-start rounded-bl-sm'
              )}
            >
              <MessageBubbleHtml html={item.message.bodyHtml} className="text-foreground" />
            </div>
          );
        }

        const isDownloading = downloadingFileId === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onFileClick(item.file)}
            disabled={isDownloading}
            className={cn(
              'flex min-h-11 max-w-[82%] items-center gap-2.5 rounded-2xl border px-3 py-2.5 text-left transition-colors',
              'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none disabled:opacity-70',
              isOwn
                ? 'border-primary/25 bg-card hover:bg-primary/5 self-end rounded-br-sm'
                : 'border-border bg-card hover:bg-muted/60 self-start rounded-bl-sm'
            )}
          >
            <span className="bg-primary/10 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
              {isDownloading ? (
                <Loader2 className="text-primary h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <FileText className="text-primary h-4 w-4" aria-hidden="true" />
              )}
            </span>
            <span className="min-w-0">
              <span className="text-foreground block truncate text-[13px] font-semibold">
                {item.file.fileName}
              </span>
              <span className="text-muted-foreground block text-[11px]">
                {formatBytes(item.file.sizeBytes)}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
