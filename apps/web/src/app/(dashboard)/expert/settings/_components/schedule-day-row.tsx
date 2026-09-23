'use client';

import { useCallback, useId, useState } from 'react';
import { Copy, Moon, Plus, X } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { ScheduleTimeSelect } from './schedule-time-select';
import { SettingsEyebrow } from './settings-card';
import {
  DAY_META,
  MAX_RANGES_PER_DAY,
  buildEndOptions,
  dayHasOtherOvernightRange,
  isOvernightRange,
  type DayState,
  type TimeRange,
} from '../_lib/schedule-helpers';

/**
 * Trigger tint for the End select. Destructive wins over the info tint when a crossing
 * range is also in conflict (design §5). An if-chain, not a nested ternary — SonarCloud
 * S3358 flags nested ternaries on new code.
 */
function endSelectTone(hasConflict: boolean, crossing: boolean): string | undefined {
  if (hasConflict) return 'bg-destructive/5';
  if (crossing) return 'border-info/40 bg-info/5';
  return undefined;
}

/**
 * The row-end actions fade in on row hover or focus, and only where the pointer can hover —
 * touch screens always see them. Opacity, never `display`/`visibility`, so the keyboard still
 * reaches them, and focusing one reveals the cluster.
 */
const REVEAL_ON_ROW_HOVER =
  'transition-opacity duration-150 [@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover/day:opacity-100 group-focus-within/day:opacity-100';

/**
 * Badge copy for a crossing range. A `09:00 → 00:00` range has a ZERO-length tail on
 * the next day — "Continues into {day}" would mislead the expert into thinking the
 * window bleeds into the next morning, so that exact case gets its own wording.
 * Display-only: `isOvernightRange` stays the sole predicate for every LOGIC path.
 */
function crossingBadgeLabel(range: Pick<TimeRange, 'end'>, nextDayFull: string): string {
  return range.end === '00:00' ? 'Runs until midnight' : `Continues into ${nextDayFull}`;
}

interface ScheduleDayRowProps {
  dayIndex: number;
  day: DayState;
  /** rangeId → inline conflict pointer, for ranges implicated in the active conflict. */
  conflictMessages?: Readonly<Record<string, string>>;
  onToggle: (enabled: boolean) => void;
  onRangeChange: (rangeId: string, field: 'start' | 'end', value: string) => void;
  onAddRange: () => void;
  onRemoveRange: (rangeId: string) => void;
  onCopyToDays: (targetIndices: number[]) => void;
}

/**
 * One weekday: switch + day name, then the day's ranges (or "Unavailable"), with
 * "+ Add range" and the copy-to-days menu at the row end — revealed on row hover for a
 * mouse, always shown on touch, and never hidden while the row has a conflict or its copy
 * menu is open. Below `sm` the ranges drop to their own line under the switch so two time
 * selects always fit at phone width.
 */
export function ScheduleDayRow({
  dayIndex,
  day,
  conflictMessages,
  onToggle,
  onRangeChange,
  onAddRange,
  onRemoveRange,
  onCopyToDays,
}: Readonly<ScheduleDayRowProps>): React.JSX.Element {
  const meta = DAY_META[dayIndex];
  const nextMeta = DAY_META[(dayIndex + 1) % DAY_META.length];
  const switchId = useId();
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyTargets, setCopyTargets] = useState<number[]>([]);

  const toggleCopyTarget = useCallback((targetIndex: number, checked: boolean): void => {
    setCopyTargets((prev) =>
      checked ? [...prev, targetIndex] : prev.filter((index) => index !== targetIndex)
    );
  }, []);

  const applyCopy = useCallback((): void => {
    onCopyToDays(copyTargets);
    setCopyTargets([]);
    setCopyOpen(false);
  }, [copyTargets, onCopyToDays]);

  const handleCopyOpenChange = useCallback((open: boolean): void => {
    setCopyOpen(open);
    if (!open) setCopyTargets([]);
  }, []);

  if (!meta || !nextMeta) return <></>;

  const otherDays = DAY_META.map((other, index) => ({ ...other, index })).filter(
    (other) => other.index !== dayIndex
  );
  // A lone range is switched off with the day toggle, not removed — removing it would
  // leave an open day with no hours, which save rejects.
  const canRemoveRange = day.ranges.length > 1;
  const hasRowConflict = day.ranges.some((range) => conflictMessages?.[range.id] !== undefined);
  const revealOnHover = !hasRowConflict && !copyOpen;

  return (
    <div className="group/day grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3.5 gap-y-2">
      {/* Toggle + day name — the name is a label, so it widens the switch's tap target. */}
      <div className="flex h-9 items-center gap-3.5">
        <Switch
          id={switchId}
          checked={day.enabled}
          onCheckedChange={onToggle}
          aria-label={`${meta.full} availability`}
        />
        <label
          htmlFor={switchId}
          className={cn(
            'flex h-9 w-10 cursor-pointer items-center text-sm',
            day.enabled ? 'text-foreground font-medium' : 'text-muted-foreground'
          )}
        >
          {meta.short}
        </label>
      </div>

      {day.enabled ? (
        <div className="col-span-3 col-start-1 row-start-2 flex flex-col gap-2 sm:col-span-1 sm:col-start-2 sm:row-start-1">
          {day.ranges.map((range, rangeIndex) => {
            const crossing = isOvernightRange(range);
            const conflictMessage = conflictMessages?.[range.id];
            const hasConflict = conflictMessage !== undefined;
            const badgeId = `crossing-badge-${range.id}`;
            const errorId = `range-error-${range.id}`;
            const describedBy = [crossing ? badgeId : undefined, hasConflict ? errorId : undefined]
              .filter((id): id is string => id !== undefined)
              .join(' ');
            const endOptions = buildEndOptions(range, !dayHasOtherOvernightRange(day, range.id));
            const endTone = endSelectTone(hasConflict, crossing);

            return (
              <div key={range.id} className="flex flex-wrap items-center gap-2">
                <ScheduleTimeSelect
                  value={range.start}
                  ariaLabel={`${meta.full} range ${rangeIndex + 1} start time`}
                  ariaDescribedBy={hasConflict ? errorId : undefined}
                  invalid={hasConflict}
                  triggerClassName={hasConflict ? 'bg-destructive/5' : undefined}
                  onChange={(value) => onRangeChange(range.id, 'start', value)}
                />
                <span className="text-muted-foreground text-sm" aria-hidden="true">
                  –
                </span>
                <ScheduleTimeSelect
                  value={range.end}
                  options={endOptions}
                  ariaLabel={`${meta.full} range ${rangeIndex + 1} end time`}
                  ariaDescribedBy={describedBy || undefined}
                  invalid={hasConflict}
                  triggerClassName={endTone}
                  onChange={(value) => onRangeChange(range.id, 'end', value)}
                />
                {crossing && (
                  <Badge
                    id={badgeId}
                    variant="outline"
                    className="border-info/30 bg-info/10 text-info-strong gap-1"
                  >
                    <Moon className="h-3 w-3" aria-hidden="true" />
                    {crossingBadgeLabel(range, nextMeta.full)}
                  </Badge>
                )}
                {canRemoveRange && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={`Remove ${meta.full} range ${rangeIndex + 1}`}
                    onClick={() => onRemoveRange(range.id)}
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </Button>
                )}
                {hasConflict && (
                  <p id={errorId} className="text-destructive-strong w-full text-xs">
                    {conflictMessage}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <span className="text-muted-foreground flex h-9 items-center text-[13px] italic">
          Unavailable
        </span>
      )}

      {day.enabled && (
        <div
          className={cn(
            'col-start-3 row-start-1 flex h-9 items-center gap-1',
            revealOnHover && REVEAL_ON_ROW_HOVER
          )}
        >
          {day.ranges.length < MAX_RANGES_PER_DAY && (
            <button
              type="button"
              onClick={onAddRange}
              className="text-primary focus-visible:ring-ring inline-flex h-8 items-center gap-1 rounded-md px-1.5 text-[13px] font-medium whitespace-nowrap underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Add range <span className="sr-only">to {meta.full}</span>
            </button>
          )}
          <Popover open={copyOpen} onOpenChange={handleCopyOpenChange}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Copy ${meta.full} hours to other days`}
              >
                <Copy className="h-4 w-4" aria-hidden="true" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-52">
              <SettingsEyebrow as="p" className="mb-3">
                Copy {meta.short} to
              </SettingsEyebrow>
              <div className="flex flex-col gap-1">
                {otherDays.map((other) => {
                  const checkboxId = `copy-${dayIndex}-to-${other.index}`;
                  return (
                    <label
                      key={other.dayOfWeek}
                      htmlFor={checkboxId}
                      className="hover:bg-muted flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm"
                    >
                      <Checkbox
                        id={checkboxId}
                        checked={copyTargets.includes(other.index)}
                        onCheckedChange={(checked) =>
                          toggleCopyTarget(other.index, checked === true)
                        }
                      />
                      {other.full}
                    </label>
                  );
                })}
              </div>
              <Button
                type="button"
                size="sm"
                className="mt-3 w-full"
                disabled={copyTargets.length === 0}
                onClick={applyCopy}
              >
                Apply
              </Button>
            </PopoverContent>
          </Popover>
        </div>
      )}
    </div>
  );
}
