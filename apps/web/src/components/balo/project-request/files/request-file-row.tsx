'use client';

import { FileText, FileSpreadsheet, Trash2, Loader2, Check } from 'lucide-react';
import { formatBytes } from '@/components/balo/document-uploader/upload-file';
import { formatRelativeTime } from '@/lib/format/relative-time';
import { Badge } from '@/components/ui/badge';
import { RequestFileAudienceBadges } from './request-file-audience-badges';
import type {
  ClientRequestFileView,
  ExpertRequestFileView,
  AdminRequestFileView,
} from '@/lib/request-files/request-file-audience-view';

function fileGlyph(contentType: string): React.JSX.Element {
  const isSpreadsheet = contentType.includes('spreadsheet') || contentType === 'text/csv';
  const Icon = isSpreadsheet ? FileSpreadsheet : FileText;
  return (
    <span className="bg-muted text-muted-foreground mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
      <Icon className="h-4 w-4" aria-hidden="true" />
    </span>
  );
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
        className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring flex h-11 w-11 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
      >
        {downloading ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <Check className="sr-only h-4 w-4" aria-hidden="true" />
        )}
        {!downloading && <span className="text-xs font-medium">Download</span>}
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
        {fileGlyph(file.contentType)}
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
                Removed · record retained
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
        {fileGlyph(file.contentType)}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{file.fileName}</div>
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
      {fileGlyph(file.contentType)}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{file.fileName}</div>
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
