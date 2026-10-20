'use client';

import { useCallback, useRef, useState } from 'react';
import { FileText, Loader2, Paperclip, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { putWithProgress, formatBytes } from '@/components/balo/document-uploader/upload-file';
import {
  PROPOSAL_DOCUMENT_ALLOWED_CONTENT_TYPES,
  MAX_PROPOSAL_DOCUMENT_BYTES,
  PROPOSAL_DOCUMENT_ACCEPT,
} from '@/lib/storage/proposal-document-constraints';
import { requestProposalDocumentUploadAction } from '@/app/(dashboard)/projects/[requestId]/_actions/request-proposal-document-upload';
import { confirmProposalDocumentUploadAction } from '@/app/(dashboard)/projects/[requestId]/_actions/confirm-proposal-document-upload';
import type { ProposalDocumentView } from '@/app/(dashboard)/projects/[requestId]/_actions/confirm-proposal-document-upload';

export type ProposalDocumentKind = 'terms' | 'ref';

interface UseProposalDocumentUploadArgs {
  requestId: string;
  relationshipId: string;
  kind: ProposalDocumentKind;
  /** Single-document mode (the terms supplement): one file at a time, the
   *  server soft-deletes the one it replaces. */
  single?: boolean;
  /** Documents of THIS controller's kind. Owned by the composer. */
  documents: ProposalDocumentView[];
  /**
   * Resolves the proposalId, FORCING a draft-create first if none exists yet
   * (documents require a persisted draft — plan edge-case 5). Returns null if the
   * draft could not be created (the composer toasts).
   */
  ensureProposalId: () => Promise<string | null>;
  onAdded: (document: ProposalDocumentView) => void;
  onRemoved: (documentId: string) => void;
}

export interface ProposalDocumentUploadController {
  /** 0–100 while a batch is uploading, else null. */
  progress: number | null;
  removingId: string | null;
  /** Uploads the files one after another; each rejected file gets its own toast. */
  uploadFiles: (files: File[]) => Promise<void>;
  remove: (documentId: string) => Promise<void>;
}

/** Null when the browser file is within the client-safe allow-list + cap, else
 *  the message to toast. */
function validateFile(file: File): string | null {
  if (!PROPOSAL_DOCUMENT_ALLOWED_CONTENT_TYPES.has(file.type)) {
    return `${file.name} isn't a supported file type.`;
  }
  if (file.size > MAX_PROPOSAL_DOCUMENT_BYTES) {
    return `${file.name} is ${formatBytes(file.size)} — files must be 10 MB or smaller.`;
  }
  return null;
}

function successMessage(added: number, single: boolean): string {
  if (single) return 'Your terms are attached';
  return added === 1 ? 'Attachment added' : `${added} files attached`;
}

/**
 * Proposal-document upload pipeline (A6.2 / BAL-288): presign → XHR PUT (with
 * progress) → confirm, plus removal. One controller per kind (`ref` attachments,
 * the single `terms` supplement); the composer owns both so the page-wide drop,
 * the Attachments section and the terms popover share one pipeline. Client-side
 * allow-list + cap are UX pre-checks; the confirm action HEAD-verifies in R2 as the
 * source of truth.
 */
export function useProposalDocumentUpload({
  requestId,
  relationshipId,
  kind,
  single = false,
  documents,
  ensureProposalId,
  onAdded,
  onRemoved,
}: Readonly<UseProposalDocumentUploadArgs>): ProposalDocumentUploadController {
  const [progress, setProgress] = useState<number | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  /** One presign → PUT → confirm. Returns true when the document was attached. */
  const uploadOne = useCallback(
    async (file: File, proposalId: string): Promise<boolean> => {
      try {
        setProgress(0);
        const presign = await requestProposalDocumentUploadAction({
          requestId,
          relationshipId,
          proposalId,
          kind,
          contentType: file.type,
          fileName: file.name,
        });
        if (!presign.success) {
          toast.error(presign.error);
          return false;
        }

        await putWithProgress({ url: presign.presignedUrl, file, onProgress: setProgress });

        const confirmed = await confirmProposalDocumentUploadAction({
          requestId,
          relationshipId,
          proposalId,
          kind,
          key: presign.key,
          fileName: file.name,
          contentType: file.type,
          sizeBytes: file.size,
        });
        if (!confirmed.success) {
          toast.error(confirmed.error);
          return false;
        }

        onAdded(confirmed.document);
        return true;
      } catch {
        toast.error("Couldn't upload that file. Please try again.");
        return false;
      }
    },
    [requestId, relationshipId, kind, onAdded]
  );

  const uploadFiles = useCallback(
    async (files: File[]): Promise<void> => {
      const candidates = single ? files.slice(0, 1) : files;
      const valid = candidates.filter((file) => {
        const validationError = validateFile(file);
        if (validationError !== null) toast.error(validationError);
        return validationError === null;
      });
      if (valid.length === 0) return;

      setProgress(0);
      try {
        const proposalId = await ensureProposalId();
        if (proposalId === null) {
          toast.error("Couldn't prepare your proposal. Please try again.");
          return;
        }
        let added = 0;
        for (const file of valid) {
          if (await uploadOne(file, proposalId)) added += 1;
        }
        if (added > 0) toast.success(successMessage(added, single));
      } finally {
        setProgress(null);
      }
    },
    [ensureProposalId, single, uploadOne]
  );

  const remove = useCallback(
    async (documentId: string): Promise<void> => {
      setRemovingId(documentId);
      try {
        const { removeProposalDocumentAction } =
          await import('@/app/(dashboard)/projects/[requestId]/_actions/remove-proposal-document');
        const proposalId = documents.find((d) => d.id === documentId)?.proposalId;
        if (proposalId === undefined) return;
        const result = await removeProposalDocumentAction({
          requestId,
          relationshipId,
          proposalId,
          documentId,
        });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        onRemoved(documentId);
        toast.success('Removed');
      } catch {
        toast.error("Couldn't remove that document. Please try again.");
      } finally {
        setRemovingId(null);
      }
    },
    [documents, requestId, relationshipId, onRemoved]
  );

  return { progress, removingId, uploadFiles, remove };
}

interface ProposalDocumentUploaderViewProps {
  controller: ProposalDocumentUploadController;
  /** Documents of the controller's kind. */
  documents: ProposalDocumentView[];
  /** Id of the element that names the file input. */
  labelId: string;
  /** Single-document mode: one file max, the picker turns into "Replace". */
  single?: boolean;
  /** Picker copy; defaults per mode. Ignored when replacing in single mode. */
  pickLabel?: string;
  /** Disabled while the proposal is no longer editable (defensive). */
  disabled?: boolean;
}

/**
 * Document list, upload progress bar and dashed picker for one
 * {@link useProposalDocumentUpload} controller. In single mode with a file already
 * attached the picker stays and reads "Replace your terms".
 */
export function ProposalDocumentUploaderView({
  controller,
  documents,
  labelId,
  single = false,
  pickLabel,
  disabled = false,
}: Readonly<ProposalDocumentUploaderViewProps>): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const { progress, removingId, uploadFiles, remove } = controller;
  const uploading = progress !== null;
  const replacing = single && documents.length > 0;
  const defaultLabel = single ? 'Attach your terms' : 'Attach a file';
  const label = replacing ? 'Replace your terms' : (pickLabel ?? defaultLabel);

  const handlePick = useCallback((): void => {
    inputRef.current?.click();
  }, []);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const files = Array.from(event.target.files ?? []);
      // Reset the input so re-picking the same file fires `change` again.
      event.target.value = '';
      if (files.length === 0) return;
      uploadFiles(files);
    },
    [uploadFiles]
  );

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        multiple={!single}
        accept={PROPOSAL_DOCUMENT_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-labelledby={labelId}
        onChange={handleChange}
        disabled={disabled || uploading}
      />

      {documents.length > 0 && (
        <ul className="space-y-2">
          {documents.map((doc) => {
            const isRemoving = removingId === doc.id;
            return (
              <li
                key={doc.id}
                className="group border-border bg-card flex items-center gap-2.5 rounded-xl border py-2 pr-2 pl-3"
              >
                <FileText className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {doc.fileName}
                  <span className="text-muted-foreground ml-2 text-[13px]">
                    {formatBytes(doc.sizeBytes)}
                  </span>
                </span>
                <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2.5 py-0.5 text-[12.5px] whitespace-nowrap">
                  {doc.kind === 'terms' ? 'Your terms' : 'Reference'}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    remove(doc.id);
                  }}
                  disabled={isRemoving || disabled}
                  aria-label={`Remove ${doc.fileName}`}
                  className="text-muted-foreground hover:bg-muted hover:text-destructive focus-visible:ring-ring flex size-11 shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50 sm:size-8"
                >
                  {isRemoving ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Trash2 className="size-4" aria-hidden="true" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {uploading && (
        <div className="space-y-1.5" aria-live="polite">
          <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
            <div
              className="bg-primary h-full rounded-full transition-[width] motion-reduce:transition-none"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-muted-foreground text-[12px]">Uploading… {progress}%</p>
        </div>
      )}

      <button
        type="button"
        onClick={handlePick}
        disabled={disabled || uploading}
        className="border-border text-muted-foreground hover:bg-muted/50 focus-visible:ring-ring flex min-h-14 w-full items-center justify-center gap-2 rounded-[14px] border-[1.5px] border-dashed p-4 text-center text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
      >
        {uploading ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <Paperclip className="size-4" aria-hidden="true" />
        )}
        {label}
      </button>
    </div>
  );
}
