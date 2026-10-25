'use client';

import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/components/balo/document-uploader/upload-file';
import { MessageBubbleHtml } from '@/components/balo/conversation/message-bubble-html';
import type { ConversationMessageView } from '@/lib/conversations/conversation-view-types';
import { FileGlyph } from './file-glyph';
import { RequestFileAudienceBadges } from './request-file-audience-badges';
import { useRequestFiles } from './request-files-provider';

interface ThreadFileCardProps {
  message: ConversationMessageView;
  /** The viewer sent it — the card sits right, in the primary tint. */
  mine: boolean;
}

/** The fields every card kind carries about its file. */
interface CardFile {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

function RemovedCard({
  fileName,
  mine,
}: Readonly<{ fileName: string; mine: boolean }>): React.JSX.Element {
  return (
    <div
      className={cn(
        'border-border bg-card flex max-w-full items-center gap-2.5 rounded-2xl border px-3 py-2.5',
        mine ? 'self-end' : 'self-start'
      )}
    >
      <FileGlyph contentType="" />
      <span className="min-w-0">
        <span className="text-muted-foreground block truncate text-[13px] font-semibold line-through">
          {fileName}
        </span>
        <span className="text-muted-foreground block text-[11px]">Removed</span>
      </span>
    </div>
  );
}

/**
 * A file shared into the conversation: the file, the sharer's note and — for the client — the
 * file's CURRENT audience. The server resolves the card per viewer, so an expert's card has no
 * audience to show and a file deleted after it was shared reads as a removed tombstone with no
 * actions. The file row is the only control; the note and badges sit outside it, so no control
 * is ever nested in another.
 */
export function ThreadFileCard({
  message,
  mine,
}: Readonly<ThreadFileCardProps>): React.JSX.Element | null {
  const files = useRequestFiles();
  const card = message.requestSharedFile;
  if (card === undefined) return null;
  if (card.kind === 'client_removed') return <RemovedCard fileName={card.fileName} mine={mine} />;

  const file: CardFile = card.file;
  const busy = files?.previewingId === file.id;
  const hasNote = message.bodyHtml.trim() !== '';

  return (
    <div className={cn('flex flex-col gap-1', mine ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'flex max-w-full flex-col gap-1.5 rounded-2xl border px-3 py-2',
          mine ? 'border-primary/25 bg-primary/10' : 'border-border bg-card'
        )}
      >
        <button
          type="button"
          disabled={files === null || busy}
          onClick={() => files?.preview(file, 'thread_card')}
          aria-label={`Open ${file.fileName}`}
          className="focus-visible:ring-ring flex min-h-11 items-center gap-2.5 text-left focus-visible:ring-2 focus-visible:outline-none disabled:opacity-70"
        >
          <FileGlyph contentType={file.contentType} />
          <span className="min-w-0">
            <span className="text-foreground block truncate text-[13px] font-semibold">
              {file.fileName}
            </span>
            <span className="text-muted-foreground block text-[11px]">
              {formatBytes(file.sizeBytes)}
            </span>
          </span>
          {busy && (
            <Loader2 className="text-primary h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
          )}
        </button>
        {hasNote && <MessageBubbleHtml html={message.bodyHtml} className="text-foreground" />}
      </div>
      {card.kind === 'client' && (
        <div className="flex flex-wrap items-center gap-1.5">
          <RequestFileAudienceBadges audience={card.file.audience} />
        </div>
      )}
    </div>
  );
}
