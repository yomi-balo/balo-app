'use server';
import 'server-only';
import { withAuth } from '@/lib/auth/with-auth';
import {
  expertsRepository,
  referenceDataRepository,
  type ApplicationWithRelations,
  type ProductsByCategory,
  type CertificationsByCategory,
} from '@balo/db';
import type { SupportType } from '@balo/db';
import { log } from '@/lib/logging';

export interface SubmittedApplicationResult {
  application: ApplicationWithRelations;
  productsByCategory: ProductsByCategory[];
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

      const [application, productsByCategory, supportTypes, certsByCategory] = await Promise.all([
        expertsRepository.findApplicationWithRelations(existingProfile.id),
        referenceDataRepository.getProductsByVertical(vertical.id),
        referenceDataRepository.getSupportTypes(vertical.id),
        referenceDataRepository.getCertificationsByVertical(vertical.id),
      ]);

      if (!application) return null;

      log.info('Submitted application loaded for review', {
        userId: session.user.id,
        applicationStatus: application.profile.applicationStatus,
      });

      return {
        application,
        productsByCategory,
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
