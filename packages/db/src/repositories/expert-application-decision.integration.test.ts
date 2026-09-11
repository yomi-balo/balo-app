import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../client';
import { auditEvents, expertProfiles, users, type ExpertProfile } from '../schema';
import { agencyFactory, expertDraftFactory, userFactory } from '../test/factories';
import {
  expertsRepository,
  type ApplicationReviewFilter,
  type DecideApplicationResult,
  type PendingApplicationStatus,
} from './experts';
import type { ExpertDeclineReason } from '../schema';

/**
 * BAL-549 / ADR-1030 — THE EXPERT-APPLICATION DECISION, end to end against real Postgres.
 *
 * This suite is the stand-in for the coherence CHECK that migration 0090 CANNOT carry:
 * `application_status IN ('approved','rejected') ⟺ decided_at IS NOT NULL` would fail validation
 * on ADD, because ~every pre-BAL-549 `approved` row has a NULL `decided_at` and `approved_at`
 * carries no actor to backfill a decider from. Coherence is therefore the repository path's job,
 * and §1 below is what pins it.
 *
 * ⚠ WHAT THIS SUITE STRUCTURALLY CANNOT CATCH, stated so nobody reads a green run as more than
 * it is. The harness swaps the base `db` for an outer transaction (`test/setup-integration.ts`),
 * so `db.transaction` inside `decideApplication` becomes a SAVEPOINT and EVERY write — whether
 * it goes to `tx` or to the base `db` — lands in the same rolled-back transaction. Two real
 * defects are therefore invisible here, and both were mutation-checked to confirm it:
 *   · `auditEventsRepository.record(…, db)` instead of `(…, tx)` — VERIFIED still green. The
 *     audit row's participation in the caller's transaction is held by the `record(input, exec)`
 *     signature and by review, never by this file.
 *   · a `decideApplication` that called `usersRepository.update` (which opens its OWN
 *     transaction against the base `db`) instead of writing on `tx` — same reason, plus it would
 *     take a second pooled connection in production.
 * The same harness (`max: 1`, one transaction per test) makes a genuine two-staffer RACE
 * inexpressible; the row lock and the fixed lock order are argued by inspection in
 * `decideApplication`'s docblock.
 *
 * WHAT IT DOES CATCH was confirmed the same way — reverting any one of these turns the named
 * test red: the `'under_review'` arm of the pending guard (D4), the `isNull(users.deletedAt)`
 * term on the `activeMode` write, the `columns` narrowing on `findApplicationWithRelations`'
 * `user` relation, `hasNote` in place of the note text, and the `activeMode` write targeting the
 * LOCKED row's `userId` rather than any caller-supplied id (the IDOR).
 */

const DAY_MS = 86_400_000;
const NOTE_TEXT = 'Two Salesforce projects, both as an admin — we need delivery lead depth.';

/** An actor with a staff role. Attribution only — the capability gate lives in `apps/web`. */
async function seedActor(): Promise<string> {
  return (await userFactory({ platformRole: 'admin' })).id;
}

/**
 * A pending application at a chosen status and submission instant. Written directly rather than
 * through `submitApplication`, because `'under_review'` has no writer in this repository (D4 —
 * latent, not dead) and because every list assertion needs a CONTROLLED `submitted_at`.
 */
async function seedPendingApplication(
  values: {
    status?: PendingApplicationStatus;
    submittedAt?: Date;
    agencyId?: string;
    userId?: string;
  } = {}
): Promise<ExpertProfile> {
  const draft = await expertDraftFactory(
    values.userId === undefined ? {} : { userId: values.userId }
  );
  const [profile] = await db
    .update(expertProfiles)
    .set({
      applicationStatus: values.status ?? 'submitted',
      submittedAt: values.submittedAt ?? new Date(Date.now() - DAY_MS),
      ...(values.agencyId === undefined ? {} : { agencyId: values.agencyId }),
    })
    .where(eq(expertProfiles.id, draft.id))
    .returning();
  if (profile === undefined) throw new Error('seedPendingApplication: update matched no row');
  return profile;
}

/** Every audit row this ticket can write, for one profile, in append order. */
async function readDecisionAudit(
  expertProfileId: string
): Promise<{ action: string; actorUserId: string | null; metadata: unknown; id: string }[]> {
  return db
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      actorUserId: auditEvents.actorUserId,
      metadata: auditEvents.metadata,
    })
    .from(auditEvents)
    .where(
      and(eq(auditEvents.entityType, 'expert_profile'), eq(auditEvents.entityId, expertProfileId))
    )
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.seq));
}

async function readProfile(expertProfileId: string): Promise<ExpertProfile> {
  const [row] = await db
    .select()
    .from(expertProfiles)
    .where(eq(expertProfiles.id, expertProfileId));
  if (row === undefined) throw new Error(`profile not found: ${expertProfileId}`);
  return row;
}

async function readUserMode(
  userId: string
): Promise<{ activeMode: string; deletedAt: Date | null }> {
  const [row] = await db
    .select({ activeMode: users.activeMode, deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.id, userId));
  if (row === undefined) throw new Error(`user not found: ${userId}`);
  return row;
}

/** The `decided` arm, or a failure naming the outcome that actually came back. */
function expectDecided(
  result: DecideApplicationResult
): Extract<DecideApplicationResult, { outcome: 'decided' }> {
  if (result.outcome !== 'decided') {
    throw new Error(`expected outcome 'decided', got '${result.outcome}'`);
  }
  return result;
}

type Decided = Extract<DecideApplicationResult, { outcome: 'decided' }>;

/** Approve one application and assert the `decided` arm. */
async function approve(expertProfileId: string, actorUserId: string): Promise<Decided> {
  return expectDecided(
    await expertsRepository.decideApplication({
      expertProfileId,
      actorUserId,
      decision: 'approve',
    })
  );
}

/** Decline one application and assert the `decided` arm. */
async function decline(
  expertProfileId: string,
  actorUserId: string,
  reason: ExpertDeclineReason = 'not_a_fit',
  note: string = NOTE_TEXT
): Promise<Decided> {
  return expectDecided(
    await expertsRepository.decideApplication({
      expertProfileId,
      actorUserId,
      decision: 'decline',
      reason,
      note,
    })
  );
}

/** The list read's caller-side constants, restated so the suite pins the same window shape. */
function listFor(
  filter: ApplicationReviewFilter,
  overrides: { decidedSince?: Date; limit?: number } = {}
): ReturnType<typeof expertsRepository.listApplicationsForReview> {
  return expertsRepository.listApplicationsForReview({
    filter,
    decidedSince: overrides.decidedSince ?? new Date(Date.now() - 30 * DAY_MS),
    limit: overrides.limit ?? 100,
  });
}

// ── §1 — coherence: the four floor columns land together ───────────────────────────────────

describe('decideApplication — §1 stamps the ADR-1030 floor columns', () => {
  it.each(['submitted', 'under_review'] as const)(
    'approves from %s and stamps status, approved_at, decided_at and decided_by',
    async (status) => {
      const actorUserId = await seedActor();
      const profile = await seedPendingApplication({ status });

      const result = await approve(profile.id, actorUserId);

      expect(result.previousStatus).toBe(status);

      const row = await readProfile(profile.id);
      expect(row.applicationStatus).toBe('approved');
      expect(row.approvedAt).not.toBeNull();
      expect(row.decidedAt).not.toBeNull();
      expect(row.decidedByUserId).toBe(actorUserId);
      // Both stamps come from the SAME `Date` instance on the approve arm.
      expect(row.decidedAt?.getTime()).toBe(row.approvedAt?.getTime());
    }
  );

  it('declines and stamps status=rejected, decided_at, decided_by, decline_reason and decline_note', async () => {
    const actorUserId = await seedActor();
    const profile = await seedPendingApplication();

    await decline(profile.id, actorUserId, 'experience_depth', NOTE_TEXT);

    const row = await readProfile(profile.id);
    // ⚠ THE STORED LABEL IS `rejected`; every SURFACE says "declined" (orchestrator D2).
    expect(row.applicationStatus).toBe('rejected');
    expect(row.decidedAt).not.toBeNull();
    expect(row.decidedByUserId).toBe(actorUserId);
    expect(row.declineReason).toBe('experience_depth');
    expect(row.declineNote).toBe(NOTE_TEXT);
    // A declined application never had an approval.
    expect(row.approvedAt).toBeNull();
  });

  it('leaves decline_reason and decline_note NULL on an approve', async () => {
    const actorUserId = await seedActor();
    const profile = await seedPendingApplication();

    await approve(profile.id, actorUserId);

    const row = await readProfile(profile.id);
    expect(row.declineReason).toBeNull();
    expect(row.declineNote).toBeNull();
  });
});

// ── §2 — refusal: the discriminated outcomes, and that they write NOTHING ───────────────────

describe('decideApplication — §2 refuses a non-pending application', () => {
  it.each(['draft', 'approved', 'rejected'] as const)(
    'refuses a %s application with outcome not_pending and changes NOTHING',
    async (status) => {
      const actorUserId = await seedActor();
      const draft = await expertDraftFactory();
      await db
        .update(expertProfiles)
        .set({ applicationStatus: status })
        .where(eq(expertProfiles.id, draft.id));

      const result = await expertsRepository.decideApplication({
        expertProfileId: draft.id,
        actorUserId,
        decision: 'approve',
      });

      expect(result.outcome).toBe('not_pending');
      if (result.outcome === 'not_pending') {
        expect(result.currentStatus).toBe(status);
      }

      const row = await readProfile(draft.id);
      expect(row.applicationStatus).toBe(status);
      expect(row.decidedAt).toBeNull();
      expect(row.decidedByUserId).toBeNull();
      expect(await readDecisionAudit(draft.id)).toHaveLength(0);
    }
  );

  it('returns not_found for an unknown profile id and writes no audit row', async () => {
    const actorUserId = await seedActor();
    const unknownId = randomUUID();

    const result = await expertsRepository.decideApplication({
      expertProfileId: unknownId,
      actorUserId,
      decision: 'approve',
    });

    expect(result.outcome).toBe('not_found');
    expect(await readDecisionAudit(unknownId)).toHaveLength(0);
  });
});

// ── §3 — atomicity: profile write + activeMode flip + audit row, in ONE transaction ─────────

describe('decideApplication — §3 writes all three halves together', () => {
  it('approve writes the profile change, the activeMode flip and the audit row', async () => {
    const actorUserId = await seedActor();
    const applicant = await userFactory({ activeMode: 'client' });
    const profile = await seedPendingApplication({ userId: applicant.id });

    await approve(profile.id, actorUserId);

    expect((await readProfile(profile.id)).applicationStatus).toBe('approved');
    expect((await readUserMode(applicant.id)).activeMode).toBe('expert');
    expect(await readDecisionAudit(profile.id)).toHaveLength(1);
  });

  it('a decline does NOT touch active_mode', async () => {
    const actorUserId = await seedActor();
    const applicant = await userFactory({ activeMode: 'client' });
    const profile = await seedPendingApplication({ userId: applicant.id });

    await decline(profile.id, actorUserId, 'not_a_fit', NOTE_TEXT);

    expect((await readUserMode(applicant.id)).activeMode).toBe('client');
  });

  it('the activeMode flip targets the profile OWNER, not any id the caller supplies', async () => {
    const actorUserId = await seedActor();
    const applicantA = await userFactory({ activeMode: 'client' });
    const applicantB = await userFactory({ activeMode: 'client' });
    const profileA = await seedPendingApplication({ userId: applicantA.id });
    await seedPendingApplication({ userId: applicantB.id });

    const result = await approve(profileA.id, actorUserId);

    // The applicant is resolved FROM THE LOCKED ROW — there is no parameter for it.
    expect(result.applicantUserId).toBe(applicantA.id);
    expect((await readUserMode(applicantA.id)).activeMode).toBe('expert');
    expect((await readUserMode(applicantB.id)).activeMode).toBe('client');
  });

  it('does not resurrect a soft-deleted applicant — the users row is not written', async () => {
    const actorUserId = await seedActor();
    const applicant = await userFactory({ activeMode: 'client' });
    const profile = await seedPendingApplication({ userId: applicant.id });
    const deletedAt = new Date();
    await db.update(users).set({ deletedAt }).where(eq(users.id, applicant.id));

    await approve(profile.id, actorUserId);

    // The profile decision still lands — there is nothing to un-decide.
    expect((await readProfile(profile.id)).applicationStatus).toBe('approved');
    const userRow = await readUserMode(applicant.id);
    expect(userRow.activeMode).toBe('client');
    expect(userRow.deletedAt).not.toBeNull();
  });
});

// ── §4 — the append-only audit contract ────────────────────────────────────────────────────

describe('decideApplication — §4 the audit row', () => {
  it('is expert_application.approved on entity_type expert_profile with the exact metadata key set', async () => {
    const actorUserId = await seedActor();
    const profile = await seedPendingApplication({ status: 'under_review' });
    const result = await approve(profile.id, actorUserId);

    const [row] = await readDecisionAudit(profile.id);
    expect(row?.action).toBe('expert_application.approved');
    // ⚠ EXACT KEY SET, not `objectContaining` — `audit_events` is append-only, so this shape is
    // unrecoverable if it ships wrong.
    expect(Object.keys(row?.metadata as Record<string, unknown>).sort()).toEqual([
      'applicantUserId',
      'previousStatus',
    ]);
    expect(row?.metadata).toMatchObject({
      previousStatus: 'under_review',
      applicantUserId: result.applicantUserId,
    });
  });

  it('carries reason and hasNote on a decline, and NEVER the note text', async () => {
    const actorUserId = await seedActor();
    const profile = await seedPendingApplication();

    await decline(profile.id, actorUserId, 'credentials_unverified', NOTE_TEXT);

    const [row] = await readDecisionAudit(profile.id);
    expect(row?.action).toBe('expert_application.declined');
    expect(Object.keys(row?.metadata as Record<string, unknown>).sort()).toEqual([
      'applicantUserId',
      'hasNote',
      'previousStatus',
      'reason',
    ]);
    expect(row?.metadata).toMatchObject({ reason: 'credentials_unverified', hasNote: true });
    // ⚠ THE NOTE-CONTAINMENT PROOF AT THE AUDIT LAYER.
    expect(JSON.stringify(row?.metadata)).not.toContain(NOTE_TEXT);
  });

  it('records hasNote false for an empty note', async () => {
    const actorUserId = await seedActor();
    const profile = await seedPendingApplication();

    await decline(profile.id, actorUserId, 'application_incomplete', '');

    const [row] = await readDecisionAudit(profile.id);
    expect(row?.metadata).toMatchObject({ hasNote: false });
  });

  it('names the ACTOR, not the applicant', async () => {
    const actorUserId = await seedActor();
    const applicant = await userFactory();
    const profile = await seedPendingApplication({ userId: applicant.id });

    await approve(profile.id, actorUserId);

    const [row] = await readDecisionAudit(profile.id);
    expect(row?.actorUserId).toBe(actorUserId);
    expect(row?.actorUserId).not.toBe(applicant.id);
  });

  it('returns the audit row id as auditEventId — colon-free, and resolving to THIS decision', async () => {
    const actorUserId = await seedActor();
    const profile = await seedPendingApplication();

    const result = await approve(profile.id, actorUserId);

    // ⚠ COLON-FREE: this id becomes half of the BullMQ jobId (orchestrator D5).
    expect(result.auditEventId).not.toContain(':');
    expect(result.auditEventId).not.toBe(profile.id);

    const [row] = await readDecisionAudit(profile.id);
    expect(row?.id).toBe(result.auditEventId);
  });
});

// ── §5 — rollback: a failure after the profile write undoes everything ──────────────────────

describe('decideApplication — §5 rolls the whole decision back on failure', () => {
  it('leaves no profile change, no activeMode change and no audit row', async () => {
    const applicant = await userFactory({ activeMode: 'client' });
    const profile = await seedPendingApplication({ userId: applicant.id });
    // A `decided_by_user_id` that names no `users` row violates the FK on the profile write.
    //
    // ⚠ WHAT THIS PROVES AND WHAT IT DOES NOT. The failure lands ON step 3, so the later steps
    // never run and their absence is not evidence that they would have been undone. What it DOES
    // pin is that the method has NO pre-write half that escapes the failure — no `activeMode`
    // flip ahead of the profile write, no audit row recorded optimistically before the row is
    // known to be writable. A failure AFTER the audit row is unreachable (the audit row is last)
    // and, per the header, would be invisible under this harness anyway.
    const ghostActorId = randomUUID();

    await expect(
      expertsRepository.decideApplication({
        expertProfileId: profile.id,
        actorUserId: ghostActorId,
        decision: 'approve',
      })
    ).rejects.toThrow();

    const row = await readProfile(profile.id);
    expect(row.applicationStatus).toBe('submitted');
    expect(row.decidedAt).toBeNull();
    expect(row.decidedByUserId).toBeNull();
    expect((await readUserMode(applicant.id)).activeMode).toBe('client');
    expect(await readDecisionAudit(profile.id)).toHaveLength(0);
  });
});

// ── §6 — listApplicationsForReview ──────────────────────────────────────────────────────────

describe('listApplicationsForReview', () => {
  it('pending returns both pending labels, oldest submission first', async () => {
    const older = await seedPendingApplication({
      status: 'under_review',
      submittedAt: new Date(Date.now() - 5 * DAY_MS),
    });
    const newer = await seedPendingApplication({
      status: 'submitted',
      submittedAt: new Date(Date.now() - 1 * DAY_MS),
    });

    const list = await listFor('pending');
    const ids = list.rows.map((row) => row.expertProfileId);

    expect(ids).toContain(older.id);
    expect(ids).toContain(newer.id);
    expect(ids.indexOf(older.id)).toBeLessThan(ids.indexOf(newer.id));
  });

  it('projects the applicant, the agency and the decline reason — and never the note', async () => {
    const actorUserId = await seedActor();
    const agency = await agencyFactory({ name: 'CloudPeak' });
    const applicant = await userFactory({ firstName: 'Priya', lastName: 'Nair' });
    const profile = await seedPendingApplication({ userId: applicant.id, agencyId: agency.id });

    await decline(profile.id, actorUserId, 'not_a_fit', NOTE_TEXT);

    const list = await listFor('declined');
    const row = list.rows.find((candidate) => candidate.expertProfileId === profile.id);

    expect(row).toBeDefined();
    expect(row?.applicantUserId).toBe(applicant.id);
    expect(row?.firstName).toBe('Priya');
    expect(row?.email).toBe(applicant.email);
    expect(row?.agencyName).toBe('CloudPeak');
    expect(row?.declineReason).toBe('not_a_fit');
    // ⚠ THE NOTE-CONTAINMENT PROOF AT THE LIST LAYER: it is not on this projection at all.
    expect(row).not.toHaveProperty('declineNote');
    expect(JSON.stringify(row)).not.toContain(NOTE_TEXT);
  });

  it('declined reads the STORED rejected label', async () => {
    const actorUserId = await seedActor();
    const profile = await seedPendingApplication();
    await decline(profile.id, actorUserId, 'not_a_fit', NOTE_TEXT);

    const list = await listFor('declined');
    const row = list.rows.find((candidate) => candidate.expertProfileId === profile.id);
    expect(row?.applicationStatus).toBe('rejected');
    expect(list.counts.declined).toBeGreaterThanOrEqual(1);
  });

  it('the decided arms exclude a decision older than decidedSince', async () => {
    const actorUserId = await seedActor();
    const profile = await seedPendingApplication();
    await approve(profile.id, actorUserId);
    // Age the decision past the window.
    await db
      .update(expertProfiles)
      .set({ decidedAt: new Date(Date.now() - 400 * DAY_MS) })
      .where(eq(expertProfiles.id, profile.id));

    const list = await listFor('approved');
    expect(list.rows.map((row) => row.expertProfileId)).not.toContain(profile.id);
  });

  it('the approved count excludes a pre-BAL-549 approval (approved_at set, decided_at NULL)', async () => {
    const before = (await listFor('approved')).counts.approved;

    const legacy = await seedPendingApplication();
    await db
      .update(expertProfiles)
      .set({ applicationStatus: 'approved', approvedAt: new Date(), decidedAt: null })
      .where(eq(expertProfiles.id, legacy.id));

    const list = await listFor('approved');
    expect(list.counts.approved).toBe(before);
    expect(list.rows.map((row) => row.expertProfileId)).not.toContain(legacy.id);
  });

  it('drops an application whose applicant user is soft-deleted', async () => {
    const applicant = await userFactory();
    const profile = await seedPendingApplication({ userId: applicant.id });
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, applicant.id));

    const list = await listFor('pending');
    expect(list.rows.map((row) => row.expertProfileId)).not.toContain(profile.id);
  });

  it('keeps a row whose DECIDER is soft-deleted, with the attribution still hydrated', async () => {
    const actorUserId = await seedActor();
    const profile = await seedPendingApplication();
    await approve(profile.id, actorUserId);
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, actorUserId));

    const list = await listFor('approved');
    const row = list.rows.find((candidate) => candidate.expertProfileId === profile.id);
    // The decider filter lives in the JOIN CONDITION, so the LEFT JOIN keeps the parent row.
    expect(row).toBeDefined();
    // …and the decider is dropped to NULL rather than dropping the application.
    expect(row?.decidedByFirstName).toBeNull();
  });

  it('hydrates the decider name when they are live', async () => {
    const actor = await userFactory({ platformRole: 'admin', firstName: 'Adeeb', lastName: 'K' });
    const profile = await seedPendingApplication();
    await approve(profile.id, actor.id);

    const list = await listFor('approved');
    const row = list.rows.find((candidate) => candidate.expertProfileId === profile.id);
    expect(row?.decidedByFirstName).toBe('Adeeb');
    expect(row?.decidedByLastName).toBe('K');
  });

  it('sets truncated when the batch fills, and clears it when it does not', async () => {
    await seedPendingApplication({ submittedAt: new Date(Date.now() - 3 * DAY_MS) });
    await seedPendingApplication({ submittedAt: new Date(Date.now() - 2 * DAY_MS) });

    const filled = await listFor('pending', { limit: 1 });
    expect(filled.rows).toHaveLength(1);
    expect(filled.truncated).toBe(true);

    const roomy = await listFor('pending', { limit: 500 });
    expect(roomy.truncated).toBe(false);
  });

  it('counts every pending application, independent of the decidedSince window', async () => {
    const before = (await listFor('pending')).counts.pending;
    await seedPendingApplication({ submittedAt: new Date(Date.now() - 900 * DAY_MS) });

    const list = await listFor('pending');
    expect(list.counts.pending).toBe(before + 1);
  });
});

// ── §7 — findApplicationWithRelations, widened ──────────────────────────────────────────────

describe('findApplicationWithRelations', () => {
  it('returns the applicant with NARROWED columns — never workosId', async () => {
    const applicant = await userFactory();
    const profile = await seedPendingApplication({ userId: applicant.id });

    const app = await expertsRepository.findApplicationWithRelations(profile.id);

    expect(app).toBeDefined();
    expect(app?.user.id).toBe(applicant.id);
    // ⚠ THE OVER-HYDRATION PROOF: an exact key set, so `columns: true` goes red here.
    expect(Object.keys(app?.user ?? {}).sort()).toEqual([
      'avatarUrl',
      'country',
      'countryCode',
      'deletedAt',
      'email',
      'firstName',
      'id',
      'lastName',
      'phone',
      'timezone',
    ]);
    expect(app?.user).not.toHaveProperty('workosId');
    expect(app?.user).not.toHaveProperty('platformRole');
  });

  it('returns agency null for an independent expert, and the narrowed agency otherwise', async () => {
    const independent = await seedPendingApplication();
    expect(
      (await expertsRepository.findApplicationWithRelations(independent.id))?.agency
    ).toBeNull();

    const agency = await agencyFactory({ name: 'CloudPeak' });
    const affiliated = await seedPendingApplication({ agencyId: agency.id });
    const app = await expertsRepository.findApplicationWithRelations(affiliated.id);

    expect(app?.agency?.name).toBe('CloudPeak');
    expect(Object.keys(app?.agency ?? {}).sort()).toEqual(['id', 'logoUrl', 'name', 'slug']);
    expect(app?.agency).not.toHaveProperty('stripeConnectId');
  });

  it('returns undefined for an unknown profile id', async () => {
    expect(await expertsRepository.findApplicationWithRelations(randomUUID())).toBeUndefined();
  });

  /**
   * ⚠⚠ THE FIX-ROUND F1 CONTAINMENT PROOF, AT THE PROJECTION LAYER.
   *
   * This read is the APPLICANT'S OWN (`load-draft.ts` → `expert-application-wizard.tsx`, a
   * `'use client'` boundary), and the decline email sends a declined applicant straight to it.
   * Before the fix the top-level select had no `columns:` at all, so the bare row — `decline_note`
   * included — was serialised into their browser.
   *
   * MUTATION-PROVEN: delete `columns: APPLICATION_PROFILE_COLUMNS` from
   * `findApplicationWithRelations` and both assertions below go red.
   */
  it('never projects the staff-only decline_note, even on a DECLINED application', async () => {
    const actorUserId = await seedActor();
    const profile = await seedPendingApplication();
    await decline(profile.id, actorUserId, 'experience_depth', NOTE_TEXT);

    const app = await expertsRepository.findApplicationWithRelations(profile.id);

    expect(app).toBeDefined();
    expect(app?.profile.applicationStatus).toBe('rejected');
    expect(app?.profile).not.toHaveProperty('declineNote');
    // The whole-payload shape: nothing anywhere under `draft` carries the note text.
    expect(JSON.stringify(app)).not.toContain(NOTE_TEXT);
  });

  it('omits stripeConnectId and searchVector from the applicant projection', async () => {
    const profile = await seedPendingApplication();
    const app = await expertsRepository.findApplicationWithRelations(profile.id);

    expect(app?.profile).not.toHaveProperty('stripeConnectId');
    expect(app?.profile).not.toHaveProperty('searchVector');
    // The allow-list is a narrowing, not a gutting — the wizard's own fields survive.
    expect(app?.profile.id).toBe(profile.id);
    expect(app?.profile).toHaveProperty('headline');
    expect(app?.profile).toHaveProperty('submittedAt');
    expect(app?.profile).toHaveProperty('declineReason');
  });
});

// ── §7b — findApplicationForStaffReview, the ONE carrier of the note ────────────────────────

describe('findApplicationForStaffReview', () => {
  it('DOES carry the decline_note — it is the staff read', async () => {
    const actorUserId = await seedActor();
    const profile = await seedPendingApplication();
    await decline(profile.id, actorUserId, 'experience_depth', NOTE_TEXT);

    const app = await expertsRepository.findApplicationForStaffReview(profile.id);

    expect(app?.profile.declineNote).toBe(NOTE_TEXT);
    expect(app?.profile.declineReason).toBe('experience_depth');
  });

  it('carries declineNote: null on an APPROVED application, and returns the same relations', async () => {
    const actorUserId = await seedActor();
    const agency = await agencyFactory({ name: 'CloudPeak' });
    const applicant = await userFactory({ firstName: 'Priya' });
    const profile = await seedPendingApplication({ userId: applicant.id, agencyId: agency.id });
    await approve(profile.id, actorUserId);

    const app = await expertsRepository.findApplicationForStaffReview(profile.id);

    expect(app?.profile.declineNote).toBeNull();
    expect(app?.user.id).toBe(applicant.id);
    expect(app?.agency?.name).toBe('CloudPeak');
    // Still the narrowed applicant projection — the staff read widens by ONE column, not by the row.
    expect(app?.user).not.toHaveProperty('workosId');
    expect(app?.profile).not.toHaveProperty('stripeConnectId');
  });

  it('returns undefined for an unknown profile id', async () => {
    expect(await expertsRepository.findApplicationForStaffReview(randomUUID())).toBeUndefined();
  });
});
