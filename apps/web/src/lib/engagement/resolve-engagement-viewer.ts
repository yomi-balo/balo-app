import 'server-only';

import { ENGAGEMENT_CAPABILITIES } from '@balo/shared/authz';
import type { SessionUser } from '@/lib/auth/session';
import { hasExpertDeliveryCapability } from '@/lib/authz/engagement';
import { resolveEngagementLens, type EngagementViewerContext } from './resolve-engagement-lens';

/** Which expert-side capacity an actor holds on an engagement. */
export interface ExpertSideActor {
  /** The actor's own expert profile is the engagement's delivering expert. */
  isDeliveringExpert: boolean;
  /** `agency_admin` = a `manage_engagement` holder who is not the delivering expert. */
  actingAs: 'delivering_expert' | 'agency_admin';
}

/**
 * Whether `user` may perform expert-side acts on this engagement, and in which capacity.
 * The ONE place the `manage_engagement` capability is asked for an engagement act (ADR-1046:
 * the delivering expert plus their agency owner/admin). `null` = not a holder.
 */
export async function resolveExpertSideActor(
  user: SessionUser,
  engagement: { id: string; expertProfileId: string }
): Promise<ExpertSideActor | null> {
  const holds = await hasExpertDeliveryCapability(
    user,
    ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT,
    engagement.expertProfileId,
    { contextType: 'project', contextId: engagement.id }
  );
  if (!holds) {
    return null;
  }
  const isDeliveringExpert = user.expertProfileId === engagement.expertProfileId;
  return {
    isDeliveringExpert,
    actingAs: isDeliveringExpert ? 'delivering_expert' : 'agency_admin',
  };
}

/**
 * The viewer's context for the delivery pages. Wraps the pure lens resolver and, when it
 * finds no relationship, admits a `manage_engagement` holder (an agency owner/admin of the
 * delivering expert) with the expert-side presentation. `null` = same 404 as a missing row.
 */
export async function resolveEngagementViewer(
  user: SessionUser,
  engagement: { id: string; companyId: string; expertProfileId: string }
): Promise<EngagementViewerContext | null> {
  const lensContext = resolveEngagementLens(user, engagement);
  if (lensContext !== null) {
    return lensContext;
  }
  const actor = await resolveExpertSideActor(user, engagement);
  if (actor === null) {
    return null;
  }
  return {
    lens: 'expert',
    archetype: 'participant',
    isClientOwner: false,
    isDeliveringExpert: false,
  };
}

/**
 * Whose time entries the viewer may edit or remove: the delivering expert keeps their own;
 * an agency owner/admin may change any author's. Shared by the page (affordances) and the
 * two time-entry actions (enforcement).
 */
export function timeEntryAuthorScope(isDeliveringExpert: boolean): 'own' | 'any' {
  return isDeliveringExpert ? 'own' : 'any';
}
