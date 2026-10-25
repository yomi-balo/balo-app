'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as Sentry from '@sentry/nextjs';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { track, REQUEST_FILE_EVENTS } from '@/lib/analytics';
import { getRequestFileDownloadAction } from '@/app/(dashboard)/projects/[requestId]/_actions/get-request-file-download';
import { revokeRequestFileGrantAction } from '@/app/(dashboard)/projects/[requestId]/_actions/revoke-request-file-grant';
import { deleteRequestFileAction } from '@/app/(dashboard)/projects/[requestId]/_actions/delete-request-file';
import type { ConversationMessageView } from '@/lib/conversations/conversation-view-types';
import type { RequestFilesView } from '@/lib/request-files/load-request-files';
import type {
  ClientRequestFileView,
  ExpertRequestFileView,
} from '@/lib/request-files/request-file-audience-view';
import { RequestFilesSheet } from './request-files-sheet';
import { ShareFileSheet } from './share-file-sheet';
import {
  useRequestFilePreview,
  type PreviewTarget,
  type RequestFilePreviewSurface,
} from './use-request-file-preview';
import { useRequestFileShare, type ShareCompleted } from './use-request-file-share';
import type { ShareRecipients } from './share-file-types';

/** Receives the card messages a share posted, so the open conversation can show them at once. */
export type ThreadMessageSink = (
  messages: ReadonlyArray<{ relationshipId: string; message: ConversationMessageView }>
) => void;

export interface RequestFilesContextValue {
  requestId: string;
  view: RequestFilesView;
  downloadingId: string | null;
  previewingId: string | null;
  deletingId: string | null;
  revokingRelationshipId: string | null;
  download: (fileId: string) => void;
  preview: (file: PreviewTarget, surface: RequestFilePreviewSurface) => void;
  requestRemove: (fileId: string) => void;
  revoke: (fileId: string, relationshipId: string, trackName: string) => void;
  /** Adds a freshly shared file to the list and hands its thread cards to the open conversation. */
  completeShare: (result: ShareCompleted) => void;
  openAllFiles: () => void;
  registerThreadMessageSink: (sink: ThreadMessageSink | null) => void;
}

const RequestFilesContext = createContext<RequestFilesContextValue | null>(null);

/**
 * The shared file list and its actions, or `null` outside the provider or when the viewer has no
 * file lens — callers render their no-files fallback for `null`, never an error.
 */
export function useRequestFiles(): RequestFilesContextValue | null {
  return useContext(RequestFilesContext);
}

/**
 * Registers the open conversation's handler for share cards. `null` (or no provider) unregisters;
 * the handler is read at delivery time, so it need not be memoized.
 */
export function useRegisterThreadMessageSink(sink: ThreadMessageSink | null): void {
  const files = useRequestFiles();
  const register = files?.registerThreadMessageSink;
  useEffect(() => {
    if (register === undefined) return;
    register(sink);
    return () => register(null);
  }, [register, sink]);
}

/** What the open conversation needs to offer a share: whether, which options, and to whom. */
export interface ThreadShare {
  allowed: boolean;
  options: 'none' | 'thread';
  recipients: ShareRecipients;
}

/**
 * ⚠ `view.lens` IS THE LOADER'S VIEW-SHAPE DISCRIMINANT, assigned from the gate's
 * already-capability-checked `scope.side`, not a role re-read in the browser. Branching on it
 * picks which of three server-decided shapes to present; it is never a second authorization
 * decision (the confirm action re-authorizes everything). A client may share only into a live
 * track's thread; an expert only while their own track is open. Options exist for a client on a
 * matched request alone — a direct request and the expert side have one recipient.
 */
export function deriveThreadShare(view: RequestFilesView, relationshipId: string): ThreadShare {
  if (view.lens === 'client') {
    return {
      allowed: view.liveTracks.some((t) => t.relationshipId === relationshipId),
      options: view.requestKind === 'matched' ? 'thread' : 'none',
      recipients: { side: 'client', liveTracks: view.liveTracks },
    };
  }
  if (view.lens === 'expert') {
    return {
      allowed: view.closedReason === null,
      options: 'none',
      recipients: { side: 'expert', clientPartyName: view.clientPartyName },
    };
  }
  return { allowed: false, options: 'none', recipients: { side: 'client', liveTracks: [] } };
}

/** The recipients the All-files dialog offers: a client's live experts; nothing for anyone else. */
function allFilesRecipients(view: RequestFilesView): ShareRecipients {
  if (view.lens === 'client') return { side: 'client', liveTracks: view.liveTracks };
  return { side: 'client', liveTracks: [] };
}

interface DeleteFileConfirmProps {
  pending: { id: string; fileName: string } | null;
  onCancel: () => void;
  onConfirm: (fileId: string) => void;
}

/**
 * The delete confirmation. Delete destroys the R2 object and the right is PARTY-LEVEL, so one
 * misclick by any member of the uploading side irreversibly removes a file for everyone,
 * silently (no notification is sent, by design). It names the file and says so plainly.
 */
function DeleteFileConfirm({
  pending,
  onCancel,
  onConfirm,
}: Readonly<DeleteFileConfirmProps>): React.JSX.Element {
  return (
    <AlertDialog open={pending !== null} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {pending?.fileName ?? 'this file'}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the file for everyone it was shared with, and it cannot be undone. No one
            is notified.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep file</AlertDialogCancel>
          <AlertDialogAction onClick={() => pending !== null && onConfirm(pending.id)}>
            Remove file
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface RequestFilesProviderProps {
  requestId: string;
  /** The loader's view; `null` ⇒ the viewer has no file lens and the provider adds nothing. */
  initialView: RequestFilesView | null;
  /** The request brief's documents, listed first in the All files sheet. */
  brief: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Owns the request's file list for the whole page: the Files card, the All files sheet, the
 * conversation's share cards and the share dialog's All-files mode all read it from here, so a
 * file shared in one place appears in all of them. Optimistic island state; no
 * `revalidatePath` anywhere in this feature.
 */
export function RequestFilesProvider({
  requestId,
  initialView,
  brief,
  children,
}: Readonly<RequestFilesProviderProps>): React.JSX.Element {
  if (initialView === null) return <>{children}</>;
  return (
    <ActiveRequestFilesProvider requestId={requestId} initialView={initialView} brief={brief}>
      {children}
    </ActiveRequestFilesProvider>
  );
}

function ActiveRequestFilesProvider({
  requestId,
  initialView,
  brief,
  children,
}: Readonly<
  Omit<RequestFilesProviderProps, 'initialView'> & { initialView: RequestFilesView }
>): React.JSX.Element {
  const [view, setView] = useState<RequestFilesView>(initialView);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [shareNewOpen, setShareNewOpen] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [revokingRelationshipId, setRevokingRelationshipId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; fileName: string } | null>(null);
  const sinkRef = useRef<ThreadMessageSink | null>(null);

  const download = useCallback(
    (fileId: string): void => {
      setDownloadingId(fileId);
      getRequestFileDownloadAction({ requestId, fileId })
        .then((result) => {
          if (!result.success) {
            toast.error(result.error);
            return;
          }
          // Same-tab: the URL forces an attachment disposition, so this downloads in place. A
          // `window.open` after the await runs outside the click's user gesture, which iOS
          // Safari blocks as a popup.
          globalThis.location.assign(result.url);
        })
        .catch((error: unknown) => {
          // The action call itself rejected (offline, deploy skew) — it never got to answer.
          Sentry.captureException(error);
          toast.error('Could not download this file. Please try again.');
        })
        .finally(() => setDownloadingId(null));
    },
    [requestId]
  );

  const { preview, previewingId, viewer } = useRequestFilePreview({
    requestId,
    viewerSide: view.lens,
    onDownload: download,
  });

  const requestRemove = useCallback(
    (fileId: string): void => {
      if (view.lens === 'admin') return; // admin never deletes
      const target = view.files.find((f) => f.id === fileId);
      if (target === undefined) return;
      setPendingDelete({ id: fileId, fileName: target.fileName });
    },
    [view]
  );

  const confirmRemove = useCallback(
    (fileId: string): void => {
      setPendingDelete(null);
      setDeletingId(fileId);
      deleteRequestFileAction({ requestId, fileId })
        .then((result) => {
          if (!result.success) {
            toast.error(result.error);
            return;
          }
          setView((current): RequestFilesView => {
            if (current.lens === 'admin') return current; // admin never deletes
            return {
              ...current,
              files: current.files.filter((f) => f.id !== fileId),
            } as RequestFilesView;
          });
          toast.success('File removed. No notification is sent.');
        })
        .catch((error: unknown) => {
          Sentry.captureException(error);
          toast.error('Could not remove this file. Please try again.');
        })
        .finally(() => setDeletingId(null));
    },
    [requestId]
  );

  const revoke = useCallback(
    (fileId: string, relationshipId: string, trackName: string): void => {
      setRevokingRelationshipId(relationshipId);
      revokeRequestFileGrantAction({ requestId, fileId, relationshipId })
        .then((result) => {
          if (!result.success) {
            toast.error(result.error);
            return;
          }
          setView((current): RequestFilesView => {
            if (current.lens !== 'client') return current;
            const files: ClientRequestFileView[] = current.files.map((f) => {
              if (f.id !== fileId || f.audience.type !== 'grants') return f;
              return {
                ...f,
                audience: {
                  type: 'grants',
                  grants: f.audience.grants.filter((g) => g.relationshipId !== relationshipId),
                },
                visibleToLiveTrackIds: f.visibleToLiveTrackIds.filter(
                  (id) => id !== relationshipId
                ),
              };
            });
            return { ...current, files };
          });
          toast.success(`Access removed. ${trackName} is not notified.`);
        })
        .catch((error: unknown) => {
          Sentry.captureException(error);
          toast.error('Could not remove access. Please try again.');
        })
        .finally(() => setRevokingRelationshipId(null));
    },
    [requestId]
  );

  const completeShare = useCallback((result: ShareCompleted): void => {
    const newFile: ClientRequestFileView | ExpertRequestFileView = result.view;
    setView((current): RequestFilesView => {
      if (current.lens === 'client' && 'audience' in newFile) {
        return { ...current, files: [newFile, ...current.files] };
      }
      if (current.lens === 'expert' && !('audience' in newFile)) {
        return { ...current, files: [newFile, ...current.files] };
      }
      return current;
    });
    sinkRef.current?.(result.threadMessages);
  }, []);

  const registerThreadMessageSink = useCallback((sink: ThreadMessageSink | null): void => {
    sinkRef.current = sink;
  }, []);

  const openAllFiles = useCallback((): void => setSheetOpen(true), []);

  const handleShared = useCallback(
    (result: ShareCompleted): void => {
      setShareNewOpen(false);
      completeShare(result);
    },
    [completeShare]
  );

  const shareNew = useRequestFileShare({
    requestId,
    recipients: allFilesRecipients(view),
    defaultEntryPoint: 'all_files',
    onShared: handleShared,
  });

  const handleOpenShareNew = useCallback((): void => {
    setSheetOpen(false);
    track(REQUEST_FILE_EVENTS.SHARE_DIALOG_OPENED, { entry_point: 'all_files' });
    setShareNewOpen(true);
  }, []);

  const { cancel: cancelShareNew, pickFile: pickShareNewFile } = shareNew;
  const handleCancelShareNew = useCallback((): void => {
    cancelShareNew();
    setShareNewOpen(false);
  }, [cancelShareNew]);

  const handlePickFile = useCallback(
    (file: File): void => pickShareNewFile(file, 'all_files'),
    [pickShareNewFile]
  );

  const value = useMemo<RequestFilesContextValue>(
    () => ({
      requestId,
      view,
      downloadingId,
      previewingId,
      deletingId,
      revokingRelationshipId,
      download,
      preview,
      requestRemove,
      revoke,
      completeShare,
      openAllFiles,
      registerThreadMessageSink,
    }),
    [
      requestId,
      view,
      downloadingId,
      previewingId,
      deletingId,
      revokingRelationshipId,
      download,
      preview,
      requestRemove,
      revoke,
      completeShare,
      openAllFiles,
      registerThreadMessageSink,
    ]
  );

  return (
    <RequestFilesContext.Provider value={value}>
      {children}
      <RequestFilesSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        brief={brief}
        onShareNew={handleOpenShareNew}
      />
      <ShareFileSheet
        open={shareNewOpen}
        mode={{ kind: 'all_files' }}
        recipients={allFilesRecipients(view)}
        upload={shareNew.upload}
        pending={shareNew.pending}
        confirming={shareNew.confirming}
        error={shareNew.error}
        onPickFile={handlePickFile}
        onRetryUpload={shareNew.retryUpload}
        onSubmit={shareNew.submit}
        onCancel={handleCancelShareNew}
      />
      <DeleteFileConfirm
        pending={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmRemove}
      />
      {viewer}
    </RequestFilesContext.Provider>
  );
}
