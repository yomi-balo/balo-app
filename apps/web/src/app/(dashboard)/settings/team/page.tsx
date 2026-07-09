import { notFound, redirect } from 'next/navigation';
import {
  partyDomainsRepository,
  companiesRepository,
  auditEventsRepository,
  partyJoinRequestsRepository,
  usersRepository,
} from '@balo/db';
import { getCurrentUser } from '@/lib/auth/session';
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import { log } from '@/lib/logging';
import { MembersAccessClient } from './_components/members-access-client';

/**
 * Company "Members & access" (BAL-347) — the THREE-section admin surface (Domains +
 * Join mode + Join-request queue). Gating order: sign-in → `MANAGE_MEMBERS` on the
 * session company → `notFound()` for a PERSONAL workspace (the whole company surface
 * is dormant/built-not-live in v1 while every company is personal). Data is loaded in
 * a `Promise.all` and assembled into a PII-free DTO for the client shell.
 */
export default async function MembersAccessPage(): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  const companyId = user.companyId;

  const allowed = await hasCapability(user, CAPABILITIES.MANAGE_MEMBERS, { companyId });
  if (!allowed) {
    notFound();
  }

  const company = await companiesRepository.findById(companyId);
  // Personal workspaces have no member-management surface (BAL-347 decision). The
  // same row also carries `domainJoinMode` for the join-mode section below.
  if (company === undefined || company.isPersonal) {
    notFound();
  }

  try {
    const [domains, latestChange, pending, resolved] = await Promise.all([
      partyDomainsRepository.listByPartyWithCreator('company', companyId),
      auditEventsRepository.findLatestByEntityAndAction({
        entityType: 'company',
        entityId: companyId,
        action: 'company.join_mode_changed',
      }),
      partyJoinRequestsRepository.listPendingByParty('company', companyId),
      partyJoinRequestsRepository.listResolvedByParty('company', companyId),
    ]);

    let lastChangedByName: string | null = null;
    if (latestChange?.actorUserId) {
      const [changer] = await usersRepository.findNamesByIds([latestChange.actorUserId]);
      const name = changer
        ? [changer.firstName, changer.lastName].filter(Boolean).join(' ').trim()
        : '';
      lastChangedByName = name.length > 0 ? name : null;
    }

    return (
      <MembersAccessClient
        dto={{
          companyId,
          companyName: company.name,
          domains,
          mode: company.domainJoinMode,
          lastChangedByName,
          lastChangedAt: latestChange?.createdAt ?? null,
          pending,
          resolved,
        }}
      />
    );
  } catch (error) {
    log.error('Failed to load members & access', {
      userId: user.id,
      companyId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}
