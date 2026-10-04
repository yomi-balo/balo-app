import 'server-only';

import { expertsRepository } from '@balo/db';
import { log } from '@/lib/logging';
import { formatSubmittedDate } from '@/lib/expert/application-derived-data';
import { ApplicationReviewBanner } from './application-review-banner';

/**
 * Streams the "under review" banner onto the client dashboard when the viewer has an expert
 * application awaiting a decision. An applicant has no expert workspace until approved, so the
 * client dashboard is where they land. Renders nothing otherwise — and nothing on a failed read:
 * the banner is informational, so it never takes the dashboard down with it.
 */
export async function ApplicationReviewBannerSlot({
  userId,
  email,
}: Readonly<{ userId: string; email: string }>): Promise<React.JSX.Element | null> {
  try {
    const pending = await expertsRepository.findPendingApplicationByUserId(userId);
    if (pending === undefined) return null;
    return (
      <ApplicationReviewBanner
        submittedOn={pending.submittedAt === null ? null : formatSubmittedDate(pending.submittedAt)}
        email={email}
      />
    );
  } catch (error) {
    log.warn('Failed to read pending expert application for the dashboard banner', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
