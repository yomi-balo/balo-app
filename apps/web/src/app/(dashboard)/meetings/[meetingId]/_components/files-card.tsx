'use client';

import { useCallback, useState } from 'react';
import { Download, Folder, Loader2, Paperclip } from 'lucide-react';
import { toast } from 'sonner';
import { SectionEmpty, SectionHead } from '@/components/balo/section/section-states';
import { track, RECAP_EVENTS } from '@/lib/analytics';
import type { RecapFileRowView } from '@/lib/meetings/recap-view-types';
import { getMeetingFileDownloadAction } from '../_actions/get-meeting-file-download';

/**
 * BAL-388 §R10 — FILES.
 *
 * ⚠ D-B IS SUPERSEDED BY BAL-473 (ADR-1013's 2026-07-14 amendment). Daily cloud recording, the
 * `meeting_recordings` table and the Mux ingest all exist as of that ticket. The "Files" rename
 * STANDS — it was always the better container name — but the reason recorded below ("there is
 * no recording anywhere") is no longer true. **Whether this card gains a recording row is
 * BAL-440's decision, not this file's** — BAL-473 ships the producer only and this component's
 * rendered shape is UNCHANGED.
 *
 * ⚠⚠ THE ORIGINAL DECISION, FOR HISTORY (NOT DELETED): "It is 'Files', not 'Meeting Records',
 * and the rename is the design decision. There is no recording anywhere (owner decision D-B: no
 * Mux, no recording column, Daily recording not enabled), so a 'records' container would always
 * read as one-of-two with something missing. 'Files' is a category that is complete at any
 * size, including zero. NO recording row, NO coming-soon, NO disabled placeholder."
 *
 * ⚠⚠ `r2Key` NEVER CROSSES IN THE PAYLOAD. `MeetingFileView` omits it structurally, so the
 * props this component receives carry a file id and nothing else. Downloads go through
 * `getMeetingFileDownloadAction`, which re-runs the participation gate server-side and returns
 * a short-lived presigned GET — that URL necessarily contains the object key in its path, by
 * construction of S3 presigning, and is browser-visible for its 300s TTL. Nothing is disclosed
 * (both ids in the key are already on the payload), but the claim is stated precisely.
 *
 * ⚠ THE DOWNLOAD AFFORDANCE IS ALWAYS VISIBLE BELOW `lg`. Touch devices cannot hover, so a
 * hover-only affordance is an inaccessible affordance.
 *
 * ⚠ UPLOADER LABELS ARE FIRST NAMES (or "You"). Never an email address.
 *
 * ⚠ THE EMPTY COPY STATES WHAT THIS CARD IS RATHER THAN INVITING AN UPLOAD. BAL-423
 * shipped `request-`/`confirm-meeting-file-upload` with NO consumer anywhere in `apps/web`, so
 * "share anything either side needs" invited a capability the user cannot reach from any
 * surface. Reword it back the day an upload affordance lands here.
 */
export function FilesCard({
  meetingId,
  files,
}: Readonly<{ meetingId: string; files: RecapFileRowView[] }>): React.JSX.Element {
  return (
    <section className="bg-card border-border rounded-2xl border p-6">
      <SectionHead
        icon={Folder}
        title="Files"
        meta={files.length > 0 ? String(files.length) : undefined}
      />
      {files.length === 0 ? (
        <SectionEmpty
          icon={Paperclip}
          title="No files yet"
          body="Anything either side shares on this consultation shows up here."
        />
      ) : (
        <ul className="max-h-[320px] overflow-y-auto">
          {files.map((row) => (
            <FileRow key={row.file.id} meetingId={meetingId} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Bytes → a compact human size. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function FileRow({
  meetingId,
  row,
}: Readonly<{ meetingId: string; row: RecapFileRowView }>): React.JSX.Element {
  const [busy, setBusy] = useState(false);

  const download = useCallback(() => {
    setBusy(true);
    getMeetingFileDownloadAction({ meetingId, fileId: row.file.id })
      .then((result) => {
        if (result.success) {
          track(RECAP_EVENTS.FILE_DOWNLOADED, {
            meeting_id: meetingId,
            content_type: row.file.contentType,
          });
          globalThis.location.assign(result.url);
          return;
        }
        toast.error(result.error);
      })
      .catch(() => {
        toast.error('Could not download that file. Please try again.');
      })
      .finally(() => setBusy(false));
  }, [meetingId, row.file.id, row.file.contentType]);

  return (
    <li className="border-border/60 group flex items-center gap-2.5 border-b py-2.5 last:border-b-0">
      <Paperclip size={14} className="text-muted-foreground flex-none" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-sm">{row.file.fileName}</span>
        <span className="text-muted-foreground block text-xs">
          {row.uploaderLabel} · {formatSize(row.file.sizeBytes)}
        </span>
      </span>
      <button
        type="button"
        onClick={download}
        disabled={busy}
        aria-label={'Download ' + row.file.fileName}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex min-h-11 min-w-11 flex-none items-center justify-center rounded-md opacity-100 focus-visible:ring-2 focus-visible:outline-none lg:opacity-0 lg:group-focus-within:opacity-100 lg:group-hover:opacity-100"
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        ) : (
          <Download className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
    </li>
  );
}
