import { eq } from 'drizzle-orm';
import { db } from '../../client';
import { expertsRepository } from '../../repositories/experts';
import { expertProfiles, type ExpertProfile } from '../../schema/experts';
import { expertDraftFactory } from './expert-draft.factory';

interface ExpertOverrides {
  userId?: string;
  verticalId?: string;
  type?: 'freelancer' | 'agency';
  firstName?: string | null;
  lastName?: string | null;
}

/**
 * Creates a fully approved expert profile (draft → submitted → approved).
 * Use expertDraftFactory if you need a draft-state profile.
 *
 * ⚠ BAL-549 — THE APPROVE STEP IS A FIXTURE WRITE, NOT A DOMAIN WRITE.
 * `expertsRepository.approveApplication` was deleted with `/admin-dev`;
 * `expertsRepository.decideApplication` is now the ONLY domain approve path, and it requires an
 * actor user and appends an `audit_events` row. A fixture must fabricate neither — hundreds of
 * suites mint an approved expert with no staff actor in play, and an audit row per fixture would
 * make `audit_events` assertions in unrelated tests meaningless. So this sets, directly, exactly
 * the two columns the fixture's consumers read. It deliberately does NOT stamp the ADR-1030
 * floor columns (`decided_at` / `decided_by_user_id`): a fixture expert is a PRE-BAL-549-shaped
 * approval, which is also the shape the "excludes a pre-BAL-549 approval" coverage in
 * `expert-application-decision.integration.test.ts` needs to exist.
 */
export async function expertFactory(overrides: ExpertOverrides = {}): Promise<ExpertProfile> {
  const draft = await expertDraftFactory(overrides);
  await expertsRepository.submitApplication(draft.id);

  const now = new Date();
  const [profile] = await db
    .update(expertProfiles)
    .set({ applicationStatus: 'approved', approvedAt: now, updatedAt: now })
    .where(eq(expertProfiles.id, draft.id))
    .returning();

  if (profile === undefined) {
    throw new Error(`expertFactory: approve UPDATE matched no row for ${draft.id}`);
  }
  return profile;
}
