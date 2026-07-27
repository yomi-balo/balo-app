'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronsUpDown, Globe } from 'lucide-react';
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

/** 'GMT+11' style short offset for a zone, or '' if unavailable. */
function shortOffset(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date());
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

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

function formatCurrentTime(tz: string): string {
  try {
    // `weekday: 'short'` disambiguates times either side of the date line (e.g.
    // "Fri, 10:35 AM"), matching the schedule-editor prototype.
    return new Date().toLocaleTimeString('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return '';
  }
}

interface ScheduleTimezoneComboboxProps {
  value: string;
  onChange: (tz: string) => void;
  disabled?: boolean;
}

export function ScheduleTimezoneCombobox({
  value,
  onChange,
  disabled,
}: Readonly<ScheduleTimezoneComboboxProps>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [currentTime, setCurrentTime] = useState('');
  const { popular, all } = useMemo(buildOptions, []);

  // Live current-time preview, refreshed every 10s.
  useEffect(() => {
    const update = (): void => setCurrentTime(formatCurrentTime(value));
    update();
    const timer = setInterval(update, 10_000);
    return () => clearInterval(timer);
  }, [value]);

  const handleSelect = useCallback(
    (tz: string): void => {
      onChange(tz);
      setOpen(false);
    },
    [onChange]
  );

  const selectedCity = extractCityFromTimezone(value) ?? value;
  const selectedCountry = TIMEZONE_TO_COUNTRY[value]?.country ?? '';

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
          variant="outline"
          role="combobox"
          disabled={disabled}
          aria-label="Select your timezone"
          aria-expanded={open}
          className="h-11 w-full justify-start gap-2.5 px-3.5 font-normal"
        >
          <Globe className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="flex-1 truncate text-left">
            <span className="text-foreground text-sm font-medium">{selectedCity}</span>
            {selectedCountry && (
              <span className="text-muted-foreground ml-1.5 text-xs">{selectedCountry}</span>
            )}
            {currentTime && (
              <span className="text-muted-foreground ml-2 text-xs">· {currentTime}</span>
            )}
          </span>
          <ChevronsUpDown
            className="text-muted-foreground h-4 w-4 shrink-0 opacity-70"
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
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
