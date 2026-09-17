'use client';

import { useMemo } from 'react';
import { personDisplayName } from '@balo/shared/parties';
import type { StaffAccessPerson } from '@balo/shared/authz';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { InputFloating } from '@/components/enhanced/input-floating';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { deriveInitials } from '@/lib/format/initials';
import { STAFF_ACCESS_ROLE_COPY } from '../_lib/staff-access-roles';

interface StaffRosterProps {
  readonly people: readonly StaffAccessPerson[];
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly activePersonId: string | null;
  readonly onSelect: (personId: string) => void;
  readonly viewerId: string;
  readonly onGiveAccess: () => void;
}

/** BAL-561 — the left-column roster: search, list, footer count and entry point. */
export function StaffRoster({
  people,
  query,
  onQueryChange,
  activePersonId,
  onSelect,
  viewerId,
  onGiveAccess,
}: Readonly<StaffRosterProps>): React.JSX.Element {
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return people;
    return people.filter((person) => {
      const name = personDisplayName(person.firstName, person.lastName, person.email);
      return name.toLowerCase().includes(needle) || person.email.toLowerCase().includes(needle);
    });
  }, [people, query]);

  return (
    <div className="border-border bg-card flex flex-col rounded-2xl border">
      <div className="p-4 pb-2">
        <InputFloating
          label="Search staff"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </div>
      <ScrollArea className="max-h-[28rem]">
        {shown.length === 0 ? (
          <div className="space-y-2 px-4 py-6 text-center">
            <p className="text-muted-foreground text-sm">
              {/* pending-MJ */}
              Nobody on the list matches &ldquo;{query}&rdquo;.
            </p>
            <button
              type="button"
              onClick={onGiveAccess}
              className="text-primary text-sm font-medium"
            >
              {/* pending-MJ */}
              Give someone access
            </button>
          </div>
        ) : (
          <ul className="space-y-0.5 p-2">
            {shown.map((person) => {
              const name = personDisplayName(person.firstName, person.lastName, person.email);
              const active = person.id === activePersonId;
              const metaParts = [STAFF_ACCESS_ROLE_COPY[person.role].title];
              if (person.customList !== null) metaParts.push('custom');
              if (!person.isLive) metaParts.push('suspended');
              return (
                <li key={person.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(person.id)}
                    aria-current={active ? 'true' : undefined}
                    className={cn(
                      'flex min-h-[44px] w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left',
                      active ? 'bg-primary/10' : 'hover:bg-muted/60'
                    )}
                  >
                    <Avatar size="sm">
                      <AvatarFallback>{deriveInitials(name)}</AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground block truncate text-sm font-medium">
                        {name}
                        {person.id === viewerId ? ' (you)' : ''}
                      </span>
                      <span className="text-muted-foreground block truncate text-xs">
                        {metaParts.join(' · ')}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </ScrollArea>
      <div className="border-border flex items-center justify-between gap-2 border-t p-3 text-sm">
        {/* pending-MJ */}
        <span className="text-muted-foreground">{people.length} with staff access</span>
        <button type="button" onClick={onGiveAccess} className="text-primary font-medium">
          {/* pending-MJ */}
          Give someone access
        </button>
      </div>
    </div>
  );
}
