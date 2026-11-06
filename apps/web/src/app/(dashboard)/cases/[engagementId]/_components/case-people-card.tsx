'use client';

import { Users } from 'lucide-react';
import { SectionHead } from '@/components/balo/section/section-states';
import type { CasePeopleGroupView } from '@/lib/cases/case-view-types';

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
 * ⚠ GROUPS, ORDER, KEYS AND "You" ALL COME FROM `_lib/load-case-people.ts`. The card does no
 * identity logic: it renders each group's label as a heading, then one row per name verbatim, then
 * an unnamed-guest count row.
 */

/** The count of guests with no name on record, e.g. `+1 guest` or `+3 guests`. */
export function formatUnnamedGuestCount(count: number): string {
  return count === 1 ? '+1 guest' : `+${count} guests`;
}

/** BAL-573 — verbatim, exported so `case-surface.test.tsx` can assert against it rather than a
 *  `stringContaining` fragment. */
export const PEOPLE_CARD_CLIENT_DISCLOSURE = (clientCompanyName: string): string =>
  `Guests on ${clientCompanyName}'s email domain see this whole case, including past consultations. Anyone else sees only the consultation they're invited to.`;

export const PEOPLE_CARD_NARROW_DISCLOSURE =
  "Guests you invite see only the consultation they're invited to.";

export function CasePeopleCard({
  groups,
  lens,
  clientCompanyName,
  hasCaseScopeDomains,
}: Readonly<{
  groups: readonly CasePeopleGroupView[];
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
      <div className="space-y-3">
        {groups.map((group) => (
          <div key={group.side} role="group" aria-label={group.label}>
            <p className="text-muted-foreground text-xs font-medium">{group.label}</p>
            {(group.people.length > 0 || group.unnamedGuestCount > 0) && (
              <ul className="mt-1 space-y-0.5">
                {group.people.map((person) => (
                  <li key={person.key} className="text-foreground text-sm">
                    {person.name}
                  </li>
                ))}
                {group.unnamedGuestCount > 0 && (
                  <li className="text-muted-foreground text-sm">
                    {formatUnnamedGuestCount(group.unnamedGuestCount)}
                  </li>
                )}
              </ul>
            )}
          </div>
        ))}
      </div>
      <p className="text-muted-foreground/80 mt-3 text-xs leading-relaxed">{disclosure}</p>
    </section>
  );
}
