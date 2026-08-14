'use client';

import { Download, FileText, Image as ImageIcon, Loader2, Paperclip } from 'lucide-react';
import { formatBytes } from '@/components/balo/document-uploader/upload-file';
import type { MeetingFileView } from '@/lib/meetings/meeting-file-view-types';

/**
 * BAL-436 — ONE file row: glyph · name · "{who} · {size}" · download.
 *
 * ── ⚠⚠ THE UPLOADER LABEL IS A NAME OR "You" — **NEVER AN EMAIL ADDRESS, NEVER AN ID** ────
 *
 * The shipped `FilesCard` rule, and it binds harder here: the payload carries
 * `uploadedByUserId` only, so the label is resolved from the LIVE Daily roster where possible
 * (the server-minted `user_name` claim of a present participant) and falls back to the neutral
 * "A participant". A raw uuid in visible markup is the defect `OverflowAvatar` already fixed
 * once on this surface.
 *
 * ── ⚠ A PAPERCLIP ON A CHAT-ORIGINATED ROW IS THE **ONLY** SOURCE DISTINCTION ────────────
 *
 * D0's acceptance criterion is a UNIFIED store: chat attachments and Files-tab drops live in
 * one table and this list shows both, unfiltered and ungrouped. The glyph aids scanning; it is
 * not a category. Adding a `source` filter or a second section here would undo the AC.
 */

/** ⚠ A LOOKUP, NOT A NESTED TERNARY (SonarCloud S3358). */
function glyphFor(contentType: string, isFromChat: boolean): React.JSX.Element {
  if (isFromChat) return <Paperclip className="h-[18px] w-[18px]" aria-hidden="true" />;
  if (contentType.startsWith('image/')) {
    return <ImageIcon className="h-[18px] w-[18px]" aria-hidden="true" />;
  }
  return <FileText className="h-[18px] w-[18px]" aria-hidden="true" />;
}

export interface FilesPanelRowProps {
  readonly file: MeetingFileView;
  /** A first name, "You", or the neutral fallback. ⚠ NEVER an address, never an id. */
  readonly uploaderLabel: string;
  readonly onDownload: (fileId: string) => void;
  readonly isDownloading: boolean;
}

export function FilesPanelRow({
  file,
  uploaderLabel,
  onDownload,
  isDownloading,
}: Readonly<FilesPanelRowProps>): React.JSX.Element {
  const isFromChat = file.source === 'chat';

  return (
    <li className="flex items-center gap-3 rounded-lg px-2 py-2.5">
      <span className="bg-muted text-muted-foreground flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-lg">
        {glyphFor(file.contentType, isFromChat)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-foreground truncate text-sm font-medium">{file.fileName}</p>
        <p className="text-muted-foreground truncate text-xs">
          {uploaderLabel} · {formatBytes(file.sizeBytes)}
          {isFromChat ? ' · shared in chat' : ''}
        </p>
      </div>
      {isDownloading ? (
        <Loader2
          data-testid="file-row-spinner"
          className="text-muted-foreground h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : (
        <button
          type="button"
          onClick={() => onDownload(file.id)}
          // ⚠ THE ACCESSIBLE NAME CARRIES THE FILE. Eight rows of "Download, button" tells a
          // screen-reader user nothing about which row they are on.
          aria-label={`Download ${file.fileName}`}
          className="text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </li>
  );
}
