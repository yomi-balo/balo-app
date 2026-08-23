import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  availabilityRulesRepository,
  caseEngagementsRepository,
  companies,
  db,
  expertSearchabilityRepository,
  expertsRepository,
  partyMembershipsRepository,
  referenceDataRepository,
  usersRepository,
} from '@balo/db';
import { getSession } from '@/lib/auth/session';
import { deriveBookingIdempotencyKey } from '@/lib/booking/booking-idempotency';
import { requireE2ESecret } from '@/lib/e2e/require-e2e-secret';
import { log } from '@/lib/logging';

export const dynamic = 'force-dynamic';

/**
 * BAL-400 — E2E-only booking-context seeding harness (WorkOS + a real slot-availability
 * pipeline are both bypassed at the DATA level, never at the AUTHORIZATION level). Playwright
 * cannot otherwise reach the states the case-booking E2E suite needs to exercise: a bookable
 * expert (approved, searchable, with a real weekly availability schedule), a second company
 * membership for the current test user (the multi-company picker), and an existing open case
 * (the "attach" and idempotent-replay paths).
 *
 * SECURITY: gated by `requireE2ESecret` — the SAME gate `/api/auth/test-login` uses (see that
 * module's docblock for the full 404/production-inert / 401-mismatch / proceed contract). This
 * route does EXTRA privileged work (arbitrary company + case creation) compared to
 * `test-login`'s single hardcoded-role session mint, so it is even more important that it
 * cannot run without the secret — verified in this file's test by asserting every repository
 * call is unreached on both the 404 and 401 branches.
 *
 * Every write below goes through a real, unmodified PRODUCTION repository call — the same ones
 * `book-consultation.ts` and the onboarding/settings flows use — so what this route seeds is
 * indistinguishable, from the app's point of view, from data a real user produced. The two
 * deliberate shortcuts (documented at their call sites below) are: (1) `applySearchable` is
 * called with a hardcoded `searchable: true` rather than deriving it from the full onboarding
 * completeness checklist (`@balo/shared/experts`) — the same shortcut
 * `apps/api/src/services/seed/seed-service.ts`'s dev seeder takes; and (2) the expert's weekly
 * availability rules are wide-open (every day, all day) rather than a realistic partial
 * schedule, so a booking slot is always found without the test needing to reason about a
 * specific week.
 *
 * `kind: 'case'` optionally derives a `bookingIdempotencyKey` via the EXACT SAME
 * `deriveBookingIdempotencyKey` the real booking Server Action uses (`sha256(userId:nonce)`),
 * given a `bookingNonce`. This lets a test force the browser's `crypto.randomUUID()` (via
 * `page.addInitScript`) to a known value, seed a case whose key matches what the browser will
 * submit, and then genuinely exercise `resolveExistingCaseByKey` — the real "hop 1 succeeded,
 * hop 2 didn't, resubmitting recovers" replay path — through the real UI. It does NOT simulate
 * the `POST /meetings` failure itself (that hop is a server-to-server call the browser never
 * sees, so Playwright cannot drop it — see the E2E suite's own docblock for why).
 */

const WEEKLY_RULES = Array.from({ length: 7 }, (_, dayOfWeek) => ({
  dayOfWeek,
  startTime: '00:00',
  endTime: '23:45',
}));

const seedRequestSchema = z.discriminatedUnion('kind', [
  // A bookable expert: approved, searchable, wide-open weekly availability.
  z.object({ kind: z.literal('expert') }),
  // A second company for the CURRENT session's user (the multi-company picker).
  z.object({ kind: z.literal('company') }),
  // An existing open case for the CURRENT session's user's primary company + a named expert.
  z.object({
    kind: z.literal('case'),
    expertProfileId: z.string().uuid(),
    title: z.string().min(1).max(200),
    // See the module docblock — matches the exact browser-minted `bookingNonce` when present.
    bookingNonce: z.string().uuid().optional(),
  }),
]);

interface SeedExpertResult {
  expertProfileId: string;
  username: string;
}

/** Creates a fresh, fully approved, publicly bookable expert profile with wide-open hours. */
async function seedExpert(): Promise<SeedExpertResult> {
  const vertical = await referenceDataRepository.getSalesforceVertical();
  const suffix = randomUUID().slice(0, 8);
  const username = `e2e-expert-${suffix}`;

  const owner = await usersRepository.create({
    workosId: `e2e_expert_${randomUUID()}`,
    email: `e2e-expert-${suffix}@balo.test`,
    firstName: 'Sam',
    lastName: 'Consultant',
    emailVerified: true,
  });

  const draft = await expertsRepository.findOrCreateDraft({
    userId: owner.id,
    verticalId: vertical.id,
    type: 'freelancer',
    firstName: owner.firstName,
    lastName: owner.lastName,
  });

  // Deterministic, collision-free username — `findOrCreateDraft`'s auto-generated one is not
  // guaranteed unique enough across parallel local runs.
  await expertsRepository.updateProfile(draft.id, { username });
  await expertsRepository.submitApplication(draft.id);
  await expertsRepository.approveApplication(draft.id);
  await availabilityRulesRepository.replaceForExpert(draft.id, WEEKLY_RULES);

  // Shortcut (1) from the module docblock: hardcoded true, not checklist-derived.
  await expertSearchabilityRepository.applySearchable({
    expertProfileId: draft.id,
    searchable: true,
    actorUserId: null,
    source: 'dashboard_read',
    failingItems: [],
  });

  return { expertProfileId: draft.id, username };
}

interface SeedCompanyResult {
  companyId: string;
  companyName: string;
}

/** Adds a SECOND company membership for `userId`, alongside their existing personal workspace. */
async function seedCompany(userId: string): Promise<SeedCompanyResult> {
  const name = `E2E Co ${randomUUID().slice(0, 8)}`;
  const [company] = await db.insert(companies).values({ name, isPersonal: false }).returning();
  if (company === undefined) {
    throw new Error('e2e seed: company insert returned no row');
  }
  await partyMembershipsRepository.findOrCreateDomainMembership({
    partyType: 'company',
    partyId: company.id,
    userId,
    actorUserId: userId,
  });
  return { companyId: company.id, companyName: company.name };
}

interface SeedCaseResult {
  engagementId: string;
  title: string;
}

/** Creates a real open (`status: 'active'`) case on the user's primary company. */
async function seedCase(input: {
  userId: string;
  companyId: string;
  expertProfileId: string;
  title: string;
  bookingNonce: string | undefined;
}): Promise<SeedCaseResult> {
  const bookingIdempotencyKey =
    input.bookingNonce === undefined
      ? undefined
      : deriveBookingIdempotencyKey(input.userId, input.bookingNonce);

  const row = await caseEngagementsRepository.create({
    companyId: input.companyId,
    expertProfileId: input.expertProfileId,
    title: input.title,
    description: '<p>Seeded for the BAL-400 E2E suite.</p>',
    actorUserId: input.userId,
    bookingIdempotencyKey,
  });

  return { engagementId: row.id, title: row.title };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const gated = requireE2ESecret(request);
  if (gated) return gated;

  try {
    const body: unknown = await request.json();
    const parsed = seedRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    // `expert` seeds a standalone profile — no session/company involvement.
    if (parsed.data.kind === 'expert') {
      const result = await seedExpert();
      return NextResponse.json({ ok: true, ...result });
    }

    // `company` and `case` both attach to the CURRENT session's user — seed one via
    // /api/auth/test-login first.
    const session = await getSession();
    if (!session.user) {
      return NextResponse.json(
        { error: 'no active session — call /api/auth/test-login before /api/e2e/seed' },
        { status: 400 }
      );
    }

    if (parsed.data.kind === 'company') {
      const result = await seedCompany(session.user.id);
      return NextResponse.json({ ok: true, ...result });
    }

    const result = await seedCase({
      userId: session.user.id,
      companyId: session.user.companyId,
      expertProfileId: parsed.data.expertProfileId,
      title: parsed.data.title,
      bookingNonce: parsed.data.bookingNonce,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    log.error('E2E booking-context seed failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    // The REASON is returned in the body on purpose. This route is secret-gated (404 without
    // `E2E_TEST_SECRET`, 401 on a mismatch), so only a caller already holding the secret can
    // read it, and production never sets that secret. A bare `{ error: 'seed failed' }` cost a
    // full CI round-trip to diagnose: Next does not surface a route's `log.error` in the
    // Playwright `[WebServer]` capture, so the reason was invisible in the job log.
    return NextResponse.json(
      {
        error: 'seed failed',
        reason: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
