'use client';

import { FileText, Loader2, Paperclip, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { formatBytes } from '@/components/balo/document-uploader/upload-file';
import type { ConversationFileView } from '@/lib/project-request/conversation-view-types';
import type { ThreadDataState } from './message-list';

interface ThreadFilesPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The active thread's fetch state — drives skeleton/error before "empty". */
  state: ThreadDataState;
  /** Newest first. */
  files: ConversationFileView[];
  downloadingFileId: string | null;
  onDownload: (file: ConversationFileView) => void;
  /** Re-runs the active thread's fetch (shared with the message list's Retry). */
  onRetry: () => void;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Compact relative timestamp for file rows ("just now", "3h ago", "2d ago"). */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const diff = now.getTime() - Date.parse(iso);
  if (diff < MINUTE_MS) return 'just now';
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m ago`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h ago`;
  const days = Math.floor(diff / DAY_MS);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

/**
 * The durable Files index for one thread — shadcn `Sheet` as the sanctioned
 * drawer: right slide-over on desktop, bottom sheet on mobile (`useIsMobile`,
 * 1024px split matching the shell's `lg:`). Rows presign a GET on click.
 */
export function ThreadFilesPanel({
  open,
  onOpenChange,
  state,
  files,
  downloadingFileId,
  onDownload,
  onRetry,
}: Readonly<ThreadFilesPanelProps>): React.JSX.Element {
  const isMobile = useIsMobile();

  let body: React.JSX.Element;
  if (state === 'loading') {
    body = (
      <div className="flex flex-col gap-2" aria-busy="true">
        <div className="bg-muted h-14 w-full animate-pulse rounded-[10px]" />
        <div className="bg-muted h-14 w-full animate-pulse rounded-[10px]" />
        <div className="bg-muted h-14 w-full animate-pulse rounded-[10px]" />
        <span className="sr-only">Loading shared files…</span>
      </div>
    );
  } else if (state === 'error') {
    body = (
      <div className="px-4 py-8 text-center">
        <p className="text-foreground text-[13px] font-semibold">Couldn&apos;t load files</p>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
          Reload this conversation to try again.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="border-border bg-card text-foreground focus-visible:ring-ring mx-auto mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-[10px] border px-4 text-[13px] font-semibold focus-visible:ring-2 focus-visible:outline-none"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          Retry
        </button>
      </div>
    );
  } else if (files.length === 0) {
    body = (
      <div className="px-4 py-8 text-center">
        <span className="bg-muted mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-[11px]">
          <Paperclip className="text-muted-foreground h-4.5 w-4.5" aria-hidden="true" />
        </span>
        <p className="text-foreground text-[13px] font-semibold">No files shared yet</p>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
          Drop a file in the conversation and it&apos;ll show up here for both of you.
        </p>
      </div>
    );
  } else {
    body = (
      <ul className="flex flex-col gap-2">
        {files.map((file) => {
          const isDownloading = downloadingFileId === file.id;
          return (
            <li key={file.id}>
              <button
                type="button"
                onClick={() => onDownload(file)}
                disabled={isDownloading}
                className="border-border bg-card hover:bg-muted/50 focus-visible:ring-ring flex min-h-11 w-full items-center gap-2.5 rounded-[10px] border px-3 py-2.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-70"
              >
                <span className="bg-primary/10 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
                  {isDownloading ? (
                    <Loader2 className="text-primary h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <FileText className="text-primary h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-foreground block truncate text-[13px] font-semibold">
                    {file.fileName}
                  </span>
                  <span className="text-muted-foreground block text-[11px]">
                    {file.uploadedByName} · {formatRelativeTime(file.createdAtIso)} ·{' '}
                    {formatBytes(file.sizeBytes)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        aria-describedby={undefined}
        side={isMobile ? 'bottom' : 'right'}
        className={cn(
          'gap-0',
          isMobile ? 'max-h-[82vh] rounded-t-2xl' : 'w-[320px] sm:max-w-[320px]'
        )}
      >
        <SheetHeader className="border-border border-b pb-3">
          <SheetTitle className="flex items-center gap-2 text-sm">
            <Paperclip className="text-primary h-4 w-4" aria-hidden="true" />
            Shared in this conversation
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-3">{body}</div>
      </SheetContent>
    </Sheet>
  );
}
