'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileText, Image as ImageIcon, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/components/balo/document-uploader/upload-file';
import { MAX_DOCUMENTS } from '@/lib/project-request/actions/schemas';
import { copyCaseFileToProjectAction } from '@/app/(dashboard)/cases/[engagementId]/_actions/copy-case-file-to-project';
import { removeProjectDocumentAction } from '@/lib/project-request/actions/remove-project-document';
import type { ProjectDocumentRef } from '@/lib/project-request/actions/schemas';
import type { CaseFileRowView } from '@/lib/cases/case-view-types';
import { caseFileEligibility, type CaseFileEligibility } from './case-file-eligibility';

export interface CaseFilePickerProps {
  caseId: string;
  files: readonly CaseFileRowView[];
  /** The uploader's own (non-case-file) document count — combined with this picker's own
   *  selection count for the shared {@link MAX_DOCUMENTS} cap (fix round F1). */
  uploadedDocumentCount: number;
  caseFileSelections: Record<string, ProjectDocumentRef>;
  /**
   * ⚠ FIX ROUND F2 — an UPDATER, exactly like React's own `setState`, never a plain next value.
   * Two quick selections each read the record as it was when THEIR OWN click started; applying
   * against a snapshot captured at render time let the second resolution silently overwrite the
   * first. An updater is applied against whatever is current at write time instead.
   */
  onCaseFileSelectionsChange: (
    updater: (prev: Record<string, ProjectDocumentRef>) => Record<string, ProjectDocumentRef>
  ) => void;
  /**
   * Fix round F18 — reports this picker's in-flight copy count on every change (including 0 on
   * mount and on settle), so the panel can shrink the uploader's own `maxDocuments` by the same
   * amount a copy still in flight already reserves here.
   */
  onBusyCountChange?: (count: number) => void;
}

/** `${origin}:${id}` — see `ProjectDraft.caseFileSelections`'s docblock for why it is
 *  origin-qualified (the two source tables' ids are each unique only within their own table). */
function caseFileKey(file: CaseFileRowView): string {
  return `${file.origin}:${file.id}`;
}

const INELIGIBLE_LABELS: Record<Exclude<CaseFileEligibility, 'eligible'>, string> = {
  too_large: 'over 5 MB',
  unsupported_type: 'file type not supported',
  at_cap: `${MAX_DOCUMENTS}-file limit reached`,
};

const GENERIC_ERROR = 'Could not attach this file. Please try again.';

/**
 * BAL-589 (D9) — the "From this case" list above `DocumentUploader` on a case mount's manual
 * step. Every case file is LISTED (never hidden for being ineligible — the row stays, greyed,
 * with its reason) so the client always sees the file existed and why it can't be added, rather
 * than a silently shorter list.
 *
 * Selecting a row copies the file server-side (`copyCaseFileToProjectAction`) into the
 * requester's own `project-documents/` prefix — the client never re-uploads it. Deselecting
 * removes it from the draft optimistically and best-effort deletes the copy
 * (`removeProjectDocumentAction`, fire-and-forget — exactly `DocumentUploader`'s own pattern for
 * a not-yet-submitted document).
 *
 * Hidden entirely when the case has no files: this section is otherwise purely about files that
 * already exist on the case, the client cannot create one here, and `DocumentUploader` (always
 * rendered alongside it) remains the acting surface.
 */
export function CaseFilePicker({
  caseId,
  files,
  uploadedDocumentCount,
  caseFileSelections,
  onCaseFileSelectionsChange,
  onBusyCountChange,
}: Readonly<CaseFilePickerProps>): React.JSX.Element | null {
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set());

  // Fix round F18 — tell the panel every time the in-flight count changes, so it can reserve
  // the same slots on the uploader's `maxDocuments` that this picker already reserves below.
  useEffect(() => {
    onBusyCountChange?.(busyKeys.size);
  }, [busyKeys, onBusyCountChange]);

  const handleDeselect = useCallback(
    (key: string) => {
      const existing = caseFileSelections[key];
      onCaseFileSelectionsChange((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      if (existing !== undefined) {
        // Best-effort tidy-up of the orphaned R2 copy — never blocks the UI, matching
        // `DocumentUploader`'s own not-yet-submitted removal.
        removeProjectDocumentAction({ key: existing.r2Key }).catch(() => {});
      }
    },
    [caseFileSelections, onCaseFileSelectionsChange]
  );

  const handleSelect = useCallback(
    async (file: CaseFileRowView, key: string) => {
      if (file.origin === 'meeting' && file.meetingId === null) {
        toast.error(GENERIC_ERROR);
        return;
      }
      setBusyKeys((prev) => new Set(prev).add(key));
      try {
        const result = await copyCaseFileToProjectAction(
          file.origin === 'meeting'
            ? { caseId, origin: 'meeting', fileId: file.id, meetingId: file.meetingId as string }
            : { caseId, origin: 'conversation', fileId: file.id }
        );
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        // ⚠ FIX ROUND F2 — functional update: applies against whatever `caseFileSelections`
        // is current AT WRITE TIME, so a second selection resolving before or after this one
        // can never clobber it.
        onCaseFileSelectionsChange((prev) => ({ ...prev, [key]: result.document }));
      } catch {
        toast.error(GENERIC_ERROR);
      } finally {
        setBusyKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [caseId, onCaseFileSelectionsChange]
  );

  const handleToggle = useCallback(
    (file: CaseFileRowView, selected: boolean) => {
      const key = caseFileKey(file);
      if (selected) {
        handleDeselect(key);
        return;
      }
      // `handleSelect` already handles every failure internally (toast + busy-state cleanup) —
      // this call is fire-and-forget from the handler's own point of view.
      handleSelect(file, key).catch(() => {});
    },
    [handleDeselect, handleSelect]
  );

  if (files.length === 0) return null;

  // Fix round F1 — the shared MAX_DOCUMENTS cap counts uploads AND case copies together.
  // Fix round F18 — a copy still in flight reserves its slot too, so two quick selections can't
  // both start past the cap.
  const totalDocumentCount =
    uploadedDocumentCount + Object.keys(caseFileSelections).length + busyKeys.size;

  return (
    <div className="space-y-1.5">
      <p className="text-foreground text-xs font-medium">From this case</p>
      <ul className="divide-border border-border divide-y rounded-lg border">
        {files.map((file) => {
          const key = caseFileKey(file);
          const selected = key in caseFileSelections;
          const busy = busyKeys.has(key);
          const eligibility = caseFileEligibility(file, selected, totalDocumentCount);
          const disabled = busy || (!selected && eligibility !== 'eligible');
          const Glyph = file.contentType.startsWith('image/') ? ImageIcon : FileText;
          const ineligibleLabel =
            eligibility === 'eligible' ? null : INELIGIBLE_LABELS[eligibility];

          return (
            <li key={key}>
              {/*
                ⚠ FIX ROUND F7 — the whole row is the label, min-h-11 (44px), so the hit target
                isn't the bare 16px checkbox. A disabled row shows a not-allowed cursor and
                never toggles.
              */}
              <label
                className={cn(
                  'flex min-h-11 items-center gap-3 px-3 py-2.5 text-sm',
                  disabled ? 'cursor-not-allowed' : 'cursor-pointer'
                )}
              >
                <Checkbox
                  checked={selected}
                  disabled={disabled}
                  onCheckedChange={() => handleToggle(file, selected)}
                  aria-label={`${selected ? 'Remove' : 'Attach'} ${file.fileName}`}
                />
                <Glyph
                  className={
                    disabled ? 'text-muted-foreground/50 h-4 w-4' : 'text-muted-foreground h-4 w-4'
                  }
                  aria-hidden="true"
                />
                <span
                  className={
                    disabled
                      ? 'text-muted-foreground flex-1 truncate'
                      : 'text-foreground flex-1 truncate'
                  }
                >
                  {file.fileName}
                </span>
                {busy ? (
                  <Loader2
                    className="text-muted-foreground h-3.5 w-3.5 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <span
                    className={
                      ineligibleLabel === null
                        ? 'text-muted-foreground text-xs'
                        : 'text-warning-strong text-xs'
                    }
                  >
                    {ineligibleLabel ?? formatBytes(file.sizeBytes)}
                  </span>
                )}
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
