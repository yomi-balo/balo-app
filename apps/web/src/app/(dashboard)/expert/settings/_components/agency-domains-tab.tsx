'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Lock } from 'lucide-react';
import type { PartyDomainWithCreator } from '@balo/db';
import { DomainsSection } from '@/components/balo/domain-join/domains-section';
import { SectionCard, SectionError, InfoNote } from '@/components/balo/domain-join/section-states';

interface AgencyDomainsTabProps {
  agencyId: string;
  partyName: string;
  /** `null` signals a load error for this tab (the page logged + degraded gracefully). */
  domains: PartyDomainWithCreator[] | null;
}

/**
 * The agency Domains tab (BAL-347) — DOMAINS ONLY, then an explicit Lock note that
 * agencies don't use join modes or request approvals (membership is decided by
 * verified email, ADR-1034). Structural party-type guarantee: this tree imports ONLY
 * `DomainsSection` (+ shared states) — it has NO import path to the company-only
 * join-mode / join-request components, so they cannot render for an agency.
 */
export function AgencyDomainsTab({
  agencyId,
  partyName,
  domains,
}: Readonly<AgencyDomainsTabProps>): React.JSX.Element {
  const router = useRouter();
  const handleRetry = useCallback(() => router.refresh(), [router]);

  if (domains === null) {
    return (
      <div className="mx-auto max-w-[620px]">
        <SectionCard
          title="Domains"
          description="Email domains that identify your agency. Anyone who signs up with one joins your team."
        >
          <SectionError label="your domains" onRetry={handleRetry} />
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[620px] flex-col gap-4">
      <DomainsSection party="agency" partyId={agencyId} partyName={partyName} domains={domains} />
      <InfoNote icon={Lock}>
        Agencies don&apos;t use join modes or request approvals. Membership is decided by verified
        email (ADR-1034): sign up with an agency domain and you&apos;re in. Manage domains above —
        everything else is automatic.
      </InfoNote>
    </div>
  );
}
