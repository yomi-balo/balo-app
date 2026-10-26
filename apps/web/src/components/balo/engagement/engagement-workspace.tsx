import type { EngagementWorkspaceView } from '@/lib/engagement/engagement-view';
import type { ActionItemsPanelView } from '@/lib/engagement/action-items-view';
import type { EndOfCallRatingView } from '@/lib/meetings/end-of-call-view-types';
import { EngagementRatingCard } from '@/components/balo/reviews/engagement-rating-card';
import { Reveal } from './reveal';
import { EngagementHeader } from './engagement-header';
import { ReviewBanner } from './review-banner';
import type { ReviewInitialAction } from './review-banner-actions';
import { ChangeRequestBanner } from './change-request-banner';
import { CompletedBanner } from './completed-banner';
import { CancelledBanner } from './cancelled-banner';
import type { WorkspaceTimeView } from '@/lib/engagement/time-view';
import { EngagementMoreActionsMenu } from './engagement-more-actions-menu';
import { OverEstimateBanner } from './time/over-estimate-banner';
import { EngagementProgress } from './engagement-progress';
import { MilestoneRail } from './milestone-rail';
import { ExpertMilestoneRail, type ProposeChangeLink } from './expert-milestone-rail';
import { MilestoneEmptyState } from './milestone-empty-state';
import { ExpertCompletionCard } from './expert-completion-card';
import { ActionItemsPanel } from './action-items-panel';
import type { ChangeOrderPanelView } from '@/lib/engagement/change-order-view';
import {
  ChangeOrderAdminPanel,
  type ChangeOrderAdminMoneyView,
} from './change-orders/change-order-admin-panel';
import { ChangeOrderHistory } from './change-orders/change-order-history';
import { ChangeOrderPanel } from './change-orders/change-order-panel';
import { RequestChangeCard } from './change-orders/request-change-card';

interface EngagementWorkspaceProps {
  view: EngagementWorkspaceView;
  /** Email dual-CTA deep-link intent (`?action=`) — auto-opens the client review modal. */
  initialAction?: ReviewInitialAction | null;
  /** BAL-391 — the action-items panel view; omitted (undefined) → the section is skipped. */
  actionItems?: ActionItemsPanelView;
  /**
   * BAL-587 — the in-app rating card's data, or `null` when there's nothing to show (an
   * expert/admin view, a non-completed status, or the loader's own never-consulted /
   * degrade-on-error branches). `offersRatingCard` on the server decides whether this is
   * ever non-null; this component does no lens or status check of its own.
   */
  rating?: EndOfCallRatingView | null;
  /**
   * BAL-622 — the change-order panel view for this viewer; omitted → no change-order surface
   * (no panel, no "Request a change", no history, no "Propose a change" on the rail).
   */
  changeOrders?: ChangeOrderPanelView;
  /**
   * BAL-622 — the Balo-staff money panel; non-null only for a viewer holding the platform
   * capability (the page resolves it). Null / omitted → not rendered.
   */
  adminMoney?: ChangeOrderAdminMoneyView | null;
  /**
   * BAL-624 — time-and-materials hours (per-milestone bars, time logs, totals, the
   * over-estimate notice); null / omitted on fixed price.
   */
  time?: WorkspaceTimeView | null;
  /**
   * BAL-624 — whether the viewer holds the platform capability to cancel any project (the page
   * resolves it). Gates the header's "More actions" menu; nothing here reads the lens.
   */
  canCancelEngagement?: boolean;
}

/**
 * Top-level composer for the read-only delivery workspace (`/engagements/[id]`).
 * Server component: it consumes the plain serializable `EngagementWorkspaceView`
 * only — never `@balo/db`, never the raw read model — so the client-bundle footgun
 * cannot fire. Every string/flag a section renders already lives on the view.
 *
 * Order mirrors the design-reference `Workspace` return (read-only slice — all
 * mutation affordances are D2–D4/D7 and omitted): header → state banners
 * (review / change-request / completed / cancelled, mutually exclusive by status)
 * → over-estimate notice → progress → milestone rail | empty state. Each section is
 * wrapped in `<Reveal>` for the staggered entrance vocabulary; the view object
 * never crosses the client boundary through `Reveal` (it wraps rendered nodes).
 */
export function EngagementWorkspace({
  view,
  initialAction = null,
  actionItems,
  rating = null,
  changeOrders,
  adminMoney = null,
  time = null,
  canCancelEngagement = false,
}: Readonly<EngagementWorkspaceProps>): React.JSX.Element {
  // Render the action-items panel only when it has something to show — live items OR a
  // writable (active) engagement inviting the first add. A read-only, empty panel is
  // purely retrospective, so it is skipped entirely.
  const showActionItems =
    actionItems !== undefined && (actionItems.items.length > 0 || actionItems.canWrite);
  // The delivering expert gets the INTERACTIVE rail only while the engagement is
  // active — the plan locks during client review / terminal states, where the
  // read-only rail (a server component) preserves D1's no-client-bundle posture. On an
  // active expert engagement the interactive island OWNS the empty case too (D3), so it
  // can host the "Add the first milestone" CTA + the scope-edit modals.
  const isInteractiveExpertRail = view.lens === 'expert' && view.status === 'active';

  // Milestone section, resolved as an independent statement (not a nested JSX ternary):
  // interactive expert rail (active) → read-only rail (has milestones) → empty state.
  let milestoneSection: React.JSX.Element | null = null;
  if (isInteractiveExpertRail) {
    milestoneSection = (
      <Reveal delay={0.2}>
        <ExpertMilestoneRail
          engagementId={view.engagementId}
          milestones={view.milestones}
          emptyState={view.emptyState}
          expertPersonShort={view.parties.expertPersonShort}
          clientCompanyName={view.parties.clientCompanyName}
          proposeChange={proposeChangeFor(changeOrders)}
          addNeedsChangeOrder={view.addMilestoneNeedsChangeOrder}
          time={time}
        />
      </Reveal>
    );
  } else if (view.hasMilestones) {
    milestoneSection = (
      <Reveal delay={0.2}>
        <MilestoneRail milestones={view.milestones} time={time} />
      </Reveal>
    );
  } else if (view.emptyState !== null) {
    milestoneSection = (
      <Reveal delay={0.2}>
        <MilestoneEmptyState emptyState={view.emptyState} />
      </Reveal>
    );
  }

  const overEstimateBanner = time?.overEstimateBanner ?? null;

  // Cancelling is a capability, not a view: the menu renders only when the page resolved the
  // platform capability and the project is in a cancellable state (it has dialog copy).
  const moreActions =
    canCancelEngagement && view.cancelDialog !== null && isCancellableStatus(view.status) ? (
      <EngagementMoreActionsMenu
        engagementId={view.engagementId}
        deliveryStatus={view.status}
        cancelDialog={view.cancelDialog}
      />
    ) : undefined;

  return (
    <div className="space-y-5">
      <Reveal>
        <EngagementHeader header={view.header} actions={moreActions} />
      </Reveal>

      {adminMoney !== null && (
        <Reveal delay={0.03}>
          <ChangeOrderAdminPanel money={adminMoney} />
        </Reveal>
      )}

      {view.reviewBanner !== null && (
        <Reveal delay={0.05}>
          <ReviewBanner
            banner={view.reviewBanner}
            lens={view.lens}
            engagementId={view.engagementId}
            clientCompanyName={view.parties.clientCompanyName}
            initialAction={initialAction}
          />
        </Reveal>
      )}

      {view.changeRequestBanner !== null && (
        <Reveal delay={0.05}>
          <ChangeRequestBanner
            banner={view.changeRequestBanner}
            engagementId={view.engagementId}
            clientCompanyName={view.parties.clientCompanyName}
          />
        </Reveal>
      )}

      {view.completedBanner !== null && (
        <Reveal delay={0.05}>
          <CompletedBanner banner={view.completedBanner} engagementId={view.engagementId} />
        </Reveal>
      )}

      {rating !== null && (
        <Reveal delay={0.08}>
          <EngagementRatingCard
            frame="section"
            surface="project_workspace"
            engagementKind="project"
            rating={rating}
            counterpartyName={view.parties.expertPersonShort}
          />
        </Reveal>
      )}

      {view.cancelledBanner !== null && (
        <Reveal delay={0.05}>
          <CancelledBanner banner={view.cancelledBanner} />
        </Reveal>
      )}

      {overEstimateBanner !== null && (
        <Reveal delay={0.08}>
          <OverEstimateBanner banner={overEstimateBanner} />
        </Reveal>
      )}

      {changeOrders !== undefined && (
        <ChangeOrderPanel
          engagementId={view.engagementId}
          lens={view.lens}
          view={changeOrders}
          clientParty={view.parties.clientCompanyName}
          expertParty={view.parties.expertPartyShort}
          expertActor={view.parties.expertRetroFirstMention}
          delay={0.12}
        />
      )}

      {view.hasMilestones && (
        <Reveal delay={0.15}>
          <EngagementProgress progress={view.progress} />
        </Reveal>
      )}

      {milestoneSection}

      {changeOrders !== undefined && view.lens === 'client' && view.status === 'active' && (
        <Reveal delay={0.21}>
          <RequestChangeCard
            engagementId={view.engagementId}
            canRequest={changeOrders.affordances.requestChange}
            expertParty={view.parties.expertPartyShort}
          />
        </Reveal>
      )}

      {changeOrders !== undefined && changeOrders.history.length > 0 && (
        <Reveal delay={0.21}>
          <ChangeOrderHistory history={changeOrders.history} />
        </Reveal>
      )}

      {showActionItems && actionItems !== undefined && (
        <Reveal delay={0.22}>
          <ActionItemsPanel view={actionItems} />
        </Reveal>
      )}

      {view.completionCard !== null && (
        <Reveal delay={0.25}>
          <ExpertCompletionCard
            engagementId={view.engagementId}
            card={view.completionCard}
            clientCompanyName={view.parties.clientCompanyName}
          />
        </Reveal>
      )}

      {changeOrders !== undefined && showChangeOrderFootnote(view, adminMoney) && (
        <Reveal delay={0.28}>
          <p className="text-muted-foreground text-sm leading-relaxed">{changeOrders.footnote}</p>
        </Reveal>
      )}
    </div>
  );
}

/** The two statuses a project can be cancelled from. */
function isCancellableStatus(status: string): status is 'active' | 'pending_acceptance' {
  return status === 'active' || status === 'pending_acceptance';
}

/** The rail's "Propose a change" entry, or undefined when the viewer has no such affordance. */
function proposeChangeFor(
  changeOrders: ChangeOrderPanelView | undefined
): ProposeChangeLink | undefined {
  if (changeOrders === undefined) return undefined;
  const { affordances, composerHref } = changeOrders;
  const available = affordances.propose || affordances.continueDraft;
  if (!available && affordances.proposeDisabledReason === null) return undefined;
  return {
    href: composerHref,
    label: affordances.continueDraft ? 'Continue draft change' : 'Propose a change',
    disabledReason: available ? null : affordances.proposeDisabledReason,
  };
}

/** The change-order footnote reads for a live project; an admin sees it only beside the money panel. */
function showChangeOrderFootnote(
  view: EngagementWorkspaceView,
  adminMoney: ChangeOrderAdminMoneyView | null
): boolean {
  if (view.lens === 'admin') return adminMoney !== null;
  return view.status === 'active';
}
