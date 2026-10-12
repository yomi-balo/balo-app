import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { partyDomainsStaffRepository, type PartyType, type StaffPartyDomainRow } from '@balo/db';
import { EntityCrumb } from '@/components/layout/breadcrumb-context';
import { getCurrentUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { log } from '@/lib/logging';
import { StaffDomainsWorkspace } from '../../_components/staff-domains-workspace';
import type { StaffDomainRowDto } from '../../_lib/staff-domain-types';
import { personName } from '../../_lib/staff-domain-view';

/**
 * The Balo-staff domains page for one company or agency.
 *
 * Reachability is gated on `VIEW_PLATFORM_ADMIN` (same as Lookup, which links here); anyone else
 * gets a 404. Write controls render only for holders of `MANAGE_PARTY_DOMAINS`, and every Server
 * Action re-checks that capability against the live row, so this render-time read is cosmetic.
 *
 * The browser receives rows projected to `StaffDomainRowDto` (a display name, ISO dates), never
 * the repository rows.
 */

export const metadata: Metadata = {
  title: 'Party domains — Balo',
  robots: { index: false, follow: false },
};

interface AdminPartyDomainsPageProps {
  params: Promise<{ partyType: string; partyId: string }>;
}

const partyTypeSchema = z.enum(['company', 'agency']);

function toRowDto(row: StaffPartyDomainRow): StaffDomainRowDto {
  return {
    id: row.id,
    domain: row.domain,
    addedVia: row.addedVia,
    createdAt: row.createdAt.toISOString(),
    createdByName: personName(row.createdBy),
    reason: row.reason,
  };
}

async function loadDomains(
  partyType: PartyType,
  partyId: string
): Promise<StaffDomainRowDto[] | null> {
  try {
    const rows = await partyDomainsStaffRepository.listForStaff(partyType, partyId);
    return rows.map(toRowDto);
  } catch (error) {
    log.error('Failed to load party domains for staff', {
      partyType,
      partyId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return null;
  }
}

export default async function AdminPartyDomainsPage({
  params,
}: Readonly<AdminPartyDomainsPageProps>): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)) {
    notFound();
  }

  const { partyType: rawPartyType, partyId: rawPartyId } = await params;
  const parsedType = partyTypeSchema.safeParse(rawPartyType);
  const parsedId = z.uuid().safeParse(rawPartyId);
  if (!parsedType.success || !parsedId.success) {
    notFound();
  }

  const party = await partyDomainsStaffRepository.getPartyForStaff(parsedType.data, parsedId.data);
  if (party === undefined) {
    notFound();
  }

  const domains = await loadDomains(party.partyType, party.partyId);
  const canManage = hasPlatformCapability(user, PLATFORM_CAPABILITIES.MANAGE_PARTY_DOMAINS);

  return (
    <>
      <EntityCrumb label={`${party.name} domains`} />
      <StaffDomainsWorkspace
        party={{
          partyType: party.partyType,
          partyId: party.partyId,
          name: party.name,
          isPersonal: party.isPersonal,
          memberCount: party.memberCount,
        }}
        domains={domains}
        canManage={canManage}
      />
    </>
  );
}
