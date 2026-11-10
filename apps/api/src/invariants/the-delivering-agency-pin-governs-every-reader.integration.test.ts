import { describe, expect, it } from 'vitest';

/**
 * INVARIANT (integration, real Postgres) — THE DELIVERING-AGENCY PIN GOVERNS EVERY READER.
 *
 * `engagements.delivering_agency_id` records which agency an engagement was delivered under,
 * once, at creation. When the expert's profile later moves to another agency, every path whose
 * subject is that engagement keeps reading the pin, so:
 *
 *   · the original agency's owner and admin still hold `manage_engagement`, still see the
 *     project in the agency lens, still get the oversight notices and still pass the
 *     credit-session visibility gate;
 *   · the new agency's owner and admin get none of those for the old work;
 *   · an engagement created after the move is pinned to the new agency, and the new agency's
 *     admin then holds `manage_engagement` over it.
 *
 * The four paths are driven through their production entry points. Only `@balo/db` is real;
 * nothing is mocked.
 */

import { randomUUID } from 'node:crypto';
import {
  agencies,
  agencyMembers,
  caseEngagementsRepository,
  creditSessionsRepository,
  creditWallets,
  db,
  eq,
  expertProfiles,
  expertsRepository,
  projectEngagementsRepository,
  usersRepository,
} from '@balo/db';
import { ENGAGEMENT_CAPABILITIES } from '@balo/shared/authz';
import { seedBookingParties } from '../test/fixtures/booking-graph.js';
import { hasEngagementCapability } from '../services/meetings/authorize-engagement-host.js';
import { resolveContext } from '../notifications/engine/resolver.js';
import { authorizeSessionExpertVisibility } from '../services/credit-session/authorize-session-expert-visibility.js';

const EXPERT_RATE_MINOR_PER_MINUTE = 500;
const FUNDED_BALANCE_MINOR = 5_000_000;
const ESTIMATED_MINUTES = 15;

interface AgencyPeople {
  readonly agencyId: string;
  readonly ownerId: string;
  readonly adminId: string;
}

async function seedUser(label: string): Promise<string> {
  const marker = randomUUID();
  const user = await usersRepository.create({
    workosId: `pin_${label}_${marker}`,
    email: `pin-${label}-${marker}@test.local`,
    firstName: label,
    lastName: 'Person',
  });
  return user.id;
}

async function seedAgency(label: string): Promise<AgencyPeople> {
  const [agency] = await db
    .insert(agencies)
    .values({ name: `Pin agency ${label} ${randomUUID()}` })
    .returning({ id: agencies.id });
  if (agency === undefined) {
    throw new Error('fixture: agency insert returned no row');
  }
  const ownerId = await seedUser(`${label}-owner`);
  const adminId = await seedUser(`${label}-admin`);
  await db.insert(agencyMembers).values([
    { agencyId: agency.id, userId: ownerId, role: 'owner' },
    { agencyId: agency.id, userId: adminId, role: 'admin' },
  ]);
  return { agencyId: agency.id, ownerId, adminId };
}

interface Scenario {
  readonly a: AgencyPeople;
  readonly b: AgencyPeople;
  readonly companyId: string;
  readonly memberUserId: string;
  readonly expertProfileId: string;
  readonly caseEngagementId: string;
  readonly projectEngagementId: string;
  readonly sessionId: string;
}

/** An expert linked to agency A, a pinned case with a credit session and a pinned project, then moved to B. */
async function seedMovedExpert(): Promise<Scenario> {
  const parties = await seedBookingParties();
  const a = await seedAgency('a');
  const b = await seedAgency('b');

  await db
    .update(expertProfiles)
    .set({ rateCents: EXPERT_RATE_MINOR_PER_MINUTE })
    .where(eq(expertProfiles.id, parties.expertProfileId));
  await expertsRepository.linkAgency(parties.expertProfileId, a.agencyId);

  const caseRow = await caseEngagementsRepository.create({
    companyId: parties.companyId,
    expertProfileId: parties.expertProfileId,
    title: 'Pin case',
    description: '<p>Pinned to agency A.</p>',
  });
  const project = await projectEngagementsRepository.create({
    companyId: parties.companyId,
    expertProfileId: parties.expertProfileId,
    pricingMethod: 'fixed',
    priceCents: 500_000,
  });

  const [wallet] = await db
    .insert(creditWallets)
    .values({ companyId: parties.companyId, balanceMinor: FUNDED_BALANCE_MINOR })
    .returning({ id: creditWallets.id });
  if (wallet === undefined) {
    throw new Error('fixture: wallet insert returned no row');
  }
  const opened = await creditSessionsRepository.open({
    walletId: wallet.id,
    companyId: parties.companyId,
    expertProfileId: parties.expertProfileId,
    initiatingMemberId: parties.memberUserId,
    estimatedMinutes: ESTIMATED_MINUTES,
    engagementId: caseRow.id,
  });
  if (!opened.ok) {
    throw new Error(`fixture: session open refused (${opened.code})`);
  }

  const moved = await expertsRepository.repointAgency(parties.expertProfileId, {
    fromAgencyId: a.agencyId,
    toAgencyId: b.agencyId,
  });
  if (!moved) {
    throw new Error('fixture: the profile did not move from agency A to agency B');
  }

  return {
    a,
    b,
    companyId: parties.companyId,
    memberUserId: parties.memberUserId,
    expertProfileId: parties.expertProfileId,
    caseEngagementId: caseRow.id,
    projectEngagementId: project.id,
    sessionId: opened.session.id,
  };
}

async function holdsManageEngagement(userId: string, caseEngagementId: string): Promise<boolean> {
  return hasEngagementCapability({ id: userId }, ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT, {
    contextType: 'case',
    contextId: caseEngagementId,
  });
}

async function noticeRecipients(s: Scenario): Promise<unknown> {
  const context = await resolveContext('engagement.cancelled', {
    correlationId: `${s.caseEngagementId}:cancelled`,
    engagementId: s.caseEngagementId,
    expertProfileId: s.expertProfileId,
  });
  return context.data.deliveringAgencyAdminUserIds;
}

async function sessionVisible(s: Scenario, userId: string): Promise<boolean> {
  const result = await authorizeSessionExpertVisibility({ sessionId: s.sessionId, userId });
  return result.ok;
}

describe('the delivering-agency pin governs every reader', () => {
  it('stamps the engagements with agency A and moves the profile to agency B', async () => {
    const s = await seedMovedExpert();

    const profile = await expertsRepository.findProfileById(s.expertProfileId);
    expect(profile?.agencyId).toBe(s.b.agencyId);
    const portfolio = await projectEngagementsRepository.listPortfolio({
      agencyId: s.a.agencyId,
    });
    expect(portfolio.map((row) => row.id)).toEqual([s.projectEngagementId]);
  });

  it("agency A's owner and admin keep all four rights over the work delivered under A", async () => {
    const s = await seedMovedExpert();

    for (const userId of [s.a.ownerId, s.a.adminId]) {
      expect(await holdsManageEngagement(userId, s.caseEngagementId)).toBe(true);
      expect(await sessionVisible(s, userId)).toBe(true);
    }

    const portfolio = await projectEngagementsRepository.listPortfolio({
      agencyId: s.a.agencyId,
    });
    expect(portfolio.map((row) => row.id)).toContain(s.projectEngagementId);

    const recipients = await noticeRecipients(s);
    expect(recipients).toEqual(expect.arrayContaining([s.a.ownerId, s.a.adminId]));
  });

  it("agency B's owner and admin get none of the four over the same work", async () => {
    const s = await seedMovedExpert();

    for (const userId of [s.b.ownerId, s.b.adminId]) {
      expect(await holdsManageEngagement(userId, s.caseEngagementId)).toBe(false);
      expect(await sessionVisible(s, userId)).toBe(false);
    }

    const portfolio = await projectEngagementsRepository.listPortfolio({
      agencyId: s.b.agencyId,
    });
    expect(portfolio.map((row) => row.id)).not.toContain(s.projectEngagementId);

    const recipients = await noticeRecipients(s);
    expect(recipients).not.toContain(s.b.ownerId);
    expect(recipients).not.toContain(s.b.adminId);
  });

  it('an engagement created after the move is pinned to agency B and B administers it', async () => {
    const s = await seedMovedExpert();

    const created = await caseEngagementsRepository.create({
      companyId: s.companyId,
      expertProfileId: s.expertProfileId,
      title: 'Created after the move',
      description: '<p>Pinned to agency B.</p>',
    });

    expect(created.deliveringAgencyId).toBe(s.b.agencyId);
    expect(await holdsManageEngagement(s.b.adminId, created.id)).toBe(true);
    expect(await holdsManageEngagement(s.a.adminId, created.id)).toBe(false);
  });
});
