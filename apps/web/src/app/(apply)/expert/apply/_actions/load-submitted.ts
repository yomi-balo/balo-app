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
import type { SupportType } from '@balo/db';
import { log } from '@/lib/logging';

export interface SubmittedApplicationResult {
  application: ApplicationWithRelations;
  skillsByCategory: SkillsByCategory[];
  supportTypes: SupportType[];
  certificationsByCategory: CertificationsByCategory[];
}

export const loadSubmittedApplication = withAuth(
  async (session): Promise<SubmittedApplicationResult | null> => {
    try {
      const vertical = await referenceDataRepository.getSalesforceVertical();

      const existingProfile = await expertsRepository.findApplicationByUserId(
        session.user.id,
        vertical.id
      );

      if (!existingProfile) return null;

      const [application, skillsByCategory, supportTypes, certsByCategory] = await Promise.all([
        expertsRepository.findApplicationWithRelations(existingProfile.id),
        referenceDataRepository.getSkillsByVertical(vertical.id),
        referenceDataRepository.getSupportTypes(),
        referenceDataRepository.getCertificationsByVertical(vertical.id),
      ]);

      if (!application) return null;

      log.info('Submitted application loaded for review', {
        userId: session.user.id,
        applicationStatus: application.profile.applicationStatus,
      });

      return {
        application,
        skillsByCategory,
        supportTypes,
        certificationsByCategory: certsByCategory,
      };
    } catch (error) {
      log.error('Failed to load submitted application', {
        userId: session.user.id,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }
);
