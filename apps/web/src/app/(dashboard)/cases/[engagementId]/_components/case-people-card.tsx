'use client';

import { Users } from 'lucide-react';
import { SectionHead } from '@/components/balo/section/section-states';
import type { CasePersonView } from '@/lib/cases/case-view-types';

/**
 * BAL-421 — who is on the case, plus the retrospective-access disclosure.
 *
 * ⚠⚠ THERE IS NO "INVITE A COLLEAGUE" BUTTON, AND ITS ABSENCE IS A DECISION. The design
 * reference draws one, and BAL-408 shipped the API (`POST /meetings/:meetingId/guests`) — but
 * TWO things are missing on `main`, either of which alone is disqualifying:
 *
 *   1. `apps/web` HAS NO SEAM THAT CREATES AN INVITE. It has only the `/join/[token]` LANDING,
 *      which CONSUMES one. There is no action, no api client and no route to call.
 *   2. GUEST READS ARE INERT. `resolveGuestConversationScope` has ZERO production callers and
 *      `/join/[token]` resolves an identity CLAIM with no guest read session behind it — so a
 *      guest holding a valid invite can read nothing.
 *
 * Rendering the button would promise, in its own copy, that "anyone invited sees this whole
 * case" while the grant grants nothing readable. That is the same class of lie as anchoring an
 * invite to a call that already happened, which the loader also refuses. The DISCLOSURE line
 * below still renders, because it is true of the grant model whenever the invite does land.
 *
 * ⚠ "You" IS RESOLVED SERVER-SIDE (`isViewer`). The client never compares user ids to work out
 * who it is talking to.
 */
export function CasePeopleCard({
  people,
}: Readonly<{ people: readonly CasePersonView[] }>): React.JSX.Element {
  return (
    <section className="bg-card border-border rounded-3xl border px-5 py-4">
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
