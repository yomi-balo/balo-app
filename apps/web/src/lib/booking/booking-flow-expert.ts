import type { ExpertProfileView } from '@/components/expert/profile';
import type { BookingFlowExpert } from '@/components/booking/types';
import { buildSimilarExpertsHref } from '@/lib/search/similar-experts-href';

/**
 * The booking wrapper's identity data from a public profile view. Shared by the profile page
 * (client-side) and `loadSearchBookingAction` (server-side), so the header reads the same
 * wherever the flow opens.
 *
 * `avatarUrl` is the RESOLVED thumbnail url (`getAvatarUrl(view.avatarKey, 'thumbnail')`).
 */
export function buildBookingFlowExpert(
  view: ExpertProfileView,
  avatarUrl: string | null
): BookingFlowExpert & { similarExpertsHref: string } {
  return {
    expertProfileId: view.expertId,
    name: view.name,
    firstName: view.firstName,
    initials: view.initials,
    avatarUrl,
    partyLabel: view.agency?.name ?? view.name,
    verified: view.baloVerified,
    availableForWork: view.availableForWork,
    similarExpertsHref: buildSimilarExpertsHref({
      verticalSlug: view.vertical.slug,
      productId: view.competencies[0]?.id,
    }),
  };
}
