'use client';

import { useCallback } from 'react';
import { MEETING_PANEL_EVENTS, track, type MeetingPanelSizeBucket } from '@/lib/analytics';
import { formatBytes, putWithProgress } from '@/components/balo/document-uploader/upload-file';
import {
  MEETING_ALLOWED_CONTENT_TYPES,
  MAX_MEETING_FILE_BYTES,
} from '@/lib/storage/meeting-file-constraints';
import type { MeetingFileView } from '@/lib/meetings/meeting-file-view-types';
import type {
  ConfirmUploadActionResult,
  RequestUploadActionResult,
} from '@/lib/meetings/meeting-panels';

/**
 * BAL-437 — ⚠⚠ **ONE DEFINITION OF "SHARE A FILE WITH THIS CALL", AT THE CLIENT TIER.**
 *
 * The three-step upload (presign → PUT → confirm) plus its two pure validators were module-
 * private to `files-panel.tsx` until the chat paperclip needed them verbatim. Copying ~90 lines
 * would have been a certain jscpd hit AND — the real cost — would have given the two in-call
 * entry points two different validation stories, two different duplicate-confirm behaviours and
 * two different analytics shapes that drift on the first edit.
 *
 * ⚠ IT MIRRORS THE SERVER TIER EXACTLY. There is ONE publisher server-side
 * (`confirmMeetingFileUploadAction`, whose single `publishMeetingEvent` both panels consume);
 * this is its client-side twin. `source` is the ONLY thing that differs between the two callers,
 * and it is bound in `call-client.tsx` where the closure lives — never chosen by a component.
 *
 * ⚠ IT REUSES THE SHIPPED `putWithProgress` RATHER THAN A SECOND XHR. One definition of "PUT a
 * file to a presigned URL"; a second would drift on error handling first.
 *
 * ⚠ CLIENT-SIDE VALIDATION BEFORE THE PRESIGN. The server re-checks type and size from the R2
 * object itself and is the source of truth — but a 10 MB round trip to be told no is a bad
 * experience mid-call.
 *
 * ⚠ NO `@/lib/logging` ANYWHERE IN HERE. It is bare pino + AsyncLocalStorage and is NOT
 * client-safe; `meeting-call-no-lens-gate.test.ts` fails the build over it. A failure is
 * observed through the `outcome` property, which names WHICH STEP failed and never the file.
 */

/** The size bands PostHog gets. ⚠ A BUCKET, never a byte count, and never the file name. */
export function sizeBucketFor(sizeBytes: number): MeetingPanelSizeBucket {
  if (sizeBytes < 100 * 1024) return 'under_100kb';
  if (sizeBytes < 1024 * 1024) return 'under_1mb';
  if (sizeBytes < 5 * 1024 * 1024) return 'under_5mb';
  return 'over_5mb';
}

/**
 * Client-side pre-validation.
 *
 * ⚠ TWO DIFFERENT MESSAGES FOR TWO DIFFERENT REMEDIES — "pick another file" and "pick a
 * smaller file" are not the same instruction, and the server's own copy makes the same split.
 */
export function rejectionFor(file: File): string | null {
  if (!MEETING_ALLOWED_CONTENT_TYPES.has(file.type)) {
    return `${file.name} isn't a supported type.`;
  }
  if (file.size > MAX_MEETING_FILE_BYTES) {
    return `${file.name} is ${formatBytes(file.size)} — files must be ${formatBytes(MAX_MEETING_FILE_BYTES)} or smaller.`;
  }
  if (file.size === 0) {
    return `${file.name} appears to be empty.`;
  }
  return null;
}

/**
 * The presign + confirm pair, exactly as the registration hands them over.
 *
 * ⚠ `confirmUpload` IS WHAT CARRIES `source`. The Files panel is handed the `'files_tab'`
 * binding and the chat composer the `'chat'` one; neither can see or change it.
 */
export interface MeetingFileUploadActions {
  readonly requestUpload: (input: {
    contentType: string;
    fileName: string;
    sizeBytes: number;
  }) => Promise<RequestUploadActionResult>;
  readonly confirmUpload: (input: {
    key: string;
    fileName: string;
    sizeBytes: number;
  }) => Promise<ConfirmUploadActionResult>;
}

export interface UseMeetingFileUploadInput {
  readonly actions: MeetingFileUploadActions;
  /**
   * ⚠⚠ THE **EXACT SHAPE**, NEVER `Record<string, string>`. A `Record` index signature defeats
   * excess-property checking at every spread below — which is exactly where the analytics event
   * map's PII guard is supposed to bite. A file NAME added to this object would otherwise
   * compile straight into a PostHog payload.
   */
  readonly meetingProps: Readonly<{ meeting_id?: string }>;
  /** Called with the persisted row on success, so each surface owns its own list update. */
  readonly onShared: (file: MeetingFileView) => void;
  readonly setIsUploading: React.Dispatch<React.SetStateAction<boolean>>;
  /** ⚠ Toast **and** the frame's one §16 live region, in one call. Same sentence in both. */
  readonly report: (kind: 'success' | 'info' | 'error', message: string) => void;
  /**
   * The success sentence.
   *
   * ⚠ PARAMETERISED BECAUSE THE TWO SURFACES OWE DIFFERENT INFORMATION. From the Files panel
   * the person is already looking at the list, so "is shared with the call" is complete. From
   * the CHAT composer they are not, so the sentence must say where the file went.
   */
  readonly successMessage: (fileName: string) => string;
}

/** ⚠ A duplicate confirm (double-click) is EXPECTED. The server's literal, matched once. */
const DUPLICATE_ERROR = 'This file was already shared.';

export function useMeetingFileUpload(
  input: Readonly<UseMeetingFileUploadInput>
): (file: File) => Promise<void> {
  const { actions, meetingProps, onShared, setIsUploading, report, successMessage } = input;

  return useCallback(
    async (file: File): Promise<void> => {
      const size_bucket = sizeBucketFor(file.size);

      const rejection = rejectionFor(file);
      if (rejection !== null) {
        track(MEETING_PANEL_EVENTS.FILE_SHARED, {
          ...meetingProps,
          outcome: 'rejected',
          size_bucket,
        });
        report('error', rejection);
        return;
      }

      setIsUploading(true);
      try {
        const presigned = await actions.requestUpload({
          contentType: file.type,
          fileName: file.name,
          sizeBytes: file.size,
        });
        if (!presigned.success) {
          track(MEETING_PANEL_EVENTS.FILE_SHARED, {
            ...meetingProps,
            outcome: 'rejected',
            size_bucket,
          });
          report('error', presigned.error);
          return;
        }

        await putWithProgress({
          url: presigned.presignedUrl,
          file,
          // Progress is not surfaced on this surface: the 10 MB cap is pinned to a 60s presign
          // TTL, so an in-call share is short by construction and a bar would flash.
          onProgress: () => {},
        });

        const confirmed = await actions.confirmUpload({
          key: presigned.key,
          fileName: file.name,
          sizeBytes: file.size,
        });
        if (!confirmed.success) {
          // ⚠ A DUPLICATE CONFIRM (double-click) IS EXPECTED, NOT AN ERROR — the server maps
          // the unique violation to friendly copy, and the row it collides with is already in
          // the list. Toasted as `info`, never `error`.
          const isDuplicate = confirmed.error === DUPLICATE_ERROR;
          track(MEETING_PANEL_EVENTS.FILE_SHARED, {
            ...meetingProps,
            outcome: isDuplicate ? 'duplicate' : 'failed',
            size_bucket,
          });
          report(isDuplicate ? 'info' : 'error', confirmed.error);
          return;
        }

        // ⚠ THE RETURNED ROW GOES STRAIGHT TO THE SURFACE — this is the "freshness" the
        // deferred `revalidatePath` was actually about, and it needs no route invalidation
        // from inside a live call. The Ably fan-out reaches EVERYONE ELSE.
        onShared(confirmed.file);
        track(MEETING_PANEL_EVENTS.FILE_SHARED, { ...meetingProps, outcome: 'ok', size_bucket });
        report('success', successMessage(file.name));
      } catch {
        // ⚠ NO `log.error` — see the module docblock. The event's `outcome` names WHICH step
        // failed and never the file.
        track(MEETING_PANEL_EVENTS.FILE_SHARED, {
          ...meetingProps,
          outcome: 'failed',
          size_bucket,
        });
        report('error', "We couldn't share that file. Please try again.");
      } finally {
        setIsUploading(false);
      }
    },
    [actions, meetingProps, onShared, setIsUploading, report, successMessage]
  );
}
