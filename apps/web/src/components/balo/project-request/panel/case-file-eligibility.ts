/**
 * BAL-589 (D9) — pure eligibility check for one row in `CaseFilePicker`'s "From this case"
 * list. Pure, no React, no I/O — the server re-checks the same two bounds in
 * `copyCaseFileToProjectAction` (defence in depth); this module exists so the picker can grey a
 * row and say why BEFORE the client ever asks the server to copy it.
 *
 * Checks run in a fixed order — size, then type, then cap — so a file that is both oversize and
 * unsupported always reads as "too_large" first, matching the single label a row can show.
 */

import {
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENTS,
  PROJECT_DOCUMENT_CONTENT_TYPES,
} from '@/lib/project-request/actions/schemas';

export type CaseFileEligibility = 'eligible' | 'too_large' | 'unsupported_type' | 'at_cap';

/** The project-document content-type allow-list, as a `Set` for O(1) membership checks. */
const SUPPORTED_CONTENT_TYPES = new Set<string>(PROJECT_DOCUMENT_CONTENT_TYPES);

/**
 * Eligibility for ONE case file row. `selected` is whether THIS file is already selected (a
 * selected row never gets locked out by the cap — only the UNSELECTED rows are, so deselecting
 * one frees exactly one slot for another). `documentCount` is the draft's current total across
 * both uploads and case-file copies (the shared {@link MAX_DOCUMENTS} cap, D9).
 */
export function caseFileEligibility(
  file: { contentType: string; sizeBytes: number },
  selected: boolean,
  documentCount: number
): CaseFileEligibility {
  if (file.sizeBytes > MAX_DOCUMENT_BYTES) return 'too_large';
  if (!SUPPORTED_CONTENT_TYPES.has(file.contentType)) return 'unsupported_type';
  if (!selected && documentCount >= MAX_DOCUMENTS) return 'at_cap';
  return 'eligible';
}
