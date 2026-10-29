'use client';

import { useCallback, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AgencyAvatar } from './agency-row';

/**
 * PersonFilter ("Delivered by") — narrows the agency lens to one expert. People are derived from
 * the loaded rows by the dashboard, so there is no member read. A shadcn `Select` up to
 * {@link SEARCH_THRESHOLD} people, a searchable `Command` above it.
 */

export const EVERYONE = 'all';
const SEARCH_THRESHOLD = 30;

export interface AgencyPerson {
  expertProfileId: string;
  /** Display label: "You" for the viewer, else the full name. */
  label: string;
  isViewer: boolean;
  count: number;
}

interface AgencyPersonFilterProps {
  people: AgencyPerson[];
  /** `EVERYONE` or an expert profile id. */
  active: string;
  total: number;
  onPick: (id: string) => void;
}

function PersonLabel({
  person,
  count,
}: Readonly<{ person: AgencyPerson; count: number }>): React.JSX.Element {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <AgencyAvatar id={person.expertProfileId} name={person.label} size={20} />
      <span className="truncate">{person.label}</span>
      <span
        className={cn(
          'ml-auto pl-2 tabular-nums',
          count === 0 ? 'text-muted-foreground/50' : 'text-muted-foreground'
        )}
      >
        {count}
      </span>
    </span>
  );
}

const TRIGGER_CLASS = 'h-11 w-full gap-2 rounded-[10px] md:h-9 md:w-auto md:max-w-[320px]';

function TriggerBody({
  current,
  total,
}: Readonly<{ current: AgencyPerson | undefined; total: number }>): React.JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-2 text-[13px]">
      <span className="text-muted-foreground whitespace-nowrap">Delivered by</span>
      {current ? (
        <>
          <AgencyAvatar id={current.expertProfileId} name={current.label} size={20} />
          <span className="text-primary truncate font-semibold">{current.label}</span>
        </>
      ) : (
        <span className="text-foreground truncate font-semibold">Everyone</span>
      )}
      <span className="text-muted-foreground tabular-nums">{current ? current.count : total}</span>
    </span>
  );
}

function SearchableFilter({
  people,
  active,
  total,
  onPick,
}: Readonly<AgencyPersonFilterProps>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const current = people.find((p) => p.expertProfileId === active);

  const handlePick = useCallback(
    (id: string) => {
      onPick(id);
      setOpen(false);
    },
    [onPick]
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={`Delivered by: ${current ? current.label : 'Everyone'}`}
          className={cn(
            'border-input bg-background focus-visible:ring-ring flex items-center justify-between border px-3 focus-visible:ring-2 focus-visible:outline-none',
            TRIGGER_CLASS
          )}
        >
          <TriggerBody current={current} total={total} />
          <ChevronDown className="text-muted-foreground h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[280px] p-0">
        <Command>
          <CommandInput placeholder="Search experts" />
          <CommandList>
            <CommandEmpty>No expert found.</CommandEmpty>
            <CommandGroup>
              <CommandItem value="Everyone" onSelect={() => handlePick(EVERYONE)}>
                <Check
                  className={cn('h-4 w-4', active === EVERYONE ? 'opacity-100' : 'opacity-0')}
                  aria-hidden="true"
                />
                Everyone
                <span className="text-muted-foreground ml-auto tabular-nums">{total}</span>
              </CommandItem>
              {people.map((person) => (
                <CommandItem
                  key={person.expertProfileId}
                  value={person.label}
                  onSelect={() => handlePick(person.expertProfileId)}
                >
                  <Check
                    className={cn(
                      'h-4 w-4',
                      active === person.expertProfileId ? 'opacity-100' : 'opacity-0'
                    )}
                    aria-hidden="true"
                  />
                  <PersonLabel person={person} count={person.count} />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function AgencyPersonFilter(props: Readonly<AgencyPersonFilterProps>): React.JSX.Element {
  const { people, active, total, onPick } = props;
  if (people.length > SEARCH_THRESHOLD) return <SearchableFilter {...props} />;

  const current = people.find((p) => p.expertProfileId === active);
  return (
    <Select value={active} onValueChange={onPick}>
      <SelectTrigger
        aria-label={`Delivered by: ${current ? current.label : 'Everyone'}`}
        className={TRIGGER_CLASS}
      >
        <SelectValue>
          <TriggerBody current={current} total={total} />
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="end" className="w-[280px]">
        <SelectItem value={EVERYONE}>
          <span className="flex flex-1 items-center gap-2">
            Everyone
            <span className="text-muted-foreground ml-auto pl-2 tabular-nums">{total}</span>
          </span>
        </SelectItem>
        {people.map((person) => (
          <SelectItem key={person.expertProfileId} value={person.expertProfileId}>
            <PersonLabel person={person} count={person.count} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
