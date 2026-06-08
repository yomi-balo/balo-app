/**
 * Pure helpers + the XHR PUT used by the document uploader. Isolated from the
 * component so the validation logic and the progress-bearing upload are
 * unit-testable (the component mocks the Server Actions + this PUT).
 */

import {
  PROJECT_DOCUMENT_CONTENT_TYPES,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENTS,
} from '../../../app/(marketing)/experts/[username]/_actions/schemas';

export { MAX_DOCUMENT_BYTES, MAX_DOCUMENTS };

/** Accept attribute for the hidden file input. */
export const DOCUMENT_ACCEPT = '.pdf,image/png,image/jpeg,image/webp';

const ALLOWED_TYPES = new Set<string>(PROJECT_DOCUMENT_CONTENT_TYPES);

export type RejectionReason = 'type' | 'size' | 'overflow';

export interface FileRejection {
  fileName: string;
  reason: RejectionReason;
  /** Human-readable, ready to toast / render. */
  message: string;
}

/** Format a byte count to a short "X.Y MB" / "X KB" string. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** True when the file's MIME type is in the allow-list. */
export function isAllowedType(file: File): boolean {
  return ALLOWED_TYPES.has(file.type);
}

export interface PartitionResult {
  /** Files that passed type/size AND fit within the remaining slots. */
  accepted: File[];
  /** Files rejected for type, size, or overflow (with ready messages). */
  rejected: FileRejection[];
}

/**
 * Validate + partition an incoming selection BEFORE any network call (the server
 * confirm action re-checks as the source of truth). Enforces: type ∈ allow-list,
 * size ≤ 5 MB, total count ≤ 4 (overflow beyond the remaining slots is rejected,
 * accepting up to what fits — design §2.6).
 */
export function partitionFiles(files: File[], currentCount: number): PartitionResult {
  const accepted: File[] = [];
  const rejected: FileRejection[] = [];
  let remaining = Math.max(0, MAX_DOCUMENTS - currentCount);

  for (const file of files) {
    if (!isAllowedType(file)) {
      rejected.push({
        fileName: file.name,
        reason: 'type',
        message: `${file.name} isn't a supported type. Use PDF, PNG, JPEG or WEBP.`,
      });
      continue;
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      rejected.push({
        fileName: file.name,
        reason: 'size',
        message: `${file.name} is ${formatBytes(file.size)} — files must be 5 MB or smaller.`,
      });
      continue;
    }
    if (remaining <= 0) {
      rejected.push({
        fileName: file.name,
        reason: 'overflow',
        message: `You can attach up to ${MAX_DOCUMENTS} files. ${file.name} not added.`,
      });
      continue;
    }
    accepted.push(file);
    remaining -= 1;
  }

  return { accepted, rejected };
}

export interface XhrUploadOptions {
  url: string;
  file: File;
  onProgress: (pct: number) => void;
  /** Receives the live XHR so the caller can abort (remove/cancel). */
  onStart?: (xhr: XMLHttpRequest) => void;
}

/**
 * PUT a file to a presigned URL with real upload progress via
 * `XMLHttpRequest.upload.onprogress` (bare `fetch` can't report progress).
 * Resolves on 2xx, rejects on error / abort / non-2xx.
 */
export function putWithProgress({
  url,
  file,
  onProgress,
  onStart,
}: XhrUploadOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.onabort = () => reject(new Error('Upload aborted'));

    onStart?.(xhr);
    xhr.send(file);
  });
}
