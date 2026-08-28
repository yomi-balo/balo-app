'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Folder } from 'lucide-react';
import { SectionHead } from '@/components/balo/section/section-states';
// ⚠⚠ F5/SUGGESTION-3 (BAL-445) — imported from `files-panel-body`, NEVER `files-panel`.
// `files-panel.tsx` module-level imports `useMeetingFileUpload`; importing from it would drag
// that hook (and its whole graph) into this read-only surface's bundle for nothing ever called.
import { FilesPanelBody } from '@/components/balo/meetings/files-panel-body';
import type { MeetingFileView } from '@/lib/meetings/meeting-file-view-types';
// ⚠⚠ RELATIVE IMPORTS. `join-link-never-writes.test.ts` fails on ANY occurrence of the literal
// `/join/` in non-comment code under `app/join/` — and unlike the app-router-wide scan, that
// assertion does NOT apply the `@/app/join/` exclusion. Same rule `join-control.tsx` and
// `lobby-client.tsx` already record.
import { listGuestMeetingFilesAction } from '../../../_actions/list-guest-meeting-files';
import { getGuestMeetingFileDownloadAction } from '../../../_actions/get-guest-meeting-file-download';

/**
 * BAL-439 §6.3 — the guest recap's Files card. The ONLY client island on this route.
 *
 * State machine copied in SHAPE from `GuestFilesPanel`, minus the `MeetingSidePanel` shell:
 * `files` / `hasFailed` / `downloadingIds` / `isMountedRef`, `load()` in a `try`/`catch`
 * (F8/WARNING-1 — a transport-level rejection must not leave a permanent skeleton), and
 * `onDownload` via an `<a download>` click.
 *
 * ⚠ NO `onAnnounce` PROP. The in-call panel threads the frame's one polite live region; there is
 * no frame here. Failures use `toast.error(result.error)` — Sonner is mounted app-wide and owns
 * its own live region.
 *
 * ⚠ NO UPLOAD AFFORDANCE OF ANY KIND — no footer, no drop target, no file input, no disabled
 * button. R9: absence beats disablement. It is a MODULE-GRAPH FACT, not a props convention:
 * `files-panel-body.tsx` has no `use-meeting-file-upload` anywhere in its transitive closure.
 *
 * `uploaderLabelFor` is the shipped zero-arg `() => 'A participant'` — the guest resolves no
 * name from `uploadedByUserId`, exactly as the in-call `GuestFilesPanel` does.
 */
export interface GuestRecapFilesProps {
  readonly meetingId: string;
  /** The raw guest token. ⚠ Never rendered as text — passed straight to the two actions below. */
  readonly guestToken: string;
}

const UPLOADER_LABEL = (): string => 'A participant';

export function GuestRecapFiles({
  meetingId,
  guestToken,
}: Readonly<GuestRecapFilesProps>): React.JSX.Element {
  const [files, setFiles] = useState<MeetingFileView[] | null>(null);
  const [hasFailed, setHasFailed] = useState(false);
  const [downloadingIds, setDownloadingIds] = useState<ReadonlySet<string>>(new Set());
  const isMountedRef = useRef(true);

  /**
   * ⚠⚠ F8/WARNING-1 — WRAPPED IN A `try`/`catch`. `listGuestMeetingFilesAction` always RESOLVES
   * with `{ success: false, … }` on every handled failure, but a genuine transport-level
   * rejection (the action itself never reaches the server) has no `.catch` anywhere else on
   * this path — an unhandled rejection would leave the panel on a PERMANENT skeleton.
   */
  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await listGuestMeetingFilesAction({ meetingId, guestToken });
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
  }, [meetingId, guestToken]);

  useEffect(() => {
    isMountedRef.current = true;
    void load();
    return () => {
      isMountedRef.current = false;
    };
  }, [load]);

  const handleRetry = useCallback((): void => {
    void load();
  }, [load]);

  const onDownload = useCallback(
    (fileId: string): void => {
      setDownloadingIds((current) => new Set(current).add(fileId));
      getGuestMeetingFileDownloadAction({ meetingId, guestToken, fileId })
        .then((result) => {
          if (!result.success) {
            toast.error(result.error);
            return;
          }
          const anchor = globalThis.document.createElement('a');
          anchor.href = result.url;
          anchor.download = '';
          anchor.rel = 'noopener noreferrer';
          anchor.target = '_blank';
          globalThis.document.body.append(anchor);
          anchor.click();
          anchor.remove();
        })
        // ⚠⚠ fix-round-1 / MUST-1 — WITHOUT THIS, A TRANSPORT-LEVEL REJECTION IS BOTH AN
        // UNHANDLED PROMISE REJECTION AND A SILENT FAILURE: `.finally` still clears the
        // spinner, so the row just reverts with no feedback at all.
        .catch(() => {
          toast.error("We couldn't start that download. Try again in a moment.");
        })
        .finally(() => {
          setDownloadingIds((current) => {
            const next = new Set(current);
            next.delete(fileId);
            return next;
          });
        });
    },
    [meetingId, guestToken]
  );

  const isLoading = files === null && !hasFailed;

  return (
    <section className="bg-card border-border rounded-2xl border p-6 shadow-sm">
      <SectionHead
        icon={Folder}
        title="Files"
        meta={files === null ? undefined : String(files.length)}
      />
      <FilesPanelBody
        files={files}
        isLoading={isLoading}
        hasFailed={hasFailed}
        onRetry={handleRetry}
        onDownload={onDownload}
        downloadingIds={downloadingIds}
        uploaderLabelFor={UPLOADER_LABEL}
        // ⚠ R9's documented exception: a guest cannot populate this list, so an invitation would
        // advertise a control that does not exist for them. Absence-framed on purpose.
        emptyLine="Nothing was shared on this call."
        errorBody="This is on our side. Try again in a moment."
      />
    </section>
  );
}
