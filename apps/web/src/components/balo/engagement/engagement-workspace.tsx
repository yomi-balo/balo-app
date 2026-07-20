import type { EngagementWorkspaceView } from '@/lib/engagement/engagement-view';
import type { ActionItemsPanelView } from '@/lib/engagement/action-items-view';
import { Reveal } from './reveal';
import { EngagementHeader } from './engagement-header';
import { ReviewBanner } from './review-banner';
import type { ReviewInitialAction } from './review-banner-actions';
import { ChangeRequestBanner } from './change-request-banner';
import { CompletedBanner } from './completed-banner';
import { CancelledBanner } from './cancelled-banner';
import { AdminOversightStrip } from './admin-oversight-strip';
import { EngagementProgress } from './engagement-progress';
import { MilestoneRail } from './milestone-rail';
import { ExpertMilestoneRail } from './expert-milestone-rail';
import { MilestoneEmptyState } from './milestone-empty-state';
import { ExpertCompletionCard } from './expert-completion-card';
import { ActionItemsPanel } from './action-items-panel';

interface EngagementWorkspaceProps {
  view: EngagementWorkspaceView;
  /** Email dual-CTA deep-link intent (`?action=`) — auto-opens the client review modal. */
  initialAction?: ReviewInitialAction | null;
  /** BAL-391 — the action-items panel view; omitted (undefined) → the section is skipped. */
  actionItems?: ActionItemsPanelView;
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
 * → admin oversight → progress → milestone rail | empty state. Each section is
 * wrapped in `<Reveal>` for the staggered entrance vocabulary; the view object
 * never crosses the client boundary through `Reveal` (it wraps rendered nodes).
 */
export function EngagementWorkspace({
  view,
  initialAction = null,
  actionItems,
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
        />
      </Reveal>
    );
  } else if (view.hasMilestones) {
    milestoneSection = (
      <Reveal delay={0.2}>
        <MilestoneRail milestones={view.milestones} />
      </Reveal>
    );
  } else if (view.emptyState !== null) {
    milestoneSection = (
      <Reveal delay={0.2}>
        <MilestoneEmptyState emptyState={view.emptyState} />
      </Reveal>
    );
  }

  return (
    <div className="space-y-5">
      <Reveal>
        <EngagementHeader header={view.header} />
      </Reveal>

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
          <ChangeRequestBanner banner={view.changeRequestBanner} />
        </Reveal>
      )}

      {view.completedBanner !== null && (
        <Reveal delay={0.05}>
          <CompletedBanner banner={view.completedBanner} engagementId={view.engagementId} />
        </Reveal>
      )}

      {view.cancelledBanner !== null && (
        <Reveal delay={0.05}>
          <CancelledBanner banner={view.cancelledBanner} />
        </Reveal>
      )}

      {view.adminOversight !== null && (
        <Reveal delay={0.1}>
          <AdminOversightStrip oversight={view.adminOversight} engagementId={view.engagementId} />
        </Reveal>
      )}

      {view.hasMilestones && (
        <Reveal delay={0.15}>
          <EngagementProgress progress={view.progress} />
        </Reveal>
      )}

      {milestoneSection}

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
    </div>
  );
}
