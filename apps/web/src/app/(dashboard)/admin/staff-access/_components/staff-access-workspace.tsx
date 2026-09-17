'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { StaffAccessPerson } from '@balo/shared/authz';
import { AddStaffDialog } from './add-staff-dialog';
import { StaffAccessDetail } from './staff-access-detail';
import { StaffAccessEmptyState } from './staff-access-states';
import { StaffRoster } from './staff-roster';

interface StaffAccessWorkspaceProps {
  readonly people: readonly StaffAccessPerson[];
  readonly viewerId: string;
  readonly initialPersonId: string | null;
}

/**
 * Prefer `preferredId` if it is still on the roster; else the first non-self person; else the
 * first person; else `null` (an empty roster). Used both for the initial selection (from the
 * `?person=` URL) and for the post-refresh fallback when the selected person falls off the
 * roster (for example, demoted to `user`).
 */
function resolveSelection(
  people: readonly StaffAccessPerson[],
  preferredId: string | null,
  viewerId: string
): string | null {
  if (preferredId !== null && people.some((person) => person.id === preferredId)) {
    return preferredId;
  }
  const nonSelf = people.find((person) => person.id !== viewerId);
  if (nonSelf !== undefined) return nonSelf.id;
  const [first] = people;
  return first?.id ?? null;
}

/**
 * BAL-561 — the client root: roster selection, search, and the add-staff entry point. Selecting a
 * person updates the URL via `window.history.replaceState` (no server round trip — deliberately
 * NOT `router.replace`, which would re-render the whole page for a client-only convenience).
 */
export function StaffAccessWorkspace({
  people,
  viewerId,
  initialPersonId,
}: Readonly<StaffAccessWorkspaceProps>): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    resolveSelection(people, initialPersonId, viewerId)
  );
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    if (selectedId !== null && people.some((person) => person.id === selectedId)) return;
    setSelectedId(resolveSelection(people, null, viewerId));
    // `people` is the only dependency this effect reacts to: it exists to catch the CURRENT
    // selection falling off a refreshed roster, not to re-derive on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people]);

  const handleSelect = useCallback((personId: string): void => {
    setSelectedId(personId);
    globalThis.history.replaceState(null, '', `?person=${personId}`);
  }, []);

  const handleGiveAccess = useCallback((): void => setAddOpen(true), []);

  const selected = useMemo(
    () => people.find((person) => person.id === selectedId) ?? null,
    [people, selectedId]
  );

  if (people.length === 0) {
    return (
      <>
        <StaffAccessEmptyState onGiveAccess={handleGiveAccess} />
        <AddStaffDialog open={addOpen} onOpenChange={setAddOpen} onSelectPerson={handleSelect} />
      </>
    );
  }

  const detailKey =
    selected === null
      ? 'none'
      : `${selected.id}:${selected.role}:${(selected.customList ?? ['∅']).join(',')}`;

  return (
    <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
      <StaffRoster
        people={people}
        query={query}
        onQueryChange={setQuery}
        activePersonId={selectedId}
        onSelect={handleSelect}
        viewerId={viewerId}
        onGiveAccess={handleGiveAccess}
      />
      {selected !== null && (
        <StaffAccessDetail key={detailKey} person={selected} people={people} viewerId={viewerId} />
      )}
      <AddStaffDialog open={addOpen} onOpenChange={setAddOpen} onSelectPerson={handleSelect} />
    </div>
  );
}
