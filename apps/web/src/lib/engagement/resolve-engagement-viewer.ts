import 'server-only';

import type { TimeEntryAuthorScope } from '@balo/db';
import { ENGAGEMENT_CAPABILITIES } from '@balo/shared/authz';
import type { SessionUser } from '@/lib/auth/session';
import { administersDeliveringAgency, hasExpertDeliveryCapability } from '@/lib/authz/engagement';
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

/** The expert-side presentation an agency owner/admin with no relationship of their own sees. */
const AGENCY_HOLDER_VIEWER: EngagementViewerContext = {
  lens: 'expert',
  archetype: 'participant',
  isClientOwner: false,
  isDeliveringExpert: false,
};

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
  return actor === null ? null : AGENCY_HOLDER_VIEWER;
}

/** What the delivery workspace lets one viewer see and do. */
export interface WorkspaceAccess {
  ctx: EngagementViewerContext;
  /** The viewer may log time: an active time and materials project and the delivering expert. */
  canLogTime: boolean;
  /** Whose time entries the viewer may edit or remove; `null` = none (not an expert-side holder, or not a live T&M project). */
  timeEntryScope: TimeEntryAuthorScope | null;
  /** The expert-side capacity the viewer acts in; `null` for client and observer viewers. */
  actingAs: ExpertSideActor['actingAs'] | null;
}

/**
 * {@link resolveEngagementViewer} plus the time-logging affordances, from ONE expert-side
 * actor resolution (the capability read). Whose entries the viewer may change is a separate
 * resolution through the same resolvers the actions use; host-context lookups are
 * request-deduped, so asking twice costs no extra reads. The capability is asked only when it decides something: the viewer has
 * no relationship of their own, or the project is an active time and materials one. Only the
 * delivering expert logs time; whose entries the viewer may change reads
 * {@link timeEntryAuthorScope}, as the time-entry actions do. `null` = same 404 as a missing row.
 */
export async function resolveWorkspaceAccess(
  user: SessionUser,
  engagement: {
    id: string;
    companyId: string;
    expertProfileId: string;
    pricingMethod: string;
    status: string;
  }
): Promise<WorkspaceAccess | null> {
  const lensContext = resolveEngagementLens(user, engagement);
  const logsTime = engagement.pricingMethod === 'tm' && engagement.status === 'active';
  const actor =
    lensContext === null || logsTime ? await resolveExpertSideActor(user, engagement) : null;
  const ctx = lensContext ?? (actor === null ? null : AGENCY_HOLDER_VIEWER);
  if (ctx === null) {
    return null;
  }
  const actingAs = viewerActingAs(lensContext, actor);
  if (!logsTime || actor === null) {
    return { ctx, canLogTime: false, timeEntryScope: null, actingAs };
  }
  return {
    ctx,
    canLogTime: actor.isDeliveringExpert,
    timeEntryScope: await timeEntryAuthorScope(user, engagement),
    actingAs,
  };
}

/** `agency_admin` for the agency-holder fallback, `delivering_expert` for the deliverer, else `null`. */
function viewerActingAs(
  lensContext: EngagementViewerContext | null,
  actor: ExpertSideActor | null
): ExpertSideActor['actingAs'] | null {
  if (lensContext === null) {
    return actor === null ? null : 'agency_admin';
  }
  if (lensContext.archetype === 'participant' && lensContext.isDeliveringExpert) {
    return 'delivering_expert';
  }
  return null;
}

/**
 * Whose time entries the actor may edit or remove. `'any'` only for whoever administers the
 * delivering agency (agency owner/admin, a delivering expert who owns the agency included),
 * read from the host context rather than inferred from the session's expert profile;
 * `'own'` for everyone else, a delivering expert with agency role `expert` and an independent
 * expert included. Shared by the page (affordances) and the two time-entry actions (enforcement).
 */
export async function timeEntryAuthorScope(
  user: SessionUser,
  engagement: { expertProfileId: string }
): Promise<TimeEntryAuthorScope> {
  return (await administersDeliveringAgency(user, engagement.expertProfileId)) ? 'any' : 'own';
}
