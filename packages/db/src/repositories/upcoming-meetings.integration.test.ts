/**
 * BAL-566 — `upcomingMeetingsRepository` against real Postgres (Testcontainers, rollback per test).
 *
 * THE SECURITY-CRITICAL CASES are the per-arm "member with permission" tests (every listed row
 * re-checked through its web gate's OWN finders) and the fold/tenancy describe's forged-context
 * case (a company's lower-tier context attached beneath ANOTHER company's primary must never put
 * that meeting on its dashboard).
 *
 * R1 fixtures: a live member (the member with permission), a REMOVED former member (soft-deleted
 * membership — the unbuildable "member without permission" is replaced by this, per the ruling),
 * a member of another company, the delivering expert, an agency colleague, and a stranger.
 *
 * Every date is derived from `Date.now()` at CALL time — never a hardcoded calendar date.
 */
import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { resolveCompanyParticipation, type CompanyRoleLookup } from '@balo/shared/authz';
import { db } from '../client';
import {
  caseEngagements,
  conversationContexts,
  conversations,
  engagements,
  expertProfiles,
  meetingContexts,
  meetings,
  projectEngagements,
  projectRequests,
  requestExpertRelationships,
  users,
} from '../schema';
import {
  agencyFactory,
  agencyMemberFactory,
  caseEngagementFactory,
  companyFactory,
  companyMemberFactory,
  engagementFactory,
  expertDraftFactory,
  expertFactory,
  meetingFactory,
  projectRequestFactory,
  requestExpertRelationshipFactory,
  userFactory,
} from '../test/factories';
import { caseEngagementsRepository } from './case-engagements';
import { conversationsRepository } from './conversations';
import { engagementsRepository } from './engagements';
import { partyMembershipsRepository } from './party-memberships';
import { projectEngagementsRepository } from './project-engagements';
import { projectRequestsRepository } from './project-requests';
import { requestExpertRelationshipsRepository } from './request-expert-relationships';
import {
  MAX_UPCOMING_RANGE_DAYS,
  upcomingMeetingsRepository,
  UpcomingMeetingsRangeTooWideError,
  type CompanyUpcomingMeeting,
  type UpcomingArm,
} from './upcoming-meetings';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

interface UpcomingRange {
  readonly rangeStart: Date;
  readonly rangeEnd: Date;
}

/** The dashboard's window (now − 2h .. now + 14d), from the clock at CALL time. */
function upNextRange(): UpcomingRange {
  const now = Date.now();
  return { rangeStart: new Date(now - 2 * HOUR_MS), rangeEnd: new Date(now + 14 * DAY_MS) };
}

function inWindow(offsetHours = 1): { scheduledStart: Date; scheduledEnd: Date } {
  const start = Date.now() + offsetHours * HOUR_MS;
  return { scheduledStart: new Date(start), scheduledEnd: new Date(start + HOUR_MS) };
}

/** THE GATE ORACLE — the exact lookup shape every production caller passes. */
const lookupCompanyRole: CompanyRoleLookup = (companyId, actorId) =>
  partyMembershipsRepository.getMemberRole('company', companyId, actorId);

async function listForCompany(companyId: string): Promise<CompanyUpcomingMeeting[]> {
  return upcomingMeetingsRepository.listForCompany({ companyId, ...upNextRange() });
}

async function listIds(companyId: string): Promise<string[]> {
  return (await listForCompany(companyId)).map((row) => row.meetingId);
}

// ── The R1 world ──────────────────────────────────────────────────────────────────────────────

interface Outsider {
  readonly label: string;
  readonly userId: string;
  readonly personalCompanyId: string;
}

interface World {
  readonly companyAId: string;
  readonly companyBId: string;
  readonly memberAUserId: string;
  readonly removedAUserId: string;
  readonly memberBUserId: string;
  readonly expertProfileId: string;
  /** The delivering expert, the agency colleague and the stranger — each with a personal company. */
  readonly outsiders: readonly Outsider[];
}

async function personalCompanyFor(userId: string): Promise<string> {
  const company = await companyFactory({ isPersonal: true });
  await companyMemberFactory({ companyId: company.id, userId, role: 'owner' });
  return company.id;
}

async function seedWorld(): Promise<World> {
  const companyA = await companyFactory();
  const companyB = await companyFactory();

  const memberA = await userFactory();
  await companyMemberFactory({ companyId: companyA.id, userId: memberA.id, role: 'member' });
  const removedA = await userFactory();
  await companyMemberFactory({
    companyId: companyA.id,
    userId: removedA.id,
    role: 'member',
    deletedAt: new Date(),
  });
  const memberB = await userFactory();
  await companyMemberFactory({ companyId: companyB.id, userId: memberB.id, role: 'member' });

  const agency = await agencyFactory();
  const expert = await expertFactory({ type: 'agency' });
  // No factory override sets `agency_id`; the fixture write is the direct update (plan §8.2).
  await db
    .update(expertProfiles)
    .set({ agencyId: agency.id })
    .where(eq(expertProfiles.id, expert.id));
  await agencyMemberFactory({ agencyId: agency.id, userId: expert.userId, role: 'owner' });
  const colleague = await userFactory();
  await agencyMemberFactory({ agencyId: agency.id, userId: colleague.id, role: 'expert' });
  const stranger = await userFactory();

  return {
    companyAId: companyA.id,
    companyBId: companyB.id,
    memberAUserId: memberA.id,
    removedAUserId: removedA.id,
    memberBUserId: memberB.id,
    expertProfileId: expert.id,
    outsiders: [
      {
        label: 'delivering expert',
        userId: expert.userId,
        personalCompanyId: await personalCompanyFor(expert.userId),
      },
      {
        label: 'agency colleague',
        userId: colleague.id,
        personalCompanyId: await personalCompanyFor(colleague.id),
      },
      {
        label: 'stranger',
        userId: stranger.id,
        personalCompanyId: await personalCompanyFor(stranger.id),
      },
    ],
  };
}

/** The lighter seed for exclusion cases, which need no actors. */
async function seedCompanyAndExpert(): Promise<{ companyId: string; expertProfileId: string }> {
  const company = await companyFactory();
  const expert = await expertDraftFactory();
  return { companyId: company.id, expertProfileId: expert.id };
}

// ── Per-arm specs ─────────────────────────────────────────────────────────────────────────────

interface ArmFixture {
  /** The parent row the context names. */
  readonly contextId: string;
  readonly projectRequestId: string | null;
  readonly expertProfileId: string | null;
}

interface SeededArmMeeting {
  readonly fixture: ArmFixture;
  readonly meetingId: string;
}

interface Exclusion {
  readonly label: string;
  readonly exclude: (seeded: SeededArmMeeting, range: UpcomingRange) => Promise<void>;
}

interface ArmSpec {
  readonly arm: UpcomingArm;
  readonly seedParent: (companyId: string, expertProfileId: string) => Promise<ArmFixture>;
  readonly softDeleteParent: (fixture: ArmFixture) => Promise<void>;
  /** Re-checks a listed row through the web gate's OWN finders (plan §2 / §8.2). */
  readonly assertPassesOwnGate: (row: CompanyUpcomingMeeting, companyId: string) => Promise<void>;
  readonly armExclusions: readonly Exclusion[];
}

async function seedArmMeeting(
  spec: ArmSpec,
  companyId: string,
  expertProfileId: string,
  offsetHours = 1
): Promise<SeededArmMeeting> {
  const fixture = await spec.seedParent(companyId, expertProfileId);
  const { meeting } = await meetingFactory({
    contexts: [{ contextType: spec.arm, contextId: fixture.contextId }],
    values: inWindow(offsetHours),
  });
  return { fixture, meetingId: meeting.id };
}

async function softDeleteEngagement(fixture: ArmFixture): Promise<void> {
  await db
    .update(engagements)
    .set({ deletedAt: new Date() })
    .where(eq(engagements.id, fixture.contextId));
}

async function softDeleteRequest(projectRequestId: string | null): Promise<void> {
  if (projectRequestId === null) throw new Error('fixture has no project request');
  await db
    .update(projectRequests)
    .set({ deletedAt: new Date() })
    .where(eq(projectRequests.id, projectRequestId));
}

const CASE_SPEC: ArmSpec = {
  arm: 'case',
  seedParent: async (companyId, expertProfileId) => {
    const { engagement } = await caseEngagementFactory({ companyId, expertProfileId });
    return { contextId: engagement.id, projectRequestId: null, expertProfileId };
  },
  softDeleteParent: softDeleteEngagement,
  // `resolveCaseAccess` → `authorizeEngagementConversation` (live engagement in the company, live
  // thread) → `load-case.ts`'s `findByEngagementId` coherence check.
  assertPassesOwnGate: async (row, companyId) => {
    const engagement = await engagementsRepository.findById(row.contextId);
    expect(engagement?.companyId).toBe(companyId);
    expect(await caseEngagementsRepository.findByEngagementId(row.contextId)).toBeDefined();
    expect(
      await conversationsRepository.findByContext({
        contextType: 'engagement',
        contextId: row.contextId,
      })
    ).toBeDefined();
    expect(row.projectRequestId).toBeNull();
  },
  armExclusions: [
    {
      label: 'a live engagement whose case_engagements child is soft-deleted',
      exclude: async ({ fixture }) => {
        await db
          .update(caseEngagements)
          .set({ deletedAt: new Date() })
          .where(eq(caseEngagements.engagementId, fixture.contextId));
      },
    },
    {
      label: 'a case whose thread conversation_contexts row is soft-deleted',
      exclude: async ({ fixture }) => {
        await db
          .update(conversationContexts)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(conversationContexts.contextType, 'engagement'),
              eq(conversationContexts.contextId, fixture.contextId)
            )
          );
      },
    },
    {
      label: 'a case whose thread conversation is soft-deleted',
      exclude: async ({ fixture }) => {
        const thread = await conversationsRepository.findByContext({
          contextType: 'engagement',
          contextId: fixture.contextId,
        });
        if (thread === undefined) throw new Error('case fixture has no thread');
        await db
          .update(conversations)
          .set({ deletedAt: new Date() })
          .where(eq(conversations.id, thread.id));
      },
    },
  ],
};

const KICKOFF_SPEC: ArmSpec = {
  arm: 'project_kickoff',
  seedParent: async (companyId, expertProfileId) => {
    const { engagement } = await engagementFactory({ companyId, expertProfileId });
    return { contextId: engagement.id, projectRequestId: null, expertProfileId };
  },
  softDeleteParent: softDeleteEngagement,
  // `/engagements/[id]`: `findWithMilestones` (live project WITH its child) + the lens's
  // `companyId` equality.
  assertPassesOwnGate: async (row, companyId) => {
    const project = await projectEngagementsRepository.findWithMilestones(row.contextId);
    expect(project).toBeDefined();
    expect(project?.companyId).toBe(companyId);
    expect(row.projectRequestId).toBeNull();
  },
  armExclusions: [
    {
      label: 'a project engagement whose project_engagements child is soft-deleted',
      exclude: async ({ fixture }) => {
        await db
          .update(projectEngagements)
          .set({ deletedAt: new Date() })
          .where(eq(projectEngagements.engagementId, fixture.contextId));
      },
    },
  ],
};

const DISCOVERY_SPEC: ArmSpec = {
  arm: 'project_discovery',
  seedParent: async (companyId, expertProfileId) => {
    const request = await projectRequestFactory({ companyId, expertProfileId });
    return { contextId: request.id, projectRequestId: request.id, expertProfileId };
  },
  softDeleteParent: (fixture) => softDeleteRequest(fixture.contextId),
  // `/projects/[requestId]`: `findByIdWithRelations` (live request) + the lens's `companyId`
  // equality. The link target is the request itself.
  assertPassesOwnGate: async (row, companyId) => {
    const request = await projectRequestsRepository.findByIdWithRelations(row.contextId);
    expect(request?.companyId).toBe(companyId);
    expect(row.projectRequestId).toBe(row.contextId);
  },
  armExclusions: [],
};

const INTERACTION_SPEC: ArmSpec = {
  arm: 'request_interaction',
  seedParent: async (companyId, expertProfileId) => {
    const request = await projectRequestFactory({ companyId, expertProfileId });
    const { relationship } = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId,
    });
    return { contextId: relationship.id, projectRequestId: request.id, expertProfileId };
  },
  softDeleteParent: async (fixture) => {
    await db
      .update(requestExpertRelationships)
      .set({ deletedAt: new Date() })
      .where(eq(requestExpertRelationships.id, fixture.contextId));
  },
  // The context names the RELATIONSHIP; the gate and the link target are its live request.
  assertPassesOwnGate: async (row, companyId) => {
    const relationship = await requestExpertRelationshipsRepository.findById(row.contextId);
    expect(relationship).toBeDefined();
    expect(relationship?.projectRequestId).toBe(row.projectRequestId);
    if (row.projectRequestId === null) throw new Error('intro row carries no projectRequestId');
    const request = await projectRequestsRepository.findByIdWithRelations(row.projectRequestId);
    expect(request?.companyId).toBe(companyId);
  },
  armExclusions: [
    {
      label: 'a live relationship on a soft-deleted request',
      exclude: ({ fixture }) => softDeleteRequest(fixture.projectRequestId),
    },
  ],
};

const COMMON_EXCLUSIONS: readonly Exclusion[] = [
  {
    label: 'a soft-deleted meeting',
    exclude: async ({ meetingId }) => {
      await db.update(meetings).set({ deletedAt: new Date() }).where(eq(meetings.id, meetingId));
    },
  },
  {
    label: 'a soft-deleted meeting_contexts row',
    exclude: async ({ meetingId }) => {
      await db
        .update(meetingContexts)
        .set({ deletedAt: new Date() })
        .where(eq(meetingContexts.meetingId, meetingId));
    },
  },
  {
    label: 'a cancelled meeting',
    exclude: async ({ meetingId }) => {
      await db.update(meetings).set({ status: 'cancelled' }).where(eq(meetings.id, meetingId));
    },
  },
  {
    label: 'an ended meeting',
    exclude: async ({ meetingId }) => {
      await db.update(meetings).set({ status: 'ended' }).where(eq(meetings.id, meetingId));
    },
  },
  {
    label: 'a meeting starting exactly at rangeEnd (half-open window)',
    exclude: async ({ meetingId }, range) => {
      await db
        .update(meetings)
        .set({
          scheduledStart: range.rangeEnd,
          scheduledEnd: new Date(range.rangeEnd.getTime() + HOUR_MS),
        })
        .where(eq(meetings.id, meetingId));
    },
  },
  {
    label: 'a meeting that ended exactly at rangeStart',
    exclude: async ({ meetingId }, range) => {
      await db
        .update(meetings)
        .set({
          scheduledStart: new Date(range.rangeStart.getTime() - HOUR_MS),
          scheduledEnd: range.rangeStart,
        })
        .where(eq(meetings.id, meetingId));
    },
  },
];

const ARM_SPECS: readonly ArmSpec[] = [CASE_SPEC, KICKOFF_SPEC, DISCOVERY_SPEC, INTERACTION_SPEC];

describe.each(ARM_SPECS)('upcomingMeetingsRepository.listForCompany — $arm arm', (spec) => {
  it('member with permission: participates, lists EXACTLY company A’s meeting, and the row passes its own gate', async () => {
    const world = await seedWorld();
    const own = await seedArmMeeting(spec, world.companyAId, world.expertProfileId);
    const other = await seedArmMeeting(spec, world.companyBId, world.expertProfileId);

    await expect(
      resolveCompanyParticipation(world.companyAId, world.memberAUserId, lookupCompanyRole)
    ).resolves.toBe('participant');

    const rows = await listForCompany(world.companyAId);

    expect(rows.map((row) => row.meetingId)).toEqual([own.meetingId]);
    expect(rows.map((row) => row.meetingId)).not.toContain(other.meetingId);
    const [row] = rows;
    if (row === undefined) throw new Error('expected exactly one row');
    expect(row).toMatchObject({
      meetingId: own.meetingId,
      status: 'scheduled',
      contextType: spec.arm,
      contextId: own.fixture.contextId,
      projectRequestId: own.fixture.projectRequestId,
      expertProfileId: own.fixture.expertProfileId,
      owningRowFound: true,
    });
    await spec.assertPassesOwnGate(row, world.companyAId);
  });

  it('removed former member: not_a_member — the loader’s omit branch — while the live member still participates', async () => {
    const world = await seedWorld();
    await seedArmMeeting(spec, world.companyAId, world.expertProfileId);

    await expect(
      resolveCompanyParticipation(world.companyAId, world.removedAUserId, lookupCompanyRole)
    ).resolves.toBe('not_a_member');
    await expect(
      resolveCompanyParticipation(world.companyAId, world.memberAUserId, lookupCompanyRole)
    ).resolves.toBe('participant');
  });

  it('member of another company: not a member of A, and company B’s list is exactly B’s meeting', async () => {
    const world = await seedWorld();
    const own = await seedArmMeeting(spec, world.companyAId, world.expertProfileId);
    const other = await seedArmMeeting(spec, world.companyBId, world.expertProfileId);

    await expect(
      resolveCompanyParticipation(world.companyAId, world.memberBUserId, lookupCompanyRole)
    ).resolves.toBe('not_a_member');
    await expect(
      resolveCompanyParticipation(world.companyBId, world.memberBUserId, lookupCompanyRole)
    ).resolves.toBe('participant');

    const idsB = await listIds(world.companyBId);
    expect(idsB).toEqual([other.meetingId]);
    expect(idsB).not.toContain(own.meetingId);
  });

  it('delivering expert, agency colleague, stranger: none participates in A, and each own personal company lists nothing', async () => {
    const world = await seedWorld();
    const own = await seedArmMeeting(spec, world.companyAId, world.expertProfileId);

    expect(world.outsiders.map((outsider) => outsider.label)).toEqual([
      'delivering expert',
      'agency colleague',
      'stranger',
    ]);
    for (const outsider of world.outsiders) {
      await expect(
        resolveCompanyParticipation(world.companyAId, outsider.userId, lookupCompanyRole)
      ).resolves.toBe('not_a_member');
      // Non-vacuity: the same lookup DOES see each outsider's own membership.
      await expect(
        resolveCompanyParticipation(outsider.personalCompanyId, outsider.userId, lookupCompanyRole)
      ).resolves.toBe('participant');
      expect(await listIds(outsider.personalCompanyId)).toEqual([]);
    }
    // Control: the meeting really is listed — for its own company.
    expect(await listIds(world.companyAId)).toEqual([own.meetingId]);
  });

  const exclusions: readonly Exclusion[] = [
    {
      label: 'a soft-deleted parent row',
      exclude: ({ fixture }) => spec.softDeleteParent(fixture),
    },
    ...COMMON_EXCLUSIONS,
    ...spec.armExclusions,
  ];

  it.each(exclusions)('excludes $label, and still lists the live control', async ({ exclude }) => {
    const { companyId, expertProfileId } = await seedCompanyAndExpert();
    const range = upNextRange();
    const control = await seedArmMeeting(spec, companyId, expertProfileId);
    const excluded = await seedArmMeeting(spec, companyId, expertProfileId);

    // Precondition: both are listed before the exclusion is applied.
    const before = await upcomingMeetingsRepository.listForCompany({ companyId, ...range });
    expect(before.map((row) => row.meetingId).sort(compareStrings)).toEqual(
      [control.meetingId, excluded.meetingId].sort(compareStrings)
    );

    await exclude(excluded, range);

    const after = await upcomingMeetingsRepository.listForCompany({ companyId, ...range });
    expect(after.map((row) => row.meetingId)).toEqual([control.meetingId]);
  });
});

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

describe('upcomingMeetingsRepository.listForCompany — fold and tenancy', () => {
  it('discovery + kickoff on ONE meeting (both company A) folds to ONE project_kickoff row', async () => {
    const { companyId, expertProfileId } = await seedCompanyAndExpert();
    const request = await projectRequestFactory({ companyId, expertProfileId });
    const { engagement } = await engagementFactory({
      companyId,
      expertProfileId,
      projectValues: { projectRequestId: request.id },
    });
    const { meeting } = await meetingFactory({
      contexts: [
        { contextType: 'project_discovery', contextId: request.id },
        { contextType: 'project_kickoff', contextId: engagement.id },
      ],
      values: inWindow(),
    });

    const rows = await listForCompany(companyId);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      meetingId: meeting.id,
      contextType: 'project_kickoff',
      contextId: engagement.id,
      projectRequestId: null,
      expertProfileId,
      owningRowFound: true,
    });
  });

  it('discovery + intro on ONE meeting is ambiguous and OMITTED, while a control meeting is listed', async () => {
    const { companyId, expertProfileId } = await seedCompanyAndExpert();
    const request = await projectRequestFactory({ companyId, expertProfileId });
    const { relationship } = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId,
    });
    const { meeting: ambiguous } = await meetingFactory({
      contexts: [
        { contextType: 'project_discovery', contextId: request.id },
        { contextType: 'request_interaction', contextId: relationship.id },
      ],
      values: inWindow(),
    });
    const control = await seedArmMeeting(DISCOVERY_SPEC, companyId, expertProfileId, 2);

    const ids = await listIds(companyId);

    expect(ids).toEqual([control.meetingId]);
    expect(ids).not.toContain(ambiguous.id);
  });

  /**
   * ⚠⚠ THE FORGED-CONTEXT CASE (mandatory, orchestrator ruling 1). Company A attaches its OWN
   * lower-tier discovery context beneath company B's case meeting. Step 1 reaches that meeting
   * through A's own request — but the fold's winner is B's case, which is not A's, so step 3 must
   * OMIT it for A. B still sees its meeting, as its case.
   */
  it('a company-A discovery context forged beneath company B’s case meeting is OMITTED for A and still listed for B', async () => {
    const companyA = await companyFactory();
    const companyB = await companyFactory();
    const expert = await expertDraftFactory();
    const bCase = await caseEngagementFactory({
      companyId: companyB.id,
      expertProfileId: expert.id,
    });
    const aRequest = await projectRequestFactory({
      companyId: companyA.id,
      expertProfileId: expert.id,
    });
    const { meeting: forged } = await meetingFactory({
      contexts: [
        { contextType: 'case', contextId: bCase.engagement.id },
        { contextType: 'project_discovery', contextId: aRequest.id },
      ],
      values: inWindow(3),
    });
    const aControl = await seedArmMeeting(DISCOVERY_SPEC, companyA.id, expert.id, 1);

    const rowsA = await listForCompany(companyA.id);
    expect(rowsA.map((row) => row.meetingId)).toEqual([aControl.meetingId]);
    expect(rowsA.map((row) => row.meetingId)).not.toContain(forged.id);
    expect(rowsA.map((row) => row.contextId)).not.toContain(bCase.engagement.id);

    const rowsB = await listForCompany(companyB.id);
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]).toMatchObject({
      meetingId: forged.id,
      contextType: 'case',
      contextId: bCase.engagement.id,
      projectRequestId: null,
      expertProfileId: expert.id,
    });
  });

  it('lists a call already running inside the 2h lookback, and every non-terminal status', async () => {
    const { companyId, expertProfileId } = await seedCompanyAndExpert();
    const running = await seedArmMeeting(CASE_SPEC, companyId, expertProfileId);
    const now = Date.now();
    await db
      .update(meetings)
      .set({
        status: 'in_progress',
        scheduledStart: new Date(now - 90 * 60_000),
        scheduledEnd: new Date(now - 30 * 60_000),
      })
      .where(eq(meetings.id, running.meetingId));
    const waiting = await seedArmMeeting(CASE_SPEC, companyId, expertProfileId, 1);
    await db
      .update(meetings)
      .set({ status: 'waiting_for_participants' })
      .where(eq(meetings.id, waiting.meetingId));
    const scheduled = await seedArmMeeting(CASE_SPEC, companyId, expertProfileId, 2);

    const rows = await listForCompany(companyId);

    expect(rows.map((row) => row.meetingId)).toEqual([
      running.meetingId,
      waiting.meetingId,
      scheduled.meetingId,
    ]);
    expect(rows.map((row) => row.status)).toEqual([
      'in_progress',
      'waiting_for_participants',
      'scheduled',
    ]);
  });

  it('orders mixed arms by scheduled_start, then meetings.id', async () => {
    const { companyId, expertProfileId } = await seedCompanyAndExpert();
    const sharedStart = inWindow(5);
    const earlier = await seedArmMeeting(INTERACTION_SPEC, companyId, expertProfileId, 2);
    const tieA = await seedArmMeeting(KICKOFF_SPEC, companyId, expertProfileId);
    const tieB = await seedArmMeeting(DISCOVERY_SPEC, companyId, expertProfileId);
    await db.update(meetings).set(sharedStart).where(eq(meetings.id, tieA.meetingId));
    await db.update(meetings).set(sharedStart).where(eq(meetings.id, tieB.meetingId));

    const rows = await listForCompany(companyId);

    const tied = [tieA.meetingId, tieB.meetingId].sort(compareStrings);
    expect(rows.map((row) => row.meetingId)).toEqual([earlier.meetingId, ...tied]);
    expect(rows.map((row) => row.contextType)).toHaveLength(3);
  });

  it('a match-routed discovery request (no expert) is listed with expertProfileId null', async () => {
    const { companyId } = await seedCompanyAndExpert();
    const request = await projectRequestFactory({
      companyId,
      sendTo: 'match',
      expertProfileId: null,
    });
    const { meeting } = await meetingFactory({
      contexts: [{ contextType: 'project_discovery', contextId: request.id }],
      values: inWindow(),
    });

    const rows = await listForCompany(companyId);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      meetingId: meeting.id,
      contextType: 'project_discovery',
      projectRequestId: request.id,
      expertProfileId: null,
    });
  });

  it('never lists a package_session primary, even when a company discovery context rides beneath it', async () => {
    const { companyId, expertProfileId } = await seedCompanyAndExpert();
    const request = await projectRequestFactory({ companyId, expertProfileId });
    const { engagement } = await engagementFactory({ companyId, expertProfileId });
    const { meeting } = await meetingFactory({
      contexts: [
        { contextType: 'package_session', contextId: engagement.id },
        { contextType: 'project_discovery', contextId: request.id },
      ],
      values: inWindow(),
    });
    const control = await seedArmMeeting(CASE_SPEC, companyId, expertProfileId, 2);

    const ids = await listIds(companyId);

    expect(ids).toEqual([control.meetingId]);
    expect(ids).not.toContain(meeting.id);
  });

  it('throws UpcomingMeetingsRangeTooWideError for a span over MAX_UPCOMING_RANGE_DAYS', async () => {
    const { companyId } = await seedCompanyAndExpert();
    const rangeStart = new Date();
    await expect(
      upcomingMeetingsRepository.listForCompany({
        companyId,
        rangeStart,
        rangeEnd: new Date(rangeStart.getTime() + MAX_UPCOMING_RANGE_DAYS * DAY_MS + 1),
      })
    ).rejects.toBeInstanceOf(UpcomingMeetingsRangeTooWideError);
  });

  it('a company with no cases, projects or requests lists []', async () => {
    const { companyId, expertProfileId } = await seedCompanyAndExpert();
    // Another company's meeting exists, so `[]` is not merely an empty database.
    const elsewhere = await seedCompanyAndExpert();
    const other = await seedArmMeeting(CASE_SPEC, elsewhere.companyId, expertProfileId);

    expect(await listIds(companyId)).toEqual([]);
    expect(await listIds(elsewhere.companyId)).toEqual([other.meetingId]);
  });
});

describe('upcomingMeetingsRepository.findTitles', () => {
  it('returns live case titles; a soft-deleted engagement, a soft-deleted child and a non-case id are absent', async () => {
    const live = await caseEngagementFactory({ caseValues: { title: 'Flow debugging' } });
    const deletedParent = await caseEngagementFactory({ caseValues: { title: 'Gone parent' } });
    await softDeleteEngagement({
      contextId: deletedParent.engagement.id,
      projectRequestId: null,
      expertProfileId: null,
    });
    const deletedChild = await caseEngagementFactory({ caseValues: { title: 'Gone child' } });
    await db
      .update(caseEngagements)
      .set({ deletedAt: new Date() })
      .where(eq(caseEngagements.engagementId, deletedChild.engagement.id));
    const { engagement: project } = await engagementFactory();

    const titles = await upcomingMeetingsRepository.findTitles({
      caseEngagementIds: [
        live.engagement.id,
        deletedParent.engagement.id,
        deletedChild.engagement.id,
        project.id,
      ],
      kickoffEngagementIds: [],
      projectRequestIds: [],
    });

    expect([...titles.caseTitleByEngagementId.entries()]).toEqual([
      [live.engagement.id, 'Flow debugging'],
    ]);
    expect(titles.kickoffRequestTitleByEngagementId.size).toBe(0);
    expect(titles.requestTitleById.size).toBe(0);
  });

  it('maps a kickoff to its linked request title, and to null (KEY PRESENT) with no request or a soft-deleted one', async () => {
    const request = await projectRequestFactory({ title: 'Lead routing rebuild' });
    const { engagement: linked } = await engagementFactory({
      projectValues: { projectRequestId: request.id },
    });
    const { engagement: unlinked } = await engagementFactory();
    const goneRequest = await projectRequestFactory({ title: 'Withdrawn brief' });
    const { engagement: orphaned } = await engagementFactory({
      projectValues: { projectRequestId: goneRequest.id },
    });
    await softDeleteRequest(goneRequest.id);
    const aCase = await caseEngagementFactory();

    const titles = await upcomingMeetingsRepository.findTitles({
      caseEngagementIds: [],
      kickoffEngagementIds: [linked.id, unlinked.id, orphaned.id, aCase.engagement.id],
      projectRequestIds: [],
    });

    const kickoff = titles.kickoffRequestTitleByEngagementId;
    expect(kickoff.size).toBe(3);
    expect(kickoff.get(linked.id)).toBe('Lead routing rebuild');
    expect(kickoff.has(unlinked.id)).toBe(true);
    expect(kickoff.get(unlinked.id)).toBeNull();
    expect(kickoff.has(orphaned.id)).toBe(true);
    expect(kickoff.get(orphaned.id)).toBeNull();
    // A case id passed as a kickoff is not a live PROJECT engagement — no key at all.
    expect(kickoff.has(aCase.engagement.id)).toBe(false);
  });

  it('returns live request titles; a soft-deleted request is absent', async () => {
    const live = await projectRequestFactory({ title: 'CPQ discovery' });
    const gone = await projectRequestFactory({ title: 'Deleted brief' });
    await softDeleteRequest(gone.id);

    const titles = await upcomingMeetingsRepository.findTitles({
      caseEngagementIds: [],
      kickoffEngagementIds: [],
      projectRequestIds: [live.id, gone.id],
    });

    expect([...titles.requestTitleById.entries()]).toEqual([[live.id, 'CPQ discovery']]);
  });

  it('empty inputs return three empty maps', async () => {
    const titles = await upcomingMeetingsRepository.findTitles({
      caseEngagementIds: [],
      kickoffEngagementIds: [],
      projectRequestIds: [],
    });

    expect(titles.caseTitleByEngagementId.size).toBe(0);
    expect(titles.kickoffRequestTitleByEngagementId.size).toBe(0);
    expect(titles.requestTitleById.size).toBe(0);
  });
});

describe('upcomingMeetingsRepository.findExpertPartyNames', () => {
  it('returns an agency expert’s person names and agency name — name columns only', async () => {
    const agency = await agencyFactory({ name: 'CloudPeak' });
    const user = await userFactory({ firstName: 'Dana', lastName: 'Reyes' });
    const expert = await expertFactory({ userId: user.id, type: 'agency' });
    await db
      .update(expertProfiles)
      .set({ agencyId: agency.id })
      .where(eq(expertProfiles.id, expert.id));

    const names = await upcomingMeetingsRepository.findExpertPartyNames([expert.id, expert.id]);

    expect(names).toEqual([
      {
        expertProfileId: expert.id,
        type: 'agency',
        firstName: 'Dana',
        lastName: 'Reyes',
        agencyName: 'CloudPeak',
      },
    ]);
    expect(Object.keys(names[0] ?? {}).sort(compareStrings)).toEqual([
      'agencyName',
      'expertProfileId',
      'firstName',
      'lastName',
      'type',
    ]);
  });

  it('an independent expert has agencyName null', async () => {
    const user = await userFactory({ firstName: 'Sam', lastName: 'Okafor' });
    const expert = await expertFactory({ userId: user.id, type: 'freelancer' });

    const names = await upcomingMeetingsRepository.findExpertPartyNames([expert.id]);

    expect(names).toHaveLength(1);
    expect(names[0]).toMatchObject({
      expertProfileId: expert.id,
      type: 'freelancer',
      firstName: 'Sam',
      lastName: 'Okafor',
      agencyName: null,
    });
  });

  it('a soft-deleted user keeps the row, with null names', async () => {
    const user = await userFactory({ firstName: 'Gone', lastName: 'User' });
    const expert = await expertFactory({ userId: user.id });
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, user.id));

    const names = await upcomingMeetingsRepository.findExpertPartyNames([expert.id]);

    expect(names).toHaveLength(1);
    expect(names[0]).toMatchObject({
      expertProfileId: expert.id,
      firstName: null,
      lastName: null,
    });
  });

  it('[] returns []', async () => {
    await expect(upcomingMeetingsRepository.findExpertPartyNames([])).resolves.toEqual([]);
  });
});
