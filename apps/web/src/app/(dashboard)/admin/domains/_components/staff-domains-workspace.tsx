'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Building2, Check, ChevronLeft, Lock, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { InfoNote, SectionCard, SectionError } from '@/components/balo/section/section-states';
import type { StaffDomainRowDto, StaffPartyDto } from '../_lib/staff-domain-types';
import { buildStaffDomainRows, listDescription, memberCountLabel } from '../_lib/staff-domain-view';
import { StaffAddDomainForm } from './staff-add-domain-form';
import { StaffDomainRow } from './staff-domain-row';

interface StaffDomainsWorkspaceProps {
  party: StaffPartyDto;
  /** `null` means the read failed; the list shows its error state instead. */
  domains: readonly StaffDomainRowDto[] | null;
  canManage: boolean;
}

function emptyCopy(partyName: string, canAdd: boolean): string {
  const base = `${partyName} has no domains, so no one joins it by email domain.`;
  return canAdd ? `${base} Add one below if the customer asked for it.` : base;
}

/**
 * The staff page body: this party's active domains, the audit-reasoned remove flow, and (for
 * holders of Manage party domains) the add / reassign form. The only writes live in the three
 * staff Server Actions; this component renders their results.
 */
export function StaffDomainsWorkspace({
  party,
  domains,
  canManage,
}: Readonly<StaffDomainsWorkspaceProps>): React.JSX.Element {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [removedCount, setRemovedCount] = useState(0);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const clearStatus = useCallback((): void => setStatus(null), []);
  const handleRemoved = useCallback((message: string): void => {
    setStatus(message);
    setRemovedCount((count) => count + 1);
  }, []);

  // The removed row unmounts with focus on it; land on the status line instead of <body>.
  useEffect(() => {
    if (removedCount > 0) statusRef.current?.focus();
  }, [removedCount]);
  const retry = useCallback((): void => router.refresh(), [router]);
  const PartyIcon = party.partyType === 'company' ? Building2 : Users;
  const canAdd = canManage && !party.isPersonal;
  const rows = useMemo(
    () => (domains === null ? [] : buildStaffDomainRows(domains, party.name)),
    [domains, party.name]
  );

  let list: React.ReactNode;
  if (domains === null) {
    list = <SectionError label={`${party.name}’s domains`} onRetry={retry} />;
  } else if (rows.length === 0) {
    list = (
      <p className="text-muted-foreground text-[13.5px] leading-relaxed">
        {emptyCopy(party.name, canAdd)}
      </p>
    );
  } else {
    list = (
      <ul className="divide-border divide-y">
        {rows.map((row) => (
          <StaffDomainRow
            key={row.id}
            row={row}
            partyType={party.partyType}
            partyId={party.partyId}
            partyName={party.name}
            isLast={rows.length === 1}
            canManage={canManage}
            onBegin={clearStatus}
            onChanged={handleRemoved}
          />
        ))}
      </ul>
    );
  }

  let footer: React.ReactNode = null;
  if (canAdd) {
    footer = (
      <SectionCard
        title="Add a domain"
        description="Use this when a customer asks for another domain, such as a second country’s. Confirm they own it first."
      >
        <StaffAddDomainForm
          partyType={party.partyType}
          partyId={party.partyId}
          partyName={party.name}
          onBegin={clearStatus}
          onChanged={setStatus}
        />
      </SectionCard>
    );
  } else if (canManage) {
    footer = (
      <InfoNote icon={Lock}>
        {`${party.name} is a personal workspace, so a domain on it would never match anyone.`}
      </InfoNote>
    );
  } else {
    footer = (
      <InfoNote icon={Lock}>
        You can see these domains but not change them. Changing domains needs the Manage party
        domains permission.
      </InfoNote>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Link
        href="/admin/lookup"
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring -ml-1 inline-flex min-h-[44px] w-fit items-center gap-1 rounded-lg text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
        Back to Lookup
      </Link>

      <header className="flex items-center gap-3.5">
        <span
          aria-hidden="true"
          className="bg-primary/10 text-primary flex size-11 flex-none items-center justify-center rounded-xl"
        >
          <PartyIcon className="size-5" />
        </span>
        <div className="min-w-0">
          <h1 className="text-foreground text-[22px] font-semibold tracking-tight [overflow-wrap:anywhere]">
            {`${party.name} domains`}
          </h1>
          <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-2 text-[13px]">
            <Badge variant="outline">{party.partyType === 'company' ? 'Company' : 'Agency'}</Badge>
            <span>{memberCountLabel(party.memberCount)}</span>
          </div>
        </div>
      </header>

      <SectionCard
        title="Active domains"
        description={listDescription(party.partyType, party.name)}
      >
        {list}
      </SectionCard>

      <div aria-live="polite">
        {status !== null && (
          <p
            ref={statusRef}
            tabIndex={-1}
            className="text-success-strong flex items-center gap-1.5 text-sm font-medium outline-none"
          >
            <Check className="size-4 flex-none" aria-hidden="true" />
            {status}
          </p>
        )}
      </div>

      {footer}
    </div>
  );
}
