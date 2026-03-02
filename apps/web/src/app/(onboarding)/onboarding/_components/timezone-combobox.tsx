'use client';

import { useMemo } from 'react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

interface TimezoneComboboxProps {
  value: string;
  onValueChange: (tz: string) => void;
}

const ALL_TIMEZONES = Intl.supportedValuesOf('timeZone');

// Pre-compute UTC offsets at module load (runs once)
const OFFSET_MAP = new Map<string, string>();
for (const tz of ALL_TIMEZONES) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'shortOffset',
    });
    const parts = formatter.formatToParts(new Date());
    OFFSET_MAP.set(tz, parts.find((p) => p.type === 'timeZoneName')?.value ?? '');
  } catch {
    OFFSET_MAP.set(tz, '');
  }
}

export function TimezoneCombobox({
  value,
  onValueChange,
}: TimezoneComboboxProps): React.JSX.Element {
  const grouped = useMemo(() => {
    const groups: Record<string, string[]> = {};
    for (const tz of ALL_TIMEZONES) {
      const region = tz.split('/')[0]!;
      (groups[region] ??= []).push(tz);
    }
    return groups;
  }, []);

  return (
    <Command className="rounded-lg border" aria-label="Select timezone">
      <CommandInput placeholder="Search timezones..." />
      <CommandList className="max-h-[240px]">
        <CommandEmpty>No timezone found.</CommandEmpty>
        {Object.entries(grouped).map(([region, timezones]) => (
          <CommandGroup key={region} heading={region}>
            {timezones.map((tz) => (
              <CommandItem
                key={tz}
                value={tz}
                onSelect={() => onValueChange(tz)}
                className="cursor-pointer"
              >
                <span className="flex-1">{tz.replace(/_/g, ' ')}</span>
                <span className="text-muted-foreground ml-auto text-xs">
                  {OFFSET_MAP.get(tz) ?? ''}
                </span>
                <Check
                  className={cn(
                    'ml-2 h-4 w-4',
                    value === tz ? 'text-primary opacity-100' : 'opacity-0'
                  )}
                />
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  );
}
