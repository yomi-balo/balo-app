/**
 * BAL-567 — `casesIndexRepository` against real Postgres (Testcontainers, rollback per test).
 *
 * ⚠⚠ THE SECURITY-CRITICAL DESCRIBE IS "every listed case opens". The AC spans two packages —
 * the LIST is `packages/db`, `resolveCaseAccess` is `server-only` in `apps/web` — so it is
 * proved here by COMPOSING the two pure predicates `resolveSide` composes
 * (`resolveCompanyParticipation` + `actorHasExpertSideVisibility`, both from
 * `@balo/shared/authz`, which `@balo/db` may import). The rule is CONSUMED, never re-typed: a
 * re-implementation here would pass while the real gate denied.
 *
 * ⚠ EVERY CONTAINMENT ASSERTION IS PAIRED WITH AN EXACT ARRAY AND A LENGTH. A bare `.every()`
 * over a possibly-empty array is vacuously true and proves nothing (memory
 * `feedback_mutation_proof_is_per_assertion_not_per_suite`).
 *
 * Fixtures go through `caseEngagementFactory` (D7): it provisions the `conversations` +
 * `conversation_contexts` rows the `no_thread` arm needs AND can seed the pre-closed /
 * pre-soft-deleted shapes `caseEngagementsRepository.create()` refuses and the Resolved section
 * requires.
 *
 * Every date is derived from `Date.now()` at CALL time — never a hardcoded calendar date
 * (memory `reference_hardcoded_date_fixtures_are_time_bombs`).
 */
import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  actorHasExpertSideVisibility,
  resolveCompanyParticipation,
  roleHasCapability,
  CAPABILITIES,
  type AgencyRoleLookup,
  type CompanyRoleLookup,
} from '@balo/shared/authz';
import {
  dailyRoomNameForMeeting,
  isMeetingVenueReady,
  MEETING_CLOSED_TO_JOIN,
} from '@balo/shared/meetings';
import { db } from '../client';
import {
  caseEngagementProducts,
  caseEngagements,
  companyMembers,
  companyRoleEnum,
  conversationContexts,
  engagements,
  expertProfiles,
  meetingContexts,
  meetings,
  meetingStatusEnum,
  products,
  users,
  type MeetingOutcome,
} from '../schema';
import {
  actionItemFactory,
  agencyFactory,
  agencyMemberFactory,
  caseEngagementFactory,
  companyFactory,
  companyMemberFactory,
  engagementFactory,
  expertFactory,
  meetingFactory,
  userFactory,
} from '../test/factories';
import { partyMembershipsRepository } from './party-memberships';
import { referenceDataRepository } from './reference-data';
import {
  assertCasesIndexMeetingCap,
  BOOKED_MEETING_STATUSES,
  casesIndexRepository,
  CasesIndexMeetingCapExceededError,
  CasesIndexPageSizeError,
  MAX_CASES_INDEX_MEETING_ROWS,
  MAX_CASES_INDEX_PAGE_SIZE,
  type CasesIndexCaseRow,
  type CasesIndexScope,
} from './cases-index';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** THE GATE ORACLES — the exact lookup shapes every production caller passes. */
const lookupCompanyRole: CompanyRoleLookup = (companyId, actorId) =>
  partyMembershipsRepository.getMemberRole('company', companyId, actorId);
const lookupAgencyRole: AgencyRoleLookup = (agencyId, actorId) =>
  partyMembershipsRepository.getMemberRole('agency', agencyId, actorId);

// ── Fixture helpers ───────────────────────────────────────────────────────────────────────────

interface SeedCaseInput {
  companyId: string;
  expertProfileId: string;
  createdAt?: Date;
  closedAt?: Date;
  closedByUserId?: string;
  closeReason?: 'resolved' | 'auto_inactive';
  deletedAt?: Date;
  title?: string;
}

async function seedCase(input: SeedCaseInput): Promise<string> {
  const closed =
    input.closedAt === undefined
      ? {}
      : {
          closedAt: input.closedAt,
          closeReason: input.closeReason ?? ('resolved' as const),
          closedByUserId:
            input.closeReason === 'auto_inactive' ? null : (input.closedByUserId ?? null),
        };
  const { engagement } = await caseEngagementFactory({
    companyId: input.companyId,
    expertProfileId: input.expertProfileId,
    values: {
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
      ...(input.deletedAt === undefined ? {} : { deletedAt: input.deletedAt }),
    },
    caseValues: {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...closed,
    },
  });
  return engagement.id;
}

/** One `case`-context meeting on `engagementId`. */
async function seedCaseMeeting(
  engagementId: string,
  values: {
    scheduledStart: Date;
    scheduledEnd?: Date;
    status?: 'scheduled' | 'waiting_for_participants' | 'in_progress' | 'ended' | 'cancelled';
    outcome?: MeetingOutcome;
    startedAt?: Date;
  }
): Promise<string> {
  const { meeting } = await meetingFactory({
    contexts: [{ contextType: 'case', contextId: engagementId }],
    values: {
      scheduledStart: values.scheduledStart,
      scheduledEnd: values.scheduledEnd ?? new Date(values.scheduledStart.getTime() + HOUR_MS),
      ...(values.status === undefined ? {} : { status: values.status }),
      ...(values.outcome === undefined ? {} : { outcome: values.outcome }),
      ...(values.startedAt === undefined ? {} : { startedAt: values.startedAt }),
    },
  });
  return meeting.id;
}

/** An APPROVED expert attached to `agencyId` (no factory override sets `agency_id`). */
async function seedAgencyExpert(
  agencyId: string,
  role: 'owner' | 'admin' | 'expert' = 'owner'
): Promise<{ profileId: string; userId: string }> {
  const expert = await expertFactory({ type: 'agency' });
  await db.update(expertProfiles).set({ agencyId }).where(eq(expertProfiles.id, expert.id));
  await agencyMemberFactory({ agencyId, userId: expert.userId, role });
  return { profileId: expert.id, userId: expert.userId };
}

async function listOpenIds(scope: CasesIndexScope, limit = 24): Promise<string[]> {
  const page = await casesIndexRepository.listOpenCases(scope, { limit });
  return page.rows.map((row) => row.engagementId);
}

async function listResolvedIds(scope: CasesIndexScope, limit = 20): Promise<string[]> {
  const page = await casesIndexRepository.listResolvedCases(scope, { limit });
  return page.rows.map((row) => row.engagementId);
}

// ── The six-actor world ───────────────────────────────────────────────────────────────────────

interface Actor {
  readonly label: string;
  readonly userId: string;
}

interface World {
  readonly companyId: string;
  readonly otherCompanyId: string;
  readonly agencyId: string;
  readonly expertProfileId: string;
  readonly expertUserId: string;
  readonly caseId: string;
  readonly participant: Actor;
  readonly removedMember: Actor;
  readonly deliveringExpert: Actor;
  /** A live agency member with role `expert` AND their own (idle) expert profile. */
  readonly agencyColleague: Actor;
  readonly colleagueExpertProfileId: string;
  /** Both a live company member AND the delivering expert of `dualCaseId`. */
  readonly dualMember: Actor;
  readonly dualExpertProfileId: string;
  readonly dualCaseId: string;
  readonly stranger: Actor;
}

async function seedWorld(): Promise<World> {
  const company = await companyFactory();
  const otherCompany = await companyFactory();
  const agency = await agencyFactory();
  const expert = await seedAgencyExpert(agency.id);

  const participant = await userFactory();
  await companyMemberFactory({ companyId: company.id, userId: participant.id, role: 'member' });

  const removed = await userFactory();
  await companyMemberFactory({
    companyId: company.id,
    userId: removed.id,
    role: 'member',
    deletedAt: new Date(),
  });

  // The colleague holds the AGENCY's base role and their own expert profile — so they have a
  // real expert workspace to list, and it must come back EMPTY while the case still opens.
  const colleague = await seedAgencyExpert(agency.id, 'expert');

  const stranger = await userFactory();

  const caseId = await seedCase({ companyId: company.id, expertProfileId: expert.profileId });

  // The DUAL actor: their own expert profile delivers a case booked by `company`, and they are
  // ALSO a live member of `company`. `resolveSide` tries the client arm first, so their side is
  // `client` — and the expert workspace must not list the case.
  const dualUser = await userFactory();
  const dualProfile = await expertFactory({ type: 'freelancer', userId: dualUser.id });
  await companyMemberFactory({ companyId: company.id, userId: dualUser.id, role: 'member' });
  const dualCaseId = await seedCase({
    companyId: company.id,
    expertProfileId: dualProfile.id,
    title: 'Dual-membership case',
  });

  return {
    companyId: company.id,
    otherCompanyId: otherCompany.id,
    agencyId: agency.id,
    expertProfileId: expert.profileId,
    expertUserId: expert.userId,
    caseId,
    participant: { label: 'company member with PARTICIPATE', userId: participant.id },
    removedMember: { label: 'removed company member', userId: removed.id },
    deliveringExpert: { label: 'the delivering expert', userId: expert.userId },
    agencyColleague: { label: 'agency colleague, role expert', userId: colleague.userId },
    colleagueExpertProfileId: colleague.profileId,
    dualMember: { label: 'company member AND delivering expert', userId: dualUser.id },
    dualExpertProfileId: dualProfile.id,
    dualCaseId,
    stranger: { label: 'stranger', userId: stranger.id },
  };
}

/**
 * ⚠ `resolveSide` (`apps/web/src/lib/conversations/authorize-conversation-context.ts`),
 * COMPOSED FROM THE SHIPPED PREDICATES — never re-implemented. CLIENT arm first, so a viewer
 * who holds BOTH memberships resolves to `client`; `member_without_participate` denies OUTRIGHT
 * rather than falling through to the expert arm.
 */
async function resolveOpenableSide(
  subject: { companyId: string; expertUserId: string; agencyId: string | null },
  actorUserId: string
): Promise<'client' | 'expert' | null> {
  const participation = await resolveCompanyParticipation(
    subject.companyId,
    actorUserId,
    lookupCompanyRole
  );
  if (participation === 'participant') return 'client';
  if (participation === 'member_without_participate') return null;
  const onExpertSide = await actorHasExpertSideVisibility(
    { userId: subject.expertUserId, agencyId: subject.agencyId },
    actorUserId,
    lookupAgencyRole
  );
  return onExpertSide ? 'expert' : null;
}

/** The subject columns the composed rule reads, taken from the ROW the repository returned. */
function subjectOf(row: CasesIndexCaseRow): {
  companyId: string;
  expertUserId: string;
  agencyId: string | null;
} {
  return { companyId: row.companyId, expertUserId: row.expertUserId, agencyId: row.agencyId };
}

// ── 1 · Scoping ───────────────────────────────────────────────────────────────────────────────

describe('casesIndexRepository.listOpenCases — scoping', () => {
  it('the company arm lists EXACTLY that company’s open cases; another company’s case is absent', async () => {
    const world = await seedWorld();
    const foreign = await seedCase({
      companyId: world.otherCompanyId,
      expertProfileId: world.expertProfileId,
    });

    const listed = await listOpenIds({ side: 'company', companyId: world.companyId });

    expect(listed).toEqual(expect.arrayContaining([world.caseId, world.dualCaseId]));
    expect(listed).toHaveLength(2);
    expect(listed).not.toContain(foreign);
    expect(await listOpenIds({ side: 'company', companyId: world.otherCompanyId })).toEqual([
      foreign,
    ]);
  });

  it('the expert arm lists EXACTLY that expert profile’s cases, across companies', async () => {
    const world = await seedWorld();
    const second = await seedCase({
      companyId: world.otherCompanyId,
      expertProfileId: world.expertProfileId,
    });
    // Role `expert`, not `owner` — `agency_owner_unique_idx` allows exactly one owner per agency.
    const otherExpert = await seedAgencyExpert(world.agencyId, 'expert');
    const notMine = await seedCase({
      companyId: world.companyId,
      expertProfileId: otherExpert.profileId,
    });

    const listed = await listOpenIds({
      side: 'expert',
      expertProfileId: world.expertProfileId,
      viewerUserId: world.expertUserId,
    });

    expect([...listed].sort()).toEqual([world.caseId, second].sort());
    expect(listed).toHaveLength(2);
    expect(listed).not.toContain(notMine);
  });

  it('the expert arm EXCLUDES a case whose company the viewer is a live member of (dual membership)', async () => {
    const world = await seedWorld();
    const expertScope: CasesIndexScope = {
      side: 'expert',
      expertProfileId: world.dualExpertProfileId,
      viewerUserId: world.dualMember.userId,
    };

    expect(await listOpenIds(expertScope)).toEqual([]);
    // ⚠ THE CASE EXISTS AND IS LIVE — it is the MEMBERSHIP that hides it, not the case. Proved
    // from the COMPANY arm, which lists the same row.
    //
    // ⚠ THIS CONTROL USED TO BE "a DIFFERENT viewer of the same expert profile sees it", and the
    // BAL-567 fix round (SEC-1) made that assertion false ON PURPOSE: the expert arm now proves
    // the viewer OWNS the profile, so a foreign viewer gets nothing. The new behaviour is pinned
    // in its own case below rather than being smuggled in by weakening this one.
    const listedForCompany = await listOpenIds({ side: 'company', companyId: world.companyId });
    expect(listedForCompany).toContain(world.dualCaseId);
  });

  /**
   * ⚠⚠ SEC-1 — THE EXPERT ARM IS SELF-VERIFYING. Every other case in this file pairs a profile
   * with the user who owns it, so none of them would notice if the ownership predicate were
   * dropped. This one supplies a MISMATCHED pair — a real, live expert profile with a viewer who
   * does not own it — which is exactly the shape a forged or stale session would take, and
   * asserts that BOTH lists and the COUNTS come back empty rather than serving that profile's
   * cases to somebody else.
   */
  it('the expert arm returns NOTHING when the viewer does not own the expert profile', async () => {
    const world = await seedWorld();
    const foreignViewer = await userFactory();
    const mismatched: CasesIndexScope = {
      side: 'expert',
      expertProfileId: world.expertProfileId,
      viewerUserId: foreignViewer.id,
    };

    // The control: the OWNER of that profile does see the case, so the scope is otherwise valid
    // and this is not passing for want of a case to find.
    const forOwner = await listOpenIds({
      side: 'expert',
      expertProfileId: world.expertProfileId,
      viewerUserId: world.expertUserId,
    });
    expect(forOwner).toEqual([world.caseId]);
    expect(forOwner).toHaveLength(1);

    expect(await listOpenIds(mismatched)).toEqual([]);
    expect(await listResolvedIds(mismatched)).toEqual([]);
    expect(await casesIndexRepository.countCasesForScope(mismatched)).toEqual({
      open: 0,
      resolved: 0,
    });
  });

  it('a mismatched viewer is refused even for a RESOLVED case', async () => {
    const world = await seedWorld();
    const foreignViewer = await userFactory();
    const closed = await seedCase({
      companyId: world.companyId,
      expertProfileId: world.expertProfileId,
      closedAt: new Date('2026-08-01T00:00:00Z'),
      // ⚠ `auto_inactive`, NOT `resolved` — `case_engagement_close_coherent` requires a
      // `closed_by_user_id` for a client-resolved close, and the sweep's close has none. The
      // close REASON is irrelevant to what this case pins (the ownership predicate), so the
      // shape that needs no extra actor is the honest fixture.
      closeReason: 'auto_inactive',
    });

    const forOwner = await listResolvedIds({
      side: 'expert',
      expertProfileId: world.expertProfileId,
      viewerUserId: world.expertUserId,
    });
    expect(forOwner).toEqual([closed]);

    const forForeigner = await listResolvedIds({
      side: 'expert',
      expertProfileId: world.expertProfileId,
      viewerUserId: foreignViewer.id,
    });
    expect(forForeigner).toEqual([]);
  });

  it('a SOFT-REMOVED company membership stops hiding the case from the expert arm', async () => {
    const world = await seedWorld();
    await db
      .update(companyMembers)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(companyMembers.companyId, world.companyId),
          eq(companyMembers.userId, world.dualMember.userId)
        )
      );

    const listed = await listOpenIds({
      side: 'expert',
      expertProfileId: world.dualExpertProfileId,
      viewerUserId: world.dualMember.userId,
    });
    expect(listed).toEqual([world.dualCaseId]);
    expect(listed).toHaveLength(1);
  });
});

// ── 2 · Liveness exclusions — each one is a case that would 404 if listed ─────────────────────

describe('casesIndexRepository.listOpenCases — every exclusion is a case that would 404', () => {
  interface Exclusion {
    readonly label: string;
    readonly exclude: (engagementId: string) => Promise<void>;
  }

  const EXCLUSIONS: readonly Exclusion[] = [
    {
      label: 'a soft-deleted engagement (gate: no_engagement)',
      exclude: async (id) => {
        await db.update(engagements).set({ deletedAt: new Date() }).where(eq(engagements.id, id));
      },
    },
    {
      label: 'a soft-deleted case_engagements child (loader: findByEngagementId)',
      exclude: async (id) => {
        await db
          .update(caseEngagements)
          .set({ deletedAt: new Date() })
          .where(eq(caseEngagements.engagementId, id));
      },
    },
    {
      label: 'a case whose thread conversation_contexts row is soft-deleted (gate: no_thread)',
      exclude: async (id) => {
        await db
          .update(conversationContexts)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(conversationContexts.contextType, 'engagement'),
              eq(conversationContexts.contextId, id)
            )
          );
      },
    },
  ];

  it.each(EXCLUSIONS)('excludes $label, while a control case is still listed', async (spec) => {
    const company = await companyFactory();
    const expert = await expertFactory();
    const excluded = await seedCase({ companyId: company.id, expertProfileId: expert.id });
    const control = await seedCase({ companyId: company.id, expertProfileId: expert.id });

    expect(await listOpenIds({ side: 'company', companyId: company.id })).toHaveLength(2);
    await spec.exclude(excluded);

    const listed = await listOpenIds({ side: 'company', companyId: company.id });
    expect(listed).toEqual([control]);
    expect(listed).toHaveLength(1);
  });

  it('excludes a non-case engagement of the same company', async () => {
    const company = await companyFactory();
    const expert = await expertFactory();
    const { engagement } = await engagementFactory({
      companyId: company.id,
      expertProfileId: expert.id,
    });
    const caseId = await seedCase({ companyId: company.id, expertProfileId: expert.id });

    const listed = await listOpenIds({ side: 'company', companyId: company.id });
    expect(listed).toEqual([caseId]);
    expect(listed).not.toContain(engagement.id);
  });

  it('a CLOSED case leaves the Open list and appears on the Resolved list — the two partition', async () => {
    const company = await companyFactory();
    const expert = await expertFactory();
    const closer = await userFactory();
    await companyMemberFactory({ companyId: company.id, userId: closer.id });
    const open = await seedCase({ companyId: company.id, expertProfileId: expert.id });
    const closed = await seedCase({
      companyId: company.id,
      expertProfileId: expert.id,
      closedAt: new Date(),
      closedByUserId: closer.id,
    });

    const scope: CasesIndexScope = { side: 'company', companyId: company.id };
    expect(await listOpenIds(scope)).toEqual([open]);
    expect(await listResolvedIds(scope)).toEqual([closed]);
    expect(await casesIndexRepository.countCasesForScope(scope)).toEqual({ open: 1, resolved: 1 });
  });
});

// ── 3 · THE AC — every listed case opens, on the workspace's own side ─────────────────────────

describe('BAL-567 — every listed case opens, on the workspace’s own side', () => {
  it('all six actors: listed ⊆ openable, with exact arrays and lengths', async () => {
    const world = await seedWorld();
    const companyScope: CasesIndexScope = { side: 'company', companyId: world.companyId };
    const [openRow] = (
      await casesIndexRepository.listOpenCases(companyScope, { limit: 24 })
    ).rows.filter((row) => row.engagementId === world.caseId);
    if (openRow === undefined) throw new Error('fixture case is not listed for its own company');
    const subject = subjectOf(openRow);

    // ── the company member WITH `PARTICIPATE` ──
    const participantListed = await listOpenIds(companyScope);
    expect([...participantListed].sort()).toEqual([world.caseId, world.dualCaseId].sort());
    expect(participantListed).toHaveLength(2);
    expect(await resolveOpenableSide(subject, world.participant.userId)).toBe('client');

    // ── the removed member: nothing is openable, and the loader never reads a list ──
    expect(
      await resolveCompanyParticipation(
        world.companyId,
        world.removedMember.userId,
        lookupCompanyRole
      )
    ).toBe('not_a_member');
    expect(await resolveOpenableSide(subject, world.removedMember.userId)).toBeNull();

    // ── the delivering expert: their list is EXACTLY their own case, and it opens ──
    const expertListed = await listOpenIds({
      side: 'expert',
      expertProfileId: world.expertProfileId,
      viewerUserId: world.expertUserId,
    });
    expect(expertListed).toEqual([world.caseId]);
    expect(expertListed).toHaveLength(1);
    expect(await resolveOpenableSide(subject, world.deliveringExpert.userId)).toBe('expert');

    // ── the agency colleague (role `expert`): listed ⊂ openable, STRICTLY. Their OWN expert
    //    workspace is empty — they deliver nothing — yet the delivering expert's case OPENS for
    //    them, because visibility is deliberately wider than the act axis (ADR-1046 §7: "do not
    //    narrow it"). This is the one row where equality would be the WRONG assertion. ──
    const colleagueListed = await listOpenIds({
      side: 'expert',
      expertProfileId: world.colleagueExpertProfileId,
      viewerUserId: world.agencyColleague.userId,
    });
    expect(colleagueListed).toEqual([]);
    expect(await resolveOpenableSide(subject, world.agencyColleague.userId)).toBe('expert');

    // ── the dual actor: listed on the COMPANY side, absent from the EXPERT side, side=client ──
    const dualExpertListed = await listOpenIds({
      side: 'expert',
      expertProfileId: world.dualExpertProfileId,
      viewerUserId: world.dualMember.userId,
    });
    expect(dualExpertListed).toEqual([]);
    const dualRow = (
      await casesIndexRepository.listOpenCases(companyScope, { limit: 24 })
    ).rows.find((row) => row.engagementId === world.dualCaseId);
    if (dualRow === undefined) throw new Error('dual case is not listed for its own company');
    expect(await resolveOpenableSide(subjectOf(dualRow), world.dualMember.userId)).toBe('client');

    // ── the stranger: both lists empty, nothing openable ──
    const strangerCompany = await companyFactory();
    await companyMemberFactory({
      companyId: strangerCompany.id,
      userId: world.stranger.userId,
      role: 'owner',
    });
    expect(await listOpenIds({ side: 'company', companyId: strangerCompany.id })).toEqual([]);
    expect(await resolveOpenableSide(subject, world.stranger.userId)).toBeNull();
  });

  it('EVERY row of EVERY non-empty list is openable on that list’s own side (containment, with lengths)', async () => {
    const world = await seedWorld();
    const extra = await seedCase({
      companyId: world.companyId,
      expertProfileId: world.expertProfileId,
    });

    const companyRows = (
      await casesIndexRepository.listOpenCases(
        { side: 'company', companyId: world.companyId },
        { limit: 24 }
      )
    ).rows;
    // ⚠ THE LENGTH ASSERTION IS WHAT STOPS THE LOOP BELOW BEING VACUOUS.
    expect(companyRows).toHaveLength(3);
    expect([...companyRows].map((r) => r.engagementId).sort()).toEqual(
      [world.caseId, world.dualCaseId, extra].sort()
    );
    for (const row of companyRows) {
      expect(await resolveOpenableSide(subjectOf(row), world.participant.userId)).toBe('client');
    }

    const expertRows = (
      await casesIndexRepository.listOpenCases(
        {
          side: 'expert',
          expertProfileId: world.expertProfileId,
          viewerUserId: world.expertUserId,
        },
        { limit: 24 }
      )
    ).rows;
    expect(expertRows).toHaveLength(2);
    expect([...expertRows].map((r) => r.engagementId).sort()).toEqual([world.caseId, extra].sort());
    for (const row of expertRows) {
      expect(await resolveOpenableSide(subjectOf(row), world.expertUserId)).toBe('expert');
    }
  });

  it('`member_without_participate` is UNBUILDABLE today — every shipped company role grants PARTICIPATE', () => {
    // The lock state this repository's caller renders for that outcome is therefore unreachable
    // through the database. If a future company role lands WITHOUT `PARTICIPATE`, this fails —
    // and the lock arm becomes live, with a real fixture to test it against.
    const roles = [...companyRoleEnum.enumValues];
    expect(roles).toEqual(['owner', 'admin', 'member']);
    expect(roles).toHaveLength(3);
    for (const role of roles) {
      expect(roleHasCapability(role, CAPABILITIES.PARTICIPATE)).toBe(true);
    }
  });
});

// ── 4 · Ordering and pagination ───────────────────────────────────────────────────────────────

describe('casesIndexRepository.listOpenCases — ordering', () => {
  it('booked-soonest-first, then unbooked by coalesce(last_held, created_at) DESC', async () => {
    const company = await companyFactory();
    const expert = await expertFactory();
    const now = Date.now();
    const scope: CasesIndexScope = { side: 'company', companyId: company.id };

    const soon = await seedCase({ companyId: company.id, expertProfileId: expert.id });
    await seedCaseMeeting(soon, { scheduledStart: new Date(now + 2 * HOUR_MS) });

    const later = await seedCase({ companyId: company.id, expertProfileId: expert.id });
    await seedCaseMeeting(later, { scheduledStart: new Date(now + 6 * 7 * DAY_MS) });

    const heldRecently = await seedCase({
      companyId: company.id,
      expertProfileId: expert.id,
      createdAt: new Date(now - 30 * DAY_MS),
    });
    await seedCaseMeeting(heldRecently, {
      scheduledStart: new Date(now - 2 * DAY_MS),
      status: 'ended',
      outcome: 'completed',
      startedAt: new Date(now - 2 * DAY_MS),
    });

    const neverHeldOld = await seedCase({
      companyId: company.id,
      expertProfileId: expert.id,
      createdAt: new Date(now - 10 * DAY_MS),
    });

    expect(await listOpenIds(scope)).toEqual([soon, later, heldRecently, neverHeldOld]);
  });

  it('⚠ a booking SIX WEEKS out sorts BELOW a call happening today (the anti-listOpenForCompanyAndExpert case)', async () => {
    const company = await companyFactory();
    const expert = await expertFactory();
    const now = Date.now();

    // `listOpenForCompanyAndExpert` orders on `MAX(scheduled_start) DESC`, which would put the
    // six-weeks-out case FIRST. This index must not.
    const today = await seedCase({ companyId: company.id, expertProfileId: expert.id });
    await seedCaseMeeting(today, { scheduledStart: new Date(now + HOUR_MS) });
    const sixWeeks = await seedCase({ companyId: company.id, expertProfileId: expert.id });
    await seedCaseMeeting(sixWeeks, { scheduledStart: new Date(now + 42 * DAY_MS) });

    expect(await listOpenIds({ side: 'company', companyId: company.id })).toEqual([
      today,
      sixWeeks,
    ]);
  });

  it('BOOKED_MEETING_STATUSES is EXACTLY the complement of MEETING_CLOSED_TO_JOIN — the drift guard', () => {
    // A 6th `meeting_status` label nobody adds to the positive list would silently drop every
    // meeting in it into the UNBOOKED bucket: a wrong page, not an error. This fails instead.
    const complement = meetingStatusEnum.enumValues.filter(
      (status) => !MEETING_CLOSED_TO_JOIN.has(status)
    );
    expect([...BOOKED_MEETING_STATUSES]).toEqual(complement);
    expect(BOOKED_MEETING_STATUSES).toHaveLength(3);
    expect(meetingStatusEnum.enumValues).toHaveLength(5);
  });

  it('a cancelled or ended meeting is NOT an upcoming booking, so its case drops to the unbooked bucket', async () => {
    const company = await companyFactory();
    const expert = await expertFactory();
    const now = Date.now();

    const booked = await seedCase({ companyId: company.id, expertProfileId: expert.id });
    await seedCaseMeeting(booked, { scheduledStart: new Date(now + 3 * HOUR_MS) });
    const cancelled = await seedCase({ companyId: company.id, expertProfileId: expert.id });
    await seedCaseMeeting(cancelled, {
      scheduledStart: new Date(now + HOUR_MS),
      status: 'cancelled',
    });

    const page = await casesIndexRepository.listOpenCases(
      { side: 'company', companyId: company.id },
      { limit: 24 }
    );
    expect(page.rows.map((row) => row.engagementId)).toEqual([booked, cancelled]);
    const [first, second] = page.rows;
    if (first === undefined || second === undefined) throw new Error('expected two rows');
    expect(first.bucket).toBe(0);
    expect(first.nextBookingAt).toBeInstanceOf(Date);
    expect(second.bucket).toBe(1);
    expect(second.nextBookingAt).toBeNull();
  });
});

describe('casesIndexRepository.listOpenCases — keyset pagination', () => {
  it('26 cases across the bucket boundary page with no duplicates and no skips', async () => {
    const company = await companyFactory();
    const expert = await expertFactory();
    const now = Date.now();
    const scope: CasesIndexScope = { side: 'company', companyId: company.id };

    const booked: string[] = [];
    for (let i = 0; i < 13; i++) {
      const id = await seedCase({ companyId: company.id, expertProfileId: expert.id });
      await seedCaseMeeting(id, { scheduledStart: new Date(now + (i + 1) * HOUR_MS) });
      booked.push(id);
    }
    const unbooked: string[] = [];
    for (let i = 0; i < 13; i++) {
      unbooked.push(
        await seedCase({
          companyId: company.id,
          expertProfileId: expert.id,
          createdAt: new Date(now - (i + 1) * DAY_MS),
        })
      );
    }
    const expected = [...booked, ...unbooked];

    const first = await casesIndexRepository.listOpenCases(scope, { limit: 24 });
    expect(first.rows).toHaveLength(24);
    expect(first.hasMore).toBe(true);
    const [last] = first.rows.slice(-1);
    if (last === undefined) throw new Error('page 1 is empty');

    const second = await casesIndexRepository.listOpenCases(scope, {
      limit: 24,
      after: { bucket: last.bucket, sortRank: last.sortRank, id: last.engagementId },
    });
    expect(second.rows).toHaveLength(2);
    expect(second.hasMore).toBe(false);

    const paged = [...first.rows, ...second.rows].map((row) => row.engagementId);
    expect(paged).toHaveLength(26);
    expect(new Set(paged).size).toBe(26);
    expect(paged).toEqual(expected);
  });

  it('rejects a limit outside 1..MAX_CASES_INDEX_PAGE_SIZE rather than serving it', async () => {
    const company = await companyFactory();
    const scope: CasesIndexScope = { side: 'company', companyId: company.id };
    await expect(casesIndexRepository.listOpenCases(scope, { limit: 0 })).rejects.toBeInstanceOf(
      CasesIndexPageSizeError
    );
    await expect(
      casesIndexRepository.listOpenCases(scope, { limit: MAX_CASES_INDEX_PAGE_SIZE + 1 })
    ).rejects.toBeInstanceOf(CasesIndexPageSizeError);
    await expect(
      casesIndexRepository.listResolvedCases(scope, { limit: 0 })
    ).rejects.toBeInstanceOf(CasesIndexPageSizeError);
  });
});

// ── 5 · Resolved list ─────────────────────────────────────────────────────────────────────────

describe('casesIndexRepository.listResolvedCases', () => {
  it('orders by closed_at DESC, carries both close reasons, and pages by keyset', async () => {
    const company = await companyFactory();
    const expert = await expertFactory();
    const closer = await userFactory();
    await companyMemberFactory({ companyId: company.id, userId: closer.id });
    const now = Date.now();
    const scope: CasesIndexScope = { side: 'company', companyId: company.id };

    const newest = await seedCase({
      companyId: company.id,
      expertProfileId: expert.id,
      closedAt: new Date(now - HOUR_MS),
      closedByUserId: closer.id,
    });
    const middle = await seedCase({
      companyId: company.id,
      expertProfileId: expert.id,
      closedAt: new Date(now - DAY_MS),
      closeReason: 'auto_inactive',
    });
    const oldest = await seedCase({
      companyId: company.id,
      expertProfileId: expert.id,
      closedAt: new Date(now - 5 * DAY_MS),
      closedByUserId: closer.id,
    });

    const page = await casesIndexRepository.listResolvedCases(scope, { limit: 2 });
    expect(page.rows.map((row) => row.engagementId)).toEqual([newest, middle]);
    expect(page.hasMore).toBe(true);
    const [, second] = page.rows;
    if (second === undefined) throw new Error('expected two rows');
    expect(second.closeReason).toBe('auto_inactive');

    const rest = await casesIndexRepository.listResolvedCases(scope, {
      limit: 2,
      after: { closedAtEpoch: second.closedAtEpoch, id: second.engagementId },
    });
    expect(rest.rows.map((row) => row.engagementId)).toEqual([oldest]);
    expect(rest.hasMore).toBe(false);
  });

  it('heldCount counts only ended+completed meetings', async () => {
    const company = await companyFactory();
    const expert = await expertFactory();
    const closer = await userFactory();
    await companyMemberFactory({ companyId: company.id, userId: closer.id });
    const now = Date.now();
    const id = await seedCase({
      companyId: company.id,
      expertProfileId: expert.id,
      closedAt: new Date(now),
      closedByUserId: closer.id,
    });

    await seedCaseMeeting(id, {
      scheduledStart: new Date(now - 4 * DAY_MS),
      status: 'ended',
      outcome: 'completed',
    });
    await seedCaseMeeting(id, {
      scheduledStart: new Date(now - 3 * DAY_MS),
      status: 'ended',
      outcome: 'completed',
    });
    await seedCaseMeeting(id, {
      scheduledStart: new Date(now - 2 * DAY_MS),
      status: 'ended',
      outcome: 'no_show_client',
    });
    await seedCaseMeeting(id, {
      scheduledStart: new Date(now - 1 * DAY_MS),
      status: 'ended',
      outcome: 'missed_call',
    });
    // The call room was never ready — nothing was held.
    await seedCaseMeeting(id, {
      scheduledStart: new Date(now - 5 * DAY_MS),
      status: 'ended',
      outcome: 'venue_unavailable',
    });
    // `ended` with a NULL outcome, and a `cancelled` one — neither is held.
    await seedCaseMeeting(id, { scheduledStart: new Date(now - 6 * DAY_MS), status: 'ended' });
    await seedCaseMeeting(id, { scheduledStart: new Date(now + DAY_MS), status: 'cancelled' });

    const [row] = (
      await casesIndexRepository.listResolvedCases(
        { side: 'company', companyId: company.id },
        { limit: 20 }
      )
    ).rows;
    if (row === undefined) throw new Error('expected the resolved case');
    expect(row.heldCount).toBe(2);
  });

  it('a soft-deleted closed case is on NEITHER list and in NEITHER count', async () => {
    const company = await companyFactory();
    const expert = await expertFactory();
    const closer = await userFactory();
    await companyMemberFactory({ companyId: company.id, userId: closer.id });
    const id = await seedCase({
      companyId: company.id,
      expertProfileId: expert.id,
      closedAt: new Date(),
      closedByUserId: closer.id,
      deletedAt: new Date(),
    });

    const scope: CasesIndexScope = { side: 'company', companyId: company.id };
    expect(await listOpenIds(scope)).toEqual([]);
    expect(await listResolvedIds(scope)).toEqual([]);
    expect(await casesIndexRepository.countCasesForScope(scope)).toEqual({ open: 0, resolved: 0 });
    expect(id).toBeTruthy();
  });
});

// ── 6 · The batched per-page reads ────────────────────────────────────────────────────────────

describe('casesIndexRepository.listCaseTrailMeetings', () => {
  it('returns every live case meeting, oldest first on coalesce(started_at, scheduled_start)', async () => {
    const company = await companyFactory();
    const expert = await expertFactory();
    const now = Date.now();
    const a = await seedCase({ companyId: company.id, expertProfileId: expert.id });
    const b = await seedCase({ companyId: company.id, expertProfileId: expert.id });

    const first = await seedCaseMeeting(a, {
      scheduledStart: new Date(now - 5 * DAY_MS),
      status: 'ended',
      outcome: 'completed',
      startedAt: new Date(now - 5 * DAY_MS + 60_000),
    });
    const secondMeeting = await seedCaseMeeting(a, { scheduledStart: new Date(now + DAY_MS) });
    const other = await seedCaseMeeting(b, { scheduledStart: new Date(now + 2 * DAY_MS) });
    const softDeleted = await seedCaseMeeting(a, { scheduledStart: new Date(now + 3 * DAY_MS) });
    await db.update(meetings).set({ deletedAt: new Date() }).where(eq(meetings.id, softDeleted));
    const detachedContext = await seedCaseMeeting(a, {
      scheduledStart: new Date(now + 4 * DAY_MS),
    });
    await db
      .update(meetingContexts)
      .set({ deletedAt: new Date() })
      .where(eq(meetingContexts.meetingId, detachedContext));

    const trail = await casesIndexRepository.listCaseTrailMeetings([a, b]);
    expect(trail.get(a)?.map((row) => row.meetingId)).toEqual([first, secondMeeting]);
    expect(trail.get(a)).toHaveLength(2);
    expect(trail.get(b)?.map((row) => row.meetingId)).toEqual([other]);
    expect(trail.size).toBe(2);

    const [firstRow] = trail.get(a) ?? [];
    if (firstRow === undefined) throw new Error('expected a trail row');
    // `roomReady` is the SQL twin's readiness BOOLEAN, not a credential: the trail still selects
    // neither `join_url` nor `daily_room_name`.
    expect(Object.keys(firstRow).sort((a, b) => a.localeCompare(b))).toEqual(
      [
        'meetingId',
        'scheduledStart',
        'scheduledEnd',
        'startedAt',
        'status',
        'outcome',
        'roomReady',
      ].sort((a, b) => a.localeCompare(b))
    );
    expect(Object.keys(firstRow)).toHaveLength(7);
  });

  it('roomReady agrees with isMeetingVenueReady for a ready, a null and a mismatched room, and no credential key rides along', async () => {
    const company = await companyFactory();
    const expert = await expertFactory();
    const now = Date.now();
    const engagementId = await seedCase({ companyId: company.id, expertProfileId: expert.id });

    const readyId = randomUUID();
    const readyRoom = dailyRoomNameForMeeting(readyId);
    const mismatchedRoom = `balo-${randomUUID().replaceAll('-', '')}`;
    const venues: Array<{ id?: string; dailyRoomName: string | null; joinUrl: string | null }> = [
      { id: readyId, dailyRoomName: readyRoom, joinUrl: `https://balo.daily.co/${readyRoom}` },
      { dailyRoomName: null, joinUrl: null },
      { dailyRoomName: mismatchedRoom, joinUrl: `https://balo.daily.co/${mismatchedRoom}` },
    ];
    const expected: Array<[string, boolean]> = [];
    for (const [index, venue] of venues.entries()) {
      const scheduledStart = new Date(now + (index + 1) * DAY_MS);
      const { meeting } = await meetingFactory({
        contexts: [{ contextType: 'case', contextId: engagementId }],
        values: {
          ...venue,
          scheduledStart,
          scheduledEnd: new Date(scheduledStart.getTime() + HOUR_MS),
        },
      });
      expected.push([meeting.id, isMeetingVenueReady(meeting)]);
    }
    expect(expected.map(([, ready]) => ready)).toEqual([true, false, false]);

    const trail = (await casesIndexRepository.listCaseTrailMeetings([engagementId])).get(
      engagementId
    );

    expect(trail).toHaveLength(3);
    expect(trail?.map((row) => [row.meetingId, row.roomReady])).toEqual(expected);
    for (const row of trail ?? []) {
      expect(Object.keys(row)).not.toContain('dailyRoomName');
      expect(Object.keys(row)).not.toContain('joinUrl');
    }
  });

  it('[] in ⇒ empty Map with NO QUERY', async () => {
    const spy = vi.spyOn(db, 'select');
    try {
      expect(await casesIndexRepository.listCaseTrailMeetings([])).toEqual(new Map());
      expect(await casesIndexRepository.listCaseProductTags([])).toEqual(new Map());
      expect(await casesIndexRepository.countOpenActionItemsByParty([])).toEqual(new Map());
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('the row cap is FAIL-CLOSED — reaching it throws rather than truncating the trail', () => {
    expect(() => assertCasesIndexMeetingCap(MAX_CASES_INDEX_MEETING_ROWS - 1, 3)).not.toThrow();
    expect(() => assertCasesIndexMeetingCap(MAX_CASES_INDEX_MEETING_ROWS, 3)).toThrow(
      CasesIndexMeetingCapExceededError
    );
  });
});

describe('casesIndexRepository.listCaseProductTags', () => {
  it('returns live tags by product name, and excludes a soft-deleted link row', async () => {
    const company = await companyFactory();
    const expert = await expertFactory();
    const engagementId = await seedCase({
      companyId: company.id,
      expertProfileId: expert.id,
    });
    const vertical = await referenceDataRepository.getSalesforceVertical();
    const [zebra, apple, gone] = await db
      .insert(products)
      .values([
        { verticalId: vertical.id, name: 'Zebra Cloud', slug: `zebra-${engagementId}` },
        { verticalId: vertical.id, name: 'Apple Cloud', slug: `apple-${engagementId}` },
        { verticalId: vertical.id, name: 'Gone Cloud', slug: `gone-${engagementId}` },
      ])
      .returning();
    if (zebra === undefined || apple === undefined || gone === undefined) {
      throw new Error('product insert failed');
    }
    await db.insert(caseEngagementProducts).values([
      { engagementId, productId: zebra.id },
      { engagementId, productId: apple.id },
      { engagementId, productId: gone.id, deletedAt: new Date() },
    ]);

    const tags = await casesIndexRepository.listCaseProductTags([engagementId]);
    expect(tags.get(engagementId)).toEqual([
      { productId: apple.id, name: 'Apple Cloud' },
      { productId: zebra.id, name: 'Zebra Cloud' },
    ]);
    expect(tags.get(engagementId)).toHaveLength(2);
    expect(tags.size).toBe(1);
  });
});

describe('casesIndexRepository.countOpenActionItemsByParty', () => {
  it('counts OPEN items per party, buckets unassigned separately, and zeroes every requested id', async () => {
    const company = await companyFactory();
    const expert = await expertFactory();
    const author = await userFactory();
    const withItems = await seedCase({ companyId: company.id, expertProfileId: expert.id });
    const without = await seedCase({ companyId: company.id, expertProfileId: expert.id });

    await actionItemFactory({
      engagementId: withItems,
      createdByUserId: author.id,
      values: { assigneeParty: 'client' },
    });
    await actionItemFactory({
      engagementId: withItems,
      createdByUserId: author.id,
      values: { assigneeParty: 'client' },
    });
    await actionItemFactory({
      engagementId: withItems,
      createdByUserId: author.id,
      values: { assigneeParty: 'expert' },
    });
    await actionItemFactory({
      engagementId: withItems,
      createdByUserId: author.id,
      values: { assigneeParty: null },
    });
    // Excluded: a DONE item and a soft-deleted one.
    await actionItemFactory({
      engagementId: withItems,
      createdByUserId: author.id,
      values: { assigneeParty: 'client', status: 'done', completedAt: new Date() },
    });
    await actionItemFactory({
      engagementId: withItems,
      createdByUserId: author.id,
      values: { assigneeParty: 'expert', deletedAt: new Date() },
    });

    const counts = await casesIndexRepository.countOpenActionItemsByParty([withItems, without]);
    expect(counts.get(withItems)).toEqual({ client: 2, expert: 1, unassigned: 1 });
    expect(counts.get(without)).toEqual({ client: 0, expert: 0, unassigned: 0 });
    expect(counts.size).toBe(2);
  });
});

// ── 7 · Column hygiene — the repository-side half of the AC's key-set test ────────────────────

describe('casesIndexRepository — column hygiene', () => {
  const OPEN_ROW_KEYS = [
    'engagementId',
    'title',
    'createdAt',
    'resolutionRequestedAt',
    'resolutionRequestedByUserId',
    'companyId',
    'companyName',
    'expertProfileId',
    'expertUserId',
    'expertFirstName',
    'expertLastName',
    'expertAvatarUrl',
    'expertUsername',
    'expertHeadline',
    'expertType',
    'agencyId',
    'agencyName',
    'nextBookingAt',
    'lastHeldAt',
    'heldCount',
    'bucket',
    'sortRank',
  ] as const;

  const RESOLVED_ROW_KEYS = [
    'engagementId',
    'title',
    'companyId',
    'companyName',
    'expertProfileId',
    'expertUserId',
    'expertFirstName',
    'expertLastName',
    'expertAvatarUrl',
    'expertUsername',
    'expertHeadline',
    'expertType',
    'agencyId',
    'agencyName',
    'closedAt',
    'closeReason',
    'heldCount',
    'closedAtEpoch',
  ] as const;

  /** Nothing here may ever ride a case row onto a client surface. */
  const DENYLIST = [
    'rateCents',
    'rate_cents',
    'stripeConnectId',
    'declineNote',
    'baloFeeBps',
    'bookingIdempotencyKey',
    'joinUrl',
    'dailyRoomName',
    'email',
    'workosId',
    'phone',
  ] as const;

  it('the open row carries EXACTLY the allow-listed keys, and none of the denylist', async () => {
    const world = await seedWorld();
    const [row] = (
      await casesIndexRepository.listOpenCases(
        { side: 'company', companyId: world.companyId },
        { limit: 24 }
      )
    ).rows;
    if (row === undefined) throw new Error('expected an open row');

    expect(Object.keys(row).sort()).toEqual([...OPEN_ROW_KEYS].sort());
    expect(Object.keys(row)).toHaveLength(OPEN_ROW_KEYS.length);
    for (const forbidden of DENYLIST) {
      expect(Object.keys(row)).not.toContain(forbidden);
    }
  });

  it('the resolved row carries EXACTLY the allow-listed keys, and none of the denylist', async () => {
    const company = await companyFactory();
    const expert = await expertFactory();
    const closer = await userFactory();
    await companyMemberFactory({ companyId: company.id, userId: closer.id });
    await seedCase({
      companyId: company.id,
      expertProfileId: expert.id,
      closedAt: new Date(),
      closedByUserId: closer.id,
    });

    const [row] = (
      await casesIndexRepository.listResolvedCases(
        { side: 'company', companyId: company.id },
        { limit: 20 }
      )
    ).rows;
    if (row === undefined) throw new Error('expected a resolved row');

    expect(Object.keys(row).sort()).toEqual([...RESOLVED_ROW_KEYS].sort());
    expect(Object.keys(row)).toHaveLength(RESOLVED_ROW_KEYS.length);
    for (const forbidden of DENYLIST) {
      expect(Object.keys(row)).not.toContain(forbidden);
    }
  });

  it('a soft-deleted expert USER keeps the case listed, with null names — the filter is in the JOIN', async () => {
    const company = await companyFactory();
    const expert = await expertFactory();
    const engagementId = await seedCase({ companyId: company.id, expertProfileId: expert.id });
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, expert.userId));

    const [row] = (
      await casesIndexRepository.listOpenCases(
        { side: 'company', companyId: company.id },
        { limit: 24 }
      )
    ).rows;
    if (row === undefined) throw new Error('a soft-deleted expert user must not drop the case');
    expect(row.engagementId).toBe(engagementId);
    expect(row.expertFirstName).toBeNull();
    expect(row.expertLastName).toBeNull();
    expect(row.expertUserId).toBe(expert.userId);
  });

  it('an agency expert carries the agency name; an independent expert carries null', async () => {
    const world = await seedWorld();
    const rows = (
      await casesIndexRepository.listOpenCases(
        { side: 'company', companyId: world.companyId },
        { limit: 24 }
      )
    ).rows;
    const agencyRow = rows.find((row) => row.engagementId === world.caseId);
    const independentRow = rows.find((row) => row.engagementId === world.dualCaseId);
    if (agencyRow === undefined || independentRow === undefined) {
      throw new Error('expected both fixture cases');
    }
    expect(agencyRow.agencyId).toBe(world.agencyId);
    expect(agencyRow.agencyName).not.toBeNull();
    expect(independentRow.agencyId).toBeNull();
    expect(independentRow.agencyName).toBeNull();
  });
});
