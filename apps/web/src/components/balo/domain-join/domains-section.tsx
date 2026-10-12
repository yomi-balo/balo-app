'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { PartyDomainForSettings, PartyType } from '@balo/db';
import { SectionCard, SectionError } from '../section/section-states';
import { DomainRow } from './domain-row';

interface DomainsSectionProps {
  party: PartyType;
  partyName: string;
  /** `null` signals a load error (the page logged it and degraded to this section's error state). */
  domains: ReadonlyArray<PartyDomainForSettings> | null;
}

const DESCRIPTION: Record<PartyType, string> = {
  company:
    'Email domains that identify your company. Teammates who sign up with a verified email on one of these can join, based on your join setting below.',
  agency:
    'Email domains that identify your agency. Anyone who signs up with a verified email on one of these joins your team automatically.',
};

const SUPPORT_MAILTO = 'mailto:support@getbalo.com';

/**
 * The read-only Domains section shared by the company and agency surfaces. Balo staff are the
 * only writers (BAL-594), so there is no add or remove control here: a zero-domain party renders
 * nothing (a party that cannot act on an empty list has nothing to invite), a load error renders
 * the error state with a retry, and otherwise the list ends with a "contact support" line for
 * anyone who needs another domain.
 */
export function DomainsSection({
  party,
  partyName,
  domains,
}: Readonly<DomainsSectionProps>): React.JSX.Element | null {
  const router = useRouter();
  const handleRetry = useCallback(() => router.refresh(), [router]);

  if (domains === null) {
    return (
      <SectionCard title="Domains" description={DESCRIPTION[party]}>
        <SectionError label="your domains" onRetry={handleRetry} />
      </SectionCard>
    );
  }
  if (domains.length === 0) return null;

  const seenNames = new Set<string>();
  return (
    <SectionCard title="Domains" description={DESCRIPTION[party]}>
      <div className="flex flex-col">
        {domains.map((domain, index) => {
          const name = domain.attribution.kind === 'signup' ? domain.attribution.name : null;
          const firstMention = name !== null && !seenNames.has(name);
          if (name !== null) seenNames.add(name);
          return (
            <div key={domain.id} className={index === 0 ? undefined : 'border-border border-t'}>
              <DomainRow row={domain} firstMention={firstMention} partyName={partyName} />
            </div>
          );
        })}
      </div>
      <p className="text-muted-foreground border-border mt-4 border-t pt-4 text-[13px] leading-relaxed">
        Using more than one domain?{' '}
        <a
          href={SUPPORT_MAILTO}
          className="text-primary focus-visible:ring-ring rounded font-semibold hover:underline focus-visible:ring-2 focus-visible:outline-none"
        >
          Contact Balo support
        </a>{' '}
        and we&apos;ll add it for you.
      </p>
    </SectionCard>
  );
}
