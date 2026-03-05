'use server';
import 'server-only';
import { withAuth } from '@/lib/auth/with-auth';
import { expertsRepository } from '@balo/db';
import { log } from '@/lib/logging';

interface SubmitResult {
  success: boolean;
  error?: string;
  failingStep?: string;
}

export const submitApplicationAction = withAuth(
  async (session, expertProfileId: string): Promise<SubmitResult> => {
    try {
      // 1. Load full application
      const application = await expertsRepository.findApplicationWithRelations(expertProfileId);
      if (!application) {
        return { success: false, error: 'Application not found' };
      }

      // 2. Verify ownership
      if (application.profile.userId !== session.user.id) {
        return { success: false, error: 'Unauthorized' };
      }

      // 3. Verify status is draft
      if (application.profile.applicationStatus !== 'draft') {
        return { success: false, error: 'Application already submitted' };
      }

      // 4. Server-side validation of all required data
      if (application.languages.length === 0) {
        log.warn('Expert application submission validation failed', {
          userId: session.user.id,
          expertProfileId,
          failingStep: 'profile',
          error: 'No languages',
        });
        return {
          success: false,
          error: 'At least one language is required',
          failingStep: 'profile',
        };
      }
      if (application.industries.length === 0) {
        log.warn('Expert application submission validation failed', {
          userId: session.user.id,
          expertProfileId,
          failingStep: 'profile',
          error: 'No industries',
        });
        return {
          success: false,
          error: 'At least one industry is required',
          failingStep: 'profile',
        };
      }

      // Get unique skill IDs from the skills array
      const uniqueSkillIds = new Set(application.skills.map((s) => s.skillId));
      if (uniqueSkillIds.size === 0) {
        log.warn('Expert application submission validation failed', {
          userId: session.user.id,
          expertProfileId,
          failingStep: 'products',
          error: 'No products selected',
        });
        return {
          success: false,
          error: 'At least one product is required',
          failingStep: 'products',
        };
      }

      // Check each skill has at least 1 non-zero dimension
      const skillProficiencies = new Map<string, number[]>();
      for (const s of application.skills) {
        const arr = skillProficiencies.get(s.skillId) ?? [];
        arr.push(s.proficiency);
        skillProficiencies.set(s.skillId, arr);
      }
      for (const [, proficiencies] of skillProficiencies) {
        if (!proficiencies.some((p) => p > 0)) {
          log.warn('Expert application submission validation failed', {
            userId: session.user.id,
            expertProfileId,
            failingStep: 'assessment',
            error: 'Product with all zero proficiencies',
          });
          return {
            success: false,
            error: 'All products must have at least one rated dimension',
            failingStep: 'assessment',
          };
        }
      }

      // 5. Submit in single update
      await expertsRepository.submitApplication(expertProfileId);

      log.info('Expert application submitted', {
        userId: session.user.id,
        expertProfileId,
        productsCount: uniqueSkillIds.size,
        certsCount: application.certifications.length,
        workHistoryCount: application.workHistory.length,
      });

      // 6. Publish domain event (notification engine)
      // await notificationEvents.publish('application.submitted', {
      //   expertProfileId,
      //   userId: session.user.id,
      //   email: session.user.email,
      // });

      return { success: true };
    } catch (error) {
      log.error('Expert application submission failed', {
        userId: session.user.id,
        expertProfileId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return {
        success: false,
        error: 'Something went wrong submitting your application. Please try again.',
      };
    }
  }
);
