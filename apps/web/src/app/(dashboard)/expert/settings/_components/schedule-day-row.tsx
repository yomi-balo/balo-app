'use client';

import { useCallback, useState } from 'react';
import { Copy, Plus, X } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScheduleTimeSelect } from './schedule-time-select';
import {
  DAY_META,
  MAX_RANGES_PER_DAY,
  START_TIME_OPTIONS,
  type DayState,
} from '../_lib/schedule-helpers';

interface ScheduleDayRowProps {
  dayIndex: number;
  day: DayState;
  onToggle: (enabled: boolean) => void;
  onRangeChange: (rangeId: string, field: 'start' | 'end', value: string) => void;
  onAddRange: () => void;
  onRemoveRange: (rangeId: string) => void;
  onCopyToDays: (targetIndices: number[]) => void;
}

export function ScheduleDayRow({
  dayIndex,
  day,
  onToggle,
  onRangeChange,
  onAddRange,
  onRemoveRange,
  onCopyToDays,
}: Readonly<ScheduleDayRowProps>): React.JSX.Element {
  const meta = DAY_META[dayIndex];
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

  if (!meta) return <></>;

  const otherDays = DAY_META.map((other, index) => ({ ...other, index })).filter(
    (other) => other.index !== dayIndex
  );

  return (
    <div className="border-border/60 flex flex-wrap items-start gap-4 border-t py-3.5 first:border-t-0">
      {/* Toggle + day name */}
      <div className="flex w-24 shrink-0 items-center gap-3 pt-1.5">
        <Switch
          checked={day.enabled}
          onCheckedChange={onToggle}
          aria-label={`${meta.full} availability`}
        />
        <span
          className={
            day.enabled
              ? 'text-foreground text-sm font-semibold'
              : 'text-muted-foreground text-sm font-medium'
          }
        >
          {meta.short}
        </span>
      </div>

      {/* Ranges or unavailable */}
      <div className="min-w-[220px] flex-1">
        {day.enabled ? (
          <div className="flex flex-col gap-2">
            {day.ranges.map((range, rangeIndex) => (
              <div key={range.id} className="flex flex-wrap items-center gap-2">
                <ScheduleTimeSelect
                  value={range.start}
                  options={START_TIME_OPTIONS}
                  ariaLabel={`${meta.full} range ${rangeIndex + 1} start time`}
                  onChange={(value) => onRangeChange(range.id, 'start', value)}
                />
                <span className="text-muted-foreground text-sm">–</span>
                <ScheduleTimeSelect
                  value={range.end}
                  minExclusive={range.start}
                  ariaLabel={`${meta.full} range ${rangeIndex + 1} end time`}
                  onChange={(value) => onRangeChange(range.id, 'end', value)}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-foreground h-8 w-8"
                  aria-label={`Remove ${meta.full} range ${rangeIndex + 1}`}
                  onClick={() => onRemoveRange(range.id)}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            ))}
            {day.ranges.length < MAX_RANGES_PER_DAY && (
              <button
                type="button"
                onClick={onAddRange}
                className="text-muted-foreground hover:text-primary focus-visible:ring-ring inline-flex w-fit items-center gap-1.5 rounded-md text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Add a time range
              </button>
            )}
          </div>
        ) : (
          <span className="text-muted-foreground pt-2 text-sm italic">Unavailable</span>
        )}
      </div>

      {/* Copy to other days */}
      <div className="shrink-0 pt-0.5">
        <Popover open={copyOpen} onOpenChange={handleCopyOpenChange}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-9 w-9"
              aria-label={`Copy ${meta.full} hours to other days`}
            >
              <Copy className="h-4 w-4" aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-52">
            <p className="text-muted-foreground mb-3 text-[11px] font-bold tracking-wider uppercase">
              Copy {meta.short} to
            </p>
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
                      onCheckedChange={(checked) => toggleCopyTarget(other.index, checked === true)}
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
    </div>
  );
}
