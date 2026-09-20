'use client';

import { Users } from 'lucide-react';
import { SectionHead } from '@/components/balo/section/section-states';
import type { CasePersonView } from '@/lib/cases/case-view-types';

/**
 * BAL-421 — who is on the case, plus the retrospective-access disclosure.
 *
 * ⚠⚠ THERE IS NO "INVITE A COLLEAGUE" BUTTON ON THIS CARD, AND ITS ABSENCE IS DELIBERATE. A
 * guest is keyed to `meetings.id`, so the per-meeting consultation row (`consultation-row-menu.tsx`)
 * is the correct anchor once two calls are booked — not this card. Even there, Invite ships in
 * a later phase: `apps/web/src/lib/authz/meeting-participation.ts:164` isn't yet a general web
 * participation seam, and a per-row `canInvite` needs that widened first.
 *
 * The DISCLOSURE line below still renders — it is true of the grant model regardless of where
 * the button eventually lives.
 *
 * ⚠ "You" IS RESOLVED SERVER-SIDE (`isViewer`). The client never compares user ids to work out
 * who it is talking to.
 */
export function CasePeopleCard({
  people,
}: Readonly<{ people: readonly CasePersonView[] }>): React.JSX.Element {
  return (
    <section className="bg-card border-border rounded-xl border px-5 py-4">
      <SectionHead icon={Users} title="People" />
      <p className="text-muted-foreground text-xs leading-relaxed">
        {people.map((person, index) => (
          <span key={person.name + String(person.isViewer)}>
            {index > 0 && ' · '}
            {person.isViewer ? 'You' : person.name}
          </span>
        ))}
      </p>
      <p className="text-muted-foreground/80 mt-1 text-xs leading-relaxed">
        Anyone invited sees this whole case, including past consultations.
      </p>
    </section>
  );
}
