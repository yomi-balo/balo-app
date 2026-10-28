import type { MilestoneTimeView, TimeEntryView } from '@/lib/engagement/time-view';

interface TimeLogListProps {
  time: Pick<MilestoneTimeView, 'entries' | 'authorsLabel'>;
  /** Per-entry controls (edit / delete) rendered after the hours; omitted on read-only surfaces. */
  renderEntryControls?: (entry: TimeEntryView) => React.ReactNode;
}

/**
 * A milestone's time entries, newest first: the day, the note and the hours, with who
 * logged them underneath. Client-safe presentation only.
 */
export function TimeLogList({
  time,
  renderEntryControls,
}: Readonly<TimeLogListProps>): React.JSX.Element {
  return (
    <div className="bg-muted/40 border-border mt-2 rounded-xl border p-3">
      <ul className="divide-border divide-y">
        {time.entries.map((entry) => (
          <li
            key={entry.id}
            className="flex items-baseline gap-3 py-2 text-sm first:pt-0 last:pb-0"
          >
            <span className="text-muted-foreground w-14 shrink-0 text-xs">
              {entry.workedOnLabel}
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-foreground break-words">{entry.note}</span>
              {entry.editedByLabel !== null && (
                <span className="text-muted-foreground block text-xs">{entry.editedByLabel}</span>
              )}
            </span>
            <span className="text-foreground shrink-0 font-medium">{entry.hoursLabel}</span>
            {renderEntryControls !== undefined && (
              <span className="inline-flex shrink-0 items-center gap-0.5 self-center">
                {renderEntryControls(entry)}
              </span>
            )}
          </li>
        ))}
      </ul>
      {time.authorsLabel !== null && (
        <p className="text-muted-foreground mt-2 text-xs">{time.authorsLabel}</p>
      )}
    </div>
  );
}
