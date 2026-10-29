import { reviewsRepository } from '@balo/db';
import type { PublicReviewEntry } from '@balo/shared/reviews';
import { log } from '@/lib/logging';

/**
 * The expert's public review entries, one per reviewed engagement. A failed read returns `null`
 * rather than throwing, so the profile still renders and its reviews section falls back to the
 * stored aggregate.
 */
export async function loadPublicReviewEntries(
  expertProfileId: string
): Promise<PublicReviewEntry[] | null> {
  try {
    return await reviewsRepository.listPublicEntriesByExpert(expertProfileId);
  } catch (error) {
    log.error('Public review entries fetch failed', {
      expertProfileId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return null;
  }
}
