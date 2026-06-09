import { FileText, Paperclip } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/components/balo/document-uploader/upload-file';
import type { RequestDocumentView } from '@/lib/project-request/request-detail-view';

interface DocumentListProps {
  documents: RequestDocumentView[];
  /** Tighter rows for the compact Phase-2 card. */
  compact?: boolean;
}

/**
 * Display-only list of the request's attached documents (filename + size). The R2
 * signed-URL download wiring is a separate file ticket — rows are not yet
 * clickable. Follows the balo-ui empty-state rule: attachments are retrospective
 * data the viewer can't add from here, so an empty list shows a neutral note
 * rather than an invitation.
 */
export function DocumentList({
  documents,
  compact = false,
}: Readonly<DocumentListProps>): React.JSX.Element {
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
      {documents.map((doc) => (
        <li
          key={doc.id}
          className={cn(
            'border-border flex items-center gap-2.5 rounded-lg border px-3',
            compact ? 'py-1.5' : 'py-2'
          )}
        >
          <span className="bg-destructive/10 flex h-7 w-7 shrink-0 items-center justify-center rounded-md">
            <FileText className="text-destructive h-3.5 w-3.5" aria-hidden="true" />
          </span>
          <span className="text-foreground min-w-0 flex-1 truncate text-sm">{doc.fileName}</span>
          <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
            {formatBytes(doc.sizeBytes)}
          </span>
        </li>
      ))}
    </ul>
  );
}
