'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { MeetingFileView } from '@/lib/meetings/meeting-file-view-types';
import type { MeetingGuestPanelRegistration } from '@/lib/meetings/meeting-panels';
import { MeetingSidePanel } from './meeting-side-panel';
// ⚠⚠ F5/SUGGESTION-3 (fix-round-1) — imported from `./files-panel-body`, NEVER `./files-panel`.
// `files-panel.tsx` module-level imports `useMeetingFileUpload`; importing from it would drag
// that hook (and its whole graph) into this read-only surface's bundle for nothing ever called.
import { FilesPanelBody } from './files-panel-body';

/**
 * BAL-445 — the GUEST Files panel: READ-ONLY BY CONSTRUCTION.
 *
 * ⚠⚠ THIS IS A SEPARATE COMPONENT, NOT A BRANCH INSIDE `FilesPanel`. `FilesPanel` calls
 * `useMeetingFileUpload({ actions: panels.files })` at the TOP LEVEL — hooks cannot be
 * skipped conditionally, and a guest's `MeetingGuestFilePanelActions` carries no
 * `requestUpload` / `confirmUpload` for that hook to bind to anyway.
 *
 * ⚠ NO FOOTER, NO DROP ZONE, NO FILE INPUT. `MeetingSidePanel` omitting `footer` renders no
 * footer strip at all — the shell-level read-only seam (R9: absence beats disablement, never
 * a disabled "Share a file" button).
 *
 * ⚠ NO UPLOADER NAME RESOLUTION. `uploadedByUserId` crosses to the guest (an opaque UUID,
 * ADR-1044's concealment rule is about addresses, not ids), but this panel resolves no name
 * from it — there is no Daily-identity probe running for a guest with no participant token
 * of their own to correlate against.
 */
export interface GuestFilesPanelProps {
  readonly panels: MeetingGuestPanelRegistration;
  readonly onClose: () => void;
  /**
   * ⚠⚠ F4 (fix-round-1) — §16'S ONE POLITE LIVE REGION, HANDED DOWN, same as the member
   * `FilesPanel`. Without this, a failed download was SILENT: the spinner ran, the row
   * reverted, and nothing told the guest — sighted or on assistive tech — that anything had
   * gone wrong. `MeetingSidePanel`'s frame already threads this into `FramePanel`; this panel
   * was simply never given it.
   */
  readonly onAnnounce: (message: string) => void;
}

const UPLOADER_LABEL = (): string => 'A participant';

export function GuestFilesPanel({
  panels,
  onClose,
  onAnnounce,
}: Readonly<GuestFilesPanelProps>): React.JSX.Element {
  const [files, setFiles] = useState<MeetingFileView[] | null>(null);
  const [hasFailed, setHasFailed] = useState(false);
  const [downloadingIds, setDownloadingIds] = useState<ReadonlySet<string>>(new Set());
  const isMountedRef = useRef(true);

  /**
   * ⚠ Toast **and** the frame's one §16 live region, in one call — mirrors the member
   * `FilesPanel`'s `report` exactly, the ONE call site it uses it for (download failure; guest
   * has no upload to report on).
   */
  const report = useCallback(
    (kind: 'success' | 'info' | 'error', message: string): void => {
      toast[kind](message);
      onAnnounce(message);
    },
    [onAnnounce]
  );

  /**
   * ⚠⚠ F8/WARNING-1 (fix-round-1) — WRAPPED IN A `try`/`catch`. `panels.files.list()` is a
   * `'use server'` action call and always RESOLVES with `{ success: false, … }` on every
   * handled failure, but a genuine transport-level rejection (the action itself never reaches
   * the server) previously had no `.catch` anywhere on this path — an unhandled rejection that
   * left the panel on a PERMANENT skeleton (`isLoading` never turns false). Catching here
   * covers both callers (mount and "Try again") in one place.
   */
  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await panels.files.list();
      if (!isMountedRef.current) return;
      if (result.success) {
        setFiles(result.files);
        setHasFailed(false);
        return;
      }
      setHasFailed(true);
    } catch {
      if (isMountedRef.current) setHasFailed(true);
    }
  }, [panels]);

  useEffect(() => {
    isMountedRef.current = true;
    void load();
    return () => {
      isMountedRef.current = false;
    };
  }, [load]);

  const onDownload = useCallback(
    (fileId: string): void => {
      setDownloadingIds((current) => new Set(current).add(fileId));
      panels.files
        .download(fileId)
        .then((result) => {
          if (!result.success) {
            // ⚠⚠ F4 (fix-round-1) — WAS: `return;` — silent. The spinner ran, the row reverted
            // to the plain Download icon, and nothing told the guest anything had gone wrong
            // ("a control that visibly does nothing reads as broken", `chat-panel-list.tsx`).
            report('error', result.error);
            return;
          }
          const anchor = globalThis.document.createElement('a');
          anchor.href = result.url;
          anchor.download = '';
          anchor.rel = 'noopener';
          anchor.target = '_blank';
          globalThis.document.body.append(anchor);
          anchor.click();
          anchor.remove();
        })
        .finally(() => {
          setDownloadingIds((current) => {
            const next = new Set(current);
            next.delete(fileId);
            return next;
          });
        });
    },
    [panels, report]
  );

  const isLoading = files === null && !hasFailed;

  return (
    <MeetingSidePanel title="Files" count={files?.length} onClose={onClose}>
      <div className="p-3">
        <FilesPanelBody
          files={files}
          isLoading={isLoading}
          hasFailed={hasFailed}
          onRetry={() => {
            void load();
          }}
          onDownload={onDownload}
          downloadingIds={downloadingIds}
          uploaderLabelFor={UPLOADER_LABEL}
          // ⚠ R9's documented exception: a guest can populate nothing here, so an
          // invitation would advertise a control that does not exist. Absence-framed.
          emptyLine="Nothing has been shared in this call yet."
          errorBody="The call itself is fine. Try again in a moment."
        />
      </div>
    </MeetingSidePanel>
  );
}
