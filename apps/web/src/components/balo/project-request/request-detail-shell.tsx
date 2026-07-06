import { Lock, Shield, User, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RequestDetailView } from '@/lib/project-request/request-detail-view';
import {
  BEFORE_INVITE_STATUSES,
  requestPhase,
  type RequestViewerContext,
} from '@/lib/project-request/resolve-request-lens';
import type { ConversationView } from '@/lib/project-request/conversation-view-types';
import type { KickoffBillingCapture } from '@/lib/billing/billing-capture';
import { RequestCard } from './request-card';
import { RequestContext } from './request-context';
import { NudgeBar, nudgeFor, EXPERT_GATED_NUDGE } from './nudge-bar';
import { AdminHealthPanel } from './admin-health-panel';
import { RequestDetailAnalytics } from './request-detail-analytics';
import { StatusStepper } from './status-stepper';
import { EoiEntry } from './eoi-entry';
import { ProposalSlot } from './proposal-slot';
import { KickoffBoard } from './proposal/kickoff-board';
import { AdminKickoffBillingPanel } from './proposal/admin-kickoff-billing-panel';
import type { AdminKickoffBillingView } from '@/lib/project-request/admin-kickoff-billing-view';
import { BillingBlockedViewTracker } from './proposal/billing-blocked-view-tracker';
import { ConversationStage } from './conversation/conversation-stage';
import { MobileRequestSheet } from './conversation/mobile-request-sheet';

interface RequestDetailShellProps {
  view: RequestDetailView;
  ctx: RequestViewerContext;
  /**
   * Phase-2 participant payload (loaded by the page). Optional/null-safe —
   * a missing payload renders the zero-thread invitation stage, never a crash.
   */
  conversation?: ConversationView | null;
  /**
   * BAL-324 admin billing + payment-terms projection (observer lens only, loaded
   * by the page). Null for participants and when no kickoff board is active.
   */
  adminBilling?: AdminKickoffBillingView | null;
  /**
   * Client billing-capture context (BAL-323), loaded by the page. Non-null ONLY for
   * the client lens on an accepted request; forwarded to the KickoffBoard.
   */
  billingCapture?: KickoffBillingCapture | null;
}

/** Defensive fallback when the page passed no conversation payload. */
const EMPTY_CONVERSATION_VIEW: ConversationView = {
  viewerUserId: '',
  threads: [],
  defaultThreadId: null,
  initialMessages: [],
  initialHasEarlier: false,
  initialFiles: [],
  realtimeEnabled: false,
};

const LENS_META = {
  client: {
    label: 'Client',
    icon: User,
    tone: 'text-primary',
    ring: 'border-primary/25 bg-primary/5',
  },
  expert: {
    label: 'Expert',
    icon: Shield,
    // Distinct brand-violet (reuses the gradient palette) so the three lenses
    // read apart: client=primary blue, expert=violet, admin=info cyan.
    tone: 'text-violet-600 dark:text-violet-400',
    ring: 'border-violet-500/25 bg-violet-500/5',
  },
  admin: { label: 'Admin', icon: Users, tone: 'text-info', ring: 'border-info/25 bg-info/5' },
} as const;

const STATUS_LABEL_BEFORE_INVITE = new Set<string>(BEFORE_INVITE_STATUSES);

/** "Viewing as {lens}" line + phase pill (participants only). */
function LensLine({
  ctx,
  isPhase2,
}: Readonly<{ ctx: RequestViewerContext; isPhase2: boolean }>): React.JSX.Element {
  const meta = LENS_META[ctx.lens];
  const Icon = meta.icon;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs',
          meta.ring
        )}
      >
        <Icon className={cn('h-3 w-3', meta.tone)} aria-hidden="true" />
        <span className="text-muted-foreground">Viewing as</span>
        <strong className={cn('font-semibold', meta.tone)}>{meta.label}</strong>
      </span>
      {ctx.archetype === 'participant' && (
        <span className="text-muted-foreground ml-auto inline-flex items-center gap-1.5 text-xs">
          <span
            className={cn('h-1.5 w-1.5 rounded-full', isPhase2 ? 'bg-violet-500' : 'bg-primary')}
            aria-hidden="true"
          />
          {isPhase2 ? 'Phase 2 — conversation' : 'Phase 1 — request'}
        </span>
      )}
    </div>
  );
}

/** Expert lock card — request not yet open to the (uninvited) expert. */
function ExpertGatedCard(): React.JSX.Element {
  return (
    <RequestCard className="px-10 py-12 text-center">
      <span className="bg-muted mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl">
        <Lock className="text-muted-foreground h-6 w-6" aria-hidden="true" />
      </span>
      <h3 className="text-foreground text-lg font-semibold">
        This request isn&apos;t open to experts yet
      </h3>
      <p className="text-muted-foreground mx-auto mt-2 max-w-sm text-sm leading-relaxed">
        Balo is still scoping it with the client. If invited, you&apos;ll get an email with a direct
        link to express interest.
      </p>
    </RequestCard>
  );
}

/**
 * The layout switch. Branches on archetype / expert-gating / phase into the four
 * layouts from the Lens × Status matrix:
 *  - observer (admin): full RequestContext + AdminHealthPanel (once invited)
 *  - expert-gated: lock card + waiting nudge
 *  - participant Phase 2: live ConversationStage (main island) + compact panel
 *    (desktop right column; mobile slim request bar → bottom sheet)
 *  - participant Phase 1: full-width RequestContext hero
 *
 * Everything is server-rendered except the analytics island and the Phase-2
 * conversation island (+ its mobile request-sheet wrapper, whose CHILDREN stay
 * server-rendered via RSC composition).
 */
export function RequestDetailShell({
  view,
  ctx,
  conversation = null,
  adminBilling = null,
  billingCapture = null,
}: Readonly<RequestDetailShellProps>): React.JSX.Element {
  const phase = requestPhase(view.status);
  const isPhase2 = phase === 'phase2';
  const isExpertGated = ctx.lens === 'expert' && STATUS_LABEL_BEFORE_INVITE.has(view.status);
  // Expert lens: the proposal-phase nudge cells key on the VIEWER'S relationship
  // status (BAL-272 divergence fix) — request status is the max-progress aggregate.
  const nudge = isExpertGated
    ? EXPERT_GATED_NUDGE
    : nudgeFor(ctx.lens, view.status, view.viewerRelationshipStatus);
  // Health panel only once there are relationships (none before experts_invited).
  const showHealthPanel = ctx.archetype === 'observer' && view.relationships.length > 0;

  // A client-lens member (not owner/admin) is blocked from the outstanding billing
  // step. Fire the blocked-view event ONCE from here (the shell mounts once; the
  // KickoffBoard mounts twice per client — desktop + mobile sheet).
  const billingBlocked =
    ctx.lens === 'client' &&
    view.kickoff !== null &&
    !view.kickoff.clientBillingConfirmed &&
    billingCapture !== null &&
    !billingCapture.canManage;

  // Phase-2 expert compact EOI card. Rendered at BOTH the mobile sheet and the desktop
  // right column, so it's built once here — sharing one element avoids duplicating the
  // JSX at both call sites. key={view.id}: App Router preserves client state across
  // dynamic-param navigation (/projects/A → /projects/B); keying by request remounts the
  // card so A's in-progress EOI draft never bleeds into B (mirrors ConversationStage).
  const expertCompactEoi = view.viewerEoi ? (
    <EoiEntry
      key={view.id}
      requestId={view.id}
      initialHasEoi={view.viewerEoi.hasLiveEoi}
      initialMessageHtml={view.viewerEoi.messageHtml}
      compact
    />
  ) : null;

  return (
    <div>
      <RequestDetailAnalytics
        requestId={view.id}
        lens={ctx.lens}
        archetype={ctx.archetype}
        status={view.status}
        phase={phase}
      />

      {billingBlocked && billingCapture && (
        <BillingBlockedViewTracker companyId={billingCapture.companyId} requestId={view.id} />
      )}

      <LensLine ctx={ctx} isPhase2={isPhase2} />

      {/* At-a-glance pipeline position — shown for every lens. A slim full-width
          strip; the stepper itself scrolls horizontally on narrow viewports. */}
      <div
        className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both mb-5 duration-500 motion-reduce:animate-none"
        style={{ animationDelay: '60ms' }}
      >
        <StatusStepper current={view.status} />
      </div>

      {nudge && (
        <div
          className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both mb-5 duration-500 motion-reduce:animate-none"
          style={{ animationDelay: '120ms' }}
        >
          <NudgeBar
            nudge={nudge}
            lens={ctx.lens}
            status={view.status}
            requestId={view.id}
            viewerRelationshipId={ctx.relationshipId}
          />
        </div>
      )}

      <div
        className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500 motion-reduce:animate-none"
        style={{ animationDelay: '180ms' }}
      >
        {ctx.archetype === 'observer' && (
          <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <RequestContext view={view} variant="full" />
            <div className="space-y-5">
              {/* Kickoff board is the admin's first CTA — above the health panel. */}
              {view.kickoff && (
                <KickoffBoard
                  requestId={view.id}
                  acceptedRelationshipId={view.kickoff.acceptedRelationshipId}
                  lens={ctx.lens}
                  clientBillingConfirmed={view.kickoff.clientBillingConfirmed}
                  expertTermsConfirmed={view.kickoff.expertTermsConfirmed}
                  approved={view.kickoff.approved}
                  expertName={view.kickoff.expertName}
                  billing={billingCapture}
                />
              )}
              {/* BAL-324: billing + payment-terms visibility (observer only). Sits
                  under the kickoff board so the admin sees WHY the billing gate is
                  open and can remind the client inline. */}
              {view.kickoff && (
                <AdminKickoffBillingPanel
                  view={adminBilling ?? null}
                  requestId={view.id}
                  acceptedRelationshipId={view.kickoff.acceptedRelationshipId}
                  clientBillingConfirmed={view.kickoff.clientBillingConfirmed}
                />
              )}
              {showHealthPanel && (
                <AdminHealthPanel
                  requestId={view.id}
                  status={view.status}
                  relationships={view.relationships}
                />
              )}
            </div>
          </div>
        )}

        {ctx.archetype === 'participant' && isExpertGated && <ExpertGatedCard />}

        {ctx.archetype === 'participant' && !isExpertGated && !isPhase2 && (
          <div className="space-y-5">
            <RequestContext view={view} variant="full" />
            {/* Expert Phase-1: the EOI-entry card sits under the brief. The client
                lens never sees it (no `viewerEoi`).
                key={view.id}: App Router preserves client state across dynamic-param
                navigation (/projects/A → /projects/B) — keying by request remounts the
                card so A's in-progress EOI draft never lingers under B's URL. Mirrors
                the ConversationStage keying below. */}
            {ctx.lens === 'expert' && view.viewerEoi && (
              <EoiEntry
                key={view.id}
                requestId={view.id}
                initialHasEoi={view.viewerEoi.hasLiveEoi}
                initialMessageHtml={view.viewerEoi.messageHtml}
              />
            )}
          </div>
        )}

        {ctx.archetype === 'participant' && !isExpertGated && isPhase2 && (
          <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
            <div className="min-w-0 space-y-4">
              {/* Mobile: slim request bar → bottom sheet. Children are the SAME
                  server-rendered compact panel the desktop right column shows
                  (RSC composition through the client sheet wrapper). */}
              <div className="lg:hidden">
                <MobileRequestSheet title={view.title}>
                  <div className="space-y-5">
                    {ctx.lens === 'expert' && (
                      <>
                        <div className="flex justify-end">
                          <ProposalSlot
                            requestId={view.id}
                            viewerRelationshipStatus={view.viewerRelationshipStatus}
                            viewerRelationshipId={ctx.relationshipId}
                          />
                        </div>
                        {expertCompactEoi}
                      </>
                    )}
                    {/* Kickoff board for BOTH client + winning expert (null otherwise). */}
                    {view.kickoff && (
                      <KickoffBoard
                        requestId={view.id}
                        acceptedRelationshipId={view.kickoff.acceptedRelationshipId}
                        lens={ctx.lens}
                        clientBillingConfirmed={view.kickoff.clientBillingConfirmed}
                        expertTermsConfirmed={view.kickoff.expertTermsConfirmed}
                        approved={view.kickoff.approved}
                        expertName={view.kickoff.expertName}
                        billing={billingCapture}
                        mobile
                      />
                    )}
                    <RequestContext view={view} variant="compact" />
                  </div>
                </MobileRequestSheet>
              </div>
              {/* key={view.id}: App Router preserves client state across
                  dynamic-param navigation (/projects/A → /projects/B) — keying
                  by request remounts the island so A's threads never linger
                  under B's URL. */}
              <ConversationStage
                key={view.id}
                requestId={view.id}
                lens={ctx.lens === 'expert' ? 'expert' : 'client'}
                requestStatus={view.status}
                view={conversation ?? EMPTY_CONVERSATION_VIEW}
              />
            </div>
            <div className="hidden space-y-5 lg:block">
              {/* Expert Phase-2: the gated "Build proposal" header slot + a compact
                  EOI card so withdraw/resubmit stays reachable once the request has
                  flipped to the conversation. The client lens gets neither. */}
              {ctx.lens === 'expert' && (
                <>
                  <div className="flex justify-end">
                    <ProposalSlot
                      requestId={view.id}
                      viewerRelationshipStatus={view.viewerRelationshipStatus}
                      viewerRelationshipId={ctx.relationshipId}
                    />
                  </div>
                  {expertCompactEoi}
                </>
              )}
              {/* Kickoff board for BOTH client + winning expert (null otherwise). */}
              {view.kickoff && (
                <KickoffBoard
                  requestId={view.id}
                  acceptedRelationshipId={view.kickoff.acceptedRelationshipId}
                  lens={ctx.lens}
                  clientBillingConfirmed={view.kickoff.clientBillingConfirmed}
                  expertTermsConfirmed={view.kickoff.expertTermsConfirmed}
                  approved={view.kickoff.approved}
                  expertName={view.kickoff.expertName}
                  billing={billingCapture}
                />
              )}
              <RequestContext view={view} variant="compact" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
