'use client';

import { useCallback, useRef, useState } from 'react';
import { FileText, Loader2, Trash2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
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

interface ProposalDocumentUploaderProps {
  requestId: string;
  relationshipId: string;
  /** Documents of THIS uploader's kind. Owned by the composer. */
  documents: ProposalDocumentView[];
  kind: ProposalDocumentKind;
  /**
   * Resolves the proposalId, FORCING a draft-create first if none exists yet
   * (documents require a persisted draft — plan edge-case 5). Returns null if the
   * draft could not be created (the composer toasts).
   */
  ensureProposalId: () => Promise<string | null>;
  onAdded: (document: ProposalDocumentView) => void;
  onRemoved: (documentId: string) => void;
  /** Single-doc mode (the terms supplement) — one max, "Replace" affordance. */
  single?: boolean;
  /** Disabled while the proposal is no longer editable (defensive). */
  disabled?: boolean;
  labelId: string;
}

/** True when the browser file is within the client-safe allow-list + cap. */
function validateFile(file: File): string | null {
  if (!PROPOSAL_DOCUMENT_ALLOWED_CONTENT_TYPES.has(file.type)) {
    return `${file.name} isn't a supported file type.`;
  }
  if (file.size > MAX_PROPOSAL_DOCUMENT_BYTES) {
    return `${file.name} is ${formatBytes(file.size)} — files must be 10 MB or smaller.`;
  }
  return null;
}

/**
 * Shared proposal-document uploader (A6.2 / BAL-288): presign → XHR PUT (with
 * progress) → confirm. Used for general `ref` attachments AND the single `terms`
 * supplement (`single`). Client-side allow-list + cap are UX pre-checks; the
 * confirm action HEAD-verifies in R2 as the source of truth.
 */
export function ProposalDocumentUploader({
  requestId,
  relationshipId,
  documents,
  kind,
  ensureProposalId,
  onAdded,
  onRemoved,
  single = false,
  disabled = false,
  labelId,
}: Readonly<ProposalDocumentUploaderProps>): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const uploading = progress !== null;
  const [firstDocument] = documents;
  const atCapacity = single && firstDocument !== undefined;

  const handlePick = useCallback((): void => {
    if (disabled || uploading) return;
    inputRef.current?.click();
  }, [disabled, uploading]);

  const uploadFile = useCallback(
    async (file: File): Promise<void> => {
      const validationError = validateFile(file);
      if (validationError !== null) {
        toast.error(validationError);
        return;
      }

      setProgress(0);
      try {
        const proposalId = await ensureProposalId();
        if (proposalId === null) {
          toast.error("Couldn't prepare your proposal. Please try again.");
          return;
        }

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
          return;
        }

        await putWithProgress({
          url: presign.presignedUrl,
          file,
          onProgress: setProgress,
        });

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
          return;
        }

        onAdded(confirmed.document);
        toast.success(single ? 'Terms supplement attached' : 'Attachment added');
      } catch {
        toast.error("Couldn't upload that file. Please try again.");
      } finally {
        setProgress(null);
      }
    },
    [ensureProposalId, requestId, relationshipId, kind, onAdded, single]
  );

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const file = event.target.files?.[0];
      // Reset the input so re-picking the same file fires `change` again.
      event.target.value = '';
      if (file === undefined) return;
      void uploadFile(file);
    },
    [uploadFile]
  );

  const handleRemove = useCallback(
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

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        accept={PROPOSAL_DOCUMENT_ACCEPT}
        className="sr-only"
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
                className="border-border bg-card flex items-center gap-2.5 rounded-[10px] border px-3 py-2.5"
              >
                <span className="bg-primary/10 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
                  <FileText className="text-primary h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-foreground block truncate text-[13px] font-semibold">
                    {doc.fileName}
                  </span>
                  <span className="text-muted-foreground block text-[11px]">
                    {formatBytes(doc.sizeBytes)}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void handleRemove(doc.id)}
                  disabled={isRemoving || disabled}
                  aria-label={`Remove ${doc.fileName}`}
                  className="text-muted-foreground hover:text-destructive focus-visible:ring-ring flex h-8 w-8 items-center justify-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
                >
                  {isRemoving ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
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
              className="bg-primary h-full rounded-full transition-[width]"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-muted-foreground text-[11px]">Uploading… {progress}%</p>
        </div>
      )}

      {!atCapacity && (
        <button
          type="button"
          onClick={handlePick}
          disabled={disabled || uploading}
          className={cn(
            'border-border text-foreground hover:bg-muted/50 focus-visible:ring-ring inline-flex min-h-11 items-center gap-2 rounded-[10px] border border-dashed px-4 text-[13px] font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60'
          )}
        >
          {uploading ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Upload className="h-4 w-4" aria-hidden="true" />
          )}
          {single ? 'Attach terms supplement' : 'Attach a file'}
        </button>
      )}

      {atCapacity && firstDocument !== undefined && (
        <button
          type="button"
          onClick={() => void handleRemove(firstDocument.id)}
          disabled={disabled || removingId !== null}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex items-center gap-1.5 rounded-md text-[12px] font-medium focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
          Remove to replace
        </button>
      )}
    </div>
  );
}
