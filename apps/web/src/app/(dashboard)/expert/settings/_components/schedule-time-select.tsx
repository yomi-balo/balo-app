'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TIME_OPTIONS } from '../_lib/schedule-helpers';

interface ScheduleTimeSelectProps {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name (e.g. "Monday range 1 start time"). */
  ariaLabel: string;
  /** When set, only options strictly after this 'HH:mm' are offered (end pickers). */
  minExclusive?: string;
  disabled?: boolean;
}

/** 15-minute wall-clock picker (00:00–23:45). End pickers filter to `> minExclusive`. */
export function ScheduleTimeSelect({
  value,
  onChange,
  ariaLabel,
  minExclusive,
  disabled,
}: Readonly<ScheduleTimeSelectProps>): React.JSX.Element {
  const options = minExclusive
    ? TIME_OPTIONS.filter((option) => option.value > minExclusive)
    : TIME_OPTIONS;

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
