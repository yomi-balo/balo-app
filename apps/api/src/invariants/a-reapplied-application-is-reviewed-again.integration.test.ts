import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BAL-557 — INVARIANT, END TO END AGAINST A REAL POSTGRES: a declined applicant who starts a
 * new application and resubmits is REVIEWED AGAIN — exactly one open `admin_alerts` row for
 * `(expert.application_pending, profileId)` after the resubmit, with the decline-era resolved
 * row still present, and the SECOND confirmation email is not deduped against the first's
 * retained BullMQ job because `correlationId` is the per-write audit row id, never the profile
 * id.
 *
 * ── WHAT IS DRIVEN ──────────────────────────────────────────────────────────────────────
 * Only production entry points: `usersRepository.create`, `referenceDataRepository.
 * getSalesforceVertical`, `expertsRepository.{createDraft,submitApplication,decideApplication,
 * reopenApplication}`, and `runAdminAlertSweep('1m', now)`. The cooldown is set to 0 with a
 * direct in-tx `UPDATE platform_settings` (no repository setter exists — this is a test-only
 * write, never a production path) so the reopen in this suite is never blocked by it.
 *
 * ── MOCKS (and only these) ──────────────────────────────────────────────────────────────
 * `../lib/queue.js` `getQueue` — BullMQ would open a Redis connection. The double REPRODUCES
 * BullMQ's own dedup semantics (`queue.add` with a jobId already seen is a silent no-op), so it
 * is the arbiter for the "receives two jobs" / "receives one job" assertions below. `@balo/db`
 * stays REAL. This file runs from `packages/db/vitest.config.integration.ts`.
 */

const { mockGetQueue, seenJobIds } = vi.hoisted(() => {
  const seen = new Set<string>();
  const add = vi.fn(async (_name: string, _data: unknown, opts: { jobId: string }) => {
    if (seen.has(opts.jobId)) return undefined;
    seen.add(opts.jobId);
    return { id: opts.jobId };
  });
  return { mockGetQueue: vi.fn(() => ({ add })), seenJobIds: seen };
});

vi.mock('../lib/queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  getQueue: mockGetQueue,
}));

import { randomUUID } from 'node:crypto';
import {
  adminAlerts,
  and,
  auditEvents,
  db,
  eq,
  expertProfiles,
  expertsRepository,
  platformSettings,
  referenceDataRepository,
  usersRepository,
  type ExpertProfile,
} from '@balo/db';
import { buildExpertApplicationSubmittedPayload } from '@balo/shared/notifications';
import { runAdminAlertSweep } from '../jobs/admin-alert-sweep.js';
import { notificationEvents } from '../notifications/publisher.js';

const MS_PER_HOUR = 60 * 60 * 1000;

async function seedDraftProfile(): Promise<ExpertProfile> {
  const marker = randomUUID();
  const user = await usersRepository.create({
    workosId: `bal557_applicant_${marker}`,
    email: `bal557-applicant-${marker}@test.local`,
    firstName: 'Reapplying',
    lastName: 'Applicant',
  });
  const vertical = await referenceDataRepository.getSalesforceVertical();
  return expertsRepository.createDraft({
    userId: user.id,
    verticalId: vertical.id,
    type: 'freelancer',
    firstName: 'Reapplying',
    lastName: 'Applicant',
  });
}

/** Test-only write: no repository setter exists for this (by design — a direct SQL `UPDATE`). */
async function setCooldownDays(days: number): Promise<void> {
  await db
    .update(platformSettings)
    .set({ value: days })
    .where(eq(platformSettings.key, 'expert_reapply_cooldown_days'));
}

async function openAlertRows(
  profileId: string
): Promise<{ id: string; resolvedAt: Date | null }[]> {
  return db
    .select({ id: adminAlerts.id, resolvedAt: adminAlerts.resolvedAt })
    .from(adminAlerts)
    .where(
      and(eq(adminAlerts.kind, 'expert.application_pending'), eq(adminAlerts.entityId, profileId))
    );
}

async function submittedAuditRows(profileId: string): Promise<{ id: string }[]> {
  return db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityType, 'expert_profile'),
        eq(auditEvents.entityId, profileId),
        eq(auditEvents.action, 'expert_application.submitted')
      )
    );
}

beforeEach(async () => {
  vi.clearAllMocks();
  seenJobIds.clear();
  await setCooldownDays(0);
});

describe('INVARIANT (end-to-end): a reapplied application is reviewed again', () => {
  it('⚠⚠ decline resolves the open row; reopen + resubmit gets exactly one fresh open row, the decline-era row stays resolved', async () => {
    const profile = await seedDraftProfile();
    const now = new Date();

    const firstSubmit = await expertsRepository.submitApplication({
      applicantUserId: profile.userId,
      verticalId: profile.verticalId,
      now,
    });
    expect(firstSubmit.outcome).toBe('submitted');

    // The pending-actions sweep sees it only once it's been waiting past its cutoff.
    const sweptAt = new Date(now.getTime() + 3 * MS_PER_HOUR);
    await runAdminAlertSweep('1m', sweptAt);
    const afterFirstSweep = await openAlertRows(profile.id);
    expect(afterFirstSweep.filter((row) => row.resolvedAt === null)).toHaveLength(1);

    const admin = await usersRepository.create({
      workosId: `bal557_admin_${randomUUID()}`,
      email: `bal557-admin-${randomUUID()}@test.local`,
      firstName: 'Staff',
      lastName: 'Reviewer',
    });
    const decision = await expertsRepository.decideApplication({
      expertProfileId: profile.id,
      actorUserId: admin.id,
      decision: 'decline',
      reason: 'not_a_fit',
      note: '',
    });
    expect(decision.outcome).toBe('decided');

    // The decline-era row resolves: the sweep no longer finds a pending application.
    await runAdminAlertSweep('1m', new Date(sweptAt.getTime() + 60_000));
    const afterDecline = await openAlertRows(profile.id);
    expect(afterDecline.filter((row) => row.resolvedAt === null)).toHaveLength(0);
    expect(afterDecline.filter((row) => row.resolvedAt !== null)).toHaveLength(1);
    const resolvedRowId = afterDecline[0]?.id;

    const reopenedAt = new Date(sweptAt.getTime() + 2 * 60_000);
    const reopened = await expertsRepository.reopenApplication({
      applicantUserId: profile.userId,
      verticalId: profile.verticalId,
      now: reopenedAt,
    });
    expect(reopened.outcome).toBe('reopened');

    const resubmittedAt = new Date(reopenedAt.getTime() + 60_000);
    const resubmit = await expertsRepository.submitApplication({
      applicantUserId: profile.userId,
      verticalId: profile.verticalId,
      now: resubmittedAt,
    });
    expect(resubmit.outcome).toBe('submitted');
    if (resubmit.outcome !== 'submitted' || firstSubmit.outcome !== 'submitted') {
      throw new Error('fixture: both submits must have succeeded');
    }
    // Two WRITES, two distinct audit ids — never the same id reused (the correlation key).
    expect(resubmit.auditEventId).not.toBe(firstSubmit.auditEventId);

    // Past the cutoff again: the resweep sees the resubmitted profile as newly pending because
    // `submitted_at` was refreshed by the resubmit.
    const finalSweep = new Date(resubmittedAt.getTime() + 3 * MS_PER_HOUR);
    await runAdminAlertSweep('1m', finalSweep);

    const finalRows = await openAlertRows(profile.id);
    const openRows = finalRows.filter((row) => row.resolvedAt === null);
    const stillResolvedRows = finalRows.filter((row) => row.resolvedAt !== null);
    // Exactly one open row for (expert.application_pending, profileId) — never more, never zero.
    expect(openRows).toHaveLength(1);
    // The old resolved row from the decline era SURVIVES — a resolved row is never reopened.
    expect(stillResolvedRows.map((row) => row.id)).toContain(resolvedRowId);
    expect(finalRows).toHaveLength(2);

    // Against real Postgres: both submits appended their own audit row.
    const auditRows = await submittedAuditRows(profile.id);
    expect(auditRows.map((row) => row.id).sort()).toEqual(
      [firstSubmit.auditEventId, resubmit.auditEventId].sort()
    );
  });

  it('⚠⚠ two submits of one profile publish distinct correlationIds that reach the dedup double as TWO jobs, never one', async () => {
    const profile = await seedDraftProfile();
    const now = new Date();

    const firstSubmit = await expertsRepository.submitApplication({
      applicantUserId: profile.userId,
      verticalId: profile.verticalId,
      now,
    });
    const admin = await usersRepository.create({
      workosId: `bal557_admin_${randomUUID()}`,
      email: `bal557-admin-${randomUUID()}@test.local`,
      firstName: 'Staff',
      lastName: 'Reviewer',
    });
    if (firstSubmit.outcome !== 'submitted') throw new Error('fixture: first submit failed');
    await expertsRepository.decideApplication({
      expertProfileId: profile.id,
      actorUserId: admin.id,
      decision: 'decline',
      reason: 'not_a_fit',
      note: '',
    });
    const reopened = await expertsRepository.reopenApplication({
      applicantUserId: profile.userId,
      verticalId: profile.verticalId,
      now: new Date(now.getTime() + 60_000),
    });
    if (reopened.outcome !== 'reopened') throw new Error('fixture: reopen failed');
    const resubmit = await expertsRepository.submitApplication({
      applicantUserId: profile.userId,
      verticalId: profile.verticalId,
      now: new Date(now.getTime() + 120_000),
    });
    if (resubmit.outcome !== 'submitted') throw new Error('fixture: resubmit failed');

    // ⚠⚠ THE FIX THIS PINS: `correlationId` is the per-write AUDIT ROW ID, not the profile id —
    // a per-profile id would collapse both publishes onto the SAME BullMQ jobId, and the
    // resubmission's confirmation email would silently never send.
    const firstPayload = buildExpertApplicationSubmittedPayload({
      userId: profile.userId,
      expertProfileId: profile.id,
      auditEventId: firstSubmit.auditEventId,
    });
    const secondPayload = buildExpertApplicationSubmittedPayload({
      userId: profile.userId,
      expertProfileId: profile.id,
      auditEventId: resubmit.auditEventId,
    });
    expect(firstPayload.correlationId).not.toBe(secondPayload.correlationId);

    await notificationEvents.publish('expert.application_submitted', firstPayload);
    await notificationEvents.publish('expert.application_submitted', secondPayload);
    expect(seenJobIds.size).toBe(2);
  });

  it('characterises the bug: a per-profile correlationId collapses two submits onto ONE job', async () => {
    // Not the shipped shape — `applicationId` standing in for `correlationId`, as the pre-BAL-557
    // payload did. This proves the dedup double is a real arbiter, not a tautology: the SAME
    // double that gave 2 jobs above gives exactly 1 here.
    const buggyFirst = { correlationId: 'profile-x', userId: 'user-x', applicationId: 'profile-x' };
    const buggySecond = {
      correlationId: 'profile-x',
      userId: 'user-x',
      applicationId: 'profile-x',
    };

    await notificationEvents.publish('expert.application_submitted', buggyFirst);
    await notificationEvents.publish('expert.application_submitted', buggySecond);
    expect(seenJobIds.size).toBe(1);
  });

  it('a caller cannot transition a profile they do not own', async () => {
    const profile = await seedDraftProfile();
    const other = await usersRepository.create({
      workosId: `bal557_other_${randomUUID()}`,
      email: `bal557-other-${randomUUID()}@test.local`,
      firstName: 'Someone',
      lastName: 'Else',
    });

    const reopenAsOther = await expertsRepository.reopenApplication({
      applicantUserId: other.id,
      verticalId: profile.verticalId,
      now: new Date(),
    });
    expect(reopenAsOther.outcome).toBe('not_found');

    const submitAsOther = await expertsRepository.submitApplication({
      applicantUserId: other.id,
      verticalId: profile.verticalId,
      now: new Date(),
    });
    expect(submitAsOther.outcome).toBe('not_found');

    // A's own row is untouched: still `draft`, so A's own submit still succeeds.
    const [unchangedRow] = await db
      .select({ applicationStatus: expertProfiles.applicationStatus })
      .from(expertProfiles)
      .where(eq(expertProfiles.id, profile.id));
    expect(unchangedRow?.applicationStatus).toBe('draft');
    const stillDraft = await expertsRepository.submitApplication({
      applicantUserId: profile.userId,
      verticalId: profile.verticalId,
      now: new Date(),
    });
    expect(stillDraft.outcome).toBe('submitted');
  });
});
