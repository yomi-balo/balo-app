'use client';

import { useCallback, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import {
  Upload,
  FileText,
  Image as ImageIcon,
  X,
  Loader2,
  RotateCw,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { requestProjectDocumentUploadAction } from '@/lib/project-request/actions/request-project-document-upload';
import { confirmProjectDocumentUploadAction } from '@/lib/project-request/actions/confirm-project-document-upload';
import { removeProjectDocumentAction } from '@/lib/project-request/actions/remove-project-document';
import type { ProjectDocumentRef } from '@/lib/project-request/actions/schemas';
import { PROJECT_DOCUMENT_CONTENT_TYPES } from '@/lib/project-request/actions/schemas';
import {
  partitionFiles,
  putWithProgress,
  formatBytes,
  DOCUMENT_ACCEPT,
  MAX_DOCUMENTS,
  type FileRejection,
} from './document-uploader/upload-file';

const ALLOWED_CONTENT_TYPE_SET = new Set<string>(PROJECT_DOCUMENT_CONTENT_TYPES);

/** Narrow the confirm action's `string` contentType to the document-ref enum. */
function toDocumentRef(doc: {
  r2Key: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}): ProjectDocumentRef | null {
  if (!ALLOWED_CONTENT_TYPE_SET.has(doc.contentType)) return null;
  return {
    r2Key: doc.r2Key,
    fileName: doc.fileName,
    contentType: doc.contentType as ProjectDocumentRef['contentType'],
    sizeBytes: doc.sizeBytes,
  };
}

type FileStatus = 'uploading' | 'success' | 'failed';

interface UploadRow {
  /** Stable client id for the row (also the React key). */
  id: string;
  file: File;
  status: FileStatus;
  progress: number;
  /** Confirmed R2 ref — present only when `status === 'success'`. */
  ref: ProjectDocumentRef | null;
  error?: string;
}

interface DocumentUploaderProps {
  /** Bubbles the current set of CONFIRMED document refs (for submit + draft). */
  onDocumentsChange: (docs: ProjectDocumentRef[]) => void;
  /** Bubbles whether any upload is still in flight (gates submit). */
  onUploadingChange?: (uploading: boolean) => void;
}

function isImageType(type: string): boolean {
  return type.startsWith('image/');
}

/**
 * Multi-file project-document uploader. Generalises the avatar `photo-upload`
 * presign→PUT→confirm flow to many files with per-file state + real per-file
 * progress (XHR `upload.onprogress`). Client guards (type/size/count) run BEFORE
 * any network call; the server confirm action re-checks as the source of truth.
 * Holds only CONFIRMED refs for submit/draft; in-flight/failed rows are never
 * persisted.
 */
export function DocumentUploader({
  onDocumentsChange,
  onUploadingChange,
}: Readonly<DocumentUploaderProps>): React.JSX.Element {
  const reduce = useReducedMotion();
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [rejections, setRejections] = useState<FileRejection[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const xhrRefs = useRef<Record<string, XMLHttpRequest>>({});
  const rejectionTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Recompute + bubble confirmed refs + uploading flag from the latest rows.
  const publish = useCallback(
    (next: UploadRow[]) => {
      const docs = next
        .filter((r): r is UploadRow & { ref: ProjectDocumentRef } => r.ref !== null)
        .map((r) => r.ref);
      onDocumentsChange(docs);
      onUploadingChange?.(next.some((r) => r.status === 'uploading'));
    },
    [onDocumentsChange, onUploadingChange]
  );

  const setRowsAndPublish = useCallback(
    (updater: (prev: UploadRow[]) => UploadRow[]) => {
      setRows((prev) => {
        const next = updater(prev);
        publish(next);
        return next;
      });
    },
    [publish]
  );

  const patchRow = useCallback(
    (id: string, patch: Partial<UploadRow>) => {
      setRowsAndPublish((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    },
    [setRowsAndPublish]
  );

  // Run the presign → PUT(progress) → confirm pipeline for a single row.
  const runUpload = useCallback(
    async (id: string, file: File) => {
      patchRow(id, { status: 'uploading', progress: 0, error: undefined });
      try {
        const presign = await requestProjectDocumentUploadAction({
          contentType: file.type,
          fileName: file.name,
        });
        if (!presign.success || !presign.presignedUrl || !presign.key) {
          throw new Error(presign.error ?? 'Failed to prepare upload');
        }

        await putWithProgress({
          url: presign.presignedUrl,
          file,
          onProgress: (pct) => patchRow(id, { progress: pct }),
          onStart: (xhr) => {
            xhrRefs.current[id] = xhr;
          },
        });

        const confirm = await confirmProjectDocumentUploadAction({
          key: presign.key,
          fileName: file.name,
          contentType: file.type,
          sizeBytes: file.size,
        });
        if (!confirm.success || !confirm.document) {
          throw new Error(confirm.error ?? 'Failed to save document');
        }
        const ref = toDocumentRef(confirm.document);
        if (ref === null) {
          throw new Error('This file type is not supported');
        }

        delete xhrRefs.current[id];
        patchRow(id, { status: 'success', progress: 100, ref });
      } catch (error) {
        delete xhrRefs.current[id];
        const message = error instanceof Error ? error.message : 'Upload failed';
        patchRow(id, { status: 'failed', error: message, ref: null });
        toast.error(`Couldn't upload ${file.name}. Tap retry.`);
      }
    },
    [patchRow]
  );

  // Identity for a rejection row — MUST match the render key so the auto-dismiss
  // timer removes exactly one row (two rejections sharing a filename, e.g. a
  // type+size pair or the same file dropped twice, dismiss independently).
  const rejectionKey = useCallback((rej: FileRejection) => `${rej.fileName}-${rej.reason}`, []);

  const dismissRejection = useCallback(
    (key: string) => {
      setRejections((prev) => prev.filter((r) => rejectionKey(r) !== key));
    },
    [rejectionKey]
  );

  // Validate + queue an incoming selection.
  const handleFiles = useCallback(
    (incoming: File[]) => {
      setRows((prev) => {
        const { accepted, rejected } = partitionFiles(incoming, prev.length);

        for (const rej of rejected) {
          toast.error(rej.message);
          // Auto-dismiss the inline row after ~4s, keyed by the SAME composite
          // identity as the render key so it removes exactly this row.
          const key = rejectionKey(rej);
          rejectionTimers.current[key] = setTimeout(() => dismissRejection(key), 4000);
        }
        if (rejected.length > 0) setRejections((r) => [...r, ...rejected]);
        if (accepted.length === 0) return prev;

        const newRows: UploadRow[] = accepted.map((file) => ({
          id: crypto.randomUUID(),
          file,
          status: 'uploading',
          progress: 0,
          ref: null,
        }));
        const next = [...prev, ...newRows];
        publish(next);
        // Kick off uploads after state commits. runUpload never rejects (it
        // catches internally + patches the row); .catch keeps it floating-safe.
        for (const row of newRows) runUpload(row.id, row.file).catch(() => {});
        return next;
      });
    },
    [publish, runUpload, dismissRejection, rejectionKey]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files ? Array.from(e.target.files) : [];
      if (files.length > 0) handleFiles(files);
      e.target.value = '';
    },
    [handleFiles]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) handleFiles(files);
    },
    [handleFiles]
  );

  const handleRemove = useCallback(
    (id: string) => {
      const row = rows.find((r) => r.id === id);
      // Abort an in-flight upload.
      const xhr = xhrRefs.current[id];
      if (xhr) {
        xhr.abort();
        delete xhrRefs.current[id];
      }
      // Best-effort R2 delete for a confirmed object (not yet persisted in DB).
      if (row?.ref) {
        removeProjectDocumentAction({ key: row.ref.r2Key }).catch(() => {});
      }
      setRowsAndPublish((prev) => prev.filter((r) => r.id !== id));
    },
    [rows, setRowsAndPublish]
  );

  const handleRetry = useCallback(
    (id: string) => {
      const row = rows.find((r) => r.id === id);
      if (row) runUpload(id, row.file).catch(() => {});
    },
    [rows, runUpload]
  );

  const atCap = rows.length >= MAX_DOCUMENTS;
  const openPicker = useCallback(() => fileInputRef.current?.click(), []);

  let dropLabel: string;
  if (isDragging) dropLabel = 'Drop to attach';
  else if (rows.length === 0) dropLabel = 'Drag files here or browse';
  else dropLabel = `Add more — ${rows.length} of ${MAX_DOCUMENTS}`;

  return (
    <div className="space-y-3">
      {/* Drop zone / cap note */}
      {atCap ? (
        <p className="border-border bg-muted/30 text-muted-foreground rounded-xl border border-dashed px-4 py-3 text-center text-[13px]">
          {MAX_DOCUMENTS} of {MAX_DOCUMENTS} attached
        </p>
      ) : (
        <button
          type="button"
          onClick={openPicker}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setIsDragging(false);
          }}
          onDrop={handleDrop}
          className={cn(
            'focus-visible:ring-ring flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors focus-visible:ring-2 focus-visible:outline-none',
            isDragging
              ? 'border-primary bg-primary/[0.04]'
              : 'border-border bg-muted/30 hover:border-primary/40'
          )}
        >
          <Upload className="text-muted-foreground h-6 w-6" aria-hidden="true" />
          <span className="text-foreground text-sm font-semibold">{dropLabel}</span>
          <span className="text-muted-foreground text-xs">
            PDF, PNG, JPEG or WEBP · up to {MAX_DOCUMENTS} files · 5 MB each
          </span>
        </button>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={DOCUMENT_ACCEPT}
        onChange={handleInputChange}
        className="hidden"
      />

      {/* Rejection rows (transient) */}
      <AnimatePresence initial={false}>
        {rejections.map((rej) => (
          <motion.p
            key={rejectionKey(rej)}
            initial={reduce ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            role="alert"
            className="text-destructive flex items-center gap-2 text-[13px]"
          >
            <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {rej.message}
          </motion.p>
        ))}
      </AnimatePresence>

      {/* File rows */}
      <AnimatePresence initial={false}>
        {rows.map((row) => {
          const Glyph = isImageType(row.file.type) ? ImageIcon : FileText;
          const failed = row.status === 'failed';
          return (
            <motion.div
              key={row.id}
              layout
              initial={reduce ? false : { opacity: 0, y: 8 }}
              animate={
                failed && !reduce ? { opacity: 1, y: 0, x: [0, -4, 4, 0] } : { opacity: 1, y: 0 }
              }
              exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
              className="border-border bg-card flex items-center gap-3 rounded-lg border p-3"
            >
              <Glyph className="text-muted-foreground h-5 w-5 shrink-0" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-foreground truncate text-sm font-medium">{row.file.name}</p>
                <p className="text-muted-foreground font-mono text-xs tabular-nums">
                  {formatBytes(row.file.size)}
                </p>
                {row.status === 'uploading' && (
                  <div
                    className="bg-muted mt-1.5 h-1 overflow-hidden rounded-full"
                    role="progressbar"
                    aria-valuenow={row.progress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`Uploading ${row.file.name}`}
                  >
                    <div
                      className="bg-primary h-full transition-[width] duration-150"
                      style={{ width: `${row.progress}%` }}
                    />
                  </div>
                )}
              </div>

              {/* Status region */}
              <div className="flex shrink-0 items-center gap-2">
                {row.status === 'uploading' && (
                  <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    {row.progress}%
                  </span>
                )}
                {row.status === 'success' && (
                  <span className="text-success inline-flex items-center gap-1.5 text-xs font-medium">
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> Attached
                  </span>
                )}
                {failed && (
                  <button
                    type="button"
                    onClick={() => handleRetry(row.id)}
                    className="text-destructive hover:bg-destructive/10 focus-visible:ring-ring inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-semibold focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <RotateCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleRemove(row.id)}
                  aria-label={`Remove ${row.file.name}`}
                  className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
