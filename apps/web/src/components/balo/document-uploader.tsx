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
  /**
   * The source `File`, or `null` for a row SEEDED from an already-confirmed ref (BAL-254 W1).
   * A seeded row has nothing local to re-upload, so it can never enter `uploading`/`failed` and
   * therefore never offers Retry — which is why every read of the display metadata below goes
   * through the row's own fields rather than through `file`.
   */
  file: File | null;
  /** Display metadata, carried on the row so a seeded row renders identically to an uploaded one. */
  fileName: string;
  sizeBytes: number;
  contentType: string;
  status: FileStatus;
  progress: number;
  /** Confirmed R2 ref — present only when `status === 'success'`. */
  ref: ProjectDocumentRef | null;
  error?: string;
}

interface DocumentUploaderProps {
  /**
   * ⚠⚠ BAL-254 W1 — THE ROWS THIS UPLOADER STARTS WITH. Read ONCE, on mount, into the
   * component's own row state; it is not a controlled value and later changes are ignored.
   *
   * Why it exists: this component owns its rows, and `onDocumentsChange` REPLACES the caller's
   * document list wholesale. Every caller that unmounts and remounts it while a draft already
   * holds documents — the review step's "Change source documents" link, and review → Edit →
   * the manual step's own uploader — therefore landed on an EMPTY dropzone, and the first file
   * added there emitted a one-element list that silently dropped the originals from both the
   * parse input and the request's attachments. Seeding closes that: the remount shows what the
   * draft holds, and adding a file appends to it.
   */
  initialDocuments?: readonly ProjectDocumentRef[];
  /** Bubbles the current set of CONFIRMED document refs (for submit + draft). */
  onDocumentsChange: (docs: ProjectDocumentRef[]) => void;
  /** Bubbles whether any upload is still in flight (gates submit). */
  onUploadingChange?: (uploading: boolean) => void;
}

function isImageType(type: string): boolean {
  return type.startsWith('image/');
}

/**
 * Already-confirmed refs → already-`success` rows. ⚠ NOT published back to the parent: the caller
 * is where these came from, and re-emitting them on mount would write the same list back through
 * `onDocumentsChange` for no reason.
 */
function seedRows(documents: readonly ProjectDocumentRef[]): UploadRow[] {
  return documents.map((doc) => ({
    id: crypto.randomUUID(),
    file: null,
    fileName: doc.fileName,
    sizeBytes: doc.sizeBytes,
    contentType: doc.contentType,
    status: 'success' as const,
    progress: 100,
    ref: doc,
  }));
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
  initialDocuments,
  onDocumentsChange,
  onUploadingChange,
}: Readonly<DocumentUploaderProps>): React.JSX.Element {
  const reduce = useReducedMotion();
  // ⚠ LAZY INITIALISER — `initialDocuments` is read exactly once, on mount (see the prop's
  // docblock). A `useEffect` sync would fight the parent, because every publish from here
  // changes the very array that would feed back in.
  const [rows, setRows] = useState<UploadRow[]>(() => seedRows(initialDocuments ?? []));
  // Mirror of `rows` for event handlers + async upload callbacks. Seeded from the SAME lazy
  // initialiser so a seeded row is visible to the very first `commitRows`. Every write goes
  // through `commitRows`, which updates state and mirror together.
  const rowsRef = useRef<UploadRow[]>(rows);
  const [rejections, setRejections] = useState<FileRejection[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const xhrRefs = useRef<Record<string, XMLHttpRequest>>({});
  const rejectionTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  /**
   * What was last bubbled, so an unchanged publish can be skipped. Identity of the `docs` array
   * is NOT the signal — a fresh array is built on every call — so this records the confirmed
   * keys plus the uploading flag, which together are everything the parent consumes.
   */
  const lastPublishedRef = useRef<{ keys: string; uploading: boolean } | null>(null);

  /**
   * Recompute + bubble confirmed refs + uploading flag from the latest rows.
   *
   * ⚠ SKIPS A PUBLISH THAT WOULD SAY NOTHING NEW. `runUpload` calls `patchRow(id, {progress})`
   * on every XHR `upload.onprogress` tick, and each one reaches here — so a 5 MB file drove a
   * `setField('documents', …)` and a full `ProjectRequestPanel` re-render per tick, every one
   * of them carrying an identical confirmed-ref list. Progress belongs to this component's own
   * row state; the parent only ever needed the confirmed set and the in-flight flag.
   *
   * ⚠ The volume predates this branch, but it used to happen during RENDER, where React
   * coalesced it. These are real commits now, which is exactly why the guard is worth its
   * few lines on the surface the whole branch is about.
   */
  const publish = useCallback(
    (next: UploadRow[]) => {
      const docs = next
        .filter((r): r is UploadRow & { ref: ProjectDocumentRef } => r.ref !== null)
        .map((r) => r.ref);
      const uploading = next.some((r) => r.status === 'uploading');
      // \u0000 cannot occur in an R2 key, so no key set can collide with another.
      const keys = docs.map((d) => d.r2Key).join('\u0000');

      const last = lastPublishedRef.current;
      if (last !== null && last.keys === keys && last.uploading === uploading) return;
      lastPublishedRef.current = { keys, uploading };

      onDocumentsChange(docs);
      onUploadingChange?.(uploading);
    },
    [onDocumentsChange, onUploadingChange]
  );

  /**
   * ⚠⚠ THE ONLY WRITE PATH FOR `rows`. The next value is derived from `rowsRef` and published
   * HERE, in the event/async callback — never from inside a `setRows` updater.
   *
   * Why: React runs a state updater during the RENDER phase. Calling `publish` in there reached
   * `onDocumentsChange` → the parent's `setField` mid-render, which React reports as "Cannot
   * update a component (`ProjectRequestPanel`) while rendering a different component
   * (`DocumentUploader`)", and StrictMode's double-invoke fired every parent write twice.
   * Reading the ref also sequences back-to-back patches in one tick correctly (each sees the
   * previous one's result), which a functional update could not do once `publish` moved out.
   */
  const commitRows = useCallback(
    (updater: (prev: UploadRow[]) => UploadRow[]) => {
      const next = updater(rowsRef.current);
      rowsRef.current = next;
      setRows(next);
      publish(next);
    },
    [publish]
  );

  const patchRow = useCallback(
    (id: string, patch: Partial<UploadRow>) => {
      commitRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    },
    [commitRows]
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
      const { accepted, rejected } = partitionFiles(incoming, rowsRef.current.length);

      for (const rej of rejected) {
        toast.error(rej.message);
        // Auto-dismiss the inline row after ~4s, keyed by the SAME composite
        // identity as the render key so it removes exactly this row.
        const key = rejectionKey(rej);
        rejectionTimers.current[key] = setTimeout(() => dismissRejection(key), 4000);
      }
      if (rejected.length > 0) setRejections((r) => [...r, ...rejected]);
      if (accepted.length === 0) return;

      // ⚠ `& { file: File }` — every row created HERE has a local `File` (only a SEEDED row
      // does not), which is what lets the `runUpload` loop below stay assertion-free.
      const newRows: (UploadRow & { file: File })[] = accepted.map((file) => ({
        id: crypto.randomUUID(),
        file,
        fileName: file.name,
        sizeBytes: file.size,
        contentType: file.type,
        status: 'uploading',
        progress: 0,
        ref: null,
      }));
      commitRows((prev) => [...prev, ...newRows]);
      // runUpload never rejects (it catches internally + patches the row);
      // .catch keeps it floating-safe.
      for (const row of newRows) runUpload(row.id, row.file).catch(() => {});
    },
    [commitRows, runUpload, dismissRejection, rejectionKey]
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
      const row = rowsRef.current.find((r) => r.id === id);
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
      commitRows((prev) => prev.filter((r) => r.id !== id));
    },
    [commitRows]
  );

  const handleRetry = useCallback(
    (id: string) => {
      const row = rowsRef.current.find((r) => r.id === id);
      // A seeded row carries no `File` — it is already confirmed and can never be `failed`, so
      // Retry is not rendered for it. The guard keeps that structural fact type-safe.
      if (row?.file) runUpload(id, row.file).catch(() => {});
    },
    [runUpload]
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
          const Glyph = isImageType(row.contentType) ? ImageIcon : FileText;
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
                <p className="text-foreground truncate text-sm font-medium">{row.fileName}</p>
                <p className="text-muted-foreground font-mono text-xs tabular-nums">
                  {formatBytes(row.sizeBytes)}
                </p>
                {row.status === 'uploading' && (
                  <div
                    className="bg-muted mt-1.5 h-1 overflow-hidden rounded-full"
                    role="progressbar"
                    aria-valuenow={row.progress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`Uploading ${row.fileName}`}
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
                {/*
                  ⚠ 44px MINIMUM HIT AREA on both controls (BAL-254 fix round F13). The AI brief
                  path is the first touch-first surface in the product — people attach photos of
                  a whiteboard from a phone — and Retry/Remove sit millimetres apart on a row.
                  The GLYPH stays at h-3.5; only the tappable box grows, so the density is
                  unchanged while the target clears the WCAG 2.5.5 / platform 44px guidance.
                */}
                {failed && (
                  <button
                    type="button"
                    onClick={() => handleRetry(row.id)}
                    className="text-destructive hover:bg-destructive/10 focus-visible:ring-ring inline-flex min-h-11 items-center gap-1 rounded-md px-2.5 py-1 text-xs font-semibold focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <RotateCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleRemove(row.id)}
                  aria-label={`Remove ${row.fileName}`}
                  className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring inline-flex h-11 w-11 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none"
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
