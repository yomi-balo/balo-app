import type { ProjectEngagementWithMilestones } from '@balo/db';
import { expertPartyDisplayName } from '@balo/shared/parties';

/** The display fields every delivery-review email (auto-accept and reminder) shares. */
export interface DeliveryEmailFields {
  clientCompanyName: string;
  expertPartyLabel: string;
  projectTitle: string;
  milestonesTotal: number;
}

/**
 * Derive the notification payload's display fields from a hydrated engagement, reusing the
 * shared BAL-329 party-label rule (`expertPartyDisplayName`) so every API-published delivery
 * email matches the web-published copy. The `Delivery with {label}` fallback for a blank
 * project title lives here and nowhere else.
 */
export function deliveryEmailFields(
  engagement: ProjectEngagementWithMilestones
): DeliveryEmailFields {
  const { user, type } = engagement.expertProfile;
  const agency = engagement.deliveringAgency;
  const expertPartyLabel = expertPartyDisplayName({
    type,
    agencyName: agency?.name ?? null,
    firstName: user.firstName,
    lastName: user.lastName,
  });
  const projectTitle =
    engagement.projectRequest?.title?.trim() || `Delivery with ${expertPartyLabel}`;
  return {
    clientCompanyName: engagement.company.name,
    expertPartyLabel,
    projectTitle,
    milestonesTotal: engagement.milestones.length,
  };
}
