'use client';

import { useCallback, useId, useMemo, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import {
  TIME_ENTRY_MAX_MINUTES,
  TIME_ENTRY_MINUTES_STEP,
  TIME_ENTRY_NOTE_MAX,
} from '@balo/shared/engagements';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { TimeEntryView } from '@/lib/engagement/time-view';
import { logTimeAction } from '@/app/(dashboard)/engagements/[id]/_actions/log-time';
import { updateTimeEntryAction } from '@/app/(dashboard)/engagements/[id]/_actions/update-time-entry';
import { useEngagementLifecycleAction } from '../use-engagement-lifecycle-action';
import { logTimeWarning } from './log-time-warning';

interface LogTimeFormProps {
  engagementId: string;
  milestoneId: string;
  milestoneTitle: string;
  estimatedMinutes: number | null;
  /** The milestone's live total, including `entry` when editing. */
  loggedMinutes: number;
  clientCompanyName: string;
  /** Present when editing: the form is prefilled from it and saves over it. */
  entry?: TimeEntryView;
  /** Closes the form, after a save and on Cancel / Escape. */
  onClose: () => void;
}

const MINUTES_PER_HOUR = 60;

/** Typed hours → whole minutes on the 15-minute grid, or null when they can't be logged. */
function minutesFromHours(hours: string): number | null {
  const value = Number(hours);
  if (hours.trim() === '' || !Number.isFinite(value)) return null;
  const minutes = Math.round(value * MINUTES_PER_HOUR);
  if (minutes <= 0 || minutes > TIME_ENTRY_MAX_MINUTES) return null;
  return minutes % TIME_ENTRY_MINUTES_STEP === 0 ? minutes : null;
}

/**
 * Logs time against an in-progress milestone, or edits the author's own entry. Hours move in
 * quarter-hour steps and every entry needs a note. Going over the estimate is allowed but
 * never silent: a warning says so before it happens. Cancel and Escape stay available while
 * a save is in flight.
 */
export function LogTimeForm({
  engagementId,
  milestoneId,
  milestoneTitle,
  estimatedMinutes,
  loggedMinutes,
  clientCompanyName,
  entry,
  onClose,
}: Readonly<LogTimeFormProps>): React.JSX.Element {
  const { isPending, run } = useEngagementLifecycleAction();
  const ids = useId();
  const hoursId = `${ids}-hours`;
  const noteId = `${ids}-note`;
  const [hours, setHours] = useState(entry === undefined ? '1' : String(entry.minutes / 60));
  const [note, setNote] = useState(entry?.note ?? '');

  const minutes = minutesFromHours(hours);
  const hoursInvalid = hours.trim() !== '' && minutes === null;
  const hintId = `${ids}-hours-hint`;
  const canSubmit = minutes !== null && note.trim() !== '' && !isPending;
  const warning = useMemo(
    () =>
      logTimeWarning({
        milestoneTitle,
        estimatedMinutes,
        loggedMinutes,
        replacedMinutes: entry?.minutes ?? 0,
        addMinutes: minutes ?? 0,
        clientCompanyName,
      }),
    [milestoneTitle, estimatedMinutes, loggedMinutes, entry, minutes, clientCompanyName]
  );

  const submit = useCallback((): void => {
    if (minutes === null || note.trim() === '') return;
    const trimmed = note.trim();
    if (entry === undefined) {
      run(
        logTimeAction({ engagementId, milestoneId, minutes, note: trimmed }),
        'Time logged',
        onClose
      );
      return;
    }
    run(
      updateTimeEntryAction({ engagementId, entryId: entry.id, minutes, note: trimmed }),
      'Time entry updated',
      onClose
    );
  }, [minutes, note, entry, run, engagementId, milestoneId, onClose]);

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (canSubmit) submit();
    },
    [canSubmit, submit]
  );
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLFormElement>): void => {
      if (event.key === 'Escape') onClose();
    },
    [onClose]
  );
  const handleHours = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => setHours(event.target.value),
    []
  );
  const handleNote = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => setNote(event.target.value),
    []
  );

  return (
    <form
      onSubmit={handleSubmit}
      onKeyDown={handleKeyDown}
      className="border-border mt-3 rounded-xl border p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={hoursId} className="sr-only">
          Hours
        </label>
        <Input
          id={hoursId}
          type="number"
          inputMode="decimal"
          min={TIME_ENTRY_MINUTES_STEP / MINUTES_PER_HOUR}
          step={TIME_ENTRY_MINUTES_STEP / MINUTES_PER_HOUR}
          value={hours}
          onChange={handleHours}
          aria-invalid={hoursInvalid}
          aria-describedby={hoursInvalid ? hintId : undefined}
          className="h-8 w-20"
        />
        <span className="text-muted-foreground text-sm">hrs</span>
        <label htmlFor={noteId} className="sr-only">
          Note
        </label>
        <Input
          id={noteId}
          autoFocus
          maxLength={TIME_ENTRY_NOTE_MAX}
          value={note}
          onChange={handleNote}
          placeholder="What did you work on?"
          className="h-8 min-w-44 flex-1"
        />
      </div>
      {hoursInvalid && (
        <p id={hintId} className="text-destructive-strong mt-2 text-xs">
          Use quarter hours, up to 24
        </p>
      )}
      {warning !== null && (
        <p className="text-warning-strong mt-2 flex items-start gap-1.5 text-xs leading-relaxed">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          {warning}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {isPending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          {entry === undefined ? 'Log time' : 'Save entry'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <span className="text-muted-foreground text-xs">
          {clientCompanyName} sees every entry and its note.
        </span>
      </div>
    </form>
  );
}
