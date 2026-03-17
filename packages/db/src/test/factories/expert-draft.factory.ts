import { expertsRepository } from '../../repositories/experts';
import { referenceDataRepository } from '../../repositories/reference-data';
import type { ExpertProfile } from '../../schema/experts';
import { userFactory } from './user.factory';

interface ExpertDraftOverrides {
  userId?: string;
  verticalId?: string;
  type?: 'freelancer' | 'agency';
  firstName?: string | null;
  lastName?: string | null;
}

export async function expertDraftFactory(
  overrides: ExpertDraftOverrides = {}
): Promise<ExpertProfile> {
  const user = overrides.userId ? null : await userFactory();
  const userId = overrides.userId ?? user!.id;

  const verticalId =
    overrides.verticalId ?? (await referenceDataRepository.getSalesforceVertical()).id;

  return expertsRepository.createDraft({
    userId,
    verticalId,
    type: overrides.type ?? 'freelancer',
    firstName: overrides.firstName ?? (user?.firstName || 'Test'),
    lastName: overrides.lastName ?? (user?.lastName || 'Expert'),
  });
}
