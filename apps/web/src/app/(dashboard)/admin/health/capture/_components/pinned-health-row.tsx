'use client';

import { useCallback, useState } from 'react';
import { HealthRow } from './health-row';
import { RedriveSheet } from './redrive-sheet';
import type { CaptureHealthRowView } from '../_lib/capture-health-view';
import { useRedriveSheet } from '../_lib/use-redrive-sheet';

/**
 * BAL-550 (§13 — "the deep-linked row is a PINNED BAND, not an in-list highlight") — the
 * `?row=<meetingId>` band above the list. A tiny CLIENT wrapper (not a Server Component,
 * despite the plan's `page.tsx` sketch labelling it "SERVER"): `HealthRow`'s re-drive button
 * needs a live event handler, and a native DOM element cannot take one from a Server Component
 * — this is the minimal boundary that makes the button work, sharing `useRedriveSheet` with
 * `HealthList` so the confirm→toast→analytic sequence has ONE implementation.
 */
interface PinnedHealthRowProps {
  readonly row: CaptureHealthRowView;
  readonly canRedrive: boolean;
  readonly actorLabel: string;
}

export function PinnedHealthRow({
  row,
  canRedrive,
  actorLabel,
}: Readonly<PinnedHealthRowProps>): React.JSX.Element {
  const [current, setCurrent] = useState(row);
  const handleRowUpdated = useCallback((updated: CaptureHealthRowView): void => {
    setCurrent(updated);
  }, []);
  const { sheetTarget, pending, openSheet, closeSheet, confirm } =
    useRedriveSheet(handleRowUpdated);

  return (
    <div className="border-primary/40 bg-primary/5 overflow-hidden rounded-2xl border">
      <HealthRow
        row={current}
        index={0}
        last
        highlighted
        canRedrive={canRedrive}
        onRedrive={openSheet}
      />
      <RedriveSheet
        target={sheetTarget}
        actorLabel={actorLabel}
        pending={pending}
        onConfirm={confirm}
        onOpenChange={(open) => {
          if (!open) closeSheet();
        }}
      />
    </div>
  );
}
