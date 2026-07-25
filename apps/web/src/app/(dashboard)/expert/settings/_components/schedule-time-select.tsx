'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TIME_OPTIONS, type TimeOption } from '../_lib/schedule-helpers';

interface ScheduleTimeSelectProps {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name (e.g. "Monday range 1 start time"). */
  ariaLabel: string;
  /** Base option list. Defaults to all 15-minute slots (end pickers); start pickers pass a capped list. */
  options?: readonly TimeOption[];
  /** When set, only options strictly after this 'HH:mm' are offered (end pickers). */
  minExclusive?: string;
  disabled?: boolean;
}

/** 15-minute wall-clock picker. End pickers filter to `> minExclusive`; start pickers pass a 23:30-capped list. */
export function ScheduleTimeSelect({
  value,
  onChange,
  ariaLabel,
  options: baseOptions = TIME_OPTIONS,
  minExclusive,
  disabled,
}: Readonly<ScheduleTimeSelectProps>): React.JSX.Element {
  const options = minExclusive
    ? baseOptions.filter((option) => option.value > minExclusive)
    : baseOptions;

  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger aria-label={ariaLabel} className="h-9 w-[112px] tabular-nums">
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
