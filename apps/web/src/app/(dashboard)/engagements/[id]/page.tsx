import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import {
  projectEngagementsRepository,
  actionItemsRepository,
  engagementChangeOrdersRepository,
  engagementMilestonesRepository,
  engagementTimeEntriesRepository,
  type ProjectEngagementWithMilestones,
  type TimeEntryListRow,
  type TimeEntrySums,
} from '@balo/db';
import { currentBillingPeriod, type BillingPeriod } from '@balo/shared/engagements';
import { log } from '@/lib/logging';
import { getCurrentUser } from '@/lib/auth/session';
import { CAPABILITIES, hasCapability } from '@/lib/authz';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import {
  resolveEngagementViewer,
  resolveWorkspaceAccess,
} from '@/lib/engagement/resolve-engagement-viewer';
import { mapEngagementToWorkspaceView, offersRatingCard } from '@/lib/engagement/engagement-view';
import { resolveWorkspaceBackHref } from '@/lib/engagement/workspace-back-href';
import { mapActionItemsToView } from '@/lib/engagement/action-items-view';
import {
  deriveEngagementParties,
  milestoneCompleterLabel,
} from '@/lib/engagement/engagement-parties';
import { mapTimeToView } from '@/lib/engagement/time-view';
import { mapChangeOrdersToView } from '@/lib/engagement/change-order-view';
import { mapChangeOrderAdminView } from '@/lib/engagement/change-order-admin-view';
import { loadProjectSettlement } from '@/lib/engagement/change-order-settlement';
import { readRatingCard } from '@/lib/reviews/read-rating-card';
import {
  trackServerAndFlush,
  ENGAGEMENT_SERVER_EVENTS,
  type EngagementWorkspaceEntry,
} from '@/lib/analytics/server';
import { EngagementWorkspace } from '@/components/balo/engagement/engagement-workspace';
import type { ReviewInitialAction } from '@/components/balo/engagement/review-banner-actions';
import { EntityCrumb } from '@/components/layout/breadcrumb-context';

interface EngagementWorkspacePageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; action?: string }>;
}

const NO_TIME_ENTRIES: Promise<TimeEntryListRow[]> = Promise.resolve([]);
const NO_TIME_SUMS: Promise<TimeEntrySums> = Promise.resolve({
  totalMinutes: 0,
  periodMinutes: null,
  byMilestone: {},
});
const NO_NOTIFIED_MILESTONES: Promise<string[]> = Promise.resolve([]);

/**
 * Request-scoped memo so `generateMetadata` and the page share a single DB read
 * per render (React `cache()` dedupes within one server request) — mirrors the
 * project-request detail page.
 *
 * ⚠ `/engagements/[id]` IS THE *PROJECT* DELIVERY WORKSPACE (BAL-417). The loader is
 * `projectEngagementsRepository.findWithMilestones`, whose query filters
 * `engagement_type = 'project'`, so a CASE engagement id resolves to `undefined` here
 * and 404s — the same leak-free copy a stranger or a missing row gets. That is correct
 * and intended: every surface below it (milestone rail, terms strip, review/auto-accept
 * banner, completion card) is project-shaped. The case surface is BAL-421's, on its own
 * route with its own loader.
 */
const loadEngagement = cache((id: string) => projectEngagementsRepository.findWithMilestones(id));

// Generic, leak-free metadata for any viewer who is not an authorised
// participant/observer of this engagement (or when it is missing). It must not
// echo the real title or otherwise confirm the engagement exists.
const GENERIC_METADATA: Metadata = {
  title: 'Delivery workspace — Balo',
  // Private dashboard content — never indexed.
  robots: { index: false, follow: false },
};

/**
 * Whitelist the `?from` query into the analytics `entry` union. Anything absent
 * or unrecognised (e.g. `?from=bogus`) collapses to `direct`.
 */
function resolveEntry(from: string | undefined): EngagementWorkspaceEntry {
  return from === 'request_detail' || from === 'inbox' || from === 'agency' ? from : 'direct';
}

/**
 * Whitelist the `?action` query (the email dual-CTA deep-link) into the review-modal
 * intent. Anything else (absent / `?action=bogus`) → null (no auto-open). The client
 * review banner only acts on it for a client-lens `pending_acceptance` engagement.
 */
function resolveInitialAction(action: string | undefined): ReviewInitialAction | null {
  return action === 'accept' || action === 'request-changes' ? action : null;
}

/**
 * The current billing period of a time and materials project, read in the delivering expert's
 * time zone (the calendar their entries are dated in). A period only exists while the project
 * is in flight; once it is completed or cancelled the totals card drops the period row.
 */
function workspaceBillingPeriod(
  engagement: ProjectEngagementWithMilestones,
  now: Date
): BillingPeriod | null {
  const inFlight = engagement.status === 'active' || engagement.status === 'pending_acceptance';
  if (engagement.pricingMethod !== 'tm' || !inFlight) return null;
  return currentBillingPeriod(
    engagement.activatedAt,
    engagement.cadence,
    now,
    engagement.expertProfile?.timezone ?? null
  );
}

/**
 * Time and materials only (BAL-624): the logged entries, their totals for the billing period,
 * and the milestones the client was already told went over their current estimate (so the Log
 * time warning doesn't promise a second notice). Fixed-price projects read nothing.
 */
function loadTimeReads(
  engagement: ProjectEngagementWithMilestones,
  billingPeriod: BillingPeriod | null
): [Promise<TimeEntryListRow[]>, Promise<TimeEntrySums>, Promise<string[]>] {
  if (engagement.pricingMethod !== 'tm') {
    return [NO_TIME_ENTRIES, NO_TIME_SUMS, NO_NOTIFIED_MILESTONES];
  }
  return [
    engagementTimeEntriesRepository.listByEngagement(engagement.id),
    engagementTimeEntriesRepository.sumsForEngagement(engagement.id, billingPeriod),
    engagementTimeEntriesRepository.listNotifiedAtCurrentEstimate(engagement.id),
  ];
}

/** When time was last logged on the engagement, for the admin activity chip. */
function latestTimeLoggedAt(entries: readonly TimeEntryListRow[]): Date | null {
  let latest: Date | null = null;
  for (const entry of entries) {
    if (latest === null || entry.createdAt > latest) latest = entry.createdAt;
  }
  return latest;
}

export async function generateMetadata({
  params,
}: Readonly<EngagementWorkspacePageProps>): Promise<Metadata> {
  const { id } = await params;

  // Mirror the page body's gating BEFORE specialising the title: Next.js streams
  // the document `<title>` even when the body `notFound()`s, so authorising here
  // is what stops a non-participant from learning the engagement's title /
  // existence. The cached loader dedupes with the page body — no extra DB cost.
  try {
    const user = await getCurrentUser();
    if (!user) return GENERIC_METADATA;

    const engagement = await loadEngagement(id);
    if (!engagement) return GENERIC_METADATA;

    const ctx = await resolveEngagementViewer(user, engagement);
    if (!ctx) return GENERIC_METADATA;

    const view = mapEngagementToWorkspaceView(engagement, ctx);
    return {
      title: `${view.header.engagementTitle} — Balo`,
      robots: { index: false, follow: false },
    };
  } catch {
    // Metadata is best-effort — the page itself surfaces load failures. Fall back
    // to the generic (leak-free) title rather than echoing anything.
    return GENERIC_METADATA;
  }
}

export default async function EngagementWorkspacePage({
  params,
  searchParams,
}: Readonly<EngagementWorkspacePageProps>): Promise<React.JSX.Element> {
  const { id } = await params;

  // The (dashboard) layout gates onboarding/drift; guard the unauthenticated
  // case explicitly so a missing session redirects rather than 500s.
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  let engagement: Awaited<ReturnType<typeof loadEngagement>>;
  try {
    engagement = await loadEngagement(id);
  } catch (error) {
    log.error('Failed to load engagement workspace', {
      engagementId: id,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error; // let error.tsx render the boundary
  }

  // Missing or soft-deleted → 404 (same copy as unauthorised — no existence leak).
  if (!engagement) {
    notFound();
  }

  // The viewer, and whether they may log time, from the expert-side capability (host-context
  // lookups are request-deduped, so repeated asks cost no extra reads).
  // Logging time is a delivery act on the engagement axis, so it is resolved by capability
  // rather than read off the lens, and only for an active time and materials project.
  const access = await resolveWorkspaceAccess(user, engagement);
  if (!access) {
    // Authenticated but not the client owner / delivering expert / admin → same
    // not-found page (existence never leaks to a stranger).
    log.warn('Engagement access denied', {
      engagementId: id,
      userId: user.id,
      companyId: user.companyId,
    });
    notFound();
  }
  const { ctx, canLogTime, timeEntryScope, actingAs } = access;

  // The in-app rating card. `offersRatingCard` is the VIEW decision (completed + client
  // lens only); the read degrades to `null` on its own, so a fault here never blocks an
  // otherwise-successful workspace render. No consultation is required for a project
  // (unlike the case surface / recap): a project can complete with zero consultation calls.
  // Runs alongside the action-items read below — two independent reads, one round trip.
  const editedMilestoneIds = engagement.milestones
    .filter((m) => m.contentEditedAt !== null)
    .map((m) => m.id);
  const now = new Date();
  const billingPeriod = workspaceBillingPeriod(engagement, now);
  const [rating, actionItems, changeOrderRows, contentEdits, timeEntries, timeSums, notified] =
    await Promise.all([
      offersRatingCard(engagement.status, ctx.lens)
        ? readRatingCard({
            engagementId: engagement.id,
            viewerUserId: user.id,
            requireHeldConsultation: false,
            now: new Date(),
          })
        : Promise.resolve(null),
      // The engagement's LIVE action items (BAL-391) — they are not on the hydrated
      // engagement graph, so the workspace loader stays a single query.
      actionItemsRepository.listByEngagement(engagement.id),
      // The engagement's change orders (BAL-622), oldest first — they move the effective price,
      // lock milestones and feed the change-order panel.
      engagementChangeOrdersRepository.listForEngagement(engagement.id),
      // What the expert reworded after the proposal, for the "Changed since proposal" chip.
      // Empty when no milestone carries the stamp (the repo returns without querying).
      engagementMilestonesRepository.listProposalContentEdits(editedMilestoneIds),
      ...loadTimeReads(engagement, billingPeriod),
    ]);
  const { from, action } = await searchParams;
  const mappedView = mapEngagementToWorkspaceView(
    engagement,
    ctx,
    now,
    changeOrderRows,
    contentEdits,
    latestTimeLoggedAt(timeEntries)
  );
  const view = {
    ...mappedView,
    header: {
      ...mappedView.header,
      backHref: resolveWorkspaceBackHref(from, engagement.expertProfile.agencyId),
    },
  };
  const time = mapTimeToView({
    engagement,
    ctx,
    entries: timeEntries,
    sums: timeSums,
    period: billingPeriod,
    viewerUserId: user.id,
    canLogTime,
    timeEntryScope,
    notifiedMilestoneIds: notified,
  });
  const canCancelEngagement = hasPlatformCapability(
    user,
    PLATFORM_CAPABILITIES.CANCEL_ANY_ENGAGEMENT
  );
  const parties = deriveEngagementParties(engagement);
  const canDecide = await hasCapability(user, CAPABILITIES.APPROVE_OWN_PROPOSALS, {
    companyId: engagement.companyId,
  });
  const changeOrders = mapChangeOrdersToView(changeOrderRows, engagement, ctx, parties, canDecide, {
    now,
    loggedMinutesByMilestone: timeSums.byMilestone,
    viewerUserId: user.id,
  });
  // Both sides of every amount are for Balo staff only: the capability gates the READ, and the
  // settlement is not even loaded for anyone else.
  const adminMoney = hasPlatformCapability(user, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)
    ? mapChangeOrderAdminView(
        await loadProjectSettlement(engagement.id),
        changeOrderRows,
        engagement,
        parties
      )
    : null;
  const actionItemsView = mapActionItemsToView(engagement, actionItems, ctx);

  // Fire the server-side view event on the authorised path. `after()` is
  // registered here (before any later throw) so the flush lands even on
  // serverless. Entry is derived from the whitelisted `?from` query.
  const viewed = {
    engagement_id: engagement.id,
    entry: resolveEntry(from),
    engagement_status: engagement.status,
    distinct_id: user.id,
  };
  if (ctx.lens !== 'expert') {
    trackServerAndFlush(ENGAGEMENT_SERVER_EVENTS.WORKSPACE_VIEWED, { ...viewed, lens: ctx.lens });
  } else if (actingAs === null) {
    log.warn('Workspace view not tracked: expert lens without an acting capacity', {
      engagementId: engagement.id,
      userId: user.id,
    });
  } else {
    trackServerAndFlush(ENGAGEMENT_SERVER_EVENTS.WORKSPACE_VIEWED, {
      ...viewed,
      lens: ctx.lens,
      acting_as: actingAs,
    });
  }

  return (
    <>
      {/* BAL-499 — publishes the engagement's title into the top bar's breadcrumb trail. Safe
          here: this is the already-authorised return path, after every gate above. */}
      <EntityCrumb label={view.header.engagementTitle} />
      <EngagementWorkspace
        view={view}
        initialAction={resolveInitialAction(action)}
        actionItems={actionItemsView}
        rating={rating}
        changeOrders={changeOrders}
        adminMoney={adminMoney}
        time={time}
        canCancelEngagement={canCancelEngagement}
        viewerCompleterLabel={milestoneCompleterLabel(engagement, parties, user)}
      />
    </>
  );
}
