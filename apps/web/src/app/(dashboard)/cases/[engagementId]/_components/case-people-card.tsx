'use client';

import { Users } from 'lucide-react';
import { SectionHead } from '@/components/balo/section/section-states';
import type { CasePersonView } from '@/lib/cases/case-view-types';

/**
 * BAL-421 — who is on the case, plus the retrospective-access disclosure.
 *
 * ⚠⚠ THERE IS STILL NO "INVITE A COLLEAGUE" BUTTON ON THIS CARD, AND ITS ABSENCE IS STILL
 * DELIBERATE. A guest is keyed to `meetings.id` (BAL-418), so the per-meeting consultation row
 * is the correct anchor once two calls are booked — this card has nothing to anchor to. BAL-573
 * ships that anchor: `consultation-row-menu.tsx`'s first item and the row's own guest-count
 * control.
 *
 * ⚠⚠ THE DISCLOSURE BELOW IS LENS-ACCURATE, NOT UNCONDITIONAL (BAL-573, D5). The old
 * unconditional "Anyone invited sees this whole case" line was FALSE for every freemail or
 * external invitee, and for every expert-side invite — `resolveGuestAccessScope` widens a
 * grant to the whole case only for a CLIENT-side inviter, on a CORPORATE address, matching a
 * LIVE registered `party_domains` row. AC 7 is satisfied by the composer's own PER-INVITEE
 * conditional disclosure at the moment of consent, not by this card; the line here still states
 * the grant model in the aggregate, because it is still worth stating.
 *
 * ⚠⚠ THE CLIENT SENTENCE ITSELF FALLS BACK TO THE NARROW ONE WHEN THE COMPANY HAS NO LIVE
 * `party_domains` ROW (e.g. a freemail-founded individual company, ADR-1038). With no
 * registered domain, no address can ever match one, so naming a domain-based widening would
 * describe an outcome that can never fire — the same narrow fact the expert lens states.
 *
 * ⚠ "You" IS RESOLVED SERVER-SIDE (`isViewer`). The client never compares user ids to work out
 * who it is talking to.
 */

/** BAL-573 — verbatim, exported so `case-surface.test.tsx` can assert against it rather than a
 *  `stringContaining` fragment. */
export const PEOPLE_CARD_CLIENT_DISCLOSURE = (clientCompanyName: string): string =>
  `Guests on ${clientCompanyName}'s email domain see this whole case, including past consultations. Anyone else sees only the consultation they're invited to.`;

export const PEOPLE_CARD_NARROW_DISCLOSURE =
  "Guests you invite see only the consultation they're invited to.";

export function CasePeopleCard({
  people,
  lens,
  clientCompanyName,
  hasCaseScopeDomains,
}: Readonly<{
  people: readonly CasePersonView[];
  lens: 'client' | 'expert';
  /** `null` ⇒ "your company" — the composer's own fallback wording. */
  clientCompanyName: string | null;
  /**
   * BAL-573 (F4) — whether the client company holds at least one LIVE `party_domains` row, i.e.
   * `view.caseScopeDomains.length > 0` on the client lens. `false` on the expert lens (there is
   * no widening to disclose there either way).
   */
  hasCaseScopeDomains: boolean;
}>): React.JSX.Element {
  const disclosure =
    lens === 'client' && hasCaseScopeDomains
      ? PEOPLE_CARD_CLIENT_DISCLOSURE(clientCompanyName ?? 'your company')
      : PEOPLE_CARD_NARROW_DISCLOSURE;

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
      <p className="text-muted-foreground/80 mt-1 text-xs leading-relaxed">{disclosure}</p>
    </section>
  );
}
