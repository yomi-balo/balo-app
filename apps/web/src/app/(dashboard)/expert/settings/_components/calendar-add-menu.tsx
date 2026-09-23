'use client';

import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PROVIDER_META } from '../_lib/calendar-providers';
import type { CalendarProvider } from '../_types/calendar';

export interface CalendarAddMenuOption {
  readonly provider: CalendarProvider;
  /**
   * Why this provider cannot be added right now ("Connected", "Waiting on IT"), shown muted
   * beside it; `null` when it can be. The caller decides — see the note where
   * `calendar-connections-section.tsx` builds these options.
   */
  readonly unavailableReason: string | null;
}

interface CalendarAddMenuProps {
  readonly options: readonly CalendarAddMenuOption[];
  readonly onSelect: (provider: CalendarProvider) => void;
}

/**
 * The Calendars card's "Add calendar" menu. Every provider is always listed, so the expert can
 * see what Balo supports even when nothing more can be added; an unavailable one is a
 * disabled item with its reason beside it rather than a missing one.
 */
export function CalendarAddMenu({
  options,
  onSelect,
}: Readonly<CalendarAddMenuProps>): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-11 gap-1.5 sm:h-9">
          <Plus aria-hidden="true" />
          Add calendar
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60 p-1.5">
        {options.map(({ provider, unavailableReason }) => {
          const { label, Icon } = PROVIDER_META[provider];
          return (
            <DropdownMenuItem
              key={provider}
              disabled={unavailableReason !== null}
              onSelect={() => onSelect(provider)}
              className="min-h-11 gap-2.5 px-2.5 sm:min-h-9"
            >
              <Icon size={16} />
              <span className="text-foreground flex-1 text-[13.5px]">{label}</span>
              {unavailableReason !== null && (
                <span className="text-muted-foreground text-xs">{unavailableReason}</span>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
