'use client';

import { useState } from 'react';
import { Upload } from 'lucide-react';
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
// ⚠ FROM THE CLIENT-SAFE CONSTRAINTS MODULE, not `@/lib/storage/request-file` — that one is
// `server-only`. `REQUEST_FILE_ACCEPT` is its verbatim re-export of this same constant, so the
// picker's filter and the server's allow-list cannot drift.
import { CONVERSATION_FILE_ACCEPT as REQUEST_FILE_ACCEPT } from '@/lib/storage/conversation-file-constraints';
import { requestSharedFileUploadAction } from '@/app/(dashboard)/projects/[requestId]/_actions/request-shared-file-upload';
import { confirmRequestFileUploadAction } from '@/app/(dashboard)/projects/[requestId]/_actions/confirm-request-file-upload';
import { getRequestFileDownloadAction } from '@/app/(dashboard)/projects/[requestId]/_actions/get-request-file-download';
import { revokeRequestFileGrantAction } from '@/app/(dashboard)/projects/[requestId]/_actions/revoke-request-file-grant';
import { deleteRequestFileAction } from '@/app/(dashboard)/projects/[requestId]/_actions/delete-request-file';
import type { RequestFilesView } from '@/lib/request-files/load-request-files';
import type {
  ClientRequestFileView,
  ExpertRequestFileView,
} from '@/lib/request-files/request-file-audience-view';
import { RequestFileRow } from './request-file-row';
import { ExpertClosureBanner } from './expert-closure-banner';
import { ShareFileSheet, type ShareFileMode } from './share-file-sheet';

interface RequestFilesPanelProps {
  requestId: string;
  /** The caller (page.tsx) renders this component only when the loader returned a view. */
  initialView: RequestFilesView;
}

/**
 * ⚠ LOADING / ERROR ARE THE ROUTE'S CONCERN, NOT THIS ISLAND'S. Data arrives fully resolved
 * from the server loader (`loadRequestFiles`) as `initialView` — there is no client-side fetch
 * to be "loading" or "error" about. `/projects/[requestId]/loading.tsx` and `error.tsx` are the
 * segment-level boundaries CLAUDE.md's "all four async states" requires; this component's own
 * states are SUCCESS (the list), EMPTY (per lens, below), and the per-mutation loading/error
 * affordances on each row (download/delete spinners, toasts).
 */
/**
 * The share-success toast copy — extracted so the pluralisation ternary isn't nested (S3358).
 *
 * ⚠ GRANTS MODE NAMES THE RECIPIENTS (design ref: `Shared with ${names}.`). "Shared with the
 * selected experts" makes the acting client re-open the row to check they picked the right
 * people; naming them is the confirmation.
 */
function shareSuccessCopy(
  mode: ShareFileMode,
  liveCount: number,
  recipientNames: readonly string[]
): string {
  if (mode === 'all_live_tracks') {
    const noun = liveCount === 1 ? 'expert' : 'experts';
    return `Shared with ${liveCount} ${noun}.`;
  }
  if (recipientNames.length === 0) return 'Shared with the selected experts.';
  return `Shared with ${listNames(recipientNames)}.`;
}

/** "A", "A and B", "A, B and C" — one flat reduction, no nested ternary. */
function listNames(names: readonly string[]): string {
  const [first] = names;
  if (first === undefined) return '';
  if (names.length === 1) return first;
  const head = names.slice(0, -1).join(', ');
  const tail = names[names.length - 1] ?? '';
  return `${head} and ${tail}`;
}

interface DeleteFileConfirmProps {
  pending: { id: string; fileName: string } | null;
  onCancel: () => void;
  onConfirm: (fileId: string) => void;
}

/**
 * The delete confirmation (BAL-431 — Rulings 1 + 3 together made this mandatory). ONE component
 * mounted by both mutating lenses rather than duplicated markup, and deliberately NOT a browser
 * `confirm()`: that is unstyleable, unannounced to assistive tech and blocks the event loop.
 *
 * The copy names the file and states the two consequences plainly — irreversible, and silent —
 * because delete sends no notification by design.
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

async function uploadToPresignedUrl(presignedUrl: string, file: File): Promise<boolean> {
  try {
    const res = await fetch(presignedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * BAL-431 §7.2 — the request-level files panel. ONE component, audience-keyed by the view
 * shape the server loader already resolved — the three lenses are three view shapes, not three
 * components. Owns optimistic island state; NO `revalidatePath` anywhere in this feature.
 */
export function RequestFilesPanel({
  requestId,
  initialView,
}: Readonly<RequestFilesPanelProps>): React.JSX.Element {
  const [view, setView] = useState<RequestFilesView>(initialView);
  const [shareOpen, setShareOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [revokingRelationshipId, setRevokingRelationshipId] = useState<string | null>(null);
  /**
   * ⚠ DELETE IS CONFIRMED, AND IT HAS TO BE. Ruling 1 made delete destroy the R2 object and
   * Ruling 3 made the right PARTY-LEVEL, so one misclick by any member of the uploading side
   * irreversibly removes a file for everyone, silently (no notification is sent, by design).
   * The pending row is held here rather than in the row so the dialog can name the file.
   */
  const [pendingDelete, setPendingDelete] = useState<{ id: string; fileName: string } | null>(null);

  async function handleDownload(fileId: string): Promise<void> {
    setDownloadingId(fileId);
    try {
      const result = await getRequestFileDownloadAction({ requestId, fileId });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      globalThis.open(result.url, '_blank', 'noopener,noreferrer');
    } finally {
      setDownloadingId(null);
    }
  }

  /** Opens the confirmation. The row's `onDelete` contract is unchanged — still `(id) => void`. */
  function requestDelete(fileId: string): void {
    if (view.lens === 'admin') return; // admin never deletes
    const target = view.files.find((f) => f.id === fileId);
    if (target === undefined) return;
    setPendingDelete({ id: fileId, fileName: target.fileName });
  }

  async function handleDelete(fileId: string): Promise<void> {
    setPendingDelete(null);
    setDeletingId(fileId);
    try {
      const result = await deleteRequestFileAction({ requestId, fileId });
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
    } finally {
      setDeletingId(null);
    }
  }

  async function handleRevoke(
    fileId: string,
    relationshipId: string,
    trackName: string
  ): Promise<void> {
    setRevokingRelationshipId(relationshipId);
    try {
      const result = await revokeRequestFileGrantAction({ requestId, fileId, relationshipId });
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
          };
        });
        return { ...current, files };
      });
      toast.success(`Access removed. ${trackName} is not notified.`);
    } finally {
      setRevokingRelationshipId(null);
    }
  }

  async function handleShareSubmit(
    mode: ShareFileMode,
    relationshipIds: string[],
    file: File
  ): Promise<void> {
    setSharing(true);
    try {
      const presigned = await requestSharedFileUploadAction({
        requestId,
        contentType: file.type || 'application/octet-stream',
        fileName: file.name,
        // Signed into the PUT as a ContentLength condition — R2 refuses any other body length.
        sizeBytes: file.size,
      });
      if (!presigned.success) {
        toast.error(presigned.error);
        return;
      }
      const uploaded = await uploadToPresignedUrl(presigned.presignedUrl, file);
      if (!uploaded) {
        toast.error('Could not share your file. Please try again.');
        return;
      }
      const share =
        mode === 'all_live_tracks'
          ? ({ mode: 'all_live_tracks' } as const)
          : ({ mode: 'grants', relationshipIds } as const);
      const confirmed = await confirmRequestFileUploadAction({
        requestId,
        key: presigned.key,
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        share,
      });
      if (!confirmed.success) {
        toast.error(confirmed.error);
        return;
      }
      const newFile: ClientRequestFileView | ExpertRequestFileView = confirmed.view;
      setView((current): RequestFilesView => {
        if (current.lens !== 'client' || !('audience' in newFile)) return current;
        return { ...current, files: [newFile, ...current.files] };
      });
      const liveCount = view.lens === 'client' ? view.liveTracks.length : 0;
      const recipientNames =
        view.lens === 'client'
          ? view.liveTracks
              .filter((t) => relationshipIds.includes(t.relationshipId))
              .map((t) => t.trackName)
          : [];
      toast.success(shareSuccessCopy(mode, liveCount, recipientNames));
      setShareOpen(false);
    } finally {
      setSharing(false);
    }
  }

  async function handleExpertUpload(file: File): Promise<void> {
    setSharing(true);
    try {
      const presigned = await requestSharedFileUploadAction({
        requestId,
        contentType: file.type || 'application/octet-stream',
        fileName: file.name,
        // Signed into the PUT as a ContentLength condition — R2 refuses any other body length.
        sizeBytes: file.size,
      });
      if (!presigned.success) {
        toast.error(presigned.error);
        return;
      }
      const uploaded = await uploadToPresignedUrl(presigned.presignedUrl, file);
      if (!uploaded) {
        toast.error('Could not share your file. Please try again.');
        return;
      }
      const confirmed = await confirmRequestFileUploadAction({
        requestId,
        key: presigned.key,
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        share: { mode: 'all_live_tracks' }, // ignored server-side on the expert arm
      });
      if (!confirmed.success) {
        toast.error(confirmed.error);
        return;
      }
      const newFile: ClientRequestFileView | ExpertRequestFileView = confirmed.view;
      setView((current): RequestFilesView => {
        if (current.lens !== 'expert' || 'audience' in newFile) return current;
        return { ...current, files: [newFile, ...current.files] };
      });
      toast.success('Uploaded. Visible to the client only.');
    } finally {
      setSharing(false);
    }
  }

  if (view.lens === 'admin') {
    return (
      <div className="border-border bg-card rounded-xl border">
        <div className="border-border border-b px-4 py-3 text-sm font-semibold">
          All files on this request
        </div>
        {/*
          ⚠ ABSENCE-FRAMED ON PURPOSE, AND THIS IS THE JUSTIFICATION CLAUDE.md's empty-state
          rule requires. Invitation framing ("Share a file with…") is owed wherever the viewer
          could ACT on the empty section. The admin lens is read-only BY CONSTRUCTION — §6, the
          sole all-files read, gated on `hasPlatformCapability(VIEW_ANY_REQUEST_FILE)`, and it
          never reaches an upload/grant/delete path (asserted at three call sites and by the
          invariant tests). There is nothing to invite a Balo admin toward here, so a plain
          factual statement is the honest copy. Do not "fix" this to invitation framing.
        */}
        {view.files.length === 0 ? (
          <p className="text-muted-foreground px-4 py-8 text-center text-sm">
            No files have been shared on this request yet.
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {view.files.map((file) => (
              <RequestFileRow key={file.id} lens="admin" file={file} />
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (view.lens === 'expert') {
    return (
      <div className="border-border bg-card rounded-xl border">
        <div className="border-border border-b px-4 py-3">
          <div className="text-sm font-semibold">
            Files shared between you and the client on this request.
          </div>
        </div>
        {view.closedReason !== null && <ExpertClosureBanner reason={view.closedReason} />}
        {view.files.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-foreground text-sm font-semibold">Share a file with the client</p>
            <p className="text-muted-foreground mt-1 text-xs">
              A profile, a reference, an approach note — anything you upload here goes to the client
              only.
            </p>
          </div>
        ) : (
          <ul className="divide-border divide-y">
            {view.files.map((file) => (
              <RequestFileRow
                key={file.id}
                lens="expert"
                file={file}
                clientPartyName={view.clientPartyName}
                onDownload={handleDownload}
                onDelete={requestDelete}
                downloadingId={downloadingId}
                deletingId={deletingId}
              />
            ))}
          </ul>
        )}
        <div className="border-border border-t px-4 py-3">
          <label className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none">
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            Upload to this conversation
            <input
              type="file"
              accept={REQUEST_FILE_ACCEPT}
              className="sr-only"
              disabled={sharing || view.closedReason !== null}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file !== undefined) {
                  // No `void` (SonarCloud S3735), and the catch is load-bearing:
                  // `handleExpertUpload` is try/finally with no catch, so a network
                  // failure would otherwise reject unhandled and the button would simply
                  // re-enable with no feedback.
                  handleExpertUpload(file).catch(() => {
                    toast.error('Could not share your file. Please try again.');
                  });
                }
                e.target.value = '';
              }}
            />
          </label>
          <p className="text-muted-foreground mt-1.5 text-xs">
            Uploads are visible to the client only. There is no audience to choose.
          </p>
        </div>
        <DeleteFileConfirm
          pending={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={(fileId) => void handleDelete(fileId)}
        />
      </div>
    );
  }

  // view.lens === 'client'
  return (
    <div className="border-border bg-card rounded-xl border">
      <div className="border-border flex items-center justify-between border-b px-4 py-3">
        <div>
          <div className="text-sm font-semibold">Files on this request</div>
          <div className="text-muted-foreground text-xs">
            You see every file. Experts see only what is shared with them.
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShareOpen(true)}
          className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
        >
          <Upload className="h-3.5 w-3.5" aria-hidden="true" />
          Share a file
        </button>
      </div>

      {view.files.length === 0 ? (
        <div className="px-4 py-8 text-center">
          <p className="text-foreground text-sm font-semibold">
            Share a file with the experts on this request
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            Requirements, org exports, a security questionnaire — share it once and choose who sees
            it.
          </p>
        </div>
      ) : (
        <ul className="divide-border divide-y">
          {view.files.map((file) => (
            <RequestFileRow
              key={file.id}
              lens="client"
              file={file}
              onDownload={handleDownload}
              onDelete={requestDelete}
              onRevoke={handleRevoke}
              downloadingId={downloadingId}
              deletingId={deletingId}
              revokingRelationshipId={revokingRelationshipId}
            />
          ))}
        </ul>
      )}

      <ShareFileSheet
        open={shareOpen}
        onOpenChange={setShareOpen}
        liveTracks={view.liveTracks}
        submitting={sharing}
        onSubmit={handleShareSubmit}
      />

      <DeleteFileConfirm
        pending={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={(fileId) => void handleDelete(fileId)}
      />
    </div>
  );
}
