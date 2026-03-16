'use client';

import { useState } from 'react';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { cn } from '@/lib/utils';
import { COUNTRIES, getPriorityCountries, type Country } from '@/lib/constants/countries';

interface CountryComboboxProps {
  value: string;
  onValueChange: (code: string) => void;
  disabled?: boolean;
}

export function CountryCombobox({
  value,
  onValueChange,
  disabled = false,
}: CountryComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const priorityCountries = getPriorityCountries();
  const selected = COUNTRIES.find((c) => c.code === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="h-11 w-full justify-between text-left font-normal"
        >
          {selected ? (
            <span className="flex items-center gap-2">
              <span className="text-base">{selected.flag}</span>
              <span>{selected.name}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">Select your country...</span>
          )}
          <ChevronsUpDown className="ml-auto h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search country..." />
          <CommandList>
            <CommandEmpty>
              <div className="flex flex-col items-center gap-1 py-4">
                <Search className="text-muted-foreground h-5 w-5" />
                <p className="text-muted-foreground text-sm">No countries found</p>
              </div>
            </CommandEmpty>

            {/* Priority countries */}
            <CommandGroup heading="Popular">
              {priorityCountries.map((country) => (
                <CountryItem
                  key={country.code}
                  country={country}
                  isSelected={value === country.code}
                  onSelect={() => {
                    onValueChange(country.code);
                    setOpen(false);
                  }}
                />
              ))}
            </CommandGroup>

            <CommandSeparator />

            {/* All countries */}
            <CommandGroup heading="All countries">
              {COUNTRIES.map((country) => (
                <CountryItem
                  key={country.code}
                  country={country}
                  isSelected={value === country.code}
                  onSelect={() => {
                    onValueChange(country.code);
                    setOpen(false);
                  }}
                />
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function CountryItem({
  country,
  isSelected,
  onSelect,
}: {
  country: Country;
  isSelected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <CommandItem
      value={`${country.name} ${country.code}`}
      onSelect={onSelect}
      className="flex items-center gap-2"
    >
      <Check className={cn('h-4 w-4', isSelected ? 'opacity-100' : 'opacity-0')} />
      <span className="text-base">{country.flag}</span>
      <span className="flex-1">{country.name}</span>
      <span className="text-muted-foreground text-xs">{country.code}</span>
    </CommandItem>
  );
}
