'use server';
import 'server-only';
import { withAuth } from '@/lib/auth/with-auth';
import { expertsRepository, type ApplicationWithRelations } from '@balo/db';
import { log } from '@/lib/logging';
import { loadReferenceData } from '@/lib/expert-apply/reference-data';

// Re-exported from its new home (BAL-502 §22) so every existing import path
// (`../_actions/load-draft`, and `./index`) keeps working unchanged.
export type { ReferenceData } from '@/lib/expert-apply/reference-data';
import type { ReferenceData } from '@/lib/expert-apply/reference-data';

export interface LoadDraftResult {
  draft: ApplicationWithRelations | null;
  referenceData: ReferenceData;
}

export const loadDraftAction = withAuth(async (session): Promise<LoadDraftResult> => {
  try {
    // The ONE definition of the six public taxonomy reads — shared with the
    // anonymous branch of `page.tsx` (`@/lib/expert-apply/reference-data`). This
    // composition serialises the draft lookup after the taxonomy reads (which have
    // their own internal Promise.all) rather than duplicating the six calls to
    // preserve the previous single-Promise.all shape.
    const referenceData = await loadReferenceData();

    const existingProfile = await expertsRepository.findApplicationByUserId(
      session.user.id,
      referenceData.vertical.id
    );

    const draft = existingProfile
      ? await expertsRepository.findApplicationWithRelations(existingProfile.id)
      : null;

    log.info('Expert application draft loaded', {
      userId: session.user.id,
      hasDraft: !!draft,
      draftStatus: draft?.profile.applicationStatus ?? null,
    });

    return {
      draft: draft ?? null,
      referenceData,
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
