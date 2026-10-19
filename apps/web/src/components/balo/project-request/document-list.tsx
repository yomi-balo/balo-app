'use client';

import { useState } from 'react';
import { Download, FileText, Loader2, Paperclip } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/components/balo/document-uploader/upload-file';
import type { RequestDocumentView } from '@/lib/project-request/request-detail-view';
import { getRequestDocumentDownloadAction } from '@/app/(dashboard)/projects/[requestId]/_actions/get-request-document-download';

interface DocumentListProps {
  requestId: string;
  documents: RequestDocumentView[];
  /** Tighter rows for the compact Phase-2 card. */
  compact?: boolean;
}

/**
 * The request brief's attached documents (filename + size). Each row opens a short-lived
 * presigned download minted by `getRequestDocumentDownloadAction`. Follows the balo-ui
 * empty-state rule: attachments are retrospective data the viewer can't add from here, so an
 * empty list shows a neutral note rather than an invitation.
 */
export function DocumentList({
  requestId,
  documents,
  compact = false,
}: Readonly<DocumentListProps>): React.JSX.Element {
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  async function handleDownload(documentId: string): Promise<void> {
    setDownloadingId(documentId);
    try {
      const result = await getRequestDocumentDownloadAction({ requestId, documentId });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      globalThis.open(result.url, '_blank', 'noopener,noreferrer');
    } finally {
      setDownloadingId(null);
    }
  }

  if (documents.length === 0) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Paperclip className="h-4 w-4 shrink-0" aria-hidden="true" />
        No documents attached.
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {documents.map((doc) => {
        const downloading = downloadingId === doc.id;
        return (
          <li key={doc.id}>
            <button
              type="button"
              onClick={() => void handleDownload(doc.id)}
              disabled={downloading}
              aria-label={`Download ${doc.fileName}`}
              className={cn(
                'group border-border hover:bg-muted/50 focus-visible:ring-ring flex w-full items-center gap-2.5 rounded-lg border px-3 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60',
                compact ? 'py-1.5' : 'py-2'
              )}
            >
              <span className="bg-destructive/10 flex h-7 w-7 shrink-0 items-center justify-center rounded-md">
                <FileText className="text-destructive h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <span className="text-foreground min-w-0 flex-1 truncate text-sm">
                {doc.fileName}
              </span>
              <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
                {formatBytes(doc.sizeBytes)}
              </span>
              {downloading ? (
                <Loader2
                  className="text-muted-foreground h-4 w-4 shrink-0 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <Download
                  className="text-muted-foreground group-hover:text-foreground h-4 w-4 shrink-0 transition-colors"
                  aria-hidden="true"
                />
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
