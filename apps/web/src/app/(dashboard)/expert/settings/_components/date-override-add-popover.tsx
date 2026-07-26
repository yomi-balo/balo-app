'use client';

import { useCallback, useMemo, useState } from 'react';
import type { DateRange } from 'react-day-picker';
import { Loader2, Plus } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export interface CreateOverrideInput {
  startDate: string;
  endDate: string;
  label?: string;
}

interface DateOverrideAddPopoverProps {
  /** Returns true when the block was created (so the popover can reset + close). */
  onCreate: (input: CreateOverrideInput) => Promise<boolean>;
}

/** Format a local `Date` (react-day-picker gives local-midnight dates) as `YYYY-MM-DD`. */
function toIsoDate(d: Date): string {
  const y = d.getFullYear().toString().padStart(4, '0');
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function DateOverrideAddPopover({
  onCreate,
}: Readonly<DateOverrideAddPopoverProps>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<DateRange | undefined>(undefined);
  const [label, setLabel] = useState('');
  const [pending, setPending] = useState(false);

  // Local-midnight today. Past dates are hidden by `listUpcoming` on refresh, so
  // blocking them at the source prevents a phantom/inconsistent optimistic row.
  // `{ before: today }` is exclusive of `today`, so today itself stays selectable.
  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  const reset = useCallback(() => {
    setRange(undefined);
    setLabel('');
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) reset();
    },
    [reset]
  );

  const handleSubmit = useCallback(async () => {
    if (!range?.from) return;
    setPending(true);
    const trimmed = label.trim();
    const created = await onCreate({
      startDate: toIsoDate(range.from),
      // Single-day selection: `to` is undefined, so the block collapses to one day.
      endDate: toIsoDate(range.to ?? range.from),
      label: trimmed.length > 0 ? trimmed : undefined,
    });
    setPending(false);
    if (created) {
      reset();
      setOpen(false);
    }
  }, [range, label, onCreate, reset]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-11 shrink-0 gap-1.5 focus-visible:ring-2">
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add time off
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-0">
        <Calendar
          mode="range"
          selected={range}
          onSelect={setRange}
          numberOfMonths={1}
          disabled={{ before: today }}
          autoFocus
          className="p-3"
        />
        <div className="border-border space-y-3 border-t p-3">
          <div className="space-y-1.5">
            <label
              htmlFor="date-override-label"
              className="text-muted-foreground block text-xs font-medium"
            >
              Label (optional)
            </label>
            <Input
              id="date-override-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={80}
              placeholder="e.g. Holiday"
              className="h-9"
            />
          </div>
          <Button
            onClick={handleSubmit}
            disabled={!range?.from || pending}
            className="h-11 w-full focus-visible:ring-2"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Block these dates
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
