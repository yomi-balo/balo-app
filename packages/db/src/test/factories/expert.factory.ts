import { expertsRepository } from '../../repositories/experts';
import type { ExpertProfile } from '../../schema/experts';
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
 */
export async function expertFactory(overrides: ExpertOverrides = {}): Promise<ExpertProfile> {
  const draft = await expertDraftFactory(overrides);
  await expertsRepository.submitApplication(draft.id);
  return expertsRepository.approveApplication(draft.id);
}
