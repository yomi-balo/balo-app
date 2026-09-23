'use client';

import { useCallback, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { TIMEZONE_TO_COUNTRY, extractCityFromTimezone } from '@balo/shared/timezone';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { shortOffset } from '../_lib/timezone-label';

interface TimezoneOption {
  tz: string;
  city: string;
  country: string;
  offset: string;
}

// Pinned subset shown first (from the design reference), filtered to valid zones at build.
const POPULAR_TIMEZONES = [
  'Australia/Melbourne',
  'Australia/Sydney',
  'Australia/Brisbane',
  'Australia/Perth',
  'Pacific/Auckland',
  'Asia/Singapore',
  'America/New_York',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Asia/Tokyo',
  'Asia/Dubai',
];

function toOption(tz: string): TimezoneOption {
  return {
    tz,
    city: extractCityFromTimezone(tz) ?? tz,
    country: TIMEZONE_TO_COUNTRY[tz]?.country ?? '',
    offset: shortOffset(tz),
  };
}

// `Intl.supportedValuesOf('timeZone')` omits 'UTC' and it isn't in TIMEZONE_TO_COUNTRY,
// so it must be added explicitly — otherwise a fresh expert (whose profile defaults to
// 'UTC') can't see or keep their current timezone.
const UTC_OPTION: TimezoneOption = {
  tz: 'UTC',
  city: 'UTC',
  country: 'Coordinated Universal Time',
  offset: shortOffset('UTC'),
};

function buildOptions(): { popular: TimezoneOption[]; all: TimezoneOption[] } {
  const supported = new Set(Intl.supportedValuesOf('timeZone'));
  const all = Object.keys(TIMEZONE_TO_COUNTRY)
    .filter((tz) => supported.has(tz))
    .sort((a, b) => a.localeCompare(b))
    .map(toOption);
  const popular = [
    UTC_OPTION,
    ...POPULAR_TIMEZONES.filter((tz) => supported.has(tz) && tz in TIMEZONE_TO_COUNTRY).map(
      toOption
    ),
  ];
  return { popular, all };
}

interface ScheduleTimezoneComboboxProps {
  value: string;
  onChange: (tz: string) => void;
  disabled?: boolean;
}

/**
 * A link-style "Change timezone" trigger that opens a searchable timezone list (popular
 * zones first, then every zone), with type-ahead filtering and arrow-key navigation from
 * the underlying Command list. The current zone is marked with a check.
 */
export function ScheduleTimezoneCombobox({
  value,
  onChange,
  disabled,
}: Readonly<ScheduleTimezoneComboboxProps>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const { popular, all } = useMemo(buildOptions, []);

  const handleSelect = useCallback(
    (tz: string): void => {
      onChange(tz);
      setOpen(false);
    },
    [onChange]
  );

  const renderItem = (option: TimezoneOption, keyPrefix: string): React.JSX.Element => (
    <CommandItem
      key={`${keyPrefix}:${option.tz}`}
      value={`${keyPrefix} ${option.tz} ${option.city} ${option.country}`}
      onSelect={() => handleSelect(option.tz)}
    >
      <Check
        className={cn('h-4 w-4', value === option.tz ? 'opacity-100' : 'opacity-0')}
        aria-hidden="true"
      />
      <span className="flex-1 truncate">
        <span className="text-foreground font-medium">{option.city}</span>
        {option.country && (
          <span className="text-muted-foreground ml-1.5 text-xs">{option.country}</span>
        )}
      </span>
      {option.offset && (
        <span className="text-muted-foreground font-mono text-[11px]">{option.offset}</span>
      )}
    </CommandItem>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="link"
          disabled={disabled}
          className="h-auto min-h-11 px-1 py-1.5 text-[13px] sm:min-h-0"
        >
          Change timezone
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(340px,calc(100vw-2rem))] p-0">
        <Command>
          <CommandInput placeholder="Search timezone…" />
          <CommandList>
            <CommandEmpty>No timezone found.</CommandEmpty>
            {popular.length > 0 && (
              <CommandGroup heading="Popular">
                {popular.map((option) => renderItem(option, 'popular'))}
              </CommandGroup>
            )}
            <CommandGroup heading="All timezones">
              {all.map((option) => renderItem(option, 'all'))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
