'use server';
import 'server-only';
import { withAuth } from '@/lib/auth/with-auth';
import { expertsRepository, type ApplicationWithRelations } from '@balo/db';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { DECLINED_APPLICATION_ERROR } from './declined-application-copy';

interface SubmitResult {
  success: boolean;
  error?: string;
  failingStep?: string;
}

/**
 * The user-facing refusal for a non-`draft` application, or `null` when the submit may proceed.
 *
 * ⚠ THE DECLINED ARM ANSWERS FOR ITSELF (web-review fix round, W1). One branch used to cover
 * every non-draft status with "Application already submitted" — true for
 * `submitted`/`under_review`/`approved`, FALSE for `rejected`: that applicant's application was
 * reviewed and DECLINED, not "already submitted", and the message left them with no idea what had
 * happened or what to do. The `rejected` case now gets the honest message, and a `log.warn` so we
 * can see how often a declined applicant tries (the follow-up ticket's demand signal).
 *
 * ⚠ THIS IS NOT THE RE-APPLICATION TRANSITION and must not become it — see
 * `DECLINED_APPLICATION_ERROR`'s docblock. The refusal stays; only the explanation changed.
 *
 * ⚠ EXTRACTED ONLY TO SHED COGNITIVE COMPLEXITY. Inlining the second branch put
 * `submitApplicationAction` at 16 against SonarCloud's cap of 15 (`pnpm lint:sonar:diff`). The
 * behaviour is exactly what the two inline `if`s did, in the same order.
 */
function refusalForStatus(
  status: ApplicationWithRelations['profile']['applicationStatus'],
  context: { readonly userId: string; readonly expertProfileId: string }
): string | null {
  if (status === 'draft') return null;
  if (status === 'rejected') {
    log.warn('Declined expert application attempted a re-submit', context);
    return DECLINED_APPLICATION_ERROR;
  }
  return 'Application already submitted';
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

      // 3. Verify status is draft (see `refusalForStatus` for the two refusals).
      const statusRefusal = refusalForStatus(application.profile.applicationStatus, {
        userId: session.user.id,
        expertProfileId,
      });
      if (statusRefusal !== null) {
        return { success: false, error: statusRefusal };
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

      // Get unique product IDs from the competencies array
      const uniqueProductIds = new Set(application.competencies.map((c) => c.productId));
      if (uniqueProductIds.size === 0) {
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

      // Check each product has at least 1 non-zero dimension
      const productProficiencies = new Map<string, number[]>();
      for (const c of application.competencies) {
        const arr = productProficiencies.get(c.productId) ?? [];
        arr.push(c.proficiency);
        productProficiencies.set(c.productId, arr);
      }
      for (const [, proficiencies] of productProficiencies) {
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
        productsCount: uniqueProductIds.size,
        certsCount: application.certifications.length,
        workHistoryCount: application.workHistory.length,
      });

      // 6. Publish domain event (notification engine) — fire-and-forget
      // Note: applicationId === expertProfileId because expert_profiles IS the application record
      publishNotificationEvent('expert.application_submitted', {
        correlationId: expertProfileId,
        userId: session.user.id,
        applicationId: expertProfileId, // expert_profiles table doubles as the application
      }).catch(() => {
        // publishNotificationEvent logs internally
      });

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
