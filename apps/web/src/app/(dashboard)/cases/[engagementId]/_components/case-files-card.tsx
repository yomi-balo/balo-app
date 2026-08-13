'use client';

import { useCallback, useState } from 'react';
import { Download, Folder, Loader2, Paperclip } from 'lucide-react';
import { toast } from 'sonner';
import { SectionHead } from '@/components/balo/section/section-states';
import { track, RECAP_EVENTS } from '@/lib/analytics';
import type { CaseFileRowView } from '@/lib/cases/case-view-types';
import { getCaseFileDownloadAction } from '../_actions/get-case-file-download';

/**
 * BAL-421 §D4 — the MERGED files card: `meeting_files` ∪ `conversation_files`, on read.
 *
 * ⚠⚠ EACH ROW CARRIES ITS `origin`, AND THE DOWNLOAD BRANCHES ON IT. The two tables are not
 * views of each other and each keeps its OWN authorization helper server-side — a meeting file
 * goes through BAL-423's `authorizeMeetingFileAccess` (with its meeting as a WHERE term), a
 * conversation file through the case gate plus a conversation-scoped lookup. Flattening
 * `origin` here would be the first step towards one gate over two tables.
 *
 * ⚠ `r2Key` IS STRUCTURALLY ABSENT FROM `CaseFileRowView`. The download resolves the key
 * SERVER-SIDE and returns a 300-second presigned GET; the browser never sees an object
 * locator, and a stale URL stops working because R2 rejects the expired signature.
 *
 * ⚠ TRUNCATION IS STATED OUT LOUD. `filesTruncated` means the merge was bounded — and because
 * `listByMeeting` caps OLDEST-FIRST, hitting that cap drops the NEWEST files. Silently showing
 * a partial list as if it were complete is the failure this line exists to prevent.
 *
 * ⚠⚠ THE EMPTY STATE IS LENS-OF-LIFECYCLE, NOT ONE STRING. While the case is OPEN the section
 * INVITES ("Share a file … in the conversation") — the balo-ui rule that an actionable empty
 * section keeps invitation copy rather than absence copy. On a CLOSED case the composer is
 * read-only, so that invitation names an action THIS VERY SURFACE has already refused; the copy
 * turns RETROSPECTIVE instead. That is CLAUDE.md's own stated exception to the keep-empty-
 * sections rule — hide/neutralise only what the user can no longer act on — and it is why this
 * component must be told `isOpen` rather than inferring it.
 */
export function CaseFilesCard({
  engagementId,
  files,
  truncated,
  lens,
  isOpen,
  counterpartyFirstName,
}: Readonly<{
  engagementId: string;
  files: readonly CaseFileRowView[];
  truncated: boolean;
  lens: 'client' | 'expert';
  /** The case's OPEN/CLOSED state — decides invitation vs retrospective empty copy. */
  isOpen: boolean;
  counterpartyFirstName: string;
}>): React.JSX.Element {
  // Keyed by `origin:id` — an id is unique only WITHIN its origin, so the bare id could
  // collide across the two tables and spin the wrong row.
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);

  const handleDownload = useCallback(
    async (file: CaseFileRowView) => {
      const key = `${file.origin}:${file.id}`;
      setDownloadingKey(key);
      try {
        const result = await getCaseFileDownloadAction(
          file.origin === 'meeting' && file.meetingId !== null
            ? {
                engagementId,
                origin: 'meeting',
                fileId: file.id,
                meetingId: file.meetingId,
              }
            : { engagementId, origin: 'conversation', fileId: file.id }
        );
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        track(RECAP_EVENTS.CASE_ACTION_CLICKED, { action: 'download_file', lens });
        globalThis.location.assign(result.url);
      } catch {
        toast.error('Could not download this file. Please try again.');
      } finally {
        setDownloadingKey(null);
      }
    },
    [engagementId, lens]
  );

  return (
    <section className="bg-card border-border rounded-3xl border px-5 py-4">
      <SectionHead
        icon={Folder}
        title="Files"
        meta={files.length > 0 ? String(files.length) : undefined}
      />
      {files.length === 0 ? (
        <p className="text-muted-foreground text-xs leading-relaxed">
          {emptyCopy(isOpen, counterpartyFirstName)}
        </p>
      ) : (
        <>
          <ul
            className="-mx-1.5 list-none overflow-y-auto overscroll-contain"
            style={{ maxHeight: 168 }}
          >
            {files.map((file) => {
              const key = `${file.origin}:${file.id}`;
              const busy = downloadingKey === key;
              return (
                <li key={key}>
                  <FileRow file={file} busy={busy} onDownload={handleDownload} />
                </li>
              );
            })}
          </ul>
          {truncated && (
            <p className="text-muted-foreground mt-2 text-xs">Showing the most recent files.</p>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The empty state's one line.
 *
 * ⚠ OPEN ⇒ AN INVITATION, NOT AN ABSENCE (the balo-ui empty-state rule): the viewer CAN act
 * from here, because the composer is right there, so the section stays and says so.
 *
 * ⚠ CLOSED ⇒ RETROSPECTIVE. The composer is read-only ("This case is closed, so the
 * conversation is read-only"), so "Share a file … in the conversation" would invite the exact
 * action the surface has just refused. Nothing forward-looking is true any more, so the copy
 * states the fact in the PAST TENSE and offers nothing. It is deliberately not the absence-
 * framed "No files yet" either — "yet" promises a future this case does not have.
 */
function emptyCopy(isOpen: boolean, counterpartyFirstName: string): string {
  if (isOpen) {
    return `Share a file with ${counterpartyFirstName} in the conversation, and anything from your consultations shows up here too.`;
  }
  return 'No files were shared on this case.';
}

function FileRow({
  file,
  busy,
  onDownload,
}: Readonly<{
  file: CaseFileRowView;
  busy: boolean;
  onDownload: (file: CaseFileRowView) => void;
}>): React.JSX.Element {
  const handleClick = useCallback(() => {
    onDownload(file);
  }, [file, onDownload]);

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      // The accessible name says what the button DOES, not just what the file is called.
      aria-label={`Download ${file.fileName}`}
      className="hover:bg-muted/60 focus-visible:ring-ring group flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
    >
      <Paperclip size={12} className="text-muted-foreground shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-xs font-medium">{file.fileName}</span>
        <span className="text-muted-foreground block text-xs">
          {file.sourceLabel} · {formatBytes(file.sizeBytes)} · {file.uploaderLabel}
        </span>
      </span>
      {busy ? (
        <Loader2
          size={13}
          className="text-muted-foreground shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : (
        <Download
          size={13}
          className="text-muted-foreground shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          aria-hidden="true"
        />
      )}
    </button>
  );
}

/** "12 KB" / "1.1 MB" — the design reference's compact form. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
