'use client';

import { useCallback, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { track, ADMIN_CAPTURE_HEALTH_EVENTS } from '@/lib/analytics';
import type { AdminRedriveOutcome } from '@/lib/analytics';
import type { RedriveTarget } from '../_components/redrive-sheet';
import type { CaptureHealthRowView } from './capture-health-view';
import { requestRedrive } from '../_actions/request-redrive';

/**
 * BAL-550 — the re-drive confirm-sheet state machine, shared by `HealthList` (the main list) and
 * `PinnedHealthRow` (the `?row=` deep-linked band) so the "open sheet → confirm → toast →
 * analytic exactly once" sequence has ONE implementation rather than two that could drift.
 */
const REDRIVE_TOAST = {
  'recording-ingest': 'Re-drive queued — recorded as admin.redrive.recording-ingest',
  'transcript-pipeline': 'Re-run queued — recorded as admin.redrive.transcript-pipeline',
} as const;

/** The row's optimistic post-confirm chip (design reference `REDRIVE[kind].after`). */
export function applyOptimisticAfter(
  row: CaptureHealthRowView,
  kind: 'recording-ingest' | 'transcript-pipeline'
): CaptureHealthRowView {
  if (kind === 'recording-ingest') {
    return {
      ...row,
      recording: { state: 'ingesting', note: 'Re-driven just now' },
      action: { kind: 'none' },
    };
  }
  return {
    ...row,
    recap: { state: 'processing', note: 'Re-run just now' },
    action: { kind: 'none' },
  };
}

function outcomeFor(
  reason: 'forbidden' | 'not_redrivable' | 'enqueue_failed' | 'unavailable' | 'invalid'
): AdminRedriveOutcome {
  if (reason === 'forbidden') return 'forbidden';
  if (reason === 'not_redrivable' || reason === 'invalid') return 'refused';
  return 'failed';
}

export function useRedriveSheet(onRowUpdated: (row: CaptureHealthRowView) => void): {
  sheetTarget: RedriveTarget | null;
  pending: boolean;
  openSheet: (row: CaptureHealthRowView) => void;
  closeSheet: () => void;
  confirm: () => void;
} {
  const [sheetTarget, setSheetTarget] = useState<RedriveTarget | null>(null);
  const [pending, startRedrive] = useTransition();

  const openSheet = useCallback((row: CaptureHealthRowView): void => {
    if (row.action.kind === 'recording-ingest') {
      setSheetTarget({
        kind: 'recording-ingest',
        row,
        recordingId: row.action.recordingId,
        segmentLabel: row.action.segmentLabel,
      });
    } else if (row.action.kind === 'transcript-pipeline') {
      setSheetTarget({ kind: 'transcript-pipeline', row, transcriptId: row.action.transcriptId });
    }
  }, []);

  const closeSheet = useCallback((): void => setSheetTarget(null), []);

  const confirm = useCallback((): void => {
    if (sheetTarget === null) return;
    const target = sheetTarget;
    const entityId = target.kind === 'recording-ingest' ? target.recordingId : target.transcriptId;

    startRedrive(async () => {
      const result = await requestRedrive({ kind: target.kind, entityId });

      if (result.success) {
        toast.success(REDRIVE_TOAST[target.kind]);
        track(ADMIN_CAPTURE_HEALTH_EVENTS.REDRIVE_REQUESTED, {
          kind: target.kind,
          outcome: 'queued',
        });
        onRowUpdated(applyOptimisticAfter(target.row, target.kind));
      } else {
        toast.error(result.error);
        track(ADMIN_CAPTURE_HEALTH_EVENTS.REDRIVE_REQUESTED, {
          kind: target.kind,
          outcome: outcomeFor(result.reason),
        });
      }
      setSheetTarget(null);
    });
  }, [sheetTarget, onRowUpdated]);

  return { sheetTarget, pending, openSheet, closeSheet, confirm };
}
