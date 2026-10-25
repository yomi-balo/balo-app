'use client';

import { Trash2, Loader2, Check } from 'lucide-react';
import { formatBytes } from '@/components/balo/document-uploader/upload-file';
import { formatRelativeTime } from '@/lib/format/relative-time';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { FileGlyph } from './file-glyph';
import { RequestFileAudienceBadges } from './request-file-audience-badges';
import type {
  ClientRequestFileView,
  ExpertRequestFileView,
  AdminRequestFileView,
} from '@/lib/request-files/request-file-audience-view';

interface FileNameProps {
  fileName: string;
  /** Present ⇒ the name previews on click (images and PDFs) or downloads (anything else). */
  onPreview?: () => void;
  previewing: boolean;
  className?: string;
}

/** The file name — a button when the row can preview, plain text for the read-only admin row. */
function FileName({
  fileName,
  onPreview,
  previewing,
  className,
}: Readonly<FileNameProps>): React.JSX.Element {
  if (onPreview === undefined) {
    return <div className={cn('truncate text-sm font-medium', className)}>{fileName}</div>;
  }
  return (
    <button
      type="button"
      onClick={onPreview}
      disabled={previewing}
      aria-label={`Open ${fileName}`}
      className={cn(
        'hover:text-primary focus-visible:ring-ring flex min-h-11 w-full items-center gap-1.5 truncate text-left text-sm font-medium focus-visible:ring-2 focus-visible:outline-none disabled:opacity-70',
        className
      )}
    >
      <span className="truncate">{fileName}</span>
      {previewing && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />}
    </button>
  );
}

function previewHandlerOf(
  onPreview: ((id: string) => void) | undefined,
  id: string
): (() => void) | undefined {
  return onPreview === undefined ? undefined : () => onPreview(id);
}

interface RequestFileRowActionsProps {
  fileName: string;
  onDownload: () => void;
  onDelete?: () => void;
  downloading: boolean;
  deleting: boolean;
}

function RequestFileRowActions({
  fileName,
  onDownload,
  onDelete,
  downloading,
  deleting,
}: Readonly<RequestFileRowActionsProps>): React.JSX.Element {
  return (
    <div className="mt-0.5 flex shrink-0 items-center gap-1">
      <button
        type="button"
        onClick={onDownload}
        disabled={downloading}
        aria-label={`Download ${fileName}`}
        className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring flex min-h-11 min-w-11 items-center justify-center rounded-md px-2.5 focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
      >
        {downloading ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <span className="text-xs font-medium">Download</span>
        )}
      </button>
      {onDelete !== undefined && (
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting}
          aria-label={`Remove ${fileName}`}
          className="text-muted-foreground hover:bg-muted hover:text-destructive focus-visible:ring-ring flex h-11 w-11 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
        >
          {deleting ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      )}
    </div>
  );
}

interface ClientRequestFileRowProps {
  lens: 'client';
  file: ClientRequestFileView;
  onDownload: (id: string) => void;
  onDelete: (id: string) => void;
  onRevoke: (fileId: string, relationshipId: string, trackName: string) => void;
  onPreview?: (id: string) => void;
  previewingId?: string | null;
  downloadingId: string | null;
  deletingId: string | null;
  revokingRelationshipId: string | null;
}

interface ExpertRequestFileRowProps {
  lens: 'expert';
  file: ExpertRequestFileView;
  /** The client party's display name — the SUBJECT of the own-upload privacy badge. */
  clientPartyName: string;
  onDownload: (id: string) => void;
  onDelete: (id: string) => void;
  onPreview?: (id: string) => void;
  previewingId?: string | null;
  downloadingId: string | null;
  deletingId: string | null;
}

interface AdminRequestFileRowProps {
  lens: 'admin';
  file: AdminRequestFileView;
}

export type RequestFileRowProps =
  | ClientRequestFileRowProps
  | ExpertRequestFileRowProps
  | AdminRequestFileRowProps;

/**
 * ONE row component, audience-keyed by the lens's view shape — the three lenses are three view
 * shapes, not three components (BAL-431 §7.2).
 */
export function RequestFileRow(props: Readonly<RequestFileRowProps>): React.JSX.Element {
  if (props.lens === 'admin') {
    const { file } = props;
    return (
      <li className="flex items-start gap-3 px-4 py-3">
        <FileGlyph contentType={file.contentType} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div
            className={
              file.deleted
                ? 'text-muted-foreground truncate text-sm font-medium line-through'
                : 'truncate text-sm font-medium'
            }
          >
            {file.fileName}
          </div>
          <div className="text-muted-foreground mt-0.5 text-xs">
            {file.uploadedByName} · {formatRelativeTime(file.createdAtIso)} ·{' '}
            {formatBytes(file.sizeBytes)} ·{' '}
            {file.side === 'expert' ? 'expert upload, own track' : `audience: ${file.audience}`}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {file.deleted && (
              <Badge className="bg-amber-50 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                Removed · audit record kept
              </Badge>
            )}
            <span className="text-muted-foreground text-xs">Visible now to:</span>
            {file.visibleTo.length === 0 && (
              <span className="text-muted-foreground text-xs">no experts</span>
            )}
            {file.visibleTo.map((v) => (
              <Badge key={v.relationshipId} variant="secondary" className="gap-1 text-xs">
                <Check className="h-2.5 w-2.5 text-emerald-500" aria-hidden="true" />
                {v.trackName}
              </Badge>
            ))}
          </div>
        </div>
      </li>
    );
  }

  if (props.lens === 'expert') {
    const { file } = props;
    return (
      <li className="flex items-start gap-3 px-4 py-3">
        <FileGlyph contentType={file.contentType} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <FileName
            fileName={file.fileName}
            onPreview={previewHandlerOf(props.onPreview, file.id)}
            previewing={props.previewingId === file.id}
          />
          <div className="text-muted-foreground mt-0.5 text-xs">
            {file.uploadedByName} · {formatRelativeTime(file.createdAtIso)} ·{' '}
            {formatBytes(file.sizeBytes)}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {/*
              ⚠ THE EXPERT'S OWN UPLOAD, NOT A CLIENT FILE. This badge is the ONE piece of
              reassurance the concealment model owes an expert: their upload is hard-fixed to
              their own track and no competing candidate can see it (ADR-1048 §1). The subject
              is therefore the CLIENT PARTY — where the file went — never `uploadedByName`,
              which for an own upload is literally "You".
            */}
            {file.source === 'you' && (
              <Badge variant="secondary" className="text-xs font-medium">
                Visible to {props.clientPartyName} only
              </Badge>
            )}
            {file.sharedBeforeYouJoined && (
              <Badge className="bg-emerald-50 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                Shared before you joined
              </Badge>
            )}
          </div>
        </div>
        <RequestFileRowActions
          fileName={file.fileName}
          onDownload={() => props.onDownload(file.id)}
          onDelete={file.canDelete ? () => props.onDelete(file.id) : undefined}
          downloading={props.downloadingId === file.id}
          deleting={props.deletingId === file.id}
        />
      </li>
    );
  }

  const { file } = props;
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <FileGlyph contentType={file.contentType} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <FileName
          fileName={file.fileName}
          onPreview={previewHandlerOf(props.onPreview, file.id)}
          previewing={props.previewingId === file.id}
        />
        <div className="text-muted-foreground mt-0.5 text-xs">
          {file.uploadedByName} · {formatRelativeTime(file.createdAtIso)} ·{' '}
          {formatBytes(file.sizeBytes)}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <RequestFileAudienceBadges
            audience={file.audience}
            onRevoke={(relationshipId, trackName) =>
              props.onRevoke(file.id, relationshipId, trackName)
            }
            revokingRelationshipId={props.revokingRelationshipId}
          />
        </div>
      </div>
      <RequestFileRowActions
        fileName={file.fileName}
        onDownload={() => props.onDownload(file.id)}
        onDelete={file.canDelete ? () => props.onDelete(file.id) : undefined}
        downloading={props.downloadingId === file.id}
        deleting={props.deletingId === file.id}
      />
    </li>
  );
}
