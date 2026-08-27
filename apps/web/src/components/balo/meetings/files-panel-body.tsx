import type { MeetingFileView } from '@/lib/meetings/meeting-file-view-types';
import { FilesPanelRow } from './files-panel-row';
import { PanelErrorCard, PanelSkeletonRows } from './panel-states';

/**
 * BAL-445 fix-round-1 (F5 / SUGGESTION-3) — `FilesPanelBody` EXTRACTED OUT OF `files-panel.tsx`
 * INTO ITS OWN MODULE.
 *
 * ⚠⚠ WHY THIS FILE EXISTS RATHER THAN BEING RE-INLINED THERE: ES modules resolve their WHOLE
 * import graph, not just the export a caller asked for. `files-panel.tsx` module-level imports
 * `useMeetingFileUpload` (`./use-meeting-file-upload`) and `useDailyIdentities`
 * (`./use-daily-identities`) for `FilesPanel` itself — so `GuestFilesPanel` importing
 * `FilesPanelBody` FROM `./files-panel` dragged the upload hook (and everything it imports)
 * into the read-only guest surface's bundle, purely as a side effect of module resolution, with
 * NOTHING in that graph ever called. It also grew the admitted-mount test's module graph enough
 * to blow past `waitFor`'s 1000ms default under worker contention (CRITICAL-6).
 *
 * Splitting the shared body into its OWN file, with no import of the upload hook anywhere in
 * its transitive closure, makes "a guest cannot upload" a MODULE-GRAPH FACT rather than a props
 * convention: the guest panel's bundle simply cannot reach `use-meeting-file-upload.tsx` through
 * this path. `files-panel.tsx` re-exports `FilesPanelBody`/`FilesPanelBodyProps` from here so
 * `FilesPanel`'s own render body needs no import-site change.
 *
 * ⚠⚠ `MEETING_FILE_LIST_CAP` IS NOT IMPORTED FROM `@balo/db`, DELIBERATELY, EVEN THOUGH
 * `MEETING_FILE_LIST_LIMIT` LIVES THERE. A `'use client'` module that VALUE-imports `@balo/db`
 * pulls `postgres` into the browser graph and breaks `next build` with "can't resolve 'tls'" —
 * a failure NO local typecheck, lint or vitest run catches
 * (memory `reference_balo_db_client_bundle_footgun`). Restating one number is the cheap side of
 * that trade; the server-side `log.warn` in `list-meeting-files.ts` is the authoritative signal
 * either way.
 */
export const MEETING_FILE_LIST_CAP = 200;

export interface FilesPanelBodyProps {
  readonly files: MeetingFileView[] | null;
  readonly isLoading: boolean;
  readonly hasFailed: boolean;
  readonly onRetry: () => void;
  readonly onDownload: (fileId: string) => void;
  readonly downloadingIds: ReadonlySet<string>;
  readonly uploaderLabelFor: (file: MeetingFileView) => string;
  /** ⚠ INVITATION-FRAMED for the member panel, ABSENCE-FRAMED for the guest one (R9's
   *  documented exception — a guest cannot populate this list, so an invitation would
   *  advertise a control that does not exist for them). */
  readonly emptyLine: string;
  readonly errorBody: string;
}

/**
 * BAL-445 — the shared list body: skeleton / error card / empty line / rows / cap notice.
 * Extracted so the member panel (drop zone + footer shell) and the read-only guest panel (no
 * shell chrome) render the SAME list logic rather than a second, drifting copy — the
 * `npx jscpd` duplication gate is why this exists as its own export.
 */
export function FilesPanelBody({
  files,
  isLoading,
  hasFailed,
  onRetry,
  onDownload,
  downloadingIds,
  uploaderLabelFor,
  emptyLine,
  errorBody,
}: Readonly<FilesPanelBodyProps>): React.JSX.Element {
  return (
    <>
      {isLoading ? <PanelSkeletonRows /> : null}

      {hasFailed ? (
        <PanelErrorCard title="We couldn't load the files" body={errorBody} onRetry={onRetry} />
      ) : null}

      {files !== null && files.length === 0 ? (
        <p className="text-muted-foreground px-2 py-4 text-center text-sm leading-relaxed">
          {emptyLine}
        </p>
      ) : null}

      {files !== null && files.length > 0 ? (
        <ul className="list-none">
          {files.map((file) => (
            <FilesPanelRow
              key={file.id}
              file={file}
              uploaderLabel={uploaderLabelFor(file)}
              onDownload={onDownload}
              isDownloading={downloadingIds.has(file.id)}
            />
          ))}
        </ul>
      ) : null}

      {/* ⚠ NO SILENT CAPS. The server logs the truncation; the reader deserves to know too. */}
      {files !== null && files.length >= MEETING_FILE_LIST_CAP ? (
        <p className="text-muted-foreground px-2 pt-2 text-xs">
          Showing the {MEETING_FILE_LIST_CAP} most recent files.
        </p>
      ) : null}
    </>
  );
}
