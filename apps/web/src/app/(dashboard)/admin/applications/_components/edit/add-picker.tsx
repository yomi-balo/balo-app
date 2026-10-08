'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';

/**
 * BAL-593 §[F] — the searchable add-picker shared by every edit section (languages, industries,
 * products, certifications): a dashed trigger button that opens a grouped, searchable combobox.
 * Design ref 905-1023 (a hand-rolled popover there; here the shadcn Popover + Command).
 */

export interface AddPickerGroup {
  /** `null` renders no group heading (a single flat list). */
  heading: string | null;
  items: { id: string; name: string }[];
}

interface AddPickerProps {
  readonly label: string;
  readonly groups: readonly AddPickerGroup[];
  readonly onPick: (id: string) => void;
  readonly disabled?: boolean;
}

export function AddPicker({
  label,
  groups,
  onPick,
  disabled = false,
}: AddPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const hasAnyItems = groups.some((g) => g.items.length > 0);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          className="border-dashed"
        >
          <Plus aria-hidden="true" className="size-3.5" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <Command>
          <CommandInput aria-label={`Search: ${label}`} placeholder="Search" />
          <CommandList>
            <CommandEmpty>
              {hasAnyItems ? 'No matches.' : 'Everything is already on the application.'}
            </CommandEmpty>
            {groups.map((group) => (
              <CommandGroup key={group.heading ?? 'all'} heading={group.heading ?? undefined}>
                {group.items.map((item) => (
                  <CommandItem
                    key={item.id}
                    value={item.name}
                    onSelect={() => {
                      onPick(item.id);
                      setOpen(false);
                    }}
                  >
                    {item.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
