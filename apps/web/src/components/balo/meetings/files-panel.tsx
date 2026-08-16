'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Paperclip, Plus } from 'lucide-react';
import { MEETING_PANEL_EVENTS, track } from '@/lib/analytics';
import { MEETING_FILE_ACCEPT } from '@/lib/storage/meeting-file-constraints';
import type { MeetingFileView } from '@/lib/meetings/meeting-file-view-types';
import type { MeetingPanelRegistration } from '@/lib/meetings/meeting-panels';
import { cn } from '@/lib/utils';
import { MeetingSidePanel } from './meeting-side-panel';
import { FilesPanelRow } from './files-panel-row';
import { PanelErrorCard, PanelSkeletonRows } from './panel-states';
import { useDailyIdentities } from './use-daily-identities';
import { useMeetingFileUpload } from './use-meeting-file-upload';

/**
 * BAL-436 — the Files panel: a drop zone plus every file on this meeting, from BOTH in-call
 * sources, with download.
 *
 * ── ⚠⚠ ONE UNIFIED LIST. NO `source` FILTER, NO SOURCE GROUPING ─────────────────────────
 *
 * That is BAL-423's D0 acceptance criterion, satisfied at the data layer:
 * `listMeetingFilesAction` returns `chat` and `files_tab` rows unfiltered and this panel adds
 * nothing. A paperclip glyph on a chat-originated row is the only distinction, and only
 * because it aids scanning.
 *
 * ── ⚠ FRESHNESS: WHAT THIS TICKET DOES AND DELIBERATELY DOES NOT DO ─────────────────────
 *
 *   · **No `revalidatePath`.** This is a client island holding its own list; revalidating
 *     would invalidate the dashboard recap route from inside a call — a different page nobody
 *     is looking at. Instead `confirmUpload` RETURNS the created row and this panel prepends
 *     it, which is the freshness the AC actually asks for.
 *   · **BAL-437 LANDED THE ABLY PUBLISH.** `confirmMeetingFileUploadAction` now publishes
 *     `MEETING_EVENT_FILE` on `meeting:{meetingId}` — ONE fan-out for BOTH in-call entry
 *     points — and the frame turns that into the `fileRevision` prop below. The `window.focus`
 *     "Ably substitute" listener BAL-436 shipped as a stopgap is **deleted**, exactly as its
 *     own docblock promised. The stated limitation it carried ("a file another participant
 *     shares does not appear until the panel is re-opened") is now closed while this panel is
 *     open, and remains true only when the transport itself is unconfigured or failed.
 *   · **No notification event.** `conversation.file_shared` exists for an ABSENT counterparty;
 *     an in-call file reaches people who are already in the call.
 *
 * ⚠ CLIENT-SIDE VALIDATION BEFORE THE PRESIGN, in the SHARED `useMeetingFileUpload` hook —
 * which the chat paperclip consumes too, so the two in-call entry points cannot end up with
 * two validation stories. The server re-checks type and size from the R2 object itself and is
 * the source of truth; a 10 MB round trip to be told no is a bad experience mid-call.
 */

/**
 * ⚠⚠ NOT IMPORTED FROM `@balo/db`, DELIBERATELY, EVEN THOUGH `MEETING_FILE_LIST_LIMIT` LIVES
 * THERE. A `'use client'` module that VALUE-imports `@balo/db` pulls `postgres` into the
 * browser graph and breaks `next build` with "can't resolve 'tls'" — a failure NO local
 * typecheck, lint or vitest run catches (memory `reference_balo_db_client_bundle_footgun`).
 * Restating one number is the cheap side of that trade; the server-side `log.warn` in
 * `list-meeting-files.ts` is the authoritative signal either way.
 */
const MEETING_FILE_LIST_CAP = 200;

/**
 * Start a download WITHOUT navigating the tab.
 *
 * ── ⚠⚠ THIS IS A DELIBERATE DEVIATION FROM THE TECHNICAL PLAN (L830-831), WHICH PRESCRIBED
 *      `window.location.assign(url)`. THE PLAN WAS WRONG. ────────────────────────────────
 *
 * `location.assign` navigates the CURRENT document. That is survivable only if the response
 * is guaranteed to carry `Content-Disposition: attachment`, and it is not: the presign is
 * 300s, so an expired or revoked URL answers with R2's **XML error body**, and any 403 / 404
 * / bucket-policy answer does the same. The browser renders that XML in the tab — which
 * unmounts the Daily call object and **ends the call for this participant**, mid-meeting,
 * because they clicked a file. There is no undo and no "back" that rejoins.
 *
 * A programmatic `<a download>` click cannot navigate the document. In the happy path the
 * browser downloads; in the failure path the browser also treats the answer as a download
 * (or does nothing at all), and either way the call survives. The `download` attribute is a
 * same-origin hint only and is ignored cross-origin, but its presence is not what makes this
 * safe — **not being a navigation is.**
 *
 * ⚠ `rel="noopener"` because the anchor is never appended to a document the user can see, and
 * a hostile `Content-Disposition` answer must not get an `opener` handle to the call tab.
 * ⚠ THE NODE IS APPENDED AND REMOVED SYNCHRONOUSLY: Firefox ignores `.click()` on an anchor
 * that is not in the document.
 */
function startDownload(url: string): void {
  const anchor = globalThis.document.createElement('a');
  anchor.href = url;
  // ⚠ EMPTY STRING = "use the server's filename". Passing our own would let a file name from
  // the payload become a local path fragment.
  anchor.download = '';
  anchor.rel = 'noopener';
  anchor.target = '_blank';
  globalThis.document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

export interface FilesPanelProps {
  readonly panels: MeetingPanelRegistration;
  readonly onClose: () => void;
  /**
   * ⚠⚠ THE **EXACT SHAPE**, NEVER `Record<string, string>`. A `Record` index signature defeats
   * excess-property checking at every `{ ...meetingProps, … }` spread below — which is exactly
   * where the analytics event map's PII guard is supposed to bite. A file NAME added to this
   * object would otherwise compile straight into a PostHog payload.
   */
  readonly meetingProps: Readonly<{ meeting_id?: string }>;
  /**
   * ⚠⚠ §16'S **ONE** POLITE LIVE REGION, OWNED BY THE FRAME. Upload and download outcomes are
   * announced through this — Sonner is a VISUAL affordance and was the only feedback these
   * mutations produced, so a screen-reader user shared a file and heard nothing at all.
   */
  readonly onAnnounce: (message: string) => void;
  /**
   * BAL-437 — ⚠⚠ **THE REAL INVALIDATION.** The frame bumps this on every inbound
   * `MEETING_EVENT_FILE`; a change reloads the list. It replaces BAL-436's `window.focus`
   * listener, which is deleted.
   *
   * ⚠ A COUNTER, NOT THE ROW. The row is on the wire, but reloading is what keeps this panel's
   * list identical to what a fresh open would show — including any row the sender's own
   * optimistic prepend does not know about. `0` on first mount is not a special case: the load
   * effect below runs on mount regardless.
   */
  readonly fileRevision: number;
}

export function FilesPanel({
  panels,
  onClose,
  meetingProps,
  onAnnounce,
  fileRevision,
}: Readonly<FilesPanelProps>): React.JSX.Element {
  const { identities, probes } = useDailyIdentities();
  const [files, setFiles] = useState<MeetingFileView[] | null>(null);
  const [hasFailed, setHasFailed] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [downloadingIds, setDownloadingIds] = useState<ReadonlySet<string>>(new Set());
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isMountedRef = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    const result = await panels.files.list();
    if (!isMountedRef.current) return;
    if (result.success) {
      setFiles(result.files);
      setHasFailed(false);
      return;
    }
    setHasFailed(true);
  }, [panels]);

  /**
   * ⚠⚠ MOUNT **AND** EVERY INBOUND FILE, IN ONE EFFECT. `fileRevision` is a dependency, so a
   * realtime `MEETING_EVENT_FILE` reloads the list exactly once — this is BAL-437's real
   * invalidation, and it replaced BAL-436's `window.focus` listener rather than joining it.
   * Two effects would have meant two reloads on any tick where both fired.
   */
  useEffect(() => {
    isMountedRef.current = true;
    void load();
    return () => {
      isMountedRef.current = false;
    };
  }, [load, fileRevision]);

  useSwallowStrayFileDrops();

  /** ⚠ Toast **and** the frame's one §16 live region, in one call. Same sentence in both. */
  const report = useCallback(
    (kind: 'success' | 'info' | 'error', message: string): void => {
      toast[kind](message);
      onAnnounce(message);
    },
    [onAnnounce]
  );

  const onShared = useCallback((file: MeetingFileView): void => {
    // ⚠ PREPEND THE RETURNED ROW — the "freshness" the deferred `revalidatePath` was actually
    // about, and it needs no route invalidation from inside a live call.
    setFiles((current) => [file, ...(current ?? [])]);
  }, []);

  const upload = useMeetingFileUpload({
    // ⚠ `panels.files` CARRIES THE `source: 'files_tab'` BINDING, fixed in `call-client.tsx`.
    // This component cannot see or choose it — see `use-meeting-file-upload.tsx`.
    actions: panels.files,
    meetingProps,
    onShared,
    setIsUploading,
    report,
    successMessage: (fileName) => `${fileName} is shared with the call.`,
  });

  const onPick = useCallback(
    (picked: FileList | null): void => {
      const [file] = Array.from(picked ?? []);
      if (file === undefined) return;
      void upload(file);
    },
    [upload]
  );

  const onDownload = useCallback(
    (fileId: string): void => {
      setDownloadingIds((current) => new Set(current).add(fileId));
      panels.files
        .download(fileId)
        .then((result) => {
          track(MEETING_PANEL_EVENTS.FILE_DOWNLOADED, {
            ...meetingProps,
            outcome: result.success ? 'ok' : 'failed',
          });
          if (!result.success) {
            report('error', result.error);
            return;
          }
          // ⚠ A PRESIGNED GET, live for 300s. `r2Key` never crosses to the browser — the
          // action resolves it server-side.
          startDownload(result.url);
        })
        .finally(() => {
          setDownloadingIds((current) => {
            const next = new Set(current);
            next.delete(fileId);
            return next;
          });
        });
    },
    [panels, meetingProps, report]
  );

  const uploaderLabelFor = useCallback(
    (file: MeetingFileView): string => resolveUploaderLabel(file, identities),
    [identities]
  );

  const isLoading = files === null && !hasFailed;

  return (
    <MeetingSidePanel
      title="Files"
      count={files?.length}
      onClose={onClose}
      footer={
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={isUploading}
          className="bg-primary text-primary-foreground focus-visible:ring-ring flex min-h-11 w-full items-center justify-center gap-2 rounded-xl text-sm font-medium transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none disabled:opacity-70"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {isUploading ? 'Sharing…' : 'Share a file'}
        </button>
      }
    >
      {probes}
      <div className="p-3">
        {/* ⚠ THE DROP ZONE STAYS LIVE IN EVERY STATE — loading, error and empty. A failed list
            read must not remove the ability to share something. */}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setIsDragging(false);
            onPick(event.dataTransfer.files);
          }}
          className={cn(
            'border-border text-muted-foreground hover:border-primary/60 focus-visible:ring-ring mb-3 flex w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed py-6 transition-colors focus-visible:ring-2 focus-visible:outline-none',
            isDragging ? 'border-primary bg-primary/5' : ''
          )}
        >
          <Paperclip className="h-[18px] w-[18px]" aria-hidden="true" />
          <span className="text-sm">Share a file with the call</span>
          <span className="text-muted-foreground/80 text-xs">
            Anything you drop here stays with this consultation.
          </span>
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={MEETING_FILE_ACCEPT}
          className="sr-only"
          aria-label="Choose a file to share with the call"
          onChange={(event) => {
            onPick(event.target.files);
            // Allow the same file to be picked twice in a row.
            event.target.value = '';
          }}
        />

        {isLoading ? <PanelSkeletonRows /> : null}

        {hasFailed ? (
          <PanelErrorCard
            title="We couldn't load the files"
            body="The call itself is fine, and you can still share something — the drop zone above works."
            onRetry={() => {
              void load();
            }}
          />
        ) : null}

        {files !== null && files.length === 0 ? (
          /* ⚠⚠ AN INVITATION, NEVER "No files yet". The person CAN act from here, so the empty
             state leads with the action (CLAUDE.md's empty-state rule). */
          <p className="text-muted-foreground px-2 py-4 text-center text-sm leading-relaxed">
            Drop in anything you want to talk through — a screenshot, a spec, a spreadsheet.
            It&apos;ll be here after the call too.
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
      </div>
    </MeetingSidePanel>
  );
}

/**
 * Swallow every file drop that lands anywhere OTHER than the drop zone, for as long as this
 * panel is mounted.
 *
 * ── ⚠⚠ WITHOUT THIS, A NEAR-MISS DROP ENDS THE CALL ─────────────────────────────────────
 *
 * The drop zone's own `onDragOver` / `onDrop` handlers `preventDefault`, but they only fire
 * for the dashed box itself. A file released 20px outside it hits the WINDOW's default
 * handler, and the browser's default for a dropped file is **navigate to it** — the tab
 * becomes a PDF viewer, the Daily call object unmounts, and the person is out of a live
 * meeting because they missed a target by a few pixels. Drag-and-drop is precisely the
 * interaction where a near miss is the common case.
 *
 * ⚠ BOTH EVENTS ARE REQUIRED. Cancelling only `drop` does nothing: the drop event is not
 * even delivered unless `dragover` has already been cancelled to signal "this is a valid drop
 * target". This is the one place where preventing one event without the other is a silent
 * no-op rather than a partial fix.
 *
 * ⚠ SCOPED TO THE PANEL'S LIFETIME, not the frame's. Suppressing browser drag-and-drop
 * globally for the whole app would be this component legislating for pages it does not own;
 * both listeners are removed on unmount.
 *
 * ⚠ IT SWALLOWS RATHER THAN UPLOADS. A drop outside the zone is an unaimed gesture, and
 * silently uploading a file somebody did not mean to share into a live consultation is a
 * worse failure than nothing happening. The zone stays the only way in.
 */
function useSwallowStrayFileDrops(): void {
  useEffect(() => {
    const swallow = (event: DragEvent): void => {
      event.preventDefault();
    };
    globalThis.addEventListener('dragover', swallow);
    globalThis.addEventListener('drop', swallow);
    return () => {
      globalThis.removeEventListener('dragover', swallow);
      globalThis.removeEventListener('drop', swallow);
    };
  }, []);
}

/**
 * Who shared it.
 *
 * ⚠⚠ A NAME OR THE NEUTRAL FALLBACK — **NEVER AN EMAIL ADDRESS AND NEVER A UUID.** The payload
 * carries `uploadedByUserId` only, so the label resolves from the LIVE Daily roster (the
 * server-minted `user_name` claim of a participant whose decoded `user_id` matches) and falls
 * back to "A participant" when that person is not in the room right now. The id itself is
 * never rendered.
 */
function resolveUploaderLabel(
  file: MeetingFileView,
  identities: readonly { userId: string | null; userName: string | null }[]
): string {
  const match = identities.find(
    (identity) =>
      identity.userId !== null && identity.userId.slice(1) === denormalise(file.uploadedByUserId)
  );
  const name = match?.userName;
  if (name === null || name === undefined || name.length === 0) return 'A participant';
  // First name only — the shipped `FilesCard` rule.
  const [first] = name.trim().split(/\s+/);
  return first === undefined || first.length === 0 ? 'A participant' : first;
}

/**
 * `users.id` → the hex run a Decision-1 `user_id` claim carries.
 *
 * ⚠ HYPHENS STRIPPED AND LOWERCASED, matching `dailyParticipantIdFor` exactly. Comparing the
 * two forms directly would never match, and a mismatch here degrades silently to "A
 * participant" rather than to a wrong name — which is the safe direction, but is also why the
 * transform is written out rather than assumed.
 */
function denormalise(userId: string): string {
  return userId.replaceAll('-', '').toLowerCase();
}
