'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { TIME_OPTIONS, type TimeOption } from '../_lib/schedule-helpers';

interface ScheduleTimeSelectProps {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name (e.g. "Monday range 1 start time"). */
  ariaLabel: string;
  /** Option list. Defaults to all 96 15-minute slots; end pickers pass a computed list. */
  options?: readonly TimeOption[];
  /** Space-separated id list describing this control (crossing badge, conflict text). */
  ariaDescribedBy?: string;
  /** Marks the control as in-error — drives the destructive border via the primitive. */
  invalid?: boolean;
  /** Extra trigger classes (crossing info tint / conflict background). */
  triggerClassName?: string;
  disabled?: boolean;
}

/** 15-minute wall-clock picker. Callers shape the option list — end pickers pass a wrapping list built by `buildEndOptions`. */
export function ScheduleTimeSelect({
  value,
  onChange,
  ariaLabel,
  options = TIME_OPTIONS,
  ariaDescribedBy,
  invalid,
  triggerClassName,
  disabled,
}: Readonly<ScheduleTimeSelectProps>): React.JSX.Element {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={invalid ? true : undefined}
        className={cn('h-9 w-[112px] tabular-nums', triggerClassName)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-64">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} className="tabular-nums">
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
