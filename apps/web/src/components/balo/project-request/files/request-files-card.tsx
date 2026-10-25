'use client';

import { RequestCard } from '../request-card';
import { formatRelativeTime } from '@/lib/format/relative-time';
import { RequestFileAudienceBadges } from './request-file-audience-badges';
import { FileGlyph } from './file-glyph';
import { useDismissRequestSheet } from '../conversation/mobile-request-sheet';
import { useRequestFiles, type RequestFilesContextValue } from './request-files-provider';

const RECENT_COUNT = 2;

interface RequestFilesCardProps {
  /** `compact` is its own card in the request panel; `full` sits inside the hero card. */
  variant: 'compact' | 'full';
  /** The section eyebrow ("Files"), supplied by the server-rendered request context. */
  heading: React.ReactNode;
  /** The request brief's documents. */
  documents: React.ReactNode;
  documentCount: number;
  /** Today's documents block, rendered when the viewer has no file lens. */
  fallback: React.ReactNode;
}

interface RecentFile {
  id: string;
  fileName: string;
  contentType: string;
  uploadedByName: string;
  createdAtIso: string;
}

/**
 * ⚠ `view.lens` IS THE LOADER'S VIEW-SHAPE DISCRIMINANT (assigned from the gate's
 * already-capability-checked side), not a role re-read in the browser: it only picks which of
 * three server-decided shapes to present.
 */
function emptyInvitation(view: RequestFilesContextValue['view']): string {
  if (view.lens === 'client') {
    if (view.requestKind === 'direct') return 'Share a file from the conversation.';
    if (view.liveTracks.length === 0) return 'Files you share with experts will appear here.';
    return 'Share a file from the conversation — or with several experts from All files.';
  }
  if (view.lens === 'expert')
    return 'Share a file from the conversation. It goes to the client only.';
  // The admin lens is read-only by construction (the sole all-files read, gated on a platform
  // capability, with no upload, grant or delete path), so there is nothing to invite it toward:
  // a plain statement is the honest copy.
  return 'No files have been shared on this request yet.';
}

function RecentFileRow({
  file,
  files,
}: Readonly<{ file: RecentFile; files: RequestFilesContextValue }>): React.JSX.Element {
  const { view } = files;
  const clientFile = view.lens === 'client' ? view.files.find((f) => f.id === file.id) : undefined;
  const canOpen = view.lens !== 'admin';
  return (
    <li className="flex items-start gap-2.5 py-2">
      <FileGlyph contentType={file.contentType} className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {canOpen ? (
          <button
            type="button"
            onClick={() => files.preview(file, 'files_card')}
            disabled={files.previewingId === file.id}
            aria-label={`Open ${file.fileName}`}
            className="hover:text-primary focus-visible:ring-ring flex min-h-11 items-center truncate text-left text-[13.5px] font-medium focus-visible:ring-2 focus-visible:outline-none disabled:opacity-70"
          >
            <span className="truncate">{file.fileName}</span>
          </button>
        ) : (
          <p className="truncate text-[13.5px] font-medium">{file.fileName}</p>
        )}
        <p className="text-muted-foreground text-xs">
          {file.uploadedByName} · {formatRelativeTime(file.createdAtIso)}
        </p>
        {clientFile !== undefined && (
          <div className="flex flex-wrap items-center gap-1.5">
            <RequestFileAudienceBadges audience={clientFile.audience} />
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * The request panel's Files card (it replaces "Request documents"): the brief, the two newest
 * files the viewer can see, and "All files · n" to open the sheet. Without a file lens (no
 * provider, or none for this viewer) it renders today's documents block unchanged.
 */
export function RequestFilesCard({
  variant,
  heading,
  documents,
  documentCount,
  fallback,
}: Readonly<RequestFilesCardProps>): React.JSX.Element {
  const files = useRequestFiles();
  const dismissRequestSheet = useDismissRequestSheet();
  if (files === null) return <>{fallback}</>;

  const handleOpenAllFiles = (): void => {
    dismissRequestSheet?.();
    files.openAllFiles();
  };

  const { view } = files;
  const recent: RecentFile[] = view.files.slice(0, RECENT_COUNT);
  const body = (
    <>
      {heading}
      {documents}
      {recent.length > 0 ? (
        <ul className="divide-border mt-1 divide-y">
          {recent.map((file) => (
            <RecentFileRow key={file.id} file={file} files={files} />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground mt-3 text-[13px] leading-relaxed">
          {emptyInvitation(view)}
        </p>
      )}
      <button
        type="button"
        onClick={handleOpenAllFiles}
        className="border-border bg-card text-foreground hover:bg-muted focus-visible:ring-ring mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-lg border text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
      >
        All files · {documentCount + view.files.length}
      </button>
    </>
  );

  if (variant === 'compact') return <RequestCard className="p-4">{body}</RequestCard>;
  return <div className="mt-5">{body}</div>;
}
