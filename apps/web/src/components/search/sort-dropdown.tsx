'use client';

import { useCallback } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { SORT_VALUES, type SortValue } from '@/lib/search/filters';
import { useUpdateSearchParams } from './use-update-search-params';

const SORT_LABELS: Record<SortValue, string> = {
  best_match: 'Best match',
  soonest: 'Soonest available',
  lowest_rate: 'Lowest rate',
  most_experienced: 'Most experienced',
};

interface SortDropdownProps {
  sort: SortValue;
  /** Render full-width (mobile controls row). */
  full?: boolean;
}

export function SortDropdown({
  sort,
  full = false,
}: Readonly<SortDropdownProps>): React.JSX.Element {
  const { setParam } = useUpdateSearchParams();

  const handleChange = useCallback(
    (value: string) => {
      setParam('sort', value);
    },
    [setParam]
  );

  return (
    <Select value={sort} onValueChange={handleChange}>
      <SelectTrigger aria-label="Sort experts" className={cn(full ? 'h-11 w-full' : 'h-9 w-auto')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SORT_VALUES.map((value) => (
          <SelectItem key={value} value={value}>
            {SORT_LABELS[value]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
