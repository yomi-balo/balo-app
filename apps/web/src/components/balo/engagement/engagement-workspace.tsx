import type { EngagementWorkspaceView } from '@/lib/engagement/engagement-view';
import { Reveal } from './reveal';
import { EngagementHeader } from './engagement-header';
import { ReviewBanner } from './review-banner';
import { ChangeRequestBanner } from './change-request-banner';
import { CompletedBanner } from './completed-banner';
import { CancelledBanner } from './cancelled-banner';
import { AdminOversightStrip } from './admin-oversight-strip';
import { EngagementProgress } from './engagement-progress';
import { MilestoneRail } from './milestone-rail';
import { ExpertMilestoneRail } from './expert-milestone-rail';
import { MilestoneEmptyState } from './milestone-empty-state';

interface EngagementWorkspaceProps {
  view: EngagementWorkspaceView;
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
}: Readonly<EngagementWorkspaceProps>): React.JSX.Element {
  // The delivering expert gets the INTERACTIVE rail only while the engagement is
  // active — the plan locks during client review / terminal states, where the
  // read-only rail (a server component) preserves D1's no-client-bundle posture. On an
  // active expert engagement the interactive island OWNS the empty case too (D3), so it
  // can host the "Add the first milestone" CTA + the scope-edit modals.
  const isInteractiveExpertRail = view.lens === 'expert' && view.status === 'active';

  return (
    <div className="space-y-5">
      <Reveal>
        <EngagementHeader header={view.header} />
      </Reveal>

      {view.reviewBanner !== null && (
        <Reveal delay={0.05}>
          <ReviewBanner banner={view.reviewBanner} />
        </Reveal>
      )}

      {view.changeRequestBanner !== null && (
        <Reveal delay={0.05}>
          <ChangeRequestBanner banner={view.changeRequestBanner} />
        </Reveal>
      )}

      {view.completedBanner !== null && (
        <Reveal delay={0.05}>
          <CompletedBanner banner={view.completedBanner} />
        </Reveal>
      )}

      {view.cancelledBanner !== null && (
        <Reveal delay={0.05}>
          <CancelledBanner banner={view.cancelledBanner} />
        </Reveal>
      )}

      {view.adminOversight !== null && (
        <Reveal delay={0.1}>
          <AdminOversightStrip oversight={view.adminOversight} />
        </Reveal>
      )}

      {view.hasMilestones && (
        <Reveal delay={0.15}>
          <EngagementProgress progress={view.progress} />
        </Reveal>
      )}

      {isInteractiveExpertRail ? (
        <Reveal delay={0.2}>
          <ExpertMilestoneRail
            engagementId={view.engagementId}
            milestones={view.milestones}
            emptyState={view.emptyState}
            expertPersonShort={view.parties.expertPersonShort}
            clientCompanyName={view.parties.clientCompanyName}
          />
        </Reveal>
      ) : view.hasMilestones ? (
        <Reveal delay={0.2}>
          <MilestoneRail milestones={view.milestones} />
        </Reveal>
      ) : (
        view.emptyState !== null && (
          <Reveal delay={0.2}>
            <MilestoneEmptyState emptyState={view.emptyState} />
          </Reveal>
        )
      )}
    </div>
  );
}
