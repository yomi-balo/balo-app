'use server';
import 'server-only';
import { withAuth } from '@/lib/auth/with-auth';
import {
  expertsRepository,
  referenceDataRepository,
  type ApplicationWithRelations,
  type SkillsByCategory,
  type CertificationsByCategory,
} from '@balo/db';
import type { Vertical, SupportType, Language, Industry } from '@balo/db';
import { log } from '@/lib/logging';

export interface ReferenceData {
  skillsByCategory: SkillsByCategory[];
  supportTypes: SupportType[];
  certificationsByCategory: CertificationsByCategory[];
  languages: Language[];
  industries: Industry[];
  vertical: Vertical;
}

export interface LoadDraftResult {
  draft: ApplicationWithRelations | null;
  referenceData: ReferenceData;
}

export const loadDraftAction = withAuth(async (session): Promise<LoadDraftResult> => {
  try {
    const vertical = await referenceDataRepository.getSalesforceVertical();

    const existingProfile = await expertsRepository.findApplicationByUserId(
      session.user.id,
      vertical.id
    );

    const [draft, skillsByCategory, supportTypes, certsByCategory, languages, industries] =
      await Promise.all([
        existingProfile
          ? expertsRepository.findApplicationWithRelations(existingProfile.id)
          : Promise.resolve(null),
        referenceDataRepository.getSkillsByVertical(vertical.id),
        referenceDataRepository.getSupportTypes(),
        referenceDataRepository.getCertificationsByVertical(vertical.id),
        referenceDataRepository.getLanguages(),
        referenceDataRepository.getIndustries(),
      ]);

    log.info('Expert application draft loaded', {
      userId: session.user.id,
      hasDraft: !!draft,
      draftStatus: draft?.profile.applicationStatus ?? null,
    });

    return {
      draft: draft ?? null,
      referenceData: {
        skillsByCategory,
        supportTypes,
        certificationsByCategory: certsByCategory,
        languages,
        industries,
        vertical,
      },
    };
  } catch (error) {
    log.error('Failed to load expert application draft', {
      userId: session.user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error; // Let the error boundary handle this
  }
});
