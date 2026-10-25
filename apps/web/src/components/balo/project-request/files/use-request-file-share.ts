'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import * as Sentry from '@sentry/nextjs';
import { toast } from 'sonner';
import { track, REQUEST_FILE_EVENTS } from '@/lib/analytics';
import { putWithProgress } from '@/components/balo/document-uploader/upload-file';
import { requestSharedFileUploadAction } from '@/app/(dashboard)/projects/[requestId]/_actions/request-shared-file-upload';
import {
  confirmRequestFileUploadAction,
  type ConfirmRequestFileUploadResult,
} from '@/app/(dashboard)/projects/[requestId]/_actions/confirm-request-file-upload';
import { discardRequestFileUploadAction } from '@/app/(dashboard)/projects/[requestId]/_actions/discard-request-file-upload';
import type {
  ShareEntryPoint,
  ShareRecipients,
  ShareSelection,
  ShareSubmission,
  ShareUploadState,
} from './share-file-types';

export type ShareCompleted = Extract<ConfirmRequestFileUploadResult, { success: true }>;

const UPLOAD_FAILED_COPY = 'Could not upload your file. Please try again.';
const SHARE_FAILED_COPY = 'Could not share your file. Please try again.';

/** "A", "A and B", "A, B and C" — one flat reduction, no nested ternary. */
function listNames(names: readonly string[]): string {
  const [first] = names;
  if (first === undefined) return '';
  if (names.length === 1) return first;
  const head = names.slice(0, -1).join(', ');
  const tail = names[names.length - 1] ?? '';
  return `${head} and ${tail}`;
}

/**
 * The success toast. Naming the recipients is the confirmation: "Shared with the selected
 * experts" makes the sharer reopen the row to check they picked the right people.
 */
export function shareSuccessCopy(recipients: ShareRecipients, share: ShareSelection): string {
  if (recipients.side === 'expert') return `Shared with ${recipients.clientPartyName}.`;
  if (share.mode === 'all_live_tracks') {
    const count = recipients.liveTracks.length;
    return `Shared with ${count} ${count === 1 ? 'expert' : 'experts'}.`;
  }
  const names = recipients.liveTracks
    .filter((t) => share.relationshipIds.includes(t.relationshipId))
    .map((t) => t.trackName);
  if (names.length === 0) return 'Shared with the selected experts.';
  return `Shared with ${listNames(names)}.`;
}

interface HookState {
  upload: ShareUploadState | null;
  pending: boolean;
  confirming: boolean;
  error: string | null;
}

const IDLE: HookState = { upload: null, pending: false, confirming: false, error: null };

export interface UseRequestFileShareInput {
  requestId: string;
  recipients: ShareRecipients;
  /** Where a cancel is attributed when it happens before any file was picked. */
  defaultEntryPoint: ShareEntryPoint;
  onShared: (result: ShareCompleted) => void;
}

export interface UseRequestFileShareResult {
  upload: ShareUploadState | null;
  /** Share was pressed and has not landed yet (mid-upload, or the confirm call is in flight). */
  pending: boolean;
  /** The confirm call is in flight — the one moment a cancel is refused. */
  confirming: boolean;
  error: string | null;
  pickFile: (file: File, entryPoint: ShareEntryPoint) => void;
  retryUpload: () => void;
  submit: (submission: ShareSubmission) => void;
  cancel: () => void;
}

/**
 * The share pipeline: pick → presign → PUT (progress, abortable) → confirm on Share.
 *
 * The upload starts the moment a file is picked; the audience is written only when the sharer
 * presses Share, through `confirmRequestFileUploadAction`. Pressing Share mid-upload parks the
 * submission and the confirm fires when the PUT resolves. Cancel aborts the PUT and discards the
 * object — `discardRequestFileUploadAction` only ever deletes a key nothing claims. A stale run
 * (cancelled, or replaced by a new pick) is dropped by comparing run ids after every await.
 */
export function useRequestFileShare(input: UseRequestFileShareInput): UseRequestFileShareResult {
  const [state, setState] = useState<HookState>(IDLE);
  const inputRef = useRef(input);
  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  const fileRef = useRef<File | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const keyRef = useRef<string | null>(null);
  const uploadedRef = useRef(false);
  const failedRef = useRef(false);
  const runIdRef = useRef(0);
  const pendingRef = useRef<ShareSubmission | null>(null);
  const confirmingRef = useRef(false);
  const entryRef = useRef<ShareEntryPoint>(input.defaultEntryPoint);

  /** Invalidates the current run, aborts its PUT, and discards its object if it left one behind. */
  const abandonRun = useCallback((): void => {
    runIdRef.current += 1;
    xhrRef.current?.abort();
    xhrRef.current = null;
    const key = keyRef.current;
    // A confirm already in flight may claim the key server-side; discarding it now could delete a shared file.
    const confirmInFlight = confirmingRef.current;
    confirmingRef.current = false;
    if (key !== null && !confirmInFlight) {
      discardRequestFileUploadAction({ requestId: inputRef.current.requestId, key }).catch(
        (error: unknown) => {
          Sentry.captureException(error);
        }
      );
    }
    keyRef.current = null;
    uploadedRef.current = false;
    failedRef.current = false;
    pendingRef.current = null;
    fileRef.current = null;
  }, []);

  useEffect(
    () => () => {
      abandonRun();
    },
    [abandonRun]
  );

  const failRun = useCallback((message: string): void => {
    failedRef.current = true;
    pendingRef.current = null;
    setState((s) => ({
      ...s,
      upload: s.upload === null ? null : { ...s.upload, status: 'failed' },
      pending: false,
      confirming: false,
      error: message,
    }));
  }, []);

  const confirmRun = useCallback(
    async (submission: ShareSubmission, runId: number): Promise<void> => {
      const file = fileRef.current;
      const key = keyRef.current;
      if (file === null || key === null) return;
      const { requestId, recipients } = inputRef.current;
      setState((s) => ({ ...s, pending: true, confirming: true, error: null }));
      confirmingRef.current = true;
      try {
        const note = submission.note.trim();
        const result = await confirmRequestFileUploadAction({
          requestId,
          key,
          fileName: file.name,
          contentType: file.type || 'application/octet-stream',
          sizeBytes: file.size,
          share: submission.share,
          ...(note.length > 0 ? { note } : {}),
          origin: { entryPoint: entryRef.current, audienceChoice: submission.audienceChoice },
        });
        if (runId !== runIdRef.current) return;
        confirmingRef.current = false;
        if (!result.success) {
          pendingRef.current = null;
          toast.error(result.error);
          setState((s) => ({ ...s, pending: false, confirming: false, error: result.error }));
          return;
        }
        toast.success(shareSuccessCopy(recipients, submission.share));
        // The object is claimed now: forget the key so a late unmount never tries to discard it.
        keyRef.current = null;
        abandonRun();
        setState(IDLE);
        inputRef.current.onShared(result);
      } catch (error) {
        if (runId !== runIdRef.current) return;
        confirmingRef.current = false;
        Sentry.captureException(error);
        pendingRef.current = null;
        toast.error(SHARE_FAILED_COPY);
        setState((s) => ({ ...s, pending: false, confirming: false, error: SHARE_FAILED_COPY }));
      }
    },
    [abandonRun]
  );

  const runUpload = useCallback(
    async (file: File, runId: number): Promise<void> => {
      try {
        const presigned = await requestSharedFileUploadAction({
          requestId: inputRef.current.requestId,
          contentType: file.type || 'application/octet-stream',
          fileName: file.name,
          sizeBytes: file.size,
        });
        if (runId !== runIdRef.current) {
          if (presigned.success) {
            discardRequestFileUploadAction({
              requestId: inputRef.current.requestId,
              key: presigned.key,
            }).catch((error: unknown) => {
              Sentry.captureException(error);
            });
          }
          return;
        }
        if (!presigned.success) {
          failRun(presigned.error);
          toast.error(presigned.error);
          return;
        }
        keyRef.current = presigned.key;
        await putWithProgress({
          url: presigned.presignedUrl,
          file,
          onProgress: (progress) => {
            if (runId !== runIdRef.current) return;
            setState((s) => ({
              ...s,
              upload: s.upload === null ? null : { ...s.upload, progress },
            }));
          },
          onStart: (xhr) => {
            xhrRef.current = xhr;
          },
        });
        if (runId !== runIdRef.current) return;
        xhrRef.current = null;
        uploadedRef.current = true;
        setState((s) => ({
          ...s,
          upload: s.upload === null ? null : { ...s.upload, progress: 100, status: 'uploaded' },
        }));
        const parked = pendingRef.current;
        if (parked !== null) await confirmRun(parked, runId);
      } catch (error) {
        if (runId !== runIdRef.current) return;
        Sentry.captureException(error);
        failRun(UPLOAD_FAILED_COPY);
        toast.error(UPLOAD_FAILED_COPY);
      }
    },
    [confirmRun, failRun]
  );

  const startRun = useCallback(
    (file: File): void => {
      const runId = runIdRef.current;
      fileRef.current = file;
      setState({
        upload: { fileName: file.name, sizeBytes: file.size, progress: 0, status: 'uploading' },
        pending: false,
        confirming: false,
        error: null,
      });
      runUpload(file, runId).catch((error: unknown) => {
        Sentry.captureException(error);
      });
    },
    [runUpload]
  );

  const pickFile = useCallback(
    (file: File, entryPoint: ShareEntryPoint): void => {
      abandonRun();
      entryRef.current = entryPoint;
      startRun(file);
    },
    [abandonRun, startRun]
  );

  const retryUpload = useCallback((): void => {
    const file = fileRef.current;
    if (file === null) return;
    abandonRun();
    startRun(file);
  }, [abandonRun, startRun]);

  const submit = useCallback(
    (submission: ShareSubmission): void => {
      if (fileRef.current === null || failedRef.current || pendingRef.current !== null) return;
      pendingRef.current = submission;
      setState((s) => ({ ...s, pending: true, error: null }));
      if (!uploadedRef.current) return;
      confirmRun(submission, runIdRef.current).catch((error: unknown) => {
        Sentry.captureException(error);
      });
    },
    [confirmRun]
  );

  const cancel = useCallback((): void => {
    track(REQUEST_FILE_EVENTS.SHARE_DIALOG_CANCELLED, {
      entry_point: entryRef.current,
      upload_complete: uploadedRef.current,
    });
    abandonRun();
    setState(IDLE);
  }, [abandonRun]);

  return {
    upload: state.upload,
    pending: state.pending,
    confirming: state.confirming,
    error: state.error,
    pickFile,
    retryUpload,
    submit,
    cancel,
  };
}
