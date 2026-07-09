'use client';

import { Globe } from 'lucide-react';
import type { PartyDomainWithCreator } from '@balo/db';
import { SectionCard, SectionEmpty } from './section-states';
import { DomainRow } from './domain-row';
import { AddDomainForm } from './add-domain-form';

type PartyType = 'company' | 'agency';

interface DomainsSectionProps {
  party: PartyType;
  partyId: string;
  partyName: string;
  domains: ReadonlyArray<PartyDomainWithCreator>;
}

const COPY: Record<PartyType, { description: string; emptyTitle: string; emptyBody: string }> = {
  company: {
    description:
      'Email domains that identify your company. New signups on these can join by domain.',
    // Action-led (never bare absence copy, e.g. "No domains yet") — balo-ui.
    emptyTitle: 'Add your first domain',
    emptyBody: "Add your company's email domain so teammates can join automatically.",
  },
  agency: {
    description:
      'Email domains that identify your agency. Anyone who signs up with one joins your team.',
    emptyTitle: 'Add your first domain',
    emptyBody:
      "Add your agency's email domain so colleagues who sign up with it join your team automatically.",
  },
};

/**
 * The Domains section — the ONLY component shared by the company and agency surfaces
 * (BAL-347). Party-agnostic: it differs only in copy via the `party` prop and never
 * imports the company-only join-mode / queue components (the party-type boundary is a
 * directory boundary). Renders the loaded list (with source-aware attribution +
 * first-mention "@ {party}") or the party-aware empty invitation, then the add form.
 */
export function DomainsSection({
  party,
  partyId,
  partyName,
  domains,
}: Readonly<DomainsSectionProps>): React.JSX.Element {
  const copy = COPY[party];
  const seenCreators = new Set<string>();

  return (
    <SectionCard title="Domains" description={copy.description}>
      {domains.length === 0 ? (
        <SectionEmpty icon={Globe} title={copy.emptyTitle} body={copy.emptyBody} />
      ) : (
        <div className="flex flex-col">
          {domains.map((domain, index) => {
            const creatorId = domain.createdBy?.id ?? null;
            const firstMention = creatorId !== null && !seenCreators.has(creatorId);
            if (creatorId !== null) seenCreators.add(creatorId);
            return (
              <div key={domain.id} className={index === 0 ? undefined : 'border-border border-t'}>
                <DomainRow
                  row={domain}
                  firstMention={firstMention}
                  partyType={party}
                  partyId={partyId}
                  partyName={partyName}
                  isLast={domains.length === 1}
                />
              </div>
            );
          })}
        </div>
      )}

      <div className="border-border mt-4 border-t pt-4">
        <AddDomainForm partyType={party} partyId={partyId} />
      </div>
    </SectionCard>
  );
}
