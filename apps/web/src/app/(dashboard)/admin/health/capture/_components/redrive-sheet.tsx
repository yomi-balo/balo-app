'use client';

import { Loader2 } from 'lucide-react';
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
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { CaptureHealthRowView, CaptureHealthActionView } from '../_lib/capture-health-view';

/**
 * BAL-550 (D4/D5b) — the re-drive confirm sheet (design reference `REDRIVE`, `admin-home.jsx:
 * 1222-1245`). Each kind says EXACTLY what changes, what is enqueued, and who it is recorded
 * under — the two re-drives are NOT one shared mutator's UI, they are two distinct sheets that
 * happen to share this shell.
 *
 * ⚠ D5b — the recap sheet's copy gains ONE sentence beyond the design reference: "The recap
 * returns to processing while it runs." Without it the sheet would contradict what the row
 * visibly does one second later (`claimRecapResume`'s `status → processing` claim).
 */
export type RedriveTarget =
  | {
      kind: 'recording-ingest';
      row: CaptureHealthRowView;
      recordingId: string;
      segmentLabel: string;
    }
  | { kind: 'transcript-pipeline'; row: CaptureHealthRowView; transcriptId: string };

interface RedriveSheetProps {
  readonly target: RedriveTarget | null;
  readonly actorLabel: string;
  readonly pending: boolean;
  readonly onConfirm: () => void;
  readonly onOpenChange: (open: boolean) => void;
}

function sheetCopy(target: RedriveTarget, actorLabel: string): { title: string; body: string } {
  if (target.kind === 'recording-ingest') {
    // ⚠ THE JOBID SHAPE IS LITERAL, `<auditId>` A DELIBERATE PLACEHOLDER — the real audit row
    // (and therefore the real jobId, D2's `buildJobId('recording-ingest', recordingId,
    // 'redrive-' + auditId)`) does not exist until the confirm commits.
    return {
      title: 'Re-drive the recording ingest?',
      body:
        `Resets "${target.row.title}" (${target.segmentLabel}) to source_ready, clears the ` +
        `errored Mux asset id, and enqueues recording-ingest--${target.recordingId}--redrive-<auditId>. ` +
        `The Daily source is still present, so the ingest can run. Recorded as ` +
        `admin.redrive.recording-ingest by ${actorLabel} @ Balo.`,
    };
  }
  return {
    title: 'Re-run the recap pipeline?',
    body:
      `Re-enqueues the recap pipeline for "${target.row.title}" as ` +
      `transcript-pipeline--${target.transcriptId}--redrive-<auditId>. Nothing is reset — the ` +
      `pipeline is idempotent and converges on the row as it is. The recap returns to ` +
      `processing while it runs. Recorded as admin.redrive.transcript-pipeline by ` +
      `${actorLabel} @ Balo.`,
  };
}

function confirmLabel(kind: CaptureHealthActionView['kind']): string {
  return kind === 'transcript-pipeline' ? 'Re-run recap' : 'Re-drive ingest';
}

export function RedriveSheet({
  target,
  actorLabel,
  pending,
  onConfirm,
  onOpenChange,
}: Readonly<RedriveSheetProps>): React.JSX.Element {
  const copy = target === null ? null : sheetCopy(target, actorLabel);

  return (
    <AlertDialog open={target !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy?.title ?? ''}</AlertDialogTitle>
          <AlertDialogDescription>{copy?.body ?? ''}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          {target !== null && (
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                onConfirm();
              }}
              disabled={pending}
              className={cn(buttonVariants({ variant: 'default' }), 'relative')}
            >
              <span className={cn('inline-flex items-center gap-2', pending && 'invisible')}>
                {confirmLabel(target.kind)}
              </span>
              {pending && (
                <span className="absolute inset-0 flex items-center justify-center gap-2">
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Re-driving…
                </span>
              )}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
